"""Импорт плейлистов: по ссылке (Spotify, Яндекс Музыка, Apple Music, Deezer, YouTube, SoundCloud)
или списком треков, вставленным текстом (подходит для любого сервиса, например VK).

Импорт идёт в фоне: страница запускает его, получает номер задачи и раз в секунду
спрашивает, сколько уже готово. Когда всё готово, страница сама создаёт плейлист.

- YouTube: yt-dlp читает плейлист целиком — названия и длительности приходят сразу.
- SoundCloud: в списке приходят только ссылки, поэтому каждый трек читаем отдельно
  (по несколько сразу). Треки с защитой DRM пропускаем — их всё равно нельзя проиграть.
- Spotify, Яндекс, Apple, Deezer, текст: музыку оттуда взять нельзя, только список
  «исполнитель — название». Для каждого трека ищем пару на YouTube или SoundCloud.
  Spotify — со встроенного плеера (без аккаунта, до 100 треков); Яндекс и Deezer — через
  их открытый API; Apple — данные лежат прямо на странице плейлиста.
"""
import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, quote, urlencode, urlparse

import requests
import yt_dlp

MAX_TRACKS = 500   # больше за раз не импортируем
WORKERS = 6        # сколько треков обрабатываем одновременно


# ---------- Что за ссылка ----------

SPOTIFY_RE = re.compile(r"(?:open\.spotify\.com/(?:intl-[a-z-]+/)?|spotify:)(playlist|album|track)[/:]([A-Za-z0-9]{10,40})")
YANDEX_HOST = re.compile(r"(^|\.)music\.yandex\.(ru|com|by|kz|uz)$")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0 Safari/537.36"}


def detect(url: str) -> tuple[str, str]:
    """Возвращает (откуда, нормальная ссылка). Ошибка — если ссылка не подходит."""
    url = url.strip()
    if m := SPOTIFY_RE.search(url):
        return "spotify", f"https://open.spotify.com/embed/{m.group(1)}/{m.group(2)}"
    parsed = urlparse(url if "://" in url else "https://" + url)
    host = parsed.netloc.lower()
    path = parsed.path
    if YANDEX_HOST.search(host):
        # Ссылки Яндекса → адрес в их API
        if m := re.search(r"/users/([^/]+)/playlists/(\d+)", path):
            return "yandex", f"https://api.music.yandex.net/users/{m.group(1)}/playlists/{m.group(2)}"
        if m := re.search(r"/playlists/([\w.-]+)", path):
            return "yandex", f"https://api.music.yandex.net/playlist/{m.group(1)}"
        if m := re.search(r"/album/(\d+)", path):
            return "yandex", f"https://api.music.yandex.net/albums/{m.group(1)}/with-tracks"
        raise ValueError("Это не ссылка на плейлист или альбом Яндекс Музыки")
    if host.endswith("music.apple.com"):
        if not re.search(r"/(playlist|album)/", path):
            raise ValueError("Это не ссылка на плейлист или альбом Apple Music")
        return "apple", parsed._replace(scheme="https", fragment="").geturl()
    if host.endswith("deezer.com") or host.endswith("deezer.page.link") or host == "link.deezer.com":
        if not re.search(r"/(playlist|album)/\d+", path):   # короткая ссылка — узнаём, куда она ведёт
            path = urlparse(requests.head(url, allow_redirects=True, timeout=10, headers=UA).url).path
        if m := re.search(r"/(playlist|album)/(\d+)", path):
            return "deezer", f"https://api.deezer.com/{m.group(1)}/{m.group(2)}"
        raise ValueError("Это не ссылка на плейлист или альбом Deezer")
    if host.endswith("youtube.com") or host.endswith("youtu.be"):
        playlist_id = parse_qs(parsed.query).get("list", [None])[0]
        if not playlist_id:
            raise ValueError("Это ссылка на одно видео, а не на плейлист YouTube")
        return "youtube", f"https://www.youtube.com/playlist?list={playlist_id}"
    if host.endswith("soundcloud.com"):
        return "soundcloud", parsed._replace(scheme="https", query="", fragment="").geturl()
    raise ValueError("Не похоже на ссылку Spotify, Яндекс Музыки, Apple Music, Deezer, YouTube или SoundCloud")


# ---------- Задача импорта ----------

