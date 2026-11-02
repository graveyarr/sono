// Строка поиска и выпадающая панель под ней (история поиска / результаты).

import { openTrackMenu, toggleLike } from "./actions.js";
import { sourceIcons } from "./icons.js";
import { tasteOf } from "./flow.js";
import { clearHistory, getSetting, isDisliked, keyOf, lib, removeFromHistory, setSetting } from "./library.js";
import { artistByName } from "./meta.js";
import { openView } from "./nav.js";
import { play, prefetch, state } from "./player.js";
import { SOURCE_NAMES, el, imgUrl, isOverlay, markCurrentRows, trackRow } from "./ui.js";

const searchBox = document.getElementById("search");
const searchBar = document.getElementById("search-form");
const queryInput = document.getElementById("query");
const sourceBtn = document.getElementById("source-btn");
const panel = document.getElementById("panel");
const panelTitle = document.getElementById("panel-title");
const panelAction = document.getElementById("panel-action");
const panelMessage = document.getElementById("panel-message");
const rowsEl = document.getElementById("rows");
// Над результатами: карточка исполнителя, если запрос — это его имя
const artistEl = el("div", "panel-artist");
artistEl.hidden = true;
rowsEl.before(artistEl);

let source = "youtube";
let results = [];          // последние результаты поиска
let panelMode = "history"; // что сейчас в панели: history | results | loading
let activeRow = -1;        // строка, выбранная стрелками на клавиатуре
let searchToken = 0;       // чтобы ответ старого поиска не затёр новый

// ---------- Источник поиска ----------

function renderSource(animate = false) {
  sourceBtn.innerHTML = `<span>${sourceIcons[source]}</span>`;
  sourceBtn.title = `Ищем на ${SOURCE_NAMES[source]}. Нажми, чтобы сменить`;
  sourceBtn.setAttribute("aria-label", sourceBtn.title);
  if (animate) sourceBtn.firstElementChild.classList.add("flip");
}

// ---------- Панель ----------

export function openPanel() { panel.classList.add("open"); }
export function closePanel() { panel.classList.remove("open"); setActiveRow(-1); }

const rowsList = () => (panelMode === "history" ? lib.history : results);

function makeRow(track, i) {
  const fromHistory = panelMode === "history";
  const row = trackRow(track, {
    index: i,
    showSource: fromHistory,
    onPlay: () => pick(i),
    onLike: toggleLike,
    onMenu: (anchor) => openTrackMenu(anchor, track, { history: fromHistory }),
    onRemove: fromHistory ? removeFromHistory : null,
  });
  row.setAttribute("role", "option");
  if (track.taste && !fromHistory) {
    row.classList.add("taste");
    row.title = "Этого исполнителя вы слушаете — трек поднят выше";
  }
  // Наведение мышью только подсвечивает строку (через :hover) и готовит трек.
  // Выбором для Enter оно НЕ считается — иначе Enter включал бы трек под курсором вместо поиска.
  row.addEventListener("mouseenter", () => prefetch(track));
  return row;
}

function renderRows() {
  rowsEl.replaceChildren(...rowsList().map(makeRow));
  markCurrentRows(state.current ? keyOf(state.current) : null);
  setActiveRow(-1);
}

function showArtist(artist) {
  artistEl.hidden = !artist;
  if (!artist) return artistEl.replaceChildren();
  const card = el("button", "panel-artist-card");
  card.type = "button";
  const photo = el("span", "panel-artist-photo");
  if (artist.picture) {
    const img = el("img");
    img.alt = "";
    img.src = imgUrl(artist.picture);
    img.onerror = () => img.remove();
    photo.append(img);
  }
  const text = el("span", "panel-artist-text");
  text.append(el("span", "panel-artist-name", artist.name), el("span", "panel-artist-kind", "Исполнитель · открыть страницу"));
  card.append(photo, text);
  card.addEventListener("click", () => {
    closePanel();
    queryInput.blur();
    openView(`artist:${artist.id}`);
  });
  artistEl.replaceChildren(card);
}

export function showHistory() {
  showArtist(null);
  panelMode = "history";
  panelTitle.textContent = "История поиска";
  panelAction.hidden = lib.history.length === 0;
  panelMessage.classList.remove("error");
  panelMessage.textContent = lib.history.length ? "" : "Здесь появятся треки, которые ты включал";
  renderRows();
}

function showResults(src) {
  panelMode = "results";
  panelTitle.textContent = `Результаты · ${SOURCE_NAMES[src]}`;
  panelAction.hidden = true;
  panelMessage.classList.remove("error");
  panelMessage.textContent = results.length ? "" : "Ничего не нашлось. Попробуй по-другому или на другом сайте";
  renderRows();
}

function showLoading(src) {
  panelMode = "loading";
  panelTitle.textContent = `Ищу на ${SOURCE_NAMES[src]}…`;
  panelAction.hidden = true;
  const skeleton = () => {
    const li = el("li", "track compact skeleton");
    li.innerHTML = `<div class="thumb"></div><div class="t-meta"><div class="line"></div><div class="line"></div></div>`;
    return li;
  };
  rowsEl.replaceChildren(...Array.from({ length: 5 }, skeleton));
  panelMessage.textContent = "";
  setActiveRow(-1);
}

function showSearchError(text) {
  panelMode = "results";
  results = [];
  rowsEl.replaceChildren();
  panelMessage.textContent = text;
  panelMessage.classList.add("error");
}

/** История изменилась (включили трек, убрали из истории) — перерисовать, если она на экране */
export function refreshHistory() {
  if (panelMode === "history") showHistory();
}

