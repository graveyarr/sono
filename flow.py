"""Flow — бесконечная подборка по вкусу (как «Моя волна», но своя).

Вкус приходит со страницы: исполнители с весами (избранное, скачанное, история, плейлисты, статистика,
что человек пропускал и дослушивал) и любимые треки. Из них собирается порция:
1. Кандидаты из нескольких источников:
   - популярные треки любимых исполнителей (Яндекс Музыка);
   - «радио» исполнителя на Deezer — треки других исполнителей, которые слушают его поклонники
     (самый точный источник «похожего»: Кино → Летов, «Смысловые галлюцинации»);
   - похожие исполнители Яндекса и Deezer и их популярные треки;
   - похожие треки Яндекса на любимые треки (шумнее: весят мало, если исполнитель не связан со вкусом);
   - в режиме «Открытия» — похожие на похожих.
2. Каждый исполнитель получает «близость» ко вкусу: сколько любимых на него указывают, в скольких
   источниках он есть сразу (совпадение источников — сильный признак), насколько высоко в их списках.
3. Оценка трека = близость исполнителя × место трека (у исполнителя или в подборке) × свежесть.
4. Отбор по режиму: «Любимое» — в основном знакомые исполнители, «Открытия» — в основном новые.
   Случайно, но с перевесом в сторону лучших; не больше 2 треков исполнителя за порцию и не подряд.
   SoundCloud: на любимые треки оттуда — его «похожие треки», у артистов SoundCloud (id «sc:…») —
   их популярное и похожее на него (андеграунд, которого нет в Яндексе и Deezer).
У каждого трека — «почему он здесь» (because): «Похоже на Кино», «Вы слушаете Кино».
Звука у треков из базы нет (source: meta) — пару на YouTube/SoundCloud плеер ищет перед включением;
треки SoundCloud — сразу настоящие.
"""
from __future__ import annotations

import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait

import artists

# Какая доля порции — знакомые исполнители (остальное — новые для человека)
MODES = {
    "liked": 0.8,
    "mix": 0.45,
    "discover": 0.12,
}

_pool = ThreadPoolExecutor(12, thread_name_prefix="flow")
# Вложенные запросы из задач _pool (похожие Deezer — вместе с радио). Сами они ничего не ждут — взаимной блокировки нет
_side = ThreadPoolExecutor(8, thread_name_prefix="flow-side")

# SoundCloud подставляет app.py: SC_API(path, **params) — запрос к API, SC_TRACK(t) — трек Sono или None
SC_API = None
SC_TRACK = None
_sc_cache: dict[str, tuple[float, object]] = {}
SC_TTL = 6 * 3600


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", " ", (text or "").lower().replace("ё", "е")).strip()


def _compact(text: str) -> str:
    """Имя без пробелов и знаков: «Lucy Bedroque» = «lucybedroque», «SLAYR» = «slayr»."""
    return _norm(text).replace(" ", "")


def _first_artist(names: str) -> str:
    return re.split(r",| feat\.? | ft\.? ", names or "", flags=re.I)[0].strip()


def track_key(artist: str, title: str) -> str:
    """Ключ «исполнитель|название» — чтобы не повторять одну песню из разных альбомов."""
    title = re.sub(r"\s*[(\[].*?[)\]]", "", title or "")   # «(Remastered)», «[prod. …]»
    return f"{_norm(_first_artist(artist))}|{_norm(title)}"


# Переделки, которые в подборке не нужны: «Fitness Version 128 Bpm», караоке, ускоренные, каверы…
JUNK = re.compile(r"fitness|\bbpm\b|karaoke|караоке|instrumental|инструментал|минус|sped ?up|speed ?up|slowed|"
                  r"nightcore|8d audio|mashup|ringtone|рингтон|\bacapella\b|bass ?boost|\bcover\b|кавер|tribute|"
                  r"reverb|\bextended\b", re.I)


# ---------- Настройки: занятие, настроение, язык ----------
# Человек говорит «под спорт», «спокойное», «только русское» — подстраиваем вес кандидатов по жанрам
# Яндекса (у трека — жанр альбома, у исполнителя — его жанры; у треков только из Deezer — по исполнителю,
# если он встречался в «похожих» Яндекса) и по кириллице в названии. Не угадали жанр — трек не выкидываем,
# а ставим реже: лучше чуть мимо, чем пустой Flow.

ENERGY = ("rap", "hip", "trap", "phonk", "drill", "dance", "edm", "electr", "techno", "house", "trance", "dnb",
          "drum", "dubstep", "breakbeat", "hardstyle", "metal", "punk", "hardrock", "hardcore", "club")
CALM = ("ambient", "lounge", "chill", "relax", "jazz", "blues", "classic", "folk", "acoustic", "newage",
        "soundtrack", "bard", "romance", "soul", "lofi", "lo-fi", "meditat", "easy", "singer", "dream")
