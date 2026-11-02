// Общие кусочки интерфейса: строки треков, обложки, меню, диалоги, уведомления.

import { icons } from "./icons.js";
import { isDownloaded, isDownloading } from "./downloads.js";
import { isDisliked, isLiked, keyOf } from "./library.js";
import { isMeta, resolvedOf } from "./meta.js";
import { openArtist, splitArtists } from "./nav.js";

export const SOURCE_NAMES = { youtube: "YouTube", soundcloud: "SoundCloud" };

/** Создаёт элемент: el("div", "class", "текст") */
export function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function iconButton(icon, label, className = "") {
  const btn = el("button", `icon-btn ${className}`.trim());
  btn.type = "button";
  btn.innerHTML = icon;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  return btn;
}

// Адрес трека на нашем сервере: /api/<что>/<источник>/<id>
export const trackPath = (what, t) => `/api/${what}/${t.source}/${t.id}`;
/** Адрес обложки. У треков из базы (страницы исполнителей) обложка своя — берём через сервер с кэшем */
export const coverUrl = (t, size = "small") => {
  if (isMeta(t) || t.cover) {
    const url = size === "large" ? t.coverLarge || t.cover : t.cover;
    return url ? imgUrl(url) : "";
  }
  return `${trackPath("cover", t)}?size=${size}`;
};
export const imgUrl = (url) => `/api/img?u=${encodeURIComponent(url)}`;

// ---------- Красивое название и исполнитель ----------
// На YouTube в названиях много мусора: «【Official Video】», «(Lyrics)», «| канал», а исполнитель
// часто записан в самом названии через тире. Для показа чистим; сохранённые данные не трогаем.

const NOISE_WORDS = "official|video|audio|lyrics?|lyric video|visuali[sz]er|m/?v|hd|hq|4k|clip|клип|премьера|текст|music video|full album";
// Скобки любого вида, внутри которых есть одно из «мусорных» слов: (Official Video), 【MV】, [HD]…
const NOISE_BRACKETS = new RegExp(`\\s*[\\[(【「（][^\\])】」）]*?(?:${NOISE_WORDS})[^\\])】」）]*[\\])】」）]\\s*`, "gi");
const VERSION_MARK = /instrumental|remix|live|cover|acoustic|slowed|sped|nightcore|karaoke|кавер|ремикс|минус/i;
// «Money - 2011 Remaster», «Song - Live at …» — это не «исполнитель - название», не разбиваем
const VERSION_TAIL = /^(\d{4}\s+)?(remaster|live|version|edit|mix|acoustic|demo|bonus)/i;

