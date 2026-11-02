// Flow — бесконечная подборка по вкусу (как «Моя волна»).
// Вкус = исполнители из избранного, истории, скачанного и плейлистов + то, чему Flow научился сам:
// пропустил трек в первые 30 секунд — исполнитель реже, дослушал — чаще (settings.flowTaste).
// Сервер (/api/flow) по вкусу собирает порцию треков из базы; пока играет — подкладываем следующую.

import { getPlaylist, getSetting, keyOf, lib, setSetting } from "./library.js";
import { isMeta, resolveMeta } from "./meta.js";
import { splitArtists } from "./nav.js";
import { extendQueue, onQueueEnd, onTrackChange, play, replaceUpcoming, state } from "./player.js";
import { displayTrack, toast } from "./ui.js";

export const FLOW_MODES = [
  { value: "liked", title: "Любимое", hint: "Больше того, что уже нравится" },
  { value: "mix", title: "Микс", hint: "Любимое вперемешку с новым" },
  { value: "discover", title: "Открытия", hint: "Исполнители, которых вы ещё не слышали" },
];
// Как часто вставлять трек прямо из избранного (каждый N-й)
const LIKED_EVERY = { liked: 3, mix: 6, discover: 0 };

const audio = document.getElementById("player");
const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Ключ «исполнитель|название» — такой же, как track_key() в flow.py */
const songKey = (t) => {
  const shown = displayTrack(t);
  const first = shown.artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?)\s+/i)[0];
  return `${norm(first)}|${norm(shown.title.replace(/\s*[(\[].*?[)\]]/g, ""))}`;
};

let session = null;   // { context, mode, artist, played: Set, loading, likedPos }

export const isFlow = (ctx = state.context) => ctx?.type === "flow";
export const flowMode = () => getSetting("flowMode", "mix");

// ---------- Вкус ----------

function taste() {
  const weights = new Map();   // нормализованное имя → { name, id, weight }
  const add = (track, w) => {
    for (const { name, id } of splitArtists(track, displayTrack(track).artist)) {
      const key = norm(name);
      if (!key || key === "неизвестный автор") continue;
      const item = weights.get(key) ?? { name, id: null, weight: 0 };
      item.weight += w;
      item.id ??= id;
      weights.set(key, item);
    }
  };
  lib.liked.forEach((t) => add(t, 3));
  lib.downloads.forEach((t) => add(t, 2));
  lib.history.forEach((t) => add(t, 1));
  lib.playlists.forEach((p) => p.tracks.slice(0, 200).forEach((t) => add(t, 0.5)));
  lib.disliked.forEach((t) => add(t, -3));
  for (const [key, { name, weight }] of Object.entries(getSetting("flowTaste", {}))) {
    const item = weights.get(key) ?? { name, id: null, weight: 0 };
    item.weight += weight;
    weights.set(key, item);
  }
  const list = [...weights.values()];
  return {
    all: list,
    seeds: list.filter((a) => a.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 20),
    banned: list.filter((a) => a.weight <= -4).map((a) => a.name),
  };
}

// ---------- Вкус для поиска ----------
// Поиск поднимает выше треки исполнителей, которых вы слушаете. Вес — тот же вкус Flow
// плюс статистика прослушиваний (час прослушивания ≈ трек в избранном).
let tasteCache = null, tasteAt = 0;

function tasteMap() {
  if (tasteCache && Date.now() - tasteAt < 10000) return tasteCache;   // пока печатают — не пересчитываем
  const map = new Map();
  const { all, banned } = taste();
  all.forEach((a) => map.set(norm(a.name), a.weight));
  for (const a of Object.values(lib.stats?.artists ?? {})) {
    const key = norm(a.name);
    map.set(key, (map.get(key) ?? 0) + Math.min(6, a.sec / 1200));
  }
  banned.forEach((name) => map.set(norm(name), -5));
  tasteCache = map;
  tasteAt = Date.now();
  return map;
}

