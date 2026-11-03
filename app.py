"""Минимальный плеер: поиск на YouTube или SoundCloud + воспроизведение.

Запуск:  python app.py   → открыть http://127.0.0.1:5000
"""
import hashlib
import json
import mimetypes
import os
import queue
import re
import subprocess
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

import requests

import updater
updater.activate()   # до import yt_dlp: если скачана свежая версия yt-dlp — берём её (updater.py)
import yt_dlp  # noqa: E402
from flask import Flask, Response, abort, jsonify, request, send_file

import appupdate
import artists
import discord_rpc
import flow
import importer
import localfiles
import netbypass
import zapret

BASE_DIR = Path(__file__).parent
# В собранном .exe код распаковывается во временную папку, которая удаляется при выходе.
# Поэтому кэш тогда храним в %LOCALAPPDATA%\Sono, а при обычном запуске — рядом с кодом.
if getattr(sys, "frozen", False):
    _appdata = Path(os.environ.get("LOCALAPPDATA", Path.home()))
    DATA_DIR = _appdata / "Sono"
    # Раньше программа называлась Player — переносим медиатеку и кэш из старой папки (один раз).
    # Не вышло (файлы чем-то заняты) — продолжаем работать со старой папкой, ничего не теряя.
    if not DATA_DIR.exists() and (_appdata / "Player" / "library.json").exists():
        try:
            os.rename(_appdata / "Player", DATA_DIR)
        except OSError:
            DATA_DIR = _appdata / "Player"
    # Установщик кладёт deno.exe рядом с Sono.exe — добавляем эту папку в PATH,
    # чтобы yt-dlp нашёл deno (без него YouTube не работает), даже если у человека его нет
    os.environ["PATH"] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")
else:
    DATA_DIR = BASE_DIR
CACHE_DIR = DATA_DIR / "cache"          # сюда сохраняется скачанное аудио
CACHE_DIR.mkdir(parents=True, exist_ok=True)
COVER_DIR = CACHE_DIR / "covers"        # сюда сохраняются обложки
COVER_DIR.mkdir(exist_ok=True)
artists.init(CACHE_DIR)                 # сведения об исполнителях и альбомах — в cache/meta/
zapret.init(DATA_DIR)                   # автонастройка zapret: скрипт и ход работы — в zapret/

# ---------- Сеть: обход блокировок ----------
# Режимы: off — напрямую (у человека свой zapret/VPN); bypass — встроенный обход (netbypass.py);
# proxy — свой прокси (адрес из VPN/прокси, http:// или socks5://).
# Весь интернет-трафик плеера (yt-dlp, requests) берёт прокси из переменных окружения
# HTTP(S)_PROXY — поэтому включить режим = поставить эти переменные. Браузерное окно не затрагивается.

NETWORK_FILE = DATA_DIR / "network.json"
NETWORK_DEFAULT = {"mode": "bypass", "strategy": "tlsrec", "proxy": ""}
_network = dict(NETWORK_DEFAULT)
_desync: netbypass.DesyncProxy | None = None


def apply_network(config: dict) -> None:
    global _desync
    if _desync:
        _desync.stop()
        _desync = None
    proxy = ""
    if config["mode"] == "bypass":
        _desync = netbypass.DesyncProxy(config["strategy"])
        proxy = _desync.url
    elif config["mode"] == "proxy":
        proxy = config["proxy"]
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        if proxy:
            os.environ[name] = proxy
        else:
            os.environ.pop(name, None)
    os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
    _network.clear()
    _network.update(config)
    print(f"[network] режим: {config['mode']}" + (f" ({config['strategy']})" if config["mode"] == "bypass" else ""))
    reset_ydl_pools()   # у готовых экземпляров yt-dlp прокси прежний — пусть создадутся заново


# ---------- Готовые экземпляры yt-dlp ----------
# Создать yt-dlp и сделать первый запрос — дорого: ~1,8 с против ~1,0 с у уже работавшего экземпляра
# (у него открыты соединения с YouTube и запомнены его служебные данные). Поэтому держим несколько готовых
# и раздаём по одному на запрос (один экземпляр нельзя использовать из двух потоков сразу).
# Замер (ноябрь 2026): ссылка на звук — было 3,3 с, стало ~1,0 с.
AUDIO_FORMAT = "bestaudio[acodec=opus][protocol=https]/bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]/bestaudio"
VIDEO_FORMAT = ("bestvideo[height<=480][vcodec^=avc1][protocol=https]/bestvideo[height<=480][vcodec^=vp][protocol=https]"
                "/bestvideo[height<=480][protocol=https]/bestvideo[height<=720][protocol=https]")
YDL_OPTIONS = {
    # Ссылка на звук, быстрый путь: «клиент» visionos не требует разгадывать скрипт YouTube (deno не нужен).
    # protocol=https — обычный файл по ссылке, а не нарезка на фрагменты; сначала Opus (~160 кбит/с), потом AAC
    "yt_fast": {"quiet": True, "no_warnings": True, "noplaylist": True, "format": AUDIO_FORMAT,
                "extractor_args": {"youtube": {"player_client": ["visionos"]}}},
    # Обычный путь — все «клиенты» по умолчанию (если быстрый не дал звука)
    "yt_full": {"quiet": True, "no_warnings": True, "noplaylist": True, "format": AUDIO_FORMAT},
    # Видео клипа без звука (звук идёт отдельно, как обычно): до 480p — клип занимает пол-экрана, больше не нужно.
    # Сначала H.264 или VP9 — их WebView2 показывает везде (AV1 — не на всех видеокартах)
    "clip_fast": {"quiet": True, "no_warnings": True, "noplaylist": True, "format": VIDEO_FORMAT,
                  "extractor_args": {"youtube": {"player_client": ["visionos"]}}},
    "clip_full": {"quiet": True, "no_warnings": True, "noplaylist": True, "format": VIDEO_FORMAT},
    # Поиск (список без подробностей)
    "search": {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True},
}
_pools: dict[str, queue.LifoQueue] = {}
_pools_lock = threading.Lock()


class ydl_pool:
    """with ydl_pool("yt_fast") as ydl: ... — готовый экземпляр yt-dlp на время запроса."""

    def __init__(self, kind: str):
        self.kind = kind

    def __enter__(self):
        with _pools_lock:
            self.pool = _pools.setdefault(self.kind, queue.LifoQueue())
        try:
            self.ydl = self.pool.get_nowait()
        except queue.Empty:
            self.ydl = yt_dlp.YoutubeDL(YDL_OPTIONS[self.kind])   # свободных нет — новый (потом тоже пригодится)
        return self.ydl

    def __exit__(self, *exc):
        if self.pool.qsize() < 4:   # больше четырёх в запасе не держим
            self.pool.put(self.ydl)


def reset_ydl_pools() -> None:
    with _pools_lock:
        _pools.clear()


def _warm_up() -> None:
    """Прогрев при запуске: первый трек за сессию тоже включится быстро, а не за ~2 с."""
    def one(kind, url):
        try:
            with ydl_pool(kind) as ydl:
                ydl.extract_info(url, download=False)
        except Exception as e:
            print(f"[warm-up] {kind}: {str(e)[:100]}")
    started = time.perf_counter()
    jobs = [threading.Thread(target=one, args=("yt_fast", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")),
            threading.Thread(target=one, args=("yt_fast", "https://www.youtube.com/watch?v=9bZkp7q19f0")),
            threading.Thread(target=one, args=("search", "ytsearch1:music"))]
    with ydl_pool("search") as ydl:
        if not ydl.cache.load("soundcloud", "client_id"):
            # Ключ SoundCloud ещё не известен (первый запуск) — пусть yt-dlp узнает его сейчас, а не при первом поиске
            jobs.append(threading.Thread(target=one, args=("search", "scsearch1:music")))
    for t in jobs:
        t.start()
    for t in jobs:
        t.join()
    print(f"[warm-up] yt-dlp готов за {time.perf_counter() - started:.1f} с")


def _load_network() -> dict:
    try:
        saved = json.loads(NETWORK_FILE.read_text(encoding="utf-8"))
        return {**NETWORK_DEFAULT, **{k: saved[k] for k in NETWORK_DEFAULT if k in saved}}
    except (OSError, ValueError):
        return dict(NETWORK_DEFAULT)


apply_network(_load_network())
threading.Thread(target=_warm_up, daemon=True, name="ydl-warm-up").start()
updater.check()   # в фоне: есть ли свежий yt-dlp (через тот же обход блокировок)
appupdate.start()   # в фоне: нет ли новой версии самой программы на GitHub (appupdate.py)

# Где можно искать. У каждого источника свой формат id, своя ссылка на трек
# и своя приставка к именам файлов в кэше (у YouTube пустая — так было и раньше;
# точки в id YouTube не бывает, поэтому «sc.» ни с чем не перепутается).
SOURCES = {
    "youtube": {
        "search": "ytsearch",
        "id_re": re.compile(r"^[A-Za-z0-9_-]{11}$"),
        "url": "https://www.youtube.com/watch?v={id}",
        "prefix": "",
    },
    "soundcloud": {
        "search": "scsearch",
        "id_re": re.compile(r"^\d{1,20}$"),
        "url": "https://api.soundcloud.com/tracks/{id}",
        "prefix": "sc.",
    },
}

# Обложки YouTube берём по стандартным адресам. Для каждого размера список
# вариантов по порядку: если первого нет (404), пробуем следующий.
COVER_VARIANTS = {
    "small": ["mqdefault"],                                  # 320x180, для списка
    "large": ["maxresdefault", "sddefault", "hqdefault"],    # до 1280x720, для плеера
}
# У SoundCloud размер обложки задаётся концом адреса: ...-t300x300.jpg
SC_COVER_SIZES = {"small": "t300x300", "large": "t500x500"}

CHUNK = 10 * 1024 * 1024   # YouTube отдаёт аудио кусками по ~10 МБ, как и сам yt-dlp
MAX_DURATION = 20 * 60   # длиннее 20 минут не берём: это миксы, а не треки

# Windows иногда берёт тип .js из реестра как «text/plain», и браузер отказывается запускать модули
mimetypes.add_type("text/javascript", ".js")

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="")

_locks: dict[str, threading.Lock] = {}   # чтобы одно и то же не делать дважды одновременно
_locks_guard = threading.Lock()


def lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def friendly_error(e: Exception) -> str:
    """Понятный текст ошибки для интерфейса вместо английского сообщения yt-dlp."""
    text = str(e)
    if "DRM" in text:
        return "Этот трек защищён от копирования (DRM), сыграть его нельзя"
    if "Sign in" in text or ("age" in text.lower() and "confirm" in text.lower()):
        return "Сайт требует войти в аккаунт, чтобы открыть этот трек"
    if "unavailable" in text.lower() or "not available" in text.lower():
        return "Трек недоступен (удалён или закрыт в вашей стране)"
    if isinstance(e, requests.RequestException) or re.search(r"timed out|HTTPSConnectionPool|Connection(Error| aborted| reset)", text):
        host = "YouTube" if "googlevideo" in text or "youtube" in text else "SoundCloud" if "soundcloud" in text or "sndcdn" in text else "Сайт"
        return (f"{host} не ответил вовремя. Попробуйте ещё раз; если повторяется — "
                "проверьте интернет или способ обхода блокировок (Настройки)")
    return re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", text)   # убираем техническую приставку yt-dlp


LOCAL_ID = re.compile(r"^[0-9a-f]{16}$")   # свои файлы с компьютера (localfiles.py): sha1 пути


def valid(source: str, track_id: str) -> bool:
    if source == "local":
        return bool(LOCAL_ID.match(track_id))
    return source in SOURCES and bool(SOURCES[source]["id_re"].match(track_id))


def track_url(source: str, track_id: str) -> str:
    return SOURCES[source]["url"].format(id=track_id)


def cache_key(source: str, track_id: str) -> str:
    # Свои файлы (local) — не из SOURCES: для кэша текстов и т.п. просто «local.<номер>»
    return (SOURCES[source]["prefix"] if source in SOURCES else f"{source}.") + track_id


_sc_artwork: dict[str, str] = {}   # id трека SoundCloud -> адрес обложки (запоминаем при поиске)
SC_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/147.0 Safari/537.36",
              "Origin": "https://soundcloud.com", "Referer": "https://soundcloud.com/", "Accept": "application/json"}


