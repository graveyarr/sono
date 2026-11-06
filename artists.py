"""Исполнители и альбомы: фото, популярные треки, дискография, похожие, биография.

Основной источник — Яндекс Музыка (открытый API без ключей): у неё есть всё, включая фото
и обложки, которые открываются из России. Deezer дополняет дискографию релизами, которых
нет в Яндексе (у андеграунда их бывает много), — но его картинки из России не открываются (403),
поэтому такие релизы показываются без обложки.

Здесь только сведения о музыке. Самого звука у этих треков нет: при включении плеер
ищет пару на YouTube или SoundCloud (/api/resolve в app.py).
Ответы кэшируются на диске на сутки — повторное открытие страницы мгновенное.
"""
import hashlib
import json
import re
import time
from pathlib import Path

import requests

YANDEX = "https://api.music.yandex.net"
DEEZER = "https://api.deezer.com"
UA = {"User-Agent": "Sono/0.2 (open-source desktop music player)"}
TTL = 24 * 3600
_dir: Path | None = None


def init(cache_dir: Path) -> None:
    global _dir
    _dir = cache_dir / "meta"
    _dir.mkdir(parents=True, exist_ok=True)


def _get(url: str, params: dict | None = None) -> dict:
    """GET с кэшем на диске на сутки."""
    key = hashlib.sha1(f"{url}?{json.dumps(params or {}, sort_keys=True)}".encode()).hexdigest()
    path = _dir / f"{key}.json"
    try:
        if time.time() - path.stat().st_mtime < TTL:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("_notFound"):
                raise LookupError("не найдено")
            return data
    except (OSError, ValueError):
        pass
    resp = requests.get(url, params=params, headers=UA, timeout=12)
    if resp.status_code == 404:
        # «Нет такой страницы» тоже запоминаем: иначе, например, у исполнителя без статьи в Википедии
        # каждое открытие страницы заново ждало три ответа «не найдено» (2–4 с)
        path.write_text(json.dumps({"_notFound": True}), encoding="utf-8")
        raise LookupError("не найдено")
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and data.get("error"):
        raise LookupError(str(data["error"]))
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", " ", (text or "").lower().replace("ё", "е")).strip()


def _img(uri: str | None, size: str) -> str | None:
    """Картинка Яндекса: в адресе вместо «%%» ставится размер (200x200, 400x400, 1000x1000…)."""
    return "https://" + uri.replace("%%", size) if uri else None


# ---------- Превращаем ответы Яндекса в то, что понимает страница ----------

def _track(t: dict, album: dict | None = None) -> dict:
    """Трек из базы. source=meta: звука нет, его найдут при включении."""
    album = album or (t.get("albums") or [{}])[0]
    title = t.get("title") or ""
    if t.get("version"):
        title += f" ({t['version']})"
    people = t.get("artists") or []
    names = ", ".join(a.get("name", "") for a in people)
    cover = t.get("coverUri") or album.get("coverUri")
    return {
        "source": "meta", "id": f"ya{t['id']}",
        "title": title, "origTitle": title, "artists": names, "channel": names,
        "artistId": people[0].get("id") if people else None,
        # Все исполнители с id — чтобы у «A, B» каждое имя вело на свою страницу
        "artistRefs": [{"id": a.get("id"), "name": a.get("name", "")} for a in people],
        "duration": round((t.get("durationMs") or 0) / 1000) or None,
        "cover": _img(cover, "200x200"), "coverLarge": _img(cover, "600x600"),
        "album": album.get("title"), "albumId": album.get("id"), "year": album.get("year"),
        "genre": album.get("genre"),   # rusrap, rock, ambient… — для настроек Flow (язык, настроение)
        "available": t.get("available", True),
        # Пометка 18+: в оригинале есть мат — пару без цензуры искать особенно важно
        "explicit": t.get("contentWarning") == "explicit",
    }


