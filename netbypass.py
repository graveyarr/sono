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
        # На Android (проверено 10 ноября, Xiaomi, Android 13) подмена не срабатывает: до сервера доходит
        # подделка вместо настоящих байтов → «SSL: INVALID_SESSION_ID». Пока не починим — там выключена
        FAKE_OK = sys.platform.startswith("linux") and not hasattr(sys, "getandroidapilevel")
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


# ---------- «Мимо VPN»: соединения прямо через сетевую карту ----------
# VPN с режимом TUN (MantaRay, sing-box, clash…) забирает весь трафик компьютера в свой адаптер и сам
# заново отправляет соединения — наши уловки с первым пакетом до провайдера тогда не доходят, а заодно
# не проверить, как Sono работает без VPN. Если соединение привязать к адресу настоящей сетевой карты,
# Windows отправит его прямо через неё, мимо адаптера VPN (проверено 3 ноября 2026).
# Адреса сайтов тогда тоже спрашиваем сами, через ту же карту: DNS у таких VPN выдаёт «ненастоящие»
# адреса 198.18.x.x, которые работают только внутри VPN.

BIND: str | None = None   # адрес сетевой карты, к которому привязываем соединения (None — как обычно)
DNS_SERVERS = ("77.88.8.8", "8.8.8.8", "1.1.1.1")   # Яндекс, Google, Cloudflare — кто ответит первым
_udp_cache: dict[str, tuple[float, str]] = {}


def _virtual(ip: str) -> bool:
    """Адрес VPN/виртуальной сети, а не настоящей карты"""
    try:
        a, b = (int(x) for x in ip.split(".")[:2])
    except ValueError:
        return True
    return (a in (0, 127) or (a, b) == (169, 254) or (a == 198 and b in (18, 19))   # 198.18/15 — «ненастоящие» адреса VPN
            or a == 26                                                             # Radmin VPN
            or (a == 100 and 64 <= b <= 127))                                      # CGNAT/Tailscale


def physical_address() -> str | None:
    """Адрес настоящей сетевой карты: та, у которой маршрут «весь интернет» (0.0.0.0/0) ведёт на роутер.
    VPN обычно ставит свои маршруты половинками (0.0.0.0/1 + 128.0.0.0/1) или с большой метрикой."""
    if sys.platform != "win32":
        return None
    import subprocess
    try:
        out = subprocess.run(["route", "print", "-4", "0.0.0.0"], capture_output=True, timeout=5,
                             creationflags=0x08000000).stdout.decode("ascii", "ignore")   # без окна консоли
    except (OSError, subprocess.SubprocessError):
        return None
    best = None
    for line in out.splitlines():
        parts = line.split()
        # «0.0.0.0  0.0.0.0  шлюз  адрес_карты  метрика»; у постоянных маршрутов — 4 колонки, их пропускаем
        if len(parts) != 5 or parts[:2] != ["0.0.0.0", "0.0.0.0"] or not parts[4].isdigit():
            continue
        gateway, ip, metric = parts[2], parts[3], int(parts[4])
        if gateway.count(".") != 3 or _virtual(ip) or _virtual(gateway):
            continue
        if best is None or metric < best[1]:
            best = (ip, metric)
    return best[0] if best else None


def set_direct(on: bool) -> str | None:
    """Включить/выключить «Мимо VPN». Возвращает адрес карты (None — не нашли или выключено)."""
    global BIND
    BIND = physical_address() if on else None
    _udp_cache.clear()
    _sc_good.clear()   # другой путь в интернет — проверенные адреса SoundCloud могли стать другими
    _sc_bad.clear()
    _sc_none.clear()
    if on:
        print(f"[network] мимо VPN: через сетевую карту {BIND}" if BIND else "[network] мимо VPN: сетевая карта не найдена")
    return BIND


def _dns_query(host: str) -> bytes:
    qid = os.urandom(2)
    labels = b"".join(bytes([len(p)]) + p for p in host.encode("idna").split(b".") if p)
    return qid + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + labels + b"\x00\x00\x01\x00\x01"


