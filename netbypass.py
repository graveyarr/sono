"""Обход замедления YouTube и SoundCloud — только для запросов самого плеера.

Провайдеры в России узнают, куда идёт защищённое (HTTPS) соединение, по имени сайта
в самом первом пакете (TLS ClientHello, поле SNI), и замедляют или режут такие соединения.
Сервер YouTube же спокойно соберёт этот пакет, даже если его прислать по частям.

Поэтому здесь — маленький локальный прокси (127.0.0.1): плеер ходит в интернет через него,
а он режет первый пакет каждого соединения так, чтобы фильтр не смог прочитать имя сайта.
Способов резки несколько — у разных провайдеров срабатывают разные (их подбирает замер скорости).
Тот же принцип, что у zapret и ByeDPI, но без драйверов и прав администратора: работает
только для трафика плеера, остальную систему не трогает.

SoundCloud сложнее: он живёт в сети Amazon CloudFront, а соединения с «иностранными хостингами»,
чьё имя фильтр не узнал, он замораживает после ~16 КБ. Спрятать имя мало — нужно ещё показать
фильтру разрешённое. Для этого способ fake: сначала уходит поддельное приветствие с именем
www.google.com, но с маленьким TTL — до фильтра оно доходит, а до сервера нет. Сервер получает
настоящее (система сама пересылает «потерянный» пакет, уже с настоящими байтами — см. send_fake).
"""
import json
import mmap
import os
import select
import socket
import ssl
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

# Способы резки первого пакета (подписи — для экрана настроек)
STRATEGIES = {
    "tlsrec": "Разрезать TLS-запись на две",
    "split": "Отправить пакет двумя частями",
    "tlsrec+split": "Разрезать запись и отправить частями",
    "disorder": "Отправить части не по порядку",
    "oob": "Вставить лишний байт посреди имени",
    "fake": "Подделка + лишний байт",
}

# Сайты SoundCloud — для них свой способ (обычно fake, см. описание модуля)
SC_HOSTS = ("soundcloud.com", "sndcdn.com", "soundcloud.cloud")
FAKE_HOST = b"www.google.com"   # имя в поддельном приветствии — фильтр такое пропускает


# Сайты YouTube (и картинки Google, где лежат аватары YouTube Music). Обход нужен только им и SoundCloud:
# остальные (Яндекс, Deezer, LRCLIB, GitHub…) не заблокированы, а некоторые из них «лишний байт»
# не выбрасывают и зависают (Deezer — замер 3 ноября 2026) — их соединения пересылаем как есть
YT_HOSTS = ("youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "ggpht.com",
            "googleusercontent.com", "youtube-nocookie.com", "youtubei.googleapis.com")


def _matches(host: str, names: tuple) -> bool:
    host = host.lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in names)


def is_soundcloud(host: str) -> bool:
    return _matches(host, SC_HOSTS)


def needs_bypass(host: str) -> bool:
    return _matches(host, YT_HOSTS) or is_soundcloud(host)


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


def build_fake(size: int, host: bytes = FAKE_HOST) -> bytes | None:
    """Поддельное приветствие TLS с разрешённым именем — ровно size байт (добивается расширением padding).
    Фильтру оно кажется настоящим началом соединения. None — в size оно не помещается."""
    name = (b"\0" + len(host).to_bytes(2, "big") + host)
    sni = b"\0\0" + (len(name) + 2).to_bytes(2, "big") + len(name).to_bytes(2, "big") + name
    versions = bytes.fromhex("002b0003020304")   # supported_versions: TLS 1.3

    def make(pad: int, session: bytes) -> bytes:
        exts = sni + versions + (b"\0\x15" + pad.to_bytes(2, "big") + b"\0" * pad if pad >= 0 else b"")
        body = (b"\x03\x03" + os.urandom(32) + bytes([len(session)]) + session
                + bytes.fromhex("000413011302") + b"\x01\x00" + len(exts).to_bytes(2, "big") + exts)
        hello = b"\x01" + len(body).to_bytes(3, "big") + body
        return b"\x16\x03\x01" + len(hello).to_bytes(2, "big") + hello

    for session in (os.urandom(32), b""):   # не влезает — без session id (на 32 байта короче)
        base = len(make(-1, session))
        if size == base:
            return make(-1, session)
        if size >= base + 4:
            return make(size - base - 4, session)
    return None


