"""Обновление самой программы Sono — чтобы людям не нужно было самим ходить на GitHub.

Как устроено:
- при запуске (в фоне) и потом раз в 6 часов спрашиваем GitHub, какой последний выпуск (Release) в репозитории;
- если его номер новее нашей версии — скачиваем установщик SonoSetup-<версия>.exe из выпуска
  в DATA_DIR/updates/app и сверяем контрольную сумму (GitHub сам считает sha256 каждого файла выпуска);
- страница показывает «Доступна версия X» — по кнопке запускаем установщик тихо (/VERYSILENT),
  он ставит новую версию поверх старой и сам запускает её снова (параметр /UPDATE=1, см. installer.iss),
  а мы сразу закрываемся, чтобы не держать свои файлы.
Медиатека лежит отдельно (%LOCALAPPDATA%\\Sono) и при обновлении не трогается.

Работает только в собранной программе и только когда указан репозиторий (REPO) —
до публикации на GitHub обновляться неоткуда.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

# Репозиторий на GitHub, вида "ник/sono". Пусто — автообновление выключено (например, в своей сборке)
REPO = "graveyarr/sono"
# Для проверки без GitHub можно подставить свой адрес с ответом в том же виде
API = os.environ.get("SONO_UPDATE_API") or (f"https://api.github.com/repos/{REPO}/releases/latest" if REPO else "")
CHECK_EVERY = 6 * 3600

_status = {"state": "idle", "current": None, "latest": None, "notes": "", "url": "", "error": None, "progress": 0}
_lock = threading.Lock()
_started = False


def _dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Sono" / "updates" / "app"


def _vtuple(v: str) -> tuple:
    nums = re.findall(r"\d+", str(v))
    return tuple(int(x) for x in nums) or (0,)


def current_version() -> str:
    """Наша версия — её записывает build.py в bundled_versions.json."""
    try:
        data = json.loads((Path(getattr(sys, "_MEIPASS", ".")) / "bundled_versions.json").read_text(encoding="utf-8"))
        return data.get("app") or "0"
    except (OSError, ValueError):
        return "0"


def enabled() -> bool:
    return bool(API) and (getattr(sys, "frozen", False) or bool(os.environ.get("SONO_UPDATE_API")))


def status() -> dict:
    with _lock:
        return {**_status, "current": current_version(), "enabled": enabled(), "repo": REPO}


def _set(**kw) -> None:
    with _lock:
        _status.update(kw)


def start() -> None:
    """Запустить фоновую проверку: сейчас и потом раз в CHECK_EVERY."""
    global _started
    if _started or not enabled():
        return
    _started = True

    def loop():
        time.sleep(20)   # не мешаем запуску программы
        while True:
            check()
            time.sleep(CHECK_EVERY)
    threading.Thread(target=loop, daemon=True, name="app-update").start()


def check() -> None:
    """Проверить GitHub и, если есть новая версия, скачать установщик."""
    if not enabled() or status()["state"] in ("checking", "downloading", "installing"):
        return
    import requests
    _set(state="checking", error=None)
    try:
        try:
            resp = requests.get(API, timeout=20, headers={"Accept": "application/vnd.github+json"})
            rel = resp.json() if resp.ok else {}
        except (requests.RequestException, ValueError):
            rel = {}
        if not rel.get("tag_name") and REPO:
            rel = _latest_from_web(requests)
        latest = str(rel.get("tag_name") or "").lstrip("vV")
        if not latest:
            raise ValueError(rel.get("message") or "GitHub не ответил, какая версия последняя")
        _set(latest=latest, notes=(rel.get("body") or "")[:1500], url=rel.get("html_url") or "")
        if _vtuple(latest) <= _vtuple(current_version()):
            _set(state="uptodate")
            return
        asset = next((a for a in rel.get("assets") or [] if re.fullmatch(r"SonoSetup-.*\.exe", a.get("name", ""))), None)
        if not asset:
            raise ValueError(f"в выпуске {latest} нет установщика SonoSetup-….exe")
        target = _dir() / asset["name"]
        want = (asset.get("digest") or "").removeprefix("sha256:").lower()
        if target.is_file() and (not want or _sha256(target) == want):
            _set(state="ready", file=str(target))   # уже скачан раньше
            return
        if not want:
            print("[app-update] контрольной суммы нет — проверю только, что файл скачался целиком")
        _set(state="downloading", progress=0)
        _dir().mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".part")
        h = hashlib.sha256()
        with requests.get(asset["browser_download_url"], stream=True, timeout=60) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("Content-Length") or asset.get("size") or 0)
            done = 0
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(1 << 16):
                    f.write(chunk)
                    h.update(chunk)
                    done += len(chunk)
                    if total:
                        _set(progress=round(done / total * 100))
        if want and h.hexdigest() != want:
            tmp.unlink(missing_ok=True)
            raise ValueError("контрольная сумма не совпала — файл повреждён, скачаю в следующий раз")
        os.replace(tmp, target)
        for old in _dir().glob("SonoSetup-*"):   # старые установщики больше не нужны
            if old != target:
                old.unlink(missing_ok=True)
        _set(state="ready", file=str(target), progress=100)
        print(f"[app-update] скачана версия {latest} — можно обновиться")
    except Exception as e:
        _set(state="error", error=str(e))
        print(f"[app-update] не получилось проверить обновление: {e}")


def _latest_from_web(requests) -> dict:
    """Запасной путь, если API GitHub отказал. Без входа он отвечает одному адресу 60 раз в час,
    а у VPN адрес общий на многих — лимит бывает исчерпан (так было при проверке). Обычная страница
    /releases/latest лимита не имеет: она перенаправляет на /releases/tag/v<версия>. Установщик лежит
    по предсказуемому адресу, контрольная сумма — в файле .sha256 рядом с ним (кладёт build.py)."""
    resp = requests.get(f"https://github.com/{REPO}/releases/latest", allow_redirects=False, timeout=20)
    tag = (resp.headers.get("Location") or "").rstrip("/").rsplit("/tag/", 1)[-1]
    if not re.fullmatch(r"v?\d+(\.\d+)*", tag):
        raise ValueError("GitHub не ответил, какая версия последняя")
    name = f"SonoSetup-{tag.lstrip('vV')}.exe"
    url = f"https://github.com/{REPO}/releases/download/{tag}/{name}"
    digest = ""
    try:
        sha = requests.get(url + ".sha256", timeout=20)
        if sha.ok and re.match(r"[0-9a-fA-F]{64}", sha.text.strip()):
            digest = "sha256:" + sha.text.strip()[:64].lower()
    except requests.RequestException:
        pass
    return {"tag_name": tag, "html_url": f"https://github.com/{REPO}/releases/tag/{tag}", "body": "",
            "assets": [{"name": name, "browser_download_url": url, "digest": digest}]}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def install() -> None:
    """Запустить скачанный установщик тихо и закрыть программу. Установщик сам откроет новую версию."""
    st = status()
    if st["state"] != "ready" or not Path(_status.get("file", "")).is_file():
        raise ValueError("Обновление ещё не скачано")
    _set(state="installing")
    flags = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — живёт и после нашего выхода
    subprocess.Popen([_status["file"], "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS",
                      "/UPDATE=1"], creationflags=flags, close_fds=True)
    # Даём странице получить ответ и закрываемся: установщику нужно заменить наши файлы
    threading.Timer(0.8, lambda: os._exit(0)).start()