def _dns_answer(reply: bytes, query: bytes) -> tuple[str, int] | None:
    """Первый адрес (A-запись) из ответа DNS и его время жизни"""
    if len(reply) < 12 or reply[:2] != query[:2] or reply[3] & 0x0F:   # чужой ответ или ошибка
        return None
    count = int.from_bytes(reply[6:8], "big")
    pos = len(query)   # вопрос повторяется в ответе как есть
    for _ in range(count):
        if pos >= len(reply):
            return None
        if reply[pos] & 0xC0 == 0xC0:   # имя — ссылкой
            pos += 2
        else:
            while pos < len(reply) and reply[pos]:
                pos += reply[pos] + 1
            pos += 1
        rtype, ttl, size = (int.from_bytes(reply[pos:pos + 2], "big"), int.from_bytes(reply[pos + 4:pos + 8], "big"),
                            int.from_bytes(reply[pos + 8:pos + 10], "big"))
        data = reply[pos + 10:pos + 10 + size]
        pos += 10 + size
        if rtype == 1 and size == 4:
            return ".".join(str(b) for b in data), ttl
    return None


def _doh_direct(host: str, bind: str) -> tuple[str, int] | None:
    """DNS-over-HTTPS (Cloudflare, Google) с сетевой карты. Обычный DNS (порт 53) мимо VPN часто закрыт:
    такие VPN ставят правило брандмауэра «DNS — только через нас» (у MantaRay так, замер 6 ноября 2026)"""
    import http.client
    for server, path in (("1.1.1.1", "/dns-query"), ("8.8.8.8", "/resolve")):
        conn = http.client.HTTPSConnection(server, 443, timeout=3, source_address=(bind, 0),
                                           context=ssl.create_default_context())
        try:
            conn.request("GET", f"{path}?type=A&name={urllib.parse.quote(host)}", headers={"Accept": "application/dns-json"})
            answers = json.loads(conn.getresponse().read()).get("Answer") or []
            for a in answers:
                if a.get("type") == 1 and not _virtual(a.get("data", "")):
                    return a["data"], int(a.get("TTL", 300))
        except (OSError, ValueError, http.client.HTTPException):
            continue
        finally:
            conn.close()
    return None


def resolve_direct(host: str, bind: str) -> str:
    """Адрес сайта мимо DNS VPN, с той же сетевой карты: DNS-over-HTTPS, а не вышло — обычный DNS (UDP)"""
    cached = _udp_cache.get(host)
    if cached and cached[0] > time.time():
        return cached[1]
    found = _doh_direct(host, bind)
    if found:
        _udp_cache[host] = (time.time() + min(max(60, found[1]), 3600), found[0])
        return found[0]
    query = _dns_query(host)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind((bind, 0))
        deadline = time.time() + 4
        for attempt in range(2):   # UDP может потеряться — второй раз спрашиваем ещё раз всех
            for server in DNS_SERVERS:
                try:
                    s.sendto(query, (server, 53))
                except OSError:
                    pass
            while (left := min(deadline, time.time() + 1.5 * (attempt + 1)) - time.time()) > 0:
                s.settimeout(left)
                try:
                    reply, _ = s.recvfrom(2048)
                except OSError:
                    break
                found = _dns_answer(reply, query)
                if found and not _virtual(found[0]):
                    _udp_cache[host] = (time.time() + min(max(60, found[1]), 3600), found[0])
                    return found[0]
    raise OSError(f"не удаётся узнать адрес {host} мимо VPN")


def _all_addresses(host: str) -> list[str]:
    """Все адреса сайта (у SoundCloud их по 4–12, у разных DNS — разные): системный DNS и DNS-over-HTTPS
    (с сетевой карты, если «Мимо VPN»). Адреса VPN (198.18.x.x) отбрасываются."""
    import http.client
    found: list[str] = []
    if not BIND:
        try:
            found += [a[4][0] for a in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)]
        except OSError:
            pass
    for server, path in (("1.1.1.1", "/dns-query"), ("8.8.8.8", "/resolve")):
        conn = http.client.HTTPSConnection(server, 443, timeout=3, context=ssl.create_default_context(),
                                           **({"source_address": (BIND, 0)} if BIND else {}))
        try:
            conn.request("GET", f"{path}?type=A&name={urllib.parse.quote(host)}", headers={"Accept": "application/dns-json"})
            found += [a["data"] for a in json.loads(conn.getresponse().read()).get("Answer") or [] if a.get("type") == 1]
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            conn.close()
    return list(dict.fromkeys(ip for ip in found if not _virtual(ip)))