/** Насколько исполнитель трека в вашем вкусе: 0 — незнаком, > 0 — слушаете, < 0 — не нравится */
export function tasteOf(track) {
  const map = tasteMap();
  const names = splitArtists(track, displayTrack(track).artist).map((a) => norm(a.name));
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

/** Что Flow выучил сам (пропуски и дослушивания): сколько исполнителей звучит чаще и реже */
export function learnedSummary() {
  const items = Object.values(getSetting("flowTaste", {}));
  return { more: items.filter((i) => i.weight > 0).length, less: items.filter((i) => i.weight < 0).length };
}

export function resetLearning() {
  setSetting("flowTaste", {});
}

/** Играет ли сейчас Flow (любой: общий, по исполнителю, по плейлисту) */
export const flowPlaying = () => isFlow() && !!state.current;

/** Flow учится: пропуск в первые 30 с — минус исполнителю, дослушал — плюс */
function learn(track, listened) {
  const duration = track.duration || audio.duration || 0;
  let delta = 0;
  if (listened < 30 && duration > 60) delta = -1;
  else if (duration && listened > duration * 0.7) delta = 0.5;
  if (!delta) return;
  const tasteMap = { ...getSetting("flowTaste", {}) };
  const { name } = splitArtists(track, displayTrack(track).artist)[0] ?? {};
  if (!name) return;
  const key = norm(name);
  const item = tasteMap[key] ?? { name, weight: 0 };
  item.weight = Math.max(-8, Math.min(8, item.weight + delta));
  tasteMap[key] = item;
  // Не копим бесконечно: оставляем 300 самых «уверенных»
  const entries = Object.entries(tasteMap).sort((a, b) => Math.abs(b[1].weight) - Math.abs(a[1].weight)).slice(0, 300);
  setSetting("flowTaste", Object.fromEntries(entries));
}

// ---------- Порции ----------

/** Исполнители плейлиста с весами — вкус Flow по плейлисту (остальная медиатека не учитывается) */
function playlistSeeds(tracks) {
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
  return [...weights.values()].sort((a, b) => b.weight - a.weight).slice(0, 20);
}

async function fetchBatch(size = 10) {
  const { seeds, banned } = taste();
  const pl = session.playlist;
  // Flow по исполнителю — только он и похожие; по плейлисту — только его исполнители и похожие на них
  const ownSeeds = session.artist ? [{ name: session.artist.name, id: session.artist.id, weight: 30 }]
    : pl ? playlistSeeds(pl.tracks) : seeds;
  const exclude = new Set(session.played);
  for (const t of [...lib.liked, ...lib.history, ...lib.disliked, ...(pl?.tracks ?? [])]) {
    exclude.add(songKey(t));
    if (t.metaId) exclude.add(t.metaId);
  }
  const res = await fetch("/api/flow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seeds: ownSeeds,
      mode: session.artist || pl ? "mix" : session.mode,
      exclude: [...exclude].slice(-3000), banned, size,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Flow не ответил");
  let tracks = data.tracks;
  tracks.forEach((t) => { session.played.add(t.id); session.played.add(songKey(t)); });
  // Иногда — трек прямо из избранного (или из самого плейлиста): он уже с YouTube/SoundCloud и стартует сразу
  const own = pl ? pl.tracks : lib.liked;
  const every = session.artist ? 0 : pl ? 4 : LIKED_EVERY[session.mode];
  if (every && own.length) {
    const out = [];
    for (const t of tracks) {
      out.push(t);
      if (++session.likedPos % every === 0) {
        const fav = own[Math.floor(Math.random() * own.length)];
        if (!session.played.has(keyOf(fav))) { session.played.add(keyOf(fav)); out.push(fav); }
      }
    }
    tracks = out;
  }
  return tracks;
}

/** Включить Flow. artist — Flow «по исполнителю» (со страницы исполнителя),
    playlist — Flow по плейлисту ({ id, name, tracks }): вкус — только этот плейлист */
export async function startFlow({ mode = flowMode(), artist = null, playlist = null, quiet = false } = {}) {
  const context = artist ? { type: "flow", id: `artist-${artist.id}`, name: `Flow: ${artist.name}` }
    : playlist ? { type: "flow", id: `playlist-${playlist.id}`, name: `Flow: ${playlist.name}` }
    : { type: "flow", id: "main", name: "Flow" };
  session = { context, mode, artist, playlist, played: new Set(), loading: true, likedPos: 0 };
  const mine = session;
  if (!quiet) toast(artist ? `Flow по исполнителю «${artist.name}»` : playlist ? `Flow по плейлисту «${playlist.name}»` : "Собираю Flow…");
  try {
    const tracks = await fetchBatch(12);
    if (session !== mine) return;
    if (!tracks.length) return toast("Flow не нашёл, что включить — послушайте и полайкайте что-нибудь", { error: true });
    // Перемешивание во Flow не нужно — порция и так случайная
    play(tracks[0], tracks, 0, context);
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    mine.loading = false;
  }
}

/** Сменить режим. Если Flow уже играет — всё, что впереди, пересобирается */
export async function setFlowMode(mode) {
  setSetting("flowMode", mode);
  if (!session || !isFlow() || session.artist || session.playlist) return;
  session.mode = mode;
  session.loading = true;
  try {
    replaceUpcoming(await fetchBatch(10));
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    session.loading = false;
  }
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

// ---------- Flow после конца очереди ----------
// Плейлист (или один трек) доиграл — продолжаем Flow в его духе: вкус — только эти треки.

export const autoFlowEnabled = () => getSetting("autoFlow", true) !== false;

function continueWithFlow() {
  if (!autoFlowEnabled() || isFlow() || !state.queue.length) return;
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
