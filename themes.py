"""Темы оформления: папка с theme.json + theme.css (и, по желанию, картинками/шрифтами и preview.png).

Встроенные темы лежат в static/themes/<имя>/, свои — в DATA_DIR/themes/<имя>/ (у .exe это
%LOCALAPPDATA%\\Sono\\themes). Страница подключает CSS темы поверх style.css — тема меняет
CSS-переменные (цвета, скругления, шрифт) и может переопределить любые стили. Как писать темы — THEMES.md.

Безопасность. Тему могут прислать чужие люди, поэтому CSS отдаётся только очищенным (clean_css):
- никаких внешних адресов: url(http…), //сайт, абсолютные пути — иначе тема могла бы «звонить домой»
  (узнать, что вы открыли Sono, и ваш адрес) или дёргать адреса самого плеера;
- @import убирается целиком (через него подгрузился бы неочищенный CSS);
- \\-экранирование вне строк убирается (им можно спрятать «url» от проверки).
Файлы из папки темы отдаются только картинки и шрифты, CSS напрямую не отдаётся. Скрипты темы не умеют.

Два вида папок (поле "part" в theme.json):
- "theme" (по умолчанию) — тема всего интерфейса: цвета, размеры, шрифт, вид и место кнопок, свои значки
  (папка icons/ — SVG-файлы с именами значков, их чистит clean_svg);
- "now" — вид экрана «Сейчас играет» (раскладка, фон, полоса перемотки). Выбирается отдельно от темы
  и подключается поверх неё вторым <link>.
"""

import json
import re
import shutil
import sys
import time
from pathlib import Path

MAX_CSS = 512 * 1024              # больше — это уже не тема
MAX_JSON = 32 * 1024
FILE_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
}
COVER_MODES = ("on", "off", "accent", "tint")   # что тема разрешает брать из обложки
PARTS = ("theme", "now")                         # тема всего Sono / вид «Сейчас играет»
TEMPLATES = {"theme": "_template", "now": "_template-now"}
MAX_ICON = 16 * 1024                             # один значок SVG
MAX_ICONS = 120

BUILTIN_DIR: Path = Path()
USER_DIR: Path = Path()


def init(base_dir: Path, data_dir: Path) -> None:
    global BUILTIN_DIR, USER_DIR
    BUILTIN_DIR = base_dir / "static" / "themes"
    USER_DIR = data_dir / "themes"


def _root(kind: str) -> Path:
    if kind == "builtin":
        return BUILTIN_DIR
    if kind == "user":
        return USER_DIR
    raise ValueError("нет такого вида тем")


def theme_dir(kind: str, name: str) -> Path:
    """Папка темы — только прямая вложенная папка в своей папке тем (никаких «..» и путей)."""
    root = _root(kind)
    if not name or name.startswith(".") or re.search(r'[\\/:*?"<>|\x00-\x1f]', name) or len(name) > 80:
        raise ValueError("неправильное имя темы")
    path = root / name
    if path.parent.resolve() != root.resolve() or not path.is_dir():
        raise ValueError("темы нет")
    return path


# ---------- Описание темы ----------

def _vtuple(v) -> tuple:
    nums = re.findall(r"\d+", str(v))
    return tuple(int(x) for x in nums[:3]) or (0,)


def needs_newer(requirement, current: str) -> str | None:
    """«sono»: ">=0.10" в theme.json. Вернёт нужную версию, если наша старее; из исходников ("0") — всё можно."""
    if not isinstance(requirement, str) or current in ("", "0"):
        return None
    m = re.match(r"\s*>=?\s*(\d+(?:\.\d+){0,2})\s*$", requirement)
    if not m:
        return None
    return m.group(1) if _vtuple(current) < _vtuple(m.group(1)) else None


