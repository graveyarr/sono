// Точка входа: загружаем медиатеку, подключаем все части и горячие клавиши.

import { openAddToPlaylist, openTrackAlbum, toggleDislike, toggleLike } from "./actions.js";
import { initDownloads, onDownloadsChange } from "./downloads.js";
import { initFlow } from "./flow.js";
import { initPresence } from "./presence.js";
import { initViz } from "./viz.js";
import { initSeekViz } from "./seekviz.js";
import { initNowBackground } from "./nowbg.js";
import { initClips } from "./clip.js";
import { initAudio } from "./audio.js";
import { initFxButton } from "./fx.js";
import { initSleepButton } from "./sleep.js";
import { initFlowView } from "./flowview.js";
import { initStats } from "./stats.js";
import { maybeWelcome } from "./welcome.js";
import { applyMotion, watchAppUpdate } from "./settings.js";
import { initTitlebar } from "./titlebar.js";
import { initThemes } from "./themes.js";
import { initCompact, isMini, toggleMini } from "./compact.js";
import { initIncoming } from "./links.js";
import { maybeWhatsNew } from "./whatsnew.js";
import { loadLocal, onLocalChange } from "./local.js";
import { announceNewReleases } from "./releases.js";
import { flush, getSetting, loadLibrary, onChange, onSaveError } from "./library.js";
import { markRecent } from "./libtools.js";
import { initLyrics } from "./lyrics.js";
import { initMobile } from "./mobile.js";
import { initPlayer, isPlaying, restoreSession, onPlayState, onTrackChange, playNext, playPrev, seekBy, state, syncLikeButtons, togglePlay } from "./player.js";
import { focusSearch, initSearch, refreshHistory } from "./search.js";
import { displayTrack, syncAllRows, toast } from "./ui.js";
import { initViews, refreshDownloads, refreshPlaying, refreshViews, syncPlayButtons } from "./views.js";

try {
  await loadLibrary();
} catch (err) {
  toast("Не удалось загрузить медиатеку: " + err.message, { error: true });
}

applyMotion();   // «Без анимаций» — до всего остального, чтобы ничего не успело дёрнуться
initThemes();    // тема оформления (themes.js) — тоже как можно раньше, чтобы не мелькала обычная
initPlayer();
loadLocal();   // свои файлы с компьютера — раздел «Мои файлы» в медиатеке
initSearch();
initViews();
initMobile();   // телефон: нижние вкладки и кнопка «Назад» (на компьютере ничего не делает)
initLyrics();
initFlow();
initPresence();
initAudio();
initViz();
initSeekViz();   // живая полоса перемотки — если её просит тема
initNowBackground();   // фон «Сейчас играет»: свет / тихий / градиент / линии
initClips();   // клип вместо обложки, где он есть
initFxButton();
initSleepButton();
initFlowView();
initStats();
initTitlebar();   // своя полоска заголовка окна (в программе; в браузере её нет)
initCompact();    // мини-плеер поверх окон (тоже только в программе)
restoreSession();   // что играло в прошлый раз — на паузе и уже подгружается (после всех init: они слушают смену трека)
initIncoming();     // трек, присланный из браузера кнопкой «+ Sono» (после restoreSession — чтобы он его не перебил)
maybeWelcome();   // первый запуск — приветствие и экскурсия
setTimeout(maybeWhatsNew, 1200);

// ---------- Значок в трее (tray.py) ----------
// Меню значка просит страницу: пауза, следующий, предыдущий. А страница сообщает значку, что играет
window.sonoTray = (action) => ({ toggle: togglePlay, next: playNext, prev: playPrev })[action]?.();
const trayApi = () => window.pywebview?.api?.tray_status ? window.pywebview.api : null;
const sendTray = () => {
  const api = trayApi();
  if (!api) return;
  const shown = state.current ? displayTrack(state.current) : null;
  api.tray_status(shown ? `${shown.artist ? `${shown.artist} — ` : ""}${shown.title}` : "", isPlaying()).catch(() => {});
};
onTrackChange(sendTray);
onPlayState(sendTray);
const sendCloseToTray = () => trayApi()?.set_close_to_tray(getSetting("closeToTray", true) !== false).catch(() => {});
if (window.pywebview?.api) sendCloseToTray();
else addEventListener("pywebviewready", sendCloseToTray, { once: true });
document.addEventListener("sono:close-to-tray", sendCloseToTray);
setTimeout(announceNewReleases, 6000);   // вышло что-то у исполнителей, на которых подписан, — уведомление   // обновились — коротко рассказать, что нового (после приветствия, если оно было)
watchAppUpdate();   // скачалась новая версия Sono — предложим обновиться
// Щелчок по названию трека на «Сейчас играет» — открыть его альбом/сингл и подсветить трек
document.querySelector('#np-info [data-np="title"]').addEventListener("click", () => openTrackAlbum(state.current));
// Скачивания: значки у треков и кнопки «Скачать» обновляются, пока сервер качает
onDownloadsChange(() => { syncAllRows(); refreshDownloads(); });
onLocalChange(() => refreshViews("local"));   // нашлись новые свои файлы — медиатека и открытый список
initDownloads();

