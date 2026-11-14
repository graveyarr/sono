// Телефон (приложение для Android, папка android/): нижние вкладки, медиатека отдельным экраном,
// системная кнопка «Назад». Раскладку меняет CSS по классу body.mobile, здесь — только поведение.

import { isMobile } from "./device.js";
import { icons } from "./icons.js";
import { coverUrl, closeMenu, displayTrack } from "./ui.js";
import { isPlaying, onPlayState, onTrackChange, playNext, playPrev, seekTo, state, togglePlay } from "./player.js";
import { closePanel, focusSearch } from "./search.js";
import { canGoBack, goBack, showView } from "./views.js";

export { isMobile };
if (isMobile) document.body.classList.add("mobile");

// На компьютере трек начинает готовиться, пока к нему ведут мышь (mouseenter → prefetch в search/views/artist).
// У пальца «наведения» нет: mouseenter приходит только вместе с нажатием. Поэтому шлём его сами в момент
// касания — пока палец на экране, сервер уже ищет пару и ссылку на звук. Других дел у mouseenter в коде нет
if (isMobile) document.addEventListener("touchstart", (e) => {
  for (const el of e.composedPath()) {
    if (el === document.body || !(el instanceof Element)) break;
    el.dispatchEvent(new MouseEvent("mouseenter"));
  }
}, { passive: true, capture: true });