def _text(value, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _color(value) -> str | None:
    """Цвета для карточки-образца: только #rgb/#rrggbb (их вставляет страница в стиль)."""
    return value if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?", value) else None


def read_theme(kind: str, name: str, current: str) -> dict | None:
    try:
        folder = theme_dir(kind, name)
    except ValueError:
        return None
    css = folder / "theme.css"
    if not css.is_file():
        return None
    meta: dict = {}
    meta_file = folder / "theme.json"
    error = ""
    if meta_file.is_file():
        try:
            raw = meta_file.read_bytes()[:MAX_JSON]
            meta = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(meta, dict):
                meta, error = {}, "theme.json — не объект {…}"
        except (OSError, ValueError) as e:
            error = f"theme.json не читается: {e}"
    cover = meta.get("coverColors", True)
    cover = "on" if cover is True else "off" if cover is False else cover if cover in COVER_MODES else "on"
    preview = [c for c in map(_color, meta.get("preview") or [] if isinstance(meta.get("preview"), list) else []) if c][:4]
    try:
        stamp = int(css.stat().st_mtime * 1000)
        size = css.stat().st_size
    except OSError:
        return None
    image = next((f"preview{ext}" for ext in (".png", ".jpg", ".webp") if (folder / f"preview{ext}").is_file()), "")
    part = meta.get("part") if meta.get("part") in PARTS else "theme"
    icons_dir = folder / "icons"
    try:
        icon_files = list(icons_dir.glob("*.svg"))[:MAX_ICONS] if part == "theme" and icons_dir.is_dir() else []
        has_icons = bool(icon_files)
        # Поправили значок — для страницы это тоже «тема изменилась» (перечитает и значки)
        stamp = max([stamp] + [int(f.stat().st_mtime * 1000) for f in icon_files])
    except OSError:
        has_icons = False
    return {
        "id": f"{kind}:{name}",
        "kind": kind,
        "folder": name,
        "name": _text(meta.get("name"), 60) or name,
        "author": _text(meta.get("author"), 60),
        "version": _text(str(meta.get("version", "")), 20),
        "description": _text(meta.get("description"), 300),
        "part": part,
        "coverColors": cover if part == "theme" else "on",   # у вида «Сейчас играет» цвета обложки решает тема
        "icons": has_icons,
        "preview": preview,
        "image": image,
        "needs": needs_newer(meta.get("sono"), current),
        "stamp": stamp,
        "tooBig": size > MAX_CSS,
        "error": error,
    }


def list_themes(current: str) -> list[dict]:
    out = []
    for kind in ("builtin", "user"):
        root = _root(kind)
        if not root.is_dir():
            continue
        names = sorted((p.name for p in root.iterdir() if p.is_dir()), key=str.lower)
        # Встроенные — в своём порядке (номер в начале имени папки не нужен: порядок из order.json)
        if kind == "builtin":
            try:
                order = json.loads((root / "order.json").read_text(encoding="utf-8"))
                names.sort(key=lambda n: order.index(n) if n in order else len(order))
            except (OSError, ValueError):
                pass
        for name in names:
            if name.startswith("_"):   # _template — заготовка для «Создать свою тему», не тема
                continue
            info = read_theme(kind, name, current)
            if info:
                out.append(info)
    return out


# ---------- Очистка CSS ----------

_SAFE_DATA = re.compile(r"^data:(image/(png|jpe?g|gif|webp|avif|svg\+xml)|font/[\w.+-]+|application/(font-woff2?|x-font-\w+))[;,]", re.I)
# «http:…», «javascript:…» — адрес; «Note: текст» (после двоеточия пробел) — просто текст для content
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:(?!\s)", re.I)


def _unescape(text: str) -> str:
    """Расшифровать \\-экранирование CSS (\\68 → h, \\: → :) — проверяем то, что увидит браузер."""
    def one(m: re.Match) -> str:
        hexa = m.group(1)
        if hexa:
            try:
                return chr(int(hexa, 16))
            except (ValueError, OverflowError):
                return "\ufffd"
        return m.group(2)
    return re.sub(r"\\(?:([0-9a-fA-F]{1,6})\s?|(.))", one, text, flags=re.S)


def safe_ref(value: str) -> bool:
    """Можно ли оставить строку/адрес: картинка/шрифт data:, относительный путь внутри темы или просто текст."""
    v = _unescape(value).strip().replace("\x00", "")
    if not v:
        return True
    if _SAFE_DATA.match(v):
        return True
    if v.startswith(("/", "\\")) or _SCHEME.match(v):
        return False
    if ".." in v.replace("\\", "/").split("/") or "%2e" in v.lower():
        return False   # «..» (и «%2e%2e» — браузер считает это тем же) вывело бы из папки темы
    return True


def clean_css(css: str) -> str:
    """Проходим CSS по символам: комментарии выкидываем, строки проверяем, экранирование вне строк убираем.
    Потом — url(…) без кавычек и @import."""
    out: list[str] = []
    i, n = 0, len(css)
    while i < n:
        c = css[i]
        if c == "/" and css.startswith("/*", i):
            end = css.find("*/", i + 2)
            i = n if end < 0 else end + 2
            out.append(" ")
            continue
        if c in "\"'":
            j = i + 1
            while j < n and css[j] != c and css[j] != "\n":
                j += 2 if css[j] == "\\" else 1
            body = css[i + 1:min(j, n)]
            out.append(f"{c}{body}{c}" if safe_ref(body) else f"{c}{c}")
            i = j + 1
            continue
        if c == "\\":
            i += 1          # экранирование вне строки: «u\72l(» → «u72l(» — уже не url
            continue
        out.append(c)
        i += 1
    text = "".join(out)

    def fix_url(m: re.Match) -> str:
        inner = m.group(1).strip()
        if inner[:1] in "\"'":
            return m.group(0)   # в кавычках — строку уже проверили выше
        return m.group(0) if safe_ref(inner) else "url()"
    text = re.sub(r"url\(([^)]*)\)", fix_url, text, flags=re.I)
    # @import — убираем совсем (браузер пропускает неизвестное «@sono-no-import»)
    text = re.sub(r"@import\b", "@sono-no-import", text, flags=re.I)
    return text


def theme_css(kind: str, name: str) -> str:
    folder = theme_dir(kind, name)
    raw = (folder / "theme.css").read_bytes()
    if len(raw) > MAX_CSS:
        raise ValueError("тема слишком большая (больше 512 КБ)")
    return clean_css(raw.decode("utf-8-sig", errors="replace"))


def theme_file(kind: str, name: str, rel: str) -> tuple[Path, str]:
    """Картинка или шрифт из папки темы (для url(картинка.png) в её CSS)."""
    folder = theme_dir(kind, name)
    path = (folder / rel).resolve()
    if folder.resolve() not in path.parents or not path.is_file():
        raise ValueError("нет файла")
    mime = FILE_TYPES.get(path.suffix.lower())
    if not mime:
        raise ValueError("такие файлы тема не отдаёт")
    return path, mime


# ---------- Свои значки темы (папка icons/) ----------

_SVG_NS = "{http://www.w3.org/2000/svg}"
_SVG_TAGS = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon"}
_SVG_ATTRS = {
    "viewBox", "d", "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "x1", "y1", "x2", "y2", "points",
    "fill", "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width", "stroke-opacity",
    "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
    "opacity", "transform", "shape-rendering", "vector-effect",
}
# Значения — только цифры, буквы, знаки чисел и путей; никаких url(…), кавычек, < > & ; и т.п.
_SVG_VALUE = re.compile(r"^[\w\s.,#%()+-]*$")


def clean_svg(text: str) -> str | None:
    """SVG-значок темы → безопасная разметка для вставки прямо в страницу (иначе <script>, onload=,
    ссылки и внешние картинки сработали бы внутри Sono). Оставляем только фигуры и их рисующие атрибуты,
    всё остальное выкидываем. Не разобрался — None."""
    import xml.etree.ElementTree as ET
    if len(text) > MAX_ICON or "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        return None
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None

    def tag(el) -> str:
        t = el.tag if isinstance(el.tag, str) else ""
        return t[len(_SVG_NS):] if t.startswith(_SVG_NS) else t

    def attrs(el) -> str:
        out = []
        for k, v in el.attrib.items():
            if k not in _SVG_ATTRS or "url" in v.lower() or not _SVG_VALUE.match(v) or len(v) > 4000:
                continue
            out.append(f' {k}="{v}"')
        return "".join(out)

    def walk(el, depth=0) -> str:
        if depth > 8:
            return ""
        t = tag(el)
        if t not in _SVG_TAGS or (t == "svg" and depth):
            return ""
        inner = "".join(walk(c, depth + 1) for c in el)
        return f"<{t}{attrs(el)}>{inner}</{t}>"

    if tag(root) != "svg":
        return None
    svg = walk(root)
    if 'viewBox="' not in svg[:200]:
        svg = svg.replace("<svg", '<svg viewBox="0 0 24 24"', 1)
    return svg


def theme_icons(kind: str, name: str) -> dict[str, str]:
    """Значки темы: icons/<имя значка>.svg → {имя: очищенная разметка}. Имена — как в static/js/icons.js."""
    folder = theme_dir(kind, name) / "icons"
    out: dict[str, str] = {}
    if not folder.is_dir():
        return out
    for path in sorted(folder.glob("*.svg"))[:MAX_ICONS]:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,39}", path.stem):
            continue
        try:
            svg = clean_svg(path.read_bytes()[:MAX_ICON + 1].decode("utf-8-sig", errors="replace"))
        except OSError:
            continue
        if svg:
            out[path.stem] = svg
    return out


