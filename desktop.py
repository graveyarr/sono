"""Sono как отдельное приложение: своё окно вместо вкладки браузера.

Запуск:  python desktop.py

Внутри всё тот же сервер из app.py, только он работает в фоне,
а страница открывается в окне через pywebview (на Windows это движок Edge).

Окно появляется сразу — с логотипом, а сервер (yt-dlp, Flask — около секунды) загружается
одновременно с движком окна. Раньше сначала грузился сервер, и только потом показывалось окно.
"""
import html
import json
import os
import secrets
import sys
import threading
import time
import traceback
import urllib.request

_started = time.perf_counter()

# Медиаклавиши клавиатуры (▶/⏭/⏮) ловит значок в трее (tray.MEDIA_KEYS): встроенный Edge (WebView2) слышит
# их, только пока окно в фокусе. Флаг --enable-features=HardwareMediaKeyHandling (раньше ставился здесь
# переменной окружения) не помогает: pywebview перекрывает переменную, а дописанный в параметры флаг
# Windows всё равно не делает Sono медиаплеером (проверено в песочнице 16–17 ноября)

from paths import DATA_DIR  # noqa: E402

# ---------- Одна копия программы ----------
# Sono часто живёт в трее (окно закрыли — музыка играет). Раньше ярлык тогда запускал вторую копию,
# а установщик обновления не мог заменить файлы, пока первая их держит, — обновление молча не вставало.
# Теперь запущенная копия записывает свой адрес в instance.json, а новая просит её показать окно и выходит.
INSTANCE_FILE = DATA_DIR / "instance.json"


def _link_from_args() -> str | None:
    """Кнопка «+ Sono» в браузере открывает адрес sono://add?url=<ссылка на трек> — Windows запускает
    SonoMusic.exe с этим адресом (установщик регистрирует sono://). Достаём ссылку на трек."""
    for arg in sys.argv[1:]:
        if arg.lower().startswith("sono:"):
            from urllib.parse import parse_qs, urlsplit
            url = (parse_qs(urlsplit(arg).query).get("url") or [""])[0]
            return url[:2000] or None
    return None


LINK = _link_from_args()
# Автозапуск вместе с Windows (настройка, system.js / autostart в app.py) запускает «SonoMusic.exe --tray»:
# окна не видно, Sono сразу в трее — открыть щелчком по значку
IN_TRAY = "--tray" in sys.argv[1:]


