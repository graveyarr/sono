// Новинки исполнителей, на которых подписан человек («Подписаться» на странице исполнителя).
// Сервер (/api/new-releases) смотрит релизы за последние 3 месяца (ответы Яндекса помнит сутки).
// Вторым запросом (/api/new-releases/more — SoundCloud отвечает дольше) — свежее с SoundCloud у тех же
// исполнителей (тот же артист находится по совпадению песен) и, если подписок мало, новинки самых
// слушаемых исполнителей (статистика + «Избранное»): у них пометка «Из ваших любимых» (fav: true).
// На «Главной» — ряд карточек, кнопка «Все» — экран «Новинки» (releaseview.js); при запуске о вышедшем
// с прошлого раза — уведомление «Новый релиз у …» (settings.seenReleases — о каких уже сказали).
// Значок у «Новинок» в медиатеке (ПК): сколько вышло за неделю и ещё не послушано (settings.heardReleases —
// что уже включали: альбом с его страницы или трек SoundCloud); изменилось — событие «sono:releases».

import { followedArtists, getSetting, keyOf, lib, setSetting } from "./library.js";
import { openView, splitArtists } from "./nav.js";
import { onTrackChange, play, state } from "./player.js";
import { artistKey, topArtists } from "./stats.js";
import { displayTrack, toast } from "./ui.js";

const FRESH_FOR = 30 * 60 * 1000;   // столько помним ответ
const FEW_FOLLOWS = 6;              // подписок меньше — добавляем любимых исполнителей
const FAV_COUNT = 10;               // скольких любимых спрашиваем

let job = null;   // { key, at, base: Promise, full: Promise, done }

/** Самые слушаемые исполнители, на которых человек не подписан: время в статистике + лайки.
 *  С каждым — до трёх его песен из медиатеки: по ним сервер проверяет, что нашёл того самого, а не тёзку */
export function favoriteArtists() {
  const followed = followedArtists();
  const skipIds = new Set(followed.map((a) => String(a.id)));
  // Слитно: в статистике «key vs. locket» (из Яндекса), а у загрузки SoundCloud — «keyvslocket»
  const keyOfName = (name) => artistKey(name).replace(/ /g, "");
  const skipNames = new Set(followed.map((a) => keyOfName(a.name)));
  const by = new Map();
  const get = (name, id) => {
    const key = keyOfName(name);
    if (!key || key === "неизвестныйавтор" || skipNames.has(key) || (id && skipIds.has(String(id)))) return null;
    let a = by.get(key);
    if (!a) by.set(key, (a = { name, id: null, score: 0, tracks: [] }));
    if (id && !a.id) a.id = String(id);
    return a;
  };
  for (const s of topArtists(40)) {
    const a = get(s.name, s.id);
    if (a) a.score += s.sec;
  }
  const sample = (t, weight) => {
    if (!t || t.source === "local") return;
    const shown = displayTrack(t);
    for (const { name, id } of splitArtists(t, shown.artist)) {
      const a = get(name, id);
      if (!a) continue;
      a.score += weight;
      if (a.tracks.length < 3 && !a.tracks.some((x) => x.title === shown.title)) {
        a.tracks.push({ title: shown.title, duration: t.duration || 0, source: t.source, id: t.id });
      }
    }
  };
  for (const t of lib.liked) sample(t, 600);              // лайк — примерно как 10 минут прослушивания
  for (const t of lib.history.slice(0, 300)) sample(t, 0);  // недавнее — только песни для проверки
  return [...by.values()].filter((a) => a.score > 0 && (a.id || a.tracks.length))
    .sort((a, b) => b.score - a.score).slice(0, FAV_COUNT)
    .map(({ name, id, tracks }) => ({ name, id, tracks }));
}

