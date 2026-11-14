// Мини-плеер поверх окон: окно Sono сжимается в маленькую плашку (обложка, название, кнопки)
// и стоит поверх остальных программ — удобно, когда работаешь или играешь. Само окно сжимает
// titlebar.py (set_mini), а страница прячет всё, кроме плашки #compact (body.mini-mode).
// Только в программе (в браузере размер окна страница не меняет).

import { whenWindowApi } from "./winapi.js";

const box = document.getElementById("compact");
const btn = document.getElementById("tb-mini");

let api = null;
let on = false;

export const isMini = () => on;

export function setMini(want) {
  if (!api || want === on) return;
  on = want;
  document.body.classList.toggle("mini-mode", on);
  box.hidden = !on;
  api.set_mini(on).catch(() => {});
}

export function toggleMini() { setMini(!on); }

function bind() {
  btn.hidden = false;
  btn.addEventListener("click", () => setMini(true));
  document.getElementById("cp-expand").addEventListener("click", () => setMini(false));
  document.getElementById("cp-close").addEventListener("click", () => api.close());

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
