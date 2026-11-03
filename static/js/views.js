// Экраны: «Главная», «Сейчас играет» и экран плейлиста (свой плейлист, «Избранное», «Не нравится»),
// боковая панель «Медиатека» и мини-плеер, который виден везде, кроме «Сейчас играет».

import { addToPlaylistItems, createPlaylist, openPlaylistMenu, openTrackMenu, pickPlaylistCover, removeTracksWithUndo, renamePlaylist, toggleDislike, toggleLike } from "./actions.js";
import { renderAlbum, renderArtist } from "./artist.js";
import { FLOW_MODES, flowMode, setFlowMode, startFlow } from "./flow.js";
import { renderFlowView } from "./flowview.js";
import { renderStats, statsCard } from "./stats.js";
import { icons } from "./icons.js";
import { setNavigator } from "./nav.js";
import { openImportDialog } from "./import.js";
import { addToPlaylist, getPlaylist, getSetting, isDisliked, keyOf, lib, moveInPlaylist, setSetting } from "./library.js";
import { isLyricsVisible, setLyricsVisible } from "./lyrics.js";
import { clearQueue, isPlaying, moveInQueue, play, playFromQueue, prefetch, queueNext, removeFromQueue, state, togglePlay } from "./player.js";
import { fillPlays, loadPlays, playsOf } from "./plays.js";
import { newReleases } from "./releases.js";
import { localTracks } from "./local.js";
import { countDownloaded, download, removeDownload } from "./downloads.js";
import { renderSettings } from "./settings.js";
import { collectionCover, confirmDialog, coverUrl, displayTrack, el, formatTotal, iconButton, imageHsl, imgUrl, markCurrentRows, nameHue, openMenu, plural, toast, trackRow } from "./ui.js";

const viewHome = document.getElementById("view-home");
const viewNow = document.getElementById("view-now");
const viewList = document.getElementById("view-list");
const viewSettings = document.getElementById("view-settings");
const navSettings = document.getElementById("nav-settings");
const upNext = document.getElementById("up-next");
const scroller = document.getElementById("views");
const libList = document.getElementById("lib-list");
const navHome = document.getElementById("nav-home");
const navNow = document.getElementById("nav-now");
const navFlow = document.getElementById("nav-flow");
const viewFlow = document.getElementById("view-flow");
const viewStats = document.getElementById("view-stats");

// Какой экран открыт: "home" | "now" | "liked" | "disliked" | "playlist:<id>" | "artist:<id>" | "album:<id>"
let view = "";
const backStack = [];   // откуда пришли — для кнопки «Назад»

// Страницы исполнителя и альбома: данные приходят с сервера, медиатека их не меняет
const isMetaView = (key) => /^(artist|album):./.test(key);
let metaToken = 0;   // чтобы медленный ответ не нарисовал страницу, с которой уже ушли

// ---------- Что показывать для каждого экрана ----------

function describe(key) {
  if (key === "liked") {
    return { kind: "liked", label: "Плейлист", name: "Избранное", tracks: lib.liked, context: { type: "liked" },
      empty: "Нажимай ♡ у треков, которые нравятся, — они соберутся здесь." };
  }
  if (key === "disliked") {
    return { kind: "disliked", label: "Скрытые треки", name: "Не нравится", tracks: lib.disliked, context: { type: "disliked" },
      empty: "Здесь будут треки с дизлайком. Они пропускаются при воспроизведении." };
  }
  if (key === "downloads") {
    return { kind: "downloads", label: "Без интернета", name: "Скачанное", tracks: lib.downloads, context: { type: "downloads" },
      empty: "Скачай плейлист кнопкой со стрелкой в его шапке или трек через «⋯» → «Скачать» — "
        + "он будет стартовать мгновенно и играть без интернета." };
  }
  if (key === "local") {
    return { kind: "local", label: "С компьютера", name: "Мои файлы", tracks: localTracks(), context: { type: "local" },
      empty: "Добавьте папку с музыкой: Настройки → «Мои файлы»." };
  }
  const playlist = getPlaylist(key.slice("playlist:".length));
  if (!playlist) return null;
  return { kind: "playlist", label: "Плейлист", name: playlist.name, tracks: playlist.tracks, playlist, cover: playlist.cover,
    context: { type: "playlist", id: playlist.id },
    empty: "В плейлисте пока пусто. Найди трек через поиск и добавь его: «⋯» → «Добавить в плейлист»." };
}

const contextKey = (ctx) => (!ctx ? "" : ctx.id ? `${ctx.type}:${ctx.id}` : ctx.type);
const playingFrom = (key) => !!state.current && contextKey(state.context) === key;

/** Включить коллекцию: с первого трека без дизлайка или в случайном порядке */
function playCollection(info, shuffle = false) {
  let tracks = info.kind === "disliked" ? info.tracks.slice() : info.tracks.filter((t) => !lib.disliked.some((d) => keyOf(d) === keyOf(t)));
  if (!tracks.length) return;
  if (shuffle) {
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
  }
  play(tracks[0], tracks, 0, info.context);
}

// Наведение на большую кнопку ▶ или плитку — готовим первый трек коллекции
function prefetchCollection(info) {
  prefetch(info.tracks.find((t) => !lib.disliked.some((d) => keyOf(d) === keyOf(t))));
}

/** Открыли список — через полсекунды (если ещё на нём) готовим два первых трека: ▶ и щелчок по верху списка —
    без ожидания. По одному, чтобы не занимать YouTube, пока человек листает */
