// «Та же песня»: одна и та же запись, загруженная на YouTube и SoundCloud (или дважды на один сайт).
// Нужна, чтобы показывать её одной строкой (пункт «одна песня — одна строка»). Данные не меняются:
// склеивается только показ, поэтому ошибка здесь ничего не удаляет — но и чужое склеивать нельзя.
// Правило: лучше не склеить одну и ту же песню, чем склеить две разные.
//
// Модуль без зависимостей от страницы — его проверяют прямо в Node на сотнях настоящих пар.
// Слова версий — те же, что у поиска пар на сервере (importer.py SC_OTHER_VERSIONS/OTHER_VERSIONS,
// linkinfo.py VERSION_WORDS); меняете там — посмотрите и здесь.

import { cleanChannel, displayTrack } from "./trackname.js";

const keyOf = (t) => `${t.source}:${t.id}`;

// Разница в длине, при которой это ещё одна и та же запись (у загрузок бывает тишина в конце, другая кодировка)
const MAX_GAP = 5;

// Пометки версий: есть в одном названии и нет в другом — это разные записи (ремикс, лайв, кавер, slowed…).
// Ищем в полном исходном названии; «граница» — не буква и не цифра (live, но не alive; mix, но не remix)
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const VERSION_TAGS = [
  ["remix", `${B}(remix|rmx|ремикс|rework|bootleg|flip|vip|edit|re-?edit|remake|ремейк)${E}|リミックス|리믹스|混音`],
  ["mix", `${B}(extended|club|radio|dub|mix)${E}`],
  ["live", `${B}(live|концерт|concert|unplugged|the first take|the home take|session|tour)${E}|ライブ|라이브|演唱會|演唱会|現場`],
  ["slowed", `${B}(slowed|замедл\\p{L}*|daycore)${E}`],
  ["sped", `${B}(sped|speed|spedup|nightcore|ускор\\p{L}*|faster)${E}`],
  ["reverb", `${B}(reverb|ревер\\p{L}*)${E}`],
  ["8d", `${B}(8d|16d|3d audio)${E}`],
  ["bass", `${B}(bass boost\\p{L}*|bassboost\\p{L}*)${E}`],
  ["cover", `${B}(cover\\p{L}*|кавер\\p{L}*|original by|originally by|оригинал|orig\\.?|dongdang|parody|пародия|tribute)${E}|カバー|歌ってみた|弾いてみた|叩いてみた|演奏してみた|커버|翻唱|翻自|原曲|원곡|원본`],
  ["inst", `${B}(instrumental|inst|инструментал|минус|karaoke|караоке|off ?vocal|acapella|a cappella|акапелла|beat|бит|type beat|stems?)${E}|オフボーカル|カラオケ|伴奏|인스트|노래방`],
  ["acoustic", `${B}(acoustic|акусти\\p{L}*|unplugged|piano|пиано|guitar|гитар\\p{L}*|orchestra\\p{L}*|оркестр\\p{L}*|jazz|lo-?fi|music box)${E}|アコースティック|ピアノ|弾き語り|어쿠스틱|피아노|钢琴|鋼琴`],
  ["demo", `${B}(demo|демо|og|og version|original version|early version|leak\\p{L}*|слив|snippet|сниппет|unfinished|rough|alt|alternate|take \\d+)${E}`],
  ["ver", `${B}(ver|version|версия|vers|edition|remaster\\p{L}*|ремастер\\p{L}*|re-?record\\p{L}*|taylor's version|clean|censored|цензур\\p{L}*|radio edit|short|tv size|full)${E}|ver\\.|バージョン|버전|tvサイズ`],
  ["loop", `${B}(loop|1 hour|10 hours?|час|часа|часов|hour)${E}`],
  ["mashup", `${B}(mashup|мэшап|медли|medley)${E}`],
  ["phonk", `${B}(phonk|фонк|drill|jersey|hardstyle|funk)${E}`],
  ["other", `${B}(reaction|reacts|реакция|разбор|tutorial|урок|lesson|tabs?|аккорды|chords|how to|dance practice|performance video|teaser|тизер|trailer|preview|превью|amv|edit audio|anime|аниме|tv anime|ost|opening theme|ending theme)${E}|オープニング|エンディング|ムービー|アニメ|主题曲|主題歌`],
].map(([tag, re]) => [tag, new RegExp(re, "iu")]);
// Те же слова все сразу — чтобы вырезать их из скобок: «(NOTD Remix)» → «NOTD»
const VERSION_ANY = new RegExp(VERSION_TAGS.map(([, re]) => `(?:${re.source})`).join("|"), "giu");
// Пометки, при которых всё равно можно склеить: официальный ремикс или «Extended/Radio Mix» есть и на YouTube,
// и на SoundCloud. Остальные (slowed от разных людей, каверы, концерты, «English Ver.» и «HIKAKIN Ver.», демо,
// сливы, акустика…) — почти всегда РАЗНЫЙ звук даже при одной длине: такое не склеиваем никогда (кроме общего трека базы)
const OK_TAGS = new Set(["", "mix", "remix", "mix,remix"]);