class ImportJob:
    def __init__(self, url: str, match: str):
        self.id = uuid.uuid4().hex
        self.url = url
        self.match = match          # где искать пары (для всего, кроме YouTube и SoundCloud)
        self.text = ""              # список треков для импорта из текста
        self.created = time.time()
        self.status = "running"     # running | done | error | cancelled
        self.error = ""
        self.kind = ""              # spotify | youtube | soundcloud
        self.name = ""              # название плейлиста
        self.total = 0
        self.done = 0
        self.tracks: list[dict | None] = []   # по порядку плейлиста; None — не получилось
        self.failed: list[dict] = []          # {title, reason}
        self.note = ""                        # пояснение (например, про лимит Spotify)
        self.lock = threading.Lock()
        self.cancelled = False

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "id": self.id, "status": self.status, "error": self.error,
                "kind": self.kind, "name": self.name, "note": self.note,
                "total": self.total, "done": self.done,
                "tracks": [t for t in self.tracks if t] if self.status == "done" else [],
                "failed": list(self.failed),
            }

    def step(self, index: int, track: dict | None, failed_title: str = "", reason: str = ""):
        with self.lock:
            self.tracks[index] = track
            if track is None:
                self.failed.append({"title": failed_title, "reason": reason})
            self.done += 1


_jobs: dict[str, ImportJob] = {}
_jobs_lock = threading.Lock()


def start(url: str, match: str, search_fn, max_duration: int, text: str = "") -> ImportJob:
    """Запускает импорт по ссылке url или по списку треков text (если он не пустой).

    search_fn(source, query, limit) — поиск из app.py. Возвращает запущенную задачу."""
    if text.strip():
        kind, clean_url = "text", ""
    else:
        kind, clean_url = detect(url)
    job = ImportJob(clean_url, match)
    job.kind = kind
    job.text = text
    with _jobs_lock:
        for old_id in [i for i, j in _jobs.items() if time.time() - j.created > 3600]:
            del _jobs[old_id]   # старые задачи больше не нужны
        _jobs[job.id] = job
    worker = {"spotify": _run_spotify, "yandex": _run_yandex, "apple": _run_apple, "deezer": _run_deezer,
              "text": _run_text, "youtube": _run_youtube, "soundcloud": _run_soundcloud}[kind]

    def run():
        try:
            worker(job, search_fn, max_duration)
            with job.lock:
                if job.status == "running":
                    job.status = "done"
        except Exception as e:
            print(f"[import] {job.url}: {e}")
            with job.lock:
                job.status = "error"
                job.error = _friendly(e, job.kind)

    threading.Thread(target=run, daemon=True).start()
    return job


def get(job_id: str) -> ImportJob | None:
    with _jobs_lock:
        return _jobs.get(job_id)


def cancel(job_id: str) -> None:
    if job := get(job_id):
        with job.lock:
            job.cancelled = True
            if job.status == "running":
                job.status = "cancelled"


# Что делать, если плейлист закрыт: по сервисам (без входа в аккаунт видны только открытые)
PRIVATE_HINT = {
    "spotify": "Этот плейлист закрытый — Spotify не показывает его без входа в аккаунт. "
               "Откройте его в Spotify → «⋯» → «Сделать общедоступным» (или «Добавить в профиль»), "
               "импортируйте, а потом при желании снова сделайте закрытым.",
    "yandex": "Этот плейлист закрытый. В Яндекс Музыке откройте плейлист → «⋯» → «Сделать публичным», "
              "импортируйте, а потом при желании снова закройте.",
    "apple": "Этот плейлист закрытый. В Apple Music откройте плейлист → «⋯» → «Поделиться плейлистом» "
             "(он станет доступен по ссылке) и вставьте сюда новую ссылку.",
    "deezer": "Этот плейлист закрытый. В Deezer откройте плейлист → «⋯» → сделайте его публичным и попробуйте снова.",
    "youtube": "Этот плейлист закрытый. На YouTube откройте плейлист → «Доступ» → «Открытый доступ» "
               "или «Доступ по ссылке» и попробуйте снова.",
    "soundcloud": "Этот плейлист закрытый. На SoundCloud откройте его настройки, сделайте публичным "
                  "или скопируйте секретную ссылку («Share» → ссылка с длинным кодом в конце).",
}


