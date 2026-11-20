// Экраны: «Главная», «Сейчас играет» и экран плейлиста (свой плейлист, «Избранное», «Не нравится»),
// боковая панель «Медиатека» и мини-плеер, который виден везде, кроме «Сейчас играет».

import { addManyToPlaylist, addToPlaylistItems, createPlaylist, openPlaylistMenu, openTrackMenu, openUploadsMenu, pickPlaylistCover, removeTracksWithUndo, renamePlaylist, toggleDislike, toggleLike } from "./actions.js";
import { renderAlbum, renderArtist } from "./artist.js";
import { FLOW_MODES, cachedMixes, flowMode, hasTaste, setFlowMode, smartShuffle, startFlow, tasteMixes, warmFlow } from "./flow.js";
import { renderFlowView } from "./flowview.js";
import { renderFlowLive, syncFlowLive } from "./flowlive.js";
import { renderStatsLive } from "./statslive.js";
import { renderReleasesLive } from "./nrlive.js";
import { renderSearchView } from "./searchlive.js";
import { renderStats, statsCard } from "./stats.js";
import { renderWorkshop } from "./workshop.js";
import { renderWorkshopLive } from "./wslive.js";
import { wrappedButton, wrappedCard } from "./wrapped.js";
import { getPick, picks, picksBuilding } from "./picks.js";
import { icons } from "./icons.js";
import { openTrack, setNavigator, trackForPage } from "./nav.js";
import { renderTrack } from "./trackpage.js";
import { isMobile } from "./device.js";
import { renderTrackLive } from "./tplive.js";
import { renderArtistLive } from "./artistlive.js";
import { openImportDialog } from "./import.js";
import { createPlaylist as createPlaylistFrom, followedArtists, getPlaylist, getSetting, isAutoDownload, isDisliked, keyOf, lib, moveSongInPlaylist, pickedUpload, setSetting } from "./library.js";
import { groupSongs, songCount, uniqueSongs } from "./samesong.js";
import { isLyricsVisible, setLyricsVisible, showLyricLine } from "./lyrics.js";
import { anim, fadeUp, liveUi, rise, riseWords, sheen, swapImage, withTransition } from "./motion.js";
import { clearQueue, isPlaying, moveInQueue, play, playFromQueue, prefetch, queueLater, queueNext, removeFromQueue, state, syncLikeButtons, togglePlay } from "./player.js";
import { fillPlays, loadPlays, playsOf } from "./plays.js";
import { unheardCount, watchReleases } from "./releases.js";
import { releaseCard, renderReleases } from "./releaseview.js";
import { recsSection } from "./recs.js";
import { createFolder, deleteFolder, folders, libFilter, libSort, libToolsOn, recentOf, renameFolder, sidebarSignature, sortMenuItems, toggleFolder, toolsRow } from "./libtools.js";
import { localTracks } from "./local.js";
import { lookTrackChanged } from "./look.js";
import { countDownloaded, download, removeDownload, setAutoList, songsToDownload } from "./downloads.js";
import { renderSettings } from "./settings.js";
import { renderSettingsLive } from "./setlive.js";
import { agoText, artistLinks, choiceDialog, collectionCover, confirmDialog, coverUrl, displayTrack, el, formatTotal, iconButton, imageHsl, imgUrl, isBroken, markCurrentRows, nameHue, onBrokenTracks, openMenu, plural, toast, trackRow } from "./ui.js";
import { bigPill, colsClass, listColumns, liveHead, miniBtn, playPill, plCard, plLayout, statusLine } from "./plcard.js";
import { showLibCheckReport } from "./libcheck.js";
import { sharePlaylist } from "./share.js";

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
const navReleases = document.getElementById("nav-releases");
const navStats = document.getElementById("nav-stats");
const navWorkshop = document.getElementById("nav-workshop");
const viewFlow = document.getElementById("view-flow");
const viewStats = document.getElementById("view-stats");
const viewWorkshop = document.getElementById("view-workshop");
const viewSearch = document.getElementById("view-search");   // результаты поиска (ПК, searchlive.js)

// Какой экран открыт: "home" | "now" | "liked" | "disliked" | "playlist:<id>" | "artist:<id>" | "album:<id>"
let view = "";
const backStack = [];   // откуда пришли — для кнопки «Назад»

// Страницы исполнителя и альбома: данные приходят с сервера, медиатека их не меняет
const isMetaView = (key) => key === "releases" || /^(artist|album):./.test(key) || (/^track:./.test(key) && !!trackForPage(key.slice(6)));
let metaToken = 0;   // чтобы медленный ответ не нарисовал страницу, с которой уже ушли

// ---------- Что показывать для каждого экрана ----------

