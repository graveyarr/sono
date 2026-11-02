"""Обход замедления YouTube и SoundCloud — только для запросов самого плеера.

Провайдеры в России узнают, куда идёт защищённое (HTTPS) соединение, по имени сайта
в самом первом пакете (TLS ClientHello, поле SNI), и замедляют или режут такие соединения.
Сервер YouTube же спокойно соберёт этот пакет, даже если его прислать по частям.

Поэтому здесь — маленький локальный прокси (127.0.0.1): плеер ходит в интернет через него,
а он режет первый пакет каждого соединения так, чтобы фильтр не смог прочитать имя сайта.
Способов резки несколько — у разных провайдеров срабатывают разные (их подбирает замер скорости).
Тот же принцип, что у zapret и ByeDPI, но без драйверов и прав администратора: работает
только для трафика плеера, остальную систему не трогает.
"""
import socket
import threading
import time

# Способы резки первого пакета (подписи — для экрана настроек)
STRATEGIES = {
    "tlsrec": "Разрезать TLS-запись на две",
    "split": "Отправить пакет двумя частями",
    "tlsrec+split": "Разрезать запись и отправить частями",
    "disorder": "Отправить части не по порядку",
}


def _sni_offset(data: bytes) -> int | None:
    """Где в первом пакете лежит имя сайта (SNI). None — это не TLS ClientHello."""
    if len(data) < 50 or data[0] != 0x16 or data[5] != 0x01:   # 0x16 — рукопожатие TLS, 0x01 — ClientHello
        return None
    try:
        pos = 5 + 4 + 2 + 32                       # заголовок записи, заголовок рукопожатия, версия, random
        pos += 1 + data[pos]                       # session id
        pos += 2 + int.from_bytes(data[pos:pos + 2], "big")   # шифры
        pos += 1 + data[pos]                       # сжатие
        end = pos + 2 + int.from_bytes(data[pos:pos + 2], "big")
        pos += 2
        while pos + 4 <= end:                      # расширения: ищем server_name (тип 0)
            ext_type = int.from_bytes(data[pos:pos + 2], "big")
            ext_len = int.from_bytes(data[pos + 2:pos + 4], "big")
            if ext_type == 0:
                return pos + 4 + 2 + 1 + 2         # список имён → тип имени → длина имени → само имя
            pos += 4 + ext_len
    except IndexError:
        pass
    return None


def _split_record(data: bytes, cut: int) -> tuple[bytes, bytes]:
    """Делит первую TLS-запись на две записи в месте cut (смещение от начала данных)."""
    length = int.from_bytes(data[3:5], "big")
    body, rest = data[5:5 + length], data[5 + length:]
    cut = min(max(1, cut - 5), len(body) - 1)
    head = data[:3]
    first = head + cut.to_bytes(2, "big") + body[:cut]
    second = head + (len(body) - cut).to_bytes(2, "big") + body[cut:]
    return first, second + rest


def send_first_packet(sock: socket.socket, data: bytes, strategy: str) -> None:
    """Отправляет первый пакет соединения, разрезая его так, чтобы фильтр не увидел имя сайта."""
    sni = _sni_offset(data)
    if sni is None:   # это не HTTPS — отправляем как есть
        sock.sendall(data)
        return
    cut = sni + 2   # режем прямо посреди имени сайта: «yo|utube.com»
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)   # чтобы части ушли отдельными пакетами

    if strategy == "tlsrec":
        first, second = _split_record(data, cut)
        sock.sendall(first + second)
    elif strategy == "split":
        sock.sendall(data[:cut])
        time.sleep(0.01)
        sock.sendall(data[cut:])
    elif strategy == "tlsrec+split":
        first, second = _split_record(data, cut)
        sock.sendall(first)
        time.sleep(0.01)
        sock.sendall(second)
    elif strategy == "disorder":
        # Первую часть отправляем с TTL=1: до сервера она не дойдёт, и система сама пришлёт её
        # повторно, уже после второй. Фильтр видит части не по порядку и не может их склеить.
        ttl = sock.getsockopt(socket.IPPROTO_IP, socket.IP_TTL)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, 1)
        sock.send(data[:cut])
        time.sleep(0.01)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl or 64)
        sock.sendall(data[cut:])
    else:
        sock.sendall(data)


class DesyncProxy:
    """Локальный HTTP-прокси (метод CONNECT): плеер просит соединиться с сайтом,
    прокси соединяется, первый пакет режет выбранным способом, остальное пересылает как есть."""

    def __init__(self, strategy: str):
        self.strategy = strategy
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(128)
        self.port = self.server.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.running = True
        threading.Thread(target=self._accept, daemon=True).start()

    def stop(self):
        self.running = False
        try:
            self.server.close()
        except OSError:
            pass

    def _accept(self):
        while self.running:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client: socket.socket):
        upstream = None
        try:
            request = b""
            while b"\r\n\r\n" not in request and len(request) < 16384:
                chunk = client.recv(4096)
                if not chunk:
                    return
                request += chunk
            method, target = request.split(b" ", 2)[:2]
            if method.upper() != b"CONNECT":   # обычный HTTP без шифрования нам не нужен
                client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
                return
            host, _, port = target.decode().rpartition(":")
            upstream = socket.create_connection((host.strip("[]"), int(port or 443)), timeout=10)
            upstream.settimeout(None)
            client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            first = client.recv(65536)
            if not first:
                return
            send_first_packet(upstream, first, self.strategy)
            # Дальше просто пересылаем в обе стороны
            other = threading.Thread(target=self._pipe, args=(upstream, client), daemon=True)
            other.start()
            self._pipe(client, upstream)
            other.join(timeout=60)
        except (OSError, ValueError):
            pass
        finally:
            for s in (client, upstream):
                if s:
                    try:
                        s.close()
                    except OSError:
                        pass

    @staticmethod
    def _pipe(src: socket.socket, dst: socket.socket):
        try:
            while data := src.recv(65536):
                dst.sendall(data)
        except OSError:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)   # сообщаем другой стороне, что данных больше не будет
            except OSError:
                pass
