// Поиск на ПК («Живая обложка», макет design/ui-new/B-ekrany.html: #search и #search-res).
// Поле наверху пустое и в фокусе — выпадающая история: «Недавно искали» (запросы, ссылки, исполнители, альбомы,
// треки), «По вашему вкусу», подсказка про ссылки и клавиши. Начали печатать — открывается экран результатов
// (views.js, экран "search"): «Лучший результат», «Треки», «Альбомы и синглы», «Исполнители», «Плейлисты»;
// фильтры «Всё | Треки | …» и «Искать на: Везде | YouTube | SoundCloud».
// История — в настройках медиатеки (settings.searchHistory, на сервере), не в localStorage: у .exe каждый
// запуск новый порт. На телефоне — прежняя панель (search.js).

import { openTrackMenu, openUploadsMenu, toggleLike } from "./actions.js";
import { load, picture, releaseCard } from "./artist.js";
import { headRow, segment } from "./artistlive.js";
import { tasteArtists, tasteOf } from "./flow.js";
import { icons } from "./icons.js";
import { openImportDialog } from "./import.js";
import { getSetting, isDisliked, keyOf, lib, pickedUpload, setSetting, slim } from "./library.js";
import { describeLink, looksLikeLink } from "./links.js";
import { rise } from "./motion.js";
import { openArtist, openTrack, openView } from "./nav.js";
import { play, prefetch, state } from "./player.js";
import { colsClass } from "./plcard.js";
import { groupSongs } from "./samesong.js";
import { avatar } from "./stats.js";
import { compactNumber, coverUrl, displayTrack, el, imgUrl, isBroken, isOverlay, markCurrentRows, plural, trackRow } from "./ui.js";

const HISTORY_MAX = 30;    // сколько помним
const HISTORY_SHOWN = 6;   // сколько видно в выпадающем списке
const TYPE_PAUSE = 300;    // поиск — через столько мс после последней буквы
const WHERE = [["Везде", "all"], ["YouTube", "youtube"], ["SoundCloud", "soundcloud"]];
const FILTERS = [["Всё", "all"], ["Треки", "tracks"], ["Исполнители", "artists"], ["Альбомы", "albums"], ["Плейлисты", "playlists"]];
const CTX = { type: "search" };

let input, form, holder, drop, shade;
let page = null;       // секция экрана результатов (views.js отдаёт её в renderSearchView)
let view = "";         // какой экран открыт (событие sono:view)
let res = null;        // текущий поиск: { q, where, link, tracks, meta, artist, lyric, info, error, … }
let filter = "all";
let where = "all";
let token = 0, abort = null, typeTimer = 0;
let tracksToken = 0, tracksAbort = null;   // треки ищутся отдельно: «Искать на» перезапрашивает только их
let sel = -1;          // выбранная стрелками строка выпадающего списка
let active = -1;       // выбранный стрелками трек на экране результатов

const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const flat = (s) => norm(s).replace(/ /g, "");
const pickUpload = (members) => pickedUpload(members) ?? members.find((t) => !isBroken(t)) ?? members[0];
const dropOpen = () => drop?.classList.contains("open");

// ---------- История поиска ----------

const history = () => getSetting("searchHistory", []);
const histKey = (h) => `${h.k}:${h.k === "track" ? keyOf(h.t) : h.id ?? h.url ?? h.q}`;

/** Запомнить: запрос { k: "q", q }, ссылку { k: "link", q, sub }, исполнителя { k: "artist", id, name, pic },
    альбом { k: "album", id, name, sub, pic }, трек { k: "track", t }, плейлист { k: "playlist", id | url, name, sub, pic } */
function remember(h) {
  if (res) res.recorded = true;   // выбрали что-то из результатов — сам запрос отдельно не пишем
  const key = histKey(h);
  setSetting("searchHistory", [h, ...history().filter((x) => histKey(x) !== key)].slice(0, HISTORY_MAX));
}

function forget(h) {
  const key = histKey(h);
  setSetting("searchHistory", history().filter((x) => histKey(x) !== key));
}

/** Ссылка коротко: без https:// и www., длинная — с многоточием */
const shortUrl = (url) => {
  const s = url.replace(/^https?:\/\/(www\.)?/i, "");
  return s.length > 44 ? `${s.slice(0, 43)}…` : s;
};

/** «Ссылка · альбом Яндекс Музыки» — что это была за ссылка */
function linkSub(info) {
  const what = { track: "трек", album: "альбом", artist: "исполнитель" }[info.kind] ?? (info.what || "плейлист");
  const service = info.service === "Яндекс Музыка" ? "Яндекс Музыки" : info.service;
  return `Ссылка · ${what}${service ? ` ${service}` : ""}`;
}

// ---------- Выпадающий список: «Недавно искали», «По вашему вкусу» ----------