function describe(key) {
  if (key === "liked") {
    return { kind: "liked", label: "Плейлист", name: "Избранное", tracks: lib.liked, context: { type: "liked" },
      empty: "Нажимайте ♡ у треков, которые нравятся, — они соберутся здесь." };
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
  if (key.startsWith("pick:")) {   // «Собрано для вас» (picks.js)
    const pick = getPick(key.slice(5));
    if (!pick) return null;
    return { kind: "pick", label: "Собрано для вас", name: pick.name, desc: pick.desc, tracks: pick.tracks, pick,
      context: { type: "pick", id: pick.id, name: pick.name }, empty: "" };
  }
  const playlist = getPlaylist(key.slice("playlist:".length));
  if (!playlist) return null;
  return { kind: "playlist", label: "Плейлист", name: playlist.name, tracks: playlist.tracks, playlist, cover: playlist.cover,
    context: { type: "playlist", id: playlist.id },
    empty: "В плейлисте пока пусто. Найдите трек через поиск и добавьте его: «⋯» → «Добавить в плейлист»." };
}

const contextKey = (ctx) => (!ctx ? "" : ctx.id ? `${ctx.type}:${ctx.id}` : ctx.type);
const playingFrom = (key) => !!state.current && contextKey(state.context) === key;

// ---------- Одна песня — одна строка ----------
// В своих плейлистах и «Избранном» загрузки одной песни (YouTube + SoundCloud, samesong.js) показываются
// одной строкой. Данные не меняются — склеивается только показ. Играет выбранная в «Загрузки трека»,
// иначе первая, которая открывается (проверка медиатеки), иначе первая по списку
const MERGED_KINDS = new Set(["liked", "playlist"]);
const pickUpload = (members) => pickedUpload(members) ?? members.find((t) => !isBroken(t)) ?? members[0];
/** Песни коллекции: [{ track (какая играет), members (все загрузки), indices (места в списке) }] */
function songsOf(info) {
  if (!MERGED_KINDS.has(info.kind)) return info.tracks.map((track, i) => ({ track, members: [track], indices: [i] }));
  return groupSongs(info.tracks, pickUpload);
}
const songTracks = (info) => songsOf(info).map((g) => g.track);

/** Включить коллекцию: с первого трека без дизлайка или в случайном порядке */
function playCollection(info, shuffle = false) {
  const all = songTracks(info);   // каждая песня один раз, даже если у неё две загрузки
  let tracks = info.kind === "disliked" ? all : all.filter((t) => !lib.disliked.some((d) => keyOf(d) === keyOf(t)));
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
  prefetch(songTracks(info).find((t) => !lib.disliked.some((d) => keyOf(d) === keyOf(t))));
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

const FIXED_VIEWS = ["home", "flow", "now", "settings", "stats", "workshop", "search"];   // экраны со своей секцией (остальные — списки)

/** Открыть экран. Возвращает обещание «экран уже на месте»: на ПК смена идёт через переход
    (View Transitions, motion.js) — новый экран появляется не сразу, а в следующем кадре */
export function showView(key, { back = false } = {}) {
  if (!FIXED_VIEWS.includes(key) && !isMetaView(key) && !describe(key)) key = "home";
  if (key === "search" && !liveUi()) key = "home";   // на телефоне поиск — прежняя панель (search.js)
  const changed = key !== view;
  const first = !view;
  if (changed && view && !back) {
    backStack.push(view);
    if (backStack.length > 50) backStack.shift();
  }
  view = key;
  // «Живая обложка»: старый экран тает, обложка перелетает, новый собирается по кусочкам
  if (changed && !first && liveUi()) return withTransition(() => applyView(true), () => enterView(view));
  applyView(changed);
  return Promise.resolve();
}

/** Показать экран view (changed — его только что открыли) */
function applyView(changed) {
  const isList = !FIXED_VIEWS.includes(view);
  viewHome.hidden = view !== "home";
  viewNow.hidden = view !== "now";
  viewSettings.hidden = view !== "settings";
  viewFlow.hidden = view !== "flow";
  viewStats.hidden = view !== "stats";
  viewWorkshop.hidden = view !== "workshop";
  viewSearch.hidden = view !== "search";
  viewList.hidden = !isList;
  if (view === "home") renderHome(changed);
  if (view === "now") renderUpNext();
  if (view === "settings" && changed) (liveUi() ? renderSettingsLive : renderSettings)();   // на ПК — 4 раздела (setlive.js)
  // На ПК («Живая обложка») Flow, «Статистика» и «Новинки» — новые экраны (flowlive.js, statslive.js, nrlive.js)
  if (view === "flow") { if (liveUi()) renderFlowLive({ covers: flowCovers }); else renderFlowView(); }
  if (view === "stats") { if (liveUi()) renderStatsLive(viewStats); else renderStats(viewStats, wrappedButton()); }
  if (view === "workshop" && changed) (liveUi() ? renderWorkshopLive : renderWorkshop)(viewWorkshop);   // на ПК — wslive.js
  if (view === "search" && changed) renderSearchView(viewSearch);
  if (isMetaView(view)) { if (changed) renderMeta(); }
  else if (isList) renderList(changed);
  document.body.classList.toggle("on-flow", view === "flow");
  if (changed) {
    const shown = { home: viewHome, now: viewNow, settings: viewSettings, flow: viewFlow, stats: viewStats, workshop: viewWorkshop, search: viewSearch }[view] ?? viewList;
    shown.classList.remove("entering");
    if (!liveUi()) {   // на ПК вход рисует переход (enterView)
      void shown.offsetWidth;
      shown.classList.add("entering");
    }
    scroller.scrollTop = 0;
  }
  document.body.classList.toggle("on-now", view === "now");
  document.body.classList.toggle("on-search", view === "search");   // поле поиска шире и с кольцом (как в макете)
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
  if (key === "releases") return (liveUi() ? renderReleasesLive : renderReleases)(viewList, stillHere);   // экран «Новинки» (nrlive.js / releaseview.js)
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  // На ПК («Живая обложка») исполнитель и трек — новые страницы (artistlive.js, tplive.js), на телефоне — прежние
  const live = liveUi();
  const render = kind === "track" ? (box, key, alive) => (live ? renderTrackLive : renderTrack)(box, trackForPage(key), alive)
    : kind === "artist" ? (live ? renderArtistLive : renderArtist) : renderAlbum;
  render(viewList, id, stillHere).then(() => {
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
  // Вкуса ещё нет — сначала выбрать исполнителей на вкладке Flow
  playBtn.addEventListener("click", () => (playingFrom("flow:main") ? togglePlay() : hasTaste() ? startFlow() : showView("flow")));
  playBtn.addEventListener("pointerenter", () => warmFlow());   // «Открытия» соберутся, пока рука идёт к кнопке
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

function renderHome(entering = false) {
  if (liveUi()) return renderHomeLive(entering);
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
  const wrapped = wrappedCard();   // «Ваш год в музыке» — в декабре и январе
  if (wrapped) children.push(wrapped);
  const made = picksRow();         // «Собрано для вас» — подборки по вкусу
  if (made) children.push(...made);
  const stats = statsCard();   // «Ваша статистика» — есть, когда уже что-то послушали
  if (stats) children.push(stats);
  // Одна песня — одна карточка: слушали с YouTube, потом с SoundCloud — показываем последнюю (samesong.js)
  const recent = uniqueSongs(lib.history.filter((t) => !isDisliked(t))).slice(0, 10);
  if (recent.length) {
    const cards = el("div", "home-cards");
    recent.forEach((t, i) => cards.append(trackCard(t, recent, i, { type: "history" })));
    children.push(el("h2", "home-h", "Недавно слушали"), cards);
  } else {
    // Пусто — подсказываем, с чего начать
    const start = el("div", "home-start");
    start.append(el("h2", "", "С чего начать"),
      el("p", "", "Найдите трек через поиск сверху — или перенесите свои плейлисты из Spotify, YouTube или SoundCloud."));
    const importBtn = el("button", "btn primary", "Импортировать плейлист");
    importBtn.type = "button";
    importBtn.addEventListener("click", () => openImportDialog({ onOpen: (id) => showView(`playlist:${id}`) }));
    start.append(importBtn);
    children.push(start);
  }
  // «Ваши миксы» и новинки исполнителей, на которых подписан, — подгружаются в фоне и встают после плиток
  const mixes = el("div", "home-mixes");
  const fresh = el("div", "home-new");
  children.splice(1, 0, mixes, fresh);
  mixesRow(mixes);
  newReleasesRow(fresh);
  homeRest.replaceChildren(...children);
  markCurrentRows(state.current ? keyOf(state.current) : null);
  syncPlayButtons();
}

// ---------- «Живая обложка» (ПК): карточка «Сейчас играет» и три карточки Flow ----------
// Как в одобренном макете B-zhivoy.html. Телефон пока остаётся прежним (его переделываем отдельным шагом).

const MIC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

/** Кнопка-пилюля с подписью */
function pill(label, icon, cls = "") {
  const b = el("button", `nc-pill ${cls}`.trim());
  b.type = "button";
  b.innerHTML = icon;
  b.append(el("span", "", label));
  return b;
}

/** Открыть «Сейчас играет» с текстом песни */
function openLyrics() {
  showView("now");
  if (!isLyricsVisible()) setLyricsVisible(true);
}

let nowCardEl = null, nowCardKey = null, nowCardParts = null;
function nowCard() {
  if (nowCardEl) return nowCardEl;
  const card = nowCardEl = el("section", "now-card glass");
  card.innerHTML = '<div class="sheen-box"><i></i></div>';
  const cover = el("button", "nc-cover");
  cover.type = "button";
  cover.title = "Открыть «Сейчас играет»";
  const img = el("img");
  img.alt = "";
  img.onerror = () => img.classList.add("broken");
  cover.append(img);
  cover.addEventListener("click", () => showView("now"));

  const body = el("div", "nc-body");
  const title = el("h1", "nc-title");
  title.addEventListener("click", () => openTrack(state.current));   // щелчок по названию — страница трека
  const who = el("div", "nc-who");
  const line = el("div", "nc-line empty");   // строка текста песни, слова загораются (lyrics.js)
  const acts = el("div", "nc-acts");
  const lyricsBtn = pill("Текст", MIC_ICON, "white");
  lyricsBtn.addEventListener("click", openLyrics);
  // Сердечко — как остальные [data-np="like"]: значок и «on» ставит player.js, подпись — style.css
  const like = el("button", "nc-pill nc-like");
  like.type = "button";
  like.dataset.np = "like";
  like.addEventListener("click", () => { if (state.current) toggleLike(state.current); });
  const similar = pill("Похожее", icons.flow);
  similar.title = "Радио по этому треку: сначала он, дальше похожее";
  similar.addEventListener("click", () => { if (state.current) startFlow({ track: state.current }); });
  acts.append(lyricsBtn, like, similar);
  body.append(el("small", "nc-kicker", "Сейчас играет"), title, who, line, acts);

  const next = el("div", "nc-next");
  const nextList = el("div", "nc-next-list");
  next.append(el("h5", "", "Далее"), nextList);
  card.append(cover, body, next);
  nowCardParts = { img, title, who, line, nextList, next };
  return card;
}

/** Обновить карточку под текущий трек. animate — трек сменился у человека на глазах */
function updateNowCard(animate) {
  const t = state.current;
  if (!t) return;
  const card = nowCard(), { img, title, who, line } = nowCardParts;
  const key = keyOf(t);
  const changed = key !== nowCardKey;
  const swap = animate && changed && !!nowCardKey;
  nowCardKey = key;
  if (changed) {
    const shown = displayTrack(t);
    img.classList.remove("broken");
    if (swap) swapImage(img, coverUrl(t, "large"), state.dir);
    else img.src = coverUrl(t, "large");
    riseWords(title, shown.title, { animate: swap });
    title.title = t.title;
    who.replaceChildren(artistLinks(t, shown.artist));
    // Альбом — если он не называется так же, как трек (тогда это сингл)
    const album = (t.album || "").trim();
    if (album && album.toLowerCase() !== shown.title.toLowerCase()) who.append(` · Альбом «${album}»`);
    if (swap) { fadeUp(who, 260); sheen(card); }
  }
  renderNextRows(swap);
  syncLikeButtons();   // подпись и значок сердечка в карточке
  showLyricLine(line);
}

/** «Далее»: три следующих трека очереди; при смене трека въезжают по очереди */
let nextSig = "";
function renderNextRows(animate) {
  const { nextList, next } = nowCardParts;
  const rows = [];
  for (let i = state.index + 1; i < state.queue.length && rows.length < 3; i++) {
    if (!isDisliked(state.queue[i])) rows.push(i);
  }
  next.hidden = !rows.length;
  const sig = rows.map((i) => `${i}:${keyOf(state.queue[i])}`).join("|");
  if (sig === nextSig && !animate) return;
  nextSig = sig;
  const loads = [];
  nextList.replaceChildren(...rows.map((i) => {
    const track = state.queue[i], shown = displayTrack(track);
    const r = el("button", "nc-next-row");
    r.type = "button";
    // Обложка в рамке-заглушке: пока сервер её готовит (первый раз у SoundCloud ~1 с), виден мягкий квадрат,
    // а сама картинка проявляется, а не выскакивает
    const art = el("span", "nc-next-art");
    const img = el("img");
    img.alt = "";
    img.src = coverUrl(track);
    if (!img.complete) {
      img.classList.add("wait");
      loads.push(img.decode().catch(() => {}).then(() => img.classList.remove("wait")));
    }
    img.onerror = () => img.classList.add("broken");
    art.append(img);
    const text = el("span", "nc-next-text");
    text.append(el("b", "", shown.title), el("span", "", shown.artist));
    r.append(art, text);
    r.title = track.title;
    r.addEventListener("click", () => playFromQueue(i));
    r.addEventListener("mouseenter", () => prefetch(track));
    return r;
  }));
  if (animate) [...nextList.children].forEach((r, i) => anim(r, [{ opacity: 0, transform: `translateX(${state.dir * 24}px)` }, { opacity: 1, transform: "none" }], { duration: 520, delay: 160 + i * 70 }));
  // Заранее — уже ПОСЛЕ маленьких обложек (картинки SoundCloud сервер качает не больше чем в 3 соединения,
  // и большая, начатая первой, задерживала маленькие в «Далее»): большая обложка следующего трека —
  // при переключении она сразу выезжает вместе с названием; маленькие ещё двух треков — въедут в «Далее» следом
  Promise.all(loads).then(() => {
    if (nextSig !== sig) return;
    if (rows.length) new Image().src = coverUrl(state.queue[rows[0]], "large");
    let more = 0;
    for (let i = rows.at(-1) + 1; i < state.queue.length && more < 2; i++) {
      if (!isDisliked(state.queue[i])) { new Image().src = coverUrl(state.queue[i]); more++; }
    }
  });
}

/** Нет трека — вместо карточки приветствие */
let greetEl = null;
function greetCard() {
  if (!greetEl) {
    greetEl = el("div", "home-hero");
    greetEl.append(homeGreet, el("p", "home-sub", "Что послушаем?"));
  }
  if (homeGreet.textContent !== greeting()) homeGreet.textContent = greeting();
  return greetEl;
}

const FLOW_CARDS = [
  { mode: "liked", title: "Любимое", sub: "То, что уже нравится" },
  { mode: "mix", title: "Микс", sub: "Любимое и новое" },
  { mode: "discover", title: "Открытия", sub: "Кого вы ещё не слышали" },
];

/** Три цветные карточки Flow: фон — размытая обложка из медиатеки, ▶ — Flow в этом режиме */
let flowRowEl = null;
function flowRow() {
  if (flowRowEl) return flowRowEl;
  const row = flowRowEl = el("section", "home-flow");
  const head = el("button", "home-h home-h-link", "Flow — бесконечно и под ваш вкус");
  head.type = "button";
  head.title = "Открыть Flow";
  head.addEventListener("click", () => showView("flow"));
  const cards = el("div", "fl-cards");
  for (const c of FLOW_CARDS) {
    const card = el("button", "fl-card");
    card.type = "button";
    card.dataset.mode = c.mode;
    card.title = FLOW_MODES.find((m) => m.value === c.mode)?.hint ?? "";
    const play = el("span", "fl-play");
    play.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`;
    card.append(el("span", "fl-bg"), el("b", "", c.title), el("span", "fl-sub", c.sub), play);
    card.addEventListener("click", () => onFlowCard(c));
    card.addEventListener("pointerenter", () => { if (!playingFrom("flow:main")) warmFlow(c.mode); });
    cards.append(card);
  }
  row.append(head, cards);
  return row;
}

function onFlowCard(c) {
  if (playingFrom("flow:main")) {
    if (flowMode() === c.mode) return togglePlay();
    setFlowMode(c.mode);
    toast(`Flow: «${c.title}» — со следующего трека`);
    return syncFlowCards();
  }
  if (!hasTaste()) return showView("flow");   // вкуса ещё нет — сначала выбрать исполнителей
  setFlowMode(c.mode);
  startFlow({ mode: c.mode });
}

/** Обложки для фона карточек: разные и яркие картинки из избранного, истории и плейлистов. Насыщенность
    каждой считаем один раз (картинка грузится в фоне); тусклые (бежевые, серые) не берём — карточка
    выходила мутной. Ярких не нашлось — у карточки свои цветные пятна */
const coverSat = new Map();   // адрес обложки → насыщенность 0–100 (−1 — ещё считается)
function scoreCover(url) {
  if (coverSat.has(url)) return;
  coverSat.set(url, -1);
  const img = new Image();
  img.onload = () => {
    coverSat.set(url, vividness(img));
    syncFlowCards();
  };
  img.onerror = () => coverSat.set(url, 0);
  img.src = url;
}
/** Насколько картинка цветная в целом (0–100): средняя «цветность» всех точек. imageHsl для этого не годится —
    он нарочно ищет цвет даже в серой обложке с одним красным пятном */
function vividness(img) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    return (sum / (d.length / 4) / 255) * 100;
  } catch {
    return 0;
  }
}
function flowCovers() {
  const seen = new Set(), candidates = [];
  const pool = [...lib.liked.slice(0, 30), ...lib.history.slice(0, 30), ...lib.playlists.flatMap((p) => p.tracks.slice(0, 4))];
  for (const t of pool) {
    const url = coverUrl(t);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push(url);
    if (candidates.length === 14) break;
  }
  candidates.forEach(scoreCover);
  return candidates.filter((u) => coverSat.get(u) >= 25).slice(0, 3);
}

function syncFlowCards() {
  if (view === "flow" && liveUi()) syncFlowLive();   // те же обложки — у карточек режимов на экране Flow
  if (!flowRowEl) return;
  const covers = flowCovers();
  flowRowEl.querySelectorAll(".fl-card").forEach((card, i) => {
    const url = covers[i] ?? "";
    const want = url ? `url("${url.replace(/["\\\n]/g, encodeURIComponent)}")` : "";
    if (card.style.getPropertyValue("--img") !== want) card.style.setProperty("--img", want);
    card.classList.toggle("no-img", !url);
    const on = playingFrom("flow:main") && flowMode() === card.dataset.mode;
    card.classList.toggle("is-playing", on && isPlaying());
  });
}

/** Главная в новом виде: карточка «Сейчас играет» (или приветствие), Flow, ряды карточек */
function renderHomeLive(entering) {
  const top = state.current ? nowCard() : greetCard();
  if (viewHome.firstElementChild !== top || !viewHome.contains(homeRest)) viewHome.replaceChildren(top, flowRow(), homeRest);
  if (state.current) updateNowCard(!entering);
  else showLyricLine(null);
  syncFlowCards();

  const children = [];
  const wrapped = wrappedCard();   // «Ваш год в музыке» — в декабре и январе
  if (wrapped) children.push(wrapped);
  const mixes = el("div", "home-mixes");
  const fresh = el("div", "home-new");
  children.push(mixes, fresh);
  const made = picksRow();         // «Собрано для вас» — подборки по вкусу
  if (made) children.push(...made);
  const recent = uniqueSongs(lib.history.filter((t) => !isDisliked(t))).slice(0, 10);
  if (recent.length) {
    const cards = el("div", "home-cards");
    recent.forEach((t, i) => cards.append(trackCard(t, recent, i, { type: "history" })));
    children.push(el("h2", "home-h", "Недавно слушали"), cards);
  }
  const stats = statsCard();   // «Ваша статистика» — есть, когда уже что-то послушали
  if (stats) children.push(stats);
  if (!recent.length) {
    const start = el("div", "home-start");
    start.append(el("h2", "", "С чего начать"),
      el("p", "", "Найдите трек через поиск сверху — или перенесите свои плейлисты из Spotify, YouTube или SoundCloud."));
    const importBtn = el("button", "btn primary", "Импортировать плейлист");
    importBtn.type = "button";
    importBtn.addEventListener("click", () => openImportDialog({ onOpen: (id) => showView(`playlist:${id}`) }));
    start.append(importBtn);
    children.push(start);
  }
  mixesRow(mixes);
  newReleasesRow(fresh);
  homeRest.replaceChildren(...children);
  markCurrentRows(state.current ? keyOf(state.current) : null);
  syncPlayButtons();
}

// ---------- Вход на экран («Живая обложка»): куски выплывают из размытия по очереди ----------

function enterView(key) {
  if (key === "home") {
    const card = viewHome.querySelector(".now-card, .home-hero");
    anim(card, [{ offset: 0, opacity: 0, transform: "scale(.98)" }], { duration: 450, fill: "backwards" });
    card?.querySelectorAll(".nc-body > *, .nc-next h5, .nc-next-row, .home-hero > *").forEach((n, i) => rise(n, 120 + i * 45, 14));
    viewHome.querySelectorAll(".home-flow .home-h, .fl-card, .home-rest .home-h, .home-rest .home-card, .home-rest .home-h-row")
      .forEach((n, i) => rise(n, 220 + Math.min(i, 14) * 40));
    return;
  }
  if (key === "now") {
    // Фон чуть «наезжает» — ощущение глубины
    anim(document.querySelector(".backdrop"), [{ transform: "scale(1.08)" }, { transform: "none" }], { duration: 1400, fill: "none" });
    document.querySelectorAll("#np-info [data-np=title] .wd").forEach((w, i) => rise(w, 380 + Math.min(i, 10) * 60, 14, 600));
    rise(document.querySelector("#np-info [data-np=artist]"), 460, 10);
    rise(document.querySelector("#view-now .np-actions"), 520, 10);
    rise(document.querySelector("#lyrics .lyrics-head"), 300, 8);
    // Строки текста выплывают по очереди — те, что видны: от пары строк над текущей и ниже
    const lines = [...document.querySelectorAll("#lyrics .lyrics-line")];
    const from = Math.max(0, lines.findIndex((p) => p.classList.contains("active")) - 3);
    lines.slice(from, from + 10).forEach((p, i) => anim(p, [{ offset: 0, opacity: 0, transform: "translateY(26px)", filter: "blur(12px)" }],
      { duration: 800, delay: 340 + i * 80, fill: "backwards" }));
    document.querySelectorAll("#up-next .up-next-head, #up-next .up-next-label, #up-next .up-next-item").forEach((n, i) => i < 14 && rise(n, 300 + i * 40, 14));
    return;
  }
  // Остальные экраны: крупные куски по очереди
  const box = document.querySelector(".views > .view:not([hidden])");
  [...(box?.children ?? [])].slice(0, 8).forEach((n, i) => rise(n, 80 + i * 60, 16));
}

// Цвет полосы с названием у каждой подборки
const PICK_COLORS = { daily: "hsl(215 60% 42%)", moment: "hsl(28 70% 42%)", discover: "hsl(150 45% 32%)", forgotten: "hsl(340 45% 40%)" };

/** «Собрано для вас»: плейлист дня, по времени суток, открытия недели, забытое (picks.js) */
function picksRow() {
  const list = picks();
  if (!list.length && !picksBuilding()) return null;
  const cards = el("div", "home-cards");
  for (const p of list) {
    const key = `pick:${p.id}`;
    const card = el("button", "home-card pick-card");
    card.type = "button";
    card.dataset.collection = key;
    card.style.setProperty("--pick", PICK_COLORS[p.id] ?? "hsl(250 40% 40%)");
    const art = el("div", "home-card-art pick-art");
    art.append(collectionCover("pick", { tracks: p.tracks }), el("span", "pick-name", p.name));
    const playBtn = el("span", "tile-play");
    playBtn.innerHTML = icons.play;
    playBtn.title = "Слушать";
    const info = describe(key);
    playBtn.addEventListener("click", (e) => { e.stopPropagation(); if (!info) return; if (playingFrom(key)) togglePlay(); else playCollection(info); });
    art.append(playBtn);
    card.append(art, el("span", "home-card-title", p.name), el("span", "home-card-artist", p.desc));
    card.title = p.desc;
    card.addEventListener("click", () => showView(key));
    card.addEventListener("mouseenter", () => info && prefetchCollection(info));
    cards.append(card);
  }
  // Пока что-то собирается впервые — место под карточку, чтобы ряд не прыгал
  if (picksBuilding() && list.length < 4) {
    const ghost = el("div", "home-card pick-card building");
    ghost.append(el("div", "home-card-art"), el("span", "home-card-title", "Собираем…"), el("span", "home-card-artist", "по вашему вкусу"));
    cards.append(ghost);
  }
  return [el("h2", "home-h", "Собрано для вас"), cards];
}

/** «Ваши миксы»: Flow по группе похожих любимых исполнителей. Посчитанные — сразу, без мигания */
function mixesRow(box) {
  const fill = (list) => {
    if (!list?.length) return;
    const cards = el("div", "home-cards");
    for (const mix of list) {
      const id = `flow:mix-${mix.id}`;
      const card = el("button", "home-card mix-card");
      card.type = "button";
      card.dataset.collection = id;
      const art = el("div", "home-card-art mix-art");
      const [lead, ...rest] = mix.artists;
      if (lead.picture) {
        const img = el("img");
        img.alt = "";
        img.loading = "lazy";
        img.src = imgUrl(lead.picture);
        img.onerror = () => img.classList.add("broken");
        art.append(img);
      }
      // Остальные исполнители микса — маленькие кружки внизу
      const faces = el("div", "mix-faces");
      for (const a of rest.slice(0, 4)) {
        const face = el("span", "mix-face", a.name.slice(0, 1).toUpperCase());
        if (a.picture) {
          const img = el("img");
          img.alt = "";
          img.src = imgUrl(a.picture);
          img.onload = () => face.replaceChildren(img);
        }
        face.title = a.name;
        faces.append(face);
      }
      art.append(faces);   // без метки «Микс»: и так понятно из заголовка «Ваши миксы»
      if (liveUi()) {   // ▶ выпрыгивает при наведении, как у остальных карточек (щелчок — по всей карточке)
        const playBtn = el("span", "tile-play");
        playBtn.innerHTML = icons.play;
        art.append(playBtn);
      }
      card.append(art, el("span", "home-card-title", mix.name),
        el("span", "home-card-artist", mix.artists.length > 2 ? mix.artists.map((a) => a.name).join(", ") : "и похожие исполнители"));
      card.title = mix.artists.map((a) => a.name).join(", ");
      card.addEventListener("click", () => (playingFrom(id) ? togglePlay() : startFlow({ mix })));
      cards.append(card);
    }
    box.replaceChildren(el("h2", "home-h", "Ваши миксы"), cards);
  };
  const ready = cachedMixes();
  if (ready) fill(ready);
  else tasteMixes().then((list) => { if (box.isConnected) fill(list); });
}

/** «Новинки ваших исполнителей» на «Главной» (подписки — кнопка «Подписаться» на странице исполнителя;
    подписок мало — и самые слушаемые, с пометкой «Из ваших любимых»). Сначала — Яндекс, потом — с SoundCloud */
function newReleasesRow(box) {
  watchReleases((list) => {
    if (!box.isConnected) return;
    if (!list.length) return box.replaceChildren();
    const onlyFav = list.every((r) => r.fav);
    const cards = el("div", "home-cards");
    const shown = list.slice(0, 10);
    for (const r of shown) cards.append(releaseCard(r, shown, { markFav: !onlyFav }));
    const head = el("div", "home-h-row");
    const all = el("button", "home-h-all", "Все");
    all.type = "button";
    all.title = "Все новинки";
    all.addEventListener("click", () => showView("releases"));
    head.append(el("h2", "home-h", onlyFav ? "Новинки ваших любимых исполнителей" : "Новинки ваших исполнителей"), all);
    box.replaceChildren(head, cards);
  });
}

// ---------- «Далее» на экране «Сейчас играет» ----------

export function contextName(ctx) {
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
  if (track.smart) {   // рекомендация умного перемешивания
    text.querySelector(".up-next-artist").prepend(el("span", "up-next-rec", "✦ "));
    li.title = track.because || "Рекомендация";
  }
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
  head.append(el("span", "up-next-title", isMobile ? "Далее" : "Очередь"));   // телефон: лист «Далее» (шаг 11б)
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
  const label = el("div", "up-next-label", isMobile ? (from ? `Из «${from}»` : "") : from ? `Далее — из «${from}»` : "Далее");
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
      : "Дальше ничего нет. Включите плейлист или добавьте трек: «⋯» → «Играть следующим»."));
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
  const on = show && !document.body.classList.contains("show-lyrics");   // текст закрывает очередь
  document.querySelectorAll('[data-np="queue"]').forEach((b) => b.classList.toggle("on", on));
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
  const subLine = el("div", "lib-sub", sub);
  const auto = autoListId(info);
  if (auto && isAutoDownload(auto)) {   // «Скачивать новые» включено — стрелка перед подписью
    const mark = el("span", "lib-auto");
    mark.innerHTML = icons.download;
    mark.title = "Новые треки скачиваются сами";
    subLine.prepend(mark);
  }
  text.append(el("div", "lib-name", info.name), subLine);
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
        onAutoDownload: () => toggleAutoDownload(info),
      });
    });
  }
  return li;
}