def _sc_search_api(query: str, limit: int) -> list[dict]:
    """Поиск на SoundCloud одним запросом к его API (~0,6 с). yt-dlp делает то же самое за 11 запросов (~2 с).
    Ключ (client_id) берём тот, что yt-dlp уже узнал и запомнил. Ответ — в том же виде, что у yt-dlp."""
    with ydl_pool("search") as ydl:
        client_id = ydl.cache.load("soundcloud", "client_id")
    if not client_id:
        raise LookupError("yt-dlp ещё не узнал ключ SoundCloud")
    # Заголовки как у браузера на soundcloud.com: без них SoundCloud через раз отвечает 403
    resp = _http.get("https://api-v2.soundcloud.com/search/tracks", timeout=10, headers=SC_HEADERS,
                     params={"q": query, "client_id": client_id, "limit": limit})
    resp.raise_for_status()
    entries = []
    for t in resp.json()["collection"]:
        if not t.get("streamable", True) or t.get("policy") == "BLOCK":
            continue
        protocols = {x.get("format", {}).get("protocol", "") for x in (t.get("media") or {}).get("transcodings") or []}
        artwork = t.get("artwork_url") or (t.get("user") or {}).get("avatar_url")   # нет обложки — фото автора, как у yt-dlp
        created = t.get("created_at") or ""
        entries.append({
            "id": str(t["id"]), "title": t.get("title"), "uploader": (t.get("user") or {}).get("username"),
            "duration": (t.get("duration") or 0) / 1000 or None,
            "thumbnails": [{"url": artwork}] if artwork else [],
            "view_count": t.get("playback_count"), "like_count": t.get("likes_count"),
            "timestamp": int(datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()) if created else None,
            # Только зашифрованные потоки — трек под DRM (у крупных лейблов), сыграть его нельзя
            "drm": bool(protocols) and all("encrypted" in p for p in protocols),
        })
    return entries


def search(source: str, query: str, limit: int = 10) -> list[dict]:
    """Ищет треки. Возвращает список словарей с id, названием и т.д."""
    entries = None
    if source == "soundcloud":
        try:
            entries = _sc_search_api(query, limit)
        except Exception as e:   # ключ устарел, SoundCloud ограничил частоту и т.п. — ищем через yt-dlp (он обновит ключ)
            print(f"[search] SoundCloud напрямую не вышло ({str(e)[:80]}), ищу через yt-dlp")
    if entries is None:
        with ydl_pool("search") as ydl:   # готовый экземпляр — без затрат на создание и первое соединение
            entries = ydl.extract_info(f"{SOURCES[source]['search']}{limit}:{query}", download=False).get("entries")

    results = []
    for entry in entries or []:
        if not entry or not entry.get("id"):
            continue
        duration = entry.get("duration")
        # Прямые эфиры не имеют длительности (None) и скачиваются бесконечно,
        # а многочасовые миксы весят сотни мегабайт. Пропускаем и то, и другое.
        if not duration or duration > MAX_DURATION:
            continue
        if source == "soundcloud" and entry.get("thumbnails"):
            _sc_artwork[entry["id"]] = entry["thumbnails"][-1]["url"]
        results.append({
            "source": source,
            "id": entry["id"],
            "title": entry.get("title"),
            "channel": entry.get("channel") or entry.get("uploader"),
            "duration": duration,   # в секундах
            # Сколько раз слушали (YouTube — просмотры, SoundCloud — прослушивания) и лайки, если есть
            "plays": entry.get("view_count"),
            "likes": entry.get("like_count"),
            "uploaded": entry.get("timestamp"),   # когда загружен (есть у SoundCloud) — для поиска версий без цензуры
            # Защищён ли (только SoundCloud через API): True — сыграть нельзя, False — точно можно, нет поля — неизвестно
            **({"drm": entry["drm"]} if "drm" in entry else {}),
        })
        _track_stats[f"{source}:{entry['id']}"] = {"plays": entry.get("view_count"), "likes": entry.get("like_count")}
    return results


_track_stats: dict[str, dict] = {}   # «источник:id» → {plays, likes}: запоминаем из поиска и из yt-dlp


def track_stats(source: str, track_id: str) -> dict:
    """Прослушивания и лайки трека. Если в поиске его не было — спрашиваем yt-dlp (1–3 с)."""
    key = f"{source}:{track_id}"
    have = _track_stats.get(key)
    if have and (have.get("full") or have.get("plays") is not None and have.get("likes") is not None):
        return have
    if source == "youtube":
        resolve_stream(track_id)   # ссылка на звук всё равно нужна — сведения запишутся по дороге
        if key in _track_stats:
            return _track_stats[key]
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(track_url(source, track_id), download=False, process=False)
    _track_stats[key] = {"plays": info.get("view_count"), "likes": info.get("like_count"), "full": True}
    return _track_stats[key]


def find_cached(key: str) -> Path | None:
    """Ищет уже скачанный файл (недокачанные .part пропускаем)."""
    for path in CACHE_DIR.glob(f"{key}.*"):
        if path.suffix not in (".part", ".ytdl") and ".part-Frag" not in path.name:
            return path
    return None


def get_audio_file(source: str, track_id: str) -> Path:
    """Скачивает аудиодорожку в cache/ (если её там ещё нет) и возвращает путь.

    Если трек уже качается по другому запросу, ждём его, а не качаем второй раз."""
    key = cache_key(source, track_id)
    with lock_for("file:" + key):
        cached = find_cached(key)
        if cached:
            print(f"[cache] {cached.name}")
            return cached

        opts = {
            "quiet": True,
            "noprogress": True,
            "noplaylist": True,
            "format": "bestaudio[ext=m4a]/bestaudio",   # без перекодирования, файл как есть
            "outtmpl": str(CACHE_DIR / f"{key}.%(ext)s"),
            "concurrent_fragment_downloads": 8,         # SoundCloud отдаёт трек кусочками, качаем по 8 сразу
        }
        print(f"[download] {source} {track_id} ...")
        with yt_dlp.YoutubeDL(opts) as ydl:
            # Сначала только читаем информацию о треке, без скачивания...
            info = ydl.extract_info(track_url(source, track_id), download=False, process=False)
            if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
                raise ValueError("Это прямой эфир, его нельзя скачать как трек")
            if not info.get("duration") or info["duration"] > MAX_DURATION:
                raise ValueError(f"Трек длиннее {MAX_DURATION // 60} минут")
            # ...и только если всё в порядке, скачиваем.
            info = ydl.process_ie_result(info, download=True)
            path = Path(ydl.prepare_filename(info))
        print(f"[download] готово: {path.name}")
        return path


# ---------- Потоковое воспроизведение (YouTube) ----------
# Вместо «скачать всё, потом играть» берём у YouTube прямую ссылку на аудио
# и пересылаем браузеру кусок за куском. Играть можно сразу, а перемотка
# работает через Range-запросы, как на самом YouTube.
#
# Самое долгое — получить ссылку (yt-dlp открывает страницу видео, 3–6 секунд).
# Поэтому ссылки запоминаем — в памяти и на диске (stream_links.json): YouTube выдаёт
# их на несколько часов, и повторное включение трека стартует сразу, даже после перезапуска.

# Одно общее соединение с серверами: не тратим время на «рукопожатие» при каждом запросе
_http = requests.Session()
_http.mount("https://", requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=32))

STREAM_LINKS_FILE = CACHE_DIR / "stream_links.json"
_stream_cache: dict[str, tuple[float, str, dict]] = {}   # id -> (до_какого_времени, url, заголовки)
_stream_file_lock = threading.Lock()


def _load_stream_links():
    try:
        saved = json.loads(STREAM_LINKS_FILE.read_text(encoding="utf-8"))
        now = time.time()
        _stream_cache.update({vid: tuple(v) for vid, v in saved.items() if v[0] > now})
    except (OSError, ValueError, TypeError, IndexError):
        pass   # файла нет или он испорчен — просто начнём с пустого


def _save_stream_links():
    with _stream_file_lock:
        now = time.time()
        alive = {vid: list(v) for vid, v in list(_stream_cache.items()) if v[0] > now}
        tmp = STREAM_LINKS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(alive), encoding="utf-8")
        os.replace(tmp, STREAM_LINKS_FILE)


_load_stream_links()
localfiles.init(DATA_DIR, CACHE_DIR)
localfiles.scan()   # при запуске — проверить, не появилось ли в папках нового (в фоне)


def _link_expiry(url: str) -> float:
    """До какого времени ссылка рабочая: YouTube пишет это в самой ссылке (expire=...). Берём с запасом."""
    m = re.search(r"[?&]expire=(\d+)", url)
    return int(m.group(1)) - 10 * 60 if m else time.time() + 30 * 60


def _cached_stream(video_id: str):
    cached = _stream_cache.get(video_id)
    if cached and cached[0] > time.time():
        return cached[1], cached[2]
    return None