# ---------- Своя тема из шаблона ----------

def create_from_template(title: str, part: str = "theme") -> str:
    """Копия заготовки (темы или вида «Сейчас играет») в папку своих тем под новым именем. Вернёт имя папки."""
    USER_DIR.mkdir(parents=True, exist_ok=True)
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", title or "").strip(" .")[:40] or "Моя тема"
    name, n = base, 2
    while (USER_DIR / name).exists():
        name, n = f"{base} {n}", n + 1
    template = BUILTIN_DIR / TEMPLATES.get(part, "_template")
    shutil.copytree(template, USER_DIR / name)
    meta_file = USER_DIR / name / "theme.json"
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    meta["name"] = name
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return name


# ---------- Удаление своей темы ----------

def _to_recycle_bin(path: Path) -> bool:
    """Windows: папку — в Корзину (можно восстановить). Вернёт False, если не вышло."""
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

    FO_DELETE = 3
    FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 0x4, 0x10, 0x40, 0x400
    op = SHFILEOPSTRUCTW(wFunc=FO_DELETE, pFrom=str(path.resolve()) + "\0\0",
                         fFlags=FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI)
    return ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0 and not op.fAnyOperationsAborted and not path.exists()


def delete_user_theme(name: str) -> str:
    """Удалить свою тему (встроенные удалить нельзя). Windows — в Корзину; иначе (или Корзина не сработала)
    папка переезжает в DATA_DIR/themes-deleted — ничего не стирается насовсем. Вернёт, куда делась тема."""
    path = theme_dir("user", name)
    if _to_recycle_bin(path):
        return "trash"
    bin_dir = USER_DIR.parent / "themes-deleted"
    bin_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(bin_dir / f"{name} {time.strftime('%Y-%m-%d %H-%M-%S')}"))
    return "moved"