export function prefetchFirst(tracks, key) {
  const first = tracks.filter((t) => !lib.disliked.some((d) => keyOf(d) === keyOf(t))).slice(0, 2);
  setTimeout(async () => {
    for (const t of first) {
      if (view !== key) return;
      await prefetch(t);
    }
  }, 500);
}

// ---------- Переключение экранов ----------

const FIXED_VIEWS = ["home", "flow", "now", "settings", "stats"];   // экраны со своей секцией (остальные — списки)

export function showView(key, { back = false } = {}) {
  if (!FIXED_VIEWS.includes(key) && !isMetaView(key) && !describe(key)) key = "home";
  const changed = key !== view;
  if (changed && view && !back) {
    backStack.push(view);
    if (backStack.length > 50) backStack.shift();
  }
  view = key;
  const isList = !FIXED_VIEWS.includes(view);
  viewHome.hidden = view !== "home";
  viewNow.hidden = view !== "now";
  viewSettings.hidden = view !== "settings";
  viewFlow.hidden = view !== "flow";
  viewStats.hidden = view !== "stats";
  viewList.hidden = !isList;
  if (view === "home") renderHome();
  if (view === "now") renderUpNext();
  if (view === "settings" && changed) renderSettings();
  if (view === "flow") renderFlowView();
  if (view === "stats") renderStats(viewStats);
  if (isMetaView(view)) { if (changed) renderMeta(); }
  else if (isList) renderList(changed);
  document.body.classList.toggle("on-flow", view === "flow");
  if (changed) {
    const shown = { home: viewHome, now: viewNow, settings: viewSettings, flow: viewFlow, stats: viewStats }[view] ?? viewList;
    shown.classList.remove("entering");
    void shown.offsetWidth;
    shown.classList.add("entering");
    scroller.scrollTop = 0;
  }
  document.body.classList.toggle("on-now", view === "now");
  renderSidebar();
  document.dispatchEvent(new CustomEvent("sono:view", { detail: view }));   // полоска заголовка обновит «Назад»
}

export function goBack() {
  // Пропускаем экраны, которых уже нет (например, удалённый плейлист)
  while (backStack.length) {
    const key = backStack.pop();
    if (FIXED_VIEWS.includes(key) || isMetaView(key) || describe(key)) return showView(key, { back: true });
  }
}

/** Есть куда вернуться (для кнопки «Назад» в полоске заголовка) */
export const canGoBack = () => backStack.length > 0;

function renderMeta() {
  const token = ++metaToken;
  const key = view;
  const stillHere = () => token === metaToken && view === key;
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  (kind === "artist" ? renderArtist : renderAlbum)(viewList, id, stillHere).then(() => {
    if (stillHere()) syncPlayButtons();
  });
}

// ---------- Главная ----------

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

/** Плитка коллекции: обложка + название; кнопка ▶ появляется при наведении */
function collectionTile(key, info) {
  const tile = el("button", "home-tile");
  tile.type = "button";
  tile.dataset.view = key;
  tile.append(collectionCover(info.kind, info), el("span", "home-tile-name", info.name));
  const playBtn = el("span", "tile-play");
  playBtn.innerHTML = icons.play;
  playBtn.title = "Слушать";
  playBtn.addEventListener("click", (e) => { e.stopPropagation(); playCollection(info); });
  if (info.tracks.length) tile.append(playBtn);
  tile.addEventListener("click", () => showView(key));
  tile.addEventListener("mouseenter", () => prefetchCollection(info));
  return tile;
}

/** Карточка трека: большая обложка, название, исполнитель */
function trackCard(track, list, index, context) {
  const card = el("button", "home-card");
  card.type = "button";
  card.dataset.key = keyOf(track);
  const art = el("div", "home-card-art");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = coverUrl(track, "large");
  img.onerror = () => img.classList.add("broken");
  const playBtn = el("span", "tile-play");
  playBtn.innerHTML = icons.play;
  art.append(img, playBtn);
  const shown = displayTrack(track);
  card.append(art, el("span", "home-card-title", shown.title), el("span", "home-card-artist", shown.artist));
  card.title = track.title;
  card.addEventListener("click", () => play(track, list.slice(), index, context));
  card.addEventListener("mouseenter", () => prefetch(track));   // пока ведут курсор — готовим трек
  return card;
}

/** Flow: большая карточка с «сиянием», кнопкой ▶ и режимами.
    Создаётся один раз: «Главная» перерисовывается при каждом треке, а сияние не должно дёргаться */
