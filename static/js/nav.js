// Переход между экранами из любого модуля (щелчок по имени исполнителя, «Перейти к альбому»…).
// Сами экраны переключает views.js — он регистрирует себя здесь при запуске.
// Отдельный маленький модуль нужен, чтобы ui.js и actions.js не зависели от views.js (иначе — круговые импорты).

import { artistByName, artistForTrack } from "./meta.js";

let navigator = null;

export function setNavigator(fn) { navigator = fn; }

/** Открыть экран: "home", "now", "playlist:<id>", "artist:<id>", "album:<id>"… */
export function openView(key) { navigator?.(key); }

// Открыть альбом и подсветить в нём трек (щелчок по названию трека). Страница альбома забирает
// отметку takeHighlight() после отрисовки — так nav.js не зависит от artist.js
let pendingHighlight = null;
export function openAlbumAt(albumId, trackKey = null) {
  pendingHighlight = trackKey;
  openView(`album:${albumId}`);
}
export function takeHighlight() {
  const key = pendingHighlight;
  pendingHighlight = null;
  return key;
}

const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Исполнители трека по отдельности: [{ name, id }]. «A, B feat. C» → три имени.
 *  «&» и «x» не делим: так часто называются группы (Simon & Garfunkel). id — если он известен из базы */
export function splitArtists(track, text) {
  const refs = track.artistRefs || [];
  const names = refs.length > 1 && norm(text) === norm(refs.map((r) => r.name).join(" "))
    ? refs.map((r) => r.name)
    : text.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i).map((s) => s.trim()).filter(Boolean);
  return names.map((name, i) => {
    const ref = refs.find((r) => norm(r.name) === norm(name));
    return { name, id: ref?.id ?? (i === 0 && !refs.length ? track.artistId ?? null : null) };
  });
}

/** Открыть исполнителя: по id из базы, если он известен, иначе — по имени. false — не нашёлся.
 *  track + title — щелчок по имени в строке трека: тогда ищем того одноимённого исполнителя,
 *  у кого есть эта песня (а у нишевых с SoundCloud — страницу автора на SoundCloud) */
export async function openArtist({ id, name, track = null, title = "" } = {}) {
  if (id) {
    openView(`artist:${id}`);
    return true;
  }
  // Пока ищем по имени, повторный щелчок по нему же не запускает второй поиск (и второе «Не нашёл»)
  const key = (name || "").trim().toLowerCase();
  if (key && key === lookingFor) return true;
  lookingFor = key;
  try {
    const found = !key ? null
      : track ? await artistForTrack(name.trim(), title, track)
      : await artistByName(name.trim());
    if (found) openView(`artist:${found.id}`);
    return !!found;
  } finally {
    lookingFor = "";
  }
}
let lookingFor = "";
