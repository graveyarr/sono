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
import io
import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, quote, urlencode, urlparse

import requests
import yt_dlp

from artists import _track as artists_track   # трек Яндекса → данные трека «из базы» (обложка, исполнители, альбом)

# Одно постоянное соединение на сайт: без него каждый запрос заново «здоровается» с сервером (~0,3–0,5 с)
_http = requests.Session()

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
        # Переезд всей медиатеки Яндекса: что переносить, по каким спискам разложить, любимые исполнители
        self.yandex: dict = {}
        self.collections: list[dict] = []   # [{name, kind, ids}] — ids по порядку списка
        self.order: list[str] = []          # номер трека Яндекса для каждого места в self.tracks
        self.artists: list[dict] = []
        self.files: list[dict] = []          # импорт из файлов: [{name, kind, items}]
        self.soundcloud: dict = {}            # переезд со SoundCloud: {login, liked, playlists, artists}

    def snapshot(self) -> dict:
        with self.lock:
            done = self.status == "done"
            data = {
                "id": self.id, "status": self.status, "error": self.error,
                "kind": self.kind, "name": self.name, "note": self.note,
                "total": self.total, "done": self.done,
                "tracks": [t for t in self.tracks if t] if done else [],
                "failed": list(self.failed),
            }
            if self.kind in ("yandex_all", "files", "sc_all"):
                data["tracks"] = []   # треки — внутри списков
                # Остановили на полпути — отдаём то, что уже нашлось (переезд бывает на тысячи треков)
                if done or (self.status == "cancelled" and self.order):
                    found = {i: t for i, t in zip(self.order, self.tracks) if t}
                    data["collections"] = [{"name": c["name"], "kind": c["kind"],
                                            "tracks": [found[i] for i in c["ids"] if i in found]}
                                           for c in self.collections]
                    data["artists"] = list(self.artists)
            return data

    def step(self, index: int, track: dict | None, failed_title: str = "", reason: str = ""):
        with self.lock:
            self.tracks[index] = track
            if track is None:
                self.failed.append({"title": failed_title, "reason": reason})
            self.done += 1


_jobs: dict[str, ImportJob] = {}
_jobs_lock = threading.Lock()


def start(url: str, match: str, search_fn, max_duration: int, text: str = "", yandex: dict | None = None,
          files: list | None = None, soundcloud: dict | None = None) -> ImportJob:
    """Запускает импорт по ссылке url, по списку треков text (если он не пустой) или переезд всей
    медиатеки Яндекса yandex = {login, liked, playlists: [номера], artists}.

    search_fn(source, query, limit) — поиск из app.py. Возвращает запущенную задачу."""
    if yandex:
        if not re.fullmatch(r"[\w.@+-]{1,100}", str(yandex.get("login", ""))):
            raise ValueError("Не понял логин Яндекса — вставьте ссылку на свой профиль или плейлист")
        kind, clean_url = "yandex_all", ""
    elif soundcloud:
        if not soundcloud_user(str(soundcloud.get("login", ""))):
            raise ValueError("Не понял ник SoundCloud — вставьте ссылку на свой профиль")
        kind, clean_url = "sc_all", ""
    elif files:
        parsed = parse_files(files)   # ошибка в файле — сразу, до запуска задачи
        kind, clean_url = "files", ""
    elif text.strip():
        kind, clean_url = "text", ""
    else:
        kind, clean_url = detect(url)
    job = ImportJob(clean_url, match)
    job.kind = kind
    job.text = text
    if kind == "files":
        job.files = parsed
    if kind == "sc_all":
        job.soundcloud = {"login": soundcloud_user(str(soundcloud["login"])), "liked": bool(soundcloud.get("liked")),
                          "playlists": list(soundcloud.get("playlists") or [])[:MAX_PLAYLISTS],
                          "artists": bool(soundcloud.get("artists"))}
    if yandex:
        job.yandex = {"login": str(yandex["login"]), "liked": bool(yandex.get("liked")),
                      "playlists": list(yandex.get("playlists") or [])[:MAX_PLAYLISTS],
                      "artists": bool(yandex.get("artists"))}
    with _jobs_lock:
        for old_id in [i for i, j in _jobs.items() if time.time() - j.created > 3600]:
            del _jobs[old_id]   # старые задачи больше не нужны
        _jobs[job.id] = job
    worker = {"spotify": _run_spotify, "yandex": _run_yandex, "apple": _run_apple, "deezer": _run_deezer,
              "text": _run_text, "youtube": _run_youtube, "soundcloud": _run_soundcloud,
              "yandex_all": _run_yandex_all, "files": _run_files, "sc_all": _run_sc_all}[kind]

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