function cleanChannel(channel) {
  return (channel || "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "")
    .replace(/\s+official(\s+(artist\s+)?(youtube\s+)?channel)?$/i, "")
    .trim();
}

/** { title, artist } для показа: без мусора, исполнитель отдельно от названия */
export function displayTrack(track) {
  // Трек из импорта знает настоящих исполнителей и название — они точнее всего
  if (track.artists && track.origTitle) return { title: track.origTitle, artist: track.artists };
  const isTopic = /-\s*topic$/i.test(track.channel || "");   // автоканалы YouTube: название уже чистое
  let artist = cleanChannel(track.channel);
  let title = (track.title || "")
    // скобки с «мусором» убираем, но не если там пометка версии: «(HQ Instrumental)», «[Live]» важно видеть
    .replace(NOISE_BRACKETS, (m) => (VERSION_MARK.test(m) ? m : " "))
    .replace(/\s*\|.*$/, "")                   // «Название | Канал»
    .replace(/\s+(lyrics?|hq|hd)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const parts = !isTopic && title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (parts && !VERSION_TAIL.test(parts[2])) {
    // «Исполнитель - Название»
    const left = parts[1].trim(), l = left.toLowerCase(), a = artist.toLowerCase();
    const sameAsChannel = !!a && (a.includes(l) || l.includes(a));
    if (sameAsChannel || left.length <= 40) {   // длинная левая часть — скорее всего не имя исполнителя
      if (!sameAsChannel) artist = left;        // канал чужой (перезалив) — исполнитель записан слева
      title = parts[2].trim();
    }
  }
  return { title: title || track.title || "Без названия", artist: artist || "Неизвестный автор" };
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 1 трек, 2 трека, 5 треков */
export function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** 950 → «950», 12 400 → «12 тыс.», 6 319 679 → «6,3 млн», 1,2 млрд */
export function compactNumber(n) {
  if (n == null) return "";
  const fmt = (x) => x.toLocaleString("ru", { maximumFractionDigits: x < 10 ? 1 : 0 });
  if (n >= 1e9) return `${fmt(n / 1e9)} млрд`;
  if (n >= 1e6) return `${fmt(n / 1e6)} млн`;
  if (n >= 1e4) return `${fmt(n / 1e3)} тыс.`;
  return n.toLocaleString("ru");
}

/** «4,8 млн слушателей», «950 слушателей», «2 слушателя» */
export function countText(n, one, few, many) {
  // У сокращённых чисел («6,3 млн») слово всегда «многих»: «млн слушателей», а не «слушателя»
  return n >= 1e4 ? `${compactNumber(n)} ${many}` : plural(n, one, few, many);
}

/** «6,3 млн просмотров» (YouTube) / «45 тыс. прослушиваний» (SoundCloud) */
export function playsText(plays, source) {
  if (plays == null) return "";
  return source === "youtube" ? countText(plays, "просмотр", "просмотра", "просмотров")
    : countText(plays, "прослушивание", "прослушивания", "прослушиваний");
}

export function formatTotal(tracks) {
  const sec = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

// ---------- Цвет картинки ----------

/** Средний цвет картинки в HSL; яркие насыщенные пиксели весят больше серых и чёрных */
export function imageHsl(img) {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let r = 0, g = 0, b = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    const weight = (1 + ((max - min) ** 2) / 64) * (max < 30 ? 0.2 : 1);
    r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight;
    total += weight;
  }
  return rgbToHsl(r / total, g / total, b / total);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

// Перезапускает CSS-анимацию у элемента (снять класс, дать браузеру заметить, вернуть)
export function replay(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

// ---------- Строка трека ----------
// Одна и та же строка — в поиске, истории и плейлистах.
// numbered: вид таблицы (номер, длительность в отдельной колонке) — для экрана плейлиста.

export function trackRow(track, { index = 0, numbered = false, showSource = false,
  onPlay, onMenu, onLike, onRemove, draggable = false } = {}) {
  const li = el("li", `track ${numbered ? "numbered" : "compact"}`);
  li.dataset.key = keyOf(track);
  li.style.setProperty("--i", Math.min(index, 20));

  if (numbered) {
    const num = el("span", "t-num");
    num.innerHTML = `<span class="t-index">${index + 1}</span><span class="t-play">${icons.play}</span>
      <span class="t-eq"><i></i><i></i><i></i></span>`;
    li.append(num);
  }

  const img = el("img", "thumb");
  img.alt = "";
  img.loading = "lazy";
  img.onerror = () => img.classList.add("broken");
  const cover = coverUrl(track);
  if (cover) img.src = cover;
  else img.classList.add("broken");   // у релизов из Deezer обложек нет

  const meta = el("div", "t-meta");
  const shown = displayTrack(track);
  const parts = [];
  if (!numbered) parts.push(formatTime(track.duration));
  if (showSource) parts.push(SOURCE_NAMES[track.source]);
  if (!numbered && track.plays != null) parts.push(playsText(track.plays, track.source).replace(/(просмотр|прослушивани)\S*/, (w) => (w.startsWith("просмотр") ? "просм." : "прослуш.")));
  const sub = el("div", "t-sub");
  const dl = el("span", "t-dl");   // значок «скачано» (виден, когда трек скачан или качается)
  dl.innerHTML = icons.downloaded;
  sub.append(dl, artistLinks(track, shown.artist), document.createTextNode(parts.length ? " · " + parts.join(" · ") : ""));
  meta.append(el("div", "t-title", shown.title), sub);
  meta.title = track.title;   // полное исходное название — во всплывающей подсказке
  li.append(img, meta);

  if (numbered) li.append(el("span", "t-source", SOURCE_NAMES[track.source] ?? ""));

  const like = iconButton(icons.heart, "В избранное", "t-like");
  like.addEventListener("click", (e) => { e.stopPropagation(); onLike?.(track); });
  li.append(like);

  if (numbered) li.append(el("span", "t-dur", formatTime(track.duration)));

  if (onRemove) {
    const remove = iconButton(icons.close, "Убрать", "t-remove");
    remove.addEventListener("click", (e) => { e.stopPropagation(); onRemove(track); });
    li.append(remove);
  }

  const more = iconButton(icons.more, "Ещё", "t-more");
  more.addEventListener("click", (e) => { e.stopPropagation(); onMenu?.(more, track); });
  li.append(more);

  li.addEventListener("click", (e) => { if (!e.target.closest("button")) onPlay?.(track); });
  li.addEventListener("contextmenu", (e) => { e.preventDefault(); onMenu?.({ x: e.clientX, y: e.clientY }, track); });
  if (draggable) li.draggable = true;

  syncRow(li, track);
  return li;
}

/** Имена исполнителей — каждое ссылкой на свою страницу («Lucy Bedroque, slayr» — две ссылки) */
export function artistLinks(track, text) {
  const box = document.createDocumentFragment();
  splitArtists(track, text).forEach(({ name, id }, i) => {
    if (i) box.append(", ");
    const link = el("span", "t-artist", name);
    link.addEventListener("click", (e) => {
      e.stopPropagation();   // строка трека и мини-плеер сами реагируют на щелчок
      openArtist({ id, name }).then((ok) => { if (!ok) toast(`Не нашёл страницу «${name}»`); });
    });
    box.append(link);
  });
  return box;
}

/** Обновляет сердечко и «дизлайк» у строки */
function syncRow(li, track = { source: li.dataset.key.split(":")[0], id: li.dataset.key.slice(li.dataset.key.indexOf(":") + 1) }) {
  track = resolvedOf(track) ?? track;   // у трека из базы смотрим на найденную пару
  const liked = isLiked(track), disliked = isDisliked(track);
  li.classList.toggle("liked", liked);
  li.classList.toggle("disliked", disliked);
  li.classList.toggle("downloaded", isDownloaded(track));
  li.classList.toggle("downloading", isDownloading(track));
  const like = li.querySelector(".t-like");
  if (like && like.dataset.state !== String(liked)) {
    like.dataset.state = String(liked);
    like.innerHTML = liked ? icons.heartFilled : icons.heart;
    like.title = liked ? "Убрать из избранного" : "В избранное";
    like.setAttribute("aria-label", like.title);
  }
}

/** После лайка/дизлайка/скачивания перерисовывает состояние всех строк на экране */
export function syncAllRows() {
  document.querySelectorAll(".track[data-key]").forEach((li) => syncRow(li));
}

/** Подсвечивает строки текущего трека */
export function markCurrentRows(key) {
  document.querySelectorAll(".track[data-key], .home-card[data-key]").forEach((li) =>
    li.classList.toggle("current", li.dataset.key === key || li.dataset.realKey === key));   // realKey — пара трека из базы
}

// ---------- Обложка коллекции (плейлист, избранное, дизлайки) ----------

// Цвет пустого плейлиста — из его названия, чтобы у каждого был свой
export function nameHue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

export function collectionCover(kind, { name = "", tracks = [], cover = null } = {}, big = false) {
  const box = el("div", `collection-cover ${kind}`);
  if (kind === "liked") { box.innerHTML = icons.heartFilled; return box; }
  if (kind === "disliked") { box.innerHTML = icons.dislikeFilled; return box; }
  if (kind === "downloads") { box.innerHTML = icons.download; return box; }

  if (cover) {   // своя обложка плейлиста (картинка, которую выбрал человек)
    const img = el("img");
    img.alt = "";
    img.src = cover;
    box.append(img);
    return box;
  }
  const unique = [...new Map(tracks.map((t) => [keyOf(t), t])).values()];
  if (unique.length >= 4) {
    box.classList.add("mosaic");
    unique.slice(0, 4).forEach((t) => {
      const img = el("img");
      img.alt = "";
      img.src = coverUrl(t);
      img.onerror = () => img.classList.add("broken");
      box.append(img);
    });
  } else if (unique.length) {
    const img = el("img");
    img.alt = "";
    img.src = coverUrl(unique[0], big ? "large" : "small");
    img.onerror = () => img.classList.add("broken");
    box.append(img);
  } else {
    const hue = nameHue(name);
    box.classList.add("empty");
    box.style.background = `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 50% 18%))`;
    box.innerHTML = icons.note;
  }
  return box;
}

// ---------- Всплывающее меню ----------
// items: [{ label, icon, action, danger, disabled, submenu: () => items }, { sep: true }, ...]
// Подменю открывается «страницей» внутри того же меню, со стрелкой назад.

const menu = el("div", "menu");
menu.setAttribute("role", "menu");
document.body.append(menu);
let menuAnchor = null;

export const isOverlay = (target) => !!target.closest?.(".menu, .dialog-backdrop");

function placeMenu() {
  const r = menuAnchor instanceof Element
    ? menuAnchor.getBoundingClientRect()
    : { left: menuAnchor.x, right: menuAnchor.x, top: menuAnchor.y, bottom: menuAnchor.y };
  const w = menu.offsetWidth, h = menu.offsetHeight, gap = 6, pad = 8;
  // По умолчанию — под кнопкой, правым краем к её правому краю (у курсора — от курсора вправо)
  let left = menuAnchor instanceof Element ? r.right - w : r.left;
  let top = r.bottom + gap;
  if (top + h > innerHeight - pad) top = Math.max(pad, r.top - h - gap);   // не влезает вниз — открываем вверх
  left = Math.min(Math.max(pad, left), innerWidth - w - pad);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function renderMenuPage(items, title = "", back = null, direction = "") {
  const page = el("div", `menu-page ${direction}`);
  if (title) {
    const head = el("button", "menu-head");
    head.type = "button";
    head.innerHTML = `${icons.back}<span></span>`;
    head.querySelector("span").textContent = title;
    head.addEventListener("click", back);
    page.append(head);
  }
  for (const item of items) {
    if (item.sep) { page.append(el("div", "menu-sep")); continue; }
    if (item.note) { page.append(el("div", "menu-note", item.note)); continue; }
    const btn = el("button", `menu-item${item.danger ? " danger" : ""}`);
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.disabled = !!item.disabled;
    btn.innerHTML = `<span class="menu-icon">${item.icon ?? ""}</span><span class="menu-label"></span>${item.submenu ? icons.chevron : ""}`;
    btn.querySelector(".menu-label").textContent = item.label;
    btn.addEventListener("click", () => {
      if (item.submenu) {
        renderMenuPage(item.submenu(), item.label, () => renderMenuPage(items, title, back, "from-left"), "from-right");
      } else {
        closeMenu();
        item.action?.();
      }
    });
    page.append(btn);
  }
  menu.replaceChildren(page);
  placeMenu();
  page.querySelector(".menu-item:not(:disabled)")?.focus({ preventScroll: true });
}

/** anchor — кнопка (меню под ней) или {x, y} (меню у курсора) */
export function openMenu(anchor, items, startSubmenu = null) {
  menuAnchor = anchor;
  menu.classList.add("open");
  if (startSubmenu) {   // сразу открыть подменю, например «Добавить в плейлист»
    const item = items.find((i) => i.submenu && i.label === startSubmenu);
    if (item) {
      renderMenuPage(item.submenu(), "", null);
      return;
    }
  }
  renderMenuPage(items);
}

export function closeMenu() {
  menu.classList.remove("open");
  menuAnchor = null;
}

document.addEventListener("pointerdown", (e) => {
  if (menuAnchor && !menu.contains(e.target)) closeMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuAnchor) { e.stopPropagation(); closeMenu(); }
}, true);
addEventListener("resize", closeMenu);
addEventListener("scroll", (e) => { if (menuAnchor && !menu.contains(e.target)) closeMenu(); }, true);

// ---------- Диалоги ----------

/** Окно поверх всего. Возвращает { box, close }: box — содержимое (это <form>), close — закрыть.
    onClose вызывается при любом закрытии (кнопка, Esc, клик мимо окна). */
export function openModal({ onClose, className = "" } = {}) {
  const backdrop = el("div", "dialog-backdrop");
  const box = el("form", `dialog ${className}`.trim());
  backdrop.append(box);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove("open");
    setTimeout(() => backdrop.remove(), 250);
    onClose?.();
  };
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("open"));
  return { box, close };
}

function openDialog(build) {
  return new Promise((resolve) => {
    let result = null;
    const { box, close } = openModal({ onClose: () => resolve(result) });
    const finish = (value) => { result = value; close(); };
    const focusTarget = build(box, finish);
    focusTarget?.focus();
    focusTarget?.select?.();
  });
}

function dialogButtons(form, finish, okLabel, danger) {
  const row = el("div", "dialog-buttons");
  const cancel = el("button", "btn ghost", "Отмена");
  cancel.type = "button";
  cancel.addEventListener("click", () => finish(null));
  const ok = el("button", `btn ${danger ? "danger" : "primary"}`, okLabel);
  ok.type = "submit";
  row.append(cancel, ok);
  form.append(row);
  return ok;
}

/** Спрашивает текст. null — если передумали */
export function promptDialog({ title, value = "", placeholder = "", okLabel = "Сохранить" }) {
  return openDialog((form, finish) => {
    const input = el("input", "dialog-input");
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = 100;
    input.spellcheck = false;
    form.append(el("h2", "", title), input);
    const ok = dialogButtons(form, finish, okLabel, false);
    const sync = () => { ok.disabled = !input.value.trim(); };
    input.addEventListener("input", sync);
    sync();
    form.addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) finish(input.value.trim()); });
    return input;
  });
}

/** Спрашивает «точно?». true — да */
export function confirmDialog({ title, text = "", okLabel = "Удалить", danger = true }) {
  return openDialog((form, finish) => {
    form.append(el("h2", "", title));
    if (text) form.append(el("p", "", text));
    const ok = dialogButtons(form, (v) => finish(!!v), okLabel, danger);
    form.addEventListener("submit", (e) => { e.preventDefault(); finish(true); });
    return ok;
  });
}

// ---------- Уведомления ----------

const toasts = el("div", "toasts");
toasts.setAttribute("aria-live", "polite");
document.body.append(toasts);

export function toast(text, { error = false } = {}) {
  const item = el("div", `toast${error ? " error" : ""}`, text);
  toasts.append(item);
  while (toasts.children.length > 3) toasts.firstElementChild.remove();
  setTimeout(() => {
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 300);
  }, error ? 4500 : 2600);
}