/** Подписка в медиатеке: круглое фото, «Исполнитель» */
function artistItem(a) {
  const key = `artist:${a.id}`;
  const li = el("li", "lib-item lib-artist");
  li.dataset.view = key;
  li.dataset.warm = key;
  li.classList.toggle("active", view === key);
  li.tabIndex = 0;
  const pic = el("div", "collection-cover lib-artist-pic");
  if (a.picture) {
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = /^https:\/\/(avatars\.yandex|[\w.-]+\.dzcdn|i\d*\.sndcdn)/.test(a.picture) ? imgUrl(a.picture) : a.picture;
    img.onerror = () => { img.remove(); pic.textContent = (a.name || "?").slice(0, 1).toUpperCase(); };
    pic.append(img);
  } else {
    pic.textContent = (a.name || "?").slice(0, 1).toUpperCase();
    pic.style.background = `hsl(${nameHue(a.name || "")} 35% 30%)`;
    pic.style.color = "#fff";   // кружок тёмный при любой теме — буква белая (в «Светлой» была тёмной на тёмном)
  }
  const text = el("div", "lib-text");
  text.append(el("div", "lib-name", a.name || "Исполнитель"), el("div", "lib-sub", String(a.id).startsWith("sc:") ? "Исполнитель · SoundCloud" : "Исполнитель"));
  li.append(pic, text);
  li.addEventListener("click", () => showView(key));
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") showView(key); });
  return li;
}

