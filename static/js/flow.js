// Flow — бесконечная подборка по вкусу (как «Моя волна»).
// Вкус = исполнители из избранного, скачанного, истории, плейлистов и статистики + любимые треки +
// то, чему Flow научился сам: пропустил трек в первые 30 секунд — исполнитель и трек реже, дослушал — чаще
// (settings.flowTaste — исполнители, settings.flowTracks — треки; старое постепенно забывается).
// Внутри сеанса Flow подстраивается сразу: два пропуска подряд — всё, что впереди, пересобирается.
// Сервер (/api/flow) по вкусу собирает порцию треков из базы; пока играет — подкладываем следующую.

import { getPlaylist, getSetting, isDisliked, keyOf, lib, setSetting } from "./library.js";
import { isMeta, resolveMeta } from "./meta.js";
import { splitArtists } from "./nav.js";
import { extendQueue, onQueueEnd, onTrackChange, play, replaceUpcoming, state } from "./player.js";
import { displayTrack, toast } from "./ui.js";

export const FLOW_MODES = [
  { value: "liked", title: "Любимое", hint: "Больше того, что уже нравится" },
  { value: "mix", title: "Микс", hint: "Любимое вперемешку с новым" },
  { value: "discover", title: "Открытия", hint: "Исполнители, которых вы ещё не слышали" },
];
// Настройки Flow: под занятие, настроение, язык (settings.flowTune). Сервер подстраивает подборку
// по жанрам — «any» значит без ограничений. Действуют на общий Flow, не на радио по треку/исполнителю
export const FLOW_TUNE = [
  { key: "activity", title: "Занятие", options: [["any", "Любое"], ["sport", "Спорт"], ["study", "Учёба и работа"],
    ["party", "Вечеринка"], ["rest", "Отдых"]] },
  { key: "mood", title: "Настроение", options: [["any", "Любое"], ["energy", "Бодрое"], ["calm", "Спокойное"]] },
  { key: "lang", title: "Язык", options: [["any", "Любой"], ["ru", "Русское"], ["foreign", "Зарубежное"]] },
];
export const flowTune = () => getSetting("flowTune", {});
/** Коротко, что выбрано: «Спорт · Русское» (пусто — ничего) */
export const tuneSummary = () => FLOW_TUNE.map(({ key, options }) => options.find(([v]) => v === flowTune()[key] && v !== "any")?.[1])
  .filter(Boolean).join(" · ");

// Как часто вставлять трек прямо из избранного (каждый N-й)
const LIKED_EVERY = { liked: 3, mix: 6, discover: 0 };
const DAY = 864e5;
const HALF_LIFE = 60 * DAY;   // выученное «весит» вдвое меньше через 2 месяца — вкус меняется

const audio = document.getElementById("player");
const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Ключ «исполнитель|название» — такой же, как track_key() в flow.py */
const songKey = (t) => {
  const shown = displayTrack(t);
  const first = shown.artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?)\s+/i)[0];
  return `${norm(first)}|${norm(shown.title.replace(/\s*[(\[].*?[)\]]/g, ""))}`;
};
const firstArtist = (t) => splitArtists(t, displayTrack(t).artist)[0]?.name ?? "";
/** Вес выученного с учётом давности */
const decayed = (item, now = Date.now()) => item.weight * 0.5 ** (Math.max(0, now - (item.t ?? now)) / HALF_LIFE);

// { context, mode, artist, playlist, track, mix, played: Set, loading, likedPos,
//   skips — пропуски подряд, avoid — кого пропускали в этом сеансе, liked — что дослушали, recent — последние исполнители }
let session = null;

export const isFlow = (ctx = state.context) => ctx?.type === "flow";
export const flowMode = () => getSetting("flowMode", "mix");

// ---------- Вкус ----------

