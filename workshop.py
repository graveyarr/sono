"""Мастерская тем: чужие темы из общего каталога на GitHub (репозиторий graveyarr/sono-themes).

Как устроено (своего сервера у Sono нет):
- в репозитории каталога робот GitHub (Actions) собирает каждую тему в zip, считает sha256 и выкладывает
  архивы, картинки и список index.json в выпуск «catalog»;
- Sono скачивает index.json и хранит копию в DATA_DIR/workshop — мастерская открывается и без интернета;
- картинки тем страница берёт только у нашего сервера (/api/workshop/preview/…), он скачивает их один раз
  и кладёт в кэш — сама страница наружу не ходит;
- «Установить» — скачать zip, сверить sha256 из каталога, распаковать по строгим правилам в
  DATA_DIR/themes/ws-<id>. Дальше это обычная своя тема: CSS и значки при каждой отдаче чистит themes.py.

Безопасность. Адреса берутся только из FILES_BASE + имя файла (имя проверяется) — из каталога нельзя
подсунуть чужой сайт. Архив: только файлы темы (theme.json/css, картинки, шрифты, icons/*.svg, LICENSE,
README), без «..» и путей, не больше MAX_FILES файлов и MAX_UNPACKED байт — размер считаем по настоящим
байтам, а не по заголовку zip (иначе «zip-бомба»). Что-то не так — архив не ставится целиком.

Для проверок: SONO_WORKSHOP_URL=<адрес папки с index.json и файлами> — например, поддельный каталог на 127.0.0.1.
"""
import hashlib
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import Path

import themes

REPO = "graveyarr/sono-themes"
_override = (os.environ.get("SONO_WORKSHOP_URL") or "").strip()
if _override:
    FILES_BASE = _override if _override.endswith("/") else _override + "/"
    CATALOG_URLS = [FILES_BASE + "index.json"]
else:
    FILES_BASE = f"https://github.com/{REPO}/releases/download/catalog/"
    CATALOG_URLS = [FILES_BASE + "index.json"]   # index.json лежит только в выпуске (робот не коммитит его в main)
ISSUES_URL = f"https://github.com/{REPO}/issues/new/choose"

SCHEMA = 1
STALE_AFTER = 6 * 3600            # каталог старше — страница попросит обновить
MAX_CATALOG = 2 * 1024 * 1024
MAX_THEMES = 2000
MAX_ZIP = 5 * 1024 * 1024
MAX_UNPACKED = 10 * 1024 * 1024
MAX_FILES = 200
MAX_PREVIEW = 1536 * 1024
PREFIX = "ws-"                    # папки тем из мастерской — чтобы не спутать со своими

_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
_FILE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,90}\.(zip|png|jpe?g|webp)$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_PART_NAME = re.compile(r"^[\w .()\[\]-]{1,80}$")   # имя файла внутри архива (кириллица можно)
_TEXT_FILES = {"license", "license.txt", "license.md", "readme.txt", "readme.md"}
# Лицензии шрифтов рядом с файлом шрифта (OFL-Unbounded.txt — так их кладёт и редактор тем)
_LICENSE_FILE = re.compile(r"^(ofl|license)-[\w.-]{1,60}\.txt$")
_IMAGE_MAGIC = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")

DIR: Path = Path()
_lock = threading.Lock()