let flowCardEl = null;
function flowCard() {
  if (flowCardEl) return flowCardEl;
  const card = flowCardEl = el("section", "flow-card");
  const aurora = el("div", "flow-aurora");
  aurora.innerHTML = "<i></i><i></i><i></i>";
  const body = el("div", "flow-body");
  const mode = flowMode();
  const sub = el("p", "flow-sub", FLOW_MODES.find((m) => m.value === mode)?.hint ?? "");
  body.append(el("div", "flow-kind", "Бесконечно · под ваш вкус"), el("h2", "flow-title", "Flow"), sub);

  const controls = el("div", "flow-controls");
  const playBtn = el("button", "play big-play flow-play");
  playBtn.type = "button";
  playBtn.dataset.collection = "flow:main";
  playBtn.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`;
  playBtn.title = "Слушать Flow";
  playBtn.addEventListener("click", () => (playingFrom("flow:main") ? togglePlay() : startFlow()));
  const seg = el("div", "seg flow-modes");
  for (const m of FLOW_MODES) {
    const btn = el("button", `seg-btn${m.value === mode ? " on" : ""}`, m.title);
    btn.type = "button";
    btn.title = m.hint;
    btn.addEventListener("click", () => {
      if (m.value === flowMode()) return;
      setFlowMode(m.value);
      if (playingFrom("flow:main")) toast(`Flow: «${m.title}» — со следующего трека`);
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b === btn));
      sub.textContent = m.hint;
    });
    seg.append(btn);
  }
  controls.append(playBtn, seg);
  body.append(controls);
  card.append(aurora, body);
  // Щелчок по карточке (не по кнопкам) — открыть вкладку Flow
  card.addEventListener("click", (e) => { if (!e.target.closest("button")) showView("flow"); });
  return card;
}

// Верх «Главной» (приветствие и Flow) создаётся один раз, перерисовывается только остальное
const homeRest = el("div", "home-rest");
const homeGreet = el("h1", "home-greet");

function renderHome() {
  if (!viewHome.contains(homeRest)) {
    const hero = el("div", "home-hero");
    hero.append(homeGreet, el("p", "home-sub", "Что послушаем?"));
    viewHome.replaceChildren(hero, flowCard(), homeRest);
  }
  if (homeGreet.textContent !== greeting()) homeGreet.textContent = greeting();

  const tiles = el("div", "home-tiles");
  tiles.append(collectionTile("liked", describe("liked")));
  for (const p of lib.playlists.slice(-7).reverse()) tiles.append(collectionTile(`playlist:${p.id}`, describe(`playlist:${p.id}`)));

  const children = [tiles];
  const stats = statsCard();   // «Ваша статистика» — есть, когда уже что-то послушали
  if (stats) children.push(stats);
  const recent = lib.history.filter((t) => !isDisliked(t)).slice(0, 10);
  if (recent.length) {
    const cards = el("div", "home-cards");
    recent.forEach((t, i) => cards.append(trackCard(t, recent, i, { type: "history" })));
    children.push(el("h2", "home-h", "Недавно слушали"), cards);
  } else {
    // Пусто — подсказываем, с чего начать
    const start = el("div", "home-start");
    start.append(el("h2", "", "С чего начать"),
      el("p", "", "Найди трек через поиск сверху — или перенеси свои плейлисты из Spotify, YouTube или SoundCloud."));
    const importBtn = el("button", "btn primary", "Импортировать плейлист");
    importBtn.type = "button";
    importBtn.addEventListener("click", () => openImportDialog({ onOpen: (id) => showView(`playlist:${id}`) }));
    start.append(importBtn);
    children.push(start);
  }
  // Новинки исполнителей, на которых подписан, — подгружаются в фоне и встают после плиток
  const fresh = el("div", "home-new");
  children.splice(1, 0, fresh);
  newReleasesRow(fresh);
  homeRest.replaceChildren(...children);
  markCurrentRows(state.current ? keyOf(state.current) : null);
  syncPlayButtons();
}

/** «Новинки ваших исполнителей» на «Главной» (подписки — кнопка «Подписаться» на странице исполнителя) */
async function newReleasesRow(box) {
  const list = await newReleases();
  if (!list.length || !box.isConnected) return;
  const cards = el("div", "home-cards");
  for (const r of list.slice(0, 10)) {
    const card = el("button", "home-card release-card");
    card.type = "button";
    const art = el("div", "home-card-art");
    if (r.cover) {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = imgUrl(r.cover);
      art.append(img);
    } else {
      art.innerHTML = icons.note;
    }
    const when = r.date ? new Date(r.date).toLocaleDateString("ru", { day: "numeric", month: "long" }) : "";
    card.append(art, el("span", "home-card-title", r.title), el("span", "home-card-artist", `${r.artist} · ${when}`));
    card.title = `${r.artist} — ${r.title}`;
    card.addEventListener("click", () => showView(`album:${r.id}`));
    cards.append(card);
  }
  box.replaceChildren(el("h2", "home-h", "Новинки ваших исполнителей"), cards);
}

// ---------- «Далее» на экране «Сейчас играет» ----------

function contextName(ctx) {
  if (!ctx) return "";
  if (ctx.type === "liked") return "Избранное";
  if (ctx.type === "playlist") return getPlaylist(ctx.id)?.name ?? "";
  if (ctx.type === "history") return "Недавнее";
  if (ctx.type === "search") return "Результаты поиска";
  if (ctx.type === "downloads") return "Скачанное";
  if (ctx.type === "local") return "Мои файлы";
  return ctx.name ?? "";   // исполнитель, альбом
}

/** Строка очереди: обложка, название, исполнитель (+ крестик «убрать») */
function queueItem(track, i, { current = false } = {}) {
  const shown = displayTrack(track);
  const li = el("li", `up-next-item${current ? " now" : ""}`);
  li.dataset.index = i;
  const img = el("img");
  img.alt = "";
  img.src = coverUrl(track);
  img.onerror = () => img.classList.add("broken");
  const text = el("div", "up-next-text");
  text.append(el("div", "up-next-name", shown.title), el("div", "up-next-artist", shown.artist));
  li.append(img, text);
  li.title = track.title;
  if (current) {
    const eq = el("span", "eq");
    eq.innerHTML = "<i></i><i></i><i></i>";
    li.append(eq);
    return li;
  }
  const remove = iconButton(icons.close, "Убрать из очереди", "up-next-remove");
  remove.addEventListener("click", (e) => { e.stopPropagation(); removeFromQueue(i); });
  li.append(remove);
  li.draggable = true;
  li.addEventListener("click", () => playFromQueue(i));
  li.addEventListener("mouseenter", () => prefetch(track));
  return li;
}

const QUEUE_LIMIT = 100;   // больше строк не рисуем — очередь из импортированного плейлиста бывает огромной

function renderUpNext() {
  if (!state.current) { upNext.replaceChildren(); upNext.hidden = true; return; }
  upNext.hidden = false;
  const keepScroll = upNext.querySelector(".up-next-scroll")?.scrollTop ?? 0;

  const head = el("div", "up-next-head");
  head.append(el("span", "up-next-title", "Очередь"));
  const upcoming = [];
  for (let i = state.index + 1; i < state.queue.length; i++) {
    if (!isDisliked(state.queue[i])) upcoming.push(i);
  }
  if (upcoming.length) {
    const clear = el("button", "panel-action", "Очистить");
    clear.type = "button";
    clear.addEventListener("click", clearQueue);
    head.append(clear);
  }

  const scroll = el("div", "up-next-scroll");
  scroll.append(el("div", "up-next-label", "Сейчас играет"));
  const nowList = el("ol", "up-next-list");
  nowList.append(queueItem(state.current, state.index, { current: true }));
  scroll.append(nowList);

  const from = contextName(state.context);
  const label = el("div", "up-next-label", from ? `Далее — из «${from}»` : "Далее");
  const badges = [state.shuffle && "вперемешку", state.repeat === "all" && "по кругу", state.repeat === "one" && "повтор трека"].filter(Boolean);
  if (badges.length) label.append(el("span", "up-next-mode", badges.join(" · ")));
  scroll.append(label);

  if (upcoming.length) {
    const list = el("ol", "up-next-list upcoming");
    upcoming.slice(0, QUEUE_LIMIT).forEach((i, n) => {
      const item = queueItem(state.queue[i], i);
      item.style.setProperty("--i", Math.min(n, 12));
      list.append(item);
    });
    enableQueueDrag(list);
    scroll.append(list);
    if (upcoming.length > QUEUE_LIMIT) scroll.append(el("p", "up-next-empty", `…и ещё ${plural(upcoming.length - QUEUE_LIMIT, "трек", "трека", "треков")}`));
  } else {
    scroll.append(el("p", "up-next-empty", state.repeat === "all"
      ? "Это последний трек — потом очередь начнётся сначала."
      : "Дальше ничего нет. Включи плейлист или добавь трек: «⋯» → «Играть следующим»."));
  }
  upNext.replaceChildren(head, scroll);
  scroll.scrollTop = keepScroll;
}

// Перетаскивание в очереди (номера строк — их места в state.queue)
function enableQueueDrag(list) {
  let from = -1;
  const clear = () => list.querySelectorAll(".up-next-item").forEach((r) => r.classList.remove("drop-before", "drop-after", "dragging"));
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".up-next-item");
    from = Number(row.dataset.index);
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(from));
  });
  list.addEventListener("dragover", (e) => {
    const row = e.target.closest(".up-next-item");
    if (from < 0 || !row) return;
    e.preventDefault();
    const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
    list.querySelectorAll(".up-next-item").forEach((r) => r.classList.remove("drop-before", "drop-after"));
    row.classList.add(after ? "drop-after" : "drop-before");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const row = e.target.closest(".up-next-item");
    if (from < 0 || !row) return;
    let to = Number(row.dataset.index) + (row.classList.contains("drop-after") ? 1 : 0);
    if (to > from) to -= 1;
    const moved = from;
    from = -1;
    clear();
    moveInQueue(moved, to);
  });
  list.addEventListener("dragend", () => { from = -1; clear(); });
}

// Кнопка «Очередь»: показывает очередь справа от плеера (на месте текста песни)
function setQueueVisible(show) {
  document.body.classList.toggle("show-queue", show);
  document.querySelectorAll('[data-np="queue"]').forEach((b) => b.classList.toggle("on", show));
  setSetting("showQueue", show);
}

function onQueueButton() {
  const wasNow = view === "now";
  if (!wasNow) showView("now");
  if (isLyricsVisible()) { setLyricsVisible(false); setQueueVisible(true); return; }
  setQueueVisible(wasNow ? !document.body.classList.contains("show-queue") : true);
}

// ---------- Боковая панель «Медиатека» ----------

function libItem(key, info, sub) {
  const li = el("li", "lib-item");
  li.dataset.view = key;
  li.classList.toggle("active", view === key);
  li.classList.toggle("playing-from", playingFrom(key));
  li.tabIndex = 0;
  const text = el("div", "lib-text");
  text.append(el("div", "lib-name", info.name), el("div", "lib-sub", sub));
  const eq = el("span", "eq");
  eq.innerHTML = "<i></i><i></i><i></i>";
  li.append(collectionCover(info.kind, info), text, eq);
  li.addEventListener("click", () => showView(key));
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") showView(key); });
  if (info.playlist) acceptTrackDrop(li, info.playlist);   // сюда можно перетащить треки из любого списка
  if (info.playlist) {
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openPlaylistMenu({ x: e.clientX, y: e.clientY }, info.playlist, {
        onPlay: () => playCollection(info),
        onDeleted: () => { if (view === key) showView("home"); },
      });
    });
  }
  return li;
}

export function renderSidebar() {
  navHome.classList.toggle("active", view === "home");
  navNow.classList.toggle("active", view === "now");
  navFlow.classList.toggle("active", view === "flow");
  navSettings.classList.toggle("active", view === "settings");
  const items = [libItem("liked", describe("liked"), `Плейлист · ${plural(lib.liked.length, "трек", "трека", "треков")}`)];
  for (const p of lib.playlists) {
    items.push(libItem(`playlist:${p.id}`, describe(`playlist:${p.id}`), `Плейлист · ${plural(p.tracks.length, "трек", "трека", "треков")}`));
  }
  if (localTracks().length) {
    items.push(libItem("local", describe("local"), `С компьютера · ${plural(localTracks().length, "трек", "трека", "треков")}`));
  }
  if (lib.downloads.length) {
    items.push(libItem("downloads", describe("downloads"), `Без интернета · ${plural(lib.downloads.length, "трек", "трека", "треков")}`));
  }
  const disliked = libItem("disliked", describe("disliked"), plural(lib.disliked.length, "трек", "трека", "треков"));
  disliked.classList.add("muted-item");
  items.push(el("li", "lib-sep"), disliked);
  libList.replaceChildren(...items);
}

// ---------- Кнопка «Скачать» в шапке плейлиста ----------
// Стрелка: скачать все треки. Когда всё скачано — закрашенная; по щелчку предлагает удалить загрузки.

function downloadControl(info) {
  const wrap = el("div", "pl-download");
  wrap.dataset.collection = view;
  const btn = iconButton(icons.download, "Скачать", "pl-dl-btn");
  btn.addEventListener("click", async () => {
    const { done } = countDownloaded(info.tracks);
    if (done < info.tracks.length) {
      download(info.tracks);
      toast(`Скачиваю «${info.name}» — треки будут играть без интернета`);
      return;
    }
    const ok = await confirmDialog({ title: `Удалить загрузки «${info.name}»?`,
      text: "Треки останутся на месте, просто снова будут играть из интернета.", okLabel: "Удалить" });
    if (!ok) return;
    const failed = await removeDownload(info.tracks);
    toast(failed ? `Удалено, кроме ${plural(failed, "трека", "треков", "треков")}, который сейчас играет` : "Загрузки удалены");
  });
  wrap.append(btn, el("span", "pl-dl-status"));
  syncDownloadControl(wrap, info.tracks);
  return wrap;
}

function syncDownloadControl(wrap, tracks) {
  const { done, active } = countDownloaded(tracks);
  const all = tracks.length > 0 && done === tracks.length;
  const btn = wrap.querySelector(".pl-dl-btn");
  btn.innerHTML = all ? icons.downloaded : icons.download;
  btn.classList.toggle("on", all);
  btn.title = all ? "Скачано — удалить загрузки" : "Скачать — чтобы играло без интернета";
  btn.setAttribute("aria-label", btn.title);
  wrap.classList.toggle("busy", active > 0);
  wrap.querySelector(".pl-dl-status").textContent = active
    ? `Скачиваю… ${done} из ${tracks.length}`
    : all ? "Скачано" : done ? `Скачано ${done} из ${tracks.length}` : "";
}

/** Состояние скачиваний изменилось — обновить кнопки «Скачать» на экране */
export function refreshDownloads() {
  document.querySelectorAll(".pl-download").forEach((wrap) => {
    const info = describe(wrap.dataset.collection);
    if (info) syncDownloadControl(wrap, info.tracks);
  });
}

// ---------- Экран плейлиста ----------

function renderList(fresh) {
  const info = describe(view);
  if (!info) return showView("home");
  const keepScroll = fresh ? 0 : scroller.scrollTop;
  if (fresh) prefetchFirst(info.tracks, view);

  // Шапка: обложка, название, сколько треков
  const header = el("header", "pl-header");
  const text = el("div", "pl-info");
  const name = el("h1", "pl-name", info.name);
  if (info.playlist) {
    name.classList.add("editable");
    name.title = "Переименовать";
    name.addEventListener("click", () => renamePlaylist(info.playlist));
  }
  const meta = info.tracks.length ? `${plural(info.tracks.length, "трек", "трека", "треков")} · ${formatTotal(info.tracks)}` : "Пусто";
  text.append(el("div", "pl-kind", info.label), name, el("div", "pl-meta", meta));
  const coverBox = collectionCover(info.kind, info, true);
  if (info.playlist) {   // щелчок по обложке — выбрать свою картинку (как в Spotify)
    coverBox.classList.add("editable");
    coverBox.title = "Выбрать свою обложку";
    const hint = el("span", "cover-edit");
    hint.innerHTML = `${icons.image}<span>Выбрать фото</span>`;
    coverBox.append(hint);
    coverBox.addEventListener("click", () => pickPlaylistCover(info.playlist));
  }
  header.append(coverBox, text);

  // Кнопки: играть, перемешать, меню плейлиста
  const actions = el("div", "pl-actions");
  if (info.kind !== "disliked") {
    const playBtn = el("button", "play big-play");
    playBtn.type = "button";
    playBtn.dataset.collection = view;
    playBtn.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`;
    playBtn.disabled = !info.tracks.length;
    playBtn.addEventListener("click", () => (playingFrom(view) ? togglePlay() : playCollection(info)));
    playBtn.addEventListener("mouseenter", () => prefetchCollection(info));
    const shuffle = iconButton(icons.shuffle, "Перемешать и слушать");
    shuffle.disabled = info.tracks.length < 2;
    shuffle.addEventListener("click", () => playCollection(info, true));
    actions.append(playBtn, shuffle);
    if (info.tracks.length) actions.append(downloadControl(info));
    // Flow по плейлисту: его исполнители и похожие на них — остальная медиатека не влияет
    if (info.tracks.length) {
      const flowBtn = el("button", "flow-pill");
      flowBtn.type = "button";
      flowBtn.innerHTML = `${icons.flow}<span>Flow</span>`;
      flowBtn.title = `Бесконечный поток в духе «${info.name}»`;
      flowBtn.addEventListener("click", () => startFlow({ playlist: { id: info.playlist?.id ?? info.kind, name: info.name, tracks: info.tracks } }));
      actions.append(flowBtn);
    }
  }
  if (info.playlist) {
    const more = iconButton(icons.more, "Ещё");
    more.addEventListener("click", () => openPlaylistMenu(more, info.playlist, {
      onPlay: () => playCollection(info),
      onDeleted: () => showView("home"),
    }));
    actions.append(more);
  }

  // Список треков. Поиск по списку, сортировка и выбор нескольких (Ctrl/Shift) — см. listTools
  const st = listState(view);
  const list = el("ol", "tracklist");
  const empty = el("p", "pl-empty", "Ничего не нашлось");
  empty.hidden = true;
  let tools, drawSelectBar, clearSelection;
  const drawList = () => {
    const shown = orderedTracks(info.tracks, st);
    const queue = shown.map((x) => x.track);
    list.replaceChildren(...shown.map(({ track }, n) => {
      const row = trackRow(track, {
        index: n,
        numbered: true,
        draggable: true,   // перетаскивание — в другой плейлист в медиатеке (а в своём плейлисте ещё и порядок)
        onPlay: () => { clearSelection(); play(track, queue.slice(), n, info.context); },
        onLike: toggleLike,
        onMenu: (anchor) => openTrackMenu(anchor, track, info.playlist ? { playlistId: info.playlist.id } : {}),
        onRemove: info.kind === "disliked" ? toggleDislike : null,
      });
      row.classList.toggle("selected", st.selected.has(keyOf(track)));
      row.addEventListener("mouseenter", () => prefetch(track));   // пока ведут курсор — готовим трек
      return row;
    }));
    // Свой порядок меняется перетаскиванием, только когда список показан как есть (без сортировки и поиска)
    list.classList.toggle("sortable", !!info.playlist && st.sort === "own" && !st.query);
    empty.hidden = shown.length > 0;
    fillPlays(list, info.tracks);
    markCurrentRows(state.current ? keyOf(state.current) : null);
    drawSelectBar();
  };
  ({ tools, drawSelectBar, clearSelection } = listTools(info, st, list, drawList));
  if (info.playlist) enableDragSort(list, info.playlist.id);
  enableDragOut(list, info, st);
  drawList();
  // Прослушивания на YouTube/SoundCloud — подгружаем в фоне и вписываем в колонку
  if (info.tracks.length) loadPlays(info.tracks.slice(0, 300)).then(() => { if (list.isConnected) fillPlays(list, info.tracks); });

  // Верх — цветная «шапка» с обложкой и кнопками, ниже — карточка со списком треков
  const hero = el("div", "pl-hero");
  hero.append(header, actions);
  setHeroColor(hero, info);

  const body = el("div", "pl-body");
  if (info.tracks.length) {
    const card = el("div", "tracklist-card");
    card.append(listHead(info), list, empty);
    body.append(tools, card);
  } else {
    body.append(el("p", "pl-empty", info.empty));
  }
  viewList.replaceChildren(hero, body);

  markCurrentRows(state.current ? keyOf(state.current) : null);
  syncPlayButtons();
  scroller.scrollTop = keepScroll;
}