function setActiveRow(i, scroll = true) {
  const rows = rowsEl.querySelectorAll(".track:not(.skeleton)");
  activeRow = rows.length ? Math.max(-1, Math.min(i, rows.length - 1)) : -1;
  rows.forEach((row, n) => row.classList.toggle("active", n === activeRow));
  if (scroll && activeRow >= 0) rows[activeRow].scrollIntoView({ block: "nearest" });
}

function pick(i) {
  const list = rowsList().slice();   // копия: история перестроится, когда трек в неё попадёт
  if (!list[i]) return;
  play(list[i], list, i, { type: panelMode === "history" ? "history" : "search" });
  closePanel();
  queryInput.blur();
}

// ---------- Поиск ----------

// Поиск идёт сам, пока печатают: через TYPE_PAUSE мс после последней буквы
const TYPE_PAUSE = 450;
let typeTimer = 0;
let lastSearch = "";   // «источник|запрос», который уже показан (или ищется) — второй раз не ищем
let searchAbort = null;

async function runSearch(q) {
  clearTimeout(typeTimer);
  const token = ++searchToken;
  const src = source;
  lastSearch = `${src}|${q.toLowerCase()}`;
  searchAbort?.abort();   // старый запрос больше не нужен
  searchAbort = new AbortController();
  // Уже есть результаты — не мигаем «скелетом», а лишь приглушаем их, пока ищется новое
  if (panelMode === "results" && results.length) {
    panelTitle.textContent = `Ищу на ${SOURCE_NAMES[src]}…`;
    panel.classList.add("busy");
  } else {
    showArtist(null);
    showLoading(src);
  }
  openPanel();
  // Параллельно: вдруг ищут исполнителя — тогда сверху покажем его страницу
  artistByName(q).then((a) => { if (token === searchToken && panelMode !== "history") showArtist(a); }).catch(() => {});
  try {
    const res = await fetch(`/api/search?source=${src}&q=${encodeURIComponent(q)}`, { signal: searchAbort.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "ошибка сервера");
    if (token !== searchToken) return;
    results = byTaste(data.results);
    panel.classList.remove("busy");
    showResults(src);
    // Готовим первые треки, только если человек перестал печатать (иначе это лишняя работа на каждую букву)
    setTimeout(() => {
      if (token === searchToken) (async () => { for (const t of results.slice(0, 3)) await prefetch(t); })();
    }, 1200);
  } catch (err) {
    if (token !== searchToken) return;
    panel.classList.remove("busy");
    lastSearch = "";
    showSearchError("Не получилось найти: " + err.message);
  }
}

/** Печатают — ищем, когда сделают паузу */
function scheduleSearch() {
  clearTimeout(typeTimer);
  const q = queryInput.value.trim();
  if (q.length < 2 || `${source}|${q.toLowerCase()}` === lastSearch) return;
  typeTimer = setTimeout(() => runSearch(q), TYPE_PAUSE);
}

/** Сначала — исполнители из вашего вкуса (избранное, история, статистика); остальное — как нашёл сайт.
    Сильно не перемешиваем: трек «по вкусу» поднимается на несколько мест, а не обязательно в самый верх */
function byTaste(list) {
  return list
    .map((track, i) => {
      const w = tasteOf(track);
      const boost = isDisliked(track) ? -20 : w > 0 ? 2 + Math.min(4, Math.log2(1 + w)) : w < 0 ? -4 : 0;
      if (w > 0) track = { ...track, taste: true };
      return { track, score: boost - i };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.track);
}

export function focusSearch() {
  queryInput.focus();
  queryInput.select();
}

export function initSearch() {
  source = SOURCE_NAMES[getSetting("source")] ? getSetting("source") : "youtube";
  renderSource();
  showHistory();

  sourceBtn.addEventListener("click", () => {
    const names = Object.keys(SOURCE_NAMES);
    source = names[(names.indexOf(source) + 1) % names.length];
    setSetting("source", source);
    renderSource(true);
    const q = queryInput.value.trim();
    if (q.length >= 2) runSearch(q);   // есть запрос — сразу ищем то же самое на новом месте
    queryInput.focus();
  });

  searchBar.addEventListener("submit", (e) => {
    e.preventDefault();
    if (activeRow >= 0) return pick(activeRow);   // строка выбрана стрелками — включаем её
    const q = queryInput.value.trim();
    // Enter не обязателен (поиск идёт сам), но если нажали — ищем сразу, не дожидаясь паузы
    if (q && (`${source}|${q.toLowerCase()}` !== lastSearch || panelMode === "history")) runSearch(q);
  });

  queryInput.addEventListener("input", () => {
    const hasText = queryInput.value.length > 0;
    searchBar.classList.toggle("has-text", hasText);
    setActiveRow(-1);   // начали печатать — выбор стрелками сбрасывается, Enter снова значит «искать»
    if (!hasText) {
      searchToken++;   // поиск ещё идёт, а поле очистили — его ответ уже не нужен
      clearTimeout(typeTimer);
      searchAbort?.abort();
      lastSearch = "";
      results = [];
      panel.classList.remove("busy");
      showHistory();
    } else {
      scheduleSearch();
    }
    openPanel();
  });

  queryInput.addEventListener("focus", openPanel);

  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveRow(activeRow + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveRow(activeRow - 1); }
    else if (e.key === "Escape") { closePanel(); queryInput.blur(); }
  });

  document.getElementById("clear").addEventListener("click", () => {
    queryInput.value = "";
    queryInput.dispatchEvent(new Event("input"));
    queryInput.focus();
  });

  panelAction.addEventListener("click", () => {
    clearHistory();
    queryInput.focus();
  });

  // Клик мимо поиска закрывает панель (но не клик по меню «⋯» или диалогу, открытым из неё)
  document.addEventListener("pointerdown", (e) => {
    if (!searchBox.contains(e.target) && !isOverlay(e.target)) closePanel();
  });
}
