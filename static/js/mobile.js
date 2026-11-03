// Телефон (приложение для Android, папка android/): нижние вкладки, медиатека отдельным экраном,
// системная кнопка «Назад». Раскладку меняет CSS по классу body.mobile, здесь — только поведение.

import { coverUrl, closeMenu, displayTrack } from "./ui.js";
import { isPlaying, onPlayState, onTrackChange, playNext, playPrev, seekTo, state, togglePlay } from "./player.js";
import { closePanel, focusSearch } from "./search.js";
import { canGoBack, goBack, showView } from "./views.js";

// MainActivity.kt дописывает «SonoAndroid» к имени браузера; ?mobile — посмотреть вид на компьютере
export const isMobile = /SonoAndroid/.test(navigator.userAgent) || new URLSearchParams(location.search).has("mobile");
if (isMobile) document.body.classList.add("mobile");

const tabbar = document.getElementById("tabbar");
let view = "home";

const setLibraryOpen = (open) => {
  document.body.classList.toggle("lib-open", open);
  syncTabs();
};

function syncTabs() {
  const lib = document.body.classList.contains("lib-open");
  const active = lib ? "library" : view === "home" ? "home" : view === "flow" ? "flow" : "";
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
  // Очередь на телефоне — слоем на весь экран; при запуске её не показываем (кнопка сама включит снова)
  document.body.classList.remove("show-queue");
  document.querySelectorAll('[data-np="queue"]').forEach((b) => b.classList.remove("on"));
  window.sonoBack = back;
  if (window.SonoAndroid) {
    onTrackChange(sendMedia);
    onPlayState(sendMedia);
    audio.addEventListener("seeked", sendMedia);
    audio.addEventListener("loadedmetadata", sendMedia);
  }
  syncTabs();
}
