// Статус в Discord: «Слушает Sono» — что играет, обложка и сколько осталось. И плеер для стрима (OBS).
// Страница сообщает серверу о смене трека, паузе и перемотке; с Discord говорит сервер (discord_rpc.py).
// Выключается в настройках (settings.discord).

import { getSetting } from "./library.js";
import { isMeta } from "./meta.js";
import { onPlayState, onTrackChange, state } from "./player.js";
import { displayTrack } from "./ui.js";
import { isMobile } from "./device.js";

const audio = document.getElementById("player");
let timer = null;
let lastSent = "";

export const presenceEnabled = () => getSetting("discord", true) !== false;

function send(body) {
  const json = JSON.stringify(body);
  if (json === lastSent) return;
  lastSent = json;
  fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: json }).catch(() => {});
}

// ---------- Плеер для стрима (OBS) ----------
// Тот же рассказ «что играет» уходит и в маленький сервер для OBS (overlay.py), если он включён.
// В отличие от Discord, на паузе трек не стирается: плеер в OBS сам покажет рекламу Sono через несколько секунд.
export const obsEnabled = () => getSetting("obs", false) === true;
let lastObs = "";

function sendObs(body) {
  const json = JSON.stringify(body);
  if (json === lastObs) return;
  lastObs = json;
  fetch("/api/obs", { method: "POST", headers: { "Content-Type": "application/json" }, body: json }).catch(() => {});
}

/** Включить/выключить сервер для OBS. Ответ: { running, port, error } */
export async function setObsServer(on) {
  lastObs = "";
  const res = await fetch("/api/obs/server", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }) }).catch(() => null);
  if (on) updatePresence(0);
  return res ? res.json().catch(() => null) : null;
}

/** Отправить текущее состояние (с задержкой: при переключениях событий бывает много подряд) */
export function updatePresence(delay = 800) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const t = state.current;
    const body = !t || isMeta(t) ? null : (() => {
      const shown = displayTrack(t);
      return {
        source: t.source, id: t.id, title: shown.title, artist: shown.artist, album: t.album || "",
        cover: t.coverLarge || t.cover || "",
        // Позицию округляем: иначе каждый «тик» выглядел бы новым состоянием
        position: Math.round(audio.currentTime), duration: Math.round(t.duration || audio.duration || 0),
        playing: !audio.paused,
      };
    })();
    if (obsEnabled()) sendObs(body ? { ...body, speed: audio.playbackRate || 1 } : { clear: true });
    if (!presenceEnabled() || !body || !body.playing) return send({ clear: true });
    send(body);
  }, delay);
}

export function initPresence() {
  onTrackChange(() => updatePresence());
  onPlayState(() => updatePresence(300));
  audio.addEventListener("seeked", () => updatePresence(300));
  addEventListener("pagehide", () => {
    const clear = () => new Blob([JSON.stringify({ clear: true })], { type: "application/json" });
    navigator.sendBeacon?.("/api/presence", clear());
    if (obsEnabled()) navigator.sendBeacon?.("/api/obs", clear());
  });
  if (obsEnabled() && !isMobile) setObsServer(true);   // включали раньше — сервер для OBS поднимаем сразу
}
