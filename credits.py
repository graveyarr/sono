"""«Кто сделал» трек — для страницы трека.

Берём только то, что написано явно: «feat./prod.» в названии, строки «Producer: …», «prod. by …», «mixed by …»
в описании SoundCloud/YouTube и автоописание YouTube Music («Provided to YouTube by …», «Composer: …»).
Сомнительное не показываем: длинные строки, ссылки, предложения — пропускаются.
"""

import re

# Роль → как её назвать на странице. Порядок — порядок показа
ROLES = {
    "feat": "При участии",
    "producer": "Продюсер",
    "writer": "Автор",
    "lyrics": "Слова",
    "music": "Музыка",
    "mix": "Сведение",
    "master": "Мастеринг",
    "art": "Обложка",
    "video": "Режиссёр клипа",
}

# Слова роли в строках описания (англ. и рус.). «by» после — необязательно
_ROLE_WORDS = [
    ("producer", r"prod(?:uced|uction|ucer|ucers)?\.?|beat(?:s)?|бит|продюсер(?:ы)?|продакшн|пр[оа]д\.?"),
    ("mix", r"mix(?:ed|ing)?(?:\s*(?:&|and|/)\s*master(?:ed|ing)?)?|сведение(?:\s*(?:и|&|/)\s*мастеринг)?|свёл|свел"),
    ("master", r"master(?:ed|ing)?|мастеринг"),
    ("writer", r"written|writer(?:s)?|songwriter(?:s)?|composer(?:\s*,\s*lyricist)?|автор(?:ы)?(?:\s+песни)?"),
    ("lyrics", r"lyric(?:s|ist)|текст|слова"),
    ("music", r"music|музыка"),
    ("art", r"(?:cover\s*)?art(?:work)?|cover|обложка"),
    ("video", r"direct(?:ed|or)|video\s+by|режиссёр|режиссер|клип"),
]

_URL = re.compile(r"https?://|www\.|\.com\b|\.ru\b|\.me\b|t\.me/", re.I)
# Имя — без лишнего: «@nick» → «nick», хвостовые знаки и эмодзи-рамки прочь
_JUNK_EDGE = re.compile(r"^[\s\-–—:|•·*~\"'«»()\[\]]+|[\s\-–—:|•·*~\"'«»()\[\]!.,]+$")
_SPLIT = re.compile(r"\s*(?:,|&|\+|/|\s(?:x|и|and|×)\s)\s*", re.I)


# «X on insta», «X (ig)», «X в инсте» — хвост про соцсети
_SOCIAL = re.compile(r"\s*(?:\(|\[)?\s*(?:on|at|в|на)?\s*(?:insta(?:gram)?|ig|twitter|tiktok|tg|инст[аеуы]?|тг)\b.*$", re.I)
# «я сам», «me» — не имя
_SELF = {"me", "myself", "i", "self", "я", "сам", "мной", "мне", "him", "her", "us", "unknown", "?"}


def _clean_name(raw: str) -> str:
    name = _JUNK_EDGE.sub("", raw.replace("@", "")).strip()
    name = _SOCIAL.sub("", name).strip()
    if name.count("(") > name.count(")"):   # «Azar Strato (FMT.Jetlag» — скобка не закрыта
        name = name[:name.index("(")].strip()
    words = name.split()
    # «Вишну visnuvison», «Mariya Aleksandrova maryeternalpeace» — после имени ник из соцсети
    if len(words) >= 2 and re.fullmatch(r"[a-z0-9_.]{5,}", words[-1]) and words[-2][:1].isupper():
        name = " ".join(words[:-1])
    return _JUNK_EDGE.sub("", name).strip()


def _names(text: str) -> list[str]:
    """«A, B & C» → ['A', 'B', 'C']; отбрасывает всё, что не похоже на имя."""
    out = []
    for raw in _SPLIT.split(text):
        name = _clean_name(raw)
        if name.lower() in _SELF:
            continue
        if not name or len(name) > 40 or _URL.search(name) or len(name.split()) > 4:
            return []   # хоть одно «не имя» — не верим всей строке
        if not re.search(r"[^\W\d_]", name):   # нет ни одной буквы
            return []
        out.append(name)
    return out if 0 < len(out) <= 6 else []


def _add(found: dict, role: str, names: list[str]):
    have = found.setdefault(role, [])
    for n in names:
        if n.lower() not in (h.lower() for h in have):
            have.append(n)


