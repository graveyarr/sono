"""Свои фоны для панели «Вид» (static/js/look.js): картинки и GIF, которые слушатель положил в Sono.

Файлы лежат в DATA_DIR/backgrounds под именем из хэша содержимого (тот же файл второй раз не копируется).
Тип узнаём по первым байтам, а не по имени: под видом картинки не положить что попало.
Примеры (нарисованы design/ui-new/tools/make_bg.py) лежат в static/backgrounds и приходят вместе с Sono."""
import hashlib

from paths import BASE_DIR, DATA_DIR

USER_DIR = DATA_DIR / "backgrounds"
EXAMPLES_DIR = BASE_DIR / "static" / "backgrounds"
MAX_SIZE = 20 * 1024 * 1024        # GIF бывают большими; больше — уже не фон, а видео
MAX_FILES = 40                     # старые сверх этого удаляются (кроме выбранного сейчас)
EXAMPLES_ORDER = ["zvezdy.gif", "zakat.jpg", "oblaka.jpg", "kletka.png"]   # первым — GIF: сразу видно, что можно
MIME = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}


def _kind(raw: bytes) -> str:
    if raw[:3] == b"\xff\xd8\xff":
        return "jpg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return ""


def _valid_name(name: str) -> bool:
    stem, _, ext = name.partition(".")
    return ext in MIME and len(stem) == 16 and all(c in "0123456789abcdef" for c in stem)


def save(raw: bytes, keep: str = "") -> str:
    """Сохранить картинку, вернуть её имя. keep — выбранный сейчас фон (его не удаляем при уборке)."""
    if len(raw) > MAX_SIZE:
        raise ValueError("файл больше 20 МБ")
    ext = _kind(raw)
    if not ext:
        raise ValueError("это не картинка (подходят JPG, PNG, GIF и WebP)")
    USER_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{hashlib.sha1(raw).hexdigest()[:16]}.{ext}"
    path = USER_DIR / name
    if path.exists():
        path.touch()                 # тот же файл ещё раз — просто поднимаем его в начало списка
    else:
        path.write_bytes(raw)
    _tidy(keep={name, keep})
    return name


def _tidy(keep: set) -> None:
    files = sorted(USER_DIR.glob("*.*"), key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files[MAX_FILES:]:
        if p.name not in keep:
            try:
                p.unlink()
            except OSError:
                pass


def list_all() -> list:
    """Свои фоны (новые первыми), потом примеры. src — адрес для страницы."""
    out = []
    if USER_DIR.exists():
        for p in sorted(USER_DIR.glob("*.*"), key=lambda p: p.stat().st_mtime, reverse=True):
            if _valid_name(p.name):
                out.append({"id": f"user:{p.name}", "src": f"/api/backgrounds/{p.name}", "gif": p.suffix == ".gif",
                            "own": True})
    if EXAMPLES_DIR.exists():
        order = {name: i for i, name in enumerate(EXAMPLES_ORDER)}
        for p in sorted(EXAMPLES_DIR.glob("*.*"), key=lambda p: (order.get(p.name, 99), p.name)):
            if p.suffix.lstrip(".") in MIME:
                out.append({"id": f"example:{p.name}", "src": f"/backgrounds/{p.name}", "gif": p.suffix == ".gif",
                            "own": False})
    return out


def path_of(name: str) -> tuple:
    """Файл своего фона и его тип — для отдачи странице."""
    if not _valid_name(name):
        raise ValueError("нет такого фона")
    path = USER_DIR / name
    if not path.is_file():
        raise ValueError("нет такого фона")
    return path, MIME[name.partition(".")[2]]


def delete(name: str) -> None:
    path, _ = path_of(name)
    path.unlink()


def touch(name: str) -> None:
    """Выбрали фон из списка — он поднимается в начало (уборка удаляет самые старые)."""
    try:
        path, _ = path_of(name)
        path.touch()
    except (ValueError, OSError):
        pass


__all__ = ["save", "list_all", "path_of", "delete", "touch", "USER_DIR", "MAX_SIZE"]
