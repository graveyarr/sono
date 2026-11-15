"""Ссылки из других сервисов в строке поиска: Spotify, Яндекс Музыка, Apple Music, Deezer, YouTube, SoundCloud.

describe(url) → что это и что с ним делать:
  {"kind": "track",  "track": {...}}            — трек: из базы Яндекса (звук найдётся при включении)
                                                   или сразу настоящий с YouTube/SoundCloud;
  {"kind": "album",  "albumId", "name", ...}     — альбом, который точно есть в Яндексе: откроем его страницу;
  {"kind": "artist", "id", "name", "picture"}    — исполнитель (Яндекс или SoundCloud «sc:<номер>»);
  {"kind": "list",   "name", "count", "url"}      — плейлист (или альбом, которого нет в Яндексе): перенести импортом;
  {"kind": "search", "query"}                    — не уверены, что нашли того же исполнителя: обычный поиск по имени.
Сомнительное не подставляем: «тот же» трек — то же название, исполнитель и версия (ремикс ≠ оригинал), длина ±12 с;
альбом — то же название у того же исполнителя; исполнитель — совпали песни, а не только имя.
Ошибка — ValueError с понятным текстом.
"""
import json
import re
from urllib.parse import parse_qs, urlparse

import requests

import artists
import importer

_http = requests.Session()
UA = importer.UA

SHORT_HOSTS = ("spotify.link", "spoti.fi", "link.deezer.com", "deezer.page.link", "on.soundcloud.com",
               "music.apple.co", "apple.co")
LINK_HOSTS = re.compile(r"(^|\.)(spotify\.com|spotify\.link|spoti\.fi|music\.yandex\.(ru|com|by|kz|uz)|"
                        r"music\.apple\.com|music\.apple\.co|apple\.co|deezer\.com|deezer\.page\.link|"
                        r"youtube\.com|youtu\.be|soundcloud\.com|vk\.com|vk\.ru|boom\.ru)$", re.I)

# Слова версии: если есть в одном названии и нет в другом — это разные записи
VERSION_WORDS = ("remix", "ремикс", "live", "концерт", "acoustic", "акуст", "sped", "speed up", "slowed",
                 "instrumental", "инструментал", "remaster", "demo", "демо", "edit", "version", "версия", "mix",
                 "cover", "кавер", "karaoke", "nightcore", "reverb", "rework", "vip", "bootleg")


def is_link(text: str) -> bool:
    text = (text or "").strip()
    if text.startswith("spotify:"):
        return True
    if not re.match(r"^(https?://)?[\w.-]+\.[a-z]{2,}/\S*$", text, re.I) or " " in text:
        return False
    host = urlparse(text if "://" in text else "https://" + text).netloc.lower().split(":")[0]
    return bool(LINK_HOSTS.search(host))


def _get(url: str, **params) -> requests.Response:
    resp = _http.get(url, params=params or None, headers=UA, timeout=12)
    if resp.status_code in (400, 404, 410):
        raise ValueError("По ссылке ничего нет — возможно, её удалили или в ней опечатка")
    resp.raise_for_status()
    return resp


def _bare(title: str) -> str:
    return artists._norm(re.sub(r"\s*[(\[].*?[)\]]", "", title or "").split(" - ")[0])


def _versions(title: str) -> set[str]:
    low = (title or "").lower()
    return {w for w in VERSION_WORDS if re.search(rf"(?<!\w){re.escape(w)}", low)}


def _album_title(name: str) -> str:
    """Название альбома для сравнения: без « - Single», «(feat. …)», но скобки с версией («(Remix)», «(Deluxe)»)
    остаются — сингл-ремикс не должен открыть обычный сингл."""
    name = re.sub(r"\s+-\s+(single|ep)$", "", name or "", flags=re.I)
    name = re.sub(r"\s*[(\[](feat\.?|ft\.?|with) [^)\]]*[)\]]", "", name, flags=re.I)
    return artists._norm(name)


_latin = importer.latin   # «Монеточка» → «monetochka» (общая с поиском пар)


def _latin_match(artist: str, title: str, duration: float | None):
    """Исполнитель в ссылке латиницей, а в Яндексе — по-русски: ищем по названию и сверяем имя «на латинице»."""
    first = re.split(r",| feat\.? | ft\.? | & ", artist or "", flags=re.I)[0]
    want = re.sub(r"[^a-z0-9]", "", first.lower())
    if not want or not re.fullmatch(r"[\x00-\x7f]+", first):
        return None
    name = _bare(title)
    for t in artists._search(title, "track")[:10]:
        if _bare(t.get("title")) != name or not t.get("albums"):
            continue
        if any(want in _latin(a.get("name")) for a in t.get("artists") or []):
            got = (t.get("durationMs") or 0) / 1000
            if duration and got and abs(got - float(duration)) > 12:
                continue
            album = next((al for al in t["albums"] if al.get("type") != "compilation"), t["albums"][0])
            return t, album
    return None