// Долгое нажатие = меню «⋯» (на компьютере его открывает правая кнопка мыши): у треков, плейлистов, папок.
// Шлём «contextmenu» сами — так одинаково на всех телефонах; собственное «contextmenu» браузера гасим,
// чтобы меню не открылось дважды (в полях ввода оставляем — там это «Вставить/Выделить»)
if (isMobile) {
  let timer = 0, start = null, firedAt = 0;
  const cancel = () => clearTimeout(timer);
  document.addEventListener("touchstart", (e) => {
    cancel();
    if (e.touches.length !== 1) return;
    const target = e.target;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    timer = setTimeout(() => {
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y });
      if (!target.dispatchEvent(menu)) firedAt = Date.now();   // кто-то открыл меню (вызвал preventDefault)
    }, 450);
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();   // листают, а не держат
  }, { passive: true });
  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
  document.addEventListener("contextmenu", (e) => {
    if (e.isTrusted && !e.target.closest?.("input, textarea")) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // Палец отпустили после меню — этот «щелчок» не должен включать трек или открывать плейлист
  document.addEventListener("click", (e) => {
    if (Date.now() - firedAt < 800) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

const tabbar = document.getElementById("tabbar");
let view = "home";

const setLibraryOpen = (open) => {
  document.body.classList.toggle("lib-open", open);
  syncTabs();
};

function syncTabs() {
  const lib = document.body.classList.contains("lib-open");
  const searching = document.getElementById("panel").classList.contains("open");
  const active = lib ? "library" : searching ? "search" : view === "home" ? "home" : view === "flow" ? "flow" : "";
  tabbar.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === active));
}

function openTab(tab) {
  if (tab === "library") return setLibraryOpen(!document.body.classList.contains("lib-open"));
  setLibraryOpen(false);
  if (tab === "search") {
    if (view === "now") showView("home");   // на «Сейчас играет» строки поиска нет
    focusSearch();
    return;
  }
  showView(tab);
}

/** Системная «Назад»: закрыть то, что открыто поверх, или вернуться на прошлый экран.
    false — закрывать нечего (MainActivity сворачивает приложение, музыка играет дальше) */
function back() {
  const body = document.body;
  const dialog = document.querySelector(".dialog-backdrop.open");
  if (dialog) {
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  }
  if (document.querySelector(".menu.open")) { closeMenu(); return true; }
  // Слои, которые на компьютере закрываются клавишей Esc (их обработчики висят на window):
  // экскурсия, «Итоги года», окно звуковых эффектов
  if (document.querySelector(".tour, .wrapped:not(.leaving), .fx-panel")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return true;
  }
  if (document.getElementById("panel").classList.contains("open")) {
    closePanel();
    document.getElementById("query").blur();
    return true;
  }
  if (body.classList.contains("lib-open")) { setLibraryOpen(false); return true; }
  if (body.classList.contains("on-now") && body.classList.contains("show-lyrics")) {
    document.querySelector('[data-np="lyrics"]').click();
    return true;
  }
  if (body.classList.contains("on-now") && body.classList.contains("show-queue")) {
    document.querySelector('[data-np="queue"]').click();
    return true;
  }
  if (canGoBack()) { goBack(); return true; }
  if (view !== "home") { showView("home"); return true; }
  return false;
}

// ---------- Шторка и экран блокировки (PlaybackService.kt) ----------
// Звук играет эта страница, а приложение показывает уведомление с кнопками и держит музыку в фоне.
// Мы сообщаем ему, что играет; оно присылает нажатия кнопок в window.sonoMedia.
const audio = document.getElementById("player");
let mediaTimer = 0;

function sendMedia() {
  clearTimeout(mediaTimer);
  mediaTimer = setTimeout(() => {
    const t = state.current;
    if (!t) return;
    const shown = displayTrack(t);
    const cover = coverUrl(t, "large");
    const duration = Number(audio.dataset.trackDuration) || audio.duration || t.duration || 0;
    window.SonoAndroid.media(shown.title || "", shown.artist || "", cover ? new URL(cover, location.href).href : "",
      isPlaying(), Math.round(duration * 1000), Math.round(audio.currentTime * 1000));
  }, 150);
}

window.sonoMedia = (action, ms) => {
  if (action === "play" || action === "pause") { if ((action === "play") !== isPlaying()) togglePlay(); }
  else if (action === "next") playNext();
  else if (action === "prev") playPrev();
  else if (action === "seek") seekTo(ms / 1000);
};

export function initMobile() {
  if (!isMobile) return;
  tabbar.hidden = false;
  tabbar.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) openTab(tab.dataset.tab);
  });
  // Выбрали что-то в медиатеке — она закрывается, открывается выбранное
  document.addEventListener("sono:view", (e) => {
    view = e.detail;
    setLibraryOpen(false);
  });
  // Мини-плеер: на компьютере имя исполнителя и название — ссылки (на исполнителя, на альбом).
  // На телефоне они мелкие, и палец попадал в них вместо «открыть плеер» — вся плашка открывает «Сейчас играет»
  document.getElementById("minibar-open").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    showView("now");
  }, true);
  // Очередь и текст песни закрывают весь экран — снизу кнопка «Свернуть» (видна, только пока они открыты)
  const sheetClose = document.createElement("button");
  sheetClose.type = "button";
  sheetClose.className = "np-sheet-close";
  sheetClose.innerHTML = `${icons.chevron}<span>Свернуть</span>`;
  sheetClose.addEventListener("click", () => {
    const which = document.body.classList.contains("show-lyrics") ? "lyrics" : "queue";
    document.querySelector(`#view-now [data-np="${which}"]`)?.click();
  });
  document.getElementById("view-now").append(sheetClose);
  // Очередь на телефоне — слоем на весь экран; при запуске её не показываем (кнопка сама включит снова)
  document.body.classList.remove("show-queue");
  document.querySelectorAll('[data-np="queue"]').forEach((b) => b.classList.remove("on"));
  window.sonoBack = back;
  // Поиск: открыта панель результатов — подсвечена вкладка «Поиск»
  new MutationObserver(syncTabs).observe(document.getElementById("panel"), { attributes: true, attributeFilter: ["class"] });
  // Кнопка «→» на клавиатуре телефона — спрятать клавиатуру, чтобы были видны все результаты
  const query = document.getElementById("query");
  query.enterKeyHint = "search";
  query.addEventListener("keydown", (e) => { if (e.key === "Enter") query.blur(); });
  // Пока открыта клавиатура, мини-плеер и вкладки над ней только отнимают место у того, что печатают и ищут
  let fullHeight = visualViewport.height;
  const syncKeyboard = () => {
    fullHeight = Math.max(fullHeight, visualViewport.height);
    const typing = document.activeElement?.matches("input:not([type=range]):not([type=checkbox]), textarea");
    document.body.classList.toggle("kb-open", !!typing && visualViewport.height < fullHeight - 150);
  };
  visualViewport.addEventListener("resize", syncKeyboard);
  document.addEventListener("focusin", syncKeyboard);
  document.addEventListener("focusout", () => setTimeout(syncKeyboard, 0));
  if (window.SonoAndroid) {
    onTrackChange(sendMedia);
    onPlayState(sendMedia);
    audio.addEventListener("seeked", sendMedia);
    audio.addEventListener("loadedmetadata", sendMedia);
  }
  syncTabs();
}
