// Треки по ссылке: вставили ссылку YouTube/SoundCloud в поиск или прислали её из браузера
// кнопкой-закладкой «+ Sono» (адрес sono://add?url=… → desktop.py → /api/incoming/take).

import { keyOf } from "./library.js";
import { isPlaying, play, playFromQueue, queueNext, state } from "./player.js";
import { displayTrack, toast } from "./ui.js";

const LINK_RE = /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com\/(watch\?|shorts\/|live\/|embed\/)|youtu\.be\/|soundcloud\.com\/[\w-]+\/[\w-]+)/i;
/** Ссылка на трек YouTube/SoundCloud (кнопка «+ Sono» в браузере присылает только такие) */
export const looksLikeTrackLink = (text) => LINK_RE.test((text || "").trim());

// Ссылки, которые понимает поиск: ещё Spotify, Яндекс Музыка, Apple Music, Deezer (и VK — объясним, почему нельзя)
const ANY_LINK_HOST = /(^|\.)(spotify\.com|spotify\.link|spoti\.fi|music\.yandex\.(ru|com|by|kz|uz)|music\.apple\.com|music\.apple\.co|apple\.co|deezer\.com|deezer\.page\.link|youtube\.com|youtu\.be|soundcloud\.com|vk\.com|vk\.ru|boom\.ru)$/i;
export function looksLikeLink(text) {
  const t = (text || "").trim();
  if (t.startsWith("spotify:")) return true;
  if (/\s/.test(t) || !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}\/\S*$/i.test(t)) return false;
  try { return ANY_LINK_HOST.test(new URL(/^https?:/i.test(t) ? t : `https://${t}`).hostname); } catch { return false; }
}

/** Что за ссылка (сервер, linkinfo.py): { kind: "track"|"album"|"artist"|"list"|"search", … } */
export async function describeLink(url, signal) {
  const res = await fetch(`/api/link?url=${encodeURIComponent(url.trim())}`, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "не получилось открыть ссылку");
  return data;
}

const FROM_LINK = { type: "link", name: "По ссылке" };

export async function trackByUrl(url, signal) {
  const res = await fetch(`/api/track-by-url?url=${encodeURIComponent(url.trim())}`, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "не получилось открыть ссылку");
  return data.track;
}

const nameOf = (track) => {
  const shown = displayTrack(track);
  return shown.artist ? `${shown.artist} — ${shown.title}` : shown.title;
};

/** Трек из браузера. Ничего не играет — включаем сразу; играет — ставим следующим (и кнопка «Включить»),
    чтобы не обрывать то, что человек слушает */
async function receive(url) {
  try {
    const track = await trackByUrl(url);
    if (state.current && isPlaying()) {
      queueNext(track);
      toast(`«${nameOf(track)}» — играет следующим`, {
        action: {
          label: "Включить",
          run: () => {
            const i = state.queue.findIndex((t, n) => n > state.index && keyOf(t) === keyOf(track));
            if (i >= 0) playFromQueue(i);
            else play(track, [track], 0, FROM_LINK);
          },
        },
      });
    } else {
      play(track, [track], 0, FROM_LINK);
      toast(`Из браузера: «${nameOf(track)}»`);
    }
  } catch (err) {
    toast("Ссылка из браузера: " + err.message, { error: true });
  }
}

let taking = false;
let again = false;   // пока разбирали прошлые, пришла ещё ссылка

async function takeIncoming() {
  if (taking) { again = true; return; }
  taking = true;
  do {
    again = false;
    try {
      const res = await fetch("/api/incoming/take", { method: "POST" });
      const { urls = [] } = await res.json();
      for (const url of urls) await receive(url);
    } catch {}
  } while (again);
  taking = false;
}

export function initIncoming() {
  window.sonoIncoming = takeIncoming;   // desktop.py зовёт, когда ссылка пришла в уже открытый Sono
  takeIncoming();                       // Sono запустили самой кнопкой — ссылка уже ждёт
}
