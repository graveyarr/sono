// Статистика прослушивания: сколько вы слушаете каждого исполнителя и с какого дня.
// Время копится, только пока трек действительно играет (перемотка и пауза не считаются).
// У трека нескольких исполнителей («A, B feat. C») время засчитывается каждому.
// Хранится в медиатеке, раздел stats: { since, total, artists: { ключ: { name, id, sec, plays, first, last } },
//   years: { "2026": { from, total, artists: {ключ: {name, id, sec, plays}}, tracks: {«источник:id»: {t, sec, plays}},
//            months: [12 × сек], hours: [24 × сек], days: {«ММДД»: сек} } } } — по годам, для «Итогов года» (wrapped.js).
// Показывается на экране «Ваша статистика» (из «Главной») и строкой на странице исполнителя.
// С нового вида ещё: у года — ctx {откуда: сек} (Flow, «Избранное», плейлист…), у трека года — f (когда услышан впервые);
// daily {«ГГГГ-ММ-ДД»: { a: {ключ: [сек, прослушиваний]}, t: {«источник:id»: [сек, прослушиваний]}, c: {откуда: сек} }}
// за последние 32 дня (dailyFrom — с какого момента пишем) — для «Недели» и «Месяца» на экране статистики (statslive.js).

import { getSetting, keyOf, lib, slim, statsChanged } from "./library.js";
import { artistByName } from "./meta.js";
import { openArtist, openView, splitArtists } from "./nav.js";
import { onTrackChange, state } from "./player.js";
import { groupSongs, uniqueSongs } from "./samesong.js";
import { displayTrack, el, imgUrl, plural } from "./ui.js";

const audio = document.getElementById("player");
const PLAY_AFTER = 30;    // столько секунд трека — уже «прослушивание»
const KEEP = 1000;        // столько исполнителей храним (самых слушаемых)
const KEEP_TRACKS = 600;  // столько треков храним за год

/** Раздел года (создаётся при первой секунде музыки в этом году) */
export function yearData(year, create = false) {
  const s = data();
  if (!s.years) {
    s.years = {};
    // Статистика по годам появилась позже общей — то, что накопилось до неё, относим к году начала
    // (треков, месяцев и часов там нет: их не записывали)
    if (s.total > 0) {
      const y = new Date(s.since).getFullYear();
      const artists = {};
      for (const [k, a] of Object.entries(s.artists)) artists[k] = { name: a.name, id: a.id, sec: a.sec, plays: a.plays };
      s.years[y] = { from: s.since, total: s.total, artists, tracks: {}, months: Array(12).fill(0), hours: Array(24).fill(0), days: {}, early: s.total };
    }
  }
  if (!s.years[year] && create) {
    s.years[year] = { from: Date.now(), total: 0, artists: {}, tracks: {}, months: Array(12).fill(0), hours: Array(24).fill(0), days: {} };
  }
  const y = s.years[year];
  if (!y || typeof y !== "object") return null;
  // Год мог прийти из чужой/испорченной копии медиатеки — дополняем недостающее, чтобы «Итоги» не падали
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const arr = (v, n) => (Array.isArray(v) && v.length === n ? v.map((x) => +x || 0) : Array(n).fill(0));
  y.total = +y.total || 0;
  y.artists = obj(y.artists);
  y.tracks = obj(y.tracks);
  y.days = obj(y.days);
  y.months = arr(y.months, 12);
  y.hours = arr(y.hours, 24);
  y.ctx = obj(y.ctx);
  return y;
}