def from_title(title: str, found: dict):
    """feat./ft./prod. в скобках или в конце названия."""
    for m in re.finditer(r"[(\[]\s*(feat\.?|ft\.?|featuring|w/|prod\.?(?:\s*by)?)\s+([^)\]]+)[)\]]", title, re.I):
        _add(found, "producer" if m.group(1).lower().startswith("prod") else "feat", _names(m.group(2)))
    m = re.search(r"\s(?:feat\.?|ft\.?|featuring)\s+([^(\[\-–—|]+)$", title, re.I)
    if m:
        _add(found, "feat", _names(m.group(1)))
    m = re.search(r"\s(?:prod\.?(?:\s*by)?|\(prod)\s+([^(\[\-–—|)]+)\)?$", title, re.I)
    if m:
        _add(found, "producer", _names(m.group(1)))


_VIDEO_CREDITS = re.compile(r"^[\W_]*(?:direct(?:ed|or)|dop\b|d\.o\.p|cinematograph|режисс[её]р|оператор|video\s+by)", re.I | re.M)


def from_description(text: str, found: dict):
    """Строки вида «prod. by X», «Producer: X», «mixed & mastered by Y» (каждая — не длиннее 120 знаков).
    В описании клипа («Director: …») «Producer» — тот, кто снимал видео, а не музыку: его не берём."""
    video = bool(_VIDEO_CREDITS.search(text or ""))
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or len(line) > 120 or _URL.search(line) and ":" not in line:
            continue
        for role, words in _ROLE_WORDS:
            m = re.match(rf"^[\W_]*(?:{words})\s*(?:by|от|:|-|–|—)\s*(?:by\s+)?(.+)$", line, re.I)
            if not m:
                continue
            if video and role == "producer" and not re.match(r"^[\W_]*(?:prod\.|beat|бит)", line, re.I):
                break
            rest = m.group(1)
            # «Mixed & mastered by X» — обе роли
            both = role == "mix" and re.search(r"master|мастеринг", line[:m.start(1)], re.I)
            names = _names(_URL.split(rest)[0] if _URL.search(rest) else rest)
            if names:
                _add(found, role, names)
                if both:
                    _add(found, "master", names)
            break


def from_youtube_music(text: str) -> dict:
    """Автоописание YouTube Music: дата выхода, лейбл (℗) и роли «Composer, Lyricist: X»."""
    out: dict = {"credits": {}}
    if not text or "Provided to YouTube by" not in text:
        return out
    m = re.search(r"Released on:\s*(\d{4}-\d{2}-\d{2})", text)
    if m:
        out["date"] = m.group(1)
    m = re.search(r"℗\s*(?:\d{4}\s+)?(.+)", text)
    if m:
        out["label"] = m.group(1).strip()[:80]
    yt_roles = {"producer": "producer", "composer": "writer", "lyricist": "lyrics", "writer": "writer",
                "songwriter": "writer", "mixing engineer": "mix", "mastering engineer": "master",
                "mixer": "mix", "featured artist": "feat"}
    for line in text.splitlines():
        if ":" not in line or len(line) > 160:
            continue
        roles, _, value = line.partition(":")
        mine = [yt_roles[r.strip().lower()] for r in roles.split(",") if r.strip().lower() in yt_roles]
        names = _names(value) if mine else []
        for role in mine:
            _add(out["credits"], role, names)
    return out


def ordered(found: dict) -> list[dict]:
    """[{role: "Продюсер", names: [...]}] в порядке ROLES."""
    return [{"role": ROLES[r], "names": found[r]} for r in ROLES if found.get(r)]


# Жанр SoundCloud — свободный текст («TWIKIPEDIA», «★», «ilovehoes»): показываем, только если в нём есть знакомое слово
_GENRE_WORDS = re.compile(
    r"rock|pop|rap|hip.?hop|trap|drill|r&b|rnb|soul|jazz|blues|metal|punk|emo|indie|alternative|electronic|electro|"
    r"techno|house|trance|dubstep|drum|bass|dnb|edm|dance|disco|ambient|classical|piano|acoustic|folk|country|"
    r"reggae|latin|soundtrack|lo.?fi|phonk|plugg|rage|hyperpop|digicore|glitch|breakcore|jersey|club|shoegaze|grunge|"
    r"hardstyle|hardcore|experimental|synth|wave|garage|grime|afro|k.?pop|j.?pop|funk|gospel|world|"
    r"рок|поп|рэп|хип.?хоп|трэп|панк|электрон|инди|метал|шансон|джаз|фонк", re.I)


def genre_ok(genre: str | None) -> str | None:
    g = (genre or "").strip()
    return g if 2 < len(g) <= 40 and _GENRE_WORDS.search(g) else None


def label_ok(label: str | None, artist: str = "") -> str | None:
    """Лейбл из «℗ …»: не список правообладателей, не «Self-Issued», не сам исполнитель."""
    lab = (label or "").strip()
    if not lab or len(lab) > 40 or "," in lab or "(" in lab or re.search(r"self.?issued|independent|не указан", lab, re.I):
        return None
    if artist and (lab.lower() in artist.lower() or artist.lower() in lab.lower()):
        return None
    return lab