def _wake_running() -> bool:
    try:
        info = json.loads(INSTANCE_FILE.read_text(encoding="utf-8"))
        if sys.platform == "win32" and not LINK and not IN_TRAY:   # разрешить той копии выйти на передний план (иначе Windows мигнёт кнопкой)
            import ctypes
            ctypes.windll.user32.AllowSetForegroundWindow(int(info["pid"]))
        body = (json.dumps({"open": LINK}).encode() if LINK
                else b'{"quiet": true}' if IN_TRAY else b"{}")
        req = urllib.request.Request(f"http://127.0.0.1:{int(info['port'])}/api/instance/show", data=body,
                                     method="POST", headers={"X-Sono-Instance": str(info["token"]),
                                                             "Content-Type": "application/json"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # мимо прокси из переменных окружения
        with opener.open(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False   # файла нет, копия закрыта или не отвечает — запускаемся сами


def _first_copy() -> bool:
    """Замок Windows (mutex) — его берёт первая копия в самом начале запуска. instance.json появляется только
    через 2–3 с (когда загрузится сервер), и пока первая копия грузилась, второй запуск ярлыком открывал
    второе Sono (нашёл автор, 22 ноября). Имя замка — от папки данных: «python desktop.py» и установленный
    Sono друг другу не мешают. Замок держится до выхода процесса — Windows снимает его сама."""
    if sys.platform != "win32":
        return True
    try:
        import ctypes
        import hashlib
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        name = "Local\\SonoMusic-" + hashlib.md5(str(DATA_DIR).lower().encode()).hexdigest()[:16]
        globals()["_MUTEX"] = kernel32.CreateMutexW(None, False, name)   # не закрываем до выхода
        return ctypes.get_last_error() != 183   # ERROR_ALREADY_EXISTS — другая копия уже запущена
    except Exception:
        return True


if _first_copy():
    if _wake_running():   # копия старой версии (без замка) ещё работает
        sys.exit(0)
else:
    # Другая копия уже есть, но, может быть, ещё грузится — ждём её сервер и просим показать окно
    for _ in range(40):   # ~20 с
        if _wake_running():
            sys.exit(0)
        time.sleep(0.5)
    # Так и не ответила (зависла?) — запускаемся сами, как раньше

import webview  # noqa: E402

import titlebar  # noqa: E402
import tray  # noqa: E402

# У .exe нет консоли, печатать некуда. Пишем всё в файл —
# его удобно смотреть, если что-то сломалось.
if getattr(sys, "frozen", False):
    sys.stdout = sys.stderr = open(DATA_DIR / "sono.log", "w", encoding="utf-8", buffering=1)

# ---------- Заставка, пока грузится программа (вариант А «Живая обложка», выбрал автор 22 ноября) ----------
# Пятна цвета последнего трека расцветают, буквы «sono» всплывают, точка бьётся в такт, снизу полоска загрузки.
# Страница продолжает её с того же кадра (#boot в index.html, style.css «Заставка», boot.js): логотип улетает
# на своё место в медиатеке, программа проявляется. Цвет — оттенок обложки, который запоминает player.js
# (настройка «splash»); в светлой теме — светлая; «Без анимаций» — без движения. Макет — design/splash.

def _hex(h: float, s: float, l: float) -> str:
    import colorsys
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360, max(0.0, min(1.0, l / 100)), max(0.0, min(1.0, s / 100)))
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def _splash_look() -> dict:
    """Цвета и режим заставки из медиатеки (читаем до окна — это быстро, сервер ещё грузится)."""
    settings = {}
    try:
        settings = json.loads((DATA_DIR / "library.json").read_text(encoding="utf-8")).get("settings") or {}
    except Exception:
        pass
    hs = settings.get("splash")
    h, s = (hs[0], hs[1]) if isinstance(hs, list) and len(hs) == 2 and all(isinstance(x, (int, float)) for x in hs) else (275, 70)
    if s < 12:
        h, s = 275, 70   # серая обложка — фиолетовый Sono
    s = max(45, min(80, s))
    light = settings.get("theme") == "builtin:light"
    up = 14 if light else 0
    return {
        "c1": _hex(h, s, 50 + up), "c2": _hex(h + 30, s, 60 + up), "c3": _hex(h - 35, s, 46 + up),
        "ac": _hex(h, max(s, 55), 62 if light else 72),
        "bg": "#f3eef6" if light else "#0a0a0a", "fg": "#16121c" if light else "#ffffff",
        "light": light, "calm": settings.get("reduceMotion") is True,
    }


SPLASH_LOOK = _splash_look()
# Правила заставки — общие со страницей (static/boot.css): страница подхватывает её с того же кадра без шва
try:
    from paths import BASE_DIR
    SPLASH_CSS = (BASE_DIR / "static" / "boot.css").read_text(encoding="utf-8")
except OSError:
    SPLASH_CSS = ""   # файла нет — просто фон без заставки (окно всё равно откроется)
SPLASH = ("""<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%%;background:%(bg)s;overflow:hidden;cursor:default;user-select:none}
:root{--boot-bg:%(bg)s;--boot-fg:%(fg)s;--boot-c1:%(c1)s;--boot-c2:%(c2)s;--boot-c3:%(c3)s;--boot-ac:%(ac)s}
""" % SPLASH_LOOK + SPLASH_CSS + """</style></head><body>
<div class="boot%s"><i class="boot-b boot-b1"></i><i class="boot-b boot-b2"></i><i class="boot-b boot-b3"></i>
<div class="boot-logo"><i>s</i><i>o</i><i>n</i><i>o</i><i class="boot-dot">.</i></div><div class="boot-bar"></div></div>
</body></html>""" % ((" light" if SPLASH_LOOK["light"] else "") + (" calm" if SPLASH_LOOK["calm"] else "")))
_splash_shown = None   # когда заставка появилась на экране (perf_counter) — страница продолжит с того же места

# Сервер грузится в своём потоке прямо сейчас — одновременно с движком окна (WebView2)
_server = {}
_server_ready = threading.Event()


def _show_window():
    """Показать окно (вторая копия попросила): из трея, из свёрнутого, поверх остальных"""
    if tray._main_hwnd:
        tray.show_window()
    else:
        window.show()


def _page_incoming():
    """Пришла ссылка из браузера, а страница уже открыта — пусть заберёт её (main.js → window.sonoIncoming)."""
    threading.Thread(target=lambda: window.evaluate_js("window.sonoIncoming && window.sonoIncoming()"),
                     daemon=True).start()


def _load_server():
    try:
        from werkzeug.serving import make_server
        from app import add_incoming, app
        if LINK:
            add_incoming(LINK)   # Sono запустили кнопкой из браузера — страница заберёт трек, когда загрузится
        # Порт 0 — система сама выберет свободный, чтобы не мешать запущенному python app.py.
        # threaded=True — чтобы поток аудио и предзагрузка ссылок не ждали друг друга.
        server = make_server("127.0.0.1", 0, app, threaded=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()   # daemon: закрыли окно — сервер умер
        _server["port"] = server.port
        token = secrets.token_hex(8)   # чтобы откликалась только наша программа, а не что-то на том же порту
        app.config.update(INSTANCE_TOKEN=token, SHOW_WINDOW=_show_window, PAGE_INCOMING=_page_incoming)
        try:
            INSTANCE_FILE.write_text(json.dumps({"pid": os.getpid(), "port": server.port, "token": token}), encoding="utf-8")
        except OSError:
            pass
        print(f"[desktop] сервер на http://127.0.0.1:{server.port} — через {time.perf_counter() - _started:.2f} с после запуска")
    except Exception:
        traceback.print_exc()
        _server["error"] = traceback.format_exc()
    finally:
        _server_ready.set()


threading.Thread(target=_load_server, daemon=True).start()

def _fit_window(want_w=1100, want_h=760, min_w=860, min_h=600, gap=24):
    """Размер и место окна под экран. Раньше было всегда 1100×760 — на ноутбуке 1366×768
    низ окна с плеером уходил под панель задач (проверка А1 в песочнице, 16 ноября).
    Всё в логических пикселях (как ждёт pywebview): рабочая область — экран без панели задач."""
    try:
        import ctypes
        from ctypes import wintypes
        rect = wintypes.RECT()
        ctypes.windll.user32.SystemParametersInfoW(0x30, 0, ctypes.byref(rect), 0)   # SPI_GETWORKAREA
        scale = (ctypes.windll.user32.GetDpiForSystem() or 96) / 96
        left, top = rect.left / scale, rect.top / scale
        wa_w, wa_h = (rect.right - rect.left) / scale, (rect.bottom - rect.top) / scale
        if wa_w < 200 or wa_h < 200:
            raise ValueError("странная рабочая область")
    except Exception:
        return dict(width=want_w, height=want_h, min_size=(min_w, min_h))
    w = int(min(want_w, wa_w - gap * 2))
    h = int(min(want_h, wa_h - gap * 2))
    min_w, min_h = min(min_w, w), min(min_h, h)   # совсем маленький экран: даём окну быть меньше
    return dict(width=w, height=h, min_size=(min_w, min_h),
                x=int(left + (wa_w - w) / 2), y=int(top + (wa_h - h) / 2))


window = webview.create_window("Sono", html=SPLASH, **_fit_window(),
                               background_color=SPLASH_LOOK["bg"],   # фон заставки — без белой вспышки
                               minimized=IN_TRAY,   # автозапуск: окно не выскакивает посреди экрана
                               js_api=titlebar.WindowApi())   # кнопки своей полоски заголовка
# Первые ~0,8 с окно тёмное — встроенный браузер ещё запускается. Прятать окно до заставки (hidden=True) пробовали
# 22 ноября: в скрытом окне браузер не запускается вовсе, окно появлялось на 2 с позже — хуже


def _splash_seen():
    """Заставка нарисована — отсюда считаем, сколько она уже идёт (страница продолжит с того же места)."""
    global _splash_shown
    if _splash_shown is None:
        _splash_shown = time.perf_counter()


if not IN_TRAY:
    window.events.loaded += _splash_seen   # первая загрузка — сама заставка
# Системную полоску заголовка заменяем своей (titlebar.py) — до показа окна, чтобы не мелькала
window.events.before_show += titlebar.install
# Значок в трее: закрыли окно — музыка играет дальше (tray.py). HWND окна знает titlebar.install
tray.install(window, lambda: titlebar._hwnd or int(window.native.Handle.ToInt64()))

if IN_TRAY and sys.platform == "win32":
    def _hide_to_tray():
        """Автозапуск: свёрнутое окно прячем совсем (и с панели задач) — Sono ждёт в трее."""
        import ctypes
        hwnd = titlebar._hwnd or int(window.native.Handle.ToInt64())
        ctypes.windll.user32.ShowWindow(hwnd, 0)   # SW_HIDE; значок в трее вернёт окно (SW_RESTORE)
    window.events.shown += _hide_to_tray


def boot():
    """Запускается вместе с окном: ждём сервер и открываем в окне саму программу"""
    print(f"[desktop] окно через {time.perf_counter() - _started:.2f} с после запуска")
    _server_ready.wait()
    if "error" in _server:
        # Раньше в таком случае окно просто не появлялось — теперь хотя бы видно, что сломалось
        window.load_html(f'<body style="background:#0a0a0a;color:#ddd;font:14px Segoe UI;padding:24px">'
                         f'<h3>Sono не запустился</h3><pre style="white-space:pre-wrap">{html.escape(_server["error"])}</pre></body>')
        return
    window.events.loaded += lambda: print(f"[desktop] страница загружена через {time.perf_counter() - _started:.2f} с")
    url = f"http://127.0.0.1:{_server['port']}"
    if not IN_TRAY:   # в трее заставку никто не видит — страница открывается как обычно
        # Страница продолжит заставку: сколько она уже на экране (мс) и её цвета (без «#»)
        from urllib.parse import urlencode
        look = SPLASH_LOOK
        url += "/?" + urlencode({"splash": round((time.perf_counter() - (_splash_shown or time.perf_counter())) * 1000),
                                 "c": ",".join(look[k].lstrip("#") for k in ("c1", "c2", "c3", "ac", "bg", "fg")),
                                 "m": ("l" if look["light"] else "") + ("c" if look["calm"] else "")})
    window.load_url(url)


# private_mode=False — чтобы история поиска и громкость (localStorage) сохранялись между запусками
webview.start(boot, private_mode=False, storage_path=str(DATA_DIR / "webview"))