def _set_entries(job: ImportJob, name: str, count: int, limit: int = MAX_TRACKS):
    with job.lock:
        job.name = name or "Импорт"
        job.total = min(count, limit)
        job.tracks = [None] * job.total
        if count > limit:
            job.note = f"В плейлисте {count} треков — импортированы первые {limit}"


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

def _match_items(job: ImportJob, search_fn, name: str, items: list[dict], limit: int = MAX_TRACKS):
    """items: [{"artist", "title", "duration" (секунды или None), "extra" — добавить к найденной паре}]"""
    _set_entries(job, name, len(items), limit)

    def one(i, item):
        if item.get("video_id"):   # номер видео YouTube (Google Takeout) — искать пару не нужно
            try:
                found = _youtube_by_id(search_fn, item["video_id"])
            except Exception:
                found = None
            if found:
                job.step(i, found)
            else:
                job.step(i, None, item.get("title") or item["video_id"], "видео удалено, закрыто или длиннее 20 минут")
            return
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
            if item.get("extra"):
                found = {**found, **item["extra"]}
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


YTM_FAST = {"quiet": True, "skip_download": True, "extractor_args": {"youtube": {"player_client": ["visionos"]}}}


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

    def info_of(video_id: str) -> dict | None:
        # Быстрый «клиент» visionos (без разгадывания скрипта YouTube): ~1,6 с вместо ~3 с; не вышло — обычный
        for opts in (YTM_FAST, {"quiet": True, "skip_download": True}):
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    return ydl.extract_info(f"https://music.youtube.com/watch?v={video_id}", download=False, process=False)
            except Exception:
                continue
        return None

    # Кандидатов проверяем одновременно: раньше по очереди — трек, которого «нет нигде», искался 10–13 с
    infos = list(_SEARCH_POOL.map(info_of, candidates[:2]))
    for video_id, info in zip(candidates[:2], infos):
        if not info:
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
    resp = _http.get(url, headers=UA, timeout=15)
    resp.raise_for_status()
    return resp.json()


# ---------- Spotify ----------

def _run_spotify(job: ImportJob, search_fn, max_duration: int):
    resp = _http.get(job.url, headers=UA, timeout=15)
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


# ---------- Вся медиатека Яндекс Музыки (переезд одним махом) ----------
# По логину из любой ссылки на профиль (…/users/<логин>/…) без входа видно «Мне нравится», плейлисты
# и любимых исполнителей — если человек не закрыл медиатеку. Сначала показываем, что нашлось
# (yandex_profile), человек отмечает нужное, потом одна задача ищет пары всем трекам разом
# (одинаковые треки из разных плейлистов — один раз) и раскладывает их по спискам.

YA_API = "https://api.music.yandex.net"
MAX_FULL = 3000      # треков за один переезд
MAX_PLAYLISTS = 100
YANDEX_CLOSED = ("Яндекс не показывает медиатеку этого пользователя: она закрыта или в ссылке ошибка. "
                 "Откройте Яндекс Музыку → ваш профиль → настройки приватности и разрешите показывать "
                 "медиатеку другим, перенесите музыку, а потом при желании снова закройте.")


def yandex_login(url: str) -> str | None:
    """Логин из ссылки на профиль/плейлист Яндекс Музыки (music.yandex.ru/users/<логин>/…) или сам логин."""
    text = url.strip()
    if re.fullmatch(r"[\w.@+-]{1,100}", text) and "yandex." not in text.lower().split("@")[0]:
        return text.split("@")[0]   # вписали логин (или почту на Яндексе — логин до «@»)
    parsed = urlparse(url.strip() if "://" in url else "https://" + url.strip())
    if not YANDEX_HOST.search(parsed.netloc.lower()):
        return None
    m = re.search(r"/users/([^/?#]+)", parsed.path)
    return m.group(1) if m else None


def _ya(path: str) -> dict | list:
    resp = _http.get(YA_API + path, headers=UA, timeout=15)
    if resp.status_code in (401, 403, 404):
        raise ValueError(YANDEX_CLOSED)
    resp.raise_for_status()
    return resp.json()["result"]


def _ya_playlists(login: str) -> list[dict]:
    own = [p for p in _ya(f"/users/{login}/playlists/list")
           if (p.get("owner") or {}).get("login", login) == login and p.get("kind") != 3 and p.get("trackCount")]
    return own[:MAX_PLAYLISTS]


