// Скачивание треков (как «Скачать» в Spotify): скачанные стартуют мгновенно и играют без интернета.
// Качает сервер, в фоне. Здесь — список скачанного (раздел медиатеки downloads),
// состояние каждого трека и опрос сервера, пока что-то качается.

import { addDownloads, keyOf, lib, removeDownloads } from "./library.js";

/** «источник:id» → done | queued | downloading | error | missing */
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

function apply(states) {
  for (const [key, value] of Object.entries(states)) status.set(key, value);
  notify();
  // Пока что-то качается — спрашиваем сервер раз в 1,5 секунды
  const active = [...status.values()].some((s) => s === "queued" || s === "downloading");
  if (active && !polling) polling = setTimeout(poll, 1500);
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
  if (!lib.downloads.length) return;
  try {
    apply(await post("/api/downloads", lib.downloads));
  } catch {}
}