def _release(a: dict) -> dict:
    kind = a.get("type") or "album"
    if kind == "album" and (a.get("trackCount") or 99) <= 6:
        kind = "ep"   # у Яндекса нет типа «EP» — короткие альбомы считаем EP
    return {"id": a["id"], "title": a.get("title"), "year": str(a.get("year") or ""),
            "type": kind, "cover": _img(a.get("coverUri"), "400x400"),
            "coverLarge": _img(a.get("coverUri"), "1000x1000"), "tracks": a.get("trackCount"),
            "date": (a.get("releaseDate") or "")[:10],   # 2025-08-29 — для «Новинок»
            "artist": ", ".join(p.get("name", "") for p in a.get("artists") or [])}


def _artist_card(a: dict) -> dict:
    cover = (a.get("cover") or {}).get("uri") or (a.get("ogImage"))
    return {"id": a["id"], "name": a.get("name"), "picture": _img(cover, "200x200"),
            "pictureLarge": _img(cover, "1000x1000"), "likes": a.get("likesCount")}


# ---------- Что спрашивает страница ----------

def _search(text: str, kind: str) -> list[dict]:
    """Поиск Яндекса: список найденного (artists/tracks). Вместо ответа Яндекс иногда присылает строку
    («text-is-empty» и т.п.) — тогда просто ничего не нашлось, а не ошибка сервера."""
    text = (text or "").strip()
    if not text:
        return []
    found = _get(f"{YANDEX}/search", {"text": text, "type": kind, "page": 0})
    result = found.get("result") if isinstance(found, dict) else None
    block = result.get(kind + "s") if isinstance(result, dict) else None
    items = block.get("results") if isinstance(block, dict) else None
    return [x for x in items or [] if isinstance(x, dict)]


def search_artists(query: str, limit: int = 6) -> list[dict]:
    return [_artist_card(a) for a in _search(query, "artist")[:limit]]


def artist_by_name(name: str) -> dict | None:
    """Исполнитель по имени (для щелчка по имени в списке треков)."""
    name = re.split(r",| feat\.? | ft\.? ", name, flags=re.I)[0].strip()
    found = search_artists(name, limit=5)
    # Сравниваем и слитно: канал SoundCloud «lucybedroque» = «Lucy Bedroque» в Яндексе
    want = _norm(name).replace(" ", "")
    for a in found:
        if _norm(a["name"]).replace(" ", "") == want:
            return a
    first = _norm(found[0]["name"]).replace(" ", "") if found else ""
    if first and want and (want in first or first in want):
        return found[0]
    return None


def find_track(artist: str, title: str, duration: float | None) -> dict | None:
    """Трек в базе Яндекса по исполнителю и названию (щелчок по названию → его альбом или сингл).
    Ответ: {"albumId", "trackId": "ya…"} или None."""
    found = match_track(artist, title, duration)
    return {"albumId": found[1].get("id"), "trackId": f"ya{found[0]['id']}"} if found else None


def match_track(artist: str, title: str, duration: float | None) -> tuple[dict, dict] | None:
    """Трек Яндекса (как он есть в ответе) и его альбом. Совпасть должны название (без скобок) и исполнитель.
    Длительность только помогает выбрать: загрузка на SoundCloud/YouTube бывает на 10–15 с короче
    версии в Яндексе, а альбом при этом тот же."""
    want_title = _norm(re.sub(r"\s*[(\[].*?[)\]]", "", title or ""))
    want_artist = _norm(re.split(r",| feat\.? | ft\.? | & ", artist or "", flags=re.I)[0])
    if not want_title:
        return None
    best, best_score = None, -1e9
    for rank, t in enumerate(_search(f"{artist} {title}", "track")):
        name = _norm(re.sub(r"\s*[(\[].*?[)\]]", "", t.get("title") or ""))
        people = " ".join(_norm(a.get("name", "")) for a in t.get("artists") or [])
        if name != want_title and not (want_title in name or name in want_title):
            continue
        if want_artist and want_artist not in people and want_artist.replace(" ", "") not in people.replace(" ", ""):
            continue
        albums = t.get("albums") or []
        if not albums:
            continue
        got = (t.get("durationMs") or 0) / 1000
        score = (3 if name == want_title else 0) - rank * 0.2
        if duration and got:
            score -= min(abs(got - duration), 60) / 10
        if score > best_score:
            # Сначала обычный альбом/сингл, а не сборник «лучшее за год» (у сборников исполнитель «various»)
            album = next((al for al in albums if al.get("type") != "compilation"), albums[0])
            best, best_score = (t, album), score
    return best