PARTY = ("dance", "pop", "edm", "house", "club", "disco", "electr", "rap", "hip", "reggaeton", "latin", "funk")
STUDY = ("ambient", "lofi", "lo-fi", "classic", "jazz", "soundtrack", "newage", "lounge", "chill", "instrumental",
         "postrock", "post-rock", "downtempo", "idm")
LOUD = ("metal", "punk", "hardcore", "hardstyle", "drill", "phonk", "rap", "trap")
# (что хотим, чего избегаем) для каждого варианта
TUNE_MOOD = {"energy": (ENERGY, CALM), "calm": (CALM, ENERGY)}
TUNE_ACTIVITY = {"sport": (ENERGY, CALM), "study": (STUDY, LOUD), "party": (PARTY, CALM), "rest": (CALM, LOUD)}
RU_GENRES = ("rus", "local", "estrada", "shanson", "bard", "romances", "soviet")
CYRILLIC = re.compile(r"[а-яё]", re.I)


def _has(genres: set[str], words: tuple) -> bool:
    return any(w in g for g in genres for w in words)


def _tune_factor(tune: dict, genres: set[str], text: str) -> float:
    """Во сколько раз чаще/реже ставить трек при выбранных настройках (1 — настройки не мешают)."""
    factor = 1.0
    for table, value in ((TUNE_MOOD, tune.get("mood")), (TUNE_ACTIVITY, tune.get("activity"))):
        if value not in table:
            continue
        want, avoid = table[value]
        if not genres:
            factor *= 0.5          # жанр неизвестен
        elif _has(genres, want) and not _has(genres, avoid):
            factor *= 1.8
        elif _has(genres, avoid) and not _has(genres, want):
            factor *= 0.08
        else:
            factor *= 0.45
    lang = tune.get("lang")
    if lang in ("ru", "foreign"):
        russian = bool(CYRILLIC.search(text)) or _has(genres, RU_GENRES)
        foreign = not russian and bool(genres)          # жанр известен и он не русский
        if lang == "ru":
            factor *= 1.0 if russian else 0.02 if foreign else 0.15
        else:
            factor *= 1.0 if foreign else 0.02 if russian else 0.6
    return factor


# ---------- Источники ----------

def _brief(artist_id: int) -> dict:
    """Популярные треки и похожие исполнители — один запрос, кэш на сутки."""
    info = artists._get(f"{artists.YANDEX}/artists/{artist_id}/brief-info").get("result") or {}
    person = info.get("artist") or {}
    return {
        "name": person.get("name") or "",
        "picture": artists._img((person.get("cover") or {}).get("uri"), "200x200"),
        "tracks": [artists._track(t) for t in info.get("popularTracks") or [] if t.get("available", True)],
        "similar": [(a["id"], a.get("name") or "") for a in info.get("similarArtists") or []],
        # Жанры исполнителя и похожих — по ним настройки Flow понимают язык и настроение трека
        "genres": person.get("genres") or [],
        "simGenres": [(a.get("name") or "", a.get("genres") or []) for a in info.get("similarArtists") or []],
    }


def _deep_tracks(artist_id: int) -> list[dict]:
    """Больше треков любимого исполнителя (для режима «Любимое»): до 50 популярных."""
    data = artists._get(f"{artists.YANDEX}/artists/{artist_id}/tracks", {"page": 0, "page-size": 50}).get("result") or {}
    return [artists._track(t) for t in data.get("tracks") or [] if t.get("available", True)]


def _similar_tracks(ya_id: str) -> list[dict]:
    """Похожие треки Яндекса на один трек."""
    data = artists._get(f"{artists.YANDEX}/tracks/{ya_id[2:]}/similar").get("result") or {}
    return [artists._track(t) for t in data.get("similarTracks") or [] if t.get("available", True)]


def _dz_track(t: dict) -> dict:
    name = (t.get("artist") or {}).get("name") or ""
    title = t.get("title") or ""
    return {"source": "meta", "id": f"dz{t['id']}", "title": title, "origTitle": title,
            "artists": name, "channel": name, "artistId": None, "duration": t.get("duration") or None,
            "cover": None, "coverLarge": None, "album": (t.get("album") or {}).get("title"), "albumId": None,
            "available": True, "explicit": bool(t.get("explicit_lyrics"))}


def _deezer_id(name: str) -> int | None:
    """Исполнитель на Deezer — только при точном совпадении имени, иначе радио будет про другого."""
    found = artists._get(f"{artists.DEEZER}/search/artist", {"q": name, "limit": 5}).get("data") or []
    want = _compact(name)
    same = [a for a in found if isinstance(a, dict) and _compact(a.get("name")) == want]
    # «Justice» и «Just-Ice» слитно одинаковы: сначала имя как написано, потом — у кого больше поклонников
    same.sort(key=lambda a: (_norm(a.get("name")) != _norm(name), -(a.get("nb_fan") or 0)))
    return same[0]["id"] if same else None