def yandex_profile(login: str) -> dict:
    """Что можно перенести: сколько лайков, какие плейлисты, сколько исполнителей."""
    with ThreadPoolExecutor(3) as pool:
        likes = pool.submit(_ya, f"/users/{login}/likes/tracks")
        playlists = pool.submit(_ya_playlists, login)
        artists = pool.submit(_ya, f"/users/{login}/likes/artists")
        # Закрыто может быть что-то одно (например, только «Мне нравится») — остальное всё равно показываем
        def part(job, default):
            try:
                return job.result()
            except ValueError:
                return default
        liked = len((part(likes, {}).get("library") or {}).get("tracks") or [])
        lists = [{"kind": p["kind"], "title": p.get("title") or "Плейлист", "count": p.get("trackCount", 0),
                  "cover": "https://" + p["cover"]["uri"].replace("%%", "200x200")
                           if (p.get("cover") or {}).get("uri") else None}
                 for p in part(playlists, [])]
        try:
            artist_count = len(artists.result())
        except Exception:
            artist_count = 0
    if not liked and not lists and not artist_count:
        raise ValueError(YANDEX_CLOSED)
    return {"login": login, "liked": liked, "playlists": lists, "artists": artist_count}


def _ya_tracks(ids: list[dict]) -> list[dict]:
    """Полные данные треков по списку {id, albumId} (лайки отдаются только номерами) — по 200 за запрос."""
    out = []
    for i in range(0, len(ids), 200):
        chunk = ",".join(f"{t['id']}:{t['albumId']}" if t.get("albumId") else str(t["id"]) for t in ids[i:i + 200])
        resp = requests.post(f"{YA_API}/tracks", data={"track-ids": chunk}, headers=UA, timeout=20)
        resp.raise_for_status()
        out += resp.json()["result"]
    return out


def _yandex_full_item(t: dict) -> dict:
    """Трек для поиска пары + то, что Яндекс знает о нём: обложка альбома, исполнители со ссылками,
    альбом, metaId (как у трека «из базы» — Flow не повторит его и узнает исполнителя)."""
    item = _yandex_item(t)
    meta = artists_track(t)
    item["extra"] = {k: v for k, v in {
        "metaId": meta["id"], "artistId": meta["artistId"], "artistRefs": meta["artistRefs"],
        "album": meta["album"], "albumId": meta["albumId"], "cover": meta["cover"], "coverLarge": meta["coverLarge"],
    }.items() if v}
    return item


def _run_yandex_all(job: ImportJob, search_fn, max_duration: int):
    want = job.yandex
    login = want["login"]
    collections = []   # [{name, kind: liked|playlist, ids: [номер трека Яндекса]}]
    raw: dict[str, dict] = {}
    if want.get("liked"):
        try:
            likes = (_ya(f"/users/{login}/likes/tracks").get("library") or {}).get("tracks") or []
        except ValueError:   # «Мне нравится» закрыто — переносим остальное
            likes = []
        tracks = _ya_tracks(likes[:MAX_FULL])   # новые лайки — первыми, как в Яндексе
        collections.append({"name": "Мне нравится", "kind": "liked", "ids": [str(t["id"]) for t in tracks]})
        raw.update({str(t["id"]): t for t in tracks})
    kinds = {int(k) for k in want.get("playlists") or [] if str(k).isdigit()}
    for p in _ya_playlists(login):
        if p["kind"] not in kinds or job.cancelled:
            continue
        result = _ya(f"/users/{login}/playlists/{p['kind']}")
        tracks = [entry.get("track") or entry for entry in result.get("tracks") or []]
        tracks = [t for t in tracks if t.get("id") and t.get("title")]
        collections.append({"name": result.get("title") or p.get("title") or "Плейлист", "kind": "playlist",
                            "ids": [str(t["id"]) for t in tracks]})
        for t in tracks:
            raw.setdefault(str(t["id"]), t)
    if want.get("artists"):
        try:
            job.artists = [{"id": a["id"], "name": a["name"],
                            "picture": "https://" + a["cover"]["uri"].replace("%%", "200x200")
                                       if (a.get("cover") or {}).get("uri") else None}
                           for a in _ya(f"/users/{login}/likes/artists") if a.get("id") and a.get("name")]
        except Exception as e:
            print(f"[import] исполнители {login}: {e}")
    ids = list(raw)[:MAX_FULL]
    if len(raw) > MAX_FULL:
        job.note = f"Треков больше {MAX_FULL} — перенесены первые {MAX_FULL}"
    job.collections = collections
    job.order = ids
    _match_items(job, search_fn, "Яндекс Музыка", [_yandex_full_item(raw[i]) for i in ids], limit=MAX_FULL)