// ---------- Поиск, сортировка и выбор нескольких треков в списке ----------

const SORTS = [
  { id: "own", title: "Свой порядок" },
  { id: "new", title: "Сначала новые" },
  { id: "title", title: "По названию" },
  { id: "artist", title: "По исполнителю" },
  { id: "duration", title: "По длительности" },
  { id: "plays", title: "По прослушиваниям" },
];
const listStates = new Map();   // экран → { sort, query, selected, anchor } — пока программа открыта
function listState(key) {
  if (!listStates.has(key)) listStates.set(key, { sort: "own", query: "", selected: new Set(), anchor: -1 });
  return listStates.get(key);
}

const fold = (s) => (s || "").toLowerCase().replace(/ё/g, "е");

/** Треки в нужном порядке и с поиском: [{ track, i }], i — место в самом списке */
function orderedTracks(tracks, st) {
  let items = tracks.map((track, i) => ({ track, i, shown: displayTrack(track) }));
  if (st.query) {
    const q = fold(st.query);
    items = items.filter(({ shown }) => fold(`${shown.title} ${shown.artist}`).includes(q));
  }
  const by = (f) => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : a.i - b.i);
  const sorters = {
    new: (a, b) => b.i - a.i,
    title: by((x) => fold(x.shown.title)),
    artist: by((x) => fold(x.shown.artist)),
    duration: (a, b) => (b.track.duration || 0) - (a.track.duration || 0),
    plays: (a, b) => (playsOf(b.track) ?? -1) - (playsOf(a.track) ?? -1),
  };
  if (sorters[st.sort]) items.sort(sorters[st.sort]);
  return items;
}

