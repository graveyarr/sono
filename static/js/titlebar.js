// Своя полоска заголовка окна вместо системной: «Назад», логотип, свернуть / развернуть / закрыть.
// Системную убирает titlebar.py (только в программе — в браузере полоски нет). Перетаскивание и кнопки
// идут через window.pywebview.api: окно получает те же сигналы, что от системного заголовка, поэтому
// работают и прилипание к краям экрана, и двойной щелчок «развернуть».

import { applyBackPlace } from "./backbtn.js";
import { canGoBack, goBack } from "./views.js";
import { whenWindowApi } from "./winapi.js";

const bar = document.getElementById("titlebar");
const backBtn = document.getElementById("tb-back");
const maxBtn = document.getElementById("tb-max");

let api = null;
let lastDown = 0;   // время прошлого нажатия на пустое место полоски — для двойного щелчка

async function syncMaximized() {
  const max = await api.is_maximized().catch(() => false);
  document.body.classList.toggle("win-max", !!max);
  maxBtn.title = maxBtn.ariaLabel = max ? "Свернуть в окно" : "Развернуть";
}

function bind() {
  document.body.classList.add("custom-titlebar");
  bar.hidden = false;

  // Пустое место полоски: тянуть — двигать окно, двойной щелчок — развернуть / вернуть
  bar.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, .tb-edge")) return;
    const now = Date.now();
    if (now - lastDown < 350) {
      lastDown = 0;
      api.toggle_maximize();
      return;
    }
    lastDown = now;
    api.drag();
  });
  // Верхний край и верхние углы — тянуть размер (остальные края у окна системные)
  bar.querySelectorAll(".tb-edge").forEach((edge) => edge.addEventListener("mousedown", (e) => {
    if (e.button === 0) api.resize(edge.dataset.edge);
  }));

  backBtn.addEventListener("click", goBack);
  document.getElementById("tb-min").addEventListener("click", () => api.minimize());
  maxBtn.addEventListener("click", () => api.toggle_maximize());
  document.getElementById("tb-close").addEventListener("click", () => api.close());

  // Развернули/вернули (кнопкой, двойным щелчком, Win+↑, прилипанием) — окно меняет размер
  let timer = 0;
  addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(syncMaximized, 80); });
  syncMaximized();
}

export function initTitlebar() {
  // «Назад» на панели (если выбрано в настройках — backbtn.js) работает и в обычном браузере
  const panelBack = document.getElementById("panel-back");
  panelBack?.addEventListener("click", goBack);
  applyBackPlace();
  const sync = () => {
    backBtn.disabled = !canGoBack();
    if (panelBack) panelBack.disabled = !canGoBack();
  };
  document.addEventListener("sono:view", sync);
  sync();

  const start = async () => {
    api = window.pywebview?.api;
    if (!api?.custom_titlebar) return;
    if (await api.custom_titlebar().catch(() => false)) bind();
  };
  // Для проверки вида в обычном браузере: ?titlebar — полоска без настоящего окна
  if (new URLSearchParams(location.search).has("titlebar")) {
    const nothing = async () => false;
    api = { drag: nothing, resize: nothing, minimize: nothing, toggle_maximize: nothing, close: nothing, is_maximized: nothing };
    return bind();
  }
  whenWindowApi(start);
}