# ---------- Подмена отправленного пакета (для fake) ----------
# Хитрость ByeDPI: данные отдаются системе «по ссылке» (Windows — TransmitFile из файла,
# Linux/Android — vmsplice из памяти), с низким TTL. Пакет уходит и теряется по дороге,
# а мы тут же подменяем байты в файле/памяти на настоящие. Сервер не подтвердил приём —
# система пересылает пакет сама, уже с настоящими байтами и обычным TTL.

_keep: list = []   # то, что система ещё может читать или куда писать (держим, пока не закончит)
_keep_lock = threading.Lock()


def _remember(item, cleanup):
    with _keep_lock:
        now = time.time()
        for old in [k for k in _keep if now - k[0] > 120]:   # через 2 минуты пакет давно доставлен
            old[2]()
            _keep.remove(old)
        _keep.append((now, item, cleanup))


if sys.platform == "win32":
    import ctypes
    import ctypes.wintypes as W

    class _OVERLAPPED(ctypes.Structure):
        _fields_ = [("Internal", ctypes.c_void_p), ("InternalHigh", ctypes.c_void_p),
                    ("Offset", W.DWORD), ("OffsetHigh", W.DWORD), ("hEvent", W.HANDLE)]

    try:
        _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _mswsock = ctypes.WinDLL("mswsock", use_last_error=True)
        _k32.CreateFileW.restype = W.HANDLE
        _k32.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
        _k32.WriteFile.argtypes = [W.HANDLE, ctypes.c_char_p, W.DWORD, ctypes.POINTER(W.DWORD), ctypes.c_void_p]
        _k32.SetFilePointer.argtypes = [W.HANDLE, ctypes.c_long, ctypes.c_void_p, W.DWORD]
        _k32.CreateEventW.restype = W.HANDLE
        _k32.CreateEventW.argtypes = [ctypes.c_void_p, W.BOOL, W.BOOL, ctypes.c_void_p]
        _k32.CloseHandle.argtypes = [W.HANDLE]
        _mswsock.TransmitFile.argtypes = [ctypes.c_size_t, W.HANDLE, W.DWORD, W.DWORD,
                                          ctypes.POINTER(_OVERLAPPED), ctypes.c_void_p, W.DWORD]
        _mswsock.TransmitFile.restype = W.BOOL
        FAKE_OK = True
    except (OSError, AttributeError):
        FAKE_OK = False

    def _write_at_start(handle, data: bytes):
        _k32.SetFilePointer(handle, 0, None, 0)
        done = W.DWORD()
        if not _k32.WriteFile(handle, data, len(data), ctypes.byref(done), None):
            raise OSError(ctypes.get_last_error(), "WriteFile")
        _k32.SetFilePointer(handle, 0, None, 0)

    def _send_swapped(sock: socket.socket, fake: bytes, real: bytes, ttl: int):
        path = os.path.join(tempfile.gettempdir(), f"sono-fake-{os.getpid()}-{threading.get_ident()}-{id(sock)}.bin")
        # FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE — файл сам исчезнет
        handle = _k32.CreateFileW(path, 0xC0000000, 7, None, 2, 0x100 | 0x04000000, None)
        if not handle or handle == W.HANDLE(-1).value:
            raise OSError(ctypes.get_last_error(), "CreateFile")
        event = _k32.CreateEventW(None, True, False, None)
        overlapped = _OVERLAPPED(hEvent=event)
        # Windows допишет итог в overlapped, когда сервер подтвердит приём, — держим до тех пор
        _remember(overlapped, lambda: (_k32.CloseHandle(event), _k32.CloseHandle(handle)))
        _write_at_start(handle, fake)
        old = sock.getsockopt(socket.IPPROTO_IP, socket.IP_TTL) or 128
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl)
        try:
            if not _mswsock.TransmitFile(sock.fileno(), handle, len(fake), len(fake),
                                         ctypes.byref(overlapped), None, 0):
                error = ctypes.get_last_error()
                if error != 997:   # ERROR_IO_PENDING — отправка идёт, так и надо
                    raise OSError(error, "TransmitFile")
            time.sleep(0.005)   # пакет ушёл — подменяем байты на настоящие
            _write_at_start(handle, real)
        finally:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, old)