def _friendly(e: Exception, kind: str = "") -> str:
    text = str(e)
    if "404" in text or "403" in text or "401" in text or "private" in text.lower():
        return PRIVATE_HINT.get(kind, "Плейлист не найден или закрыт. Проверь ссылку и что плейлист открыт для всех")
    return re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", text)


def _set_entries(job: ImportJob, name: str, count: int):
    with job.lock:
        job.name = name or "Импорт"
        job.total = min(count, MAX_TRACKS)
        job.tracks = [None] * job.total
        if count > MAX_TRACKS:
            job.note = f"В плейлисте {count} треков — импортированы первые {MAX_TRACKS}"


def _parallel(job: ImportJob, items: list, fn):
    """Вызывает fn(index, item) для всех элементов, по WORKERS штук одновременно."""
    def guarded(args):
        if not job.cancelled:
            fn(*args)
    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(guarded, enumerate(items)))


# ---------- YouTube ----------

def _run_youtube(job: ImportJob, search_fn, max_duration: int):
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(job.url, download=False)
    entries = list(info.get("entries") or [])[:MAX_TRACKS]
    _set_entries(job, info.get("title"), len(list(info.get("entries") or [])))
    for i, e in enumerate(entries):
        title = e.get("title") or "?"
        duration = e.get("duration")
        if not e.get("id") or not duration:   # удалённые и закрытые видео приходят без длительности
            job.step(i, None, title, "видео удалено или закрыто")
        elif duration > max_duration:
            job.step(i, None, title, f"длиннее {max_duration // 60} минут")
        else:
            job.step(i, {"source": "youtube", "id": e["id"], "title": title,
                         "channel": e.get("channel") or e.get("uploader"), "duration": duration})


# ---------- SoundCloud ----------

def _run_soundcloud(job: ImportJob, search_fn, max_duration: int):
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(job.url, download=False)
    if info.get("_type") != "playlist":
        raise ValueError("Это ссылка на один трек, а не на плейлист SoundCloud")
    all_entries = list(info.get("entries") or [])
    entries = all_entries[:MAX_TRACKS]
    _set_entries(job, info.get("title"), len(all_entries))

    def one(i, entry):
        url = entry.get("url") or f"https://api.soundcloud.com/tracks/{entry.get('id')}"
        try:
            with yt_dlp.YoutubeDL({"quiet": True, "noplaylist": True}) as ydl:
                t = ydl.extract_info(url, download=False, process=False)
            if not t.get("duration") or t["duration"] > max_duration:
                job.step(i, None, t.get("title") or url, f"длиннее {max_duration // 60} минут")
            else:
                job.step(i, {"source": "soundcloud", "id": str(t["id"]), "title": t.get("title"),
                             "channel": t.get("uploader"), "duration": t["duration"]})
        except Exception as e:
            reason = "защищён от копирования (DRM)" if "DRM" in str(e) else "недоступен"
            job.step(i, None, entry.get("title") or url.rsplit("/", 1)[-1], reason)

    _parallel(job, entries, one)


# ---------- Поиск пар для треков из других сервисов ----------
# Spotify, Яндекс, Apple, Deezer и текст дают только список «исполнитель — название — длительность».
# Каждый сервис превращает свои данные в такой список, а пары ищет одна общая функция.

def _match_items(job: ImportJob, search_fn, name: str, items: list[dict]):
    """items: [{"artist", "title", "duration" (секунды или None)}]"""
    _set_entries(job, name, len(items))

    def one(i, item):
        artist = (item.get("artist") or "").replace(" ", " ").strip()
        title = (item.get("title") or "").strip()
        label = f"{artist} — {title}" if artist else title
        try:
            found = _find_pair(job.match, search_fn, artist, title, item.get("duration"))
        except Exception:
            found = None
        if found and artist and item.get("either_order") and _channel_order(found, artist, title) == "swapped":
            artist, title = title, artist   # строка списка была «Название - Исполнитель»
        if found:
            # Запоминаем исполнителей и название из исходного сервиса: у найденной пары
            # исполнитель — один канал-загрузчик, и соавторы бы потерялись
            if artist:
                found = {**found, "artists": artist, "origTitle": title}
            job.step(i, found)
        else:
            job.step(i, None, label, "не нашлось пары")

    _parallel(job, items[:job.total], one)