/** Папка плейлистов: щелчок — раскрыть/свернуть; «⋯» (видна при наведении) или правая кнопка —
 *  переименовать/удалить. Раньше меню было только по правой кнопке — его никто не находил. */
function folderItem(folder, count) {
  const li = el("li", `lib-item lib-folder${folder.open ? " open" : ""}`);
  li.tabIndex = 0;
  const cover = el("div", "collection-cover folder-cover");
  cover.innerHTML = icons.folder;
  const text = el("div", "lib-text");
  text.append(el("div", "lib-name", folder.name), el("div", "lib-sub", `Папка · ${plural(count, "плейлист", "плейлиста", "плейлистов")}`));
  const more = iconButton(icons.more, "Ещё", "lib-more");
  const arrow = el("span", "lib-folder-arrow");
  arrow.innerHTML = icons.chevron;
  li.append(cover, text, more, arrow);
  const menuAt = (anchor) => openMenu(anchor, [
    { label: "Переименовать", icon: icons.edit, action: () => renameFolder(folder) },
    { label: "Удалить папку", icon: icons.trash, danger: true, action: () => deleteFolder(folder) },
  ]);
  more.addEventListener("click", (e) => { e.stopPropagation(); menuAt(more); });
  const toggle = () => toggleFolder(folder);
  li.addEventListener("click", toggle);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === li) toggle(); });
  li.addEventListener("contextmenu", (e) => { e.preventDefault(); menuAt({ x: e.clientX, y: e.clientY }); });
  return li;
}