# ---------- SoundCloud: «замороженные» адреса ----------
# SoundCloud живёт в сети Amazon CloudFront, у каждого его сайта много адресов, и DNS выдаёт разные
# (Google DNS — «поближе к России»). Часть адресов фильтр провайдера замораживает после ~16 КБ при
# любом способе обхода, другие с «подделкой» работают (замер 6 ноября 2026: 108.157.214.x — всегда
# заморозка; 13.33.235.x, 143.204.238.x, 52.84.150.x — работают). Поиск тогда то работал, то висел.
# Любой адрес CloudFront отдаёт любой сайт SoundCloud (сайт выбирается по имени в приветствии TLS),
# поэтому проверяем адреса — скачиваем главную soundcloud.com (~77 КБ, ~0,6 с) — и ходим через рабочие.

SC_GOOD_FOR = 20 * 60   # сколько верим проверке адреса (с)
# (адрес, способ, TTL) → до какого времени верим проверке: с другим способом или TTL адрес ведёт себя иначе
_sc_good: dict[tuple, float] = {}
_sc_bad: dict[tuple, float] = {}
_sc_none: dict[tuple, float] = {}   # (способ, TTL) → до какого времени не проверяем (рабочих не нашлось)
_sc_lock = threading.Lock()
SC_PROBE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def _sc_probe(ip: str, strategy: str, fake_ttl: int) -> bool:
    """Открывается ли SoundCloud целиком (≥ 40 КБ) через этот адрес выбранным способом"""
    import http.client
    tmp = DesyncProxy(strategy, strategy, fake_ttl, force_ip=ip)
    conn = http.client.HTTPSConnection("127.0.0.1", tmp.port, timeout=4, context=ssl.create_default_context())
    try:
        conn.set_tunnel("soundcloud.com", 443)
        conn.request("GET", "/", headers={"User-Agent": SC_PROBE_UA, "Accept-Encoding": "identity"})
        resp = conn.getresponse()
        got, deadline = 0, time.time() + 4
        while got < 40000 and time.time() < deadline:
            chunk = resp.read(16384)
            if not chunk:
                break
            got += len(chunk)
        return got >= 40000
    except (OSError, http.client.HTTPException, ValueError):
        return False
    finally:
        conn.close()
        tmp.stop()


def _sc_pick(host: str, strategy: str, fake_ttl: int) -> str | None:
    """Рабочий адрес CloudFront для сайта SoundCloud (None — не нашли, тогда как обычно)"""
    now = time.time()
    way = (strategy, fake_ttl)
    good = [k[0] for k, until in _sc_good.items() if until > now and k[1:] == way]
    if good:
        return good[int(now * 1000) % len(good)]   # по очереди — не нагружать один адрес
    if _sc_none.get(way, 0) > now:   # недавно не нашли ни одного — не проверяем на каждом соединении
        return None
    with _sc_lock:   # проверяет один поток, остальные соединения ждут его результат (один раз, ≤ ~5 с)
        good = [k[0] for k, until in _sc_good.items() if until > time.time() and k[1:] == way]
        if good:
            return good[0]
        if _sc_none.get(way, 0) > time.time():
            return None
        candidates = [ip for ip in dict.fromkeys(_all_addresses(host) + _all_addresses("soundcloud.com"))
                      if _sc_bad.get((ip, *way), 0) < time.time()]
        groups = list({ip.rsplit(".", 1)[0]: ip for ip in candidates}.values())[:6]   # по адресу из каждой подсети
        if not groups:
            return None
        from concurrent.futures import ThreadPoolExecutor, as_completed
        found = None
        pool = ThreadPoolExecutor(len(groups))
        jobs = {pool.submit(_sc_probe, ip, strategy, fake_ttl): ip for ip in groups}

        def remember(job):   # подсеть ведёт себя одинаково — запоминаем все её адреса
            ip = jobs[job]
            try:
                ok = job.result()
            except Exception:
                return
            subnet = ip.rsplit(".", 1)[0]
            for c in candidates:
                if c.rsplit(".", 1)[0] == subnet:
                    # плохой — ненадолго: заморозка бывает и случайной (один и тот же адрес то работает, то нет)
                    (_sc_good if ok else _sc_bad)[(c, *way)] = time.time() + (SC_GOOD_FOR if ok else 5 * 60)

        for job in jobs:   # и те проверки, что закончатся после ответа, пополнят списки
            job.add_done_callback(remember)
        try:
            for job in as_completed(jobs, timeout=9):
                if job.result():
                    found = jobs[job]
                    break
        except Exception:
            pass
        pool.shutdown(wait=False)
        if not found:
            _sc_none[way] = time.time() + 60
        print(f"[network] SoundCloud: рабочий адрес {found}" if found else
              "[network] SoundCloud: рабочий адрес не нашёлся — минуту идём как обычно")
        return found


