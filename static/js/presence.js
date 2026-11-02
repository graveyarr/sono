// Статус в Discord: «Слушает Sono» — что играет, обложка и сколько осталось.
// Страница сообщает серверу о смене трека, паузе и перемотке; с Discord говорит сервер (discord_rpc.py).
// Выключается в настройках (settings.discord).

import { getSetting } from "./library.js";
import { isMeta } from "./meta.js";
import { onPlayState, onTrackChange, state } from "./player.js";
import { displayTrack } from "./ui.js";

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

/** Отправить текущее состояние (с задержкой: при переключениях событий бывает много подряд) */
export function updatePresence(delay = 800) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const t = state.current;
    if (!presenceEnabled() || !t || isMeta(t) || audio.paused) return send({ clear: true });
    const shown = displayTrack(t);
    send({
      source: t.source, id: t.id, title: shown.title, artist: shown.artist, album: t.album || "",
      cover: t.coverLarge || t.cover || "",
      // Позицию округляем: иначе каждый «тик» выглядел бы новым состоянием
      position: Math.round(audio.currentTime), duration: Math.round(t.duration || audio.duration || 0), playing: true,
    });
  }, delay);
}

export function initPresence() {
  onTrackChange(() => updatePresence());
  onPlayState(() => updatePresence(300));
  audio.addEventListener("seeked", () => updatePresence(300));
  addEventListener("pagehide", () => navigator.sendBeacon?.("/api/presence", new Blob([JSON.stringify({ clear: true })], { type: "application/json" })));
}