def _deezer_related(dz_id: int) -> list[str]:
    related = artists._get(f"{artists.DEEZER}/artist/{dz_id}/related", {"limit": 25}).get("data") or []
    return [a.get("name") or "" for a in related if isinstance(a, dict)]


def _deezer(name: str) -> dict:
    """Deezer: «радио» исполнителя (что слушают его поклонники) и похожие исполнители."""
    dz_id = _deezer_id(name)
    if not dz_id:
        return {"radio": [], "related": []}
    related = _side.submit(_safe, _deezer_related, dz_id, default=[])   # одновременно с радио
    radio = artists._get(f"{artists.DEEZER}/artist/{dz_id}/radio", {"limit": 50}).get("data") or []
    return {"radio": [_dz_track(t) for t in radio if isinstance(t, dict) and t.get("readable", True)],
            "related": related.result()}


def _sc_cached(key: str, fn):
    hit = _sc_cache.get(key)
    if hit and time.time() - hit[0] < SC_TTL:
        return hit[1]
    value = fn()
    _sc_cache[key] = (time.time(), value)
    if len(_sc_cache) > 500:
        _sc_cache.pop(next(iter(_sc_cache)))
    return value


def _sc_flow_track(t: dict) -> dict | None:
    """Трек SoundCloud → кандидат Flow. Исполнитель — из данных лейбла, «Исполнитель - Название» или автор загрузки."""
    track = SC_TRACK(t) if SC_TRACK and isinstance(t, dict) else None
    if not track:
        return None
    title = t.get("title") or ""
    artist = (t.get("publisher_metadata") or {}).get("artist") or ""
    if not artist and " - " in title:
        artist, title = title.split(" - ", 1)
    return {**track, "artists": artist or track.get("channel") or "", "keyTitle": title,
            "year": (t.get("created_at") or "")[:4] or None}


def _sc_related(track_id) -> list[dict]:
    """«Похожие треки» SoundCloud на один трек."""
    def load():
        data = SC_API(f"/tracks/{int(track_id)}/related", limit=20) or {}
        return [x for x in map(_sc_flow_track, data.get("collection") or []) if x]
    return _sc_cached(f"rel{track_id}", load)


def _sc_artist(uid: int) -> dict:
    """Артист SoundCloud: его популярные треки (только свои загрузки) и похожие на самый популярный."""
    def load():
        top = [t for t in (SC_API(f"/users/{uid}/toptracks", limit=10) or {}).get("collection") or []
               if (t.get("user") or {}).get("id") == uid]
        return {"tracks": [x for x in map(_sc_flow_track, top) if x], "first": top[0]["id"] if top else None}
    info = _sc_cached(f"user{uid}", load)
    return {"tracks": info["tracks"], "related": _sc_related(info["first"]) if info["first"] else []}


def _safe(fn, *args, default=None):
    try:
        return fn(*args)
    except Exception as e:
        print(f"[flow] {fn.__name__}{args[:1]}: {e}")
        return default


def _resolve_seed(seed: dict) -> int | None:
    if seed.get("id"):
        try:
            return int(seed["id"])
        except (TypeError, ValueError):
            pass
    found = _safe(artists.artist_by_name, seed.get("name") or "")
    return int(found["id"]) if found else None


def _resolve_track(seed: dict) -> str | None:
    """Трек-«затравка» → его id в Яндексе (у треков из базы он уже есть)."""
    meta_id = str(seed.get("id") or "")
    if re.fullmatch(r"ya\d+", meta_id):
        return meta_id
    duration = seed.get("duration") if isinstance(seed.get("duration"), (int, float)) else None
    found = _safe(artists.match_track, str(seed.get("artist") or ""), str(seed.get("title") or ""), duration)
    return f"ya{found[0]['id']}" if found else None


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
        else:
            chosen.append(pool.pop()[0])
    return chosen


def _weight(item: dict) -> float:
    """Вес из запроса страницы: число от −1000 до 1000 (что-то другое — 0)."""
    try:
        value = float(item.get("weight") or 0)
    except (TypeError, ValueError):
        return 0.0
    return max(-1000.0, min(1000.0, value)) if value == value else 0.0   # value != value — это NaN


def _norm_weights(items: list[dict]) -> list[tuple[dict, float]]:
    """Веса от 0 до 1, сглаженные корнем: самый любимый исполнитель не забивает всех остальных."""
    top = max((_weight(s) for s in items), default=0)
    return [(s, (_weight(s) / top) ** 0.5) for s in items] if top > 0 else []


# ---------- Порция ----------