// «Original Mix» — это и есть оригинал, а «feat./prod.» — не версия
const NOT_VERSION = /(?<![\p{L}\p{N}])(original mix|feat\.?|ft\.?|prod\.?(\s*by)?)(?![\p{L}\p{N}])/giu;

/** Набор пометок версии из всего, что известно о названии */
function versionTags(track) {
  const text = `${track.title || ""} ${track.origTitle || ""}`.normalize("NFKC").toLowerCase().replace(NOT_VERSION, " ");
  const tags = VERSION_TAGS.filter(([, re]) => re.test(text)).map(([tag]) => tag);
  // Дата в названии («… 22.08.2026 москва», «2023.03.26») — почти всегда запись концерта (как в importer._looks_original)
  if (/(?<!\d)(\d{1,2}[./-]\d{1,2}[./-](19|20)?\d\d|(19|20)\d\d[./-]\d{1,2}[./-]\d{1,2})(?!\d)/.test(text) && !tags.includes("live")) tags.push("live");
  return tags.sort().join(",");
}

// ---------- Название и исполнитель для сравнения ----------

/** Только буквы и цифры, NFKC (широкие японские буквы → обычные), ё → е */
const flat = (s) => (s || "").normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");

// Внутри скобок — мусор, если там только эти слова (official, MV, даты…). Иначе в скобках часть названия:
// у японских загрузок в 【】 часто само название («【素晴らしき日々～不連続存在～】soranosita / …»)
const JUNK_WORDS = /^(official|офиц\p{L}*|video|видео|audio|аудио|music|lyrics?|lyric|текст|слова|visuali[sz]er|m\/?v|pv|hd|hq|4k|8k|1080p|720p|clip|клип|премьера|premiere|new|новинка|explicit|full|song|track|single|сингл|album|альбом|ep|free|dl|download|download link|in description|out now|official audio|official video|music video|lyric video|color coded|han|rom|eng|kor|jpn|sub|subs|subtitles|rus sub|перевод|translation|和訳|日本語訳|中日字幕|歌詞|歌詞付き|가사|高音質|音源|字幕|\d+|[-./:]|\s)+$/iu;
const BRACKETS = /[(\[【「『（［《〈<{]([^)\]】」』）］》〉>}]*)[)\]】」』）］》〉>}]/gu;

