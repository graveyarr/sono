// Мини-плеер поверх окон: окно Sono сжимается в маленькую плашку и стоит поверх остальных программ — удобно,
// когда работаешь или играешь. Две формы («Живая обложка», шаг 10; выбирается в «Виде» — look.js):
//   «Капсула» 440×84 — обложка, название, ♡ ⏮ ⏯ ⏭;
//   «Квадрат» 300×360 — обложка, название, две строки текста песни, ♡ ⏮ ⏯ ⏭ и 🎤 (текст в большом окне).
// В обеих: дизлайк — при наведении рядом с ♡, кнопки окна (поверх всех окон / развернуть / закрыть) — при наведении
// в углу, перемотка — тонкая полоска по нижнему краю, колесо — громкость, пустое место — тянуть окно,
// двойной щелчок — обратно в большое окно.
// Само окно сжимает titlebar.py (set_mini), страница прячет всё, кроме плашки #compact (body.mini-mode).
// Только в программе (в браузере размер окна страница не меняет).

import { miniLook, setMiniPin } from "./look.js";
import { setLyricsVisible, showMiniLyric } from "./lyrics.js";
import { stepVolume } from "./player.js";
import { whenWindowApi } from "./winapi.js";

const box = document.getElementById("compact");
const btn = document.getElementById("tb-mini");
const pinBtn = document.getElementById("cp-pin");
const lyric = box.querySelector(".cp-lyric");
const vol = box.querySelector(".cp-vol");

let api = null;
let on = false;

export const isMini = () => on;

function showPin(pin) {
  pinBtn.classList.toggle("on", pin);
  pinBtn.setAttribute("aria-pressed", String(pin));
  pinBtn.title = pin ? "Поверх всех окон — включено" : "Поверх всех окон — выключено";
}

export function setMini(want) {
  if (!api || want === on) return;
  on = want;
  const { shape, pin } = miniLook();
  box.dataset.shape = shape;
  showPin(pin);
  document.body.classList.toggle("mini-mode", on);
  box.hidden = !on;
  // Строки текста — только в «Квадрате» и только пока он открыт
  showMiniLyric(on && shape === "square" ? lyric : null);
  api.set_mini(on, shape, pin).catch(() => {});
}

export function toggleMini() { setMini(!on); }

/** Колесо над мини-плеером — громкость (как на большом ползунке), с подсказкой «Громкость 40%» */
let volTimer = 0;
function onWheel(e) {
  e.preventDefault();
  const level = stepVolume(e.deltaY < 0 ? 0.05 : -0.05);
  vol.textContent = `Громкость ${Math.round(level * 100)}%`;
  vol.classList.add("show");
  clearTimeout(volTimer);
  volTimer = setTimeout(() => vol.classList.remove("show"), 900);
}

function bind() {
  btn.hidden = false;
  btn.addEventListener("click", () => setMini(true));
  document.getElementById("cp-expand").addEventListener("click", () => setMini(false));
  document.getElementById("cp-close").addEventListener("click", () => api.close());
  pinBtn.addEventListener("click", () => {
    const pin = !miniLook().pin;
    setMiniPin(pin);
    showPin(pin);
    api.set_mini(true, miniLook().shape, pin).catch(() => {});
  });
  // 🎤 в «Квадрате» — весь текст песни в большом окне
  document.getElementById("cp-mic").addEventListener("click", async () => {
    setMini(false);
    setLyricsVisible(true);
    const views = await import("./views.js");
    views.showView?.("now");
  });
  box.addEventListener("wheel", onWheel, { passive: false });

  // Открылось окно-диалог (обновление, «Что нового», меню) — в маленькой плашке его не разглядеть,
  // возвращаем обычное окно
  new MutationObserver((changes) => {
    if (on && changes.some((c) => [...c.addedNodes].some((n) => n.classList?.contains("dialog-backdrop")))) setMini(false);
  }).observe(document.body, { childList: true });

  // Щёлкнули по имени исполнителя — его страница откроется в обычном окне
  box.addEventListener("click", (e) => { if (e.target.closest(".t-artist")) setMini(false); }, true);

  // Пустое место плашки — тянуть окно; двойной щелчок — вернуть обычное окно
  let lastDown = 0;
  box.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, a, .t-artist")) return;
    const now = Date.now();
    if (now - lastDown < 350) {
      lastDown = 0;
      setMini(false);
      return;
    }
    lastDown = now;
    api.drag();
  });
}

export function initCompact() {
  const start = async () => {
    const candidate = window.pywebview?.api;
    if (!candidate?.set_mini || !(await candidate.custom_titlebar().catch(() => false))) return;
    api = candidate;
    bind();
  };
  whenWindowApi(start);
}