# ---------- Apple Music ----------

def _run_apple(job: ImportJob, search_fn, max_duration: int):
    resp = _http.get(job.url, headers=UA, timeout=15)
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
# Ещё — текст, скопированный со страницы музыки (VK, Яндекс, Spotify в браузере: Ctrl+A, Ctrl+C):
# там на трек несколько строк — название, исполнитель, длительность «3:45» отдельной строкой.

DURATION_LINE = re.compile(r"^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$")
# Надписи кнопок и пометки, которые попадают в копию страницы
PAGE_JUNK = re.compile(r"^(e|explicit|18\+|hq|lyrics|текст|добавить|ещё|еще|слушать|воспроизвести|поделиться|"
                       r"скачать|удалить|в плейлист|play|pause|more|add|\d+|[•·|–—-]+)$", re.I)


def _seconds(m) -> int:
    return int(m[1] or 0) * 3600 + int(m[2]) * 60 + int(m[3])


def _page_blocks(lines: list[str]) -> list[dict] | None:
    """Копия страницы: строки трека разделены длительностями. Нет такого — None (обычный список)."""
    durations = [i for i, line in enumerate(lines) if DURATION_LINE.match(line)]
    if len(durations) < 2 or len(durations) < len([x for x in lines if x.strip()]) / 6:
        return None
    meaningful = [i for i, line in enumerate(lines) if line.strip() and not PAGE_JUNK.match(line.strip())]
    # Где длительность: после строк трека (обычно) или перед ними. Перед — если с неё всё начинается
    # или после последней длительности ещё есть название и исполнитель
    head = len([i for i in meaningful if i < durations[0]])
    tail = len([i for i in meaningful if i > durations[-1]])
    starts = head == 0 or (tail >= 2 and head <= 1)
    groups: list[tuple[list[str], int]] = []   # (строки трека, длительность)
    block: list[str] = []
    pending = None   # длительность, которая стоит перед строками трека
    for line in lines:
        m = DURATION_LINE.match(line)
        if not m:
            text = line.strip()
            if text and not PAGE_JUNK.match(text):
                block.append(text)
            continue
        if starts:
            if pending is not None:
                groups.append((block, pending))
            pending = _seconds(m)
        else:
            groups.append((block, _seconds(m)))
        block = []
    if starts and pending is not None:
        groups.append((block, pending))
    out = []
    for block, seconds in groups:
        # Лишние строки (шапка страницы, подписи) — с той стороны, где нет длительности
        block = block[:2] if starts else block[-2:]
        if not block:
            continue
        if len(block) == 1:
            parts = re.split(r"\s+[-–—]\s+", block[0], maxsplit=1)
            out.append({"artist": parts[0], "title": parts[1], "either_order": True, "duration": seconds} if len(parts) == 2
                       else {"artist": "", "title": block[0], "duration": seconds})
        else:   # обычно «название», потом «исполнитель»; если наоборот — проверим по Яндексу и паре
            out.append({"artist": block[1], "title": block[0], "either_order": True, "duration": seconds})
    return out


def _run_text(job: ImportJob, search_fn, max_duration: int):
    lines = job.text.splitlines()
    items = _page_blocks(lines)
    if items:
        if _list_is_swapped(items):
            items = [{**it, "artist": it["title"], "title": it["artist"]} if it["artist"] else it for it in items]
        return _match_items(job, search_fn, "Импорт из списка", items)
    items = []
    for line in lines:
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
        # Вместо ответа Яндекс иногда присылает строку — тогда «не понять»
        results = found["result"]["tracks"]["results"][:5]
    except Exception:
        return None
    for t in results:
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


# ---------- Файлы из других сервисов ----------
# Spotify без входа отдаёт только открытые плейлисты и не больше 100 треков, «Любимые треки» — никак.
# Зато есть выгрузки: Exportify (CSV по плейлисту), официальная «Скачать мои данные» Spotify
# (YourLibrary.json — любимые треки, Playlist1.json — все плейлисты), Google Takeout YouTube/YouTube Music
# (CSV с номерами видео — пару искать не нужно), TuneMyMusic/Soundiiz и любой CSV с колонками
# «исполнитель» и «название». Каждый файл (или плейлист внутри файла) → свой список; «любимое» → в «Избранное».