def resolve_stream(video_id: str, refresh: bool = False, kind: str = "audio") -> tuple[str, dict]:
    """Возвращает прямую ссылку на аудио (kind="video" — на видео без звука, для клипа) и заголовки для неё
    (ссылки живут часы).

    Получение ссылки занимает несколько секунд, поэтому её можно запросить заранее (prefetch).
    Если один и тот же трек запрошен дважды одновременно, второй запрос дождётся первого."""
    key = video_id if kind == "audio" else f"video:{video_id}"   # у звука ключ прежний — старый кэш ссылок годится
    if not refresh and (hit := _cached_stream(key)):
        return hit
    with lock_for("stream:" + key):
        if not refresh and (hit := _cached_stream(key)):   # пока ждали, ссылку мог получить другой запрос
            return hit
        return _resolve_stream_uncached(video_id, kind)


def _resolve_stream_uncached(video_id: str, kind: str = "audio") -> tuple[str, dict]:
    print(f"[stream] ищу ссылку для {video_id}{' (видео)' if kind == 'video' else ''} ...")
    started = time.perf_counter()
    # Сначала быстрый путь (один «клиент» YouTube без разгадывания скрипта, ~1 с), не вышло — обычный (~2–3 с)
    for way in (("yt_fast", "yt_full") if kind == "audio" else ("clip_fast", "clip_full")):
        try:
            with ydl_pool(way) as ydl:
                info = ydl.extract_info(track_url("youtube", video_id), download=False)
            break
        except yt_dlp.utils.DownloadError as e:
            if way.endswith("_full") or re.search(r"unavailable|private|removed|blocked|copyright", str(e), re.I):
                raise   # видео недоступно — обычный путь тут не поможет, не тратим время
            print(f"[stream] {video_id}: быстрый путь не подошёл ({str(e)[:80]}), пробую обычный")
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise ValueError("Это прямой эфир, его нельзя играть как трек")
    url = info["url"]
    headers = info.get("http_headers") or {}
    # Заодно запоминаем просмотры и лайки — экрану «Сейчас играет» не придётся спрашивать yt-dlp ещё раз
    _track_stats[f"youtube:{video_id}"] = {"plays": info.get("view_count"), "likes": info.get("like_count"), "full": True}
    _stream_cache[video_id if kind == "audio" else f"video:{video_id}"] = (_link_expiry(url), url, headers)
    _save_stream_links()
    quality = f"{info.get('abr')} kbps" if kind == "audio" else f"{info.get('height')}p {info.get('vcodec')}"
    print(f"[stream] ссылка получена за {time.perf_counter() - started:.1f} с ({way}, {info.get('ext')}, {quality})")
    return url, headers


def open_upstream(video_id: str, start: int, end: int, kind: str = "audio"):
    """Запрашивает у YouTube байты [start, end]. Возвращает (ответ, всего_байт, тип_файла)."""
    for attempt in (1, 2):
        url, headers = resolve_stream(video_id, refresh=(attempt == 2), kind=kind)
        resp = _http.get(url, headers={**headers, "Range": f"bytes={start}-{end}"},
                         stream=True, timeout=15)
        if resp.status_code in (403, 404, 410) and attempt == 1:
            print(f"[stream] {video_id}: ссылка устарела ({resp.status_code}), обновляю")
            resp.close()
            continue
        break
    resp.raise_for_status()

    match = re.search(r"/(\d+)$", resp.headers.get("Content-Range", ""))
    if match:
        total = int(match.group(1))
    elif start == 0 and "Content-Length" in resp.headers:
        total = int(resp.headers["Content-Length"])     # сервер проигнорировал Range и отдал всё
    else:
        resp.close()
        raise RuntimeError("YouTube не поддерживает перемотку для этого потока")
    return resp, total, resp.headers.get("Content-Type", "audio/mp4")


# Начало трека, скачанное заранее. Даже с готовой ссылкой серверы YouTube отвечают
# 1–1,5 секунды (в России — заметнее), поэтому при подготовке трека (prefetch) сразу
# берём его первые ~30 секунд звука. При нажатии ▶ они отдаются мгновенно из памяти,
# а остальное подкачивается, пока они играют.
HEAD_BYTES = 512 * 1024
_heads: dict[str, tuple[int, str, bytes]] = {}   # id -> (всего байт, тип файла, начало файла)


def prefetch_head(video_id: str):
    if video_id in _heads:
        return
    resp, total, mimetype = open_upstream(video_id, 0, HEAD_BYTES - 1)
    data = resp.content
    resp.close()
    _heads[video_id] = (total, mimetype, data)
    while len(_heads) > 24:   # держим в памяти только последние ~24 трека (это ~12 МБ)
        try:
            _heads.pop(next(iter(_heads)))
        except (StopIteration, KeyError, RuntimeError):   # другой поток успел поменять словарь
            break


def stream_youtube(video_id: str, kind: str = "audio"):
    """Пересылает аудио (kind="video" — видео клипа без звука) с YouTube браузеру. Понимает Range-запросы (перемотка).
    Идёт через тот же обход блокировок, что и звук: браузер сам к YouTube не ходит."""
    if kind == "audio" and (path := find_cached(cache_key("youtube", video_id))):
        return send_file(path, conditional=True)   # трек скачан — отдаём с диска: мгновенно и без интернета
    range_header = request.headers.get("Range")
    match = re.match(r"bytes=(\d*)-(\d*)$", range_header or "")
    start = int(match.group(1)) if match and match.group(1) else 0
    wanted_end = int(match.group(2)) if match and match.group(2) else None

    head = _heads.get(video_id) if kind == "audio" else None
    if head and start < len(head[2]):   # начало уже в памяти — YouTube пока не спрашиваем
        total, mimetype, head_data = head
        first = None
    else:
        head_data = b""
        first_end = start + CHUNK - 1
        if wanted_end is not None:
            first_end = min(first_end, wanted_end)
        try:
            first, total, mimetype = open_upstream(video_id, start, first_end, kind)
        except Exception as e:
            print(f"[error] stream {video_id}: {e}")
            return jsonify(error=friendly_error(e)), 502

    if start >= total:
        if first:
            first.close()
        return Response(status=416, headers={"Content-Range": f"bytes */{total}"})
    end = total - 1 if wanted_end is None else min(wanted_end, total - 1)

    def generate():
        resp, pos = first, start
        retries = 0
        try:
            if pos < len(head_data):   # сначала — то, что уже скачано заранее
                piece = head_data[pos:end + 1]
                pos += len(piece)
                yield piece
            while pos <= end:
                try:
                    if resp is None:
                        resp, _, _ = open_upstream(video_id, pos, min(pos + CHUNK - 1, end), kind)
                    for block in resp.iter_content(64 * 1024):
                        pos += len(block)
                        retries = 0
                        yield block
                except (requests.RequestException, OSError) as e:
                    # YouTube «подвис» посреди трека (бывает при замедлении): переподключаемся с того же
                    # байта — браузер ничего не заметит. Раньше поток просто обрывался, и трек вставал с ошибкой
                    retries += 1
                    if retries > 3:
                        raise
                    print(f"[stream] {video_id}: обрыв на {pos} ({e.__class__.__name__}), переподключаюсь ({retries}/3)")
                    time.sleep(0.5 * retries)
                if resp:
                    resp.close()
                resp = None
        except Exception as e:      # не вышло и после повторов
            print(f"[stream] {video_id}: поток прерван на {pos}: {e}")
        finally:
            if resp:
                resp.close()

    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1)}
    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return Response(generate(), status=206 if range_header else 200,
                    mimetype=mimetype, headers=headers)


# ---------- SoundCloud: играть во время скачивания ----------
# SoundCloud отдаёт трек кусочками по несколько секунд (HLS). Качаем их по 6 сразу,
# а браузеру отдаём строго по порядку, как только очередной готов, — играть можно
# уже после первого кусочка, а не ждать весь трек. Когда скачан весь трек, он
# сохраняется в кэш: следующие разы отдаётся мгновенно и с перемоткой.

class ScDownload:
    """Скачивание одного трека SoundCloud. Готовые кусочки копятся в chunks;
    любой желающий может читать их по мере появления (iter_chunks)."""

    def __init__(self, track_id: str):
        self.track_id = track_id
        self.chunks: list[bytes] = []
        self.done = False
        self.error = ""
        self.cond = threading.Condition()

    def add(self, data: bytes):
        with self.cond:
            self.chunks.append(data)
            self.cond.notify_all()

    def finish(self, error: str = ""):
        with self.cond:
            self.done, self.error = True, error
            self.cond.notify_all()

    def wait_first(self, timeout: float = 60) -> bool:
        """Ждёт первый кусочек. False — если скачать не получилось."""
        with self.cond:
            self.cond.wait_for(lambda: self.chunks or self.done, timeout)
            return bool(self.chunks)

    def wait_done(self, timeout: float = 120):
        with self.cond:
            self.cond.wait_for(lambda: self.done, timeout)

    def iter_chunks(self):
        i = 0
        while True:
            with self.cond:
                self.cond.wait_for(lambda: i < len(self.chunks) or self.done, 60)
                if i >= len(self.chunks):
                    return   # всё отдали (или скачивание оборвалось)
                chunk = self.chunks[i]
            i += 1
            yield chunk


_sc_downloads: dict[str, ScDownload] = {}


def sc_download(track_id: str) -> ScDownload | None:
    """Запускает скачивание трека SoundCloud (или возвращает уже идущее). None — трек уже в кэше."""
    with lock_for("sc:" + track_id):
        if find_cached(cache_key("soundcloud", track_id)):
            return None
        job = _sc_downloads.get(track_id)
        if job and not job.error:
            return job
        job = _sc_downloads[track_id] = ScDownload(track_id)
    threading.Thread(target=_run_sc_download, args=(job,), daemon=True).start()
    return job


def _hls_parts(url: str, headers: dict) -> list[str]:
    """Адреса всех кусочков трека из плейлиста HLS (.m3u8), по порядку."""
    text = _http.get(url, headers=headers, timeout=15).text
    if "#EXT-X-STREAM-INF" in text:   # это список вариантов качества — берём первый
        variant = next(line for line in text.splitlines() if line and not line.startswith("#"))
        return _hls_parts(urljoin(url, variant.strip()), headers)
    parts = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-MAP:"):           # «шапка» файла — идёт первой
            parts.append(urljoin(url, re.search(r'URI="([^"]+)"', line).group(1)))
        elif line.startswith("#EXT-X-KEY") and "METHOD=NONE" not in line:
            raise ValueError("Трек защищён от копирования (DRM)")
        elif line and not line.startswith("#"):
            parts.append(urljoin(url, line))
    return parts


def _fetch(url: str, headers: dict) -> bytes:
    resp = _http.get(url, headers=headers, timeout=20)
    resp.raise_for_status()
    return resp.content