# ---------- Что получилось ----------

def _track_result(artist: str, title: str, duration: float | None, search_fn) -> dict:
    """Трек по «исполнитель — название»: сначала база Яндекса (обложка, альбом), иначе сразу пара на YouTube/SoundCloud."""
    if not title:
        raise ValueError("Сервис не отдал название трека")
    found = artists.match_track(artist, title, duration) or _latin_match(artist, title, duration)
    if found:
        t, album = found
        got = (t.get("durationMs") or 0) / 1000
        ya_title = (t.get("title") or "") + (f" ({t['version']})" if t.get("version") else "")
        same_version = _versions(ya_title) == _versions(title)
        same_length = not (duration and got) or abs(got - float(duration)) <= 12
        if same_version and same_length:
            return {"kind": "track", "track": artists._track(t, album)}
    why: dict = {}
    real = importer._find_pair("auto", search_fn, artist, title, duration, why)
    if real:
        return {"kind": "track", "track": {**real, "artists": artist, "origTitle": title}}
    if why.get("drm"):
        raise ValueError(f"«{artist} — {title}» есть только на SoundCloud, и там он защищён от копирования (DRM)")
    raise ValueError(f"«{artist} — {title}» не нашёлся ни на YouTube, ни на SoundCloud")


def _album_result(name: str, artist: str, items: list[dict], url: str, service: str) -> dict:
    """Альбом из другого сервиса: есть такой же в Яндексе — откроем его страницу, нет — предложим перенести."""
    want = _album_title(name)
    for item in items[:3]:   # первый трек бывает интро с другим названием в Яндексе — пробуем три
        found = artists.match_track(artist, item.get("title") or "", item.get("duration"))
        if found and _album_title(found[1].get("title")) == want:
            album = found[1]
            return {"kind": "album", "albumId": str(album["id"]), "name": album.get("title") or name,
                    "artist": artist, "cover": artists._img(album.get("coverUri"), "200x200"), "service": service}
    return {"kind": "list", "what": "альбом", "name": name, "artist": artist, "count": len(items) or None,
            "url": url, "service": service}


def _artist_result(name: str, titles: list[str], service: str) -> dict:
    """Исполнитель: в Яндексе тёзок много, поэтому нужны общие песни (хотя бы одна из популярных)."""
    want = {_bare(t) for t in titles if len(_bare(t)) >= 2}
    best, best_hits = None, 0
    for a in artists.search_artists(name, limit=5):
        if not (artists._same_name(a.get("name"), name) or re.sub(r"[^a-z0-9]", "", name.lower()) in _latin(a.get("name"))):
            continue
        if not want:
            continue
        top = artists._get(f"{artists.YANDEX}/artists/{a['id']}/tracks", {"page": 0, "page-size": 100})
        have = {_bare(t.get("title")) for t in ((top.get("result") or {}).get("tracks") or [])}
        hits = len(want & have)
        if hits > best_hits:
            best, best_hits = a, hits
    if best:
        return {"kind": "artist", "id": best["id"], "name": best["name"], "picture": best.get("picture"), "service": service}
    return {"kind": "search", "query": name, "service": service}


def _list_result(url: str, service: str, name: str | None = None, count: int | None = None, what: str = "плейлист") -> dict:
    return {"kind": "list", "what": what, "name": name, "count": count, "url": url, "service": service}


# ---------- Сервисы ----------

