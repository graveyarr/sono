"""Flow — бесконечная подборка по вкусу (как «Моя волна»).

Вкус приходит со страницы: исполнители с весами (из избранного, истории, скачанного и того,
что человек пропускал или дослушивал во Flow). Здесь из них собирается порция треков:
- «свои» — популярные треки любимых исполнителей;
- «похожие» — исполнители, на которых указывают сразу несколько любимых (данные Яндекс Музыки);
- «открытия» — похожие на похожих: то, чего человек ещё не слышал.
Доли зависят от режима: «Любимое», «Микс», «Открытия». Звука у треков нет (source: meta) —
пару на YouTube/SoundCloud плеер ищет перед включением, как на страницах исполнителей.
"""
from __future__ import annotations

import random
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import artists

MODES = {   # доли: свои, похожие, открытия
    "liked": (0.75, 0.25, 0.0),
    "mix": (0.4, 0.45, 0.15),
    "discover": (0.1, 0.5, 0.4),
}


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", " ", (text or "").lower().replace("ё", "е")).strip()


def track_key(artist: str, title: str) -> str:
    """Ключ «исполнитель|название» — чтобы не повторять одну песню из разных альбомов."""
    first = re.split(r",| feat\.? | ft\.? ", artist or "", flags=re.I)[0]
    title = re.sub(r"\s*[(\[].*?[)\]]", "", title or "")   # «(Remastered)», «[prod. …]»
    return f"{_norm(first)}|{_norm(title)}"


def _brief(artist_id: int) -> dict:
    """Популярные треки и похожие исполнители — один запрос, кэш на сутки."""
    info = artists._get(f"{artists.YANDEX}/artists/{artist_id}/brief-info").get("result") or {}
    return {
        "name": (info.get("artist") or {}).get("name") or "",
        "tracks": [artists._track(t) for t in info.get("popularTracks") or [] if t.get("available", True)],
        "similar": [(a["id"], a.get("name") or "") for a in info.get("similarArtists") or []],
    }


def _deep_tracks(artist_id: int) -> list[dict]:
    """Больше треков любимого исполнителя (для режима «Любимое»): до 50 популярных."""
    data = artists._get(f"{artists.YANDEX}/artists/{artist_id}/tracks", {"page": 0, "page-size": 50}).get("result") or {}
    return [artists._track(t) for t in data.get("tracks") or [] if t.get("available", True)]


def _resolve_seed(seed: dict) -> tuple[int, float] | None:
    weight = float(seed.get("weight") or 1)
    if seed.get("id"):
        return int(seed["id"]), weight
    try:
        found = artists.artist_by_name(seed.get("name") or "")
    except Exception:
        return None
    return (int(found["id"]), weight) if found else None


def _chart() -> list[dict]:
    """Для тех, у кого ещё нет вкуса: чарт Яндекс Музыки."""
    data = artists._get(f"{artists.YANDEX}/landing3/chart/russia").get("result") or {}
    return [artists._track(item["track"]) for item in (data.get("chart") or {}).get("tracks") or []
            if item.get("track") and item["track"].get("available", True)
            and not JUNK.search(item["track"].get("title") or "")]


def _pick_weighted(items: list[tuple], k: int) -> list:
    """k разных элементов, вероятность — по весу (элемент — (что, вес))."""
    pool = [(x, max(w, 0.01)) for x, w in items]
    chosen = []
    while pool and len(chosen) < k:
        total = sum(w for _, w in pool)
        r = random.uniform(0, total)
        for i, (x, w) in enumerate(pool):
            r -= w
            if r <= 0:
                chosen.append(x)
                pool.pop(i)
                break
    return chosen


# Переделки, которые в подборке не нужны: «Fitness Version 128 Bpm», караоке, ускоренные…
JUNK = re.compile(r"fitness|\bbpm\b|karaoke|караоке|instrumental|инструментал|минус|sped ?up|speed ?up|slowed|"
                  r"nightcore|8d audio|mashup|ringtone|рингтон|\bacapella\b", re.I)


def _pick_track(tracks: list[dict], seen: set[str]) -> dict | None:
    """Трек исполнителя: чаще из самых популярных, но не всегда первый."""
    fresh = [t for t in tracks if t["id"] not in seen and track_key(t["artists"], t["title"]) not in seen
             and not JUNK.search(t["title"] or "")]
    if not fresh:
        return None
    weights = [1 / (1 + i * 0.35) for i in range(len(fresh))]
    return random.choices(fresh, weights=weights)[0]


