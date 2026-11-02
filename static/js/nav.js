// Переход между экранами из любого модуля (щелчок по имени исполнителя, «Перейти к альбому»…).
// Сами экраны переключает views.js — он регистрирует себя здесь при запуске.
// Отдельный маленький модуль нужен, чтобы ui.js и actions.js не зависели от views.js (иначе — круговые импорты).

import { artistByName } from "./meta.js";

let navigator = null;

export function setNavigator(fn) { navigator = fn; }

/** Открыть экран: "home", "now", "playlist:<id>", "artist:<id>", "album:<id>"… */
export function openView(key) { navigator?.(key); }

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

/** Открыть исполнителя: по id из базы, если он известен, иначе — по имени. false — не нашёлся */
export async function openArtist({ id, name } = {}) {
  if (id) {
    openView(`artist:${id}`);
    return true;
  }
  const found = name ? await artistByName(name.trim()) : null;
  if (found) openView(`artist:${found.id}`);
  return !!found;
}