def batch(seeds: list[dict], mode: str = "mix", exclude: list[str] | None = None,
          banned: list[str] | None = None, size: int = 10, tracks: list[dict] | None = None,
          avoid: list[dict] | None = None, known: list[str] | None = None,
          recent: list[str] | None = None, quick: bool = False, ready=None, tune: dict | None = None) -> dict:
    """Порция Flow.
    seeds   — исполнители [{name, id?, weight}] (чем больше вес, тем ближе ко вкусу);
    tracks  — любимые треки [{key, id?, artist, title, duration?, weight}] (от них — похожие треки);
    exclude — id треков и ключи «исполнитель|название», которые уже звучали или есть в медиатеке;
    banned  — исполнители, которых человек не хочет слышать; avoid — [{name, weight<0}] — слышать реже;
    known   — исполнители, которых человек уже слышал (для «знакомое / новое»);
    recent  — исполнители последних треков (чтобы не возвращаться к ним сразу);
    quick   — первая порция: без второго круга запросов (почти всё уже в кэше), чтобы Flow заиграл сразу;
    ready   — ready(id) → True, если пара на YouTube/SoundCloud для трека уже найдена (такой ставим первым);
    tune    — настройки {activity: sport|study|party|rest, mood: energy|calm, lang: ru|foreign} (пусто — без них).
    Ответ: {tracks, seedIds: {key: "ya…"}} — seedIds страница запоминает, чтобы не искать треки снова."""
    started = time.time()
    share_known = MODES.get(mode, MODES["mix"])
    seen = set(exclude or [])
    banned_set = {_compact(b) for b in banned or [] if b}
    avoid_w = {_compact(str(a["name"])): _weight(a) for a in avoid or [] if isinstance(a, dict) and a.get("name")}
    recent_set = {_compact(r) for r in recent or [] if r}
    tune = {k: v for k, v in (tune or {}).items() if isinstance(v, str) and v not in ("", "any")}

    # Каждый раз — лучшие 6 исполнителей и ещё 4 случайных из остальных: порции не одинаковые
    seeds = sorted([s for s in seeds or [] if isinstance(s, dict) and _weight(s) > 0 and isinstance(s.get("name"), str)
                    and _compact(s["name"]) not in banned_set], key=lambda s: -_weight(s))
    seeds = seeds[:6] + _pick_weighted([(s, _weight(s)) for s in seeds[6:30]], 4)
    track_seeds = [{**t, "artist": str(t.get("artist") or ""), "title": str(t.get("title") or "")}
                   for t in tracks or [] if isinstance(t, dict) and _weight(t) > 0][:8]

    # Deezer ищет по имени — запускаем сразу, не дожидаясь id Яндекса (первый Flow с пустым кэшем: 4,3 → ~2,5 с)
    dz_names: dict[str, str] = {}
    for s in seeds:
        if len(dz_names) < 4 and _compact(s["name"]) and _compact(s["name"]) not in dz_names:
            dz_names[_compact(s["name"])] = s["name"]
    dz_jobs = {name: _pool.submit(_safe, _deezer, name, default=None) for name in dz_names.values()}
    # SoundCloud — тоже сразу: артисты «sc:<номер>» (до 3) и любимые треки оттуда (до 4)
    sc_artist_jobs, sc_track_jobs = {}, {}
    if SC_API:
        for s in seeds:
            uid = str(s.get("id") or "")
            if uid.startswith("sc:") and uid[3:].isdigit() and len(sc_artist_jobs) < 3:
                sc_artist_jobs[s["name"]] = _pool.submit(_safe, _sc_artist, int(uid[3:]), default=None)
        for t in track_seeds:
            sc_id = str(t.get("sc") or "")
            if sc_id.isdigit() and len(sc_track_jobs) < 4:
                sc_track_jobs[sc_id] = _pool.submit(_safe, _sc_related, sc_id, default=[])
    artist_jobs = [_pool.submit(_resolve_seed, s) for s in seeds]   # исполнители и треки — одновременно
    track_ids = list(_pool.map(_resolve_track, track_seeds))
    artist_ids = [f.result() for f in artist_jobs]
    seed_ids = {str(t.get("key")): tid for t, tid in zip(track_seeds, track_ids) if tid and t.get("key")}
    # Найденные по имени id исполнителей — страница запомнит и в следующий раз пришлёт сама
    artist_found = {s.get("name"): aid for s, aid in zip(seeds, artist_ids) if aid and not s.get("id") and s.get("name")}

    own: dict[str, dict] = {}   # компактное имя → {name, id, w}
    for (seed, w), artist_id in zip(_norm_weights(seeds), artist_ids):
        key = _compact(seed.get("name"))
        if key and key not in own:
            own[key] = {"name": seed.get("name") or "", "id": artist_id, "w": w}
    known_set = {_compact(k) for k in known or [] if k} | set(own)
    tseeds = [(t, w, tid) for (t, w), tid in zip(_norm_weights(track_seeds), track_ids) if tid]
    sc_tseeds = [(t, w) for t, w in _norm_weights(track_seeds) if str(t.get("sc") or "") in sc_track_jobs]

    if not own and not tseeds and not sc_tseeds:   # вкуса ещё нет — чарт вперемешку
        chart = [t for t in _safe(_chart, default=[]) if t["id"] not in seen
                 and track_key(t["artists"], t["title"]) not in seen and _compact(_first_artist(t["artists"])) not in banned_set]
        random.shuffle(chart)
        return {"tracks": [{**t, "because": "Популярное сейчас", "flow": "new"} for t in chart[:size]], "seedIds": seed_ids, "artistIds": artist_found}

    # ---- 1. Первый круг: всё про любимых исполнителей и треки — одновременно ----
    own_list = sorted(own.values(), key=lambda a: -a["w"])
    deep = mode == "liked"
    jobs = {}
    for a in own_list:
        if a["id"]:
            jobs[("brief", a["name"])] = _pool.submit(_safe, _brief, a["id"], default=None)
            if deep and len([k for k in jobs if k[0] == "deep"]) < 5:
                jobs[("deep", a["name"])] = _pool.submit(_safe, _deep_tracks, a["id"], default=[])
    for a in own_list[:4]:   # Deezer — по самым любимым (3 запроса на исполнителя, потом из кэша)
        jobs[("dz", a["name"])] = dz_jobs.get(a["name"]) or _pool.submit(_safe, _deezer, a["name"], default=None)
    for t, w, tid in tseeds:
        jobs[("sim", tid)] = _pool.submit(_safe, _similar_tracks, tid, default=[])
    got = {k: f.result() for k, f in jobs.items()}
    sc_got = {name: f.result() for name, f in sc_artist_jobs.items()}
    sc_rel = {sc_id: f.result() for sc_id, f in sc_track_jobs.items()}

    # ---- 2. Близость исполнителей ко вкусу ----
    aff: dict[str, dict] = {}

    def bump(name, artist_id, amount, source, because):
        key = _compact(name)
        if not key or key in banned_set or amount <= 0:
            return
        a = aff.setdefault(key, {"name": name, "id": None, "score": 0.0, "src": set(), "seeds": set(), "best": (0, "")})
        a["id"] = a["id"] or artist_id
        a["score"] += amount
        a["src"].add(source)
        a["seeds"].add(because)
        if amount > a["best"][0]:
            a["best"] = (amount, because)

    for a in own_list:
        brief = got.get(("brief", a["name"]))
        for rank, (sid, sname) in enumerate((brief or {}).get("similar", [])):
            bump(sname, sid, a["w"] / (1 + rank * 0.3), "ya", a["name"])
        dz = got.get(("dz", a["name"]))
        if dz:
            for rank, name in enumerate(dz["related"]):
                bump(name, None, a["w"] / (1 + rank * 0.3), "dz", a["name"])
            for pos, t in enumerate(dz["radio"]):
                bump(_first_artist(t["artists"]), None, a["w"] * 0.3 / (1 + pos * 0.03), "radio", a["name"])
    for t, w, tid in tseeds:
        for rank, s in enumerate(got.get(("sim", tid)) or []):
            bump(_first_artist(s["artists"]), s.get("artistId"), w * 0.15 / (1 + rank * 0.1), "track", t.get("artist") or "")
    # SoundCloud: похожее на артиста — как радио Deezer, похожее на трек — как похожие треки
    for a in own_list:
        for rank, s in enumerate((sc_got.get(a["name"]) or {}).get("related") or []):
            bump(_first_artist(s["artists"]), None, a["w"] * 0.4 / (1 + rank * 0.1), "sc", a["name"])
    for t, w in sc_tseeds:
        for rank, s in enumerate(sc_rel.get(str(t["sc"])) or []):
            bump(_first_artist(s["artists"]), None, w * 0.2 / (1 + rank * 0.1), "sc", t.get("artist") or "")

    def affinity(key: str) -> float:
        """Близость исполнителя: любимый — его вес (+ немного, если на него указывают другие любимые);
        остальные — набранное × совпадение источников × сколько любимых на него указывают."""
        a = aff.get(key)
        if key in own:
            value = own[key]["w"] + (0.3 * a["score"] if a else 0)
        elif a:
            # Один источник — может ошибаться (у Яндекса в «похожих» на Justice бывает старый хип-хоп),
            # подтверждение вторым — сильный признак
            agree = 0.6 if len(a["src"]) == 1 else 1 + 0.5 * (len(a["src"]) - 1)
            value = a["score"] * agree * (1 + 0.25 * min(len(a["seeds"]) - 1, 4))
        else:
            value = 0.05
        if avoid_w.get(key, 0) < 0:   # пропускал — реже (−1 → ×0.6, −3 → ×0.2)
            value *= 0.6 ** -avoid_w[key]
        if key in recent_set:
            value *= 0.5
        return value

    # ---- 3. Второй круг: популярные треки самых близких похожих исполнителей ----
    # Только тех, чей id в Яндексе уже известен (один запрос): у исполнителей «только из Deezer» треки
    # и так есть — из радио, а поиск по имени добавил бы ещё полсекунды
    others = sorted(((k, affinity(k)) for k in aff if k not in own and aff[k]["id"]), key=lambda x: -x[1])
    n_open = 0 if quick else {"liked": 4, "mix": 8, "discover": 10}.get(mode, 8)
    open_keys = _pick_weighted(others[:30], n_open)
    second = {k: _pool.submit(_safe, _brief, aff[k]["id"], default=None) for k in open_keys}
    second = {k: f.result() for k, f in second.items()}

    # «Открытия»: похожие на похожих, которых человек ещё не слышал
    deeper: dict[str, tuple[float, int, str, str]] = {}
    if mode == "discover" and not quick:
        for k, brief in second.items():
            for rank, (did, dname) in enumerate((brief or {}).get("similar", [])):
                dk = _compact(dname)
                if not dk or dk in own or dk in aff or dk in known_set or dk in banned_set:
                    continue
                score = affinity(k) * 0.4 / (1 + rank * 0.3) + (deeper[dk][0] if dk in deeper else 0)
                deeper[dk] = (score, did, dname, aff[k]["name"])
        picks = _pick_weighted([(dk, v[0]) for dk, v in sorted(deeper.items(), key=lambda x: -x[1][0])[:20]], 4)
        third = {dk: _pool.submit(_safe, _brief, deeper[dk][1], default=None) for dk in picks}
        third = {dk: f.result() for dk, f in third.items()}
    else:
        third = {}

    # ---- 4. Кандидаты ----
    # Жанры исполнителей (из всего, что уже пришло от Яндекса) — для настроек
    artist_genres: dict[str, set[str]] = {}
    if tune:
        for brief in [got.get(("brief", a["name"])) for a in own_list] + list(second.values()) + list(third.values()):
            if not brief:
                continue
            artist_genres.setdefault(_compact(brief["name"]), set()).update(brief.get("genres") or [])
            for name, genres in brief.get("simGenres") or []:
                artist_genres.setdefault(_compact(name), set()).update(genres)
    cands: dict[str, dict] = {}
    year_now = time.gmtime().tm_year

    def offer(track: dict, score: float, because: str):
        if not track or score <= 0 or track["id"] in seen:
            return
        key = track_key(track["artists"], track.get("keyTitle") or track["title"])
        if key in seen or JUNK.search(track["title"] or ""):
            return
        duration = track.get("duration") or 0
        if duration and not 60 <= duration <= 600:
            return
        names = [_compact(n) for n in re.split(r",| feat\.? | ft\.? ", track["artists"] or "", flags=re.I)]
        if not names[0] or any(n in banned_set for n in names):
            return
        if re.search(r"\bremix\b|ремикс", track["title"] or "", re.I):
            score *= 0.6   # ремиксы — реже оригиналов
        if re.search(r"remake|ремейк|re-?recorded|\((?:19|20)\d\d\)|\bdemo\b|\b(?:7|12)(?:''|\"|”| ?inch)",
                     track["title"] or "", re.I):
            score *= 0.4   # «Звезда (2025)», «Проснись (Remake 2024)», демо, 12" — не тот самый трек
        if str(track.get("year") or "").isdigit() and int(track["year"]) >= year_now - 1:
            score *= 1.15  # свежее — чуть чаще
        fit = 1.0
        if tune:
            genres = ({track["genre"]} if track.get("genre") else set()) | artist_genres.get(names[0], set())
            # Без скобок: Яндекс пишет «(из фильма «Трон»)» по-русски и у зарубежных треков
            bare = re.sub(r"[(\[].*?[)\]]", "", track["title"] or "")   # не внутри f-строки: Python до 3.12 так не умеет
            fit = _tune_factor(tune, genres, f"{track['artists']} {bare}")
            score *= fit
        c = cands.get(key)
        if c:
            c["score"] += score * 0.5   # трек сразу из нескольких источников — сильнее
            if c["track"]["id"].startswith("dz") and track["id"].startswith("ya"):
                c["track"] = track      # версия Яндекса — с обложкой
            return
        cands[key] = {"track": track, "score": score, "artist": names[0], "because": because, "fit": fit}

    def because_of(key: str) -> str:
        if key in own:
            return f"Вы слушаете {own[key]['name']}"
        a = aff.get(key)
        return f"Похоже на {a['best'][1]}" if a and a["best"][1] else ""

    for a in own_list:
        key = _compact(a["name"])
        pool = got.get(("deep", a["name"])) or (got.get(("brief", a["name"])) or {}).get("tracks") or []
        for rank, t in enumerate(pool):
            artist = _compact(_first_artist(t["artists"]))
            offer(t, affinity(artist if artist in own else key) / (1 + rank * 0.3), because_of(key))
        dz = got.get(("dz", a["name"]))
        for pos, t in enumerate((dz or {}).get("radio", [])):
            artist = _compact(_first_artist(t["artists"]))
            because = because_of(artist) if artist in own else f"Похоже на {a['name']}"
            offer(t, (affinity(artist) * 0.6 + a["w"] * 0.6) / (1 + pos * 0.03), because)
    for t, w, tid in tseeds:
        for rank, s in enumerate(got.get(("sim", tid)) or []):
            artist = _compact(_first_artist(s["artists"]))
            title = re.sub(r"\s*[(\[].*?[)\]]", "", t.get("title") or "").strip()
            offer(s, w * 0.3 / (1 + rank * 0.1) + affinity(artist) * 0.5, f"Похоже на «{title}»" if title else because_of(artist))
    for a in own_list:   # артисты SoundCloud: свои треки и похожие
        sc = sc_got.get(a["name"]) or {}
        key = _compact(a["name"])
        for rank, t in enumerate(sc.get("tracks") or []):
            offer(t, affinity(key) / (1 + rank * 0.3), because_of(key))
        for rank, t in enumerate(sc.get("related") or []):
            artist = _compact(_first_artist(t["artists"]))
            because = because_of(artist) if artist in own else f"Похоже на {a['name']}"
            offer(t, (affinity(artist) * 0.6 + a["w"] * 0.5) / (1 + rank * 0.05), because)
    for t, w in sc_tseeds:   # любимые треки со SoundCloud — его «похожие треки»
        title = re.sub(r"\s*[(\[].*?[)\]]", "", t.get("title") or "").strip()
        for rank, s in enumerate(sc_rel.get(str(t["sc"])) or []):
            artist = _compact(_first_artist(s["artists"]))
            offer(s, w * 0.4 / (1 + rank * 0.08) + affinity(artist) * 0.5, f"Похоже на «{title}»" if title else because_of(artist))
    for k, brief in second.items():
        for rank, t in enumerate((brief or {}).get("tracks", [])):
            offer(t, affinity(k) * 0.8 / (1 + rank * 0.35), because_of(k))
    for dk, brief in third.items():
        for rank, t in enumerate((brief or {}).get("tracks", [])):
            offer(t, deeper[dk][0] * 0.8 / (1 + rank * 0.35), f"Новое для вас · похоже на {deeper[dk][3]}")

    # ---- 5. Отбор: знакомое и новое — по режиму ----
    known_pool = sorted((c for c in cands.values() if c["artist"] in known_set), key=lambda c: -c["score"])[:80]
    new_pool = sorted((c for c in cands.values() if c["artist"] not in known_set), key=lambda c: -c["score"])[:80]
    per_artist: dict[str, int] = {}
    chosen: list[dict] = []

    def take(pool: list[dict], count: int, limit: int):
        options = [c for c in pool if c not in chosen]
        while options and count > 0:
            c = _pick_weighted([(c, c["score"] ** 1.4) for c in options], 1)[0]
            options.remove(c)
            if per_artist.get(c["artist"], 0) >= limit:
                continue
            per_artist[c["artist"]] = per_artist.get(c["artist"], 0) + 1
            chosen.append(c)
            count -= 1

    n_known = round(size * share_known)
    if tune:
        # С настройками сначала — только подходящие (или с неизвестным жанром, 0.5); остальные — если не хватило
        fits = lambda pool: [c for c in pool if c["fit"] >= 0.5]
        take(fits(known_pool), n_known, 2)
        take(fits(new_pool), size - len(chosen), 1 if mode != "liked" else 2)
        take(fits(known_pool + new_pool), size - len(chosen), 3)
        if "lang" in tune:   # язык — строже всего: чужой язык ставим, только если иначе совсем нечего
            take([c for c in known_pool + new_pool if c["fit"] > 0.03], size - len(chosen), 4)
    take(known_pool, n_known - len(chosen), 2)
    take(new_pool, size - len(chosen), 1 if mode != "liked" else 2)
    take(known_pool + new_pool, size - len(chosen), 2)   # где-то не хватило — добираем откуда есть
    take(known_pool + new_pool, size - len(chosen), 4)

    # Лучший трек — первым (первое впечатление), остальные вперемешку; один исполнитель не подряд
    chosen.sort(key=lambda c: -c["score"])
    rest = chosen[1:]
    random.shuffle(rest)
    chosen = chosen[:1] + rest
    for i in range(1, len(chosen)):
        if chosen[i]["artist"] == chosen[i - 1]["artist"]:
            for j in range(i + 1, len(chosen)):
                if chosen[j]["artist"] != chosen[i - 1]["artist"]:
                    chosen[i], chosen[j] = chosen[j], chosen[i]
                    break

    # Треки только из Deezer — ищем в Яндексе: там обложка, альбом и ссылки на исполнителей.
    # Ждём не дольше 0,4 с: что не успело — уйдёт как есть (обложку возьмём у найденной пары),
    # а поиск доработает в фоне и в следующий раз ответ будет из кэша
    lookups = {i: _pool.submit(_safe, artists.match_track, c["track"]["artists"], c["track"]["title"],
                               c["track"].get("duration"))
               for i, c in enumerate(chosen) if c["track"]["id"].startswith("dz")}
    if lookups:
        wait(lookups.values(), timeout=0.4)
    result = []
    for i, c in enumerate(chosen):
        t = c["track"]
        future = lookups.get(i)
        found = future.result() if future and future.done() else None
        if found and f"ya{found[0]['id']}" not in seen:
            t = artists._track(*found)
        if t.get("source") == "soundcloud":   # настоящий трек — как в поиске (имя и название страница разберёт сама)
            t = {k: v for k, v in t.items() if k not in ("artists", "keyTitle", "year")}
        result.append({**t, "because": c["because"], "flow": "known" if c["artist"] in known_set else "new"})
    # Первым — трек, для которого звук уже есть (SoundCloud или пара найдена раньше): старт без ожидания поиска
    if ready:
        hit = next((i for i, t in enumerate(result[:5]) if t.get("source") == "soundcloud" or ready(t["id"])), 0)
        result.insert(0, result.pop(hit))
    print(f"[flow] {mode}: {len(result)} из {len(cands)} кандидатов, {len(aff)} похожих исполнителей, "
          f"{time.time() - started:.1f} с")
    return {"tracks": result, "seedIds": seed_ids, "artistIds": artist_found}