// Медиатека изменилась → обновить всё, что её показывает
onChange((section) => {
  // Сердечки — и при смене плейлистов: ♡ может класть в выбранный плейлист (settings.likeTarget)
  if (section === "liked" || section === "disliked" || section === "playlists") {
    syncAllRows();
    syncLikeButtons();
  }
  if (section === "history") refreshHistory();
  refreshViews(section);
});
onSaveError((err) => toast("Не удалось сохранить медиатеку: " + err.message, { error: true }));
addEventListener("pagehide", flush);

onTrackChange(refreshPlaying);
// «Недавние» в медиатеке: из какого списка включали музыку (порядок обновится при следующей перерисовке —
// чтобы строка не прыгала вверх прямо под курсором)
let recentKey = "";
onTrackChange(() => {
  const c = state.context;
  const key = !c ? "" : c.type === "playlist" ? `playlist:${c.id}` : c.type === "artist" ? `artist:${c.id}` : c.type;
  if (key && key !== recentKey) { recentKey = key; markRecent(key); }
});
onPlayState(syncPlayButtons);

// Кнопки у текущего трека (на большом экране и в мини-плеере)
const withCurrent = (fn) => () => { if (state.current) fn(state.current); };
document.querySelectorAll('[data-np="like"]').forEach((b) => b.addEventListener("click", withCurrent(toggleLike)));
document.querySelectorAll('[data-np="dislike"]').forEach((b) => b.addEventListener("click", withCurrent(toggleDislike)));
document.querySelectorAll('[data-np="add"]').forEach((b) => b.addEventListener("click", () => {
  if (state.current) openAddToPlaylist(b, state.current);
}));

// ---------- Горячие клавиши ----------
// Пробел — пауза, ←/→ — перемотка на 5 с, L — в избранное, Ctrl+K или / — к поиску (на любой раскладке)

// Кнопка «нажимается» пробелом при его отпускании — гасим и это, иначе сработало бы и то, и другое
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && e.target.closest?.("button, .lib-item") && !e.target.closest(".dialog-backdrop, .menu")) e.preventDefault();
});

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.(".dialog-backdrop, .menu")) return;   // в диалоге и меню клавиши свои
  // По клавише (e.code), а не по букве: на русской раскладке Ctrl+K — это «Ctrl+Л», а «/» — это «.»
  const typing = e.target.matches?.("input:not([type=range]), textarea, select, [contenteditable]");
  if (e.ctrlKey && e.code === "KeyM" && !e.altKey && !e.shiftKey) {   // мини-плеер поверх окон
    e.preventDefault();
    toggleMini();
    return;
  }
  if ((e.ctrlKey && e.code === "KeyK") || (e.code === "Slash" && !e.ctrlKey && !e.altKey && !typing)) {
    e.preventDefault();
    if (isMini()) toggleMini();   // искать — в обычном окне
    focusSearch();
    return;
  }
  if (typing) return;   // в поле ввода клавиши нужны для текста
  // Пробел — всегда пауза/продолжить, даже если в фокусе кнопка: раньше он «нажимал» последнюю нажатую
  // кнопку (например, «Следующая») — так браузер ведёт себя с кнопками. Стрелки на ползунке браузер обработает сам
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) togglePlay(); }
  else if (e.target.type === "range" || !state.current || e.ctrlKey || e.altKey) return;
  else if (e.key === "ArrowLeft") seekBy(-5);
  else if (e.key === "ArrowRight") seekBy(5);
  else if (e.code === "KeyL") toggleLike(state.current);
});