function histRow(h) {
  const row = el("div", `sq-row${h.k === "artist" ? " round" : ""}`);
  row.setAttribute("role", "option");
  let title = h.name || h.q || "", sub = h.sub || "";
  if (h.k === "track") {
    const shown = displayTrack(h.t);
    title = shown.title;
    sub = `Трек${shown.artist ? ` · ${shown.artist}` : ""}`;
  } else if (h.k === "artist") sub = "Исполнитель";
  else if (h.k === "link") title = shortUrl(h.q);
  const src = h.k === "track" ? coverUrl(h.t) : h.pic ? imgUrl(h.pic) : "";
  if (src) {
    const img = el("img");
    img.alt = "";
    img.src = src;
    img.onerror = () => img.replaceWith(Object.assign(el("span", "sq-ic"), { innerHTML: icons.note }));
    row.append(img);
  } else {
    const ic = el("span", "sq-ic");
    ic.innerHTML = h.k === "link" ? icons.link : h.k === "q" ? icons.clock : h.k === "artist" ? icons.artist : icons.note;
    row.append(ic);
  }
  const text = el("div", "sq-text");
  text.append(el("b", "", title));
  if (sub) text.append(el("span", "", sub));
  if (h.k === "link") text.title = h.q;
  const x = el("button", "sq-x");
  x.type = "button";
  x.innerHTML = icons.close;
  x.title = "Убрать из истории";
  x.addEventListener("click", (e) => { e.stopPropagation(); forget(h); renderDrop(); input.focus(); });
  row.append(text, x);
  row.addEventListener("click", () => useHistory(h));
  row._item = h;
  return row;
}

function tasteChip(a) {
  const chip = el("button", "sq-chip");
  chip.type = "button";
  const pic = el("span", "sq-chip-pic");
  pic.textContent = (a.name || "?").trim()[0]?.toUpperCase() ?? "";
  avatar(a, pic);   // фото исполнителя (по имени) — когда найдётся
  chip.append(pic, el("span", "", a.name));
  chip.title = `Открыть: ${a.name}`;
  if (a.id) chip.dataset.warm = `artist:${a.id}`;
  chip.addEventListener("click", () => {
    closeDrop();
    input.blur();
    if (a.id) openView(`artist:${a.id}`);
    else openArtist({ name: a.name });
  });
  return chip;
}

function renderDrop() {
  const list = history().slice(0, HISTORY_SHOWN);
  const taste = tasteArtists(5);
  const parts = [];
  const head = el("h5", "sq-h", "Недавно искали");
  if (list.length) {
    const clear = el("button", "sq-clear", "Очистить");
    clear.type = "button";
    clear.addEventListener("click", () => { setSetting("searchHistory", []); renderDrop(); input.focus(); });
    head.append(clear);
    parts.push(head, ...list.map(histRow));
  } else {
    parts.push(head, el("p", "sq-empty", "Здесь появятся ваши запросы, исполнители и треки, которые вы находили"));
  }
  if (taste.length) {
    const chips = el("div", "sq-chips");
    chips.append(...taste.map(tasteChip));
    parts.push(el("h5", "sq-h sq-h2", "По вашему вкусу"), chips);
  }
  const tip = el("div", "sq-tip");
  tip.innerHTML = `${icons.link}<span>Вставьте ссылку — Sono найдёт те же песни</span>`;
  const svc = el("span", "sq-svc");
  // VK музыку без входа не отдаёт (Sono объяснит, как перенести список) — поэтому в подсказке его нет
  for (const s of ["Яндекс", "Spotify", "Apple", "YouTube", "SoundCloud"]) svc.append(el("span", "", s));
  tip.append(svc);
  const keys = el("div", "sq-keys");
  keys.innerHTML = "<span><kbd>↑↓</kbd>выбрать</span><span><kbd>Enter</kbd>искать</span><span><kbd>Del</kbd>убрать из истории</span><span><kbd>Esc</kbd>закрыть</span>";
  drop.replaceChildren(...parts, tip, keys);
  fitChips();
  setSel(-1);
}

/** Чипы «По вашему вкусу» — в одну строку, как в макете: не влезшие в ширину списка не показываем */
function fitChips() {
  const chips = [...drop.querySelectorAll(".sq-chip")];
  if (!chips.length || !drop.offsetWidth) return;
  const top = chips[0].offsetTop;
  chips.forEach((c) => { if (c.offsetTop > top + 4) c.remove(); });
}

const dropItems = () => [...drop.querySelectorAll(".sq-row, .sq-chip")];

function setSel(i) {
  const items = dropItems();
  sel = items.length ? Math.max(-1, Math.min(i, items.length - 1)) : -1;
  items.forEach((n, k) => n.classList.toggle("sel", k === sel));
  if (sel >= 0) items[sel].scrollIntoView({ block: "nearest" });
}

function openDrop() {
  if (dropOpen()) return;
  drop.classList.add("open");
  renderDrop();
  placeShade();
  document.body.classList.add("sq-open");
}

function closeDrop() {
  drop?.classList.remove("open");
  document.body.classList.remove("sq-open");
  sel = -1;
}

