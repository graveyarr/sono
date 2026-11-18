// Скачивание треков (как «Скачать» в Spotify): скачанные стартуют мгновенно и играют без интернета.
// Качает сервер, в фоне. Здесь — список скачанного (раздел медиатеки downloads),
// состояние каждого трека и опрос сервера, пока что-то качается.

import { addDownloads, autoDownloadLists, autoListTracks, keyOf, lib, onChange, removeDownloads, setAutoDownload } from "./library.js";
import { groupSongs, twinsIn } from "./samesong.js";

/** «источник:id» → done | queued | downloading | error | nospace (мало места на диске) | missing */
const status = new Map();
const listeners = new Set();
let polling = null;

/** fn() — изменилось состояние скачиваний */
export const onDownloadsChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

export const downloadState = (track) => status.get(keyOf(track)) ?? "missing";
export const isDownloaded = (track) => downloadState(track) === "done";
export const isDownloading = (track) => ["queued", "downloading"].includes(downloadState(track));

/** Сколько из списка скачано и сколько ещё качается */
export function countDownloaded(tracks) {
  let done = 0, active = 0;
  for (const t of tracks) {
    const s = downloadState(t);
    if (s === "done") done++;
    else if (s === "queued" || s === "downloading") active++;
  }
  return { done, active };
}

const post = (url, tracks) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tracks: tracks.map((t) => ({ source: t.source, id: t.id })) }),
}).then((r) => r.json());

let noSpaceRetry = null;
let noSpaceNoticed = false;
/** Сервер не стал качать — на диске меньше 500 МБ. true — один раз за запуск (сказать человеку) */
export function takeNoSpaceNotice() {
  if (noSpaceNoticed || ![...status.values()].includes("nospace")) return false;
  noSpaceNoticed = true;
  return true;
}

function apply(states) {
  for (const [key, value] of Object.entries(states)) status.set(key, value);
  notify();
  // Пока что-то качается — спрашиваем сервер раз в 1,5 секунды
  const active = [...status.values()].some((s) => s === "queued" || s === "downloading");
  if (active && !polling) polling = setTimeout(poll, 1500);
  // Не хватило места — пробуем снова раз в 5 минут: вдруг человек освободил диск
  if (!active && !noSpaceRetry && [...status.values()].includes("nospace")) {
    noSpaceRetry = setTimeout(async () => {
      noSpaceRetry = null;
      const waiting = lib.downloads.filter((t) => downloadState(t) === "nospace");
      if (waiting.length) try { apply(await post("/api/downloads", waiting)); } catch {}
    }, 5 * 60 * 1000);
  }
}

async function poll() {
  polling = null;
  try {
    apply(await post("/api/downloads/status", lib.downloads));
  } catch {
    polling = setTimeout(poll, 4000);
  }
}

/** Скачать треки */
export async function download(tracks) {
  if (!tracks.length) return;
  addDownloads(tracks);
  tracks.forEach((t) => { if (!isDownloaded(t)) status.set(keyOf(t), "queued"); });
  notify();
  apply(await post("/api/downloads", tracks));
}

/** Удалить загрузки (сами треки остаются в плейлистах — просто снова будут играть из интернета) */
export async function removeDownload(tracks) {
  const failed = [];
  for (const t of tracks) {
    const res = await fetch(`/api/downloads/${t.source}/${t.id}`, { method: "DELETE" });
    if (res.ok) status.set(keyOf(t), "missing");
    else failed.push(t);
  }
  removeDownloads(tracks.filter((t) => !failed.includes(t)));
  notify();
  return failed.length;
}

/** При запуске: узнать, что уже скачано, и докачать то, что не успело в прошлый раз */
export async function initDownloads() {
  watchAutoDownload();
  if (!lib.downloads.length) return;
  try {
    apply(await post("/api/downloads", lib.downloads));
  } catch {}
}

// ---------- Авто-скачивание у плейлистов («Скачивать новые») ----------
// Следим за списками с включённым авто-скачиванием: появился трек, которого там не было, — качаем.
// Так ловится любой способ добавить (♡, «В плейлист», «Рекомендуемые», импорт, перетаскивание) — на ПК
// и на телефоне. Уже лежавшие при включении треки докачиваются, только если человек выбрал «Докачать все».

/** Трек уже скачан (или качается) — он сам или другая загрузка той же песни (samesong.js) */
function haveSong(track) {
  return twinsIn(lib.downloads, track).some((t) => keyOf(t) !== keyOf(track) || downloadState(t) !== "error");
}

/** Что качать из списка: по одной загрузке на песню, без уже скачанных песен */
export function songsToDownload(tracks) {
  return groupSongs(tracks)
    .filter((g) => !g.members.some((t) => t.source === "local" || isDownloaded(t) || isDownloading(t) || haveSong(t)))
    .map((g) => g.members[0]);
}

const known = new Map();   // id списка → ключи треков, которые там уже были
const keysOf = (id) => new Set((autoListTracks(id) ?? []).map(keyOf));

/** Включить/выключить «Скачивать новые». catchUp — докачать и то, что уже лежит в списке */
export function setAutoList(id, on, catchUp = false) {
  setAutoDownload(id, on);
  if (!on) return known.delete(id);
  known.set(id, keysOf(id));   // то, что лежит сейчас, — «старое»: его качает только «Докачать все»
  if (catchUp) {
    const todo = songsToDownload(autoListTracks(id) ?? []);
    if (todo.length) download(todo);
  }
}

function checkAutoLists() {
  const lists = autoDownloadLists();
  for (const id of [...known.keys()]) if (!lists.includes(id)) known.delete(id);
  const fresh = [];
  for (const id of lists) {
    const before = known.get(id);
    const tracks = autoListTracks(id) ?? [];
    known.set(id, new Set(tracks.map(keyOf)));
    if (before) fresh.push(...tracks.filter((t) => !before.has(keyOf(t))));
  }
  const todo = songsToDownload(fresh);
  if (todo.length) download(todo);
}

let watching = false;
function watchAutoDownload() {
  if (watching) return;
  watching = true;
  for (const id of autoDownloadLists()) known.set(id, keysOf(id));   // при запуске — ничего не качаем заново
  onChange((section) => {
    if (section === "liked" || section === "playlists") checkAutoLists();
  });
}