function taste() {
  const weights = new Map();   // нормализованное имя → { name, id, weight }
  const bump = (name, id, w) => {
    const key = norm(name);
    if (!key || key === "неизвестный автор") return;
    const item = weights.get(key) ?? { name, id: null, weight: 0 };
    item.weight += w;
    item.id ??= id ?? null;
    weights.set(key, item);
  };
  const add = (track, w) => splitArtists(track, displayTrack(track).artist).forEach(({ name, id }) => bump(name, id, w));
  // Свежие лайки весят больше старых (избранное хранится новыми сверху)
  lib.liked.forEach((t, i) => add(t, 3 * Math.max(0.4, 1 - i / 300)));
  lib.downloads.forEach((t) => add(t, 2));
  lib.history.forEach((t) => add(t, 1));
  lib.playlists.forEach((p) => p.tracks.slice(0, 200).forEach((t) => add(t, 0.5)));
  lib.disliked.forEach((t) => add(t, -3));
  // Сколько человек на самом деле слушал: час ≈ трек в избранном; давно не слушал — меньше
  const now = Date.now();
  for (const a of Object.values(lib.stats?.artists ?? {})) {
    const fresh = 0.5 ** (Math.max(0, now - (a.last ?? now)) / HALF_LIFE);
    bump(a.name, a.id, Math.min(6, a.sec / 1200) * fresh);
  }
  for (const item of Object.values(getSetting("flowTaste", {}))) bump(item.name, null, decayed(item, now));
  const ids = getSetting("flowArtistIds", {});
  const list = [...weights.values()].map((a) => (a.id ? a : { ...a, id: ids[norm(a.name)] ?? null }));
  return {
    all: list,
    seeds: list.filter((a) => a.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 30),
    banned: list.filter((a) => a.weight <= -4).map((a) => a.name),
    avoid: list.filter((a) => a.weight < 0 && a.weight > -4).map(({ name, weight }) => ({ name, weight })),
  };
}

/** Любимые треки — от них сервер берёт «похожие треки». Немного случайно: каждая порция чуть другая */
function trackSeeds(source = null) {
  const items = new Map();   // ключ → { key, id, artist, title, duration, weight }
  const add = (t, w) => {
    if (!t || w <= 0) return;
    const key = songKey(t);
    const shown = displayTrack(t);
    const item = items.get(key) ?? { key, id: t.metaId || (isMeta(t) ? t.id : null), artist: firstArtist(t) || shown.artist,
                                     title: t.origTitle || shown.title, duration: t.duration, weight: 0,
                                     sc: t.source === "soundcloud" ? t.id : null };   // от него — «похожие» SoundCloud
    item.weight += w;
    items.set(key, item);
  };
  if (source) source.forEach((t) => add(t, 1));
  else {
    lib.liked.slice(0, 150).forEach((t, i) => add(t, 3 / (1 + i * 0.03)));
    lib.downloads.slice(0, 50).forEach((t) => add(t, 1));
    for (const item of Object.values(getSetting("flowTracks", {}))) {
      const w = decayed(item);
      if (w > 0) add({ ...item.track, duration: item.track.duration }, w);
    }
  }
  session?.liked.forEach((t) => add(t, 6));   // дослушанное в этом сеансе — сильнее всего
  const cached = getSetting("flowYaIds", {});
  const list = [...items.values()].map((t) => ({ ...t, id: t.id || cached[t.key] || null }));
  // 6 штук: вероятность — по весу
  const out = [];
  while (list.length && out.length < 6) {
    const total = list.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    const i = Math.max(0, list.findIndex((t) => (r -= t.weight) <= 0));
    out.push(list.splice(i, 1)[0]);
  }
  return out;
}

/** Сервер нашёл id треков и исполнителей в базе — запоминаем, чтобы в следующий раз не искать */
function rememberIds(tracks, people) {
  if (tracks && Object.keys(tracks).length) {
    const all = { ...getSetting("flowYaIds", {}), ...tracks };
    setSetting("flowYaIds", Object.fromEntries(Object.entries(all).slice(-500)));
  }
  if (people && Object.keys(people).length) {
    const all = { ...getSetting("flowArtistIds", {}) };
    for (const [name, id] of Object.entries(people)) all[norm(name)] = id;
    setSetting("flowArtistIds", Object.fromEntries(Object.entries(all).slice(-500)));
  }
}