const post = (url, body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then(async (res) => {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Сервер не ответил");
  return data.releases || [];
});

function merge(...lists) {
  const seen = new Set(), out = [];
  for (const r of lists.flat()) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function start() {
  const ids = followedArtists().map((a) => String(a.id));
  const key = ids.join(",");
  // Любимых пересчитываем только вместе с запросом (раз в полчаса или когда изменились подписки):
  // «Главная» перерисовывается часто, а перебирать всю медиатеку каждый раз незачем
  if (job && job.key === key && Date.now() - job.at < FRESH_FOR) return job;
  const favorites = ids.length < FEW_FOLLOWS ? favoriteArtists() : [];
  const mine = { key, at: Date.now(), done: false, favorites: favorites.length };
  const failed = () => { mine.at = 0; return []; };   // не вышло — в следующий раз спросим заново
  mine.base = ids.length ? post("/api/new-releases", { ids }).catch(failed) : Promise.resolve([]);
  const more = ids.some((id) => /^\d+$/.test(id)) || favorites.length
    ? post("/api/new-releases/more", { ids, favorites }).catch(failed) : Promise.resolve([]);
  mine.full = Promise.all([mine.base, more]).then(([a, b]) => {
    mine.done = true;
    const list = merge(a, b);
    if (job === mine) { known = list; releasesChanged(); }
    return list;
  });
  job = mine;
  return mine;
}

/** Все новинки (новые сверху): [{ id, title, type, date, cover, artist, artistId, tracks, track?, source?, fav? }] */
export const newReleases = () => start().full;

/** Для экранов: сначала то, что ответил Яндекс, потом — вместе с SoundCloud и любимыми.
 *  cb(список, всёЛи). Если всё уже готово — вызывается один раз */
export function watchReleases(cb) {
  const j = start();
  if (!j.done) j.base.then((list) => { if (!j.done) cb(merge(list), false); });
  j.full.then((list) => cb(list, true));
}

// ---------- Значок «не послушано» ----------

let known = [];   // последний полный список новинок
const releasesChanged = () => document.dispatchEvent(new CustomEvent("sono:releases"));
export const weekAgo = () => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const heardSet = () => new Set(getSetting("heardReleases", []));
export const isHeard = (r) => heardSet().has(r.id);

/** Сколько новинок этой недели ещё не включали (для значка у «Новинок») */
export function unheardCount() {
  const heard = heardSet(), since = weekAgo();
  return known.filter((r) => (r.date || "") >= since && !heard.has(r.id)).length;
}

function markHeard(r) {
  const heard = getSetting("heardReleases", []);
  if (heard.includes(r.id)) return;
  setSetting("heardReleases", [...heard, r.id].slice(-300));
  releasesChanged();
}

// Заиграл альбом-новинка (с его страницы, «Слушать», ▶) или трек SoundCloud из новинок — значит, послушали
onTrackChange(() => {
  const t = state.current, ctx = state.context;
  if (!t || !known.length) return;
  const key = keyOf(t);
  for (const r of known) {
    if ((ctx?.type === "album" && String(ctx.id) === String(r.id)) || (r.track && keyOf(r.track) === key)) markHeard(r);
  }
});

/** Ждём ли ещё ответа SoundCloud и есть ли у нас подписки/любимые вообще */
export const releasesAsked = () => followedArtists().length > 0 || !!start().favorites;

/** При запуске: о новых релизах с прошлого раза — уведомлением с кнопкой «Открыть» (не больше двух сразу).
 *  Только у подписок (не у «любимых») и только вышедшее за последнюю неделю */
export async function announceNewReleases() {
  const list = (await newReleases()).filter((r) => !r.fav);
  const seen = getSetting("seenReleases", null);
  setSetting("seenReleases", [...new Set([...(seen || []), ...list.map((r) => r.id)])].slice(-300));
  if (!seen) return;   // первый раз — просто запоминаем, что уже вышло, без потока уведомлений
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const fresh = list.filter((r) => !seen.includes(r.id) && (r.date || "") >= weekAgo);
  fresh.slice(0, 2).forEach((r, i) => setTimeout(() => toast(`Новый релиз у ${r.artist}: «${r.title}»`, {
    action: r.track ? { label: "Слушать", run: () => play(r.track, [r.track], 0) }
      : { label: "Открыть", run: () => openView(`album:${r.id}`) },
  }), i * 700));
}