def batch(seeds: list[dict], mode: str = "mix", exclude: list[str] | None = None,
          banned: list[str] | None = None, size: int = 10) -> list[dict]:
    """Порция Flow. seeds — [{name, id?, weight}], exclude — id треков и ключи «исполнитель|название»,
    которые уже звучали; banned — имена исполнителей, которых человек не хочет слышать."""
    shares = MODES.get(mode, MODES["mix"])
    seen = set(exclude or [])
    banned_norm = {_norm(b) for b in banned or []}
    is_banned = lambda name: _norm(name) in banned_norm

    seeds = sorted(seeds or [], key=lambda s: -(s.get("weight") or 0))[:12]
    with ThreadPoolExecutor(6) as pool:
        resolved = [r for r in pool.map(_resolve_seed, seeds) if r]
    own_weights: dict[int, float] = defaultdict(float)
    for artist_id, weight in resolved:
        own_weights[artist_id] += weight

    if not own_weights:   # вкуса ещё нет — чарт вперемешку
        chart = [t for t in _chart() if t["id"] not in seen and not is_banned(t["artists"])]
        random.shuffle(chart)
        return chart[:size]

    with ThreadPoolExecutor(6) as pool:
        briefs = dict(zip(own_weights, pool.map(_safe_brief, own_weights)))

    # Похожие: чем больше любимых на них указывают (и чем выше в списке), тем больше вес
    similar: dict[int, float] = defaultdict(float)
    names: dict[int, str] = {}
    for artist_id, info in briefs.items():
        for rank, (sid, sname) in enumerate(info["similar"]):
            if sid in own_weights or is_banned(sname):
                continue
            similar[sid] += own_weights[artist_id] / (1 + rank * 0.25)
            names[sid] = sname

    n_own = round(size * shares[0])
    n_discover = round(size * shares[2])
    n_similar = size - n_own - n_discover

    # Сколько исполнителей открыть (каждый — запрос; потом из кэша)
    similar_pick = _pick_weighted(list(similar.items()), max(n_similar + 2, 0))
    with ThreadPoolExecutor(6) as pool:
        similar_briefs = dict(zip(similar_pick, pool.map(_safe_brief, similar_pick)))

    discover: dict[int, float] = defaultdict(float)
    if n_discover:
        for sid, info in similar_briefs.items():
            for rank, (did, dname) in enumerate(info["similar"]):
                if did in own_weights or did in similar or is_banned(dname):
                    continue
                discover[did] += similar[sid] / (1 + rank * 0.3)
        discover_pick = _pick_weighted(list(discover.items()), n_discover + 2)
        with ThreadPoolExecutor(6) as pool:
            discover_briefs = dict(zip(discover_pick, pool.map(_safe_brief, discover_pick)))
    else:
        discover_briefs = {}

    result: list[dict] = []

    def take(artist_tracks: dict[int, list[dict]], weights: dict[int, float], count: int, tag: str):
        order = _pick_weighted([(a, weights.get(a, 1)) for a in artist_tracks], len(artist_tracks))
        picked = 0
        # По кругу: сначала по треку от разных исполнителей, если не хватило — ещё раз
        for _ in range(3):
            for a in order:
                if picked >= count:
                    return
                track = _pick_track(artist_tracks[a], seen)
                if not track or is_banned(track["artists"]):
                    continue
                seen.add(track["id"])
                seen.add(track_key(track["artists"], track["title"]))
                result.append({**track, "flow": tag})
                picked += 1

    deep = mode == "liked"
    own_tracks = {}
    if deep:
        with ThreadPoolExecutor(6) as pool:
            own_tracks = dict(zip(own_weights, pool.map(_safe_deep, own_weights)))
    else:
        own_tracks = {a: info["tracks"] for a, info in briefs.items()}
    take(own_tracks, own_weights, n_own, "own")
    take({a: i["tracks"] for a, i in similar_briefs.items()}, similar, n_similar, "similar")
    take({a: i["tracks"] for a, i in discover_briefs.items()}, discover, n_discover, "discover")
    if len(result) < size:   # где-то не хватило — добираем из своих и похожих
        take(own_tracks, own_weights, size - len(result), "own")

    random.shuffle(result)
    # Один и тот же исполнитель не подряд
    for i in range(1, len(result)):
        if track_key(result[i]["artists"], "") == track_key(result[i - 1]["artists"], ""):
            for j in range(i + 1, len(result)):
                if track_key(result[j]["artists"], "") != track_key(result[i - 1]["artists"], ""):
                    result[i], result[j] = result[j], result[i]
                    break
    return result[:size]


def _safe_brief(artist_id: int) -> dict:
    try:
        return _brief(artist_id)
    except Exception as e:
        print(f"[flow] исполнитель {artist_id}: {e}")
        return {"name": "", "tracks": [], "similar": []}


def _safe_deep(artist_id: int) -> list[dict]:
    try:
        return _deep_tracks(artist_id)
    except Exception:
        return _safe_brief(artist_id)["tracks"]