def _sc_frozen(ip: str, strategy: str, fake_ttl: int):
    """Соединение через этот адрес замёрзло посреди работы — его подсеть больше не берём (на 5 мин).
    Адреса одной группы то работают, то замерзают (13.33.235.x — замер 6 ноября 2026): трек обрывался"""
    subnet = ip.rsplit(".", 1)[0]
    way = (strategy, fake_ttl)
    dropped = [k for k in list(_sc_good) if k[1:] == way and k[0].rsplit(".", 1)[0] == subnet]
    for k in dropped:
        _sc_good.pop(k, None)
        _sc_bad[k] = time.time() + 5 * 60
    if dropped:
        print(f"[network] SoundCloud: соединение через {subnet}.x замёрзло — дальше через другие адреса")


def _connect(host: str, port: int, ip: str | None = None) -> socket.socket:
    host = host.strip("[]")
    bind = BIND
    if ip:   # адрес уже выбран (SoundCloud)
        return socket.create_connection((ip, port), timeout=10, **({"source_address": (bind, 0)} if bind else {}))
    if bind:
        ip = host if host.replace(".", "").isdigit() else resolve_direct(host, bind)
        try:
            return socket.create_connection((ip, port), timeout=10, source_address=(bind, 0))
        except OSError as e:
            if getattr(e, "winerror", None) != 10049 and e.errno not in (99, 10049):   # адрес карты сменился
                raise
            if set_direct(True) in (None, bind):
                raise
            return _connect(host, port)
    try:
        return socket.create_connection((host, port), timeout=10)
    except socket.gaierror:
        return socket.create_connection((resolve(host), port), timeout=10)


# Подделок одновременно — не больше двух на всю программу, пока сервер не ответил: когда новых соединений
# с подделкой сразу шесть (кусочки трека, проверка адресов), фильтр часть из них не узнаёт и замораживает
_FAKE_GATE = threading.Semaphore(2)


class DesyncProxy:
    """Локальный HTTP-прокси (метод CONNECT): плеер просит соединиться с сайтом,
    прокси соединяется, первый пакет режет выбранным способом, остальное пересылает как есть.
    У SoundCloud — свой способ (sc_strategy)."""

    def __init__(self, strategy: str, sc_strategy: str | None = None, fake_ttl: int = 4, force_ip: str | None = None):
        self.strategy = strategy
        self.sc_strategy = sc_strategy or strategy
        self.fake_ttl = fake_ttl
        self.fake_gate = _FAKE_GATE   # общий на все прокси (см. выше)
        self.force_ip = force_ip   # для проверки адреса SoundCloud: все соединения — на этот адрес
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
            ip = self.force_ip
            if not ip and is_soundcloud(host) and self.sc_strategy in ("fake", "oob"):
                try:
                    ip = _sc_pick(host, self.sc_strategy, self.fake_ttl)
                except Exception as e:   # проверка не удалась — идём как обычно
                    print(f"[network] SoundCloud: проверка адресов не удалась ({e})")
            try:
                upstream = _connect(host, int(port or 443), ip)
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
            if strategy in (None, "none"):   # none — без уловок (режим «напрямую» с «Мимо VPN»)
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
            picked = ip if ip and not self.force_ip else None
            seen = {"bytes": 0, "last": time.time()} if picked else None
            other = threading.Thread(target=self._pipe, args=(upstream, client, seen), daemon=True)
            other.start()
            self._pipe(client, upstream)
            # Плеер бросил соединение, не дождавшись ответа: сервер не закрыл его, но давно молчит,
            # а пришло совсем немного — это заморозка. Адрес (и его подсеть) — в плохие, дальше через другие
            if seen and other.is_alive() and seen["bytes"] < 64 * 1024 and time.time() - seen["last"] > 3:
                _sc_frozen(picked, self.sc_strategy, self.fake_ttl)
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
    def _pipe(src: socket.socket, dst: socket.socket, seen: dict | None = None):
        try:
            while data := src.recv(65536):
                if seen is not None:   # для SoundCloud: сколько пришло и когда в последний раз (заморозка)
                    seen["bytes"] += len(data)
                    seen["last"] = time.time()
                dst.sendall(data)
        except OSError:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)   # сообщаем другой стороне, что данных больше не будет
            except OSError:
                pass
