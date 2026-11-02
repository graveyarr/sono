"""Sono как отдельное приложение: своё окно вместо вкладки браузера.

Запуск:  python desktop.py

Внутри всё тот же сервер из app.py, только он работает в фоне,
а страница открывается в окне через pywebview (на Windows это движок Edge).
"""
import sys
import threading

import webview
from werkzeug.serving import make_server

import titlebar
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
# private_mode=False — чтобы история поиска и громкость (localStorage) сохранялись между запусками
webview.start(private_mode=False, storage_path=str(DATA_DIR / "webview"))