/** Затемнение экрана под выпадающим списком (как в макете): ровно по основной части */
function placeShade() {
  const r = document.getElementById("views").getBoundingClientRect();
  Object.assign(shade.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}

function useHistory(h) {
  remember(h);   // поднять наверх
  if (h.k === "q" || h.k === "link") {
    input.value = h.q;
    syncField();
    closeDrop();
    runSearch(h.q);
    return;
  }
  closeDrop();
  input.blur();
  if (h.k === "artist") openView(`artist:${h.id}`);
  else if (h.k === "album") openView(`album:${h.id}`);
  else if (h.k === "track") play(h.t, [h.t], 0, CTX);
  else if (h.k === "playlist") {
    if (h.id && lib.playlists.some((p) => p.id === h.id)) openView(`playlist:${h.id}`);
    else if (h.url) openImportDialog({ url: h.url });
  }
}

// ---------- Поиск ----------

/** Сначала — исполнители из вашего вкуса (избранное, история, статистика); остальное — как нашёл сайт.
    Сильно не перемешиваем: трек «по вкусу» поднимается на несколько мест, а не обязательно в самый верх */
export function byTaste(list) {
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

/** Треки с одного или обоих сайтов: по очереди (1-й YouTube, 1-й SoundCloud, 2-й …), «по вкусу» выше,
    одна песня с двух сайтов — одна строка (samesong.js) */
async function fetchTracks(q, src, signal) {
  const one = async (s) => {
    const r = await fetch(`/api/search?source=${s}&q=${encodeURIComponent(q)}`, { signal });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "ошибка сервера");
    return d.results || [];
  };
  const sources = src === "all" ? ["youtube", "soundcloud"] : [src];
  const got = await Promise.allSettled(sources.map(one));
  if (signal.aborted) throw new DOMException("отменено", "AbortError");
  const lists = got.filter((g) => g.status === "fulfilled").map((g) => g.value);
  if (!lists.length) throw got[0].reason;
  const merged = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) for (const l of lists) if (l[i]) merged.push(l[i]);
  const failed = sources.filter((_, i) => got[i].status === "rejected").map((s) => (s === "youtube" ? "YouTube" : "SoundCloud"));
  return { groups: groupSongs(byTaste(merged), pickUpload), failed };
}

/** Найти. record — запомнить запрос в истории (нажали Enter) */
async function runSearch(q, { record = false } = {}) {
  clearTimeout(typeTimer);
  q = q.trim();
  if (!q) return;
  const link = looksLikeLink(q);
  if (record && !link) remember({ k: "q", q });
  if (res && res.q === q && !res.error && res.where === where) {   // это уже на экране — только показать
    goToPage();
    return;
  }
  const my = ++token;
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const alive = () => my === token;
  const prev = res && (res.tracks || res.meta || res.info) ? res : res?.stale ?? null;
  res = { q, where, link, tracks: null, meta: null, artist: null, lyric: null, info: null, error: null,
          stale: prev, fresh: true, at: Date.now(), recorded: false };
  active = -1;
  goToPage();
  paint();

  if (link) {   // ссылка из любого сервиса: трек — строкой, альбом/исполнитель/плейлист — карточкой
    try {
      const info = await describeLink(q, signal);
      if (!alive()) return;
      if (info.kind === "search") {   // исполнитель есть, но в базе не уверены, что это он, — ищем по имени
        input.value = info.query;
        syncField();
        return runSearch(info.query);
      }
      res.info = info;
      res.stale = null;
      remember({ k: "link", q, sub: linkSub(info) });
      if (info.kind === "artist") loadArtist(info, alive);
      if (info.kind === "album") {
        const r = res;
        load(`/api/album/${info.albumId}`).then((al) => { if (alive()) { r.album = al; paint(); } }).catch(() => {});
      }
    } catch (err) {
      if (!alive() || err.name === "AbortError") return;
      res.error = err.message.replace(/^./, (c) => c.toUpperCase());
      res.stale = null;
    }
    paint();
    return;
  }

  loadTracks(res);

  fetch(`/api/search/all?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.json()).then((meta) => {
    if (!alive()) return;
    res.meta = meta;
    if (meta.best?.kind === "artist") loadArtist(meta.best, alive);
    paint();
  }).catch(() => { if (alive()) { res.meta = { best: null, artists: [], albums: [], playlists: [] }; paint(); } });

  // …или вспомнили строчку из песни (от трёх слов) — поиск по тексту (Яндекс Музыка + LRCLIB)
  if (q.split(/\s+/).length >= 3) {
    fetch(`/api/search/lyrics?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.json()).then((d) => {
      if (!alive() || !d.tracks?.length) return;
      res.lyric = d.tracks[0];
      paint();
    }).catch(() => {});
  }
}

/** Треки текущего поиска (r) — с того сайта, что выбран в «Искать на» */
function loadTracks(r) {
  const my = ++tracksToken;
  tracksAbort?.abort();
  tracksAbort = new AbortController();
  const alive = () => my === tracksToken && res === r;
  fetchTracks(r.q, r.where, tracksAbort.signal).then((t) => {
    if (!alive()) return;
    r.tracks = t;
    r.stale = null;
    paint();
    // Готовим первые треки, только если человек перестал печатать (иначе это лишняя работа на каждую букву)
    setTimeout(() => { if (alive()) (async () => { for (const g of t.groups.slice(0, 3)) await prefetch(g.track); })(); }, 1200);
  }).catch((err) => {
    if (!alive() || err.name === "AbortError") return;
    r.tracks = { groups: [], failed: [], error: "Не получилось найти: " + err.message };
    r.stale = null;
    paint();
  });
}