else:
    import ctypes

    class _iovec(ctypes.Structure):
        _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]

    try:
        _libc = ctypes.CDLL(None, use_errno=True)
        _vmsplice = _libc.vmsplice
        _vmsplice.argtypes = [ctypes.c_int, ctypes.POINTER(_iovec), ctypes.c_size_t, ctypes.c_uint]
        _vmsplice.restype = ctypes.c_ssize_t
        _splice = _libc.splice
        _splice.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint]
        _splice.restype = ctypes.c_ssize_t
        FAKE_OK = sys.platform.startswith("linux") or hasattr(sys, "getandroidapilevel")
    except (OSError, AttributeError):
        FAKE_OK = False

    def _send_swapped(sock: socket.socket, fake: bytes, real: bytes, ttl: int):
        memory = mmap.mmap(-1, len(fake))   # общая анонимная память: страницы уходят в сокет без копии
        memory[:] = fake
        view = (ctypes.c_char * len(fake)).from_buffer(memory)
        _remember((memory, view), lambda: None)   # система ещё может переслать из этих страниц
        read_end, write_end = os.pipe()
        old = sock.getsockopt(socket.IPPROTO_IP, socket.IP_TTL) or 64
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl)
        try:
            vec = _iovec(ctypes.addressof(view), len(fake))
            if _vmsplice(write_end, ctypes.byref(vec), 1, 8) != len(fake):   # 8 — SPLICE_F_GIFT
                raise OSError(ctypes.get_errno(), "vmsplice")
            if _splice(read_end, None, sock.fileno(), None, len(fake), 0) != len(fake):
                raise OSError(ctypes.get_errno(), "splice")
            time.sleep(0.005)   # пакет ушёл — подменяем байты на настоящие
            memory[:] = real
        finally:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, old)
            os.close(read_end)
            os.close(write_end)

if not FAKE_OK:
    del STRATEGIES["fake"]


def _send_oob(sock: socket.socket, data: bytes, cut: int):
    """Две части, а между ними — один «срочный» байт (TCP urgent). Фильтр видит его внутри имени
    сайта, а сервер (как велит TCP) убирает его из потока: «you?tube» → «youtube»."""
    sock.sendall(data[:cut])
    sock.send(b"a", socket.MSG_OOB)
    sock.sendall(data[cut:])