_SEARCH_POOL = ThreadPoolExecutor(12, thread_name_prefix="pair-search")   # импорт ищет по 6 треков сразу, по 2 сайта


def _find_pair(match: str, search_fn, artist: str, title: str, duration: float | None,
               why: dict | None = None) -> dict | None:
    """Ищет пару для трека. match: youtube | soundcloud | auto.

    auto — сначала SoundCloud (там трек потом стартует быстрее), но только если нашлось
    что-то действительно похожее и не защищённое от копирования; иначе — YouTube.
    why — если передан, туда пишется причина неудачи: {"drm": True} — трек есть только
    на SoundCloud, и там он защищён (так у артистов крупных лейблов)."""
    query = f"{artist} - {title}" if artist else title
    sources = ["soundcloud", "youtube"] if match == "auto" else [match]
    # Ищем на обоих сайтах сразу, а не по очереди: если на SoundCloud не нашлось, результат YouTube уже готов
    # (так пара для трека «из базы» находится на ~1–1,5 с быстрее). Ответ, который не понадобился, просто не ждём
    found = {source: _SEARCH_POOL.submit(search_fn, source, query, limit=8) for source in sources}
    for source in sources:
        ranked = _ranked(found[source].result(), duration, artist, title)
        for candidate in ranked[:3]:
            if source == "soundcloud":
                if match == "auto" and not _close_enough(candidate, duration, artist, title):
                    break   # на SoundCloud нет точного совпадения — идём на YouTube
                if (candidate.get("duration") or 0) < 45 and not (duration and duration < 45):
                    continue   # 30-секундный отрывок вместо трека — SoundCloud так отдаёт часть музыки
                if candidate.get("drm") or "drm" not in candidate and not _sc_playable(candidate["id"]):
                    if why is not None:
                        why["drm"] = True
                    continue   # защищён (DRM) — пробуем следующий вариант
                return candidate
            if _looks_original(candidate, duration, artist, title):
                return candidate
        if source == "youtube":
            # В обычном поиске YouTube у малоизвестных артистов первыми идут биты «type beat»,
            # ремейки и реакции, а оригинала нет. Зато он есть в разделе «Песни» YouTube Music.
            if found := _youtube_music_song(artist, title, duration):
                return found
    return None   # лучше честно «не нашлось», чем подсунуть инструментал или чужой ремейк


def _looks_original(track: dict, duration: float | None, artist: str, title: str) -> bool:
    """Похоже ли видео на сам трек, а не на бит, ремейк, урок или реакцию."""
    name, original = (track.get("title") or "").lower(), title.lower()
    if any(word in name and word not in original for word in OTHER_VERSIONS):
        return False
    if _norm(title.split("(")[0]) not in _norm(name):   # в названии видео должно быть название трека
        return False
    if duration and track.get("duration") and abs(track["duration"] - duration) > 15:
        return False
    first_artist = artist.split(",")[0].strip().lower()
    where = f"{track.get('channel') or ''} {name}".lower()
    return not first_artist or first_artist in where or first_artist.replace(" ", "") in where.replace(" ", "")


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", " ", (text or "").lower().replace("ё", "е")).strip()


def _youtube_music_song(artist: str, title: str, duration: float | None) -> dict | None:
    """Ищет официальную запись в YouTube Music. В выдаче нет исполнителя и длительности, поэтому
    кандидатов с точно таким же названием проверяем по-настоящему: канал исполнителя
    («Исполнитель - Topic» или его собственный) и длительность ±10 с."""
    want = _norm(title.split("(")[0])
    if not want:
        return None
    first_artist = _norm(artist.split(",")[0])
    # Общая выдача: в ней есть раздел «Песни» с официальными записями
    # (отдельная вкладка «#songs» выдаёт что-то своё, не по запросу — проверено)
    url = "https://music.youtube.com/search?q=" + quote(f"{artist} {title}")
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "playlistend": 12}) as ydl:
            entries = list(ydl.extract_info(url, download=False).get("entries") or [])[:12]
    except Exception:
        return None
    candidates = [e["id"] for e in entries if e.get("id") and _norm((e.get("title") or "").split("(")[0]) == want]
    for video_id in candidates[:2]:
        try:
            with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
                info = ydl.extract_info(f"https://music.youtube.com/watch?v={video_id}", download=False, process=False)
        except Exception:
            continue
        who = _norm(" ".join(str(info.get(k) or "") for k in ("channel", "uploader", "artist", "creator"))
                    + " " + " ".join(info.get("artists") or []))
        got = info.get("duration")
        if first_artist and first_artist not in who:
            continue
        if duration and got and abs(got - duration) > 10:
            continue
        return {"source": "youtube", "id": video_id, "title": info.get("title") or title,
                "channel": info.get("channel") or artist.split(",")[0].strip() or None, "duration": got or duration}
    return None