// ---------- Вкус для поиска ----------
// Поиск поднимает выше треки исполнителей, которых вы слушаете. Вес — тот же вкус Flow.
let tasteCache = null, tasteAt = 0;

function tasteMap() {
  if (tasteCache && Date.now() - tasteAt < 10000) return tasteCache;   // пока печатают — не пересчитываем
  const map = new Map();
  const { all, banned } = taste();
  all.forEach((a) => {
    const key = norm(a.name);
    map.set(key, a.weight);
    // «Группа КИНО» и «КИНО» — один исполнитель (так пишут по-разному на YouTube и в Яндексе)
    const bare = key.replace(/^группа /, "");
    if (bare !== key && !map.has(bare)) map.set(bare, a.weight);
  });
  banned.forEach((name) => map.set(norm(name), -5));
  tasteCache = map;
  tasteAt = Date.now();
  return map;
}

/** Насколько исполнитель трека в вашем вкусе: 0 — незнаком, > 0 — слушаете, < 0 — не нравится */
export function tasteOf(track) {
  const map = tasteMap();
  const names = splitArtists(track, displayTrack(track).artist).map((a) => norm(a.name).replace(/^группа /, ""));
  names.push(norm((track.channel || "").replace(/\s*-\s*topic$|vevo$/i, "")));
  let best = 0;
  for (const n of names) {
    const w = n ? map.get(n) ?? 0 : 0;
    if (Math.abs(w) > Math.abs(best)) best = w;
  }
  return best;
}

/** Исполнители, из которых сейчас складывается вкус (для экрана Flow): [{ name, id, weight }] */
export const tasteArtists = (n = 10) => taste().seeds.slice(0, n);

/** Есть ли у человека хоть какой-то вкус (иначе Flow предложит выбрать исполнителей) */
export const hasTaste = () => taste().seeds.length > 0;

/** Что Flow выучил сам (пропуски и дослушивания): сколько исполнителей звучит чаще и реже */
export function learnedSummary() {
  const items = Object.values(getSetting("flowTaste", {})).map((i) => decayed(i)).filter((w) => Math.abs(w) >= 0.25);
  return { more: items.filter((w) => w > 0).length, less: items.filter((w) => w < 0).length };
}

export function resetLearning() {
  setSetting("flowTaste", {});
  setSetting("flowTracks", {});
}

/** Новый человек выбрал любимых исполнителей — они становятся началом вкуса */
export function seedTaste(picked) {
  const map = { ...getSetting("flowTaste", {}) };
  const now = Date.now();
  for (const { name } of picked) map[norm(name)] = { name, weight: 4, t: now };
  setSetting("flowTaste", map);
  tasteCache = null;
}

/** Играет ли сейчас Flow (любой: общий, по исполнителю, по плейлисту, по треку) */
export const flowPlaying = () => isFlow() && !!state.current;

/** Обновить запись выученного: вес с учётом давности + delta, не больше ±8, хранить не больше limit */
function bumpLearned(setting, key, base, delta, limit) {
  const map = { ...getSetting(setting, {}) };
  const now = Date.now();
  const item = map[key] ? { ...map[key], weight: decayed(map[key], now) } : { ...base, weight: 0 };
  item.weight = Math.max(-8, Math.min(8, item.weight + delta));
  item.t = now;
  map[key] = item;
  const entries = Object.entries(map).sort((a, b) => Math.abs(decayed(b[1], now)) - Math.abs(decayed(a[1], now)));
  setSetting(setting, Object.fromEntries(entries.slice(0, limit)));
}