def artist(artist_id: int) -> dict:
    info = _get(f"{YANDEX}/artists/{artist_id}/brief-info").get("result") or {}
    a = info.get("artist") or {}
    tracks = _get(f"{YANDEX}/artists/{artist_id}/tracks", {"page": 0, "page-size": 50}).get("result") or {}
    albums = _get(f"{YANDEX}/artists/{artist_id}/direct-albums",
                  {"page": 0, "page-size": 200, "sort-by": "year"}).get("result") or {}
    releases = [_release(r) for r in albums.get("albums") or []]
    releases += _deezer_extra_releases(a.get("name") or "", releases)
    releases.sort(key=lambda r: r.get("date") or r["year"] or "0", reverse=True)   # новые сверху
    stats = info.get("stats") or {}
    return {**_artist_card(a), "likes": a.get("likesCount"),
            # Слушателей в Яндекс Музыке за последний месяц и насколько их стало больше/меньше
            "listeners": stats.get("lastMonthListeners"), "listenersDelta": stats.get("lastMonthListenersDelta"),
            "top":[_track(t) for t in tracks.get("tracks") or []],
            "tracksTotal": (tracks.get("pager") or {}).get("total"),
            "releases": releases,
            "related": [_artist_card(r) for r in info.get("similarArtists") or []],
            # Новый релиз за последние 3 месяца — карточкой наверху страницы
            "newRelease": next((r for r in releases if r.get("date") and r["date"] >= time.strftime(
                "%Y-%m-%d", time.localtime(time.time() - 90 * 86400))), None),
            **_bio(a)}


# ---------- Биография ----------
# Яндекс знает биографию не всех (у многих — пусто или одна строка). Тогда — короткая статья из Википедии,
# но только если это статья о музыканте: у тёзок («Кино» — это и фильм) описание другое.
MUSIC_WORDS = re.compile(r"музык|певец|певица|исполнител|рэп|рок|групп|композитор|автор песен|диджей|продюсер|"
                         r"singer|musician|rapper|band|songwriter|record producer|\bdj\b|duo|group", re.I)


def _bio(a: dict) -> dict:
    text = ((a.get("description") or {}).get("text") or "").strip()
    if len(text) >= 120:
        return {"bio": text[:3000], "bioSource": "Яндекс Музыка"}
    wiki = wiki_bio(a.get("name") or "")
    if wiki:
        return {"bio": wiki["text"], "bioSource": "Википедия", "bioUrl": wiki["url"]}
    return {"bio": text[:3000], "bioSource": "Яндекс Музыка" if text else ""}


