// «Собрано для вас» на «Главной»: подборки, которые Sono собирает сам — и только по вашему вкусу.
//   «Плейлист дня»     — любимое вперемешку с новым, похожим на ваших исполнителей; каждый день другой;
//   «Бодрое утро» / «Для дел» / «Спокойный вечер» / «Ночное» — по времени суток: тот же вкус,
//                        но с настройкой настроения Flow (энергичное утром, спокойное вечером);
//   «Открытия недели»  — исполнители, которых у вас ещё нет, но они близки к вашим; по понедельникам;
//   «Забытое»          — ваши же треки (избранное, плейлисты, часто слушаемое), которые давно не звучали.
// Треки для первых трёх собирает Flow-сервер (/api/flow) по вкусу, потом им ищутся пары на YouTube/
// SoundCloud — в подборку попадают уже настоящие треки (можно скачать, добавить, перетащить).
// Хранится в разделе медиатеки picks: { <id>: { key, name, desc, tracks, at } }; key — день/неделя/время суток,
// сменился — подборка собирается заново (старая видна, пока новая не готова).

import { hasTaste, songKey, tasteBatch, tasteOf } from "./flow.js";
import { keyOf, lib, picksChanged } from "./library.js";
import { isMeta, toReal } from "./meta.js";

const SIZE = 25;
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekKey() {
  const d = new Date();
  return "w" + dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));   // понедельник
}

/** Случайность «на день»: в один и тот же день — одинаковая (подборка не перемешивается при каждом открытии) */
function seeded(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9 | 0;
    return ((h >>> 0) % 1e6) / 1e6;
  };
}

/** Время суток → настроение подборки */
function moment() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return { id: "morning", name: "Бодрое утро", desc: "Энергичное из вашего круга — чтобы проснуться", tune: { mood: "energy" } };
  if (h >= 12 && h < 18) return { id: "day", name: "Для дел", desc: "Ровное и не отвлекает — из того, что вам близко", tune: { activity: "study" } };
  if (h >= 18 && h < 23) return { id: "evening", name: "Спокойный вечер", desc: "Мягкое и тёплое — под конец дня", tune: { mood: "calm" } };
  return { id: "night", name: "Ночное", desc: "Тихая музыка для поздних часов", tune: { mood: "calm" } };
}

// ---------- Сборка ----------