const libText = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");

/** Значок у «Новинок» (ПК): сколько вышло за неделю и ещё не послушано; послушали всё — значка нет */
function syncReleasesBadge() {
  if (!liveUi()) return;
  const n = unheardCount();
  let badge = navReleases.querySelector(".nav-badge");
  if (!n) return badge?.remove();
  if (!badge) navReleases.append(badge = el("em", "nav-badge"));
  badge.textContent = n > 9 ? "9+" : String(n);
  navReleases.title = `Новинки · ${plural(n, "новый релиз", "новых релиза", "новых релизов")} за неделю`;
}
document.addEventListener("sono:releases", syncReleasesBadge);

export function renderSidebar({ keepFocus = false } = {}) {
  navHome.classList.toggle("active", view === "home");
  navNow.classList.toggle("active", view === "now");
  navFlow.classList.toggle("active", view === "flow");
  navSettings.classList.toggle("active", view === "settings");
  navReleases.classList.toggle("active", view === "releases");
  syncReleasesBadge();
  navStats.classList.toggle("active", view === "stats");
  navWorkshop.classList.toggle("active", view === "workshop");
  lastSidebarSig = sidebarSignature();
  const tools = libToolsOn();
  // Счётчик — песни, как и строки в списке (две загрузки одной песни — один трек)
  const playlistItem = (p) => libItem(`playlist:${p.id}`, describe(`playlist:${p.id}`), `Плейлист · ${plural(songCount(p.tracks), "трек", "трека", "треков")}`);
  const pinned = [libItem("liked", describe("liked"), `Плейлист · ${plural(songCount(lib.liked), "трек", "трека", "треков")}`)];
  if (localTracks().length) {
    pinned.push(libItem("local", describe("local"), `С компьютера · ${plural(localTracks().length, "трек", "трека", "треков")}`));
  }
  if (lib.downloads.length) {
    pinned.push(libItem("downloads", describe("downloads"), `Без интернета · ${plural(lib.downloads.length, "трек", "трека", "треков")}`));
  }
  const disliked = libItem("disliked", describe("disliked"), plural(lib.disliked.length, "трек", "трека", "треков"));
  disliked.classList.add("muted-item");

  // Прежняя медиатека: плейлисты по порядку, без папок, фильтров и подписок
  if (!tools) {
    document.querySelector(".lib-tools")?.remove();
    libList.replaceChildren(...pinned.slice(0, 1), ...lib.playlists.map(playlistItem), ...pinned.slice(1), el("li", "lib-sep"), disliked);
    return;
  }

  // Строка фильтров — над списком (перерисовывается вместе с ним)
  const artistsAll = followedArtists();
  if (libFilter.chip === "artists" && !artistsAll.length) libFilter.chip = "all";
  // ПК: без отдельной строки — 🔍 и «≡» в заголовке «Медиатека», перед «+» (libtools.js → compact)
  const compact = liveUi();
  const row = toolsRow((opts) => renderSidebar(opts), (anchor) => openMenu(anchor, sortMenuItems()), artistsAll.length > 0, compact);
  const oldRow = document.querySelector(".lib-tools");
  const hadFocus = keepFocus && oldRow?.contains(document.activeElement);
  if (oldRow) oldRow.replaceWith(row);
  else if (compact) document.getElementById("new-playlist").before(row);
  else libList.before(row);
  if (hadFocus) {
    const input = row.querySelector("input");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  const sort = libSort();
  const q = libText(libFilter.query.trim());
  const match = (name) => !q || libText(name).includes(q);
  const byName = (a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
  const order = (list, keyOf, createdOf) => {
    const out = list.slice();
    if (sort === "alpha") out.sort(byName);
    else if (sort === "added") out.sort((a, b) => createdOf(b) - createdOf(a));
    else if (sort === "recent") out.sort((a, b) => (recentOf(keyOf(b)) || createdOf(b)) - (recentOf(keyOf(a)) || createdOf(a)));
    return out;
  };
  const items = [];
  if (libFilter.chip !== "artists") {
    items.push(...pinned.filter((li) => match(li.querySelector(".lib-name").textContent)));
    const playlists = order(lib.playlists, (p) => `playlist:${p.id}`, (p) => p.created || 0);
    if (q) {
      items.push(...playlists.filter((p) => match(p.name)).map(playlistItem));   // поиск — без папок
    } else {
      const inFolder = new Set();
      for (const f of folders()) {
        const inside = playlists.filter((p) => f.items.includes(p.id));
        inside.forEach((p) => inFolder.add(p.id));
        items.push(folderItem(f, inside.length));
        if (f.open) inside.forEach((p) => { const li = playlistItem(p); li.classList.add("in-folder"); items.push(li); });
      }
      items.push(...playlists.filter((p) => !inFolder.has(p.id)).map(playlistItem));
    }
  }
  if (libFilter.chip !== "playlists") {
    // Подписки: «Добавлено» — порядок подписки (новые первыми)
    const artists = order(artistsAll.map((a, i) => ({ ...a, n: artistsAll.length - i })), (a) => `artist:${a.id}`, (a) => a.n);
    items.push(...artists.filter((a) => match(a.name)).map(artistItem));
  }
  if (!items.length) items.push(el("li", "lib-empty", q ? "Ничего не нашлось" : "Пусто"));
  if (libFilter.chip === "all" && !q) items.push(el("li", "lib-sep"), disliked);
  libList.replaceChildren(...items);
}

let lastSidebarSig = "";
addEventListener("sono:libtools", () => renderSidebar());

// ---------- Кнопка «Скачать» в шапке плейлиста ----------
// Стрелка: скачать все треки. Когда всё скачано — закрашенная; по щелчку предлагает удалить загрузки.

function downloadControl(info) {
  const wrap = el("div", "pl-download");
  wrap.dataset.collection = view;
  const btn = iconButton(icons.download, "Скачать", "pl-dl-btn");
  btn.addEventListener("click", () => onDownloadClick(info));
  wrap.append(btn, el("span", "pl-dl-status"));
  syncDownloadControl(wrap, info.tracks);
  return wrap;
}

/** «Скачать»: не всё скачано — скачать; всё — предложить удалить загрузки */
async function onDownloadClick(info) {
  const { done } = countDownloaded(info.tracks);
  if (done < info.tracks.length) {
    download(info.tracks);
    toast(`Скачиваю «${info.name}» — треки будут играть без интернета`, { icon: "download" });
    return;
  }
  const ok = await confirmDialog({ title: `Удалить загрузки «${info.name}»?`,
    text: "Треки останутся на месте, просто снова будут играть из интернета.", okLabel: "Удалить" });
  if (!ok) return;
  const failed = await removeDownload(info.tracks);
  toast(failed ? `Удалено, кроме ${plural(failed, "трека", "треков", "треков")}, который сейчас играет` : "Загрузки удалены");
}

function syncDownloadControl(wrap, tracks) {
  const { done, active } = countDownloaded(tracks);
  const all = tracks.length > 0 && done === tracks.length;
  if (wrap.classList.contains("pl-mini")) {   // кнопка с подписью в карточке (ПК): «Скачать» / «3 из 7» / «Скачано»
    wrap.innerHTML = `${all ? icons.downloaded : icons.download}<span class="pl-mini-l"></span>`;
    wrap.querySelector(".pl-mini-l").textContent = active ? `${done} из ${tracks.length}` : all ? "Скачано" : done ? `${done} из ${tracks.length}` : "Скачать";
    wrap.classList.toggle("on", all);
    wrap.classList.toggle("busy", active > 0);
    wrap.title = active ? `Скачиваю… ${done} из ${tracks.length}` : all ? "Скачано — удалить загрузки" : "Скачать — чтобы играло без интернета";
    return;
  }
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

// ---------- «Скачивать новые» (авто-скачивание, downloads.js) ----------
// Выключатель в шапке «Избранного» и своих плейлистов: всё, что сюда добавят, сразу скачивается

const autoListId = (info) => (info.kind === "liked" ? "liked" : info.kind === "playlist" ? info.playlist.id : null);

/** Включить/выключить «Скачивать новые» у списка (из шапки и из «⋯» плейлиста) */
export async function toggleAutoDownload(info) {
  const id = autoListId(info);
  if (isAutoDownload(id)) {
    setAutoList(id, false);
    syncAutoControls();
    toast(`«${info.name}»: новые треки больше не скачиваются сами`);
    return;
  }
  const left = songsToDownload(info.tracks).length;
  let catchUp = false;
  if (left) {
    const answer = await choiceDialog({
      title: "Скачивать новые треки?",
      text: `Всё, что вы добавите в «${info.name}», будет сразу скачиваться и играть без интернета. `
        + (left === 1 ? "Один трек уже лежит здесь — скачать и его?"
          : `Ещё ${plural(left, "трек", "трека", "треков")} уже лежат здесь — скачать и их?`),
      buttons: [{ label: "Только новые", value: "new" }, { label: "Скачать все", value: "all", primary: true }],
    });
    if (!answer) return;
    catchUp = answer === "all";
  }
  setAutoList(id, true, catchUp);
  syncAutoControls();
  toast(catchUp ? `Скачиваю «${info.name}» — новые треки тоже будут скачиваться сами`
    : `«${info.name}»: новые треки будут скачиваться сами`);
}

const syncAutoControls = () => document.querySelectorAll(".pl-auto")
  .forEach((btn) => btn.setAttribute("aria-pressed", String(isAutoDownload(btn.dataset.autoList))));

function autoControl(info) {
  const id = autoListId(info);
  const btn = el("button", "pl-auto");
  btn.type = "button";
  btn.dataset.autoList = id;
  btn.append(el("span", "pl-auto-knob"), el("span", "pl-auto-text", "Скачивать новые"));
  btn.title = "Всё, что добавите сюда, будет сразу скачиваться и играть без интернета";
  btn.setAttribute("aria-pressed", String(isAutoDownload(id)));
  btn.addEventListener("click", () => toggleAutoDownload(info));
  return btn;
}

/** Состояние скачиваний изменилось — обновить кнопки «Скачать» на экране */
export function refreshDownloads() {
  document.querySelectorAll(".pl-download").forEach((wrap) => {
    const info = describe(wrap.dataset.collection);
    if (info) syncDownloadControl(wrap, info.tracks);
  });
  syncAutoControls();
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
  // Песни (две загрузки одной песни — одна строка и один трек в счёте)
  const songs = songsOf(info);
  const songList = songs.map((g) => g.track);
  const meta = songs.length ? `${plural(songs.length, "трек", "трека", "треков")} · ${formatTotal(songList)}` : "Пусто";
  text.append(el("div", "pl-kind", info.label), name);
  if (info.desc) text.append(el("div", "pl-desc", info.desc));
  const metaLine = el("div", "pl-meta", meta);
  metaLine.dataset.kind = info.label;   // телефон: «Плейлист · 8 треков · 21 мин» одной строкой (шаг 11в)
  text.append(metaLine);
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
    shuffle.disabled = songs.length < 2;
    shuffle.addEventListener("click", () => playCollection(info, true));
    actions.append(playBtn, shuffle);
    // Умное перемешивание: вперемешку + после каждых двух треков — похожий из рекомендаций
    if (info.kind !== "pick") {
      const smart = iconButton(icons.smartShuffle, "Умное перемешивание: список вперемешку и похожие треки между ними", "pl-smart");
      smart.disabled = !info.tracks.length;
      smart.addEventListener("click", () => smartShuffle({ name: info.name, tracks: songList, context: info.context }));
      actions.append(smart);
    }
    if (info.tracks.length) actions.append(downloadControl(info));
    if (autoListId(info)) actions.append(autoControl(info));
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
  if (info.pick && info.tracks.length) {   // подборка меняется сама — понравилась, можно оставить себе
    const keep = el("button", "flow-pill");
    keep.type = "button";
    keep.innerHTML = `${icons.plus}<span>Сохранить в медиатеку</span>`;
    keep.title = "Подборка обновится — а копия останется у вас";
    keep.addEventListener("click", () => {
      const date = new Date(info.pick.at).toLocaleDateString("ru", { day: "numeric", month: "long" });
      const p = createPlaylistFrom(`${info.name} · ${date}`, info.tracks);
      toast(`Плейлист «${p.name}» — в медиатеке`);
    });
    actions.append(keep);
  }
  if (info.playlist) {
    const more = iconButton(icons.more, "Ещё", "pl-more");   // на телефоне её зовёт «⋯» в полоске сверху (mobile.js)
    more.addEventListener("click", () => openPlaylistMenu(more, info.playlist, {
      onPlay: () => playCollection(info),
      onDeleted: () => showView("home"),
      onAutoDownload: () => toggleAutoDownload(info),
    }));
    actions.append(more);
  }

  // Список треков. Поиск по списку, сортировка и выбор нескольких (Ctrl/Shift) — см. listTools
  const st = listState(view);
  const list = el("ol", "tracklist");
  const empty = el("p", "pl-empty", "Ничего не нашлось");
  empty.hidden = true;
  const live = liveUi();   // ПК, «Живая обложка»: карточка слева, список с колонками справа (plcard.js)
  const cols = live ? listColumns(songList) : null;
  let tools, drawSelectBar, clearSelection;
  let shownSongs = [];   // песни в том порядке, в каком стоят строки (для перетаскивания)
  // Первое открытие длинного списка: сразу — первые строки (их и видно), остальные — следом, не задерживая показ
  // (3000 треков рисовались ~1 с целиком). При перерисовке — сразу все: иначе потерялось бы место прокрутки
  let firstDraw = fresh;
  let drawToken = 0;
  const drawList = () => {
    const shown = orderedTracks(songs, st);
    shownSongs = shown.map((x) => x.group);
    const queue = shown.map((x) => x.track);
    const makeRow = ({ track, group }, n) => {
      const row = trackRow(track, {
        index: n,
        numbered: true,
        draggable: true,   // перетаскивание — в другой плейлист в медиатеке (а в своём плейлисте ещё и порядок)
        onPlay: () => { clearSelection(); play(track, queue.slice(), n, info.context); },
        onLike: toggleLike,
        onMenu: (anchor) => openTrackMenu(anchor, track, { ...(info.playlist ? { playlistId: info.playlist.id } : {}), members: group.members }),
        onRemove: info.kind === "disliked" ? toggleDislike : null,
        uploads: group.members,
        onUploads: (chip) => openUploadsMenu(chip, group.members, track),
        cols,
      });
      row.classList.toggle("selected", st.selected.has(keyOf(track)));
      row.addEventListener("mouseenter", () => prefetch(track));   // пока ведут курсор — готовим трек
      return row;
    };
    const token = ++drawToken;
    const first = firstDraw ? Math.min(shown.length, 120) : shown.length;
    firstDraw = false;
    list.replaceChildren(...shown.slice(0, first).map((x, n) => makeRow(x, n)));
    let at = first;
    const rest = () => {
      if (token !== drawToken || !list.isConnected) return;   // список уже перерисовали или ушли с экрана
      const part = shown.slice(at, at + 400);
      list.append(...part.map((x, i) => makeRow(x, at + i)));
      at += part.length;
      fillPlays(list, info.tracks);
      markCurrentRows(state.current ? keyOf(state.current) : null);
      if (at < shown.length) setTimeout(rest, 0);
    };
    if (at < shown.length) setTimeout(rest, 0);
    // Свой порядок меняется перетаскиванием, только когда список показан как есть (без сортировки и поиска)
    list.classList.toggle("sortable", !!info.playlist && st.sort === "own" && !st.query);
    empty.hidden = shown.length > 0;
    fillPlays(list, info.tracks);
    markCurrentRows(state.current ? keyOf(state.current) : null);
    drawSelectBar();
  };
  ({ tools, drawSelectBar, clearSelection } = listTools(info, st, list, drawList, songs));
  if (info.playlist) enableDragSort(list, info.playlist.id, () => shownSongs);
  enableDragOut(list, info, st);
  drawList();
  // Прослушивания на YouTube/SoundCloud — подгружаем в фоне и вписываем в колонку
  if (info.tracks.length) loadPlays(info.tracks.slice(0, 300)).then(() => { if (list.isConnected) fillPlays(list, info.tracks); });

  if (live) {
    viewList.replaceChildren(liveList(info, { songs, songList, coverBox, name, tools, list, empty, cols }));
  } else {
    // Верх — цветная «шапка» с обложкой и кнопками, ниже — карточка со списком треков
    const hero = el("div", "pl-hero");
    hero.append(header, actions);
    setHeroColor(hero, info);

    const body = el("div", "pl-body");
    if (info.tracks.length) {
      const card = el("div", "tracklist-card");
      card.append(listHead(info), list, empty);
      body.append(tools, card);
      // Свой плейлист — под ним «Рекомендуемые» в его духе (recs.js)
      if (info.playlist) body.append(recsSection(info.playlist));
    } else {
      body.append(el("p", "pl-empty", info.empty));
    }
    viewList.replaceChildren(hero, body);
  }

  markCurrentRows(state.current ? keyOf(state.current) : null);
  syncPlayButtons();
  scroller.scrollTop = keepScroll;
}

// ---------- Экран плейлиста на ПК («Живая обложка», макет B-ekrany.html#playlist) ----------
// Слева — стеклянная карточка: обложка, название, «Играть»/«Вперемешку», кнопки с подписями, «Скачивать новые»,
// строка проверки медиатеки. Справа — поиск/сортировка, список с колонками, «Рекомендуемые»

function liveList(info, { songs, songList, coverBox, name, tools, list, empty, cols }) {
  const count = songs.length;
  // «Ваш плейлист · 8 треков · 21 мин · обновлён вчера»
  const meta = document.createDocumentFragment();
  if (info.kind === "playlist") meta.append(el("b", "", "Ваш плейлист"), " · ");
  meta.append(count ? `${plural(count, "трек", "трека", "треков")} · ${formatTotal(songList)}` : "Пусто");
  const updated = Math.max(0, ...info.tracks.map((t) => t.added || 0));
  if (updated && (info.kind === "playlist" || info.kind === "liked")) {
    meta.append(` · ${info.kind === "liked" ? "обновлено" : "обновлён"} ${agoText(updated)}`);
  }

  const acts = [], minis = [], extra = [];
  if (info.kind !== "disliked" && info.tracks.length) {
    const playBtn = playPill(view, () => (playingFrom(view) ? togglePlay() : playCollection(info)));
    playBtn.addEventListener("mouseenter", () => prefetchCollection(info));
    const shuffle = bigPill("Вперемешку", icons.shuffle, () => playCollection(info, true));
    shuffle.disabled = count < 2;
    acts.push(playBtn, shuffle);
    // Flow по списку: его исполнители и похожие на них — остальная медиатека не влияет
    if (info.kind !== "local") {
      const flow = miniBtn("Flow", icons.flow, () => startFlow({ playlist: { id: info.playlist?.id ?? info.kind, name: info.name, tracks: info.tracks } }));
      flow.title = `Бесконечный поток в духе «${info.name}»`;
      minis.push(flow);
    }
    if (info.kind !== "local" && info.kind !== "downloads") {
      const dl = miniBtn("Скачать", icons.download, () => onDownloadClick(info), "pl-download");
      dl.dataset.collection = view;
      syncDownloadControl(dl, info.tracks);
      minis.push(dl);
    }
    if (info.kind === "pick") {   // подборка меняется сама — понравилась, можно оставить себе
      const keep = miniBtn("В медиатеку", icons.plus, () => keepPick(info));
      keep.title = "Подборка обновится — а копия останется у вас";
      minis.push(keep);
    } else if (info.kind === "playlist" || info.kind === "liked") {
      minis.push(miniBtn("Поделиться", icons.share, () => sharePlaylist({ name: info.name, tracks: songList })));
    }
  }
  // «Ещё»: у своего плейлиста — его меню (переименовать, обложка, папка, удалить…), у остальных — что есть
  const smart = info.kind !== "pick" && info.kind !== "disliked" && info.tracks.length ? [{
    label: "Умное перемешивание", icon: icons.smartShuffle,
    action: () => smartShuffle({ name: info.name, tracks: songList, context: info.context }),
  }] : [];
  if (info.playlist) {
    minis.push(miniBtn("Ещё", icons.more, (anchor) => openPlaylistMenu(anchor, info.playlist, {
      onPlay: () => playCollection(info),
      onDeleted: () => showView("home"),
      onAutoDownload: () => toggleAutoDownload(info),
      extra: smart,
    })));
  } else if (smart.length) {
    const auto = autoListId(info);
    minis.push(miniBtn("Ещё", icons.more, (anchor) => openMenu(anchor, [
      ...smart,
      ...(auto ? [{ label: isAutoDownload(auto) ? "Не скачивать новые треки" : "Скачивать новые треки",
        icon: isAutoDownload(auto) ? icons.downloaded : icons.download, action: () => toggleAutoDownload(info) }] : []),
    ])));
  }
  if (autoListId(info) && info.tracks.length) extra.push(autoControl(info));

  const card = plCard({ cover: coverBox, kind: info.label, name, meta, desc: info.desc, acts, minis, extra,
    status: libStatus(info, songs) });

  if (!info.tracks.length) return plLayout(card, el("p", "pl-empty", info.empty));
  // Над списком: поиск и сортировка (listTools) и «Добавить треки» у своего плейлиста
  if (info.playlist) {
    const add = el("button", "chip pl-add");
    add.type = "button";
    add.innerHTML = `${icons.plus}<span>Добавить треки</span>`;
    add.addEventListener("click", () => {
      document.getElementById("query")?.focus();
      toast("Найдите трек и нажмите «⋯» → «Добавить в плейлист» — или «Добавить» в «Рекомендуемых» ниже");
    });
    tools.append(el("span", "sp"), add);
  }
  const removable = info.kind === "disliked";
  const tl = el("div", `tracklist-card glass ${colsClass(cols, removable)}`);
  tl.append(liveHead(cols, { removable }), list, empty);
  return plLayout(card, tools, tl, info.playlist ? recsSection(info.playlist) : null);
}

/** Строка проверки медиатеки внизу карточки: «Все 8 треков открываются · проверено сегодня» */
function libStatus(info, songs) {
  if (!MERGED_KINDS.has(info.kind) || !songs.length) return null;
  const broken = songs.filter((g) => g.members.every((t) => isBroken(t))).length;
  if (broken) {
    return statusLine(`${plural(broken, "трек не открывается", "трека не открываются", "треков не открываются")} · подробнее`,
      "bad", showLibCheckReport);
  }
  const at = getSetting("libCheckAt", 0);
  if (!at) return null;   // ещё не проверяли — нечего обещать
  const fresh = songs.some((g) => g.members.some((t) => (t.added || 0) > at));
  const all = songs.length === 1 ? "Трек открывается" : `Все ${plural(songs.length, "трек", "трека", "треков")} открываются`;
  return statusLine(fresh ? `Проверено ${agoText(at)} · новые треки проверю позже` : `${all} · проверено ${agoText(at)}`, "ok");
}

/** «Собрано для вас» → копия в медиатеке */
function keepPick(info) {
  const date = new Date(info.pick.at).toLocaleDateString("ru", { day: "numeric", month: "long" });
  const p = createPlaylistFrom(`${info.name} · ${date}`, info.tracks);
  toast(`Плейлист «${p.name}» — в медиатеке`);
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

/** Песни в нужном порядке и с поиском: [{ track, group, i }], i — место (первой загрузки) в самом списке */
function orderedTracks(songs, st) {
  let items = songs.map((group) => ({ track: group.track, group, i: group.indices[0], shown: displayTrack(group.track) }));
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
function listTools(info, st, list, drawList, songs) {
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

  // Выбор хранит ключ строки — той загрузки, что показана; для очереди и «В плейлист» берём её,
  // а удаление убирает все загрузки песни
  const selectedSongs = () => songs.filter((g) => st.selected.has(keyOf(g.track)));
  const selectedTracks = () => selectedSongs().map((g) => g.track);
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
    // «Снять выбор» — только крестиком (с «В очередь» надписи не помещались в строку на 1100 px)
    const unselect = btn("Снять выбор", icons.close, clearSelection, "sel-close");
    unselect.title = "Снять выбор (Esc)";
    unselect.setAttribute("aria-label", "Снять выбор");
    bar.replaceChildren(el("span", "select-count", `Выбрано: ${n}`),
      btn("Играть следующими", icons.playNext, () => {
        selectedTracks().reverse().forEach((t) => queueNext(t));
        toast(`${plural(n, "трек", "трека", "треков")} — играют следующими`);
        clearSelection();
      }),
      btn("В очередь", icons.queue, () => {
        queueLater(selectedTracks());
        toast(`${plural(n, "трек", "трека", "треков")} — в очереди`);
        clearSelection();
      }),
      btn("В плейлист", icons.plus, (e) => openMenu(e.currentTarget, addToPlaylistItems(selectedTracks()))),
      ...(info.playlist ? [btn("Удалить", icons.trash, () => {
        const picked = selectedSongs();
        st.selected.clear();
        removeTracksWithUndo(info.playlist.id, picked.flatMap((g) => g.members), picked.length);
      }, "danger-text")] : []),
      unselect);
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
    addManyToPlaylist(playlist, tracks);   // та же песня другой загрузкой — только по «Всё равно добавить»
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

// Перетаскивание треков внутри плейлиста. Строка — песня (у неё может быть несколько загрузок): двигается
// целиком, все её загрузки встают подряд на новое место. songsNow() — песни в порядке строк
function enableDragSort(list, playlistId, songsNow) {
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
    const target = rows().indexOf(row), after = row.classList.contains("drop-after");
    clearMarks();
    const songs = songsNow(), moved = songs[from], onto = songs[target];
    from = -1;
    if (!moved || !onto || moved === onto) return;
    moveSongInPlaylist(playlistId, moved.members.map(keyOf), onto.members.map(keyOf), after);
  });
  list.addEventListener("dragend", () => { from = -1; clearMarks(); });
}

/** Большая кнопка в шапке плейлиста показывает паузу, если играет именно этот плейлист */
export function syncPlayButtons() {
  document.querySelectorAll("[data-collection]").forEach((btn) => {
    btn.classList.toggle("is-playing", playingFrom(btn.dataset.collection) && isPlaying());
  });
  syncFlowCards();
}

// ---------- Подключение ----------

/** Медиатека изменилась — перерисовать то, что от неё зависит */
export function refreshViews(section) {
  if (section === "settings") {
    // Папки, сортировка, подписки и выключатель лежат в настройках — перерисовать медиатеку, только если они менялись
    if (sidebarSignature() !== lastSidebarSig) renderSidebar();
    // Выбрали другую загрузку песни («Загрузки трека») — строка показывает и включает её
    const picks = getSetting("uploadPick", null);
    if (picks !== lastUploadPick) {
      lastUploadPick = picks;
      if (isListView()) renderList(false);
    }
    return;
  }
  if (view === "home") renderHome();   // главная показывает и историю, и плейлисты
  if (section === "history") return;
  renderSidebar();
  if (view === "now") renderUpNext();
  else if (view === "flow") renderFlowView();   // плейлисты в «Flow по плейлисту»
  else if (FIXED_VIEWS.includes(view) || isMetaView(view)) return;
  else renderList(false);
}

let lastUploadPick = null;
const isListView = () => !!view && !FIXED_VIEWS.includes(view) && !isMetaView(view);

/** Сменился трек (или очередь) — подсветить его в списках и в медиатеке, обновить «Далее» */
export function refreshPlaying() {
  if (view === "now") renderUpNext();
  lookTrackChanged();   // очередь на «Сейчас играет» (справа/снизу) и образцы в панели «Вид»
  // Карточка «Сейчас играет» на «Главной»: трек сменился — обложка, название и «Далее» меняются на глазах
  if (view === "home" && liveUi()) {
    if (state.current && nowCardEl?.isConnected) updateNowCard(true);
    else renderHome();
  }
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
  lastUploadPick = getSetting("uploadPick", null);
  // Проверка медиатеки нашла неоткрывающиеся загрузки — у песни с двумя загрузками строка выберет рабочую
  onBrokenTracks(() => { if (isListView()) renderList(false); });
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
  navReleases.addEventListener("click", () => showView("releases"));
  navStats.addEventListener("click", () => showView("stats"));
  navWorkshop.addEventListener("click", () => showView("workshop"));
  // «Вид» в верхней полосе — панель справа (look.js → initLook); на телефоне кнопки нет
  // Микрофон в капсуле: не на «Сейчас играет» — открыть её с текстом (а не просто переключить текст)
  document.querySelector(".minibar .mini-right")?.addEventListener("click", (e) => {
    if (!e.target.closest('[data-np="lyrics"]') || view === "now") return;
    e.stopImmediatePropagation();
    openLyrics();
  }, true);
  // «+» в медиатеке: создать пустой плейлист или импортировать по ссылке
  const newBtn = document.getElementById("new-playlist");
  newBtn.addEventListener("click", () => openMenu(newBtn, [
    { label: "Новый плейлист", icon: icons.plus, action: async () => {
      const playlist = await createPlaylist();
      if (playlist) showView(`playlist:${playlist.id}`);
    } },
    ...(libToolsOn() ? [{ label: "Новая папка", icon: icons.folder, action: () => createFolder() }] : []),
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
