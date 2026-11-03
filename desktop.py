"""Sono как отдельное приложение: своё окно вместо вкладки браузера.

Запуск:  python desktop.py

Внутри всё тот же сервер из app.py, только он работает в фоне,
а страница открывается в окне через pywebview (на Windows это движок Edge).
"""
import os
import sys
import threading

# Медиаклавиши клавиатуры (▶/⏭/⏮, на ноутбуках — Fn+F5/F6/F7) и панель Windows с названием трека
# (всплывает у регулятора громкости): во встроенном Edge (WebView2) это выключено — клавиши работали,
# только пока окно в фокусе, а свёрнутое окно их не слышало. Включаем ту же функцию, что у обычного Chrome.
# WebView2 читает параметры из этой переменной при запуске, поэтому ставим её до import webview
_args = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
if "HardwareMediaKeyHandling" not in _args:
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (_args + " --enable-features=HardwareMediaKeyHandling").strip()

import webview  # noqa: E402
from werkzeug.serving import make_server

import titlebar
import tray
from app import DATA_DIR, app

# У .exe нет консоли, печатать некуда. Пишем всё в файл —
# его удобно смотреть, если что-то сломалось.
if getattr(sys, "frozen", False):
    sys.stdout = sys.stderr = open(DATA_DIR / "sono.log", "w", encoding="utf-8", buffering=1)

# Порт 0 — система сама выберет свободный, чтобы не мешать запущенному python app.py.
# threaded=True — чтобы поток аудио и предзагрузка ссылок не ждали друг друга.
server = make_server("127.0.0.1", 0, app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()   # daemon: закрыли окно — сервер умер
print(f"[desktop] сервер на http://127.0.0.1:{server.port}")

window = webview.create_window("Sono", f"http://127.0.0.1:{server.port}", width=1100, height=760,
                               min_size=(860, 600), background_color="#0a0a0a",   # тёмный фон — без белой вспышки
                               js_api=titlebar.WindowApi())   # кнопки своей полоски заголовка
# Системную полоску заголовка заменяем своей (titlebar.py) — до показа окна, чтобы не мелькала
window.events.before_show += titlebar.install
# Значок в трее: закрыли окно — музыка играет дальше (tray.py). HWND окна знает titlebar.install
tray.install(window, lambda: titlebar._hwnd or int(window.native.Handle.ToInt64()))
# private_mode=False — чтобы история поиска и громкость (localStorage) сохранялись между запусками
webview.start(private_mode=False, storage_path=str(DATA_DIR / "webview"))