MAX_FILES_BYTES = 8_000_000
LIKED_NAMES = re.compile(r"liked|понрав|любим|music library songs|yourlibrary|избранн|favou?rite", re.I)
YT_ID = re.compile(r"^[\w-]{11}$")
TITLE_COLS = ("track name", "song title", "title", "track", "song", "название", "название трека", "трек")
ARTIST_COLS = ("artist name(s)", "artist name", "artist names", "artist", "artists", "artist name 1",
               "исполнитель", "исполнители", "имя исполнителя")
VIDEO_COLS = ("video id", "идентификатор видео", "id видео")
PLAYLIST_COLS = ("playlist name", "playlist", "плейлист", "название плейлиста")


def _file_title(name: str) -> str:
    """«liked_songs.csv» → «liked songs», «Мой плейлист-videos.csv» → «Мой плейлист»."""
    base = re.sub(r"\.(csv|json|txt)$", "", (name or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1], flags=re.I)
    base = re.sub(r"[-_ ]?videos$", "", base, flags=re.I).replace("_", " ").strip()
    return base or "Импорт"


def _collection_kind(name: str) -> str:
    return "liked" if LIKED_NAMES.search(name or "") else "playlist"


def _csv_rows(text: str) -> tuple[list[str], list[list[str]]]:
    """Заголовок и строки CSV. В старых выгрузках Takeout перед таблицей есть «шапка» плейлиста —
    ищем строку, где есть колонка с названием трека или номером видео."""
    import csv
    import io
    rows = [r for r in csv.reader(io.StringIO(text.lstrip("﻿"))) if any(c.strip() for c in r)]
    # Сначала — строка с номером видео: в «шапке» старого Takeout есть колонка Title (это название плейлиста)
    for known in (set(VIDEO_COLS), set(TITLE_COLS)):
        for i, row in enumerate(rows[:20]):
            if {c.strip().lower() for c in row} & known:
                return [c.strip().lower() for c in row], rows[i + 1:]
    return [], rows


def _pick_col(header: list[str], names: tuple) -> int:
    return next((header.index(n) for n in names if n in header), -1)


def _parse_csv(name: str, text: str) -> list[dict]:
    """→ [{name, kind, items: [{artist, title, duration} | {video_id, title}]}]"""
    header, rows = _csv_rows(text)
    get = lambda row, i: row[i].strip() if 0 <= i < len(row) else ""
    vid, title, artist = _pick_col(header, VIDEO_COLS), _pick_col(header, TITLE_COLS), _pick_col(header, ARTIST_COLS)
    if vid < 0 and not header and rows and all(YT_ID.match(get(r, 0)) for r in rows[:5]):
        vid = 0   # таблица без заголовка, в первой колонке — номера видео
    # У YouTube Music исполнители разложены по колонкам «Artist Name 1», «Artist Name 2»…
    extra_artists = [i for i, c in enumerate(header) if re.fullmatch(r"artist name [2-9]", c)]
    duration = _pick_col(header, ("duration (ms)", "duration_ms"))
    duration_sec = _pick_col(header, ("duration", "длительность"))
    playlist = _pick_col(header, PLAYLIST_COLS)
    if vid < 0 and title < 0:
        raise ValueError(f"«{name}»: не нашёл колонок с названием трека или номером видео")
    groups: dict[str, list[dict]] = {}
    for row in rows:
        group = get(row, playlist) or _file_title(name)
        if vid >= 0 and YT_ID.match(get(row, vid)):
            item = {"video_id": get(row, vid), "title": get(row, title)}
        elif title >= 0 and get(row, title):
            who = ", ".join(a for a in [get(row, artist)] + [get(row, i) for i in extra_artists] if a)
            seconds = None
            if duration >= 0 and get(row, duration).isdigit():
                seconds = int(get(row, duration)) / 1000
            elif duration_sec >= 0 and (m := re.fullmatch(r"(?:(\d+):)?(\d+):(\d\d)", get(row, duration_sec))):
                seconds = int(m[1] or 0) * 3600 + int(m[2]) * 60 + int(m[3])
            item = {"artist": who, "title": get(row, title), "duration": seconds}
        else:
            continue
        groups.setdefault(group, []).append(item)
    return [{"name": g, "kind": _collection_kind(g if playlist >= 0 else name), "items": items}
            for g, items in groups.items()]


