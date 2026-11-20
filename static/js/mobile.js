// Телефон (приложение для Android, папка android/): нижние вкладки, медиатека отдельным экраном,
// системная кнопка «Назад». Раскладку меняет CSS по классу body.mobile, здесь — только поведение.

import { openAddToPlaylist } from "./actions.js";
import { isMobile } from "./device.js";
import { openFxPanel } from "./fx.js";
import { icons } from "./icons.js";
import { resolvedOf } from "./meta.js";
import { openTrack } from "./nav.js";
import { openShareCard } from "./sharecard.js";
import { sleepMenuItems } from "./sleep.js";
import { coverUrl, closeMenu, displayTrack, el, openMenu } from "./ui.js";
import { isPlaying, onPlayState, onTrackChange, playNext, playPrev, seekTo, state, togglePlay } from "./player.js";
import { closePanel, focusSearch } from "./search.js";
import { canGoBack, contextName, goBack, showView } from "./views.js";

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
let searchMode = false;   // нажата вкладка «Поиск»: видна строка поиска (на остальных экранах её нет — шаг 11)

const setSearchMode = (on) => {
  searchMode = on;
  document.body.classList.toggle("search-open", on);
};

const setLibraryOpen = (open) => {
  document.body.classList.toggle("lib-open", open);
  syncTabs();
};

function syncTabs() {
  const lib = document.body.classList.contains("lib-open");
  const searching = searchMode || document.getElementById("panel").classList.contains("open");
  const active = lib ? "library" : searching ? "search" : view === "home" ? "home" : view === "flow" ? "flow" : "";
  const tabs = [...tabbar.querySelectorAll(".tab")];
  tabs.forEach((t) => t.classList.toggle("on", t.dataset.tab === active));
  // Подсветка под значком переезжает к выбранной вкладке (style.css, «шаг 11»); нет выбранной — гаснет
  const at = tabs.findIndex((t) => t.dataset.tab === active);
  if (at >= 0) tabbar.style.setProperty("--tab-i", at);
  tabbar.classList.toggle("has-on", at >= 0);
}