def _words(text: str) -> set[str]:
    return set(re.findall(r"\w+", text.lower()))


def _close_enough(track: dict, duration: float | None, artist: str, title: str) -> bool:
    """Для «Авто»: на SoundCloud много перезаливов, ремиксов и 30-секундных отрывков —
    берём только явно тот же трек."""
    text = f"{track.get('channel') or ''} {track.get('title') or ''}".lower()
    first_artist = artist.split(",")[0].strip().lower()
    # Имя исполнителя может быть и слитно: канал «lucybedroque» = «Lucy Bedroque»
    if first_artist and first_artist not in text and first_artist.replace(" ", "") not in text.replace(" ", ""):
        return False
    if title and title.split("(")[0].strip().lower() not in text:
        return False
    got = track.get("duration") or 0
    if duration:
        return abs(got - duration) <= 8
    # Длительность оригинала неизвестна (импорт списком) — отсекаем явно не то:
    # отрывки, многочасовые «full»-версии и названия с лишними словами
    extra = _words(track.get("title") or "") - _words(f"{artist} {title}") - {"feat", "ft", "official", "audio"}
    return 45 <= got <= 480 and len(extra) <= 2


_sc_checked: dict[str, bool] = {}


def _sc_playable(track_id: str) -> bool:
    """Можно ли проиграть трек SoundCloud (часть треков защищена DRM — yt-dlp тогда ругается)."""
    if track_id not in _sc_checked:
        try:
            with yt_dlp.YoutubeDL({"quiet": True, "noplaylist": True}) as ydl:
                ydl.extract_info(f"https://api.soundcloud.com/tracks/{track_id}", download=False, process=False)
            _sc_checked[track_id] = True
        except Exception:
            _sc_checked[track_id] = False
    return _sc_checked[track_id]


def _get_json(url: str) -> dict:
    resp = requests.get(url, headers=UA, timeout=15)
    resp.raise_for_status()
    return resp.json()


# ---------- Spotify ----------

def _run_spotify(job: ImportJob, search_fn, max_duration: int):
    resp = requests.get(job.url, headers=UA, timeout=15)
    resp.raise_for_status()
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.+?)</script>', resp.text)
    try:
        entity = json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (AttributeError, KeyError, TypeError, ValueError):
        # У закрытого плейлиста Spotify без входа в аккаунт не отдаёт ничего
        raise ValueError(PRIVATE_HINT["spotify"]) from None
    raw = entity.get("trackList") or []
    if "/track/" in job.url:   # ссылка на один трек — делаем «плейлист» из него
        raw = [{"title": entity.get("name") or entity.get("title"), "subtitle": ", ".join(
            a.get("name", "") for a in entity.get("artists") or []), "duration": entity.get("duration")}]
    items = [{"artist": t.get("subtitle"), "title": t.get("title"),
              "duration": (t.get("duration") or 0) / 1000 or None}   # у Spotify миллисекунды
             for t in raw]
    if "/playlist/" in job.url and len(items) >= 100:
        job.note = "Spotify без входа в аккаунт отдаёт только первые 100 треков плейлиста"
    _match_items(job, search_fn, entity.get("name") or entity.get("title"), items)


# ---------- Яндекс Музыка ----------

def _yandex_item(t: dict) -> dict:
    title = t.get("title") or ""
    if t.get("version"):   # «Песня» + версия «Remix» → «Песня (Remix)»
        title += f" ({t['version']})"
    return {"artist": ", ".join(a.get("name", "") for a in t.get("artists") or []),
            "title": title, "duration": (t.get("durationMs") or 0) / 1000 or None}