/** Строка над списком: поиск, сортировка; когда выбраны треки — что с ними сделать */
function listTools(info, st, list, drawList) {
  const tools = el("div", "list-tools");
  const search = el("label", "list-search");
  search.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>`;
  const input = el("input");
  input.type = "search";
  input.placeholder = "Поиск в списке";
  input.value = st.query;
  input.addEventListener("input", () => { st.query = input.value.trim(); drawList(); });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    input.value = "";
    st.query = "";
    drawList();
    input.blur();
  });
  search.append(input);
  const sortBtn = el("button", "btn ghost list-sort");
  sortBtn.type = "button";
  const drawSort = () => { sortBtn.innerHTML = `${icons.sort}<span>${SORTS.find((x) => x.id === st.sort).title}</span>`; };
  sortBtn.addEventListener("click", () => openMenu(sortBtn, SORTS.map((x) => ({
    label: x.title, icon: x.id === st.sort ? icons.check : "",
    action: async () => {
      st.sort = x.id;
      drawSort();
      if (x.id === "plays") {
        toast("Узнаю, сколько раз слушали…");
        await loadPlays(info.tracks.slice(0, 300));
      }
      drawList();
    },
  }))));
  drawSort();
  const bar = el("div", "select-bar");
  tools.append(search, sortBtn, bar);

  const selectedTracks = () => info.tracks.filter((t) => st.selected.has(keyOf(t)));
  const clearSelection = () => {
    if (!st.selected.size) return;
    st.selected.clear();
    st.anchor = -1;
    drawList();
  };
  const drawSelectBar = () => {
    const n = st.selected.size;
    tools.classList.toggle("selecting", n > 0);
    if (!n) return bar.replaceChildren();
    const btn = (label, icon, fn, cls = "") => {
      const b = el("button", `btn ghost ${cls}`.trim());
      b.type = "button";
      b.innerHTML = `${icon}<span>${label}</span>`;
      b.addEventListener("click", fn);
      return b;
    };
    bar.replaceChildren(el("span", "select-count", `Выбрано: ${n}`),
      btn("Играть следующими", icons.playNext, () => {
        selectedTracks().reverse().forEach((t) => queueNext(t));
        toast(`${plural(n, "трек", "трека", "треков")} — играют следующими`);
        clearSelection();
      }),
      btn("В плейлист", icons.plus, (e) => openMenu(e.currentTarget, addToPlaylistItems(selectedTracks()))),
      ...(info.playlist ? [btn("Удалить", icons.trash, () => {
        const picked = selectedTracks();
        st.selected.clear();
        removeTracksWithUndo(info.playlist.id, picked);
      }, "danger-text")] : []),
      btn("Снять выбор", icons.close, clearSelection));
  };

  // Ctrl+щелчок — добавить/убрать трек, Shift+щелчок — всё от прошлого выбранного до этого.
  // Обычный щелчок, как и раньше, включает трек
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".track");
    if (!row || e.target.closest("button, .t-artist") || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const rows = [...list.querySelectorAll(".track")];
    const n = rows.indexOf(row);
    const keys = rows.map((r) => r.dataset.key);
    if (e.shiftKey && st.anchor >= 0) {
      const [a, b] = [Math.min(st.anchor, n), Math.max(st.anchor, n)];
      keys.slice(a, b + 1).forEach((k) => st.selected.add(k));
    } else if (st.selected.has(keys[n])) {
      st.selected.delete(keys[n]);
    } else {
      st.selected.add(keys[n]);
    }
    st.anchor = n;
    rows.forEach((r) => r.classList.toggle("selected", st.selected.has(r.dataset.key)));
    drawSelectBar();
  }, true);
  return { tools, drawSelectBar, clearSelection };
}

// Esc снимает выбор в открытом списке
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.target.closest?.("input, .dialog-backdrop, .menu")) return;
  const st = listStates.get(view);
  if (st?.selected.size) {
    st.selected.clear();
    st.anchor = -1;
    renderList(false);
  }
});

// Перетаскивание треков на плейлист в медиатеке: берём выбранные (если тащат один из них) или один трек
const DRAG_TYPE = "text/x-sono-tracks";
function enableDragOut(list, info, st) {
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".track");
    if (!row) return;
    const picked = st.selected.has(row.dataset.key) ? info.tracks.filter((t) => st.selected.has(keyOf(t)))
      : info.tracks.filter((t) => keyOf(t) === row.dataset.key);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(picked));
    e.dataTransfer.effectAllowed = "copyMove";
    document.body.classList.add("dragging-tracks");
  });
  list.addEventListener("dragend", () => document.body.classList.remove("dragging-tracks"));
}

/** Плейлист в медиатеке принимает перетащенные треки */
function acceptTrackDrop(li, playlist) {
  li.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    li.classList.add("drop-target");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
  li.addEventListener("drop", (e) => {
    li.classList.remove("drop-target");
    document.body.classList.remove("dragging-tracks");
    let tracks = [];
    try { tracks = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || "[]"); } catch {}
    if (!tracks.length) return;
    e.preventDefault();
    const added = tracks.filter((t) => addToPlaylist(playlist.id, t)).length;
    toast(added ? `Добавлено в «${playlist.name}»: ${plural(added, "трек", "трека", "треков")}` : `Уже есть в «${playlist.name}»`);
  });
}

// Подписи колонок над списком (ширины совпадают с колонками строки трека)
function listHead(info) {
  const head = el("div", "tl-head");
  const removable = info.kind === "disliked";
  head.innerHTML = `<span class="t-num">#</span><span class="h-title">Название</span>
    <span class="t-plays" title="Сколько раз слушали на YouTube/SoundCloud">Прослушивания</span>
    <span class="t-source">Сайт</span><span class="h-btn"></span>
    <span class="t-dur" title="Длительность">${icons.clock}</span>
    ${removable ? '<span class="h-btn"></span>' : ""}<span class="h-btn"></span>`;
  return head;
}

// Цвет шапки: у плейлиста — по обложке первого трека, у остальных — свой постоянный
const heroColors = new Map();   // адрес обложки → цвет, чтобы не считать заново при каждой перерисовке
function setHeroColor(hero, info) {
  const fallback = info.kind === "liked" ? "hsl(252 65% 45%)"
    : info.kind === "disliked" ? "hsl(0 0% 30%)"
    : `hsl(${nameHue(info.name)} 45% 32%)`;
  if (info.kind !== "playlist" || (!info.tracks.length && !info.cover)) {
    hero.style.setProperty("--hero", fallback);
    return;
  }
  const url = info.cover || coverUrl(info.tracks[0]);   // своя обложка — цвет шапки по ней
  if (heroColors.has(url)) {
    hero.style.setProperty("--hero", heroColors.get(url));
    return;
  }
  hero.style.setProperty("--hero", fallback);
  const img = new Image();
  img.src = url;
  img.decode().then(() => {
    const [h, s] = imageHsl(img);
    const color = `hsl(${h.toFixed(0)} ${Math.min(Math.max(s, 25), 70).toFixed(0)}% 32%)`;
    heroColors.set(url, color);
    hero.style.setProperty("--hero", color);
  }).catch(() => {});
}

// Перетаскивание треков внутри плейлиста
function enableDragSort(list, playlistId) {
  let from = -1;
  const rows = () => [...list.children];
  const clearMarks = () => rows().forEach((r) => r.classList.remove("drop-before", "drop-after", "dragging"));

  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".track");
    // Порядок меняем, только когда плейлист показан как есть (без сортировки и поиска); иначе — тащат в медиатеку
    if (!row || !list.classList.contains("sortable")) { from = -1; return; }
    from = rows().indexOf(row);
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(from));
  });
  list.addEventListener("dragover", (e) => {
    const row = e.target.closest(".track");
    if (from < 0 || !row) return;
    e.preventDefault();
    const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
    rows().forEach((r) => r.classList.remove("drop-before", "drop-after"));
    row.classList.add(after ? "drop-after" : "drop-before");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const row = e.target.closest(".track");
    if (from < 0 || !row) return;
    let to = rows().indexOf(row) + (row.classList.contains("drop-after") ? 1 : 0);
    if (to > from) to -= 1;   // трек сначала вынимают из списка, позиции ниже сдвигаются
    clearMarks();
    const moved = from;
    from = -1;
    moveInPlaylist(playlistId, moved, to);
  });
  list.addEventListener("dragend", () => { from = -1; clearMarks(); });
}

/** Большая кнопка в шапке плейлиста показывает паузу, если играет именно этот плейлист */
export function syncPlayButtons() {
  document.querySelectorAll("[data-collection]").forEach((btn) => {
    btn.classList.toggle("is-playing", playingFrom(btn.dataset.collection) && isPlaying());
  });
}

// ---------- Подключение ----------

/** Медиатека изменилась — перерисовать то, что от неё зависит */
export function refreshViews(section) {
  if (section === "settings") return;
  if (view === "home") renderHome();   // главная показывает и историю, и плейлисты
  if (section === "history") return;
  renderSidebar();
  if (view === "now") renderUpNext();
  else if (view === "flow") renderFlowView();   // плейлисты в «Flow по плейлисту»
  else if (FIXED_VIEWS.includes(view) || isMetaView(view)) return;
  else renderList(false);
}

/** Сменился трек (или очередь) — подсветить его в списках и в медиатеке, обновить «Далее» */
export function refreshPlaying() {
  if (view === "now") renderUpNext();
  markCurrentRows(state.current ? keyOf(state.current) : null);
  libList.querySelectorAll(".lib-item").forEach((li) => li.classList.toggle("playing-from", playingFrom(li.dataset.view)));
  syncPlayButtons();
}

// Спрятать / показать медиатеку (запоминается)
function setSidebarHidden(hidden) {
  document.body.classList.toggle("sidebar-hidden", hidden);
  const toggle = document.getElementById("sidebar-toggle");
  toggle.title = hidden ? "Показать медиатеку" : "Спрятать медиатеку";
  toggle.setAttribute("aria-label", toggle.title);
}

export function initViews() {
  setSidebarHidden(!!getSetting("sidebarHidden", false));
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    const hidden = !document.body.classList.contains("sidebar-hidden");
    setSidebarHidden(hidden);
    setSetting("sidebarHidden", hidden);
  });

  setQueueVisible(getSetting("showQueue", true) !== false);
  document.querySelectorAll('[data-np="queue"]').forEach((b) => b.addEventListener("click", onQueueButton));
  navHome.addEventListener("click", () => showView("home"));
  navNow.addEventListener("click", () => showView("now"));
  navFlow.addEventListener("click", () => showView("flow"));
  navSettings.addEventListener("click", () => showView("settings"));
  // «+» в медиатеке: создать пустой плейлист или импортировать по ссылке
  const newBtn = document.getElementById("new-playlist");
  newBtn.addEventListener("click", () => openMenu(newBtn, [
    { label: "Новый плейлист", icon: icons.plus, action: async () => {
      const playlist = await createPlaylist();
      if (playlist) showView(`playlist:${playlist.id}`);
    } },
    { label: "Импорт по ссылке…", icon: icons.import, action: () => openImportDialog({
      onOpen: (id) => showView(`playlist:${id}`),
    }) },
  ]));
  document.getElementById("minibar-open").addEventListener("click", () => showView("now"));
  // «Назад» — боковая кнопка мыши и Alt+←, как в браузере (кнопку-стрелку на экране автор попросил убрать)
  addEventListener("mouseup", (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } });
  addEventListener("keydown", (e) => { if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); } });
  setNavigator((key) => showView(key));
  showView("home");
}