def _run_sc_download(job: ScDownload):
    key = cache_key("soundcloud", job.track_id)
    try:
        print(f"[soundcloud] качаю {job.track_id} ...")
        opts = {"quiet": True, "noplaylist": True, "format": "bestaudio[protocol=m3u8_native]/bestaudio"}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(track_url("soundcloud", job.track_id), download=False)
        if not info.get("duration") or info["duration"] > MAX_DURATION:
            raise ValueError(f"Трек длиннее {MAX_DURATION // 60} минут")
        headers = info.get("http_headers") or {}
        is_hls = str(info.get("protocol", "")).startswith("m3u8")
        parts = _hls_parts(info["url"], headers) if is_hls else [info["url"]]
        with ThreadPoolExecutor(6) as pool:
            for future in [pool.submit(_fetch, part, headers) for part in parts]:
                job.add(future.result())   # по порядку: следующий ждём, только если он ещё не готов
        target = CACHE_DIR / f"{key}.{info.get('ext') or 'm4a'}"
        tmp = target.with_name(target.name + ".part")
        tmp.write_bytes(b"".join(job.chunks))
        os.replace(tmp, target)
        # Трек уже в файле — через пару минут забываем скачивание (и его кусочки в памяти, 3–8 МБ).
        # Раньше они копились навсегда: каждый проигранный трек SoundCloud оставался в памяти.
        # Кто ещё дочитывает поток, держит свою ссылку на job — у него ничего не пропадёт.
        threading.Timer(120, lambda: _sc_downloads.pop(job.track_id, None)).start()
        print(f"[soundcloud] готово: {target.name} ({len(parts)} кусочков)")
        job.finish()
    except Exception as e:
        print(f"[soundcloud] {job.track_id}: {e}")
        job.finish(friendly_error(e))
    finally:
        with lock_for("sc:" + job.track_id):
            if _sc_downloads.get(job.track_id) is job and not job.error:
                del _sc_downloads[job.track_id]   # файл уже в кэше — дальше отдаём его


def stream_soundcloud(track_id: str):
    key = cache_key("soundcloud", track_id)
    job = sc_download(track_id)
    if job is None:   # уже в кэше — обычный файл с перемоткой
        return send_file(find_cached(key), conditional=True)
    start = re.match(r"bytes=(\d+)-", request.headers.get("Range") or "")
    if request.args.get("full") or (start and int(start.group(1)) > 0):
        # Перемотка туда, что ещё не скачано (?full=1 просит плеер): дожидаемся конца
        # скачивания (обычно 1–3 секунды) и отдаём готовый файл с перемоткой
        job.wait_done()
        if job.error or not (path := find_cached(key)):
            return jsonify(error=job.error or "трек не докачался"), 502
        return send_file(path, conditional=True)
    if not job.wait_first():
        return jsonify(error=job.error or "не получилось скачать трек"), 502
    # Отдаём по мере скачивания. Длина заранее неизвестна, поэтому без Content-Length
    return Response(job.iter_chunks(), status=200, mimetype="audio/mp4", headers={"Accept-Ranges": "bytes"})


# ---------- Скачивание (как «Скачать» в Spotify) ----------
# Скачанный трек лежит в cache/ и отдаётся оттуда: стартует мгновенно и играет без интернета.
# Качаем в фоне, по 2 трека сразу. Что именно человек скачал, помнит медиатека
# (раздел downloads) — при запуске страница присылает этот список, и недокачанное докачивается.

_dl_status: dict[str, str] = {}   # "источник:id" -> queued | downloading | error
_dl_queue: "queue.Queue[tuple[str, str]]" = queue.Queue()
_dl_workers_started = False
_dl_lock = threading.Lock()


def _download_worker():
    while True:
        source, track_id = _dl_queue.get()
        key = f"{source}:{track_id}"
        _dl_status[key] = "downloading"
        try:
            if source == "youtube":
                get_audio_file(source, track_id)
            elif job := sc_download(track_id):
                job.wait_done(600)
                if job.error or not job.done:
                    raise RuntimeError(job.error or "не докачался")
            for size in ("small", "large"):   # обложки — чтобы и без интернета всё выглядело как надо
                get_cover_file(source, track_id, size)
            _dl_status.pop(key, None)
            print(f"[download] скачан {key}")
        except Exception as e:
            print(f"[download] {key}: {e}")
            _dl_status[key] = "error"


def download_status(source: str, track_id: str) -> str:
    if source == "local":
        return "done"   # свой файл и так на диске
    key = f"{source}:{track_id}"
    if key in _dl_status:
        return _dl_status[key]
    return "done" if find_cached(cache_key(source, track_id)) else "missing"


def queue_downloads(tracks: list[tuple[str, str]]) -> None:
    global _dl_workers_started
    with _dl_lock:
        if not _dl_workers_started:
            for _ in range(2):
                threading.Thread(target=_download_worker, daemon=True).start()
            _dl_workers_started = True
        for source, track_id in tracks:
            if download_status(source, track_id) in ("missing", "error"):
                _dl_status[f"{source}:{track_id}"] = "queued"
                _dl_queue.put((source, track_id))


# ---------- Тексты песен ----------
# Берём из LRCLIB (lrclib.net): бесплатная открытая база, без ключей. У многих песен там
# есть «синхронизированный» текст — каждая строка с отметкой времени, как в Spotify.
# Найденное (и «не найдено» — на сутки) храним в cache/lyrics/, чтобы не спрашивать снова.

LRCLIB = "https://lrclib.net/api"
LRCLIB_HEADERS = {"User-Agent": "Sono (open-source desktop music player)"}
LYRICS_DIR = CACHE_DIR / "lyrics"
LYRICS_DIR.mkdir(exist_ok=True)


def _parse_lrc(text: str) -> list[list]:
    """«[01:23.45] строка» → [[83.45, "строка"], ...] по порядку."""
    lines = []
    for raw in (text or "").splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        words = re.sub(r"\[\d+:\d+(?:\.\d+)?\]", "", raw).strip()
        lines += [[int(m) * 60 + float(s), words] for m, s in stamps]
    return sorted(lines, key=lambda line: line[0])


def _lyrics_result(data: dict) -> dict:
    return {"found": True, "instrumental": bool(data.get("instrumental")),
            "synced": _parse_lrc(data.get("syncedLyrics") or ""), "plain": data.get("plainLyrics") or ""}


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", " ", (text or "").lower().replace("ё", "е")).strip()


def find_lyrics(artist: str, title: str, duration: float) -> dict:
    # Каналы часто называются «Группа КИНО» — в базе же просто «Кино». Пробуем оба варианта
    artists = [artist]
    if (short := re.sub(r"^(группа|гр\.)\s+", "", artist, flags=re.I)) != artist:
        artists.append(short)

    # Собираем варианты: точный запрос (исполнитель + название + длительность ±2 с) и поиск похожих.
    # В базе бывают дубли без таймингов и мусор вроде записи из одной строки — поэтому
    # не берём первое попавшееся, а выбираем лучшее из всех.
    found = []
    for name in artists:
        params = {"artist_name": name, "track_name": title}
        if duration:
            params["duration"] = round(duration)
        resp = _http.get(f"{LRCLIB}/get", params=params, headers=LRCLIB_HEADERS, timeout=10)
        if resp.status_code == 200:
            found.append(resp.json())
    for query in [{"track_name": title, "artist_name": name} for name in artists] + [{"q": f"{artists[-1]} {title}"}]:
        resp = _http.get(f"{LRCLIB}/search", params=query, headers=LRCLIB_HEADERS, timeout=10)
        if resp.ok:
            found += resp.json()[:10]
    lines = lambda item: len([x for x in (item.get("plainLyrics") or item.get("syncedLyrics") or "").splitlines() if x.strip()])
    found = [item for item in found if item.get("instrumental") or lines(item) >= 5]   # пустышки — мимо
    if not found:
        return {"found": False}

    want_title, want_artist = _norm(title), set(_norm(artists[-1]).split())
    cyrillic = bool(re.search(r"[а-яё]", title.lower()))

    def score(item):
        s = 2 if item.get("syncedLyrics") else 0                       # с таймингами — лучше
        name = _norm(item.get("trackName"))
        s += 3 if name == want_title else 1 if want_title in name else -2
        if want_artist & set(_norm(item.get("artistName")).split()):
            s += 2
        if duration and item.get("duration"):
            diff = abs(item["duration"] - duration)
            s += 3 if diff <= 5 else 1 if diff <= 15 else -3
        text = item.get("plainLyrics") or item.get("syncedLyrics") or ""
        if cyrillic and not re.search(r"[а-яё]", text.lower()):
            s -= 4                                                      # русская песня, а текст латиницей — перевод
        return s

    best = max(found, key=score)
    return _lyrics_result(best) if score(best) > 0 else {"found": False}


# ---------- Обложки ----------

def cover_urls(source: str, track_id: str, size: str) -> list[str]:
    """Адреса, по которым можно взять обложку, по порядку предпочтения."""
    if source == "youtube":
        return [f"https://i.ytimg.com/vi/{track_id}/{v}.jpg" for v in COVER_VARIANTS[size]]
    artwork = _sc_artwork.get(track_id)
    if not artwork:   # сервер перезапускали после поиска — узнаём обложку заново
        with yt_dlp.YoutubeDL({"quiet": True}) as ydl:
            info = ydl.extract_info(track_url(source, track_id), download=False, process=False)
        artwork = info.get("thumbnail")
        if not artwork:
            return []
        _sc_artwork[track_id] = artwork
    return [re.sub(r"-[^-/]+\.jpg$", f"-{SC_COVER_SIZES[size]}.jpg", artwork)]


def get_cover_file(source: str, track_id: str, size: str) -> Path | None:
    """Скачивает обложку в cache/covers/ (если её там нет). None — если не вышло."""
    target = COVER_DIR / f"{cache_key(source, track_id)}_{size}.jpg"
    if target.exists():
        return target
    try:
        urls = cover_urls(source, track_id, size)
    except Exception as e:
        print(f"[cover] {source} {track_id}: не узнал адрес обложки: {e}")
        return None
    for url in urls:
        try:
            resp = _http.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)   # через обход/прокси, как всё остальное
            resp.raise_for_status()
            target.write_bytes(resp.content)
            print(f"[cover] {source} {track_id} {size}")
            return target
        except Exception as e:
            print(f"[cover] {url} не вышло: {e}")
    return None


# ---------- Медиатека: избранное, плейлисты, дизлайки, история, настройки ----------
# Всё лежит в одном файле library.json рядом с кэшем. Страница при каждом изменении
# присылает раздел целиком — для одного человека на своём компьютере этого хватает.
# (Хранить в браузере нельзя: у .exe каждый запуск новый порт, и браузер считает это другим сайтом.)