def _parse_json(name: str, text: str) -> list[dict]:
    """Официальная выгрузка Spotify: YourLibrary.json (любимые треки) и Playlist*.json (все плейлисты)."""
    data = json.loads(text.lstrip("﻿"))
    out = []
    if isinstance(data, dict) and isinstance(data.get("tracks"), list):
        items = [{"artist": str(t.get("artist") or ""), "title": str(t.get("track") or "")}
                 for t in data["tracks"] if isinstance(t, dict) and t.get("track")]
        out.append({"name": "Любимые треки", "kind": "liked", "items": items})
    if isinstance(data, dict) and isinstance(data.get("playlists"), list):
        for p in data["playlists"]:
            if not isinstance(p, dict):
                continue
            items = []
            for entry in p.get("items") or []:
                t = (entry or {}).get("track") if isinstance(entry, dict) else None
                if isinstance(t, dict) and t.get("trackName"):
                    items.append({"artist": str(t.get("artistName") or ""), "title": str(t["trackName"])})
            if items:
                out.append({"name": str(p.get("name") or "Плейлист"), "kind": "playlist", "items": items})
    if not out:
        raise ValueError(f"«{name}»: это не выгрузка Spotify (нужны YourLibrary.json или Playlist1.json)")
    return out


MAX_ZIP_BYTES = 40_000_000


def _unzip(name: str, data: str) -> list[dict]:
    """Архив Exportify или Google Takeout (base64) → его .csv/.json. Из Takeout берём только плейлисты и
    музыку: там же лежат подписки, комментарии и список своих видео — их в плейлисты превращать не надо."""
    import base64
    import zipfile
    raw = base64.b64decode(data, validate=False)
    if len(raw) > MAX_ZIP_BYTES:
        raise ValueError(f"«{name}»: архив слишком большой. В Google Takeout выберите только «YouTube и YouTube Music» → «Плейлисты»")
    out, total = [], 0
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise ValueError(f"«{name}»: архив повреждён")
    for info in archive.infolist():
        path = info.filename.replace("\\", "/")
        low = path.lower()
        if info.is_dir() or not low.endswith((".csv", ".json")) or info.file_size > 6_000_000:
            continue
        # Takeout/<«YouTube и YouTube Music»>/<папка>/файл — смотрим на папку и имя, а не на название сервиса
        inner = "/".join(low.split("/")[2:]) if low.startswith("takeout/") else low
        if low.startswith("takeout/") and not re.search(r"playlist|плейлист|music library|музык", inner):
            continue
        total += info.file_size
        if total > MAX_FILES_BYTES:
            break
        out.append({"name": path.rsplit("/", 1)[-1], "text": archive.read(info).decode("utf-8", "replace")})
    return out


def parse_files(files: list) -> list[dict]:
    """Файлы со страницы [{name, text} или {name, zip: base64}] → списки треков.
    Ошибка — если ни один файл не подошёл."""
    if not isinstance(files, list) or not files:
        raise ValueError("Выберите файл")
    if sum(len(str((f or {}).get("text", ""))) for f in files if isinstance(f, dict)) > MAX_FILES_BYTES:
        raise ValueError("Файлы слишком большие — выберите поменьше за раз")
    collections, errors = [], []
    unpacked = []
    for f in files[:200]:
        if isinstance(f, dict) and f.get("zip"):
            try:
                unpacked += _unzip(str(f.get("name") or "архив"), str(f["zip"]))
            except ValueError as e:
                errors.append(str(e))
        else:
            unpacked.append(f)
    for f in unpacked[:500]:
        if not isinstance(f, dict):
            continue
        name, text = str(f.get("name") or "файл"), str(f.get("text") or "")
        try:
            found = _parse_json(name, text) if name.lower().endswith(".json") else _parse_csv(name, text)
            collections += [c for c in found if c["items"]]
        except json.JSONDecodeError:   # (сам он тоже ValueError — проверяем первым)
            errors.append(f"«{name}»: файл повреждён")
        except ValueError as e:
            errors.append(str(e))
    if not collections:
        raise ValueError(errors[0] if errors else "В файлах нет ни одного трека")
    return collections


def _file_key(item: dict) -> str:
    if item.get("video_id"):
        return "yt:" + item["video_id"]
    return f"{_norm(item.get('artist', ''))}|{_norm(item.get('title', ''))}"