def _spotify(url: str, search_fn) -> dict:
    m = importer.SPOTIFY_RE.search(url) or re.search(r"open\.spotify\.com/(?:intl-[a-z-]+/)?(artist)/([A-Za-z0-9]{10,40})", url)
    if not m:
        raise ValueError("Такую ссылку Spotify Sono не понимает — нужна ссылка на трек, альбом, плейлист или исполнителя")
    kind, sid = m.group(1), m.group(2)
    page = _get(f"https://open.spotify.com/embed/{kind}/{sid}").text
    data = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.+?)</script>', page)
    try:
        entity = json.loads(data.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (AttributeError, KeyError, TypeError, ValueError):
        raise ValueError("Spotify не отдал данные — возможно, плейлист закрыт или ссылка неверная") from None
    name = entity.get("name") or entity.get("title") or ""
    tracks = [{"title": t.get("title"), "artist": t.get("subtitle"), "duration": (t.get("duration") or 0) / 1000 or None}
              for t in entity.get("trackList") or []]
    if kind == "track":
        artist = ", ".join(a.get("name", "") for a in entity.get("artists") or [])
        return _track_result(artist, name, (entity.get("duration") or 0) / 1000 or None, search_fn)
    if kind == "album":
        return _album_result(name, entity.get("subtitle") or "", tracks, url, "Spotify")
    if kind == "artist":
        return _artist_result(name, [t["title"] for t in tracks], "Spotify")
    return _list_result(url, "Spotify", name, len(tracks) or None)


def _yandex(url: str, path: str, search_fn) -> dict:
    if m := re.search(r"/track/(\d+)", path):
        res = artists._get(f"{artists.YANDEX}/tracks/{m.group(1)}").get("result") or []
        if not res or not res[0].get("title") or res[0].get("error"):
            raise ValueError("В Яндекс Музыке такого трека нет — возможно, его удалили")
        return {"kind": "track", "track": artists._track(res[0])}
    if m := re.search(r"/album/(\d+)", path):
        album = artists._get(f"{artists.YANDEX}/albums/{m.group(1)}").get("result") or {}
        if not album.get("id"):
            raise ValueError("В Яндекс Музыке такого альбома нет — возможно, его удалили")
        return {"kind": "album", "albumId": str(album["id"]), "name": album.get("title"),
                "artist": ", ".join(a.get("name", "") for a in album.get("artists") or []),
                "cover": artists._img(album.get("coverUri"), "200x200"), "service": "Яндекс Музыка"}
    if m := re.search(r"/artist/(\d+)", path):
        info = (artists._get(f"{artists.YANDEX}/artists/{m.group(1)}/brief-info").get("result") or {}).get("artist") or {}
        if not info.get("id"):
            raise ValueError("В Яндекс Музыке такого исполнителя нет")
        card = artists._artist_card(info)
        return {"kind": "artist", "id": card["id"], "name": card["name"], "picture": card.get("picture"), "service": "Яндекс Музыка"}
    if "/playlists/" in path:
        _, api = importer.detect(url)
        res = artists._get(api).get("result") or {}
        return _list_result(url, "Яндекс Музыка", res.get("title"), res.get("trackCount"))
    raise ValueError("Такую ссылку Яндекс Музыки Sono не понимает — нужна ссылка на трек, альбом, плейлист или исполнителя")


def _itunes(country: str, **params) -> list[dict]:
    return _get("https://itunes.apple.com/lookup", country=country, **params).json().get("results") or []


def _apple(url: str, parsed, search_fn) -> dict:
    parts = [p for p in parsed.path.split("/") if p]
    country = parts[0] if parts and len(parts[0]) == 2 else "us"
    song = parse_qs(parsed.query).get("i", [None])[0]
    if not song and "song" in parts:
        song = parts[-1]
    if song and song.isdigit():
        res = [r for r in _itunes(country, id=song) if r.get("wrapperType") == "track"]
        if not res:
            raise ValueError("Apple Music не отдал этот трек — возможно, его нет в этой стране")
        t = res[0]
        return _track_result(t.get("artistName") or "", t.get("trackName") or "", (t.get("trackTimeMillis") or 0) / 1000 or None, search_fn)
    if "album" in parts and parts[-1].isdigit():
        res = _itunes(country, id=parts[-1], entity="song")
        head = next((r for r in res if r.get("wrapperType") == "collection"), None)
        if not head:
            raise ValueError("Apple Music не отдал этот альбом")
        items = [{"title": r.get("trackName"), "duration": (r.get("trackTimeMillis") or 0) / 1000 or None}
                 for r in res if r.get("wrapperType") == "track"]
        return _album_result(head.get("collectionName") or "", head.get("artistName") or "", items, url, "Apple Music")
    if "artist" in parts and parts[-1].isdigit():
        res = _itunes(country, id=parts[-1], entity="song", limit=25)
        head = next((r for r in res if r.get("wrapperType") == "artist"), None)
        if not head:
            raise ValueError("Apple Music не отдал этого исполнителя")
        return _artist_result(head.get("artistName") or "", [r.get("trackName") or "" for r in res if r.get("wrapperType") == "track"], "Apple Music")
    if "playlist" in parts:
        return _list_result(url, "Apple Music")
    raise ValueError("Такую ссылку Apple Music Sono не понимает — нужна ссылка на трек, альбом, плейлист или исполнителя")


def _deezer(url: str, path: str, search_fn) -> dict:
    m = re.search(r"/(track|album|playlist|artist)/(\d+)", path)
    if not m:
        raise ValueError("Такую ссылку Deezer Sono не понимает — нужна ссылка на трек, альбом, плейлист или исполнителя")
    kind, did = m.groups()
    info = _get(f"{artists.DEEZER}/{kind}/{did}").json()
    if info.get("error"):
        raise ValueError("В Deezer такого нет — возможно, удалили или ссылка неверная")
    if kind == "track":
        return _track_result((info.get("artist") or {}).get("name") or "", info.get("title") or "", info.get("duration"), search_fn)
    if kind == "album":
        items = [{"title": t.get("title"), "duration": t.get("duration")} for t in (info.get("tracks") or {}).get("data") or []]
        return _album_result(info.get("title") or "", (info.get("artist") or {}).get("name") or "", items, url, "Deezer")
    if kind == "artist":
        top = _get(f"{artists.DEEZER}/artist/{did}/top", limit=25).json().get("data") or []
        return _artist_result(info.get("name") or "", [t.get("title") or "" for t in top], "Deezer")
    return _list_result(url, "Deezer", info.get("title"), info.get("nb_tracks"))


def _youtube(url: str, parsed, track_fn) -> dict:
    query = parse_qs(parsed.query)
    if parsed.netloc.endswith("youtu.be") or query.get("v") or re.match(r"/(shorts|live|embed)/", parsed.path):
        return {"kind": "track", "track": track_fn(url)}
    if query.get("list"):
        return _list_result(url, "YouTube")
    raise ValueError("Такую ссылку YouTube Sono не понимает — нужна ссылка на видео или плейлист")


def _soundcloud(url: str, parsed, track_fn, sc_resolve) -> dict:
    parts = [p for p in parsed.path.split("/") if p]
    if not parts:
        raise ValueError("Это главная страница SoundCloud — нужна ссылка на трек, плейлист или артиста")
    if len(parts) >= 3 and parts[1] == "sets":
        try:   # название и сколько треков — для карточки
            data = sc_resolve(f"https://soundcloud.com/{'/'.join(parts[:3])}")
        except Exception:
            data = {}
        what = "альбом" if data.get("is_album") else "плейлист"
        return _list_result(url, "SoundCloud", data.get("title"), data.get("track_count"), what)
    if len(parts) == 1 or parts[1] in ("tracks", "albums", "popular-tracks", "reposts", "likes", "followers", "following", "sets"):
        data = sc_resolve(f"https://soundcloud.com/{parts[0]}")
        if data.get("kind") != "user":
            raise ValueError("На SoundCloud такого артиста нет")
        return {"kind": "artist", "id": f"sc:{data['id']}", "name": data.get("username") or parts[0],
                "picture": data.get("avatar_url"), "service": "SoundCloud"}
    return {"kind": "track", "track": track_fn(url)}


def describe(url: str, search_fn, track_fn, sc_resolve) -> dict:
    """search_fn — поиск app.search, track_fn — трек YouTube/SoundCloud по ссылке, sc_resolve — /resolve SoundCloud."""
    url = url.strip()
    if url.startswith("spotify:"):
        return _spotify(url, search_fn)
    if "://" not in url:
        url = "https://" + url
    parsed = urlparse(url)
    host = parsed.netloc.lower().split(":")[0]
    if host.endswith(SHORT_HOSTS):   # короткая ссылка — узнаём, куда ведёт
        try:
            url = _http.get(url, headers=UA, timeout=12, allow_redirects=True).url
        except requests.RequestException:
            raise ValueError("Короткая ссылка не открылась — попробуйте полную") from None
        parsed = urlparse(url)
        host = parsed.netloc.lower().split(":")[0]
    if host.endswith("spotify.com"):
        if parsed.path.strip("/") in ("", "embed"):
            raise ValueError("Короткая ссылка Spotify никуда не ведёт — возможно, она устарела")
        return _spotify(url, search_fn)
    if importer.YANDEX_HOST.search(host):
        return _yandex(url, parsed.path, search_fn)
    if host.endswith("music.apple.com"):
        return _apple(url, parsed, search_fn)
    if host.endswith("deezer.com"):
        return _deezer(url, parsed.path, search_fn)
    if host.endswith("youtube.com") or host.endswith("youtu.be"):
        return _youtube(url, parsed, track_fn)
    if host.endswith("soundcloud.com"):
        return _soundcloud(url, parsed, track_fn, sc_resolve)
    if host.endswith(("vk.com", "vk.ru", "boom.ru")):
        raise ValueError("VK не отдаёт музыку без входа в аккаунт. Откройте плейлист в VK, выделите список "
                         "(Ctrl+A, Ctrl+C) и вставьте его в «Импорт → Списком»")
    raise ValueError("Ссылки с этого сайта Sono пока не понимает")