LIBRARY_FILE = DATA_DIR / "library.json"
LIBRARY_SECTIONS = {"liked": list, "disliked": list, "playlists": list, "history": list, "settings": dict,
                    "downloads": list,   # треки, которые человек скачал
                    "stats": dict}       # сколько слушали каждого исполнителя (static/js/stats.js)
_library_lock = threading.Lock()


def load_library() -> dict:
    """Читает медиатеку. Вызывать под _library_lock."""
    try:
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("внутри не словарь")
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as e:
        # Файл испорчен — не затираем его, а откладываем в сторону, чтобы данные можно было спасти
        broken = LIBRARY_FILE.with_name(f"library.broken-{int(time.time())}.json")
        print(f"[library] файл не читается ({e}), сохранил его как {broken.name}")
        try:
            LIBRARY_FILE.replace(broken)
        except OSError:
            pass
        data = {}
    return {name: data[name] if isinstance(data.get(name), kind) else kind()
            for name, kind in LIBRARY_SECTIONS.items()}


def save_library_section(name: str, value) -> None:
    with _library_lock:
        data = load_library()
        data[name] = value
        tmp = LIBRARY_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, LIBRARY_FILE)   # подмена целиком: если что-то упадёт, старый файл останется цел


# ---------- HTTP-маршруты ----------

