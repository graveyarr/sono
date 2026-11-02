"""Статус в Discord: «Слушает Sono — Название · Исполнитель» с обложкой и полоской времени.

Discord на компьютере слушает локальный канал (на Windows — именованный канал \\\\.\\pipe\\discord-ipc-N).
Протокол простой: кадр = код операции (4 байта) + длина (4 байта) + JSON.
Сначала «рукопожатие» с id приложения Discord (его создают один раз на discord.com/developers,
имя приложения и есть «Sono» в строке «Слушает Sono»), потом команды SET_ACTIVITY.
Без внешних библиотек. Если Discord не запущен — тихо пробуем снова раз в 15 секунд.
"""
from __future__ import annotations

import json
import os
import struct
import sys
import threading
import time
import uuid

# id приложения Discord «Sono» (публичный, не секрет). Пусто — функция выключена.
CLIENT_ID = "1566649138169520298"

OP_HANDSHAKE, OP_FRAME, OP_CLOSE = 0, 1, 2
RETRY = 15   # секунд между попытками подключиться, если Discord не запущен


class Presence:
    def __init__(self, client_id: str):
        self.client_id = client_id
        self._pipe = None
        self._wanted: dict | None = None   # что показать (None — ничего)
        self._sent = None                  # что уже показано (при запуске — ничего)
        self._event = threading.Event()
        self._lock = threading.Lock()
        self.connected = False
        self.error = ""
        if client_id and sys.platform == "win32":
            threading.Thread(target=self._loop, daemon=True, name="discord-rpc").start()

    # ---------- Что показать ----------

    def show(self, activity: dict | None) -> None:
        with self._lock:
            self._wanted = activity
        self._event.set()

    # ---------- Работа с каналом ----------

    def _connect(self) -> bool:
        for n in range(10):
            try:
                pipe = open(rf"\\.\pipe\discord-ipc-{n}", "r+b", buffering=0)
            except OSError:
                continue
            try:
                self._pipe = pipe
                self._send(OP_HANDSHAKE, {"v": 1, "client_id": self.client_id})
                op, data = self._recv()
                if op == OP_FRAME and data.get("evt") == "READY":
                    self.connected, self.error = True, ""
                    user = (data.get("data") or {}).get("user") or {}
                    print(f"[discord] подключился ({user.get('username', '?')})")
                    return True
                self.error = data.get("message") or "Discord не принял подключение"
                print(f"[discord] {self.error}")
            except OSError as e:
                self.error = str(e)
            self._close()
        if not self.error:
            self.error = "Discord не запущен"
        return False

    def _close(self):
        try:
            if self._pipe:
                self._pipe.close()
        except OSError:
            pass
        self._pipe = None
        self.connected = False

    def _send(self, op: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._pipe.write(struct.pack("<II", op, len(body)) + body)

    def _recv(self) -> tuple[int, dict]:
        head = self._pipe.read(8)
        if len(head) < 8:
            raise OSError("Discord закрыл соединение")
        op, length = struct.unpack("<II", head)
        body = b""
        while len(body) < length:
            chunk = self._pipe.read(length - len(body))
            if not chunk:
                raise OSError("Discord закрыл соединение")
            body += chunk
        return op, json.loads(body.decode("utf-8") or "{}")

    def _loop(self):
        while True:
            self._event.wait(RETRY)
            self._event.clear()
            with self._lock:
                wanted = self._wanted
            if wanted is self._sent:
                continue
            if not self._pipe and not self._connect():
                continue
            try:
                self._send(OP_FRAME, {"cmd": "SET_ACTIVITY", "nonce": str(uuid.uuid4()),
                                      "args": {"pid": os.getpid(), "activity": wanted}})
                op, data = self._recv()
                if op == OP_CLOSE:
                    raise OSError(data.get("message") or "Discord закрыл соединение")
                if data.get("evt") == "ERROR":
                    self.error = (data.get("data") or {}).get("message") or "ошибка"
                    print(f"[discord] {self.error}")
                self._sent = wanted
            except (OSError, ValueError) as e:
                print(f"[discord] связь потеряна: {e}")
                self._close()
                self._event.set()   # попробуем переподключиться и отправить снова
                time.sleep(2)


def activity(title: str, artist: str, *, album: str = "", cover: str = "", url: str = "",
             position: float = 0, duration: float = 0, source: str = "") -> dict:
    """Статус «Слушает»: название, исполнитель, обложка и полоска времени."""
    clip = lambda s, n=128: (s or "")[:n].ljust(2)   # Discord требует от 2 до 128 символов
    now = time.time()
    act = {"type": 2, "details": clip(title), "state": clip(artist)}   # type 2 — «Слушает»
    if duration:
        act["timestamps"] = {"start": int((now - position) * 1000), "end": int((now - position + duration) * 1000)}
    if cover:
        act["assets"] = {"large_image": cover, "large_text": clip(album or title)}
    if url:
        act["buttons"] = [{"label": f"Открыть на {source}" if source else "Открыть", "url": url}]
    return act