def _run_files(job: ImportJob, search_fn, max_duration: int):
    unique: dict[str, dict] = {}
    collections = []
    for c in job.files:
        keys = []
        for item in c["items"]:
            key = _file_key(item)
            if key.strip("|"):
                unique.setdefault(key, item)
                keys.append(key)
        collections.append({"name": c["name"], "kind": c["kind"], "ids": keys})
    ids = list(unique)[:MAX_FULL]
    if len(unique) > MAX_FULL:
        job.note = f"Треков больше {MAX_FULL} — перенесены первые {MAX_FULL}"
    job.collections = collections
    job.order = ids
    _match_items(job, search_fn, collections[0]["name"] if len(collections) == 1 else "Импорт из файлов",
                 [unique[k] for k in ids], limit=MAX_FULL)


def _youtube_by_id(search_fn, video_id: str) -> dict | None:
    """Видео YouTube по номеру (из Takeout): поиск по номеру отдаёт само видео — с названием и длительностью."""
    for t in search_fn("youtube", video_id, 3):
        if t.get("id") == video_id:
            return t
    return None


# ---------- Переезд со SoundCloud (по нику) ----------
# Открытый профиль SoundCloud без входа отдаёт лайки, плейлисты и подписки. Звук там же — пару искать
# не нужно: треки сразу настоящие. Подписки → «Мои исполнители» (id вида «sc:<номер>») и вкус Flow.
# SC_API(path, **params) и SC_ART(id, url) подставляет app.py (ключ SoundCloud, обход блокировок, обложки).

SC_API = None
SC_ART = None
SC_RESERVED = {"discover", "search", "stream", "you", "charts", "upload", "messages", "settings", "pages",
               "people", "tags", "terms-of-use", "jobs", "mobile", "popular", "signin", "logout", "notifications"}
SC_CLOSED = ("SoundCloud не нашёл такой профиль. Откройте soundcloud.com, нажмите на свой аватар → «Profile» "
             "и скопируйте ссылку из адресной строки — вида soundcloud.com/ваш-ник.")
MAX_SC_FOLLOWINGS = 300


def soundcloud_user(url: str) -> str | None:
    """Ник из ссылки на профиль (или из любой ссылки внутри профиля), или сам ник."""
    text = (url or "").strip()
    m = re.match(r"^(?:https?://)?(?:www\.|m\.)?soundcloud\.com/([\w-]+)", text, re.I)
    nick = m[1] if m else text if re.fullmatch(r"[\w-]{2,100}", text) else None
    return nick if nick and nick.lower() not in SC_RESERVED else None


def _sc_pages(path: str, limit: int, **params) -> list[dict]:
    """Все страницы списка SoundCloud (next_href), но не больше limit записей."""
    out = []
    data = SC_API(path, limit=min(200, limit), linked_partitioning=1, **params)
    while True:
        out += data.get("collection") or []
        nxt = data.get("next_href")
        if not nxt or len(out) >= limit:
            return out[:limit]
        data = SC_API(nxt)


def soundcloud_profile(nick: str) -> dict:
    try:
        user = SC_API("/resolve", url=f"https://soundcloud.com/{nick}")
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 404:
            raise ValueError(SC_CLOSED)
        raise
    if user.get("kind") != "user":
        raise ValueError("Это ссылка не на профиль, а на трек или плейлист. Нужна ссылка вида soundcloud.com/ваш-ник")
    playlists = []
    for p in _sc_pages(f"/users/{user['id']}/playlists_without_albums", MAX_PLAYLISTS):
        if p.get("track_count"):
            playlists.append({"id": p["id"], "title": p.get("title") or "Плейлист", "count": p["track_count"],
                              "cover": p.get("artwork_url") or ((p.get("tracks") or [{}])[0] or {}).get("artwork_url")})
    return {"login": user.get("permalink") or nick, "name": user.get("username") or nick,
            "avatar": user.get("avatar_url"), "liked": user.get("likes_count") or 0,
            "playlists": playlists, "artists": min(user.get("followings_count") or 0, MAX_SC_FOLLOWINGS)}


def _sc_full_tracks(ids: list) -> dict:
    """Полные данные треков по номерам: у плейлистов SoundCloud отдаёт целиком только первые несколько."""
    out = {}
    for i in range(0, len(ids), 50):
        for t in SC_API("/tracks", ids=",".join(str(x) for x in ids[i:i + 50])) or []:
            out[t["id"]] = t
    return out


