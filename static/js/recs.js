// «Рекомендуемые» под своим плейлистом (как в Spotify): 10 треков в духе списка — его исполнители и похожие
// на них (Flow по плейлисту, flow.js listRecs). Кнопка «+» добавляет трек в плейлист, на его место встаёт
// следующий из запаса; «Обновить» — другие треки. Показываем только треки, которым нашлась пара на YouTube/
// SoundCloud (не нашлось — лучше не показать, чем показать серую строку). Подборка помнится до закрытия Sono
// (по плейлисту) — список перерисовывается после каждого «+», и треки не должны прыгать.

import { openTrackMenu, toggleLike } from "./actions.js";
import { listRecs, songKey } from "./flow.js";
import { icons } from "./icons.js";
import { addToPlaylist, getPlaylist, isDisliked, keyOf } from "./library.js";
import { isMeta, toReal } from "./meta.js";
import { play, prefetch, state } from "./player.js";
import { el, iconButton, markCurrentRows, toast, trackRow } from "./ui.js";

const SHOWN = 10;     // строк на экране
const ASK = 30;       // сколько просим у Flow за раз (часть отсеется: нет пары, повтор)
const WORKERS = 5;    // сколько пар ищем одновременно

/** id плейлиста → { tracks: [настоящие треки по порядку], seen: Set ключей, loading, failed,
    views: Set функций перерисовки — экран плейлиста пересоздаётся после каждого изменения медиатеки } */
const cache = new Map();

/** Песня уже есть в плейлисте (та же загрузка или та же песня с другой загрузки) */
function inList(playlist, track) {
  const keys = new Set(playlist.tracks.map(keyOf));
  const songs = new Set(playlist.tracks.map(songKey));
  const metas = new Set(playlist.tracks.map((t) => t.metaId).filter(Boolean));
  return keys.has(keyOf(track)) || songs.has(songKey(track)) || (track.metaId && metas.has(track.metaId));
}

/** Пары на YouTube/SoundCloud, по WORKERS сразу; onFound — каждый найденный (по порядку подборки) */
async function realTracks(list, onFound) {
  const out = new Array(list.length).fill(undefined);
  let next = 0, flushed = 0;
  const flush = () => {   // отдаём по порядку: трек i — когда готовы все до него
    while (flushed < out.length && out[flushed] !== undefined) {
      if (out[flushed]) onFound(out[flushed]);
      flushed++;
    }
  };
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try { out[i] = isMeta(list[i]) ? await toReal(list[i]) : list[i]; } catch { out[i] = null; }
      out[i] ??= null;
      flush();
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
}

/** Собрать (или досбрать) подборку для плейлиста; перерисовывает все его ряды, когда пришли треки */
function load(playlistId) {
  const entry = cache.get(playlistId);
  const redraw = () => entry.views.forEach((draw) => draw());
  if (entry.loading) return;
  const playlist = getPlaylist(playlistId);
  if (!playlist?.tracks.length) return;
  entry.failed = false;
  entry.loading = (async () => {
    const meta = await listRecs(playlist.tracks, { size: ASK, exclude: [...entry.seen] });
    meta.forEach((t) => { entry.seen.add(songKey(t)); if (t.id) entry.seen.add(t.id); });
    await realTracks(meta, (real) => {
      const pl = getPlaylist(playlistId);
      if (!pl || isDisliked(real) || inList(pl, real)) return;
      if (entry.tracks.some((t) => keyOf(t) === keyOf(real) || songKey(t) === songKey(real))) return;
      entry.seen.add(keyOf(real));
      entry.tracks.push({ ...real, recFor: playlistId });
      // Новый трек попал на экран — рисуем. После «Обновить» старые стоят, пока новых не наберётся на экран
      const count = usable(entry.tracks, pl).length;
      if (entry.prev ? count >= SHOWN : count <= SHOWN) { entry.prev = null; redraw(); }
    });
  })()
    .catch(() => { entry.failed = true; })
    .finally(() => { entry.loading = null; entry.prev = null; redraw(); });
}

