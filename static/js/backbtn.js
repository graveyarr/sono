// Где кнопка «Назад»: в полоске заголовка окна (как раньше) или на основной панели, слева от поиска
// (как в Spotify). settings.backButton = "titlebar" | "panel" → класс body.back-in-panel.
// Сами кнопки и их «Назад» подключает titlebar.js, выбор — «Настройки → Оформление».

import { getSetting, setSetting } from "./library.js";

export const BACK_PLACES = [
  { id: "titlebar", title: "В полоске окна", hint: "Маленькая стрелка слева вверху, рядом с «sono.»." },
  { id: "panel", title: "На панели", hint: "Крупная стрелка слева от поиска — как в Spotify." },
];

export const backPlace = () => (getSetting("backButton") === "panel" ? "panel" : "titlebar");

export function applyBackPlace() {
  document.body.classList.toggle("back-in-panel", backPlace() === "panel");
}

export function setBackPlace(place) {
  setSetting("backButton", place === "panel" ? "panel" : "titlebar");
  applyBackPlace();
}