def init(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "workshop"


# ---------- Скачивание ----------

def _download(url: str, limit: int, timeout: int = 20) -> bytes:
    """Скачать файл целиком, но не больше limit байт (больше — ошибка, а не обрезка)."""
    import requests
    with requests.get(url, stream=True, timeout=timeout, headers={"User-Agent": "Sono"}) as resp:
        if resp.status_code == 404:
            raise ValueError("файла нет в каталоге")
        resp.raise_for_status()
        if int(resp.headers.get("Content-Length") or 0) > limit:
            raise ValueError("файл слишком большой")
        buf = io.BytesIO()
        for chunk in resp.iter_content(1 << 16):
            buf.write(chunk)
            if buf.tell() > limit:
                raise ValueError("файл слишком большой")
        return buf.getvalue()


def file_url(name: str) -> str:
    if not _FILE.match(name or ""):
        raise ValueError("неправильное имя файла")
    return FILES_BASE + name


# ---------- Каталог ----------

def _str(value, limit: int) -> str:
    return re.sub(r"[\x00-\x1f]", " ", value).strip()[:limit] if isinstance(value, str) else ""


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _clean_theme(raw) -> dict | None:
    """Одна тема из index.json — только известные поля, проверенные. Что-то главное не так — пропускаем."""
    if not isinstance(raw, dict):
        return None
    tid = raw.get("id")
    zip_name = raw.get("zip")
    sha = str(raw.get("sha256") or "").lower()
    if not isinstance(tid, str) or not _ID.match(tid) or not isinstance(zip_name, str) \
            or not _FILE.match(zip_name) or not zip_name.endswith(".zip") or not _SHA.match(sha):
        return None
    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
    previews = raw.get("previews") if isinstance(raw.get("previews"), list) else []
    colors = raw.get("preview") if isinstance(raw.get("preview"), list) else []
    cover = raw.get("coverColors", "on")
    cover = "on" if cover is True else "off" if cover is False else cover if cover in themes.COVER_MODES else "on"
    dates = {k: v for k in ("created", "updated") if isinstance(v := raw.get(k), str) and _DATE.match(v)}
    return {
        "id": tid,
        "name": _str(raw.get("name"), 60) or tid,
        "author": _str(raw.get("author"), 60),
        "description": _str(raw.get("description"), 600),
        "part": raw.get("part") if raw.get("part") in themes.PARTS else "theme",
        "tags": [t for t in (_str(x, 24) for x in tags[:8]) if t],
        "version": _str(str(raw.get("version") or ""), 20) or "1",
        "sono": _str(raw.get("sono"), 20),
        "license": _str(raw.get("license"), 40),
        "created": dates.get("created", ""),
        "updated": dates.get("updated", dates.get("created", "")),
        "size": min(_int(raw.get("size")), MAX_ZIP),
        "sha256": sha,
        "zip": zip_name,
        "previews": [p for p in previews[:4] if isinstance(p, str) and _FILE.match(p) and not p.endswith(".zip")],
        "preview": [c for c in map(themes._color, colors) if c][:4],
        "coverColors": cover,
        "icons": raw.get("icons") is True,
        "font": raw.get("font") is True,
        "downloads": _int(raw.get("downloads")),
    }


def clean_catalog(raw) -> dict:
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA:
        raise ValueError("каталог другого формата — возможно, нужна новая версия Sono")
    items, seen = [], set()
    for t in (raw.get("themes") if isinstance(raw.get("themes"), list) else [])[:MAX_THEMES]:
        c = _clean_theme(t)
        if c and c["id"] not in seen:
            seen.add(c["id"])
            items.append(c)
    featured = [f for f in (raw.get("featured") if isinstance(raw.get("featured"), list) else []) if f in seen][:8]
    updated = raw.get("updated") if isinstance(raw.get("updated"), str) and _DATE.match(raw["updated"]) else ""
    return {"schema": SCHEMA, "updated": updated, "featured": featured, "themes": items}


def _cache_file() -> Path:
    return DIR / "index.json"


def _load_cache() -> dict | None:
    try:
        data = json.loads(_cache_file().read_text(encoding="utf-8"))
        cat = clean_catalog(data)
        cat["fetchedAt"] = _int(data.get("fetchedAt"))
        return cat
    except (OSError, ValueError):
        return None


def refresh() -> dict:
    """Скачать свежий каталог (по очереди с каждого адреса). Не вышло — ошибка, старая копия остаётся."""
    errors = []
    for url in CATALOG_URLS:
        try:
            raw = json.loads(_download(url, MAX_CATALOG).decode("utf-8-sig"))
            cat = clean_catalog(raw)
        except Exception as e:   # сеть, не JSON, не тот формат — пробуем следующий адрес
            errors.append(str(e))
            continue
        cat["fetchedAt"] = int(time.time())
        DIR.mkdir(parents=True, exist_ok=True)
        tmp = _cache_file().with_suffix(".tmp")
        tmp.write_text(json.dumps(cat, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, _cache_file())
        _prune_previews(cat)
        return cat
    raise ValueError("каталог не загрузился: " + (errors[-1] if errors else "нет адреса"))


def installed() -> dict[str, dict]:
    """Темы из мастерской, которые уже стоят: {id: {version, folder}}."""
    out = {}
    root = themes.USER_DIR
    if not root.is_dir():
        return out
    for path in root.iterdir():
        if path.is_dir() and path.name.startswith(PREFIX):
            meta = read_mark(path)
            if meta:
                out[meta["id"]] = {"version": meta["version"], "folder": path.name}
    return out


def read_mark(folder: Path) -> dict | None:
    """.workshop.json в папке темы: откуда она (id в каталоге) и какая версия стоит."""
    try:
        meta = json.loads((folder / ".workshop.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict) or not _ID.match(str(meta.get("id") or "")):
        return None
    return {"id": meta["id"], "version": _str(str(meta.get("version") or ""), 20)}


def _needs(entry: dict, current: str) -> str | None:
    """Поле sono в каталоге: "0.9.8" или ">=0.9.8" — какая версия Sono нужна (None — подходит)."""
    req = entry["sono"]
    return themes.needs_newer(req if not req or req.startswith(">") else f">={req}", current)


def catalog(current: str) -> dict:
    """Каталог для страницы — сразу, без сети (сохранённая копия) + что уже стоит и что можно обновить."""
    cat = _load_cache() or {"schema": SCHEMA, "updated": "", "featured": [], "themes": [], "fetchedAt": 0}
    have = installed()
    for t in cat["themes"]:
        mine = have.get(t["id"])
        t["installed"] = mine["version"] if mine else None
        t["themeId"] = f"user:{mine['folder']}" if mine else None
        t["hasUpdate"] = bool(mine) and mine["version"] != t["version"]
        t["needs"] = _needs(t, current)
    cat["stale"] = time.time() - cat["fetchedAt"] > STALE_AFTER
    cat["issues"] = ISSUES_URL
    return cat


def find(theme_id: str) -> dict:
    cat = _load_cache()
    for t in (cat or {}).get("themes", []):
        if t["id"] == theme_id:
            return t
    raise ValueError("такой темы нет в каталоге — обновите каталог")


# ---------- Картинки ----------

def _preview_dir() -> Path:
    return DIR / "previews"


def _is_image(data: bytes) -> bool:
    return data.startswith(_IMAGE_MAGIC) or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")


def preview(name: str) -> Path:
    """Картинка темы из кэша; нет — скачать (только имена из каталога, только png/jpg/webp)."""
    url = file_url(name)
    if name.endswith(".zip"):
        raise ValueError("это не картинка")
    path = _preview_dir() / name
    if path.is_file():
        return path
    cat = _load_cache() or {"themes": []}
    if not any(name in t["previews"] for t in cat["themes"]):
        raise ValueError("картинки нет в каталоге")
    data = _download(url, MAX_PREVIEW)
    if not _is_image(data):
        raise ValueError("это не картинка")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{uuid.uuid4().hex}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return path


def _prune_previews(cat: dict) -> None:
    """После обновления каталога — стереть картинки тем, которых в нём больше нет."""
    keep = {p for t in cat["themes"] for p in t["previews"]}
    folder = _preview_dir()
    if folder.is_dir():
        for f in folder.iterdir():
            if f.is_file() and f.name not in keep:
                f.unlink(missing_ok=True)


# ---------- Установка ----------

def _allowed(parts: list[str]) -> bool:
    if any(not _PART_NAME.match(p) or p.startswith(".") for p in parts):
        return False
    name = parts[-1].lower()
    ext = os.path.splitext(name)[1]
    if len(parts) == 1:
        return (name in ("theme.json", "theme.css") or name in _TEXT_FILES or bool(_LICENSE_FILE.match(name))
                or ext in themes.FILE_TYPES)
    return len(parts) == 2 and parts[0] == "icons" and ext == ".svg"


def _limit(name: str) -> int:
    if name.lower() == "theme.css":
        return themes.MAX_CSS
    if name.lower() == "theme.json":
        return themes.MAX_JSON
    if name.lower().endswith(".svg") and "/" in name:
        return themes.MAX_ICON
    return MAX_UNPACKED


def unpack(data: bytes) -> dict[str, bytes]:
    """Разобрать zip темы в {путь: байты}. Любое нарушение правил — ValueError (тема не ставится)."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("архив повреждён") from None
    infos = [i for i in zf.infolist() if not i.is_dir()]
    if not infos:
        raise ValueError("архив пустой")
    if len(infos) > MAX_FILES:
        raise ValueError("в архиве слишком много файлов")
    names = []
    for info in infos:
        if info.flag_bits & 0x1:
            raise ValueError("архив с паролем")
        raw = info.filename
        if "\\" in raw or raw.startswith("/") or ":" in raw:
            raise ValueError(f"недопустимый путь в архиве: {raw}")
        names.append(raw.split("/"))
    # Тему могли заархивировать вместе с папкой — одну общую папку сверху снимаем
    tops = {p[0] for p in names}
    if len(tops) == 1 and all(len(p) > 1 for p in names) and ["theme.css"] not in names:
        names = [p[1:] for p in names]
    files, total = {}, 0
    for info, parts in zip(infos, names):
        if not parts or not _allowed(parts):
            raise ValueError(f"в теме не может быть такого файла: {info.filename}")
        rel = "/".join(parts)
        if rel.lower() in (k.lower() for k in files):
            raise ValueError(f"файл повторяется: {rel}")
        limit = _limit(rel)
        with zf.open(info) as f:
            body = f.read(limit + 1)   # настоящие байты, а не размер из заголовка
        if len(body) > limit:
            raise ValueError(f"файл слишком большой: {rel}")
        total += len(body)
        if total > MAX_UNPACKED:
            raise ValueError("тема слишком большая после распаковки")
        files[rel] = body
    if "theme.css" not in files:
        raise ValueError("в архиве нет theme.css")
    if "theme.json" in files:
        try:
            meta = json.loads(files["theme.json"].decode("utf-8-sig"))
        except ValueError:
            raise ValueError("theme.json не читается") from None
        if not isinstance(meta, dict):
            raise ValueError("theme.json — не объект {…}")
    return files


def install(theme_id: str, current: str) -> dict:
    """Поставить (или обновить) тему из каталога. Вернёт {id: "user:ws-…", folder, version}."""
    with _lock:
        entry = find(theme_id)
        need = _needs(entry, current)
        if need:
            raise ValueError(f"для этой темы нужна Sono {need} или новее")
        data = _download(file_url(entry["zip"]), MAX_ZIP, timeout=60)
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("архив не совпал с каталогом (повреждён или подменён) — попробуйте обновить каталог")
        files = unpack(data)
        root = themes.USER_DIR
        root.mkdir(parents=True, exist_ok=True)
        tmp = root / f".ws-new-{uuid.uuid4().hex[:8]}"   # с точки — список тем такие папки не видит
        try:
            for rel, body in files.items():
                path = tmp / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
            mark = {"id": entry["id"], "version": entry["version"], "sha256": entry["sha256"],
                    "installedAt": int(time.time())}
            (tmp / ".workshop.json").write_text(json.dumps(mark, ensure_ascii=False), encoding="utf-8")
            dest = root / f"{PREFIX}{entry['id']}"
            old = None
            if dest.exists():
                old = root / f".ws-old-{uuid.uuid4().hex[:8]}"
                os.replace(dest, old)
            try:
                os.replace(tmp, dest)
            except OSError:
                if old:
                    os.replace(old, dest)   # не вышло — вернуть прежнюю версию на место
                raise
            if old:
                shutil.rmtree(old, ignore_errors=True)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        return {"id": f"user:{dest.name}", "folder": dest.name, "version": entry["version"]}


def cleanup() -> None:
    """При запуске: убрать недоделанные папки (Sono закрыли посреди установки)."""
    root = themes.USER_DIR
    if root.is_dir():
        for p in root.iterdir():
            if p.is_dir() and (p.name.startswith(".ws-new-") or p.name.startswith(".ws-old-")):
                shutil.rmtree(p, ignore_errors=True)