def wiki_bio(name: str) -> dict | None:
    """Краткая статья из Википедии (сначала русская, потом английская), если она о музыканте."""
    if not name:
        return None
    for lang, title in (("ru", name), (f"ru", f"{name} (группа)"), ("ru", f"{name} (музыкант)"), ("en", name)):
        try:
            page = _get(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{requests.utils.quote(title.replace(' ', '_'))}")
        except Exception:
            continue
        if page.get("type") != "standard":
            continue   # «неоднозначность» (страница со списком тёзок) — не то
        about = f"{page.get('description') or ''} {(page.get('extract') or '')[:200]}"
        if MUSIC_WORDS.search(about) and len(page.get("extract") or "") > 80:
            return {"text": page["extract"].strip()[:3000],
                    "url": ((page.get("content_urls") or {}).get("desktop") or {}).get("page", "")}
    return None


# ---------- Новинки исполнителей, на которых подписан человек ----------

def new_releases(artist_ids: list[int], days: int = 90) -> list[dict]:
    """Релизы за последние days дней у этих исполнителей — новые сверху. Кэш ответов Яндекса — сутки."""
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
    out, seen = [], set()
    for artist_id in artist_ids[:60]:
        try:
            albums = _get(f"{YANDEX}/artists/{int(artist_id)}/direct-albums",
                          {"page": 0, "page-size": 10, "sort-by": "year"}).get("result") or {}
        except Exception:
            continue
        for a in albums.get("albums") or []:
            r = _release(a)
            if r["date"] and r["date"] >= since and r["id"] not in seen:
                seen.add(r["id"])
                out.append({**r, "artistId": int(artist_id)})
    out.sort(key=lambda r: r["date"], reverse=True)
    return out


def album(album_id: str) -> dict:
    """Альбом Яндекса (число) или Deezer (dz123 — из дополнения дискографии, без обложки)."""
    if str(album_id).startswith("dz"):
        return _deezer_album(int(str(album_id)[2:]))
    a = _get(f"{YANDEX}/albums/{album_id}/with-tracks").get("result") or {}
    tracks = [_track(t, a) for volume in a.get("volumes") or [] for t in volume]
    people = a.get("artists") or [{}]
    # Лайки альбома: в самом ответе их нет, но они есть в сведениях об альбоме у каждого трека
    likes = a.get("likesCount") or next((al.get("likesCount") for volume in a.get("volumes") or [] for t in volume
                                         for al in t.get("albums") or [] if str(al.get("id")) == str(album_id)), None)
    return {**_release(a), "likes": likes, "artist":{"id": people[0].get("id"), "name": ", ".join(p.get("name", "") for p in people)},
            "label": ", ".join(l.get("name", "") for l in a.get("labels") or []), "tracks": tracks}


# ---------- Дополнение из Deezer ----------

def _deezer_extra_releases(name: str, have: list[dict]) -> list[dict]:
    """Релизы из Deezer, которых нет в Яндексе (сравниваем по названию)."""
    try:
        found = _get(f"{DEEZER}/search/artist", {"q": name, "limit": 3}).get("data") or []
        match = next((a for a in found if _norm(a.get("name")) == _norm(name)), None)
        if not match:
            return []
        data = _get(f"{DEEZER}/artist/{match['id']}/albums", {"limit": 200}).get("data") or []
    except Exception:
        return []
    known = {_norm(r["title"]) for r in have}
    extra = []
    for r in data:
        if _norm(r.get("title")) in known:
            continue
        known.add(_norm(r.get("title")))
        extra.append({"id": f"dz{r['id']}", "title": r.get("title"), "year": (r.get("release_date") or "")[:4],
                      "type": r.get("record_type") or "album", "cover": None, "coverLarge": None, "tracks": None})
    return extra


def _deezer_album(album_id: int) -> dict:
    a = _get(f"{DEEZER}/album/{album_id}")
    artist_info = a.get("artist") or {}
    tracks = []
    for t in (a.get("tracks") or {}).get("data", []):
        names = (t.get("artist") or artist_info).get("name", "")
        tracks.append({"source": "meta", "id": f"dz{t['id']}", "title": t.get("title"), "origTitle": t.get("title"),
                       "artists": names, "channel": names, "artistId": None, "duration": t.get("duration"),
                       "cover": None, "coverLarge": None, "album": a.get("title"), "albumId": f"dz{album_id}",
                       "available": True})
    return {"id": f"dz{album_id}", "title": a.get("title"), "year": (a.get("release_date") or "")[:4],
            "type": a.get("record_type") or "album", "cover": None, "coverLarge": None, "tracks": tracks,
            "artist": {"id": None, "name": artist_info.get("name")}, "label": a.get("label")}
