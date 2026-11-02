"""Обновление yt-dlp без новой версии Sono.

YouTube часто меняет сайт, и yt-dlp, зашитый в установщик, через несколько недель перестаёт работать.
Поэтому собранная программа сама следит за новыми версиями:
- при запуске (в фоне) спрашивает PyPI, какая версия yt-dlp последняя;
- если новее нашей — скачивает «колесо» (.whl — это zip с кодом) yt-dlp и нужной ему версии yt-dlp-ejs
  (решатель JS-задачек YouTube), проверяет контрольную сумму (sha256 с PyPI) и кладёт в DATA_DIR/updates;
- при следующем запуске activate() ставит эти файлы первыми в sys.path — Python берёт код прямо из zip.
Если новая версия не загрузилась — молча откатываемся на встроенную и больше эту версию не берём.
Работает только в собранной программе: из исходников yt-dlp обновляют через pip.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
from pathlib import Path

PYPI = "https://pypi.org/pypi/{}/json"
_status = {"state": "idle", "current": None, "latest": None, "pending": None, "error": None}
_lock = threading.Lock()


def _dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Sono" / "updates"


def _vtuple(v: str) -> tuple:
    try:
        return tuple(int(x) for x in str(v).split("."))
    except ValueError:
        return (0,)


def _bundled() -> dict:
    """Версии, зашитые в установщик (build.py записывает их в bundled_versions.json)."""
    try:
        return json.loads((Path(getattr(sys, "_MEIPASS", ".")) / "bundled_versions.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _state() -> dict:
    try:
        return json.loads((_dir() / "updates.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_state(data: dict) -> None:
    _dir().mkdir(parents=True, exist_ok=True)
    (_dir() / "updates.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def activate() -> None:
    """Вызывается ДО import yt_dlp: подключает скачанную свежую версию, если она новее встроенной."""
    if not getattr(sys, "frozen", False):
        return
    state, bundled = _state(), _bundled()
    ready = state.get("ready") or {}
    version = ready.get("yt_dlp")
    if not version or version in state.get("bad", []) or _vtuple(version) <= _vtuple(bundled.get("yt_dlp", "0")):
        return
    wheels = [_dir() / name for name in ready.get("files", [])]
    if not wheels or not all(w.is_file() for w in wheels):
        return
    for w in reversed(wheels):
        sys.path.insert(0, str(w))
    try:
        import yt_dlp  # noqa: F401 — проверяем, что новая версия вообще загружается
        import yt_dlp.version
        if yt_dlp.version.__version__ != version:
            raise ImportError(f"ожидали {version}, загрузилась {yt_dlp.version.__version__}")
        print(f"[update] yt-dlp {version} (свежий, из обновления)")
    except Exception as e:
        print(f"[update] свежий yt-dlp {version} не загрузился ({e}) — беру встроенный")
        for w in wheels:
            while str(w) in sys.path:
                sys.path.remove(str(w))
        for name in [m for m in sys.modules if m == "yt_dlp" or m.startswith(("yt_dlp.", "yt_dlp_ejs"))]:
            del sys.modules[name]
        state.setdefault("bad", []).append(version)
        state.pop("ready", None)
        _save_state(state)


def status() -> dict:
    with _lock:
        return dict(_status)


def _set(**kw) -> None:
    with _lock:
        _status.update(kw)


def _download(session, info: dict, target: Path) -> None:
    """Скачать файл и сверить контрольную сумму с PyPI."""
    resp = session.get(info["url"], timeout=60)
    resp.raise_for_status()
    if hashlib.sha256(resp.content).hexdigest() != info["digests"]["sha256"]:
        raise ValueError("контрольная сумма не совпала — файл повреждён")
    tmp = target.with_suffix(".part")
    tmp.write_bytes(resp.content)
    os.replace(tmp, target)


def check(force: bool = False) -> None:
    """Проверить и скачать новую версию (в фоне). force — даже в версии из исходников (для проверки)."""
    if not (getattr(sys, "frozen", False) or force):
        return
    threading.Thread(target=_check, daemon=True, name="ytdlp-update").start()


def _check() -> None:
    import requests
    import yt_dlp.version
    current = yt_dlp.version.__version__
    _set(state="checking", current=current, error=None)
    try:
        s = requests.Session()
        info = s.get(PYPI.format("yt-dlp"), timeout=20).json()
        latest = info["info"]["version"]
        _set(latest=latest)
        state = _state()
        if _vtuple(latest) <= _vtuple(current) or latest in state.get("bad", []):
            _set(state="uptodate")
            return
        if (state.get("ready") or {}).get("yt_dlp") == latest:
            _set(state="ready", pending=latest)   # уже скачано — подхватится при следующем запуске
            return
        _set(state="downloading")
        _dir().mkdir(parents=True, exist_ok=True)
        wheel = next(u for u in info["urls"] if u["packagetype"] == "bdist_wheel")
        files = [wheel["filename"]]
        _download(s, wheel, _dir() / wheel["filename"])
        # yt-dlp требует ровно определённую версию yt-dlp-ejs — докачиваем её, если она не та, что у нас
        pin = next((r.split("==")[1].split(";")[0].strip() for r in info["info"].get("requires_dist") or []
                    if r.startswith("yt-dlp-ejs==")), None)
        have_ejs = _bundled().get("yt_dlp_ejs")
        if pin and pin != have_ejs:
            ejs_info = s.get(f"https://pypi.org/pypi/yt-dlp-ejs/{pin}/json", timeout=20).json()
            ejs = next(u for u in ejs_info["urls"] if u["packagetype"] == "bdist_wheel")
            _download(s, ejs, _dir() / ejs["filename"])
            files.append(ejs["filename"])
        state["ready"] = {"yt_dlp": latest, "files": files}
        _save_state(state)
        # Старые скачанные версии больше не нужны
        for old in _dir().glob("*.whl"):
            if old.name not in files:
                old.unlink(missing_ok=True)
        _set(state="ready", pending=latest)
        print(f"[update] скачан yt-dlp {latest} — включится при следующем запуске")
    except Exception as e:
        _set(state="error", error=str(e))
        print(f"[update] не получилось проверить обновление yt-dlp: {e}")
