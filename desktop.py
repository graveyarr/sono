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


if _wake_running():
    sys.exit(0)

import webview  # noqa: E402

import titlebar  # noqa: E402
import tray  # noqa: E402

# У .exe нет консоли, печатать некуда. Пишем всё в файл —
# его удобно смотреть, если что-то сломалось.
if getattr(sys, "frozen", False):
    sys.stdout = sys.stderr = open(DATA_DIR / "sono.log", "w", encoding="utf-8", buffering=1)

# Заставка, пока грузится сервер: логотип «sono.» по центру, как значок. Проявляется не сразу —
# если всё загрузилось быстро, её просто не успеют заметить (без мигания)
SPLASH = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0a0a0a;overflow:hidden;cursor:default;user-select:none}
body{display:grid;place-items:center}
b{font:700 54px "Century Gothic","Segoe UI",sans-serif;color:#fff;letter-spacing:-1px;opacity:0;
  animation:in .5s ease-out .25s forwards}
@keyframes in{to{opacity:.9}}
</style></head><body><b>sono.</b></body></html>"""

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
                               background_color="#0a0a0a",   # тёмный фон — без белой вспышки
                               minimized=IN_TRAY,   # автозапуск: окно не выскакивает посреди экрана
                               js_api=titlebar.WindowApi())   # кнопки своей полоски заголовка
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
    """Запускается, когда окно уже на экране: ждём сервер и открываем в окне саму программу"""
    print(f"[desktop] окно через {time.perf_counter() - _started:.2f} с после запуска")
    _server_ready.wait()
    if "error" in _server:
        # Раньше в таком случае окно просто не появлялось — теперь хотя бы видно, что сломалось
        window.load_html(f'<body style="background:#0a0a0a;color:#ddd;font:14px Segoe UI;padding:24px">'
                         f'<h3>Sono не запустился</h3><pre style="white-space:pre-wrap">{html.escape(_server["error"])}</pre></body>')
        return
    window.events.loaded += lambda: print(f"[desktop] страница загружена через {time.perf_counter() - _started:.2f} с")
    window.load_url(f"http://127.0.0.1:{_server['port']}")


# private_mode=False — чтобы история поиска и громкость (localStorage) сохранялись между запусками
webview.start(boot, private_mode=False, storage_path=str(DATA_DIR / "webview"))