export const artistKey = (name) => (name || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function data() {
  const s = lib.stats;
  if (!s.artists) Object.assign(s, { since: Date.now(), total: 0, artists: {} });
  return s;
}

// ---------- Подсчёт ----------

let lastPos = null;     // где был трек при прошлом «тике»
let trackSec = 0;       // сколько прослушано текущего трека
let counted = false;    // уже засчитали «прослушивание» этому треку

function credit(seconds) {
  const t = state.current;
  if (!t || t.source === "meta") return;
  const s = data();
  const now = Date.now();
  s.total += seconds;
  trackSec += seconds;
  const countPlay = !counted && trackSec >= PLAY_AFTER;
  if (countPlay) counted = true;

  // По годам: трек, месяц, час, день
  const date = new Date(now);
  const y = yearData(date.getFullYear(), true);
  y.total += seconds;
  y.months[date.getMonth()] += seconds;
  y.hours[date.getHours()] += seconds;
  const day = String(date.getMonth() + 1).padStart(2, "0") + String(date.getDate()).padStart(2, "0");
  y.days[day] = (y.days[day] || 0) + seconds;
  const tk = keyOf(t);
  const tr = y.tracks[tk] ?? (y.tracks[tk] = { t: slim(t), sec: 0, plays: 0, f: now });
  tr.sec += seconds;
  if (countPlay) tr.plays += 1;
  // Откуда слушали (Flow, «Избранное», плейлист…) и что за день — для экрана статистики
  const from = sourceKey(state.context);
  y.ctx[from] = (y.ctx[from] || 0) + seconds;
  const d = dayBucket(date);
  d.c[from] = (d.c[from] || 0) + seconds;
  const dt = d.t[tk] ?? (d.t[tk] = [0, 0]);
  dt[0] += seconds;
  if (countPlay) dt[1] += 1;

  for (const { name, id } of splitArtists(t, displayTrack(t).artist)) {
    const key = artistKey(name);
    if (!key || key === "неизвестный автор") continue;
    const a = s.artists[key] ?? (s.artists[key] = { name, id: null, sec: 0, plays: 0, first: now, last: now });
    a.sec += seconds;
    a.last = now;
    if (id && !a.id) a.id = id;
    if (countPlay) a.plays += 1;
    const ya = y.artists[key] ?? (y.artists[key] = { name, id: null, sec: 0, plays: 0 });
    ya.sec += seconds;
    if (id && !ya.id) ya.id = id;
    if (countPlay) ya.plays += 1;
    const da = d.a[key] ?? (d.a[key] = [0, 0]);
    da[0] += seconds;
    if (countPlay) da[1] += 1;
  }
  statsChanged();
}

/** Откуда играет трек — для плитки «чаще всего»: flow:mix (основной Flow и его режим), flow (Flow по исполнителю,
 *  плейлисту, треку), liked, pl:<id>, album, artist, search… */
function sourceKey(ctx) {
  if (!ctx?.type) return "other";
  if (ctx.type === "flow") return ctx.id === "main" ? `flow:${getSetting("flowMode", "mix")}` : "flow";
  if (ctx.type === "playlist") return `pl:${ctx.id}`;
  return String(ctx.type).replace(/[^a-z]/g, "") || "other";
}

/** Ключ дня «2026-11-19» (по местному времени) */
export const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const KEEP_DAYS = 32;   // столько дней храним подробно (неделя и месяц)

function dayBucket(date) {
  const s = data();
  if (!s.daily || typeof s.daily !== "object" || Array.isArray(s.daily)) s.daily = {};
  s.dailyFrom ??= date.getTime();
  const k = dayKey(date);
  const d = s.daily[k] ?? (s.daily[k] = { a: {}, t: {}, c: {} });
  for (const f of ["a", "t", "c"]) if (!d[f] || typeof d[f] !== "object") d[f] = {};
  return d;
}

/** Дни старше месяца — убираем (раздел не растёт) */
function trimDaily() {
  const s = data();
  if (!s.daily) return;
  const oldest = dayKey(new Date(Date.now() - KEEP_DAYS * 86400000));
  for (const k of Object.keys(s.daily)) if (k < oldest) delete s.daily[k];
}

function onTime() {
  const pos = audio.currentTime;
  if (!audio.paused && lastPos !== null) {
    const delta = (pos - lastPos) / (audio.playbackRate || 1);   // в настоящих секундах (со скоростью эффектов)
    if (delta > 0 && delta < 2) credit(delta);                     // больше 2 с за «тик» — это перемотка
  }
  lastPos = pos;
}

function trim() {
  const s = data();
  const keys = Object.keys(s.artists);
  if (keys.length <= KEEP * 1.1) return;
  keys.sort((a, b) => s.artists[b].sec - s.artists[a].sec).slice(KEEP).forEach((k) => delete s.artists[k]);
}

/** За год храним самые слушаемые треки и исполнителей — чтобы раздел не рос бесконечно */
function trimYear() {
  const y = yearData(new Date().getFullYear());
  if (!y) return;
  for (const [field, keep] of [["tracks", KEEP_TRACKS], ["artists", KEEP]]) {
    const keys = Object.keys(y[field]);
    if (keys.length <= keep * 1.1) continue;
    keys.sort((a, b) => y[field][b].sec - y[field][a].sec).slice(keep).forEach((k) => delete y[field][k]);
  }
}

export function initStats() {
  audio.addEventListener("timeupdate", onTime);
  audio.addEventListener("seeking", () => { lastPos = null; });
  audio.addEventListener("emptied", () => { lastPos = null; });
  let key = null;
  onTrackChange(() => {
    const k = state.current ? `${state.current.source}:${state.current.id}` : null;
    if (k === key) return;
    key = k;
    trackSec = 0;
    counted = false;
    lastPos = null;
    trim();
    trimYear();
    trimDaily();
  });
}

// ---------- Вид ----------

/** «4 ч 12 мин», «37 мин», «меньше минуты» */
export function formatListen(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return m ? `${h} ч ${m} мин` : `${h} ч`;
  if (m) return `${m} мин`;
  return "меньше минуты";
}

const formatDate = (ts) => new Date(ts).toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" });
const daysAgo = (ts) => Math.max(0, Math.floor((Date.now() - ts) / 86400000));

/** Статистика по исполнителю (для его страницы): по id из базы или по имени */
export function artistStats({ id, name }) {
  const s = lib.stats?.artists;
  if (!s) return null;
  return s[artistKey(name)] ?? Object.values(s).find((a) => id && a.id === id) ?? null;
}

/** Строка для страницы исполнителя: «Вы слушаете с 3 ноября 2026 · 4 ч 12 мин · 37 прослушиваний» */
export function artistStatsLine(artist) {
  const a = artistStats(artist);
  if (!a || a.sec < 30) return null;
  const days = daysAgo(a.first);
  return `Вы слушаете с ${formatDate(a.first)}${days ? ` (${plural(days, "день", "дня", "дней")})` : " — с сегодня"}`
    + ` · ${formatListen(a.sec)} · ${plural(a.plays, "прослушивание", "прослушивания", "прослушиваний")}`;
}

/** Треки исполнителя, которые вы слушали (за все годы): чаще слушаемые — первыми. Для «Вы слушали» на его странице */
export function artistTracks({ name }) {
  const want = artistKey(name);
  if (!want) return [];
  const all = new Map();
  for (const y of Object.values(lib.stats?.years ?? {})) {
    for (const [k, r] of Object.entries(y?.tracks ?? {})) {
      if (!r?.t || !splitArtists(r.t, displayTrack(r.t).artist).some((a) => artistKey(a.name) === want)) continue;
      const got = all.get(k) ?? { t: r.t, plays: 0, sec: 0 };
      got.plays += r.plays || 0;
      got.sec += r.sec || 0;
      all.set(k, got);
    }
  }
  return uniqueSongs([...all.values()].filter((x) => x.sec >= 30)
    .sort((a, b) => b.plays - a.plays || b.sec - a.sec).map((x) => x.t));
}

/** Сколько песен исполнителя у вас в «Избранном» (обе загрузки одной песни — одна) */
export function artistLikedCount({ name }) {
  const want = artistKey(name);
  if (!want) return 0;
  return uniqueSongs(lib.liked.filter((t) => splitArtists(t, displayTrack(t).artist).some((a) => artistKey(a.name) === want))).length;
}

/** Самые слушаемые исполнители */
export function topArtists(n = 50) {
  const s = lib.stats?.artists ?? {};
  return Object.values(s).filter((a) => a.sec >= 30).sort((a, b) => b.sec - a.sec).slice(0, n);
}

/** Карточка на «Главной»: «Вы слушали 12 ч · больше всего — Звери» → экран статистики */
export function statsCard() {
  const top = topArtists(3);
  if (!top.length) return null;
  const card = el("button", "stats-card");
  card.type = "button";
  const total = lib.stats.total || 0;
  card.append(el("span", "stats-card-kicker", "Ваша статистика"),
    el("span", "stats-card-big", formatListen(total)),
    el("span", "stats-card-sub", `больше всего — ${top.map((a) => a.name).join(", ")}`));
  card.addEventListener("click", () => openView("stats"));
  return card;
}

const pictures = new Map();   // имя → адрес фото (или null)

export function avatar(a, box) {
  const fill = (url) => {
    if (!url) return;
    const img = el("img");
    img.alt = "";
    img.src = imgUrl(url);
    img.onload = () => box.replaceChildren(img);
  };
  if (pictures.has(a.name)) return fill(pictures.get(a.name));
  artistByName(a.name).then((f) => { pictures.set(a.name, f?.picture ?? null); if (f && !a.id) a.id = f.id; fill(f?.picture); })
    .catch(() => {});
}

/** Экран «Ваша статистика»; extra — кнопка «Итоги года» (wrapped.js), если есть */
export function renderStats(box, extra = null) {
  const s = data();
  const top = topArtists(50);
  // Считаем тех же, кого показываем (от 30 секунд), — иначе «4 исполнителя», а в списке трое
  const counted = topArtists(Infinity).length;
  const head = el("div", "stats-head");
  head.append(el("div", "pl-kind", "Ваша статистика"), el("h1", "pl-name", formatListen(s.total || 0)),
    el("div", "pl-meta", `музыки с ${formatDate(s.since)} · ${plural(counted, "исполнитель", "исполнителя", "исполнителей")}`));
  if (extra) head.append(extra);
  const list = el("ol", "stats-list");
  const max = top[0]?.sec || 1;
  top.forEach((a, i) => {
    const li = el("li", "stats-row");
    li.style.setProperty("--i", Math.min(i, 20));
    const pic = el("span", "stats-pic", a.name.slice(0, 1).toUpperCase());
    avatar(a, pic);
    const info = el("div", "stats-info");
    const bar = el("div", "stats-bar");
    const fill = el("i");
    fill.style.width = `${Math.max(2, (a.sec / max) * 100)}%`;
    bar.append(fill);
    info.append(el("div", "stats-name", a.name), bar,
      el("div", "stats-sub", `с ${formatDate(a.first)} · ${plural(a.plays, "прослушивание", "прослушивания", "прослушиваний")}`));
    li.append(el("span", "stats-rank", String(i + 1)), pic, info, el("span", "stats-time", formatListen(a.sec)));
    if (a.id) li.dataset.warm = `artist:${a.id}`;
    li.addEventListener("click", () => openArtist({ id: a.id, name: a.name }));
    list.append(li);
  });
  const body = el("div", "pl-body");
  body.append(top.length ? list : el("p", "pl-empty", "Здесь появятся исполнители, которых вы слушаете, — со временем и датой, когда начали."));
  const hero = el("div", "pl-hero stats-hero");
  hero.style.setProperty("--hero", "hsl(250 45% 30%)");
  hero.append(head);
  box.replaceChildren(hero, body);
}

// ---------- За период: неделя, месяц, год, всё время (экран статистики на ПК — statslive.js) ----------

const MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_IN = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
const MONTHS_TO = ["январю", "февралю", "марту", "апрелю", "маю", "июню", "июлю", "августу", "сентябрю", "октябрю", "ноябрю", "декабрю"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayLong = (d) => d.toLocaleDateString("ru", { day: "numeric", month: "long" });
const capital = (text) => text[0].toUpperCase() + text.slice(1);
/** Сколько музыки было в этот день (years[год].days есть с самого начала статистики) */
const secOfDay = (d) => yearData(d.getFullYear())?.days[String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0")] || 0;

/** Источники для плитки «чаще всего»: Flow (и его режимы), «Избранное», плейлист… */
const SOURCE_NAMES = { liked: "Избранное", album: "Альбомы", artist: "Исполнители", search: "Поиск", releases: "Новинки",
  recs: "Рекомендуемые", history: "История", downloads: "Скачанное", local: "Мои файлы", track: "Страницы треков" };
const FLOW_MODE_NAMES = { liked: "Любимое", mix: "Микс", discover: "Открытия" };

function topSource(ctx) {
  const total = Object.values(ctx).reduce((a, b) => a + b, 0);
  if (total < 60) return null;
  const groups = new Map();   // подпись → { sec, modes }
  for (const [k, sec] of Object.entries(ctx)) {
    let name = null, mode = null;
    if (k === "flow" || k.startsWith("flow:")) { name = "Flow"; mode = FLOW_MODE_NAMES[k.slice(5)] ?? null; }
    else if (k.startsWith("pl:")) name = lib.playlists.find((p) => String(p.id) === k.slice(3))?.name ?? null;
    else name = SOURCE_NAMES[k] ?? null;
    if (!name) continue;
    const g = groups.get(name) ?? { name, sec: 0, modes: {} };
    g.sec += sec;
    if (mode) g.modes[mode] = (g.modes[mode] || 0) + sec;
    groups.set(name, g);
  }
  const best = [...groups.values()].sort((a, b) => b.sec - a.sec)[0];
  if (!best) return null;
  const mode = Object.entries(best.modes).sort((a, b) => b[1] - a[1])[0];
  return { name: best.name, share: best.sec / total, mode: mode?.[0] ?? null, modeShare: mode ? mode[1] / total : 0 };
}

/** Одна песня с разных загрузок — одна строка (счёт складывается) */
function mergeSongs(items) {
  return groupSongs(items.map((x) => x.t)).map((g) => {
    const parts = g.indices.map((i) => items[i]);
    const top = parts.reduce((a, b) => (b.plays > a.plays ? b : a));
    return { t: top.t, keys: parts.map((p) => keyOf(p.t)), plays: parts.reduce((a, b) => a + b.plays, 0),
      sec: parts.reduce((a, b) => a + b.sec, 0), f: Math.min(...parts.map((p) => p.f ?? Infinity)) };
  });
}

/** Ключи треков, слышанных в годы до этого */
function keysBefore(year) {
  const keys = new Set();
  for (const [y, v] of Object.entries(lib.stats?.years ?? {})) if (+y < year) Object.keys(v?.tracks ?? {}).forEach((k) => keys.add(k));
  return keys;
}

/** Статистика за период: week | month | year | all.
 *  { title, timeLabel, sec, prev, prevLabel, artists, tracks: [{ t, plays, sec }], artistCount, trackCount,
 *    newArtists, newTracks (null — не посчитать), source, bars: [{ label, title, sec }], barsTitle, detailFrom } */
export function periodStats(period, now = new Date()) {
  const s = data();
  const Y = now.getFullYear(), M = now.getMonth();
  const today = startOfDay(now);
  const out = { period, prev: null, prevLabel: "", newArtists: null, newTracks: null, detailFrom: null, bars: [] };
  let start = null, artistsRaw = [], tracksRaw = [];
  const ctx = {};

  // Подробности за неделю и месяц — из daily (пишется с dailyFrom; раньше их не было)
  const fromDaily = (from) => {
    const a = new Map(), t = new Map();
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const day = s.daily?.[dayKey(d)];
      if (!day) continue;
      const yr = yearData(d.getFullYear());
      for (const [k, v] of Object.entries(day.a ?? {})) {
        const x = a.get(k) ?? { name: s.artists[k]?.name ?? k, id: s.artists[k]?.id ?? null, sec: 0, plays: 0 };
        x.sec += +v?.[0] || 0;
        x.plays += +v?.[1] || 0;
        a.set(k, x);
      }
      for (const [k, v] of Object.entries(day.t ?? {})) {
        const known = yr?.tracks[k];
        if (!known?.t) continue;
        const x = t.get(k) ?? { t: known.t, sec: 0, plays: 0, f: known.f };
        x.sec += +v?.[0] || 0;
        x.plays += +v?.[1] || 0;
        t.set(k, x);
      }
      for (const [k, sec] of Object.entries(day.c ?? {})) ctx[k] = (ctx[k] || 0) + (+sec || 0);
    }
    artistsRaw = [...a.values()];
    tracksRaw = [...t.values()];
    if (!s.dailyFrom || s.dailyFrom > from.getTime()) out.detailFrom = s.dailyFrom || now.getTime();
  };

  if (period === "week") {
    start = addDays(today, -6);
    out.title = "7 дней";
    out.timeLabel = "музыки за 7 дней";
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      out.bars.push({ label: WEEKDAYS[d.getDay()], title: dayLong(d), sec: secOfDay(d) });
    }
    out.sec = out.bars.reduce((a, b) => a + b.sec, 0);
    let prev = 0;
    for (let i = 1; i <= 7; i++) prev += secOfDay(addDays(start, -i));
    out.prev = prev;
    out.prevLabel = "к прошлой неделе";
    out.barsTitle = "по дням";
    fromDaily(start);
  } else if (period === "month") {
    start = new Date(Y, M, 1);
    out.title = capital(MONTHS_NOM[M]);
    out.timeLabel = `музыки в ${MONTHS_IN[M]}`;
    out.sec = yearData(Y)?.months[M] ?? 0;
    const pm = M ? M - 1 : 11;
    out.prev = yearData(M ? Y : Y - 1)?.months[pm] ?? 0;
    out.prevLabel = `к ${MONTHS_TO[pm]}`;
    for (let day = 1; day <= now.getDate(); day++) {
      const d = new Date(Y, M, day);
      out.bars.push({ label: String(day), title: dayLong(d), sec: secOfDay(d) });
    }
    out.barsTitle = MONTHS_NOM[M];
    fromDaily(start);
  } else if (period === "year") {
    start = new Date(Y, 0, 1);
    const y = yearData(Y);
    out.title = String(Y);
    out.timeLabel = `музыки в ${Y} году`;
    out.sec = y?.total ?? 0;
    const py = yearData(Y - 1);
    if (py) { out.prev = py.total; out.prevLabel = `к ${Y - 1} году`; }
    for (let m = 0; m <= M; m++) out.bars.push({ label: MONTHS_SHORT[m], title: `${capital(MONTHS_NOM[m])} ${Y}`, sec: y?.months[m] ?? 0 });
    out.barsTitle = "по месяцам";
    artistsRaw = Object.values(y?.artists ?? {}).map((a) => ({ ...a }));
    tracksRaw = Object.values(y?.tracks ?? {}).filter((r) => r?.t).map((r) => ({ t: r.t, sec: r.sec || 0, plays: r.plays || 0, f: r.f }));
    Object.assign(ctx, y?.ctx ?? {});
  } else {
    out.title = "Всё время";
    out.timeLabel = s.since ? `музыки с ${formatDate(s.since)}` : "музыки";
    out.sec = s.total || 0;
    const years = Object.keys(s.years ?? {}).filter((yr) => /^\d{4}$/.test(yr)).sort();
    for (const yr of years) out.bars.push({ label: yr, title: `${yr} год`, sec: yearData(+yr)?.total ?? 0 });
    out.barsTitle = "по годам";
    artistsRaw = Object.values(s.artists).map((a) => ({ ...a }));
    const all = new Map();
    for (const yr of years) {
      const y = yearData(+yr);
      for (const [k, r] of Object.entries(y?.tracks ?? {})) {
        if (!r?.t) continue;
        const x = all.get(k) ?? { t: r.t, sec: 0, plays: 0 };
        x.sec += r.sec || 0;
        x.plays += r.plays || 0;
        all.set(k, x);
      }
      for (const [k, sec] of Object.entries(y?.ctx ?? {})) ctx[k] = (ctx[k] || 0) + (+sec || 0);
    }
    tracksRaw = [...all.values()];
  }

  out.artists = artistsRaw.filter((a) => a.sec >= 30).sort((a, b) => b.sec - a.sec);
  out.tracks = mergeSongs(tracksRaw.filter((x) => x.plays > 0)).sort((a, b) => b.plays - a.plays || b.sec - a.sec);
  out.artistCount = out.artists.length;
  out.trackCount = out.tracks.length;
  // «Впервые» и «новых» — только если статистика шла и до начала периода (иначе новое — всё подряд)
  if (start && s.since && s.since < start.getTime()) {
    const from = start.getTime();
    out.newArtists = out.artists.filter((a) => (s.artists[artistKey(a.name)]?.first ?? 0) >= from).length;
    const before = keysBefore(start.getFullYear());
    const fresh = (x) => !x.keys.some((k) => before.has(k));
    // В неделе и месяце трек новый, если в этом году его впервые услышали в этот период (f — с нового вида)
    out.newTracks = out.tracks.filter((x) => fresh(x) && (period === "year" || (Number.isFinite(x.f) && x.f >= from))).length;
  }
  // Сравнивать не с чем: в прошлом периоде статистики ещё не было (иначе «▲ 2 ч к октябрю» при пустом октябре)
  const prevStart = period === "week" ? addDays(start, -7) : period === "month" ? new Date(M ? Y : Y - 1, M ? M - 1 : 11, 1)
    : period === "year" ? new Date(Y - 1, 0, 1) : null;
  if (!prevStart || !s.since || s.since > prevStart.getTime() + 86400000) out.prev = null;
  out.source = topSource(ctx);
  return out;
}