def _body() -> dict:
    """JSON из запроса — всегда словарь: на кривые данные (число, строку, список) отвечаем понятной ошибкой
    или пустым результатом, а не падением сервера."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _list(value) -> list:
    return value if isinstance(value, list) else []

# Во всех адресах треков сначала источник, потом id: /api/stream/youtube/dQw4w9WgXcQ

@app.post("/api/import")
def api_import_start():
    """Запускает импорт. {url} — по ссылке, или {text} — по списку треков;
    match — где искать пары: youtube, soundcloud или auto (сначала SoundCloud, иначе YouTube)"""
    data = _body()
    match = data.get("match", "auto")
    if match not in SOURCES and match != "auto":
        return jsonify(error="Неизвестный источник"), 400
    try:
        job = importer.start(str(data.get("url", "")), match, search, MAX_DURATION,
                             text=str(data.get("text", ""))[:100_000])
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(job.snapshot())


@app.get("/api/import/<job_id>")
def api_import_status(job_id):
    job = importer.get(job_id)
    if not job:
        abort(404)
    return jsonify(job.snapshot())


@app.delete("/api/import/<job_id>")
def api_import_cancel(job_id):
    importer.cancel(job_id)
    return jsonify(ok=True)


# ---------- Перенос медиатеки и «Поделиться плейлистом» ----------
# Файлы кладём в «Загрузки» пользователя: их легко найти, отправить другу или перенести на другой ПК.

EXPORT_DIR = Path.home() / "Downloads"
if not EXPORT_DIR.is_dir():
    EXPORT_DIR = Path.home()
LIBRARY_LISTS = ("liked", "disliked", "history", "downloads")


def _safe_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name).strip(" .")[:80] or "Плейлист"


def _unique_path(name: str) -> Path:
    path = EXPORT_DIR / name
    n = 2
    while path.exists():
        path = EXPORT_DIR / f"{Path(name).stem} ({n}){Path(name).suffix}"
        n += 1
    return path


def _track_key(t: dict) -> str:
    return f"{t.get('source')}:{t.get('id')}"


def _clean_tracks(tracks) -> list[dict]:
    """Из чужого файла берём только треки с понятным источником и id."""
    return [t for t in (tracks or []) if isinstance(t, dict) and valid(t.get("source"), str(t.get("id")))]


@app.post("/api/library/export")
def api_library_export():
    """Резервная копия всей медиатеки — файл в «Загрузках»."""
    with _library_lock:
        data = load_library()
    backup = {"format": "sono-library", "version": 1, "exported": time.strftime("%Y-%m-%d %H:%M"),
              "library": {k: data[k] for k in ("playlists", *LIBRARY_LISTS, "stats")}}
    path = _unique_path(f"Sono — медиатека {time.strftime('%Y-%m-%d')}.json")
    path.write_text(json.dumps(backup, ensure_ascii=False, indent=1), encoding="utf-8")
    return jsonify(path=str(path), name=path.name)


@app.post("/api/library/import")
def api_library_import():
    """Восстановить медиатеку из файла копии. Ничего не затирает: новое добавляется к тому, что есть."""
    backup = _body()
    incoming = backup.get("library") if backup.get("format") in ("sono-library", "player-library") else None   # player-… — копии, сделанные до переименования
    if not isinstance(incoming, dict):
        return jsonify(error="Это не файл медиатеки Sono"), 400
    added = {}
    with _library_lock:
        current = load_library()
    for section in LIBRARY_LISTS:
        have = {_track_key(t) for t in current[section]}
        fresh = [t for t in _clean_tracks(incoming.get(section)) if _track_key(t) not in have]
        if fresh:
            save_library_section(section, current[section] + fresh)
        added[section] = len(fresh)
    playlists = current["playlists"]
    by_id = {p.get("id"): p for p in playlists}
    added["playlists"] = 0
    for p in incoming.get("playlists") or []:
        if not isinstance(p, dict) or not p.get("id"):
            continue
        tracks = _clean_tracks(p.get("tracks"))
        # Своя обложка — картинка data:image/… (не больше ~300 КБ, чтобы не раздуть медиатеку)
        cover = p.get("cover") if isinstance(p.get("cover"), str) and p["cover"].startswith("data:image/") \
            and len(p["cover"]) < 400_000 else None
        if p["id"] in by_id:   # такой плейлист уже есть — дописываем недостающие треки
            mine = by_id[p["id"]]
            have = {_track_key(t) for t in mine["tracks"]}
            mine["tracks"] += [t for t in tracks if _track_key(t) not in have]
            if cover and not mine.get("cover"):
                mine["cover"] = cover
        else:
            playlists.append({"id": p["id"], "name": str(p.get("name") or "Плейлист")[:100],
                              "created": p.get("created") or 0, "tracks": tracks, **({"cover": cover} if cover else {})})
            added["playlists"] += 1
    save_library_section("playlists", playlists)
    # Статистика: у каждого исполнителя берём большее время и прослушивания и самую раннюю дату
    theirs = (incoming.get("stats") or {}).get("artists") if isinstance(incoming.get("stats"), dict) else None
    if isinstance(theirs, dict):
        stats = current.get("stats") or {}
        mine = stats.setdefault("artists", {})
        for key, a in theirs.items():
            if not isinstance(a, dict) or not isinstance(a.get("sec"), (int, float)):
                continue
            have = mine.get(key)
            if not have:
                mine[key] = a
                continue
            have["sec"] = max(have.get("sec", 0), a["sec"])
            have["plays"] = max(have.get("plays", 0), a.get("plays", 0))
            have["first"] = min(have.get("first") or a.get("first") or 0, a.get("first") or have.get("first") or 0)
        stats["total"] = max(stats.get("total", 0), (incoming["stats"].get("total") or 0))
        stats["since"] = min(stats.get("since") or time.time() * 1000, incoming["stats"].get("since") or time.time() * 1000)
        save_library_section("stats", stats)
    return jsonify(added=added)


@app.post("/api/share/playlist")
def api_share_playlist():
    """Плейлист в файл — его можно отправить другу, он откроет его через «Импорт»."""
    data = _body()
    tracks = _clean_tracks(data.get("tracks"))
    name = str(data.get("name") or "Плейлист")[:100]
    path = _unique_path(f"{_safe_name(name)}.sono.json")
    path.write_text(json.dumps({"format": "sono-playlist", "version": 1, "name": name, "tracks": tracks},
                               ensure_ascii=False, indent=1), encoding="utf-8")
    return jsonify(path=str(path), name=path.name)


@app.post("/api/reveal")
def api_reveal():
    """Показать файл в Проводнике (только наши файлы из «Загрузок»)."""
    path = Path(str(_body().get("path", "")))
    if path.parent != EXPORT_DIR or not path.exists():
        abort(400)
    subprocess.Popen(["explorer", "/select,", str(path)])
    return jsonify(ok=True)


@app.get("/api/library")
def api_library():
    with _library_lock:
        return jsonify(load_library())


@app.put("/api/library/<section>")
def api_library_save(section):
    if section not in LIBRARY_SECTIONS:
        abort(404)
    value = request.get_json(silent=True)
    if not isinstance(value, LIBRARY_SECTIONS[section]):
        return jsonify(error="Неверные данные"), 400
    save_library_section(section, value)
    return jsonify(ok=True)



@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/search")
def api_search():
    query = request.args.get("q", "").strip()
    source = request.args.get("source", "youtube")
    if not query:
        return jsonify(error="Пустой запрос"), 400
    if source not in SOURCES:
        return jsonify(error="Неизвестный источник"), 400
    # Поиск идёт по мере ввода: одно и то же («моне» → «монет» → стёрли букву) часто ищут повторно —
    # недавние ответы помним 10 минут
    key = (source, query.lower())
    cached = _search_cache.get(key)
    if cached and time.time() - cached[0] < 600:
        return jsonify(results=cached[1])
    try:
        # Защищённые (DRM) треки SoundCloud не показываем — включить их всё равно нельзя
        results = [r for r in search(source, query) if not r.get("drm")]
    except Exception as e:  # покажем ошибку в интерфейсе, а не просто 500
        print(f"[error] search {source}: {e}")
        return jsonify(error=friendly_error(e)), 502
    _search_cache[key] = (time.time(), results)
    while len(_search_cache) > 200:
        _search_cache.pop(next(iter(_search_cache)))
    return jsonify(results=results)


_search_cache: dict[tuple, tuple] = {}


# ---------- Сколько раз слушали — пачкой (плейлисты, страница исполнителя) ----------
# SoundCloud — один запрос к API на 50 треков; YouTube — поиск по номеру видео (он выдаёт само видео
# с числом просмотров, ~0,6 с), по 4 одновременно. Ответы помним сутки (cache/plays.json).
PLAYS_FILE = CACHE_DIR / "plays.json"
try:
    _plays: dict = json.loads(PLAYS_FILE.read_text(encoding="utf-8"))
except (OSError, ValueError):
    _plays = {}
_plays_lock = threading.Lock()


def _plays_youtube(video_id: str) -> int | None:
    try:
        hit = next((r for r in search("youtube", video_id, limit=1) if r["id"] == video_id), None)
        return hit.get("plays") if hit else None
    except Exception:
        return None


def plays_for(tracks: list[tuple[str, str]]) -> dict[str, int | None]:
    now = time.time()
    out, need_yt, need_sc = {}, [], []
    for source, track_id in tracks:
        key = f"{source}:{track_id}"
        saved = _plays.get(key)
        if saved and now - saved[1] < 24 * 3600:
            out[key] = saved[0]
        elif (st := _track_stats.get(key)) and st.get("plays") is not None:
            out[key] = st["plays"]   # уже знаем из поиска или из получения ссылки
        elif source == "youtube":
            need_yt.append(track_id)
        elif source == "soundcloud":
            need_sc.append(track_id)
    if need_sc:
        with ydl_pool("search") as ydl:
            client_id = ydl.cache.load("soundcloud", "client_id")
        for i in range(0, len(need_sc), 50):
            try:
                resp = _http.get("https://api-v2.soundcloud.com/tracks", headers=SC_HEADERS, timeout=10,
                                 params={"ids": ",".join(need_sc[i:i + 50]), "client_id": client_id})
                for t in resp.json() if resp.ok else []:
                    out[f"soundcloud:{t['id']}"] = t.get("playback_count")
            except Exception:
                pass
    if need_yt:
        with ThreadPoolExecutor(4) as pool:
            for vid, n in zip(need_yt, pool.map(_plays_youtube, need_yt)):
                out[f"youtube:{vid}"] = n
    with _plays_lock:
        for key, n in out.items():
            if n is not None:
                _plays[key] = (n, now)
        try:
            PLAYS_FILE.write_text(json.dumps(_plays), encoding="utf-8")
        except OSError:
            pass
    return out


@app.post("/api/plays")
def api_plays():
    """{tracks: [{source, id}]} → {plays: {"источник:id": число или null}}. До 200 треков за раз."""
    items = [(str(t.get("source")), str(t.get("id"))) for t in _list(_body().get("tracks")) if isinstance(t, dict)]
    items = [(s, i) for s, i in items if s in ("youtube", "soundcloud") and valid(s, i)][:200]
    return jsonify(plays=plays_for(items))


@app.get("/api/stats/<source>/<track_id>")
def api_track_stats(source, track_id):
    """Сколько раз трек слушали и лайкали (для экрана «Сейчас играет»)."""
    if not valid(source, track_id):
        return jsonify(error="Неверный трек"), 400
    if source == "local":
        return jsonify(plays=None, likes=None)
    try:
        return jsonify(track_stats(source, track_id))
    except Exception as e:
        return jsonify(error=friendly_error(e)), 502


@app.post("/api/prepare/<source>/<track_id>")
def api_prepare(source, track_id):
    """Скачивает трек заранее, чтобы ошибка была видна до запуска плеера."""
    if not valid(source, track_id):
        return jsonify(error="Неверный id трека"), 400
    try:
        path = get_audio_file(source, track_id)
        return jsonify(ok=True, file=path.name, size=path.stat().st_size)
    except Exception as e:
        print(f"[error] prepare {source} {track_id}: {e}")
        return jsonify(error=friendly_error(e)), 502


@app.post("/api/prefetch/<source>/<track_id>")
def api_prefetch(source, track_id):
    """Готовит трек заранее, чтобы он начался сразу после нажатия ▶.

    YouTube: получаем ссылку и начало трека. SoundCloud: начинаем скачивать трек (в фоне)."""
    if not valid(source, track_id):
        abort(400)
    if source == "local":
        return jsonify(ok=True)   # свой файл — и так мгновенно
    try:
        if source == "youtube":
            resolve_stream(track_id)
            prefetch_head(track_id)   # и первые ~30 секунд звука — чтобы старт был мгновенным
        else:
            sc_download(track_id)
        return jsonify(ok=True)
    except Exception as e:
        print(f"[prefetch] {source} {track_id}: {e}")
        return jsonify(error=friendly_error(e)), 502


TEST_VIDEO = "dQw4w9WgXcQ"   # для замера скорости — видео, которое точно есть и не удалят


def _measure(proxy: str | None, stream_url: str, headers: dict) -> dict:
    """Скорость звука с YouTube (МБ/с) и время ответа SoundCloud (мс) через данный прокси (None — напрямую)."""
    s = requests.Session()
    s.trust_env = False   # не брать текущий режим из переменных окружения — меряем ровно этот вариант
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    result = {"youtube": None, "soundcloud": None}
    try:
        t0 = time.time()
        r = s.get(stream_url, headers={**headers, "Range": "bytes=0-1572863"}, stream=True, timeout=(6, 6))
        got = 0
        for chunk in r.iter_content(65536):
            got += len(chunk)
            if time.time() - t0 > 6:
                break
        result["youtube"] = round(got / max(time.time() - t0, 0.01) / 1048576, 2)
    except Exception as e:
        print(f"[network] замер YouTube ({proxy or 'напрямую'}): {e}")
    try:
        t0 = time.time()
        s.get("https://soundcloud.com/", timeout=6).raise_for_status()
        result["soundcloud"] = round((time.time() - t0) * 1000)
    except Exception as e:
        print(f"[network] замер SoundCloud ({proxy or 'напрямую'}): {e}")
    return result


@app.get("/api/network")
def api_network():
    # Списком пар, а не словарём: Flask сортирует ключи словаря, а порядок способов важен
    return jsonify(config=_network, strategies=list(netbypass.STRATEGIES.items()))


@app.put("/api/network")
def api_network_save():
    data = _body()
    config = {**_network, **{k: data[k] for k in NETWORK_DEFAULT if k in data}}
    if config["mode"] not in ("off", "bypass", "proxy") or config["strategy"] not in netbypass.STRATEGIES:
        return jsonify(error="Неизвестный режим"), 400
    if config["mode"] == "proxy" and not re.match(r"^(https?|socks5h?|socks4)://[^\s/]+:\d+$", config["proxy"].strip()):
        return jsonify(error="Адрес прокси — в виде socks5://127.0.0.1:1080 или http://адрес:порт"), 400
    config["proxy"] = config["proxy"].strip()
    apply_network(config)
    NETWORK_FILE.write_text(json.dumps(config), encoding="utf-8")
    return jsonify(config=_network)


@app.post("/api/network/test")
def api_network_test():
    """Замер: напрямую, каждым способом обхода и через свой прокси (если задан). Занимает 10–40 секунд."""
    try:
        stream_url, headers = resolve_stream(TEST_VIDEO)
    except Exception as e:
        return jsonify(error="Не получилось открыть YouTube даже для замера. Попробуйте режим «Свой прокси» "
                             f"(адрес из вашего VPN). Подробности: {friendly_error(e)}"), 502
    variants = [("off", None)] + [(name, "bypass") for name in netbypass.STRATEGIES]
    if _network.get("proxy"):
        variants.append(("proxy", _network["proxy"]))
    results = []
    for name, kind in variants:
        tmp = netbypass.DesyncProxy(name) if kind == "bypass" else None
        proxy = tmp.url if tmp else kind if name == "proxy" else None
        results.append({"name": name, **_measure(proxy, stream_url, headers)})
        if tmp:
            tmp.stop()
    return jsonify(results=results)


# ---------- Обновление yt-dlp (updater.py) ----------

@app.get("/api/update")
def api_update_status():
    st = updater.status()
    st["current"] = st["current"] or yt_dlp.version.__version__
    st["frozen"] = bool(getattr(sys, "frozen", False))
    return jsonify(st)


@app.post("/api/update/check")
def api_update_check():
    updater.check(force=True)
    return jsonify(ok=True)


# ---------- Обновление самой программы (appupdate.py) ----------

@app.get("/api/app-update")
def api_app_update_status():
    return jsonify(appupdate.status())


@app.post("/api/app-update/check")
def api_app_update_check():
    threading.Thread(target=appupdate.check, daemon=True).start()
    return jsonify(ok=True)


@app.post("/api/track-album")
def api_track_album():
    """{artist, title, duration} → альбом/сингл этого трека в базе Яндекса: {albumId, trackId} или 404."""
    data = _body()
    try:
        found = artists.find_track(str(data.get("artist") or "")[:200], str(data.get("title") or "")[:200], data.get("duration"))
    except Exception as e:
        return jsonify(error=friendly_error(e)), 502
    if not found:
        return jsonify(error="Не нашёл альбом с этим треком"), 404
    return jsonify(found)


_sc_links: dict[str, str] = {}


def source_link(source: str, track_id: str) -> str:
    """Ссылка на трек на самом сайте. У SoundCloud храним только номер — адрес страницы узнаём у его API."""
    if source == "youtube":
        return f"https://www.youtube.com/watch?v={track_id}"
    if track_id not in _sc_links:
        with ydl_pool("search") as ydl:
            client_id = ydl.cache.load("soundcloud", "client_id")
        resp = _http.get(f"https://api-v2.soundcloud.com/tracks/{track_id}", params={"client_id": client_id},
                         headers=SC_HEADERS, timeout=10)
        resp.raise_for_status()
        _sc_links[track_id] = resp.json()["permalink_url"]
    return _sc_links[track_id]


@app.get("/api/link/<source>/<track_id>")
def api_link(source, track_id):
    """Ссылка на трек на YouTube/SoundCloud — «⋯» → «Скопировать ссылку»."""
    if source not in SOURCES or not valid(source, track_id):   # у своих файлов ссылки нет
        abort(400)
    try:
        return jsonify(url=source_link(source, track_id))
    except Exception as e:
        return jsonify(error=friendly_error(e)), 502


@app.post("/api/open-link/<source>/<track_id>")
def api_open_link(source, track_id):
    """«⋯» → «Открыть на YouTube/SoundCloud»: страница трека в обычном браузере (адрес строим сами — только эти сайты)."""
    if source not in SOURCES or not valid(source, track_id):   # у своих файлов ссылки нет
        abort(400)
    try:
        url = source_link(source, track_id)
    except Exception as e:
        return jsonify(error=friendly_error(e)), 502
    if not re.match(r"^https://(www\.youtube\.com|soundcloud\.com)/", url):
        abort(400)
    webbrowser.open(url)
    return jsonify(ok=True)


@app.post("/api/open-releases")
def api_open_releases():
    """Окно «Что нового» → «Все выпуски на GitHub»: открыть страницу выпусков в обычном браузере.
    Адрес фиксированный — страница не может попросить открыть что-то другое."""
    if not appupdate.REPO:
        return jsonify(error="Репозиторий не указан"), 400
    webbrowser.open(f"https://github.com/{appupdate.REPO}/releases")
    return jsonify(ok=True)


@app.post("/api/app-update/install")
def api_app_update_install():
    """Человек согласился обновиться: скачать (если ещё не скачано) и установить. Программа перезапустится."""
    try:
        appupdate.download_and_install()
    except Exception as e:
        return jsonify(error=str(e)), 400
    return jsonify(ok=True)


# ---------- Статус в Discord (discord_rpc.py) ----------

_presence = discord_rpc.Presence(discord_rpc.CLIENT_ID)


_maxres_ok: dict[str, bool] = {}   # есть ли у видео YouTube большая картинка maxresdefault


def _public_cover(source: str, track_id: str, cover: str | None) -> str:
    """Обложка по открытому адресу: Discord берёт картинку сам, наш локальный сервер ему не виден."""
    if cover and cover.startswith("https://"):
        return cover.replace("200x200", "400x400")   # обложки альбомов Яндекса — покрупнее
    if source == "youtube":
        # Не hqdefault: он 4:3, и у широких видео чёрные полосы сверху и снизу «впечатаны» в саму картинку
        # (так было в статусе Discord). Широкая картинка без полос — maxresdefault (бывает не у всех) или mqdefault;
        # Discord сам обрезает её до квадрата по центру — как обложка в плеере
        if track_id not in _maxres_ok:
            try:
                _maxres_ok[track_id] = _http.head(f"https://i.ytimg.com/vi/{track_id}/maxresdefault.jpg", timeout=5).ok
            except requests.RequestException:
                _maxres_ok[track_id] = False
        return f"https://i.ytimg.com/vi/{track_id}/{'maxresdefault' if _maxres_ok[track_id] else 'mqdefault'}.jpg"
    try:
        urls = cover_urls(source, track_id, "large")
        return urls[0] if urls else ""
    except Exception:
        return ""


@app.get("/api/presence")
def api_presence_status():
    return jsonify(available=bool(discord_rpc.CLIENT_ID), connected=_presence.connected, error=_presence.error)


@app.post("/api/presence")
def api_presence():
    """{source, id, title, artist, album, cover, position, duration, playing} — или {clear: true}."""
    data = _body()
    if data.get("clear") or not data.get("playing") or not valid(data.get("source"), str(data.get("id", ""))):
        _presence.show(None)
        return jsonify(ok=True)
    source, track_id = data["source"], str(data["id"])

    def build():   # обложка SoundCloud может потребовать запроса — не держим страницу
        _presence.show(discord_rpc.activity(
            str(data.get("title") or ""), str(data.get("artist") or ""), album=str(data.get("album") or ""),
            cover=_public_cover(source, track_id, data.get("cover")),
            url=track_url(source, track_id) if source == "youtube" else "",
            source=SOURCES_TITLE.get(source, ""),
            position=float(data.get("position") or 0), duration=float(data.get("duration") or 0)))
    threading.Thread(target=build, daemon=True).start()
    return jsonify(ok=True)


SOURCES_TITLE = {"youtube": "YouTube", "soundcloud": "SoundCloud"}


# ---------- Flow: бесконечная подборка по вкусу (flow.py) ----------

@app.post("/api/flow")
def api_flow():
    data = _body()
    seeds = [s for s in _list(data.get("seeds"))[:60] if isinstance(s, dict)]
    mode = data.get("mode") if isinstance(data.get("mode"), str) and data["mode"] in flow.MODES else "mix"
    exclude = [str(x) for x in _list(data.get("exclude"))[:3000]]
    banned = [str(x) for x in _list(data.get("banned"))[:300]]
    tracks = [t for t in _list(data.get("tracks"))[:20] if isinstance(t, dict)]
    avoid = [a for a in _list(data.get("avoid"))[:300] if isinstance(a, dict)]
    known = [str(x) for x in _list(data.get("known"))[:2000]]
    recent = [str(x) for x in _list(data.get("recent"))[:20]]
    try:
        size = min(max(int(data.get("size") or 10), 1), 25)
    except (TypeError, ValueError):
        size = 10
    try:
        return jsonify(**flow.batch(seeds, mode, exclude, banned, size=size, tracks=tracks,
                                    avoid=avoid, known=known, recent=recent, quick=data.get("quick") is True,
                                    ready=lambda meta_id: not (_resolved.get(meta_id) or {"missing": True}).get("missing")))
    except Exception as e:
        print(f"[flow] {e}")
        return jsonify(error="Нет связи с Яндекс Музыкой — Flow не может подобрать треки"), 502


@app.post("/api/flow/mixes")
def api_flow_mixes():
    """«Ваши миксы» на «Главной»: {seeds: [{name, id?, weight}]} → группы похожих любимых исполнителей."""
    seeds = [s for s in _list(_body().get("seeds"))[:60] if isinstance(s, dict)]
    try:
        return jsonify(mixes=flow.mixes(seeds))
    except Exception as e:
        print(f"[flow] миксы: {e}")
        return jsonify(error="Нет связи с Яндекс Музыкой"), 502


# ---------- zapret: автонастройка уже установленного (zapret.py) ----------

TEST_SC = "https://soundcloud.com/forss/flickermood"   # старый демо-трек SoundCloud, никуда не денется


def _sc_test_urls() -> list[str]:
    """Пара первых кусочков звука SoundCloud — для замера скорости в подборе стратегии zapret."""
    opts = {"quiet": True, "noplaylist": True, "format": "bestaudio[protocol=m3u8_native]/bestaudio"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(TEST_SC, download=False)
    headers = info.get("http_headers") or {}
    if str(info.get("protocol", "")).startswith("m3u8"):
        return _hls_parts(info["url"], headers)[:2]
    return [info["url"]]


def _zapret_root() -> Path:
    path = Path(str(_body().get("path", "")))
    if not (path / "bin" / "winws.exe").is_file():
        raise LookupError("Папка zapret не найдена — нажмите «Найти» ещё раз")
    return path


@app.get("/api/zapret")
def api_zapret_find():
    """Где стоит zapret и в каком он состоянии. ?path= — проверить папку, которую указал человек."""
    try:
        return jsonify(found=zapret.find(request.args.get("path") or None))
    except LookupError as e:
        return jsonify(error=str(e)), 404


@app.post("/api/zapret/lists")
def api_zapret_lists():
    """Дописать домены YouTube и SoundCloud в список zapret."""
    try:
        root = _zapret_root()
        added = zapret.add_domains(root)
        return jsonify(added=added, info=zapret.describe(root))
    except LookupError as e:
        return jsonify(error=str(e)), 404
    except PermissionError:
        return jsonify(error="Папка zapret защищена от записи. Нажмите «Подобрать стратегию» — "
                             "с правами администратора плеер допишет домены сам."), 403


@app.post("/api/zapret/setup")
def api_zapret_setup():
    """Подбор лучшей стратегии и установка службой (спрашивает права администратора)."""
    try:
        root = _zapret_root()
        yt_url, _ = resolve_stream(TEST_VIDEO)
        sc_urls = _sc_test_urls()
    except LookupError as e:
        return jsonify(error=str(e)), 404
    except Exception as e:
        return jsonify(error="Не получилось подготовить замер: " + friendly_error(e)), 502
    try:
        (zapret.WORK_DIR / "applied").unlink(missing_ok=True)
        zapret.start_setup(root, yt_url, sc_urls)
    except PermissionError as e:
        return jsonify(error=str(e)), 403
    except (LookupError, RuntimeError) as e:
        return jsonify(error=str(e)), 409
    return jsonify(ok=True)


@app.get("/api/zapret/progress")
def api_zapret_progress():
    state = zapret.progress()
    # zapret поставлен и работает на весь компьютер — встроенный обход плееру больше не нужен
    flag = zapret.WORK_DIR / "applied"
    if state.get("state") == "done" and state.get("installed") and not flag.exists():
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.touch()
        if _network["mode"] == "bypass":
            config = {**_network, "mode": "off"}
            apply_network(config)
            NETWORK_FILE.write_text(json.dumps(config), encoding="utf-8")
            state["switchedOff"] = True
    return jsonify(state)


def _tracks_from_request() -> list[tuple[str, str]]:
    data = _body()
    return [(t.get("source"), str(t.get("id"))) for t in _list(data.get("tracks"))[:5000]
            if isinstance(t, dict) and t.get("source") != "local" and valid(t.get("source"), str(t.get("id")))]


@app.post("/api/downloads")
def api_downloads_start():
    """Скачать треки. {tracks: [{source, id}]} → состояние каждого («источник:id» → done/queued/...)"""
    tracks = _tracks_from_request()
    queue_downloads(tracks)
    return jsonify({f"{s}:{i}": download_status(s, i) for s, i in tracks})


@app.post("/api/downloads/status")
def api_downloads_status():
    return jsonify({f"{s}:{i}": download_status(s, i) for s, i in _tracks_from_request()})


@app.delete("/api/downloads/<source>/<track_id>")
def api_download_delete(source, track_id):
    """Удалить скачанный файл (обложки оставляем — они маленькие)."""
    if not valid(source, track_id):
        abort(400)
    if path := find_cached(cache_key(source, track_id)):
        try:
            path.unlink()
        except OSError as e:   # файл сейчас играет — Windows не даст удалить
            return jsonify(error=f"Не получилось удалить: файл занят ({e.strerror})"), 409
    return jsonify(ok=True)


# ---------- Исполнители и альбомы (данные из Яндекс Музыки и Deezer — artists.py) ----------

def _meta_call(fn, *args):
    try:
        return jsonify(fn(*args))
    except LookupError:
        abort(404)
    except Exception as e:
        print(f"[meta] {fn.__name__}{args}: {e}")
        return jsonify(error="Не получилось загрузить сведения об исполнителе — нет связи с Deezer"), 502


@app.get("/api/artist/search")
def api_artist_search():
    query = request.args.get("q", "").strip()
    return _meta_call(artists.search_artists, query) if query else jsonify([])


@app.get("/api/artist/by-name")
def api_artist_by_name():
    found = artists.artist_by_name(request.args.get("name", ""))
    return jsonify(found) if found else (jsonify(error="Исполнитель не нашёлся"), 404)


@app.get("/api/artist/<int:artist_id>")
def api_artist(artist_id):
    return _meta_call(artists.artist, artist_id)


@app.post("/api/new-releases")
def api_new_releases():
    """{ids: [id исполнителя Яндекса]} → релизы за последние 3 месяца (для подписок: «Новинки» на «Главной»)."""
    ids = [int(x) for x in _body().get("ids") or [] if str(x).isdigit()]
    try:
        return jsonify(releases=artists.new_releases(ids) if ids else [])
    except Exception as e:
        return jsonify(error=friendly_error(e)), 502


@app.get("/api/album/<album_id>")
def api_album(album_id):
    if not re.match(r"^(dz)?\d+$", album_id):
        abort(400)
    return _meta_call(artists.album, album_id)


IMG_DIR = CACHE_DIR / "meta-img"
IMG_DIR.mkdir(exist_ok=True)


@app.get("/api/img")
def api_img():
    """Фото исполнителя / обложка альбома (Яндекс) — через сервер и с кэшем на диске."""
    url = request.args.get("u", "")
    if not re.match(r"^https://(avatars\.yandex\.net|[\w.-]+\.dzcdn\.net)/", url):
        abort(400)
    path = IMG_DIR / (hashlib.sha1(url.encode()).hexdigest() + ".jpg")
    if not path.exists():
        try:
            resp = _http.get(url, timeout=10)
            resp.raise_for_status()
            path.write_bytes(resp.content)
        except Exception:
            abort(404)
    return send_file(path, mimetype="image/jpeg", max_age=7 * 24 * 3600)


@app.post("/api/versions")
def api_versions():
    """{source, id, artist, title, duration, exclude: ["источник:id"]} → другие загрузки того же трека
    (для трека с цензурой: человек послушает и выберет оригинал). importer.find_versions."""
    data = _body()
    source, track_id = str(data.get("source", "")), str(data.get("id", ""))
    if not valid(source, track_id):
        abort(400)
    exclude = {f"{source}:{track_id}", *[str(x) for x in data.get("exclude") or []]}
    artist, title = str(data.get("artist") or "")[:200], str(data.get("title") or "")[:200]
    try:
        versions = importer.find_versions(search, artist, title, data.get("duration"), exclude)
    except Exception as e:
        return jsonify(error=friendly_error(e)), 502
    return jsonify(versions=[{**v, "artists": artist or None, "origTitle": title or None} for v in versions])


# Трек из базы → пара на YouTube/SoundCloud. Найденное запоминаем навсегда, «не нашлось» — на сутки
# (вдруг загрузят). v2: старый запасной поиск в YouTube Music мог взять одноимённый трек другого
# исполнителя — поэтому прежний кэш (resolved.json) не используем, пары находятся заново.
RESOLVED_FILE = CACHE_DIR / "resolved-v2.json"
try:
    _resolved: dict = json.loads(RESOLVED_FILE.read_text(encoding="utf-8"))
except (OSError, ValueError):
    _resolved = {}
_resolved_lock = threading.Lock()


@app.post("/api/resolve")
def api_resolve():
    """{id, artists, title, duration, prefetch} → настоящий трек (YouTube или SoundCloud) или 404."""
    data = _body()
    meta_id = str(data.get("id", ""))
    if not re.match(r"^(ya|dz)\d+$", meta_id):
        abort(400)
    with lock_for("resolve:" + meta_id):
        saved = _resolved.get(meta_id)
        if saved is None or (saved.get("missing") and time.time() - saved.get("checked", 0) > 24 * 3600):
            artist, title = str(data.get("artists") or ""), str(data.get("title") or "")
            why: dict = {}
            try:
                found = importer._find_pair("auto", search, artist, title, data.get("duration"), why)
            except Exception as e:
                print(f"[resolve] {artist} — {title}: {e}")
                return jsonify(error=friendly_error(e)), 502
            saved = ({**found, "artists": artist, "origTitle": title} if found
                     else {"missing": True, "checked": time.time(), "drm": bool(why.get("drm"))})
            with _resolved_lock:
                _resolved[meta_id] = saved
                RESOLVED_FILE.write_text(json.dumps(_resolved, ensure_ascii=False), encoding="utf-8")
    if saved.get("missing"):
        if saved.get("drm"):
            return jsonify(error="Этот трек есть только на SoundCloud, и там он защищён от копирования (DRM)", drm=True), 404
        return jsonify(error="Этого трека нет ни на YouTube, ни на SoundCloud"), 404
    if data.get("prefetch"):   # заодно готовим звук, чтобы старт был мгновенным
        try:
            if saved["source"] == "youtube":
                resolve_stream(saved["id"])
                prefetch_head(saved["id"])
            else:
                sc_download(saved["id"])
        except Exception:
            pass
    return jsonify(saved)


@app.get("/api/lyrics/<source>/<track_id>")
def api_lyrics(source, track_id):
    """Текст песни. ?artist=&title=&duration= — как трек показан в плеере (уже без «мусора» в названии)."""
    if not valid(source, track_id):
        abort(400)
    cached = LYRICS_DIR / f"{cache_key(source, track_id)}.json"
    try:
        saved = json.loads(cached.read_text(encoding="utf-8"))
        if saved.get("found") or time.time() - saved.get("checked", 0) < 24 * 3600:
            return jsonify(saved)
    except (OSError, ValueError):
        pass
    try:
        result = find_lyrics(request.args.get("artist", ""), request.args.get("title", ""),
                             float(request.args.get("duration") or 0))
    except Exception as e:
        print(f"[lyrics] {source} {track_id}: {e}")
        return jsonify(error="Не получилось загрузить текст — нет связи с lrclib.net"), 502
    result["checked"] = time.time()
    cached.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return jsonify(result)


@app.get("/api/cover/<source>/<track_id>")
def api_cover(source, track_id):
    """Отдаёт обложку. ?size=small (для списка) или large (для плеера)."""
    size = request.args.get("size", "small")
    if not valid(source, track_id) or size not in COVER_VARIANTS:
        abort(400)
    path = localfiles.cover_of(track_id) if source == "local" else get_cover_file(source, track_id, size)
    if not path:
        abort(404)
    # Обложка трека не меняется — браузер может не переспрашивать сутки (раньше спрашивал при каждом показе).
    # У своих файлов обложку могут заменить — их проверяем как прежде
    return send_file(path, mimetype="image/jpeg", max_age=None if source == "local" else 24 * 3600)


@app.get("/api/stream/<source>/<track_id>")
def api_stream(source, track_id):
    """Отдаёт аудио браузеру. Играть можно сразу, перемотка работает в обоих случаях."""
    if not valid(source, track_id):
        abort(400)
    if source == "local":   # свой файл с компьютера — прямо с диска, с перемоткой
        path = localfiles.path_of(track_id)
        if not path:
            return jsonify(error="Файл не найден — его переместили или удалили"), 404
        return send_file(path, conditional=True)
    if source == "youtube":
        return stream_youtube(track_id)
    return stream_soundcloud(track_id)


# ---------- Свои файлы с компьютера (localfiles.py) ----------

@app.get("/api/local")
def api_local():
    """Папки, найденные треки и идёт ли сейчас просмотр папок."""
    return jsonify(**localfiles.status(), tracks=localfiles.tracks())


@app.post("/api/local/folders")
def api_local_add():
    """{path} — добавить папку с музыкой (подпапки тоже) и просмотреть её в фоне."""
    path = str(_body().get("path") or "").strip().strip('"')
    try:
        localfiles.add_folder(path)
    except Exception as e:
        return jsonify(error=str(e)), 400
    return jsonify(localfiles.status())


@app.delete("/api/local/folders")
def api_local_remove():
    path = str(_body().get("path") or "")
    localfiles.remove_folder(path)
    return jsonify(localfiles.status())


@app.post("/api/local/rescan")
def api_local_rescan():
    localfiles.touch_cover_cache()
    localfiles.scan()
    return jsonify(localfiles.status())


# ---------- Клипы вместо обложки ----------
# Если у трека есть официальный клип на YouTube, «Сейчас играет» показывает его без звука вместо обложки —
# звук идёт как обычно, видео подстраивается под него. Чтобы картинка не расходилась с музыкой, клип берём
# только если это то же самое видео, что играет, или его длительность совпадает с треком (±3 с):
# у клипов со сценкой во вступлении длительность другая — такие не показываем.

CLIP_WORDS = re.compile(r"official\s*(music\s*)?video|music\s*video|\bm/?v\b|official\s*mv|клип|video\s*oficial|videoclip", re.I)
NOT_CLIP = re.compile(r"audio|lyric|текст|visuali[sz]er|sped|slowed|nightcore|\b8d\b|remix|cover|кавер|\blive\b|концерт|"
                      r"karaoke|караоке|instrumental|reaction|type beat|tiktok|teaser|trailer|snippet", re.I)
CLIPS_FILE = CACHE_DIR / "clips.json"
try:
    _clips: dict = json.loads(CLIPS_FILE.read_text(encoding="utf-8"))
except (OSError, ValueError):
    _clips = {}


def find_clip(source: str, track_id: str, artist: str, title: str, duration: float | None,
              channel: str = "") -> str | None:
    """id видео YouTube с клипом этого трека или None."""
    if source == "youtube":
        # Играет само видео — картинка совпадает с музыкой до кадра. Показываем его, если это клип по названию
        # или видео с канала исполнителя/лейбла без пометок «audio/lyrics/…». «- Topic» — это только обложка
        if CLIP_WORDS.search(title or "") or (channel and not re.search(r"-\s*topic$", channel, re.I)
                                              and not NOT_CLIP.search(title or "")):
            return track_id
    if not title:
        return None
    want = importer._norm(title.split("(")[0])
    first_artist = importer._norm(artist.split(",")[0]) if artist else ""
    for r in search("youtube", f"{artist} {title} official video".strip(), limit=6):
        name = r.get("title") or ""
        if not CLIP_WORDS.search(name) or (NOT_CLIP.search(name) and not NOT_CLIP.search(title)):
            continue
        if want not in importer._norm(name):
            continue
        if first_artist and first_artist not in importer._norm(f"{r.get('channel') or ''} {name}") \
                and first_artist.replace(" ", "") not in importer._norm(f"{r.get('channel') or ''} {name}").replace(" ", ""):
            continue
        if not duration or not r.get("duration") or abs(r["duration"] - duration) > 3:
            continue   # длительность не совпала (или неизвестна) — картинка разойдётся с музыкой
        return r["id"]
    return None


@app.post("/api/clip")
def api_clip():
    """{source, id, artist, title, duration, channel} → {clip: id видео YouTube или null}. Ответ помним (нет клипа — неделю)."""
    data = _body()
    source, track_id = str(data.get("source", "")), str(data.get("id", ""))
    if not valid(source, track_id):
        abort(400)
    key = f"{source}:{track_id}"
    saved = _clips.get(key)
    if saved and (saved.get("clip") or time.time() - saved.get("checked", 0) < 7 * 24 * 3600):
        return jsonify(clip=saved.get("clip"))
    try:
        clip = find_clip(source, track_id, str(data.get("artist") or "")[:200], str(data.get("title") or "")[:200],
                         data.get("duration"), str(data.get("channel") or "")[:200])
    except Exception as e:
        return jsonify(error=friendly_error(e)), 502
    _clips[key] = {"clip": clip, "checked": time.time()}
    try:
        CLIPS_FILE.write_text(json.dumps(_clips, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    if clip:   # заранее готовим ссылку на видео — когда страница попросит, оно начнётся сразу
        threading.Thread(target=lambda: _safe(resolve_stream, clip, kind="video"), daemon=True).start()
    return jsonify(clip=clip)


def _safe(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except Exception as e:
        print(f"[clip] {e}")


@app.get("/api/video/youtube/<video_id>")
def api_video(video_id):
    """Видео клипа без звука — через сервер (и обход блокировок), с перемоткой."""
    if not valid("youtube", video_id):
        abort(400)
    return stream_youtube(video_id, kind="video")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