/** Название без мусора в скобках, без feat/prod-хвостов; пометки версий здесь не важны (их сравнивают отдельно) */
function titleCore(title) {
  let t = (title || "").normalize("NFKC").replace(/(?<![\p{L}\p{N}])original mix(?![\p{L}\p{N}])/giu, " ")
    .replace(BRACKETS, (m, inner) => {
      const s = inner.trim();
      if (!s || JUNK_WORDS.test(s) || /^(feat|ft|prod|with|при уч)/i.test(s)) return " ";
      // Пометка версии сравнивается отдельно, но остальные слова скобки — нет: «(NOTD Remix)» ≠ «(Major Lazer Remix)»
      if (VERSION_TAGS.some(([, re]) => re.test(s.toLowerCase()))) {
        const rest = s.replace(VERSION_ANY, " ").replace(/(?<![\p{L}\p{N}])(by|ver|x|feat\.?|ft\.?|prod\.?)(?![\p{L}\p{N}])/giu, " ");
        return JUNK_WORDS.test(rest.trim() || " ") ? " " : ` ${rest} `;
      }
      return ` ${s} `;
    });
  // «Song feat. X», «U wld never do it prod kuru» — хвост до следующей скобки
  t = t.replace(/\s(feat\.?|ft\.?|prod\.?|при уч\.?)\s[^(\[【「『（［]*/giu, " ");
  return flat(t);
}

/** Имена исполнителей строки «A, B feat. C & D» */
function names(text) {
  return (text || "").normalize("NFKC").split(/\s*(?:,|&|\+|×|、|\/|／|;)\s*|\s+(?:feat\.?|ft\.?|featuring|x|и|and|with|vs\.?)\s+/iu)
    .map(flat).filter((n) => n.length >= 2);
}

// Латиницей русское имя пишут по-разному (как importer.latin): «Монеточка» = «monetochka»
const TRANSLIT = Object.fromEntries([..."абвгдеёжзийклмнопрстуфхцчшщъыьэюя"].map((c, i) =>
  [c, ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t",
    "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"][i]]));
function latin(name) {
  if (!/[а-я]/.test(name)) return [name];
  const out = new Set([[...name].map((c) => TRANSLIT[c] ?? c).join("")]);
  for (const [ru, alt] of [["х", "h"], ["ц", "c"], ["й", "i"], ["ю", "iu"], ["я", "ia"]]) {
    out.add([...name].map((c) => (c === ru ? alt : TRANSLIT[c] ?? c)).join(""));
  }
  return [...out];
}

// Названия, которые бывают у многих разных песен одного исполнителя: склеиваем только по общему треку базы
const GENERIC = /^(intro|outro|interlude|skit|untitled|demo|track\d*|bonus|prelude|reprise|instrumental|интро|аутро|интерлюдия|скит|безназвания|\d+)$/u;

// Заметно «азиатское» письмо: такие названия сами с латиницей не сравниваются (у иероглифов несколько чтений),
// а внутри одного письма — как обычно
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Все разумные прочтения «исполнитель + название» одной загрузки */
function readings(track) {
  const out = [];
  // Из импорта или страницы исполнителя — точные данные, других прочтений не нужно
  if (track.artists && track.origTitle) {
    const core = titleCore(track.origTitle), who = names(track.artists);
    if (core && who.length) out.push({ core, who });
    return out;
  }
  const raw = (track.title || "").normalize("NFKC");
  // Что написано в скобках исходного названия и не мусор. Показ (displayTrack) иногда выбрасывает скобку
  // целиком («(eight birthday party …)» — из-за «hd» в «birthday»), поэтому потерянное возвращаем в название
  const inner = [...raw.matchAll(BRACKETS)].map((m) => m[1].trim())
    .filter((s) => s && !JUNK_WORDS.test(s) && !/^(feat|ft|prod|with|при уч)/i.test(s)
      && !VERSION_TAGS.some(([, re]) => re.test(s.toLowerCase())));
  const add = (artist, title) => {
    const have = flat(`${artist} ${title}`);
    const lost = inner.filter((s) => !have.includes(flat(s))).join(" ");
    const core = titleCore(title) + flat(lost);
    const who = names(artist);
    if (core && who.length) out.push({ core, who });
  };
  const shown = displayTrack(track);
  const channel = track.pubArtist || cleanChannel(track.channel);
  add(shown.artist, shown.title);
  // Японский обычай «Название / Исполнитель» и обратный «Исполнитель / Название»
  const slash = raw.replace(BRACKETS, (m, inner) => (JUNK_WORDS.test(inner.trim()) ? " " : m)).split(/\s+[\/／]\s+/);
  if (slash.length === 2) {
    add(slash[1], slash[0]);
    add(slash[0], slash[1]);
  }
  // «【Ado】うっせぇわ», «YOASOBI「夜に駆ける」», «ずっと真夜中でいいのに。『秒針を噛む』»
  let m = raw.match(/^\s*[【\[]([^】\]]+)[】\]]\s*(.+)$/u);
  if (m) add(m[1], m[2]);
  m = raw.match(/^\s*([^「『]+?)\s*[「『]([^」』]+)[」』]/u);
  if (m) add(m[1], m[2]);
  // Название без исполнителя в нём, исполнитель — сам канал
  if (channel && shown.artist !== channel) add(channel, shown.title);
  return out;
}

const cache = new Map();   // ключ трека + название → признаки (считать заново на каждую строку дорого)
function features(track) {
  const id = `${keyOf(track)}|${track.title}|${track.origTitle ?? ""}|${track.artists ?? ""}|${track.channel ?? ""}`;
  let f = cache.get(id);
  if (!f) {
    if (cache.size > 5000) cache.clear();
    f = { tags: versionTags(track), reads: readings(track), duration: Number(track.duration) || 0, metaId: track.metaId || null };
    cache.set(id, f);
  }
  return f;
}

function sameArtist(a, b) {
  // Первый исполнитель одной загрузки — среди исполнителей другой (у второй может не быть гостей в названии)
  const has = (list, name) => list.some((n) => n === name || latin(n).includes(name) || latin(name).includes(n));
  return has(b.who, a.who[0]) || has(a.who, b.who[0]);
}

