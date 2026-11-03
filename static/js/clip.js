// Клип вместо обложки на «Сейчас играет» (Настройки → Оформление → «Клипы вместо обложки»).
// Сервер (/api/clip) говорит, есть ли у трека клип: само играющее видео YouTube (если это не «- Topic» и не
// «audio/lyrics») или официальный клип той же длительности (±3 с — иначе картинка разойдётся с музыкой).
// Видео без звука идёт через сервер (/api/video/youtube/<id>, тот же обход блокировок) и подстраивается под
// звук: пауза, перемотка, скорость. Качаем видео, только пока открыт «Сейчас играет», — меньше интернета.

import { getSetting, setSetting } from "./library.js";
import { isMeta } from "./meta.js";
import { onTrackChange, state } from "./player.js";
import { displayTrack } from "./ui.js";

const audio = document.getElementById("player");
const video = document.getElementById("clip");
const wrap = video.closest(".cover-wrap");
const deck = video.closest(".deck");

let clipId = null;     // id видео клипа для текущего трека (null — нет клипа)
let forKey = "";       // для какого трека clipId
let token = 0;

export const clipsEnabled = () => getSetting("clips", true) !== false;

export function setClipsEnabled(on) {
  setSetting("clips", on);
  if (on) check();
  else hide(true);
}

const visible = () => document.body.classList.contains("on-now") && !document.hidden;
const keyOf = (t) => `${t.source}:${t.id}`;

function hide(drop = false) {
  wrap.classList.remove("clip-on");
  deck.classList.remove("has-clip");
  video.pause();
  if (drop) {
    clipId = null;
    video.removeAttribute("src");
    video.load();
  }
}

/** Трек сменился — спрашиваем сервер, есть ли клип */
async function check() {
  const track = state.current;
  const my = ++token;
  if (!track || isMeta(track) || !clipsEnabled()) return hide(true);
  if (keyOf(track) === forKey) return show();
  hide(true);
  forKey = keyOf(track);
  const shown = displayTrack(track);
  try {
    const res = await fetch("/api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: track.source, id: track.id, title: track.title, artist: shown.artist,
        channel: track.channel || "", duration: track.duration }),
    });
    const data = await res.json();
    if (my !== token) return;
    clipId = data.clip || null;
  } catch {
    clipId = null;
  }
  show();
}

/** Показать клип, если он есть и экран «Сейчас играет» открыт */
function show() {
  if (!clipId || !clipsEnabled()) return;
  if (!visible()) { video.pause(); return; }
  const src = `/api/video/youtube/${clipId}`;
  if (!video.src.endsWith(src)) {
    video.src = src;
    video.currentTime = audio.currentTime || 0;
  }
  deck.classList.add("has-clip");   // место под широкое видео — сразу, чтобы потом не прыгало
  sync(true);
}

/** Подогнать видео под звук: та же позиция, скорость, пауза */
function sync(hard = false) {
  if (!clipId || !video.src) return;
  video.playbackRate = audio.playbackRate || 1;
  const drift = video.currentTime - audio.currentTime;
  if (hard || Math.abs(drift) > 0.3) {
    if (video.duration && audio.currentTime > video.duration) return hide();   // клип короче трека — дальше обложка
    video.currentTime = audio.currentTime + (audio.paused ? 0 : 0.05);
  }
  if (!audio.paused && visible()) video.play().catch(() => {});
  else video.pause();
}

export function initClips() {
  onTrackChange(check);
  // Первые кадры готовы — плавно показываем видео поверх обложки
  video.addEventListener("loadeddata", () => {
    if (clipId && visible()) wrap.classList.add("clip-on");
  });
  // Видео не загрузилось — возвращаем обложку и больше не пытаемся для этого трека
  video.addEventListener("error", () => { if (video.getAttribute("src")) hide(true); });
  for (const ev of ["play", "pause", "seeked", "ratechange"]) audio.addEventListener(ev, () => sync(ev === "seeked"));
  // Раз в секунду проверяем, не разошлись ли (видео могло подгружаться)
  setInterval(() => { if (clipId && !audio.paused && visible()) sync(); }, 1000);
  // Открыли/закрыли «Сейчас играет» или свернули окно. Класс у body меняется часто (игра/пауза и т.п.) —
  // реагируем только на смену видимости, иначе видео каждый раз перематывалось бы
  let wasVisible = visible();
  const onScreen = () => {
    if (visible() === wasVisible) return;
    wasVisible = visible();
    if (wasVisible) show();
    else video.pause();
  };
  new MutationObserver(onScreen).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", onScreen);
}