def _sc_track(t: dict, max_duration: int) -> tuple[dict | None, str]:
    """Трек SoundCloud из API → трек Sono (или None и причина)."""
    protocols = {x.get("format", {}).get("protocol", "") for x in (t.get("media") or {}).get("transcodings") or []}
    if t.get("policy") == "BLOCK" or not t.get("streamable", True):
        return None, "недоступен в вашей стране"
    if protocols and all("encrypted" in p for p in protocols):
        return None, "защищён от копирования (DRM)"
    if t.get("policy") == "SNIP":   # без подписки Go+ — только 30-секундный отрывок
        return None, "на SoundCloud — только отрывок (нужна подписка)"
    duration = (t.get("duration") or 0) / 1000
    if not duration or duration > max_duration:
        return None, f"длиннее {max_duration // 60} минут"
    art = t.get("artwork_url") or (t.get("user") or {}).get("avatar_url")
    if art and SC_ART:
        SC_ART(str(t["id"]), art)
    return {"source": "soundcloud", "id": str(t["id"]), "title": t.get("title"),
            "channel": (t.get("user") or {}).get("username"), "duration": duration,
            "plays": t.get("playback_count"), "likes": t.get("likes_count")}, ""


def _run_sc_all(job: ImportJob, search_fn, max_duration: int):
    want = job.soundcloud
    user = SC_API("/resolve", url=f"https://soundcloud.com/{want['login']}")
    uid = user["id"]
    collections, raw = [], {}
    if want.get("liked"):
        likes = [x["track"] for x in _sc_pages(f"/users/{uid}/track_likes", MAX_FULL) if x.get("track")]
        collections.append({"name": "Лайки SoundCloud", "kind": "liked", "ids": [t["id"] for t in likes]})
        raw.update({t["id"]: t for t in likes})
    chosen = {int(x) for x in want.get("playlists") or [] if str(x).isdigit()}
    for p in _sc_pages(f"/users/{uid}/playlists_without_albums", MAX_PLAYLISTS):
        if p.get("id") not in chosen or job.cancelled:
            continue
        ids = [t["id"] for t in p.get("tracks") or [] if t.get("id")]
        collections.append({"name": p.get("title") or "Плейлист", "kind": "playlist", "ids": ids})
        for t in p.get("tracks") or []:
            if t.get("id") and t.get("title"):
                raw.setdefault(t["id"], t)
        for i in ids:
            raw.setdefault(i, None)   # дочитаем ниже
    if want.get("artists"):
        try:
            job.artists = [{"id": f"sc:{a['id']}", "name": a.get("username"), "picture": a.get("avatar_url")}
                           for a in _sc_pages(f"/users/{uid}/followings", MAX_SC_FOLLOWINGS) if a.get("username")]
        except Exception as e:
            print(f"[import] подписки SoundCloud {want['login']}: {e}")
    order = list(raw)[:MAX_FULL]
    if len(raw) > MAX_FULL:
        job.note = f"Треков больше {MAX_FULL} — перенесены первые {MAX_FULL}"
    missing = [i for i in order if not raw.get(i)]
    if missing:
        raw.update(_sc_full_tracks(missing))
    job.collections = [{**c, "ids": [str(i) for i in c["ids"]]} for c in collections]
    job.order = [str(i) for i in order]
    _set_entries(job, user.get("username") or "SoundCloud", len(order), MAX_FULL)
    fallback = []   # защищённые (DRM), закрытые в стране и отрывки — ищем ту же песню на YouTube
    for i, tid in enumerate(order[:job.total]):
        t = raw.get(tid)
        if not t:
            job.step(i, None, str(tid), "трек удалён или закрыт")
            continue
        track, reason = _sc_track(t, max_duration)
        if track:
            job.step(i, track)
        elif "DRM" in reason or "стране" in reason or "отрывок" in reason:
            fallback.append((i, t, reason))
        else:
            job.step(i, None, t.get("title") or str(tid), reason)

    def pair(_, item):
        i, t, reason = item
        # У крупных лейблов исполнитель — в metadata, а загрузил трек лейбл
        artist = (t.get("publisher_metadata") or {}).get("artist") or (t.get("user") or {}).get("username") or ""
        title = t.get("title") or ""
        try:
            found = _find_pair("youtube", search_fn, artist, title, (t.get("duration") or 0) / 1000 or None)
        except Exception:
            found = None
        if found:
            job.step(i, {**found, "artists": artist, "origTitle": title})
        else:
            job.step(i, None, title, reason + ", на YouTube не нашёлся")

    _parallel(job, fallback, pair)