/** Страница исполнителя (тот же кэш, что у artist.js): альбомы, похожие, слушатели — и откроется мгновенно */
function loadArtist(a, alive) {
  const r = res;
  load(`/api/artist/${a.id}`).then((data) => {
    if (!alive()) return;
    r.artist = data;
    paint();
    if (String(a.id).startsWith("sc:")) return;
    // Альбомы с SoundCloud, которых нет в Яндексе, — как на странице исполнителя (новые сверху)
    load(`/api/artist/${a.id}/soundcloud`).then((sc) => {
      if (!alive() || !sc.releases?.length) return;
      r.scReleases = sc.releases;
      paint();
    }).catch(() => {});
  }).catch(() => {});
}

function goToPage() {
  if (view !== "search") openView("search");
}

/** Поле: крестик и подсказка «Ctrl K» */
function syncField() {
  form.classList.toggle("has-text", input.value.length > 0);
}

function scheduleSearch() {
  clearTimeout(typeTimer);
  const q = input.value.trim();
  if (q.length < 2 && !looksLikeLink(q)) return;
  if (res && res.q === q && res.where === where && view === "search") return;
  typeTimer = setTimeout(() => runSearch(q), TYPE_PAUSE);
}

// ---------- Экран результатов ----------

/** views.js: открыт экран «search» (или его надо перерисовать) */
export function renderSearchView(box) {
  page = box;
  view = "search";
  if (res && input && !input.value) { input.value = res.q; syncField(); }
  paint({ enter: true });
}

function paint({ enter = false } = {}) {
  if (!page || view !== "search") return;
  const d = res && !res.tracks && !res.info && !res.error && res.stale ? res.stale : res;
  const root = el("div", "sr-live");
  if (!d) {
    root.append(el("p", "sr-empty-start", "Что включим? Начните печатать — исполнитель, трек, строчку из песни или ссылку"));
    page.replaceChildren(root);
    return;
  }
  // Новый поиск, а прежние результаты ещё на экране — они приглушены, пока не придут новые треки
  root.classList.toggle("busy", d !== res);
  if (d.link) linkPage(root, d);
  else resultsPage(root, d);
  // Новые результаты появились впервые — куски выплывают по очереди (при входе на экран это делает переход)
  const animate = !enter && d === res && res.fresh && !!(d.tracks || d.meta || d.info || d.error);
  if (animate) res.fresh = false;
  page.replaceChildren(root);
  markCurrentRows(state.current ? keyOf(state.current) : null);
  if (animate) [...root.children].slice(0, 6).forEach((n, i) => rise(n, 40 + i * 50, 12, 500));
}

function filtersRow(d) {
  const row = el("div", "sr-filters");
  const kinds = segment(FILTERS, filter, (v) => { filter = v; paint(); document.getElementById("views").scrollTop = 0; });
  const label = el("span", "sr-where-label", "Искать на");
  const sites = segment(WHERE, where, (v) => {
    where = v;
    setSetting("searchWhere", v);
    if (!res || res.link) return;
    // Искать заново только треки: исполнители, альбомы и плейлисты от сайта не зависят
    if (res.stale) Object.assign(res, { meta: res.meta ?? res.stale.meta, artist: res.artist ?? res.stale.artist, stale: null });
    res.where = v;
    res.tracks = null;
    paint();
    loadTracks(res);
  });
  row.append(kinds, el("span", "sr-sp"), label, sites);
  return row;
}

function resultsPage(root, d) {
  root.append(filtersRow(d));
  const groups = d.tracks?.groups ?? [];
  const albums = albumList(d), artists = artistList(d), lists = playlistList(d);
  const best = bestCard(d);
  const nothing = d.tracks && d.meta && !groups.length && !best && !albums.length && !artists.length && !lists.length;
  if (nothing) {
    root.append(emptyBox(d.tracks.error || `По запросу «${d.q}» ничего не нашлось`,
      d.tracks.error ? "Проверьте интернет или попробуйте ещё раз через минуту"
        : where === "all" ? "Проверьте, нет ли опечатки, или напишите по-другому — например, только имя исполнителя"
          : "Проверьте, нет ли опечатки, или поищите везде — на YouTube и SoundCloud сразу"));
    return;
  }
  if (d.tracks?.failed?.length) root.append(el("p", "sr-note", `${d.tracks.failed.join(" и ")} не ответил — показано то, что нашлось на другом сайте`));

  if (filter === "all") {
    const top = el("div", "sr-top");
    const right = el("section", "sr-tracks-col");
    const more = groups.length > 5 ? linkButton("Все треки", () => setFilter("tracks")) : null;
    right.append(headRow("Треки", more), tracksBox(d, 5));
    if (best || !d.meta || !d.tracks) {
      const left = el("section", "sr-best-col");
      left.append(headRow("Лучший результат"), best ?? skeletonBest(true));
      top.append(left);
    } else top.classList.add("single");
    top.append(right);
    root.append(top);
    if (albums.length) root.append(rowSection("Альбомы и синглы", albums.map((r) => albumCard(r)), albums.length, "albums"));
    if (artists.length) root.append(rowSection("Исполнители", artists.map(artistCard), artists.length, "artists"));
    if (lists.length) root.append(rowSection("Плейлисты", lists.map(playlistCard), lists.length, "playlists"));
    if (!d.meta) root.append(skeletonRow());
    return;
  }
  if (filter === "tracks") { root.append(tracksBox(d, 50)); return; }
  const what = { artists: [artists, artistCard, "Исполнителей"], albums: [albums, albumCard, "Альбомов"], playlists: [lists, playlistCard, "Плейлистов"] }[filter];
  if (!d.meta) { root.append(skeletonRow()); return; }
  if (!what[0].length) { root.append(emptyBox(`${what[2]} по запросу «${d.q}» не нашлось`, "Посмотрите во «Всё» — там треки")); return; }
  const grid = el("div", "pl-more-row all sr-grid");
  grid.append(...what[0].map((x) => what[1](x)));
  root.append(grid);
}