def _run_yandex(job: ImportJob, search_fn, max_duration: int):
    result = _get_json(job.url)["result"]
    if "/albums/" in job.url:
        raw = [t for volume in result.get("volumes") or [] for t in volume]
        name = result.get("title")
    else:
        raw = [entry.get("track") or entry for entry in result.get("tracks") or []]
        name = result.get("title")
        if result.get("trackCount", 0) > len(raw):
            job.note = f"Яндекс отдал {len(raw)} треков из {result['trackCount']}"
    _match_items(job, search_fn, name, [_yandex_item(t) for t in raw if t.get("title")])


# ---------- Apple Music ----------

def _run_apple(job: ImportJob, search_fn, max_duration: int):
    resp = requests.get(job.url, headers=UA, timeout=15)
    resp.raise_for_status()
    resp.encoding = "utf-8"
    m = re.search(r'<script type="application/json" id="serialized-server-data">(.+?)</script>', resp.text, re.S)
    if not m:
        raise ValueError("Apple Music не отдал список треков. Возможно, плейлист закрыт")
    data = json.loads(m.group(1))

    # Треки на странице — это объекты с названием, исполнителями (subtitleLinks) и длительностью
    tracks, headers = [], []

    def walk(o):
        if isinstance(o, dict):
            if "title" in o and "duration" in o and "subtitleLinks" in o:
                tracks.append(o)
            elif "title" in o and o.get("subtitleLinks"):
                headers.append(o)   # шапка альбома: название + исполнитель
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)

    # У треков альбома исполнитель не указан — берём его из шапки альбома
    album_artist = ", ".join(s.get("title", "") for s in (headers[0]["subtitleLinks"] if headers else []))
    title_tag = re.search(r'<meta property="og:title" content="([^"]+)"', resp.text)
    name = re.sub(r"\s+(on|в)\s+Apple\s+Music$|\s+[-–—]\s+Apple\s+Music$", "", title_tag.group(1)) if title_tag else "Apple Music"
    name = re.sub(r"\s+by\s+.+$", "", name) if "/album/" in job.url else name
    items = [{"artist": ", ".join(s.get("title", "") for s in t.get("subtitleLinks") or []) or album_artist,
              "title": t.get("title"), "duration": (t.get("duration") or 0) / 1000 or None}
             for t in tracks]
    _match_items(job, search_fn, name, items)


# ---------- Deezer ----------

def _run_deezer(job: ImportJob, search_fn, max_duration: int):
    info = _get_json(job.url)
    if info.get("error"):
        raise ValueError("Deezer: плейлист не найден или закрыт")
    raw = list(info.get("tracks", {}).get("data") or [])
    next_url = info.get("tracks", {}).get("next")
    while next_url and len(raw) < MAX_TRACKS:   # длинные плейлисты Deezer отдаёт страницами
        page = _get_json(next_url)
        raw += page.get("data") or []
        next_url = page.get("next")
    items = [{"artist": (t.get("artist") or {}).get("name"), "title": t.get("title"), "duration": t.get("duration")}
             for t in raw]
    _match_items(job, search_fn, info.get("title"), items)


# ---------- Список текстом ----------
# По строке на трек: «Исполнитель - Название» (или просто название). Номера в начале строк убираем.

def _run_text(job: ImportJob, search_fn, max_duration: int):
    items = []
    for line in job.text.splitlines():
        line = re.sub(r"^\s*(\d+[.)]\s*|[-•*]\s+)", "", line).strip()   # «1. », «- », «• »
        if not line:
            continue
        parts = re.split(r"\s+[-–—]\s+", line, maxsplit=1)
        # either_order: человек мог написать и «Название - Исполнитель» — проверим по найденной паре
        items.append({"artist": parts[0], "title": parts[1], "either_order": True} if len(parts) == 2
                     else {"artist": "", "title": line})
    if not items:
        raise ValueError("В списке нет ни одного трека")
    if _list_is_swapped(items):   # весь список записан наоборот — сразу меняем местами
        items = [{**it, "artist": it["title"], "title": it["artist"]} if it["artist"] else it for it in items]
    _match_items(job, search_fn, "Импорт из списка", items)


def _same(a: str, b: str) -> bool:
    """Одно и то же имя? Сравниваем по словам: «Lucy Bedroque» есть в «Lucy Bedroque, slayr»,
    а однобуквенное «C» не найдётся внутри «lucybedroque»."""
    wa, wb = set(_norm(a).split()), set(_norm(b).split())
    if not wa or not wb:
        return False
    # «lucybedroque» (имя канала слитно) = «Lucy Bedroque»
    ca, cb = "".join(_norm(a).split()), "".join(_norm(b).split())
    return wa <= wb or wb <= wa or ca == cb or min(len(ca), len(cb)) >= 4 and (ca in cb or cb in ca)