/** Одна ли это песня (та же запись). Строго: сомнение — «нет» */
export function sameSong(a, b) {
  if (!a || !b) return false;
  if (keyOf(a) === keyOf(b)) return true;
  if (a.source === "local" || b.source === "local") return false;   // свои файлы не склеиваем
  const fa = features(a), fb = features(b);
  // Длина известна у обеих и почти одна (ремиксы, slowed, клипы со вступлением — длиннее/короче)
  if (!fa.duration || !fb.duration || Math.abs(fa.duration - fb.duration) > MAX_GAP) return false;
  // Обе — пары одного трека базы (Яндекс/Deezer): та же песня. Разные треки базы — разные песни
  if (fa.metaId && fb.metaId) return fa.metaId === fb.metaId && fa.tags === fb.tags;
  if (fa.tags !== fb.tags || !OK_TAGS.has(fa.tags)) return false;
  // У ремикса — только основное прочтение (с именем ремиксера из скобок), без «Название / Исполнитель» и т.п.
  const ra0 = fa.tags ? fa.reads.slice(0, 1) : fa.reads, rb0 = fb.tags ? fb.reads.slice(0, 1) : fb.reads;
  for (const ra of ra0) {
    for (const rb of rb0) {
      if (ra.core !== rb.core || GENERIC.test(ra.core)) continue;
      if (ra.core.length < 2 || (!CJK.test(ra.core) && ra.core.length < 3)) continue;
      if (sameArtist(ra, rb)) return true;
    }
  }
  return false;
}

/** Ключи для быстрого поиска «кандидатов»: сравниваем только загрузки с общим ключом */
function bucketKeys(track) {
  const f = features(track);
  return f.metaId ? [`m:${f.metaId}`, ...f.reads.map((r) => r.core)] : f.reads.map((r) => r.core);
}

/** Склеить список в песни: [{ track (какая играет), members: [загрузки по порядку], indices }] в порядке списка.
 *  pick(members) — какую загрузку показывать и включать (по умолчанию первую) */
export function groupSongs(tracks, pick = (members) => members[0]) {
  const groups = [];
  const byKey = new Map();   // ключ кандидата → группы
  tracks.forEach((track, i) => {
    let home = null;
    const seen = new Set();
    for (const k of bucketKeys(track)) {
      for (const g of byKey.get(k) ?? []) {
        if (seen.has(g)) continue;
        seen.add(g);
        // Склеиваем, только если трек — та же песня, что и КАЖДАЯ загрузка группы (без «цепочек» A≈B≈C)
        if (g.members.every((m) => sameSong(m, track))) { home = g; break; }
      }
      if (home) break;
    }
    if (!home) {
      home = { members: [], indices: [] };
      groups.push(home);
    }
    home.members.push(track);
    home.indices.push(i);
    for (const k of bucketKeys(track)) {
      if (!byKey.has(k)) byKey.set(k, []);
      if (!byKey.get(k).includes(home)) byKey.get(k).push(home);
    }
  });
  for (const g of groups) g.track = g.members.length > 1 ? pick(g.members) ?? g.members[0] : g.members[0];
  return groups;
}

// Указатель списка «ключ кандидата → загрузки» — строится один раз на список, пока тот не изменился
// (медиатека заменяет массив при изменении, а «+ в плейлист» меняет длину — это и проверяем)
const indexes = new WeakMap();
const signature = (list) => `${list.length}|${list[0] ? keyOf(list[0]) : ""}|${list.length ? keyOf(list[list.length - 1]) : ""}`;
function indexOf(list) {
  const sig = signature(list);
  let ix = indexes.get(list);
  if (!ix || ix.sig !== sig) {
    const map = new Map();
    for (const t of list) {
      for (const k of new Set([keyOf(t), ...bucketKeys(t)])) {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(t);
      }
    }
    ix = { sig, map };
    indexes.set(list, ix);
  }
  return ix.map;
}

/** Загрузки той же песни в списке (и сама эта загрузка, если она там есть) */
export function twinsIn(list, track) {
  if (!track || !list?.length) return [];
  const map = indexOf(list);
  const found = new Set(map.get(keyOf(track)) ?? []);
  for (const k of bucketKeys(track)) for (const t of map.get(k) ?? []) if (!found.has(t) && sameSong(t, track)) found.add(t);
  return [...found];
}

/** Сколько песен в списке (две загрузки одной песни — одна) */
const counts = new WeakMap();
export function songCount(list) {
  if (!list?.length) return 0;
  const sig = signature(list);
  const c = counts.get(list);
  if (c?.sig === sig) return c.n;
  const n = groupSongs(list).length;
  counts.set(list, { sig, n });
  return n;
}

/** Каждая песня один раз — первая (самая верхняя) загрузка: для «Недавно слушали» */
export const uniqueSongs = (list) => groupSongs(list).map((g) => g.members[0]);
