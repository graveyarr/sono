"""Свои файлы с компьютера: папки с музыкой (mp3, flac, m4a, ogg, opus, wav…) в медиатеке Sono.

Человек добавляет папку в настройках — Sono в фоне обходит её (с подпапками), читает теги
(название, исполнитель, альбом, длительность) библиотекой mutagen — она уже есть вместе с yt-dlp —
и показывает треки в разделе «Мои файлы». Играют они прямо с диска, с перемоткой и без интернета.
Номер трека — первые 16 знаков sha1 от пути к файлу. Список папок и найденного — DATA_DIR/local.json.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

AUDIO_EXT = {".mp3", ".flac", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".wma", ".webm"}
MAX_TRACKS = 20000

_file: Path | None = None
_covers: Path | None = None
_data = {"folders": [], "tracks": {}}
_lock = threading.Lock()
_scan = {"running": False, "found": 0, "error": ""}


def init(data_dir: Path, cache_dir: Path) -> None:
    global _file, _covers, _data
    _file = data_dir / "local.json"
    _covers = cache_dir / "local-covers"
    _covers.mkdir(parents=True, exist_ok=True)
    try:
        _data = json.loads(_file.read_text(encoding="utf-8"))
        _data.setdefault("folders", [])
        _data.setdefault("tracks", {})
    except (OSError, ValueError):
        _data = {"folders": [], "tracks": {}}


def _save() -> None:
    tmp = _file.with_suffix(".tmp")
    tmp.write_text(json.dumps(_data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _file)


def track_id(path: str) -> str:
    return hashlib.sha1(os.path.normcase(os.path.abspath(path)).encode("utf-8")).hexdigest()[:16]


def _tags(path: Path) -> dict | None:
    """Название, исполнитель, альбом, длительность. Тегов нет — название из имени файла («Исполнитель - Название»).
    None — это не музыка (битый файл или чужой файл с расширением .mp3): в список его не берём."""
    import mutagen
    title = artist = album = ""
    duration = None
    try:
        f = mutagen.File(path, easy=True)
        if f is None:
            return None
        tags = f.tags or {}
        pick = lambda k: (tags.get(k) or [""])[0] if hasattr(tags, "get") else ""   # noqa: E731
        title, artist, album = pick("title"), pick("artist") or pick("albumartist"), pick("album")
        duration = round(f.info.length) if getattr(f, "info", None) and f.info.length else None
    except Exception:
        return None
    if not title:
        stem = path.stem
        if " - " in stem and not artist:
            artist, title = [x.strip() for x in stem.split(" - ", 1)]
        else:
            title = stem
    return {"title": title.strip(), "artist": artist.strip(), "album": album.strip(), "duration": duration}


def _walk(folder: str):
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if Path(name).suffix.lower() in AUDIO_EXT:
                yield Path(root) / name


def scan() -> None:
    """Обойти все папки заново (в фоне). Уже известные файлы с тем же временем изменения не перечитываем."""
    if _scan["running"]:
        return

    def work():
        _scan.update(running=True, found=0, error="")
        try:
            old = dict(_data["tracks"])
            fresh = {}
            for folder in list(_data["folders"]):
                if not os.path.isdir(folder):
                    continue
                for path in _walk(folder):
                    if len(fresh) >= MAX_TRACKS:
                        break
                    tid = track_id(str(path))
                    try:
                        mtime = int(path.stat().st_mtime)
                    except OSError:
                        continue
                    known = old.get(tid)
                    # Без длительности — перечитываем: так из списка уходят битые файлы, найденные старыми версиями
                    if not (known and known.get("mtime") == mtime and known.get("duration")):
                        tags = _tags(path)
                        if tags is None:
                            continue
                        known = {"path": str(path), "mtime": mtime, **tags}
                    fresh[tid] = known
                    _scan["found"] = len(fresh)
            with _lock:
                _data["tracks"] = fresh
                _save()
        except Exception as e:
            _scan["error"] = str(e)
            print(f"[local] не получилось просмотреть папки: {e}")
        finally:
            _scan["running"] = False
    threading.Thread(target=work, daemon=True, name="local-scan").start()


def add_folder(folder: str) -> None:
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        raise ValueError("Такой папки нет")
    with _lock:
        if folder not in _data["folders"]:
            _data["folders"].append(folder)
            _save()
    scan()


def remove_folder(folder: str) -> None:
    with _lock:
        _data["folders"] = [f for f in _data["folders"] if f != folder]
        _save()
    scan()


def status() -> dict:
    return {"folders": list(_data["folders"]), "scanning": _scan["running"], "found": _scan["found"],
            "error": _scan["error"], "count": len(_data["tracks"])}


def tracks() -> list[dict]:
    """Треки для страницы: как у YouTube/SoundCloud — {source, id, title, channel, duration} + album."""
    out = []
    for tid, t in _data["tracks"].items():
        out.append({"source": "local", "id": tid, "title": t["title"], "channel": t["artist"] or None,
                    **({"artists": t["artist"], "origTitle": t["title"]} if t["artist"] else {}),
                    "album": t.get("album") or None, "duration": t.get("duration")})
    out.sort(key=lambda t: ((t["channel"] or "").lower(), (t.get("album") or "").lower(), t["title"].lower()))
    return out


def path_of(tid: str) -> Path | None:
    t = _data["tracks"].get(tid)
    return Path(t["path"]) if t and os.path.isfile(t["path"]) else None


def cover_of(tid: str) -> Path | None:
    """Обложка: вшитая в файл (mp3/flac/m4a/ogg) или cover.jpg/folder.jpg рядом. Кэш — cache/local-covers."""
    path = path_of(tid)
    if not path:
        return None
    cached = _covers / f"{tid}.jpg"
    if cached.exists():
        return cached if cached.stat().st_size else None
    data = b""
    try:
        import mutagen
        f = mutagen.File(path)
        tags = getattr(f, "tags", None)
        if hasattr(f, "pictures") and f.pictures:                       # FLAC
            data = f.pictures[0].data
        elif tags is not None and hasattr(tags, "getall"):               # MP3 (ID3)
            pics = tags.getall("APIC")
            data = pics[0].data if pics else b""
        elif tags is not None and "covr" in tags:                        # M4A
            data = bytes(tags["covr"][0])
        elif tags is not None and "metadata_block_picture" in tags:      # OGG/Opus
            import base64
            from mutagen.flac import Picture
            data = Picture(base64.b64decode(tags["metadata_block_picture"][0])).data
    except Exception:
        data = b""
    if not data:
        for name in ("cover.jpg", "folder.jpg", "front.jpg", "cover.png", "folder.png"):
            side = path.parent / name
            if side.is_file():
                data = side.read_bytes()
                break
    cached.write_bytes(data)   # пустой файл — «обложки нет», чтобы не искать каждый раз
    return cached if data else None


def touch_cover_cache() -> None:
    """Сбросить запомненное «обложки нет» (после пересканирования могли появиться)."""
    for p in _covers.glob("*.jpg"):
        if p.stat().st_size == 0 and time.time() - p.stat().st_mtime > 3600:
            p.unlink(missing_ok=True)