def _yandex_order(item: dict) -> str | None:
    """Где исполнитель, а где название — по Яндекс Музыке: ищем «левое правое» среди треков.
    "normal" — слева исполнитель, "swapped" — слева название, None — не понять (трека там нет)."""
    try:
        found = _get_json("https://api.music.yandex.net/search?" + urlencode(
            {"text": f"{item['artist']} {item['title']}", "type": "track", "page": 0}))
    except Exception:
        return None
    for t in (((found.get("result") or {}).get("tracks") or {}).get("results") or [])[:5]:
        names = ", ".join(a.get("name", "") for a in t.get("artists") or [])
        if _same(names, item["artist"]) and _same(t.get("title"), item["title"]):
            return "normal"
        if _same(names, item["title"]) and _same(t.get("title"), item["artist"]):
            return "swapped"
    return None


def _list_is_swapped(items: list[dict]) -> bool:
    """Список обычно пишут одинаково от начала до конца — смотрим первые 10 строк и решаем за всех."""
    sample = [it for it in items if it.get("either_order")][:10]
    if not sample:
        return False
    with ThreadPoolExecutor(5) as pool:
        votes = list(pool.map(_yandex_order, sample))
    return votes.count("swapped") > votes.count("normal")


def _channel_order(found: dict, artist: str, title: str) -> str | None:
    """Где исполнитель — по каналу найденной пары: на SoundCloud и YouTube канал — это исполнитель."""
    channel = _norm(re.sub(r"\s*-\s*topic$|vevo$", "", found.get("channel") or "", flags=re.I))
    in_left, in_right = _same(channel, artist), _same(channel, title)
    if in_left != in_right:
        return "normal" if in_left else "swapped"
    return None


# Слова, по которым видно, что это не студийная версия (если их нет в оригинальном названии)
OTHER_VERSIONS = ("live", "cover", "remix", "slowed", "sped up", "speed up", "nightcore", "karaoke",
                  "instrumental", "8d", "reverb", "concert", "концерт", "кавер", "ремикс", "минус", "караоке",
                  "bass boost", "(bass)", "[bass]",
                  "hz)", "hz]", "lesson", "tutorial", "reaction", "reacts", "1 hour", "loop", "teaser", "snippet",
                  "later... with", "урок", "разбор", "реакция",
                  # биты и ремейки, которыми забит поиск по малоизвестным артистам
                  "type beat", "remake", "flp", "fl studio", "how to make", "was made", "how ''", "prod.",
                  "free for profit", "[free]", "(free)", "remaster", "live audio", "sample found",
                  "unreleased", "trailer", "review", "but with", "snippet", "leak",
                  # версии с цензурой (запиканные или с вырезанными словами)
                  "clean version", "(clean)", "[clean]", "- clean", "(censored)", "[censored]", "censored version",
                  "radio edit", "radio version", "радио версия", "радио-версия", "radio mix")

# ---------- Версии без цензуры ----------
# Сейчас треки «чистят» так: заменяют слова («наркотик» → «компотик») или вырезают их, оставляя музыку.
# По звуку это не распознать (нужно распознавание речи), поэтому ищем ДРУГИЕ загрузки того же трека:
# с пометкой «без цензуры»/«оригинал» и старые (выложены до того, как трек переделали). Какая из них
# без цензуры — человек решает на слух; Sono запоминает выбор.

UNCENSORED_WORDS = ("explicit", "uncensored", "dirty", "без цензуры", "нецензур", "18+", "uncut",
                    "original version", "оригинал", "старая версия", "до цензуры", "old version", "без купюр")
CENSORED_WORDS = ("clean", "censored", "radio edit", "radio version", "edited", "радио версия", "радио-версия",
                  "цензур", "без мата", "tv version", "family friendly")


# Скобки, которые ничего не говорят о версии
BRACKET_JUNK = r"official|audio|video|lyric|visuali[sz]er|клип|текст|премьера|prod|feat|ft\.|music|hd|hq|\d{4}"