# ---------- «Ваши миксы» ----------

def mixes(seeds: list[dict], count: int = 6) -> list[dict]:
    """Любимые исполнители, разбитые на группы похожих — чтобы русский рок не мешался с зарубежным попом.
    Два исполнителя близки, если один есть в списке похожих у другого или у них много общих похожих.
    Ответ: [{artists: [{name, id, picture}]}] — у каждого микса 1–5 исполнителей, самые любимые первыми."""
    seeds = sorted([s for s in seeds or [] if isinstance(s, dict) and _weight(s) > 0 and isinstance(s.get("name"), str)
                    and s["name"].strip()], key=lambda s: -_weight(s))[:16]
    ids = list(_pool.map(_resolve_seed, seeds))
    briefs = list(_pool.map(lambda i: _safe(_brief, i) if i else None, ids))
    # Похожие из Deezer — у Яндекса, например, The Weeknd и Dua Lipa друг на друга не указывают
    related = list(_pool.map(lambda s: _safe(lambda n: _deezer_related(_deezer_id(n) or 0) if _deezer_id(n) else [],
                                             s["name"], default=[]), seeds))
    items = []
    for seed, artist_id, brief, more in zip(seeds, ids, briefs, related):
        if brief and not any(x["id"] == artist_id for x in items):
            items.append({"name": brief["name"] or seed["name"], "id": artist_id, "picture": brief.get("picture"),
                          "keys": {_compact(brief["name"]), _compact(seed["name"])},
                          "similar": {_compact(n) for _, n in brief["similar"]} | {_compact(n) for n in more}})

    def close(a: dict, b: dict) -> float:
        direct = b["keys"] & a["similar"] or a["keys"] & b["similar"]
        return (2 if direct else 0) + 0.5 * len(a["similar"] & b["similar"])

    groups, free = [], list(items)
    while free and len(groups) < count:
        members = [free.pop(0)]   # самый любимый из оставшихся — «лицо» микса
        # Добавляем по одному: того, кто ближе всех к группе в среднем; без прямой связи хоть с кем-то
        # в группе или при слабой средней близости — не берём (иначе рок «перетечёт» в поп через общих)
        while free and len(members) < 5:
            def fit(x):
                scores = [close(m, x) for m in members]
                return sum(scores) / len(scores) if max(scores) >= 2 else 0
            best = max(free, key=fit)
            if fit(best) < 1:
                break
            members.append(best)
            free.remove(best)
        groups.append(members)
    # Одиночки — в конец: микс из нескольких исполнителей интереснее, чем Flow по одному
    groups.sort(key=lambda g: len(g) < 2)
    return [{"artists": [{k: x[k] for k in ("name", "id", "picture")} for x in g]} for g in groups]