/** Flow учится: пропуск в первые 30 с — минус исполнителю и треку, дослушал — плюс */
function learn(track, listened) {
  const duration = track.duration || audio.duration || 0;
  let delta = 0;
  if (listened < 30 && duration > 60) delta = -1;
  else if (duration && listened > duration * 0.7) delta = 0.5;
  if (!delta) return;
  const name = firstArtist(track);
  if (!name) return;
  bumpLearned("flowTaste", norm(name), { name }, delta, 300);
  const t = { source: track.source, id: track.id, metaId: track.metaId, title: track.title, origTitle: track.origTitle,
              artists: track.artists, channel: track.channel, duration: track.duration };
  bumpLearned("flowTracks", songKey(track), { track: t }, delta * 2, 200);
  tasteCache = null;
  if (!session) return;
  // Этот сеанс: пропуски подряд → Flow меняет курс сразу, не дожидаясь следующей порции
  session.recent = [name, ...session.recent].slice(0, 8);
  if (delta < 0) {
    session.avoid.set(norm(name), { name, weight: (session.avoid.get(norm(name))?.weight ?? 0) - 2 });
    session.skips += 1;
    if (session.skips >= 2) steer();
  } else {
    session.skips = 0;
    session.liked = [track, ...session.liked].slice(0, 5);
  }
}

/** Два пропуска подряд — пересобираем всё, что впереди, с учётом пропущенного */
async function steer() {
  if (!session || session.loading || !isFlow() || state.context.id !== session.context.id) return;
  session.skips = 0;
  session.loading = true;
  try {
    replaceUpcoming(await fetchBatch(8));
    toast("Понял — Flow меняет подборку");
  } catch (err) {
    console.log("[flow]", err.message);
  } finally {
    session.loading = false;
  }
}

// ---------- Порции ----------

/** Исполнители списка с весами — вкус Flow по плейлисту (остальная медиатека не учитывается) */
function listSeeds(tracks) {
  const weights = new Map();
  for (const t of tracks) {
    for (const { name, id } of splitArtists(t, displayTrack(t).artist)) {
      const key = norm(name);
      if (!key || key === "неизвестный автор") continue;
      const item = weights.get(key) ?? { name, id: null, weight: 0 };
      item.weight += 1;
      item.id ??= id;
      weights.set(key, item);
    }
  }
  return [...weights.values()].sort((a, b) => b.weight - a.weight).slice(0, 30);
}

/** Любимые треки исполнителей микса — от них «похожие треки» */
const mixTracks = (mix) => {
  const names = new Set(mix.artists.map((a) => norm(a.name)));
  return lib.liked.filter((t) => splitArtists(t, displayTrack(t).artist).some((a) => names.has(norm(a.name))));
};