/** Что показывать сейчас: без того, что уже попало в плейлист или в дизлайки
    (пока после «Обновить» собирается новая подборка — прежняя) */
const usable = (tracks, playlist) => tracks.filter((t) => !isDisliked(t) && !inList(playlist, t));
const visible = (entry, playlist) => usable(entry.prev ?? entry.tracks, playlist);

/** Ряд «Рекомендуемые» под плейлистом. Рисуется сразу из памяти; подборки нет — собирает её в фоне */
export function recsSection(playlist) {
  const section = el("section", "pl-recs");
  if (!playlist?.tracks.length) return section;
  if (!cache.has(playlist.id)) cache.set(playlist.id, { tracks: [], prev: null, seen: new Set(), loading: null, failed: false, views: new Set() });
  const entry = cache.get(playlist.id);

  const head = el("div", "pl-recs-head");
  const titles = el("div", "pl-recs-titles");
  titles.append(el("h2", "meta-h", "Рекомендуемые"), el("p", "pl-recs-sub", `В духе «${playlist.name}» — добавьте то, что понравится`));
  const again = el("button", "meta-more pl-recs-again", "Обновить");
  again.type = "button";
  head.append(titles, again);
  const list = el("ol", "tracklist pl-recs-list");
  const note = el("p", "pl-recs-note");
  section.append(head, list, note);

  let attached = false, drawn = null;
  const draw = () => {
    if (section.isConnected) attached = true;
    else if (attached) { entry.views.delete(draw); return; }   // экран ушёл — этот ряд больше не нужен
    const pl = getPlaylist(playlist.id);
    if (!pl) return;
    const shown = visible(entry, pl).slice(0, SHOWN);
    const sig = shown.map(keyOf).join(" ");
    if (sig !== drawn) { drawn = sig; drawRows(pl, shown); }   // те же треки — не перерисовываем (строки «въезжают» заново)
    again.disabled = !!entry.loading;
    note.hidden = shown.length > 0 && !entry.failed;
    note.textContent = entry.failed ? "Не получилось подобрать похожие треки — нет связи с базой музыки"
      : entry.loading ? "Подбираю похожие треки…"
      : entry.tracks.length ? "Больше подобрать нечего — нажмите «Обновить» или добавьте в плейлист ещё треков"
      : "Похожего не нашлось — исполнителей этого списка нет в базе музыки";
    section.classList.toggle("loading", !!entry.loading && !shown.length);
  };
  const drawRows = (pl, shown) => {
    const queue = shown.slice();
    const context = { type: "recs", id: pl.id, name: `Рекомендации к «${pl.name}»` };
    list.replaceChildren(...shown.map((track, n) => {
      const row = trackRow(track, {
        index: n,
        onPlay: () => play(track, queue.slice(), n, context),
        onLike: toggleLike,
        onMenu: (anchor) => openTrackMenu(anchor, track),
      });
      const add = iconButton(icons.plus, `Добавить в «${pl.name}»`, "pl-recs-add");
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        if (addToPlaylist(pl.id, track)) toast(`Добавлено в «${pl.name}»`);
        // Запас кончается — подбираем ещё (уже показанное не повторится)
        if (visible(entry, pl).length < SHOWN + 3) load(pl.id);
      });
      row.append(add);
      row.addEventListener("mouseenter", () => prefetch(track));
      return row;
    }));
    markCurrentRows(state.current ? keyOf(state.current) : null);
  };
  entry.views.add(draw);

  again.addEventListener("click", () => {
    entry.prev = visible(entry, getPlaylist(playlist.id) ?? playlist).slice(0, SHOWN);   // стоят, пока не придут новые
    entry.tracks = [];   // уже показанное остаётся в seen — придут другие
    load(playlist.id);
    draw();
  });

  if (visible(entry, playlist).length < SHOWN) load(playlist.id);
  draw();
  return section;
}
