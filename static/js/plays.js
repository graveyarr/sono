// Сколько раз трек слушали на YouTube/SoundCloud — колонка «Прослушивания» в плейлистах, альбомах и на
// странице исполнителя, и сортировка по ней. Сервер (/api/plays) спрашивает пачкой и помнит сутки.
// У треков «из базы» (Яндекс) своих чисел нет — берём их найденную пару на YouTube/SoundCloud
// (для страницы исполнителя пару ищем заранее — resolveMeta).

import { keyOf } from "./library.js";
import { isMeta, resolveMeta, resolvedOf } from "./meta.js";
import { compactNumber } from "./ui.js";

const known = new Map();   // «источник:id» → число (или null — не узнали)

/** Настоящий трек (YouTube/SoundCloud), чьи прослушивания показывать: сам трек или пара трека из базы */
const realOf = (t) => (isMeta(t) ? resolvedOf(t) : t);
const canCount = (t) => t && (t.source === "youtube" || t.source === "soundcloud");

/** Прослушивания трека, если уже известны (undefined — ещё не спрашивали) */
export function playsOf(track) {
  const real = realOf(track);
  return canCount(real) ? known.get(keyOf(real)) : undefined;
}

/** Узнать прослушивания для списка треков. resolve — искать пары трекам из базы (дольше, по 4 сразу) */
export async function loadPlays(tracks, { resolve = false } = {}) {
  if (resolve) {
    const metas = tracks.filter((t) => isMeta(t) && !resolvedOf(t));
    for (let i = 0; i < metas.length; i += 4) {
      await Promise.all(metas.slice(i, i + 4).map((t) => resolveMeta(t).catch(() => null)));
    }
  }
  const want = tracks.map(realOf).filter((t) => canCount(t) && !known.has(keyOf(t)));
  const unique = [...new Map(want.map((t) => [keyOf(t), { source: t.source, id: t.id }])).values()];
  for (let i = 0; i < unique.length; i += 200) {
    try {
      const res = await fetch("/api/plays", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: unique.slice(i, i + 200) }),
      });
      const { plays = {} } = await res.json();
      for (const t of unique.slice(i, i + 200)) known.set(`${t.source}:${t.id}`, plays[`${t.source}:${t.id}`] ?? null);
    } catch {}
  }
}

/** Вписать числа в колонку .t-plays у строк списка (строки знают свой трек по data-key) */
export function fillPlays(list, tracks) {
  const byKey = new Map(tracks.map((t) => [keyOf(t), t]));
  list.querySelectorAll(".track[data-key]").forEach((row) => {
    const cell = row.querySelector(".t-plays");
    const track = byKey.get(row.dataset.key);
    if (!cell || !track) return;
    const n = playsOf(track);
    cell.textContent = n == null ? "" : compactNumber(n);
    cell.title = n == null ? "" : `${n.toLocaleString("ru")} прослушиваний на ${realOf(track).source === "youtube" ? "YouTube" : "SoundCloud"}`;
  });
}