def censor_hint(name: str) -> int:
    """+1 — в названии сказано, что без цензуры; −1 — что с цензурой; 0 — не сказано."""
    name = (name or "").lower()
    if any(w in name for w in UNCENSORED_WORDS):   # сначала: «uncensored» и «без цензуры» содержат «censored»/«цензур»
        return 1
    return -1 if any(w in name for w in CENSORED_WORDS) else 0


def find_versions(search_fn, artist: str, title: str, duration: float | None,
                  exclude: set[str], limit: int = 8) -> list[dict]:
    """Другие загрузки того же трека на YouTube и SoundCloud — от самых вероятных «без цензуры».
    У каждой — why: почему она может быть оригиналом."""
    base = f"{artist} {title}".strip()
    queries = [("soundcloud", base), ("youtube", base), ("youtube", f"{base} без цензуры")]
    with ThreadPoolExecutor(3) as pool:
        found = list(pool.map(lambda q: _safe_search(search_fn, *q), queries))
    seen, out = set(), []
    for (source, _), results in zip(queries, found):
        for rank, r in enumerate(_ranked(results, duration, artist, title)):
            key = f"{source}:{r['id']}"
            if key in exclude or key in seen:
                continue
            seen.add(key)
            hint = censor_hint(r.get("title"))
            if hint < 0 or r.get("drm"):
                continue   # сама подписана как «clean»/«radio edit» или защищена (DRM) — не сыграть
            if duration and r.get("duration") and abs(r["duration"] - duration) > 20:
                continue
            name = (r.get("title") or "").lower()
            if any(word in name and word not in title.lower() for word in OTHER_VERSIONS):
                continue   # ремикс, кавер, live — это уже другой трек
            if not (_close_enough(r, duration, artist, title) if source == "soundcloud" else _looks_original(r, duration, artist, title)):
                continue
            why, score = [], -rank * 0.4
            if hint > 0:
                why.append("подписан как «без цензуры»")
                score += 4
            # Пометка в скобках, которой нет в оригинале и которая не «мусор» вроде (Official Audio) —
            # скорее всего, это другая версия («Xmas Edition», «Sped Up»…)
            extra = [b for b in re.findall(r"[(\[]([^)\]]+)[)\]]", name)
                     if b.strip() not in title.lower() and not re.search(BRACKET_JUNK, b)]
            if extra and hint <= 0:
                score -= 2
            year = time.gmtime(r["uploaded"]).tm_year if r.get("uploaded") else None
            if year:
                r = {**r, "year": year}
                age = time.gmtime().tm_year - year
                if age >= 2:
                    why.append(f"старая загрузка ({year}) — могла остаться без правок")
                score += min(age, 6) * 0.5   # чем старше загрузка, тем вероятнее оригинал
            if source == "soundcloud":
                score += 0.5   # на SoundCloud артисты часто оставляют первую версию
            out.append((score, {**r, "why": why}))
    out.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in out[:limit]]


def _safe_search(search_fn, source: str, query: str) -> list[dict]:
    try:
        return search_fn(source, query, limit=10)
    except Exception:
        return []


def _best_match(results: list[dict], want_duration: float | None, artist: str, title: str) -> dict | None:
    ranked = _ranked(results, want_duration, artist, title)
    return ranked[0] if ranked else None


def _ranked(results: list[dict], want_duration: float | None, artist: str, title: str) -> list[dict]:
    """Результаты поиска от самого похожего на оригинал к наименее похожему.

    Баллы: чем ближе длительность — тем лучше; официальный канал исполнителя — плюс;
    «live», «cover», «remix» и т.п., которых нет в оригинале, — минус; чуть выше ценится то,
    что поиск поставил выше."""
    first_artist = artist.split(",")[0].strip().lower()
    original = title.lower()

    def score(pair):
        rank, r = pair
        s = -rank * 0.4
        if want_duration and r.get("duration"):
            s -= min(abs(r["duration"] - want_duration), 120) / 8   # каждые 8 секунд разницы — минус балл
        channel = (r.get("channel") or "").lower()
        if first_artist and first_artist in channel:
            s += 1.5   # канал самого исполнителя (на YouTube «Исполнитель - Topic» — студийные записи)
        name = (r.get("title") or "").lower()
        if any(word in name and word not in original for word in OTHER_VERSIONS):
            s -= 3
        return s

    return [r for _, r in sorted(enumerate(results), key=score, reverse=True)]