function openTab(tab) {
  if (tab === "library") return setLibraryOpen(!document.body.classList.contains("lib-open"));
  setLibraryOpen(false);
  if (tab === "search") {
    const open = () => { setSearchMode(true); syncTabs(); focusSearch(); };
    // На «Сейчас играет» строки поиска нет — сначала «Главная» (её событие sono:view выключает поиск, поэтому — после)
    if (view === "now") Promise.resolve(showView("home")).then(open);
    else open();
    return;
  }
  setSearchMode(false);
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
  // Редактор тем (editor.js) — закрыть его (спросит, сохранить ли изменения)
  if (body.classList.contains("theme-editing")) {
    dispatchEvent(new CustomEvent("sono:editor-back"));
    return true;
  }
  // Слои, которые на компьютере закрываются клавишей Esc (их обработчики висят на window):
  // экскурсия, «Итоги года», окно звуковых эффектов
  if (document.querySelector(".tour, .wrapped:not(.leaving), .fx-panel")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return true;
  }
  if (document.getElementById("panel").classList.contains("open") || searchMode) {
    closePanel();
    document.getElementById("query").blur();
    setSearchMode(false);
    syncTabs();
    return true;
  }
  if (body.classList.contains("lib-open")) { setLibraryOpen(false); return true; }
  if (body.classList.contains("sheet-queue") || body.classList.contains("sheet-more")) { closeSheets(); return true; }
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

// ---------- Полоска сверху у плейлиста, альбома, исполнителя (шаг 11в, макет B-telefon-ekrany.html) ----------
// «‹» — назад, «⋯» — меню плейлиста (его кнопка в ряду под шапкой на телефоне спрятана). Пока шапка видна,
// полоска прозрачная; прокрутили ниже — стекло и название посередине

const LIST_VIEW = /^(playlist|album|artist|pick):|^(liked|disliked)$/;

function initTopBar() {
  const bar = el("div", "m-bk");
  const back = btn("m-bk-back", icons.back);
  back.setAttribute("aria-label", "Назад");
  const title = el("b", "m-bk-title");
  const more = btn("m-bk-more", icons.more);
  more.setAttribute("aria-label", "Ещё");
  bar.append(back, title, more);
  document.body.append(bar);
  back.addEventListener("click", () => (canGoBack() ? goBack() : showView("home")));
  more.addEventListener("click", () => document.querySelector("#view-list .pl-more")?.click());
  const scroller = document.getElementById("views");
  const sync = () => {
    const solid = document.body.classList.contains("on-list") && scroller.scrollTop > 220;
    if (solid) title.textContent = document.querySelector("#view-list .pl-name")?.textContent ?? "";
    bar.classList.toggle("solid", solid);
  };
  scroller.addEventListener("scroll", sync, { passive: true });
  document.addEventListener("sono:view", (e) => {
    document.body.classList.toggle("on-list", LIST_VIEW.test(e.detail));
    sync();
  });
  document.body.classList.toggle("on-list", LIST_VIEW.test(view));
}

// ---------- «Сейчас играет» (шаг 11б, макет B-telefon.html) ----------
// Во весь экран: сверху «свернуть», «Играет из …» и «Ещё»; внизу три подписанные кнопки «Текст / Далее / Ещё».
// «Далее» (очередь) и «Ещё» (6 действий с подписями) — листы снизу. Жесты: обложку вбок — другой трек,
// вниз (обложку или шапку) — свернуть. Кнопки эффектов, таймера, дизлайка и «в плейлист» остаются в разметке
// (их рисуют и слушают fx.js, sleep.js, player.js), на телефоне они спрятаны — их зовёт лист «Ещё»

const nowView = document.getElementById("view-now");
const npButton = (role) => nowView.querySelector(`[data-np="${role}"]`);
const btn = (className, icon, label) => {
  const b = el("button", className);
  b.type = "button";
  b.innerHTML = icon;
  if (label) b.append(el("span", "", label));
  return b;
};

function closeSheets() {
  document.body.classList.remove("sheet-queue", "sheet-more");
  syncPills();
}
function openSheet(name) {
  closeMenu();
  document.body.classList.remove("sheet-queue", "sheet-more");
  document.body.classList.add(`sheet-${name}`);
  if (name === "more") fillMore();
  syncPills();
}

/** Свернуть «Сейчас играет» — туда, откуда пришли */
function closeNow() {
  closeSheets();
  if (canGoBack()) goBack();
  else showView(view === "now" ? "home" : view);
}

let pills = null, moreSheet = null, fromName = null;
function syncPills() {
  if (!pills) return;
  const body = document.body.classList;
  pills.lyr.classList.toggle("on", body.contains("show-lyrics"));
  pills.queue.classList.toggle("on", body.contains("sheet-queue"));
  pills.more.classList.toggle("on", body.contains("sheet-more"));
}

function syncFrom() {
  const name = state.current ? contextName(state.context) : "";
  fromName.textContent = name || "Sono";
}

/** Лист «Ещё»: обложка и название, 6 подписанных действий */
function fillMore() {
  const t = state.current;
  if (!t) return;
  const shown = displayTrack(t);
  const head = moreSheet.querySelector(".np-more-track");
  head.querySelector("img").src = coverUrl(t);
  head.querySelector("b").textContent = shown.title;
  head.querySelector("span").textContent = shown.artist;
  const dis = npButton("dislike");
  const disTile = moreSheet.querySelector("[data-act=dislike]");
  disTile.classList.toggle("on", dis.classList.contains("on"));
  disTile.querySelector("span").textContent = dis.classList.contains("on") ? "Не нравится ✓" : "Не нравится";
  moreSheet.querySelector("[data-act=sleep]").classList.toggle("on", npButton("sleep").classList.contains("on"));
  moreSheet.querySelector("[data-act=fx]").classList.toggle("on", npButton("fx").classList.contains("on"));
}

function moreAction(act) {
  const t = state.current;
  closeSheets();
  if (!t) return;
  const anchor = pills.more;   // меню (таймер, плейлисты) открывается над кнопкой «Ещё»
  if (act === "fx") openFxPanel(anchor);
  else if (act === "sleep") openMenu(anchor, sleepMenuItems());
  else if (act === "add") openAddToPlaylist(anchor, t);
  else if (act === "about") openTrack(t);
  else if (act === "share") openShareCard(t, resolvedOf(t) ?? t);
  else if (act === "dislike") npButton("dislike").click();
}

/** Палец по элементу: вбок (onX) или вниз (onY) — как в макете (drag) */
function drag(node, onX, onY, only = () => true) {
  let sx = 0, sy = 0, axis = null, id = null;
  node.addEventListener("pointerdown", (e) => {
    if (e.button || e.target.closest("button, input, a") || !only(e.target)) return;
    sx = e.clientX; sy = e.clientY; axis = null; id = e.pointerId;
  });
  node.addEventListener("pointermove", (e) => {
    if (id !== e.pointerId) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!axis && Math.hypot(dx, dy) > 8) {
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if ((axis === "x" && !onX) || (axis === "y" && !onY)) { id = null; return; }
      node.setPointerCapture(id);
    }
    if (axis === "x") onX.move(dx);
    if (axis === "y") onY.move(dy);
  });
  const end = (e) => {
    if (id !== e.pointerId) return;
    id = null;
    if (axis === "x") onX.end(e.clientX - sx);
    if (axis === "y") onY.end(e.clientY - sy);
    axis = null;
  };
  node.addEventListener("pointerup", end);
  node.addEventListener("pointercancel", end);
}

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
function initGestures(head) {
  const cover = nowView.querySelector(".cover-wrap");
  const lyricsOn = () => document.body.classList.contains("show-lyrics");
  const swipeX = {
    move: (dx) => { if (!lyricsOn()) cover.style.translate = `${dx * 0.9}px 0`, cover.style.rotate = `${dx / 40}deg`; },
    end: (dx) => {
      const from = [cover.style.translate, cover.style.rotate];
      cover.style.translate = cover.style.rotate = "";
      if (from[0]) cover.animate([{ translate: from[0], rotate: from[1] || "0deg" }, { translate: "0 0", rotate: "0deg" }], { duration: 480, easing: EASE });
      if (Math.abs(dx) > 70) (dx < 0 ? playNext : playPrev)();
    },
  };
  const swipeDown = {
    move: (dy) => {
      nowView.style.transform = `translateY(${Math.max(0, dy)}px)`;
      nowView.style.opacity = String(1 - Math.max(0, dy) / 900);
    },
    end: (dy) => {
      const from = nowView.style.transform;
      nowView.style.transform = nowView.style.opacity = "";
      if (dy > 110) {
        nowView.animate([{ transform: from, opacity: 1 - dy / 900 }, { transform: "translateY(100%)", opacity: 0.4 }],
          { duration: 320, easing: "cubic-bezier(.4,0,1,1)" }).finished.then(closeNow);
      } else if (from) nowView.animate([{ transform: from }, { transform: "none" }], { duration: 420, easing: EASE });
    },
  };
  drag(cover, swipeX, swipeDown);
  drag(head, null, swipeDown);
  // Листы тянут вниз за верх (у «Далее» список листается сам) — закрываются
  const upNext = document.getElementById("up-next");
  for (const [sheet, only] of [[upNext, (t) => t === upNext || !!t.closest(".up-next-head")], [moreSheet, () => true]]) {
    drag(sheet, null, {
      move: (dy) => { sheet.style.transition = "none"; sheet.style.translate = `0 ${Math.max(0, dy)}px`; },
      end: (dy) => { sheet.style.transition = sheet.style.translate = ""; if (dy > 90) closeSheets(); },
    }, only);
  }
}

