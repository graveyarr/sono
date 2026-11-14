"""Плеер для стрима (OBS): маленькая страница «что играет в Sono» на постоянном адресе.

У самого Sono адрес каждый запуск новый (свободный порт), а в OBS адрес вписывают один раз —
поэтому плеер для стрима живёт на отдельном маленьком сервере с постоянным портом OBS_PORT.
Сервер только показывает: страница (static/obs.html) и то, что играет (/now). Ничего не принимает
и ничего не меняет — даже если адрес узнает чужая страница в браузере, она увидит только название трека.
Включается в настройках («Плеер для стрима»), что играет — сообщает страница Sono через app.py.
"""

import threading
import time

from flask import Flask, jsonify, send_file

from paths import BASE_DIR

OBS_PORT = 47800
PAGE = BASE_DIR / "static" / "obs.html"

_state: dict = {}          # что играет: title, artist, cover, source, position, duration, playing, key, at
_lock = threading.Lock()
_server = None
error = ""                 # почему не запустился (порт занят и т. п.)

obs_app = Flask(__name__, static_folder=None)


def set_state(data: dict | None) -> None:
    """Новый трек / пауза / перемотка. at — когда это было (по нему страница двигает полоску сама)"""
    with _lock:
        _state.clear()
        if data:
            _state.update(data, at=time.time())


@obs_app.get("/")
def page():
    return send_file(PAGE, mimetype="text/html", max_age=0)


@obs_app.get("/now")
def now():
    with _lock:
        data = dict(_state)
    at = data.pop("at", time.time())
    data.pop("key", None)
    if data.get("playing"):
        # Сколько уже сыграно прямо сейчас (страница не знает, когда пришло последнее сообщение)
        data["position"] = float(data.get("position") or 0) + (time.time() - at) * float(data.get("speed") or 1)
    data.setdefault("playing", False)
    resp = jsonify(data)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def running() -> bool:
    return _server is not None


def start() -> bool:
    """Запустить сервер (если ещё не запущен). False — не вышло, причина в error"""
    global _server, error
    if _server:
        return True
    from werkzeug.serving import make_server
    try:
        srv = make_server("127.0.0.1", OBS_PORT, obs_app, threaded=True)
    except OSError as e:
        error = f"порт {OBS_PORT} занят другой программой" if getattr(e, "winerror", 0) == 10048 or e.errno in (98, 10048) \
            else str(e)
        print(f"[obs] не запустился: {e}")
        return False
    error = ""
    _server = srv
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[obs] плеер для стрима: http://127.0.0.1:{OBS_PORT}/")
    return True


def stop() -> None:
    global _server
    srv, _server = _server, None
    if srv:
        threading.Thread(target=srv.shutdown, daemon=True).start()
