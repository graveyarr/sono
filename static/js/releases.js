// Новинки исполнителей, на которых подписан человек («Подписаться» на странице исполнителя).
// Сервер (/api/new-releases) смотрит релизы за последние 3 месяца (ответы Яндекса помнит сутки).
// На «Главной» — ряд карточек «Новинки ваших исполнителей»; при запуске о вышедшем с прошлого раза —
// уведомление «Новый релиз у …» (settings.seenReleases — о каких уже сказали; в первый раз — молча запоминаем).

import { followedArtists, getSetting, setSetting } from "./library.js";
import { openView } from "./nav.js";
import { toast } from "./ui.js";

let cache = null, cacheAt = 0, cacheFor = "";

/** Новинки (новые сверху): [{ id, title, type, date, cover, artist, artistId, tracks }] */
export async function newReleases() {
  const ids = followedArtists().map((a) => a.id);
  if (!ids.length) return [];
  const key = ids.join(",");
  if (cache && key === cacheFor && Date.now() - cacheAt < 30 * 60 * 1000) return cache;
  try {
    const res = await fetch("/api/new-releases", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    cache = data.releases || [];
    cacheAt = Date.now();
    cacheFor = key;
  } catch {
    cache = cache || [];
  }
  return cache;
}

/** При запуске: о новых релизах с прошлого раза — уведомлением с кнопкой «Открыть» (не больше двух сразу) */
export async function announceNewReleases() {
  const list = await newReleases();
  const seen = getSetting("seenReleases", null);
  setSetting("seenReleases", [...new Set([...(seen || []), ...list.map((r) => r.id)])].slice(-300));
  if (!seen) return;   // первый раз — просто запоминаем, что уже вышло, без потока уведомлений
  const fresh = list.filter((r) => !seen.includes(r.id));
  fresh.slice(0, 2).forEach((r, i) => setTimeout(() => toast(`Новый релиз у ${r.artist}: «${r.title}»`, {
    action: { label: "Открыть", run: () => openView(`album:${r.id}`) },
  }), i * 700));
}