def send_first_packet(sock: socket.socket, data: bytes, strategy: str, fake_ttl: int = 4) -> bytes | None:
    """Отправляет первый пакет соединения, разрезая его так, чтобы фильтр не увидел имя сайта.
    Для fake возвращает отправленную подделку (по ней видно, не дошла ли она до сервера)."""
    sni = _sni_offset(data)
    if sni is None:   # это не HTTPS — отправляем как есть
        sock.sendall(data)
        return
    name_len = int.from_bytes(data[sni - 2:sni], "big")
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
    elif strategy == "oob":
        _send_oob(sock, data, sni + name_len // 2)
    elif strategy == "fake" and FAKE_OK and (fake := build_fake(sni)):
        # Всё до имени сайта — подделкой (сервер получит настоящее при пересылке),
        # дальше — настоящее, с «срочным» байтом посреди имени
        _send_swapped(sock, fake, data[:sni], fake_ttl)
        _send_oob(sock, data[sni:], name_len // 2)
        return fake
    elif strategy == "fake":   # подделка не поместилась или не работает в этой системе
        _send_oob(sock, data, sni + name_len // 2)
    else:
        sock.sendall(data)
    return None


def fake_reached_server(reply: bytes, fake: bytes) -> bool:
    """Ответ сервера — на подделку, а не на настоящее приветствие? Сервер повторяет в ответе
    номер сессии (session id) из приветствия, которое получил, — у подделки он свой, случайный."""
    if reply[:1] == b"\x15":   # ошибка TLS сразу в ответ
        return True
    if len(reply) < 76 or reply[0] != 0x16 or reply[5] != 0x02 or fake[43] != 32:
        return False
    return reply[43] == 32 and reply[44:76] == fake[44:76]


# ---------- Адрес сайта: DNS провайдера, а если он молчит — DNS через HTTPS ----------
# Бывает, что провайдер не отвечает на вопрос «какой адрес у youtube.com» (getaddrinfo failed).
# Тогда спрашиваем Cloudflare или Google напрямую по их адресу — провайдер этого не подменит.

DOH = ("https://1.1.1.1/dns-query?type=A&name=", "https://8.8.8.8/resolve?type=A&name=")
_doh_cache: dict[str, tuple[float, str]] = {}
_no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def resolve(host: str) -> str:
    """Адрес сайта: как обычно, а не вышло — через DNS-over-HTTPS (с кэшем на время жизни записи)."""
    try:
        return socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    except OSError:
        pass
    cached = _doh_cache.get(host)
    if cached and cached[0] > time.time():
        return cached[1]
    for base in DOH:
        try:
            req = urllib.request.Request(base + urllib.parse.quote(host), headers={"Accept": "application/dns-json"})
            answers = json.loads(_no_proxy.open(req, timeout=5).read()).get("Answer") or []
            records = [a for a in answers if a.get("type") == 1]
            if records:
                _doh_cache[host] = (time.time() + max(60, records[0].get("TTL", 300)), records[0]["data"])
                print(f"[network] {host}: DNS провайдера не ответил, адрес взят через {base.split('/')[2]}")
                return records[0]["data"]
        except (OSError, ValueError):
            continue
    raise OSError(f"не удаётся узнать адрес {host}")


def _connect(host: str, port: int) -> socket.socket:
    host = host.strip("[]")
    try:
        return socket.create_connection((host, port), timeout=10)
    except socket.gaierror:
        return socket.create_connection((resolve(host), port), timeout=10)


class DesyncProxy:
    """Локальный HTTP-прокси (метод CONNECT): плеер просит соединиться с сайтом,
    прокси соединяется, первый пакет режет выбранным способом, остальное пересылает как есть.
    У SoundCloud — свой способ (sc_strategy)."""

    def __init__(self, strategy: str, sc_strategy: str | None = None, fake_ttl: int = 4):
        self.strategy = strategy
        self.sc_strategy = sc_strategy or strategy
        self.fake_ttl = fake_ttl
        # Подделок одновременно — не больше двух, пока сервер не ответил: когда новых соединений
        # с подделкой сразу шесть (кусочки трека), фильтр часть из них не узнаёт и замораживает
        self.fake_gate = threading.Semaphore(2)
        self.fake_failures = 0
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(128)
        self.port = self.server.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.running = True
        threading.Thread(target=self._accept, daemon=True).start()

    def _fake_failed(self):
        """Сервер ответил на подделку — значит, она до него дошла: TTL великоват
        или весь трафик идёт через VPN (он принимает пакеты раньше, чем те «потеряются»).
        Два раза подряд — дальше без подделки, только «лишний байт»."""
        self.fake_failures += 1
        if self.fake_failures >= 2:
            print("[network] подделка доходит до сервера — дальше «лишний байт» (поможет «Подобрать лучший способ»)")
            self.strategy = "oob" if self.strategy == "fake" else self.strategy
            self.sc_strategy = "oob" if self.sc_strategy == "fake" else self.sc_strategy

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
            try:
                upstream = _connect(host, int(port or 443))
            except OSError as e:   # сайт не найден или не отвечает — так и говорим, а не молча закрываем
                print(f"[network] {host}: {e}")
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                return
            upstream.settimeout(None)
            client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            first = client.recv(65536)
            if not first:
                return
            strategy = (self.sc_strategy if is_soundcloud(host) else self.strategy) if needs_bypass(host) else None
            if strategy is None:
                upstream.sendall(first)
            elif strategy == "fake":
                with self.fake_gate:
                    fake = send_first_packet(upstream, first, strategy, self.fake_ttl)
                    ready, _, _ = select.select([upstream], [], [], 1.5)   # ждём ответ сервера (данные не забираем)
                if fake and ready and fake_reached_server(upstream.recv(76, socket.MSG_PEEK), fake):
                    self._fake_failed()
            else:
                send_first_packet(upstream, first, strategy, self.fake_ttl)
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
