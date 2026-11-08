// Треки «из базы» (страницы исполнителей и альбомов) — у них нет звука (source: "meta").
// Перед включением сервер ищет им пару на YouTube или SoundCloud (/api/resolve) и запоминает её.
// Здесь — запросы к серверу и память найденного на время работы программы.

const resolved = new Map();   // id трека из базы → настоящий трек (или null — нигде нет)
const pending = new Map();    // id → запрос, который уже идёт (чтобы не искать дважды)
const reasons = new Map();    // id → почему пары нет (текст для человека)

/** Почему у трека из базы нет пары */
export const missingReason = (track) => reasons.get(track.id) || "Этого трека нет ни на YouTube, ни на SoundCloud";

export const isMeta = (track) => track?.source === "meta";

/** Найденная пара, если её уже искали (без запроса) */
export const resolvedOf = (track) => (isMeta(track) ? resolved.get(track.id) ?? null : track);

/** Найти пару. null — трека нет ни на YouTube, ни на SoundCloud. prefetch — заодно подготовить звук */
export function resolveMeta(track, { prefetch = false } = {}) {
  if (!isMeta(track)) return Promise.resolve(track);
  if (resolved.has(track.id)) return Promise.resolve(resolved.get(track.id));
  if (pending.has(track.id)) return pending.get(track.id);
  const request = fetch("/api/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: track.id, artists: track.artists, title: track.origTitle || track.title,
                           duration: track.duration, prefetch }),
  })
    .then(async (res) => {
      if (res.status === 404) {   // нигде нет — запоминаем, почему (например, только на SoundCloud под DRM)
        reasons.set(track.id, (await res.json().catch(() => ({}))).error);
        return null;
      }
      if (!res.ok) throw new Error((await res.json()).error || "сервер не ответил");
      return res.json();
    })
    .then((real) => {
      resolved.set(track.id, real);
      // Строки этого трека на экране: запоминаем настоящий ключ (для подсветки играющего), «нет нигде» — серым
      document.querySelectorAll(`[data-key="meta:${track.id}"]`).forEach((row) => {
        if (real) row.dataset.realKey = `${real.source}:${real.id}`;
        row.classList.toggle("unavailable", !real);
        if (!real) row.title = missingReason(track);
      });
      return real;
    })
    .finally(() => pending.delete(track.id));
  pending.set(track.id, request);
  return request;
}

/** Настоящий трек для включения и медиатеки — с обложкой альбома и id исполнителя из базы
 *  (они красивее и точнее кадра из ролика). null — нигде нет */
export async function toReal(track) {
  const real = await resolveMeta(track);
  if (!real || !isMeta(track)) return real;
  const extra = { artistId: track.artistId, albumId: track.albumId, album: track.album, artistRefs: track.artistRefs,
                  metaId: track.id,     // metaId — чтобы Flow не повторял трек
                  because: track.because };   // «Похоже на …» — почему Flow поставил этот трек
  if (track.cover) Object.assign(extra, { cover: track.cover, coverLarge: track.coverLarge });
  return Object.fromEntries(Object.entries({ ...real, ...extra }).filter(([, v]) => v != null));
}

/** Исполнитель трека: тот одноимённый, у кого есть эта песня → { id, name } или null */
export async function artistForTrack(name, title, track) {
  const real = resolvedOf(track) ?? track;   // у трека из базы — найденная пара (SoundCloud/YouTube)
  const res = await fetch("/api/artist/for-track", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, title, duration: track.duration || real.duration, source: real.source, id: real.id }),
  });
  return res.ok ? res.json() : null;
}

/** Исполнитель по имени (щелчок по имени в списке) → { id, name } или null */
export async function artistByName(name) {
  const res = await fetch(`/api/artist/by-name?name=${encodeURIComponent(name)}`);
  return res.ok ? res.json() : null;
}