function initNowScreen() {
  // Шапка: свернуть · «Играет из …» · «Ещё»
  const head = el("div", "np-head");
  head.append(el("span", "np-grab"));
  const down = btn("np-head-btn np-down", icons.chevron);
  down.setAttribute("aria-label", "Свернуть");
  down.addEventListener("click", closeNow);
  const from = el("div", "np-from");
  fromName = el("b");
  from.append(el("small", "", "Играет из"), fromName);
  const dots = btn("np-head-btn", icons.more);
  dots.setAttribute("aria-label", "Ещё");
  dots.addEventListener("click", () => openSheet("more"));
  head.append(down, from, dots);
  nowView.prepend(head);

  // Три подписанные кнопки под плеером
  const row = el("div", "np-pills");
  pills = {
    lyr: btn("np-pill", icons.mic, "Текст"),
    queue: btn("np-pill", icons.queue, "Далее"),
    more: btn("np-pill", icons.more, "Ещё"),
  };
  pills.lyr.addEventListener("click", () => { closeSheets(); npButton("lyrics").click(); });
  pills.queue.addEventListener("click", () => (document.body.classList.contains("sheet-queue") ? closeSheets() : openSheet("queue")));
  pills.more.addEventListener("click", () => (document.body.classList.contains("sheet-more") ? closeSheets() : openSheet("more")));
  row.append(pills.lyr, pills.queue, pills.more);
  nowView.querySelector(".controls").after(row);

  // Затемнение под листами (касание — закрыть) и лист «Ещё»
  const dim = el("div", "np-dim");
  dim.addEventListener("click", closeSheets);
  moreSheet = el("div", "np-more-sheet");
  const track = el("div", "np-more-track");
  const img = el("img");
  img.alt = "";
  const text = el("div");
  text.append(el("b"), el("span"));
  track.append(img, text);
  const grid = el("div", "np-more-grid");
  for (const [act, icon, label] of [["fx", icons.fx, "Эффекты"], ["sleep", icons.moon, "Таймер сна"], ["add", icons.plus, "В плейлист"],
    ["about", icons.info, "О треке"], ["share", icons.share, "Поделиться"], ["dislike", icons.dislike, "Не нравится"]]) {
    const tile = btn("np-more-tile", icon, label);
    tile.dataset.act = act;
    tile.addEventListener("click", () => moreAction(act));
    grid.append(tile);
  }
  moreSheet.append(el("span", "np-grab"), track, grid);
  nowView.append(dim, moreSheet);

  // Текст включили/выключили (lyrics.js ставит body.show-lyrics) — подсветить «Текст»
  new MutationObserver(syncPills).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  onTrackChange(() => { syncFrom(); if (document.body.classList.contains("sheet-more")) fillMore(); });
  document.addEventListener("sono:view", (e) => { if (e.detail !== "now") closeSheets(); });
  syncFrom();
  initGestures(head);
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
    setSearchMode(false);
    setLibraryOpen(false);
  });
  // Мини-плеер: на компьютере имя исполнителя и название — ссылки (на исполнителя, на альбом).
  // На телефоне они мелкие, и палец попадал в них вместо «открыть плеер» — вся плашка открывает «Сейчас играет»
  document.getElementById("minibar-open").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    showView("now");
  }, true);
  // «Сейчас играет»: шапка, «Текст / Далее / Ещё», листы снизу, жесты (шаг 11б). Очередь на телефоне —
  // лист «Далее» (body.sheet-queue; класс np-queue занят панелью очереди ПК), а не прежний слой show-queue: при запуске его не показываем
  initNowScreen();
  initTopBar();
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