// s — сеанс, для которого порция (по умолчанию — текущий; заготовка warmFlow — свой, временный)
async function fetchBatch(size = 10, { quick = false, s = session } = {}) {
  const { all, seeds, banned, avoid } = taste();
  const pl = s.playlist, one = s.track, mix = s.mix;
  // Flow по исполнителю — только он и похожие; по плейлисту — только его исполнители и похожие на них;
  // радио по треку — его исполнители и похожие на сам трек; микс — его исполнители (вес — из вкуса)
  const weightOf = new Map(all.map((a) => [norm(a.name), a.weight]));
  const ownSeeds = s.artist ? [{ name: s.artist.name, id: s.artist.id, weight: 30 }]
    : one ? listSeeds([one]).map((s) => ({ ...s, weight: 30 }))
    : mix ? mix.artists.map((a) => ({ name: a.name, id: a.id, weight: Math.max(1, weightOf.get(norm(a.name)) ?? 1) }))
    : pl ? listSeeds(pl.tracks) : seeds;
  const tracks = s.artist ? [] : trackSeeds(one ? [one] : mix ? mixTracks(mix) : pl ? pl.tracks : null);
  const exclude = new Set(s.played);
  for (const t of [...lib.liked, ...lib.history, ...lib.disliked, ...(pl?.tracks ?? [])]) {
    exclude.add(songKey(t));
    if (t.metaId) exclude.add(t.metaId);
  }
  const avoidAll = new Map(avoid.map((a) => [norm(a.name), a]));
  s.avoid.forEach((a, k) => avoidAll.set(k, { name: a.name, weight: (avoidAll.get(k)?.weight ?? 0) + a.weight }));
  const res = await fetch("/api/flow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seeds: ownSeeds, tracks,
      mode: s.artist || pl || one || mix ? "mix" : s.mode,
      exclude: [...exclude].slice(-3000), banned, size,
      avoid: [...avoidAll.values()],
      known: all.filter((a) => a.weight > 0).map((a) => a.name).slice(0, 2000),
      recent: s.recent, quick,
      tune: s.artist || pl || one || mix ? {} : flowTune(),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Flow не ответил");
  rememberIds(data.seedIds, data.artistIds);
  let list = data.tracks;
  list.forEach((t) => {
    s.played.add(t.id);
    s.played.add(songKey(t));
    // В радио по исполнителю/треку/плейлисту «Вы слушаете X» звучит странно — там это просто «Ещё X»
    if ((s.artist || one || pl || mix) && t.because) t.because = t.because.replace(/^Вы слушаете /, "Ещё ");
  });
  // Иногда — трек прямо из избранного (или из самого плейлиста): он уже с YouTube/SoundCloud и стартует сразу
  const own = pl ? pl.tracks : mix ? mixTracks(mix) : lib.liked;
  const every = s.artist || one ? 0 : pl ? 4 : mix ? 5 : LIKED_EVERY[s.mode];
  if (every && own.length) {
    const out = [];
    for (const t of list) {
      out.push(t);
      if (++s.likedPos % every === 0) {
        const fav = own[Math.floor(Math.random() * own.length)];
        if (!s.played.has(keyOf(fav))) {
          s.played.add(keyOf(fav));
          out.push({ ...fav, because: pl ? `Из «${pl.name}»` : "Из избранного" });
        }
      }
    }
    list = out;
  }
  return list;
}

/** Подборка по вашему вкусу без Flow-сеанса — для «Собрано для вас» на «Главной» (picks.js).
    mode — как у Flow (liked/mix/discover), tune — занятие/настроение/язык ({} — без них).
    Вкуса нет — пусто (новичку подборки не показываем). Треки — «из базы», пары ищет picks.js */
export async function tasteBatch({ mode = "mix", size = 25, tune = {}, exclude = [] } = {}) {
  const { all, seeds, banned, avoid } = taste();
  if (!seeds.length) return [];
  const skip = new Set(exclude);
  for (const t of [...lib.liked, ...lib.history.slice(0, 200), ...lib.disliked]) {
    skip.add(songKey(t));
    if (t.metaId) skip.add(t.metaId);
  }
  const res = await fetch("/api/flow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seeds, tracks: trackSeeds(null), mode, exclude: [...skip].slice(-3000), banned, size, avoid,
      known: all.filter((a) => a.weight > 0).map((a) => a.name).slice(0, 2000), recent: [], tune,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Flow не ответил");
  rememberIds(data.seedIds, data.artistIds);
  return data.tracks;
}

/** Умное перемешивание (как в Spotify): список вперемешку, а после каждых двух его треков — рекомендация
    в его духе (исполнители и треки списка → /api/flow, как Flow по плейлисту). Играет сразу, рекомендации
    вставляются, когда придут. В очереди они помечены «✦», у трека — «because»: «Рекомендация · похоже на …» */
export async function smartShuffle({ name, tracks, context }) {
  const own = tracks.filter((t) => !isDisliked(t));
  if (!own.length) return;
  const mixed = own.slice();
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
  }
  const ctx = { ...context, smart: true };
  play(mixed[0], mixed, 0, ctx);
  toast(`Умное перемешивание: «${name}» и похожие треки`);
  const exclude = new Set();
  for (const t of [...own, ...lib.liked, ...lib.disliked, ...lib.history.slice(0, 200)]) {
    exclude.add(songKey(t));
    if (t.metaId) exclude.add(t.metaId);
  }
  try {
    const res = await fetch("/api/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seeds: listSeeds(own), tracks: trackSeeds(own), mode: "mix", exclude: [...exclude].slice(-3000),
        banned: taste().banned, size: Math.min(25, Math.max(4, Math.ceil(own.length / 2))), known: [], recent: [], tune: {},
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (state.context !== ctx) return;   // пока подбирали, включили другое
    const recs = data.tracks.map((t) => ({
      ...t, smart: true,
      because: `Рекомендация${t.because ? ` · ${t.because.replace(/^Вы слушаете /, "ещё ").replace(/^Похоже/, "похоже")}` : ""}`,
    }));
    const out = [];
    let r = 0;
    state.queue.slice(state.index + 1).forEach((t, i) => {
      out.push(t);
      if (i % 2 === 1 && r < recs.length) out.push(recs[r++]);
    });
    if (!out.length && recs.length) out.push(recs[r++]);   // в списке один трек — хоть одна рекомендация после него
    replaceUpcoming(out);
  } catch {
    if (state.context === ctx) toast("Не получилось подобрать похожие треки — играет просто вперемешку");
  }
}

/** Ключ «исполнитель|название» — для подборок (не повторять одну песню с разных загрузок) */
export { songKey };

// ---------- Заготовка Flow ----------
// Обычный Flow стартует мгновенно с любимого трека. А «Открытия» (и Flow без избранного) ждали порцию
// и пару для первого трека — 2–5 с тишины. Поэтому порцию собираем заранее: через 8 с после запуска,
// при наведении на ▶ Flow и при смене режима/настроек. Звук первого трека тоже готовится (prefetch).
// Заготовка годна 10 минут и только для того же режима и настроек.

let warm = null;   // { key, at, job: обещание { tracks, first, played } }
const WARM_TTL = 10 * 60 * 1000;
const warmKey = (mode) => `${mode}|${JSON.stringify(flowTune())}|${lib.liked.length}`;
/** Начнётся ли обычный Flow без ожидания (с любимого трека) */
const startsInstantly = (mode) => mode !== "discover" && lib.liked.some((t) => !isMeta(t));

export function warmFlow(mode = flowMode()) {
  if (startsInstantly(mode) || !hasTaste() || (session && isFlow())) return;
  const key = warmKey(mode);
  if (warm && warm.key === key && Date.now() - warm.at < WARM_TTL) return;
  const s = { mode, played: new Set(), likedPos: 0, avoid: new Map(), recent: [] };
  const job = fetchBatch(8, { quick: true, s }).then(async (tracks) => {
    if (!tracks.length) throw new Error("пусто");
    return { tracks, first: await firstPlayable(tracks), played: s.played };
  });
  warm = { key, at: Date.now(), job };
  job.catch(() => { if (warm?.job === job) warm = null; });
}

/** Взять заготовку (один раз), если она для этого режима и ещё свежая */
function takeWarm(mode) {
  const w = warm;
  warm = null;
  return w && w.key === warmKey(mode) && Date.now() - w.at < WARM_TTL ? w.job.catch(() => null) : null;
}

/** Первый трек порции, у которого нашлась пара (ищем у трёх сразу) — чтобы старт не ждал ненайденный */
function firstPlayable(tracks) {
  const tries = tracks.slice(0, 3).map((t, i) => resolveMeta(t, { prefetch: true }).then((r) => {
    if (!r) throw new Error("нет пары");
    return i;
  }));
  return Promise.any(tries).catch(() => 0);   // кто первым нашёлся, тот и играет
}

/** Включить Flow. artist — Flow «по исполнителю» (со страницы исполнителя),
    playlist — Flow по плейлисту ({ id, name, tracks }): вкус — только этот плейлист,
    track — радио по треку: сначала сам трек, дальше похожее на него,
    mix — «Ваш микс» ({ id, name, artists }): группа похожих любимых исполнителей */
export async function startFlow({ mode = flowMode(), artist = null, playlist = null, track = null, mix = null,
                                  quiet = false } = {}) {
  const context = artist ? { type: "flow", id: `artist-${artist.id}`, name: `Flow: ${artist.name}` }
    : track ? { type: "flow", id: `track-${keyOf(track)}`, name: `Радио: ${displayTrack(track).title}` }
    : mix ? { type: "flow", id: `mix-${mix.id}`, name: `Микс: ${mix.name}` }
    : playlist ? { type: "flow", id: `playlist-${playlist.id}`, name: `Flow: ${playlist.name}` }
    : { type: "flow", id: "main", name: "Flow" };
  session = { context, mode, artist, playlist, track, mix, played: new Set(), loading: true, likedPos: 0,
              skips: 0, avoid: new Map(), liked: [], recent: [] };
  const mine = session;
  if (!quiet) toast(artist ? `Flow по исполнителю «${artist.name}»` : track ? `Радио по треку «${displayTrack(track).title}»`
    : mix ? `Микс: ${mix.name}`
    : playlist ? `Flow по плейлисту «${playlist.name}»` : "Собираю Flow…");
  // Мгновенный старт: радио по треку начинается с самого трека, обычный Flow — с любимого трека,
  // пока сервер собирает порцию (в «Открытиях» — нет: там ждут нового)
  let instant = null;
  if (track) instant = track;
  else if (!artist && !playlist && !mix && mode !== "discover" && lib.liked.length) {
    const fav = lib.liked[Math.floor(Math.random() * Math.min(lib.liked.length, 40))];
    if (!isMeta(fav)) instant = { ...fav, because: "Из избранного" };
  }
  if (instant) {
    session.played.add(keyOf(instant));
    session.played.add(songKey(instant));
    play(instant, [instant], 0, context);
  }
  try {
    // Заготовка (warmFlow) — порция и пара первого трека уже есть: играет сразу
    const ready = !instant && context.id === "main" ? await takeWarm(mode) : null;
    if (session !== mine) return;
    if (ready) ready.played.forEach((k) => session.played.add(k));
    // Первая порция — быстрая (без второго круга запросов): Flow заиграет быстрее, следующие — полные
    const tracks = ready ? ready.tracks : await fetchBatch(instant ? 10 : 8, { quick: !instant });
    if (session !== mine) return;
    if (instant) return extendQueue(tracks);
    if (!tracks.length) return toast("Flow не нашёл, что включить — послушайте и полайкайте что-нибудь", { error: true });
    const first = ready ? ready.first : await firstPlayable(tracks);
    if (session !== mine) return;
    // Перемешивание во Flow не нужно — порция и так случайная
    const queue = [tracks[first], ...tracks.filter((_, i) => i !== first)];
    play(queue[0], queue, 0, context);
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    mine.loading = false;
  }
}

/** Сменить режим. Если Flow уже играет — всё, что впереди, пересобирается */
export async function setFlowMode(mode) {
  setSetting("flowMode", mode);
  warmFlow(mode);   // Flow не играет — заготовим порцию нового режима (иначе вернётся сразу)
  if (!session || !isFlow() || session.artist || session.playlist || session.track || session.mix) return;
  session.mode = mode;
  rebuildUpcoming();
}

// Пересобрать то, что впереди. Нажали несколько кнопок подряд — берём только ответ на последнее нажатие
// (иначе ответ на первое мог прийти позже и затереть второе)
let rebuildSeq = 0;
async function rebuildUpcoming() {
  const mine = ++rebuildSeq;
  session.loading = true;
  try {
    const batch = await fetchBatch(10);
    if (mine === rebuildSeq) replaceUpcoming(batch);
  } catch (err) {
    if (mine === rebuildSeq) toast(err.message, { error: true });
  } finally {
    if (mine === rebuildSeq) session.loading = false;
  }
}

/** Сменить настройку (занятие/настроение/язык). Играет общий Flow — впереди пересобирается под неё */
export async function setFlowTune(key, value) {
  setSetting("flowTune", { ...flowTune(), [key]: value });
  warmFlow();
  if (!session || !isFlow() || session.artist || session.playlist || session.track || session.mix) return;
  rebuildUpcoming();
}

// Пока играет — подкладываем следующую порцию и заранее ищем пары трекам впереди
async function keepFlowing() {
  if (!session || !isFlow() || state.context.id !== session.context.id) return;
  for (const t of state.queue.slice(state.index + 1, state.index + 4)) resolveMeta(t).catch(() => {});
  if (session.loading || state.queue.length - state.index - 1 >= 4) return;
  session.loading = true;
  try {
    extendQueue(await fetchBatch(10));
  } catch (err) {
    console.log("[flow]", err.message);
  } finally {
    session.loading = false;
  }
}

// ---------- «Ваши миксы» ----------
// Вкус, разбитый на группы похожих исполнителей (русский рок, рэп, зарубежный поп…) — на «Главной».
// Считаем раз в полчаса: группы меняются медленно, а «Главная» перерисовывается при каждом треке.

let mixesCache = null, mixesAt = 0, mixesLoading = null;

/** Уже посчитанные миксы (без запроса) или null */
export const cachedMixes = () => (mixesCache && Date.now() - mixesAt < 30 * 60e3 ? mixesCache : null);

/** Миксы: [{ id, name, artists: [{ name, id, picture }] }] */
export function tasteMixes() {
  if (cachedMixes()) return Promise.resolve(mixesCache);
  if (mixesLoading) return mixesLoading;
  const { seeds } = taste();
  if (seeds.length < 3) return Promise.resolve([]);
  mixesLoading = fetch("/api/flow/mixes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seeds: seeds.slice(0, 16) }),
  })
    .then((res) => (res.ok ? res.json() : { mixes: [] }))
    .then(({ mixes }) => {
      mixesCache = (mixes ?? []).map((m) => {
        const names = m.artists.map((a) => a.name);
        return { ...m, id: norm(names[0]).replace(/ /g, "-"), name: names.length > 2 ? `${names[0]}, ${names[1]} и др.` : names.join(", ") };
      });
      mixesAt = Date.now();
      return mixesCache;
    })
    .catch(() => [])
    .finally(() => { mixesLoading = null; });
  return mixesLoading;
}

// ---------- Flow после конца очереди ----------
// Плейлист (или один трек) доиграл — продолжаем Flow в его духе: вкус — только эти треки.

export const autoFlowEnabled = () => getSetting("autoFlow", true) !== false;

function continueWithFlow() {
  // Flow из прошлого сеанса (restored) сам больше не подкладывает треки — продолжаем его так же, как плейлист
  if (!autoFlowEnabled() || (isFlow() && !state.context.restored) || !state.queue.length) return;
  const ctx = state.context ?? {};
  const name = ctx.name || (ctx.type === "playlist" && getPlaylist(ctx.id)?.name)
    || (ctx.type === "liked" && "Избранное") || "продолжение";
  toast("Очередь закончилась — дальше Flow в том же духе");
  startFlow({ playlist: { id: "continue", name, tracks: state.queue.slice(-50) }, quiet: true });
}

// ---------- Подключение ----------

let current = null;   // { track, maxPos } — сколько прослушали текущий трек
export function initFlow() {
  onQueueEnd(continueWithFlow);
  setTimeout(() => warmFlow(), 8000);   // после запуска, когда всё уже загрузилось
  audio.addEventListener("timeupdate", () => {
    if (current && audio.currentTime > current.maxPos) current.maxPos = audio.currentTime;
  });
  onTrackChange(() => {
    const now = state.current;
    if (now && current && keyOf(current.track) !== keyOf(now)) {
      // Трек из базы сменился найденной парой — это тот же трек, а не пропуск.
      // Учимся только на реально игравших (у ненайденного трека «прослушано 0 с» — не его вина)
      const samePiece = isMeta(current.track) && now.metaId === current.track.id;
      if (!samePiece && current.flow && !isMeta(current.track)) learn(current.track, current.maxPos);
      current = null;
    }
    if (now && !current) current = { track: now, maxPos: 0, flow: isFlow() };
    keepFlowing();
  });
}
