// Таймер сна (кнопка-луна data-np="sleep" у плеера и в мини-плеере): через N минут или в конце трека
// музыка плавно затихает и встаёт на паузу. Время идёт по часам — и на паузе тоже, как в Spotify.
// Затихание — отдельный регулятор в звуковой цепочке (sleepFade в audio.js), ползунок громкости не трогаем.

import { sleepFade } from "./audio.js";
import { icons } from "./icons.js";
import { isPlaying, state, togglePlay } from "./player.js";
import { openMenu, toast } from "./ui.js";

const FADE_SEC = 30;                       // столько секунд затихает перед паузой
const MINUTES = [10, 15, 30, 45, 60, 90];

let deadline = 0;       // когда выключить (мс), 0 — таймер по времени не стоит
let fading = false;
let timer = null;

const audio = document.getElementById("player");
const active = () => deadline > 0 || !!state.stopAfterTrack;

function minutesLeft() {
  return Math.max(1, Math.ceil((deadline - Date.now()) / 60000));
}

function sync() {
  const left = deadline ? `ещё ${minutesLeft()} мин` : state.stopAfterTrack ? "в конце трека" : "";
  document.querySelectorAll('[data-np="sleep"]').forEach((b) => {
    b.classList.toggle("on", active());
    b.title = active() ? `Таймер сна: ${left}` : "Таймер сна";
    b.setAttribute("aria-label", b.title);
  });
}

/** Сбросить всё: и таймер, и затихание (громкость обратно) */
function cancel(silent = false) {
  const was = active();
  deadline = 0;
  state.stopAfterTrack = null;
  clearInterval(timer);
  timer = null;
  if (fading) sleepFade(1, 0.4);
  fading = false;
  sync();
  if (was && !silent) toast("Таймер сна выключен");
}

/** Время вышло: пауза, потом громкость обратно (следующее «Играть» — с обычной громкостью) */
function finish() {
  deadline = 0;
  state.stopAfterTrack = null;
  clearInterval(timer);
  timer = null;
  if (isPlaying()) togglePlay();
  setTimeout(() => { sleepFade(1, 0); fading = false; }, 400);
  sync();
  toast("Спокойной ночи — музыка на паузе");
}

function tick() {
  if (deadline) {
    const left = (deadline - Date.now()) / 1000;
    if (left <= 0) return finish();
    if (left <= FADE_SEC && !fading && isPlaying()) {
      fading = sleepFade(0, left);
    }
  } else if (state.stopAfterTrack) {
    // «До конца трека»: затихаем в последние секунды (у трека без длины — просто пауза в конце)
    const left = (audio.duration || 0) - audio.currentTime;
    if (Number.isFinite(left) && left > 0 && left <= 8 && !fading && isPlaying()) fading = sleepFade(0, left);
    if (fading && left > 8) { sleepFade(1, 0.4); fading = false; }   // перемотали назад
  }
  sync();
}

function start(minutes) {
  cancel(true);
  if (minutes === "track") {
    state.stopAfterTrack = finish;
    toast("Музыка выключится в конце трека");
  } else {
    deadline = Date.now() + minutes * 60000;
    toast(`Музыка выключится через ${minutes} мин`);
  }
  timer = setInterval(tick, 1000);
  sync();
}

function openSleepMenu(anchor) {
  const items = [];
  if (active()) {
    items.push({ note: deadline ? `Выключится через ${minutesLeft()} мин` : "Выключится в конце трека" });
    items.push({ label: "Выключить таймер", icon: icons.close, action: () => cancel() });
    items.push({ sep: true });
  }
  MINUTES.forEach((m) => items.push({ label: `${m} минут`, icon: icons.clock, action: () => start(m) }));
  items.push({ label: "До конца трека", icon: icons.moon, action: () => start("track") });
  openMenu(anchor, items);
}

export function initSleepButton() {
  document.querySelectorAll('[data-np="sleep"]').forEach((b) => {
    b.innerHTML = icons.moon;
    b.addEventListener("click", () => openSleepMenu(b));
  });
  // Сменили трек вручную во время затихания «в конце трека» — громкость обратно, ждём конца нового
  audio.addEventListener("loadstart", () => {
    if (fading && state.stopAfterTrack) { sleepFade(1, 0); fading = false; }
  });
  sync();
}