/** Пары на YouTube/SoundCloud — по 4 сразу; ненайденные выкидываем */
async function realTracks(list) {
  const out = new Array(list.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const t = list[i];
      try { out[i] = isMeta(t) ? await toReal(t) : t; } catch { out[i] = null; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out.filter(Boolean);
}

/** Один и тот же трек — один раз (и с разных загрузок) */
function unique(list) {
  const seen = new Set();
  return list.filter((t) => {
    const k = songKey(t);
    if (seen.has(k) || seen.has(keyOf(t))) return false;
    seen.add(k);
    seen.add(keyOf(t));
    return true;
  });
}

/** «Плейлист дня»: порция Flow «вперемешку» + каждый 4-й — из избранного (выбор на этот день) */
async function buildDaily(key) {
  const fresh = await realTracks(await tasteBatch({ mode: "mix", size: SIZE }));
  const rnd = seeded(key);
  const liked = lib.liked.slice();
  const out = [];
  fresh.forEach((t, i) => {
    out.push(t);
    if (i % 3 === 2 && liked.length) out.push({ ...liked.splice(Math.floor(rnd() * liked.length), 1)[0], because: "Из избранного" });
  });
  return unique(out).slice(0, 30);
}

async function buildMoment(m) {
  // Не повторяем «Плейлист дня» — иначе обе подборки начинались с одного и того же трека
  const exclude = (lib.picks.daily?.tracks ?? []).flatMap((t) => [songKey(t), t.metaId].filter(Boolean));
  return unique(await realTracks(await tasteBatch({ mode: "mix", size: SIZE, tune: m.tune, exclude })));
}

/** «Открытия недели»: только новые для вас исполнители */
async function buildDiscover() {
  const list = await tasteBatch({ mode: "discover", size: SIZE });
  // Flow сам помечает знакомых (flow: known), но имена бывают разные («КИНО» и «Группа КИНО») — сверяемся ещё и со вкусом
  return unique(await realTracks(list.filter((t) => t.flow !== "known" && tasteOf(t) <= 0)));
}

/** «Забытое»: ваши треки, которые давно не звучали. Чем чаще слушали и чем дольше молчат — тем вероятнее */
function buildForgotten(key) {
  const recent = new Set();
  for (const t of lib.history.slice(0, 150)) { recent.add(keyOf(t)); recent.add(songKey(t)); }
  const disliked = new Set(lib.disliked.map(keyOf));
  const plays = new Map();   // сколько раз включали (за все годы «Итогов»)
  for (const y of Object.values(lib.stats?.years ?? {})) {
    for (const [k, item] of Object.entries(y.tracks ?? {})) plays.set(k, (plays.get(k) ?? 0) + (item.plays || 0));
  }
  const cands = new Map();
  const add = (t, w) => {
    const k = keyOf(t);
    if (recent.has(k) || recent.has(songKey(t)) || disliked.has(k) || isMeta(t)) return;
    const have = cands.get(k);
    cands.set(k, { t, w: (have?.w ?? 0) + w });
  };
  // Избранное хранится новыми сверху — старые лайки весят больше (их и забыли)
  lib.liked.forEach((t, i) => add(t, 1 + Math.min(3, i / 25)));
  lib.downloads.forEach((t) => add(t, 1));
  lib.playlists.forEach((p) => p.tracks.slice(0, 300).forEach((t) => add(t, 0.4)));
  for (const y of Object.values(lib.stats?.years ?? {})) {
    for (const item of Object.values(y.tracks ?? {})) if (item.plays >= 3) add(item.t, 0);
  }
  for (const c of cands.values()) c.w += Math.min(4, (plays.get(keyOf(c.t)) ?? 0) * 0.4);
  const pool = [...cands.values()];
  if (pool.length < 12) return [];
  const rnd = seeded(key + "forgotten");
  const out = [];
  while (pool.length && out.length < SIZE) {
    let r = rnd() * pool.reduce((s, c) => s + c.w, 0);
    const i = Math.max(0, pool.findIndex((c) => (r -= c.w) <= 0));
    out.push(pool.splice(i, 1)[0].t);
  }
  return unique(out);
}

/** Какие подборки сейчас нужны: id, ключ (когда пересобирать), название, описание, как собрать */
function wanted() {
  const today = dayKey();
  const m = moment();
  return [
    { id: "daily", key: today, name: "Плейлист дня", desc: "Любимое вперемешку с новым. Каждый день — другой", build: () => buildDaily(today) },
    { id: "moment", key: `${today}-${m.id}`, name: m.name, desc: m.desc, build: () => buildMoment(m) },
    { id: "discover", key: weekKey(), name: "Открытия недели", desc: "Новые для вас исполнители, похожие на ваших. Обновляется по понедельникам", build: buildDiscover },
    { id: "forgotten", key: today, name: "Забытое", desc: "То, что вы любили, но давно не включали", build: () => buildForgotten(today) },
  ];
}

// ---------- Для экранов ----------

const building = new Set();
const running = new Map();    // id → сборка (подборка по времени суток ждёт «Плейлист дня», чтобы не повторять его)
const failedAt = new Map();   // не вышло (нет сети) — пробуем снова не раньше чем через 5 минут

/** Подборки для «Главной» (готовые) и сборка устаревших в фоне. onReady() — когда что-то обновилось */
export function picks() {
  if (!hasTaste()) return [];
  const store = lib.picks;
  const list = [];
  for (const w of wanted()) {
    const have = store[w.id];
    if (have?.key !== w.key && !building.has(w.id) && !(Date.now() - (failedAt.get(w.id) ?? 0) < 5 * 60e3)) running.set(w.id, refresh(w));
    if (have?.tracks?.length) list.push({ id: w.id, ...have, stale: have.key !== w.key });
  }
  return list;
}

/** Есть ли подборки, которые ещё собираются (для «скелета» на «Главной») */
export const picksBuilding = () => building.size > 0;

async function refresh(w) {
  building.add(w.id);
  try {
    if (w.id === "moment") await running.get("daily")?.catch(() => {});
    const tracks = await w.build();
    if (tracks.length >= 5) {
      lib.picks = { ...lib.picks, [w.id]: { key: w.key, name: w.name, desc: w.desc, tracks, at: Date.now() } };
    } else if (lib.picks[w.id]) {
      // Собрать не из чего (мало треков) — старую не показываем как свежую, но и не теряем
      lib.picks = { ...lib.picks, [w.id]: { ...lib.picks[w.id], key: w.key } };
    } else {
      lib.picks = { ...lib.picks, [w.id]: { key: w.key, name: w.name, desc: w.desc, tracks: [], at: Date.now() } };
    }
  } catch (err) {
    console.log("[подборки]", w.id, err.message);
    failedAt.set(w.id, Date.now());
    building.delete(w.id);
    picksChanged();   // убрать «Собираем…» с «Главной»
    return;
  }
  building.delete(w.id);
  picksChanged();
}

/** Подборка по id — для экрана списка (views.js, «pick:<id>») */
export const getPick = (id) => (lib.picks[id]?.tracks?.length ? { id, ...lib.picks[id] } : null);