function setFilter(v) {
  filter = v;
  paint();
  document.getElementById("views").scrollTop = 0;
}

function linkButton(text, onClick) {
  const b = el("button", "meta-more sr-all", text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function rowSection(title, cards, count, kind) {
  const row = el("div", "pl-more-row");
  row.append(...cards);
  const sec = el("section", "meta-section");
  sec.append(headRow(title, count > 5 ? linkButton(`Все ${count}`, () => setFilter(kind)) : null), row);
  return sec;
}

function emptyBox(title, text) {
  const box = el("div", "sr-empty glass");
  const ic = el("span", "sr-empty-ic");
  ic.innerHTML = icons.search;
  box.append(ic, el("b", "", title), el("span", "", text));
  return box;
}

function skeletonBest(loading) {
  return el("div", `sr-best glass sr-skel${loading ? "" : " none"}`);
}

function skeletonRow() {
  const row = el("div", "sr-skel-row");
  for (let i = 0; i < 5; i++) row.append(el("span", "sr-skel"));
  return row;
}

// ---------- Треки ----------

function tracksBox(d, limit, ctx = CTX) {
  const card = el("div", `tracklist-card glass sr-tracks ${colsClass({ album: false, added: false })}`);
  if (!d.tracks) {
    for (let i = 0; i < Math.min(limit, 5); i++) card.append(el("div", "sr-skel-track"));
    return card;
  }
  const groups = d.tracks.groups;
  if (!groups.length) {
    card.classList.add("empty");
    card.append(el("p", "sr-none", d.tracks.error || (where === "all" ? "Треков не нашлось" : `На ${where === "youtube" ? "YouTube" : "SoundCloud"} треков не нашлось — попробуйте «Везде»`)));
    return card;
  }
  const tracks = groups.map((g) => g.track);
  const list = el("ol", "tracklist");
  groups.slice(0, limit).forEach((g, i) => {
    const track = g.track;
    const row = trackRow(track, {
      index: i, numbered: true, cols: { album: false, added: false },
      uploads: g.members,
      onUploads: (chip) => openUploadsMenu(chip, g.members, track),
      onPlay: () => {
        remember({ k: "track", t: slim(track) });
        play(track, tracks.slice(), i, ctx);
      },
      onLike: toggleLike,
      onMenu: (anchor) => openTrackMenu(anchor, track, g.members.length > 1 ? { members: g.members } : {}),
    });
    if (track.taste && !aboutQuery(track, d.q)) {   // ищут самого исполнителя — пометка у каждого трека ни к чему
      row.classList.add("taste");
      row.title = "Этого исполнителя вы слушаете — трек поднят выше";
    }
    const plays = row.querySelector(".t-plays");
    if (plays && track.plays != null) {
      plays.textContent = compactNumber(track.plays);
      plays.title = `${track.plays.toLocaleString("ru")} ${track.source === "youtube" ? "просмотров на YouTube" : "прослушиваний на SoundCloud"}`;
    }
    row.addEventListener("mouseenter", () => prefetch(track));
    list.append(row);
  });
  card.append(list);
  return card;
}

/** Трек того, кого ищут (исполнитель или канал похож на запрос) */
function aboutQuery(track, q, orTitle = false) {
  const want = flat(q);
  if ([displayTrack(track).artist, track.channel].some((n) => { const who = flat(n); return who.length >= 2 && (who.includes(want) || want.includes(who)); })) return true;
  if (!orTitle) return false;
  // …или в названии есть слово из запроса (от трёх букв)
  const title = ` ${norm(displayTrack(track).title)} `;
  return norm(q).split(" ").some((w) => w.length >= 3 && title.includes(` ${w} `));
}

/** Стрелки на экране результатов: выбрать трек, Enter — включить */
function setActive(i) {
  const rows = page ? [...page.querySelectorAll(".sr-tracks .track")] : [];
  active = rows.length ? Math.max(-1, Math.min(i, rows.length - 1)) : -1;
  rows.forEach((r, n) => r.classList.toggle("active", n === active));
  if (active >= 0) rows[active].scrollIntoView({ block: "nearest" });
}

// ---------- «Лучший результат» ----------

const big = (url) => (url ? imgUrl(url) : "");
const wordFor = (n, one, few, many) => (n >= 1e4 ? many : plural(n, one, few, many).replace(/^\S+\s/, ""));

function bestCard(d) {
  if (d.lyric?.lyricLine) return lyricBest(d.lyric);
  const b = d.meta?.best;
  if (b?.kind === "artist") return artistBest(d, b);
  if (b?.kind === "album") {
    return bestBox({ src: big(b.coverLarge || b.cover), name: b.title, sub: ["Альбом", b.artist, b.year].filter(Boolean).join(" · "),
      warm: `album:${b.id}`,
      open: () => { remember({ k: "album", id: b.id, name: b.title, sub: `Альбом${b.artist ? ` · ${b.artist}` : ""}`, pic: b.cover }); openView(`album:${b.id}`); },
      play: () => playAlbum(b) });
  }
  if (b?.kind === "track") return trackBest(b.track, "Трек");
  if (b?.kind === "playlist") {
    return bestBox({ src: big(b.cover), name: b.name, sub: ["Плейлист", b.owner, b.count && plural(b.count, "трек", "трека", "треков")].filter(Boolean).join(" · "),
      open: () => openPlaylist(b) });
  }
  if (d.lyric) return lyricBest(d.lyric);
  const first = d.tracks?.groups?.[0]?.track;
  return first && aboutQuery(first, d.q, true) ? trackBest(first, "Трек", d.tracks.groups.map((g) => g.track)) : null;
}

function bestBox({ src, name, sub, round = false, warm = "", open, play: onPlay = null, extra = null }) {
  const card = el("div", `sr-best glass${round ? " round" : ""}`);
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  const art = picture(null, "sr-best-art", name);
  if (src) {   // пока грузится — цветная заглушка; не загрузилась — так и остаётся
    const img = el("img");
    img.alt = "";
    img.src = src;
    img.onload = () => { art.classList.remove("no-image"); art.removeAttribute("style"); art.replaceChildren(img); };
  }
  const text = el("div", "sr-best-text");
  text.append(el("b", "sr-best-name", name));
  if (extra) text.append(extra);
  text.append(el("span", "sr-best-sub", sub));
  card.append(art, text);
  card.title = name;
  if (warm) card.dataset.warm = warm;
  if (onPlay) {
    const btn = el("button", "sr-best-play");
    btn.type = "button";
    btn.innerHTML = icons.play;
    btn.title = "Слушать";
    btn.addEventListener("click", (e) => { e.stopPropagation(); onPlay(); });
    card.append(btn);
  }
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return card;
}

function artistBest(d, b) {
  const a = d.artist && String(d.artist.id) === String(b.id) ? d.artist : null;
  const fromSc = String(b.id).startsWith("sc:");
  const sub = ["Исполнитель"];
  if (a?.listeners) sub.push(`${compactNumber(a.listeners)} ${wordFor(a.listeners, "слушатель", "слушателя", "слушателей")}`);
  else if ((a?.followers ?? b.followers) > 0) { const n = a?.followers ?? b.followers; sub.push(`${compactNumber(n)} ${wordFor(n, "подписчик", "подписчика", "подписчиков")}`); }
  // На каких сайтах нашлись его треки (как в макете: «SoundCloud и YouTube»)
  const name = flat(b.name);
  const sites = new Set((d.tracks?.groups ?? []).flatMap((g) => g.members)
    .filter((t) => { const who = flat(displayTrack(t).artist) || flat(t.channel); return who && (who.includes(name) || name.includes(who)); })
    .map((t) => (t.source === "youtube" ? "YouTube" : "SoundCloud")));
  if (sites.size) sub.push([...sites].sort().join(" и "));
  else if (fromSc) sub.push("SoundCloud");
  const top = a?.top ?? [];
  return bestBox({ src: big(a?.pictureLarge || b.pictureLarge || b.picture), name: b.name, sub: sub.join(" · "), round: true,
    warm: `artist:${b.id}`,
    open: () => { remember({ k: "artist", id: b.id, name: b.name, pic: b.picture }); openView(`artist:${b.id}`); },
    play: top.length ? () => play(top[0], top.slice(), 0, { type: "artist", id: b.id, name: b.name }) : null });
}

function trackBest(track, kind, list = [track]) {
  const shown = displayTrack(track);
  const site = track.source === "youtube" ? "YouTube" : track.source === "soundcloud" ? "SoundCloud" : "";
  return bestBox({ src: coverUrl(track, "large"), name: shown.title, sub: [kind, shown.artist, site].filter(Boolean).join(" · "),
    open: () => { remember({ k: "track", t: slim(track) }); openTrack(track); },
    play: () => { remember({ k: "track", t: slim(track) }); play(track, list.slice(), Math.max(0, list.indexOf(track)), CTX); } });
}

function lyricBest(track) {
  const shown = displayTrack(track);
  const quote = track.lyricLine ? el("span", "sr-best-quote", `«${track.lyricLine}»`) : null;
  const sub = [shown.artist, track.lyricLine ? "нашлось по словам песни" : "похоже, это слова из этой песни"].filter(Boolean).join(" · ");
  return bestBox({ src: coverUrl(track, "large"), name: shown.title, sub, extra: quote,
    open: () => { remember({ k: "track", t: slim(track) }); openTrack(track); },
    play: () => { remember({ k: "track", t: slim(track) }); play(track, [track], 0, CTX); } });
}

async function playAlbum(r) {
  try {
    const album = await load(`/api/album/${r.id}`);
    if (album.tracks.length) play(album.tracks[0], album.tracks.slice(), 0, { type: "album", id: album.id, name: album.title });
  } catch {}
}

function openPlaylist(p) {
  if (p.own) {
    remember({ k: "playlist", id: p.id, name: p.name, sub: "Плейлист · ваш", pic: p.cover });
    openView(`playlist:${p.id}`);
  } else {
    remember({ k: "playlist", url: p.url, name: p.name, sub: `Плейлист · ${p.owner || "Яндекс Музыка"}`, pic: p.cover });
    openImportDialog({ url: p.url });
  }
}

// ---------- Альбомы, исполнители, плейлисты ----------

/** Альбомы: у исполнителя-«лучшего результата» — его дискография, иначе найденные по названию */
function albumList(d) {
  const best = d.meta?.best;
  if (best?.kind === "artist" && d.artist && String(d.artist.id) === String(best.id) && d.artist.releases?.length) {
    const own = [...d.artist.releases, ...(d.scReleases ?? [])].sort((x, y) =>
      `${y.year || "0"}${y.date || ""}`.localeCompare(`${x.year || "0"}${x.date || ""}`));
    const seen = new Set(own.map((r) => String(r.id)));
    return [...own, ...(d.meta.albums ?? []).filter((r) => !seen.has(String(r.id)) && flat(r.artist).includes(flat(best.name)))];
  }
  return d.meta?.albums ?? [];
}

function artistList(d) {
  const seen = new Set();
  return [...(d.meta?.artists ?? []), ...(d.artist?.related ?? [])].filter((a) => {
    const k = String(a.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 16);
}

/** Плейлисты: ваши (по названию) и из Яндекс Музыки («Лучшее: …» — перенести в медиатеку) */
function playlistList(d) {
  const want = norm(d.q).split(" ").filter(Boolean);
  const own = lib.playlists.filter((p) => { const have = norm(p.name); return want.length && want.every((w) => have.includes(w)); })
    .map((p) => ({ own: true, id: p.id, name: p.name, count: p.tracks.length, cover: p.cover || p.tracks.find((t) => t.cover)?.cover || null }));
  return [...own, ...(d.meta?.playlists ?? [])];
}

function albumCard(r) {
  const card = releaseCard(r, true);
  card.addEventListener("click", () => remember({ k: "album", id: r.id, name: r.title, sub: `Альбом${r.artist ? ` · ${r.artist}` : ""}`, pic: r.cover }), { capture: true });
  return card;
}

function artistCard(a) {
  const card = el("button", "home-card live-artist-card");
  card.type = "button";
  const sc = String(a.id).startsWith("sc:");
  card.append(picture(a.picture, "home-card-art", a.name), el("span", "home-card-title", a.name), el("span", "home-card-artist", sc ? "Исполнитель · SoundCloud" : "Исполнитель"));
  card.title = a.name;
  card.dataset.warm = `artist:${a.id}`;
  card.addEventListener("click", () => { remember({ k: "artist", id: a.id, name: a.name, pic: a.picture }); openView(`artist:${a.id}`); });
  return card;
}

function playlistCard(p) {
  const card = el("button", "home-card sr-pl-card");
  card.type = "button";
  const art = picture(p.cover, "home-card-art", p.name);
  if (!p.cover) art.innerHTML = icons.note;
  const count = p.count ? plural(p.count, "трек", "трека", "треков") : "";
  card.append(art, el("span", "home-card-title", p.name),
    el("span", "home-card-artist", p.own ? `Ваш плейлист${count ? ` · ${count}` : ""}` : [p.owner || "Яндекс Музыка", count].filter(Boolean).join(" · ")));
  card.title = p.own ? p.name : `${p.name} — перенести в медиатеку`;
  card.addEventListener("click", () => openPlaylist(p));
  return card;
}

// ---------- По ссылке ----------

function linkPage(root, d) {
  const info = d.info;
  const head = headRow(info?.service ? `По ссылке · ${info.service}` : "По ссылке");
  root.append(head);
  if (d.error) { root.append(emptyBox("Ссылка не открылась", d.error)); return; }
  if (!info) {
    const top = el("div", "sr-top sr-link");
    const left = el("section", "sr-best-col");
    left.append(skeletonBest(true));
    top.append(left);
    root.append(top);
    return;
  }
  const top = el("div", "sr-top sr-link");
  let best;
  if (info.kind === "track") best = trackBest(info.track, "Трек");
  else if (info.kind === "album") {
    best = bestBox({ src: big(info.cover), name: info.name || "Альбом", sub: ["Альбом", info.artist].filter(Boolean).join(" · "),
      warm: `album:${info.albumId}`, open: () => openView(`album:${info.albumId}`), play: () => playAlbum({ id: info.albumId }) });
  } else if (info.kind === "artist") best = artistBest({ ...d, meta: { best: info } }, info);
  else {   // list — плейлист (или альбом не из базы) переносится в медиатеку
    const what = info.what === "альбом" ? "Альбом" : "Плейлист";
    best = bestBox({ src: big(info.cover), name: info.name || what, sub: [what, info.service, info.count && plural(info.count, "трек", "трека", "треков"), "перенести в медиатеку"].filter(Boolean).join(" · "),
      open: () => openImportDialog({ url: info.url }) });
  }
  const left = el("section", "sr-best-col");
  left.append(best);
  top.append(left);
  const right = el("section", "sr-tracks-col");
  if (info.kind === "track") right.append(headRow("Трек"), tracksBox({ q: "", tracks: { groups: groupSongs([info.track]) } }, 1));
  else if (info.kind === "album" && d.album?.tracks?.length) {
    const al = d.album;
    right.append(headRow("Треки альбома", al.tracks.length > 8 ? linkButton(`Все ${al.tracks.length}`, () => openView(`album:${info.albumId}`)) : null),
      tracksBox({ q: "", tracks: { groups: groupSongs(al.tracks) } }, 8, { type: "album", id: al.id, name: al.title }));
  } else if (info.kind === "artist" && d.artist?.top?.length) {
    right.append(headRow("Популярные треки"), tracksBox({ q: "", tracks: { groups: groupSongs(d.artist.top) } }, 5, { type: "artist", id: d.artist.id, name: d.artist.name }));
  }
  if (right.childElementCount) top.append(right);   // нет — карточка одна, той же ширины
  root.append(top);
  if (info.kind === "artist" && d.artist) {
    const albums = d.artist.releases ?? [];
    if (albums.length) root.append(rowSection("Альбомы и синглы", albums.map((r) => albumCard(r)), 0, "albums"));
    if (d.artist.related?.length) root.append(rowSection("Похожие исполнители", d.artist.related.map(artistCard), 0, "artists"));
  }
}

// ---------- Подключение ----------

export function initSearchLive() {
  input = document.getElementById("query");
  form = document.getElementById("search-form");
  holder = document.getElementById("search");
  input.placeholder = "Что включим? Исполнитель, трек или ссылка";
  where = WHERE.some(([, v]) => v === getSetting("searchWhere")) ? getSetting("searchWhere") : "all";
  drop = el("div", "sq-drop");
  drop.setAttribute("role", "listbox");
  holder.append(drop);
  shade = el("div", "sq-shade");
  document.body.append(shade);
  const kbd = el("kbd", "sq-kbd", "Ctrl K");
  input.after(kbd);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const items = dropItems();
    if (dropOpen() && sel >= 0 && items[sel]) return items[sel].click();
    if (!dropOpen() && active >= 0) {
      const row = page?.querySelectorAll(".sr-tracks .track")[active];
      if (row) { row.click(); input.blur(); return; }
    }
    const q = input.value.trim();
    if (!q) return;
    closeDrop();
    runSearch(q, { record: true });
  });

  input.addEventListener("input", () => {
    syncField();
    active = -1;
    if (!input.value.trim()) {
      token++;   // поиск ещё идёт, а поле очистили — его ответ уже не нужен
      tracksToken++;
      clearTimeout(typeTimer);
      abort?.abort();
      tracksAbort?.abort();
      // Недоискавшийся поиск отменён — на экране остаются прежние результаты (иначе «загрузка» навсегда)
      if (res && !(res.link ? res.info || res.error : res.tracks && res.meta)) { res = res.stale ?? null; paint(); }
      openDrop();
      renderDrop();
      return;
    }
    closeDrop();
    scheduleSearch();
  });

  input.addEventListener("focus", () => { if (!input.value.trim()) openDrop(); });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (dropOpen()) setSel(sel + step);
      else if (view === "search") setActive(active + step);
    } else if (e.key === "Delete" && dropOpen() && sel >= 0) {
      const item = dropItems()[sel];
      if (item?._item) {
        e.preventDefault();
        const at = sel;
        forget(item._item);
        renderDrop();
        setSel(Math.min(at, drop.querySelectorAll(".sq-row").length - 1));
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeDrop();
      input.blur();
    }
  });

  document.getElementById("clear").addEventListener("click", () => {
    input.value = "";
    syncField();
    input.focus();
    openDrop();
  });

  // Щелчок мимо поиска закрывает список (но не по меню «⋯» или окну, открытым из него)
  document.addEventListener("pointerdown", (e) => {
    if (dropOpen() && !holder.contains(e.target) && !isOverlay(e.target)) closeDrop();
  });
  addEventListener("resize", () => { if (dropOpen()) placeShade(); });

  document.addEventListener("sono:view", (e) => {
    const was = view;
    view = e.detail;
    if (view === "search") return;
    if (was === "search") {
      // Посмотрели результаты и ушли — запрос попадёт в историю (если из них ничего не выбрали)
      if (res && !res.recorded && !res.link && res.tracks?.groups?.length && Date.now() - res.at > 3000) remember({ k: "q", q: res.q });
      page = null;
    }
    // На другом экране поле пустое (как в макете); вернётесь «Назад» — запрос снова в поле
    if (input.value) { input.value = ""; syncField(); }
    closeDrop();
  });
}

/** Ctrl+K / «/» (main.js): к полю поиска */
export function focusSearchLive() {
  input.focus();
  input.select();
  if (!input.value.trim()) openDrop();
}
