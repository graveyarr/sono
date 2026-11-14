// Мастерская тем: темы и виды «Сейчас играет» от других слушателей (каталог — github.com/graveyarr/sono-themes,
// сервер — workshop.py). Раскладка по мотивам мастерской Steam: слева поиск и разделы со счётчиками,
// сверху «Выбор разработчиков», ниже вкладки «Популярные / Новые / Обновлённые» и карточки.
// Каталог и картинки сервер хранит у себя — экран открывается и без интернета. Страница наружу не ходит.

import { icons } from "./icons.js";
import { chooseTheme, currentThemeId, deleteTheme, loadThemes, onThemesChange } from "./themes.js";
import { compactNumber, confirmDialog, el, openModal, plural, toast } from "./ui.js";
import { openExternal } from "./device.js";

const TABS = [
  { id: "popular", title: "Популярные", hint: "Больше всего скачиваний" },
  { id: "new", title: "Новые", hint: "Недавно появились в мастерской" },
  { id: "updated", title: "Обновлённые", hint: "Недавно обновлены авторами" },
];

let root = null;               // <section id="view-workshop">
let cat = null;                // каталог с сервера: {themes, featured, fetchedAt, stale, offline, error}
let filter = "all";            // раздел слева: all | part:theme | part:now | tag:<метка> | icons | font | installed | updates
let query = "";
let tab = "popular";
let loading = false;
let refreshing = false;
const busy = new Set();        // id тем, которые сейчас ставятся
let listening = false;

const norm = (s) => (s || "").toLowerCase().replace(/ё/g, "е");

export function renderWorkshop(section) {
  root = section;
  if (!listening) {
    listening = true;
    onThemesChange(() => { if (root && !root.hidden) draw(); });   // включили тему в настройках — обновить кнопки
  }
  draw();
  load();
}

async function load({ refresh = false } = {}) {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch("/api/workshop/catalog");
    cat = await res.json();
  } catch {
    cat = cat || { themes: [], featured: [], fetchedAt: 0, error: "Sono не ответил" };
  } finally {
    loading = false;
  }
  draw();
  if (refresh || cat.stale) await refreshCatalog();
}

async function refreshCatalog() {
  if (refreshing) return;
  refreshing = true;
  draw();
  try {
    const res = await fetch("/api/workshop/refresh", { method: "POST" });
    cat = await res.json();
  } catch {
    if (cat) cat.error = "Нет связи с каталогом — показан сохранённый.";
  } finally {
    refreshing = false;
  }
  draw();
}

// ---------- Что показывать ----------

function matches(t) {
  if (query) {
    const hay = norm([t.name, t.author, t.description, ...(t.tags || [])].join(" "));
    if (!norm(query).split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  if (filter === "all") return true;
  if (filter === "part:theme") return t.part === "theme";
  if (filter === "part:now") return t.part === "now";
  if (filter === "icons") return t.icons;
  if (filter === "font") return t.font;
  if (filter === "installed") return !!t.installed;
  if (filter === "updates") return t.hasUpdate;
  if (filter.startsWith("tag:")) return (t.tags || []).includes(filter.slice(4));
  return true;
}

function sorted(list) {
  const by = {
    popular: (a, b) => b.downloads - a.downloads || (b.updated || "").localeCompare(a.updated || ""),
    new: (a, b) => (b.created || "").localeCompare(a.created || ""),
    updated: (a, b) => (b.updated || "").localeCompare(a.updated || ""),
  }[tab];
  return [...list].sort((a, b) => by(a, b) || a.name.localeCompare(b.name, "ru"));
}

function categories() {
  const all = cat?.themes ?? [];
  const count = (fn) => all.filter(fn).length;
  const tags = new Map();
  for (const t of all) for (const tag of t.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
  const groups = [
    { title: "Разделы", items: [
      ["all", "Все", all.length],
      ["part:theme", "Темы", count((t) => t.part === "theme")],
      ["part:now", "Виды «Сейчас играет»", count((t) => t.part === "now")],
    ].filter((i) => i[0] === "all" || i[2]) },   // пустые разделы не показываем
    { title: "Метки", items: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
      .map(([tag, n]) => [`tag:${tag}`, tag, n]) },
    { title: "Особенности", items: [
      ["icons", "Со своими значками", count((t) => t.icons)],
      ["font", "Со своим шрифтом", count((t) => t.font)],
    ].filter((i) => i[2]) },
    { title: "Мои", items: [
      ["installed", "Установленные", count((t) => t.installed)],
      ["updates", "Есть обновления", count((t) => t.hasUpdate)],
    ] },
  ];
  return groups.filter((g) => g.items.length);
}

// ---------- Отрисовка ----------

function draw() {
  if (!root) return;
  const keepScroll = root.querySelector(".ws-side")?.scrollTop ?? 0;
  const focused = document.activeElement?.classList.contains("ws-search-input");
  const caret = focused ? document.activeElement.selectionStart : null;

  const head = el("div", "ws-head");
  const title = el("div", "ws-title");
  title.append(el("h1", "", "Мастерская тем"), el("p", "ws-sub", statusText()));
  const actions = el("div", "ws-actions");
  const submit = el("button", "btn ghost", "Предложить тему");
  submit.type = "button";
  submit.title = "Откроет страницу каталога на GitHub — там можно прислать свою тему";
  submit.addEventListener("click", () => openExternal("/api/workshop/open/submit"));
  const upd = el("button", `btn ghost ws-refresh${refreshing ? " busy" : ""}`, refreshing ? "Обновляю…" : "Обновить");
  upd.type = "button";
  upd.disabled = refreshing;
  upd.addEventListener("click", () => refreshCatalog());
  actions.append(submit, upd);
  head.append(title, actions);

  const layout = el("div", "ws-layout");
  layout.append(sideColumn(), mainColumn());
  root.replaceChildren(head, layout);

  root.querySelector(".ws-side").scrollTop = keepScroll;
  if (focused) {
    const input = root.querySelector(".ws-search-input");
    input.focus();
    input.setSelectionRange(caret, caret);
  }
}

function statusText() {
  if (!cat) return "Загружаю каталог…";
  if (refreshing && !cat.fetchedAt) return "Загружаю каталог…";
  const when = cat.fetchedAt ? dateText(new Date(cat.fetchedAt * 1000).toISOString().slice(0, 10)) : "";
  if (cat.offline || cat.error) return cat.fetchedAt ? `Нет связи — показан каталог от ${when}` : "Нет связи с каталогом";
  const n = cat.themes.length;
  return `Темы от слушателей Sono · ${plural(n, "тема", "темы", "тем")}${when ? ` · каталог от ${when}` : ""}`;
}

function sideColumn() {
  const side = el("aside", "ws-side");
  const search = el("label", "ws-search");
  search.innerHTML = icons.search;
  const input = el("input", "ws-search-input");
  input.type = "search";
  input.placeholder = "Найти тему";
  input.value = query;
  input.addEventListener("input", () => { query = input.value.trim(); draw(); });
  search.append(input);
  side.append(search);
  const cats = el("nav", "ws-cats");
  for (const g of categories()) {
    const group = el("div", "ws-cat-group");
    group.append(el("div", "ws-cat-title", g.title));
    for (const [key, label, n] of g.items) {
      const btn = el("button", `ws-cat${filter === key ? " on" : ""}`);
      btn.type = "button";
      btn.append(el("span", "ws-cat-name", label), el("span", "ws-cat-count", String(n)));
      btn.addEventListener("click", () => { filter = filter === key && key !== "all" ? "all" : key; draw(); });
      group.append(btn);
    }
    cats.append(group);
  }
  side.append(cats);
  return side;
}

function mainColumn() {
  const main = el("div", "ws-main");
  if (!cat || (!cat.themes.length && (loading || refreshing))) {
    main.append(el("div", "ws-empty", "Загружаю каталог…"));
    return main;
  }
  if (!cat.themes.length) {
    const empty = el("div", "ws-empty");
    empty.append(el("p", "", cat.error ? "Каталог не загрузился. Проверьте интернет и нажмите «Обновить»." : "В каталоге пока пусто."));
    main.append(empty);
    return main;
  }
  const front = filter === "all" && !query;
  const featured = front ? cat.featured.map((id) => cat.themes.find((t) => t.id === id)).filter(Boolean) : [];
  if (featured.length) main.append(featuredBlock(featured));

  const tabs = el("div", "ws-tabs");
  for (const t of TABS) {
    const b = el("button", `ws-tab${tab === t.id ? " on" : ""}`, t.title);
    b.type = "button";
    b.addEventListener("click", () => { tab = t.id; draw(); });
    tabs.append(b);
  }
  main.append(tabs, el("p", "ws-tab-hint", TABS.find((t) => t.id === tab).hint));

  const list = sorted(cat.themes.filter(matches));
  if (!list.length) {
    main.append(el("div", "ws-empty", query ? `По запросу «${query}» ничего не нашлось` : "Здесь пока пусто"));
    return main;
  }
  const grid = el("div", "ws-grid");
  grid.append(...list.map(themeCard));
  main.append(grid);
  return main;
}

function featuredBlock(items) {
  const box = el("section", "ws-featured");
  const top = el("div", "ws-featured-top");
  const text = el("div", "");
  text.append(el("h2", "ws-featured-title", "Выбор разработчиков"),
    el("p", "ws-featured-text", "Лучшие темы мастерской: мы их посмотрели, они аккуратные и хорошо работают на компьютере и телефоне."));
  top.append(text);
  const row = el("div", "ws-featured-row");
  for (const t of items) {
    const card = el("button", "ws-fcard");
    card.type = "button";
    const info = el("span", "ws-fcard-info");
    info.append(downloadsLine(t, "ws-fcard-dl"), el("span", "ws-fcard-name", t.name), el("span", "ws-fcard-author", byline(t)));
    card.append(shot(t), info);
    card.addEventListener("click", () => openDetails(t));
    row.append(card);
  }
  box.append(top, row);
  return box;
}

function themeCard(t) {
  const card = el("article", "ws-card");
  card.tabIndex = 0;
  const body = el("div", "ws-card-body");
  const top = el("div", "ws-card-top");
  const names = el("div", "ws-card-names");
  names.append(el("h3", "ws-card-name", t.name), el("span", "ws-card-author", byline(t)));
  top.append(names, actionButton(t, true));
  const tags = el("div", "ws-tags");
  for (const tag of kindTags(t)) tags.append(el("span", "ws-tag", tag));
  const foot = el("div", "ws-card-foot");
  foot.append(downloadsLine(t), el("span", "", t.updated ? `обновлена ${dateText(t.updated)}` : ""));
  body.append(top, tags, foot);
  card.append(shot(t), body);
  card.addEventListener("click", (e) => { if (!e.target.closest("button")) openDetails(t); });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === card) openDetails(t); });
  return card;
}

const byline = (t) => (t.author ? `Автор: ${t.author}` : "Автор не указан");

function kindTags(t) {
  return [t.part === "now" ? "Вид «Сейчас играет»" : null, ...(t.tags || []), t.icons ? "Свои значки" : null].filter(Boolean);
}

function downloadsLine(t, cls = "ws-dl") {
  const line = el("span", cls);
  line.innerHTML = icons.download;
  const n = t.downloads || 0;
  line.append(n >= 1e4 ? `${compactNumber(n)} скачиваний` : plural(n, "скачивание", "скачивания", "скачиваний"));
  return line;
}

function dateText(iso) {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Картинка темы; пока не загрузилась (или её нет / нет сети) — «окно Sono» цветами темы, как в настройках */
function shot(t, index = 0, cls = "ws-shot") {
  const box = el("span", `${cls} theme-swatch${t.part === "now" ? " now" : ""}`);
  const [bg = "#151515", panel = "#2a2a2a", fg = "#ffffff", accent = fg] = t.preview ?? [];
  box.style.setProperty("--c-bg", bg);
  box.style.setProperty("--c-panel", panel);
  box.style.setProperty("--c-fg", fg);
  box.style.setProperty("--c-accent", accent);
  box.innerHTML = t.part === "now"
    ? '<span class="tn-cover"></span><span class="tn-text"><i></i><i></i></span><span class="ts-bar"><b></b></span>'
    : '<span class="ts-side"></span><span class="ts-main"><i></i><i></i><i></i></span><span class="ts-bar"><b></b></span>';
  const name = t.previews?.[index];
  if (name) {
    const img = el("img", "ws-img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = `/api/workshop/preview/${encodeURIComponent(name)}`;
    img.addEventListener("error", () => img.remove());
    box.append(img);
  }
  return box;
}

// ---------- Кнопки: установить / включить / обновить ----------

function state(t) {
  if (busy.has(t.id)) return { label: t.installed ? "Обновляю…" : "Ставлю…", disabled: true };
  if (t.needs && !t.installed) return { label: `Нужна Sono ${t.needs}`, disabled: true };
  if (!t.installed) return { label: "Установить", kind: "primary", run: () => install(t) };
  if (t.hasUpdate) return { label: "Обновить", kind: "primary", run: () => install(t) };
  if (currentThemeId(t.part) === t.themeId) return { label: "Включена", kind: "ghost on", icon: icons.check, run: null };
  return { label: "Включить", kind: "ghost", run: () => enable(t) };
}

function actionButton(t, small = false) {
  const s = state(t);
  const btn = el("button", `btn ${s.kind || "ghost"} ws-act${small ? " small" : ""}`);
  btn.type = "button";
  if (s.icon) btn.innerHTML = s.icon;
  btn.append(s.label);
  btn.disabled = !!s.disabled;
  if (!s.run) btn.classList.add("idle");
  btn.addEventListener("click", (e) => { e.stopPropagation(); s.run?.(); });
  return btn;
}

async function install(t) {
  const wasInstalled = !!t.installed;
  busy.add(t.id);
  draw();
  try {
    const res = await fetch("/api/workshop/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "не получилось");
    await loadThemes();
    if (!wasInstalled || currentThemeId(t.part) !== data.id) chooseTheme(data.id, t.part);
    toast(wasInstalled ? `«${t.name}» обновлена` : `«${t.name}» установлена и включена`);
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy.delete(t.id);
  }
  await load();
  refreshDetails(t.id);
}

function enable(t) {
  chooseTheme(t.themeId, t.part);
  toast(`«${t.name}» включена`);
  draw();
  refreshDetails(t.id);
}

async function remove(t) {
  const ok = await confirmDialog({
    title: `Удалить «${t.name}»?`,
    text: "Тема уйдёт в Корзину. Поставить её снова можно здесь же, в мастерской.",
  });
  if (!ok) return;
  try {
    await deleteTheme(t.themeId);
    toast(`«${t.name}» удалена`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  await load();
  refreshDetails(t.id);
}

// ---------- Окно темы ----------

let details = null;   // { id, box }

function openDetails(t) {
  const { box, close } = openModal({ className: "ws-dialog", onClose: () => { details = null; } });
  details = { id: t.id, box, close };
  box.addEventListener("submit", (e) => e.preventDefault());   // окно — <form>: Enter не должен его «отправлять»
  fillDetails(t);
  box.querySelector(".ws-d-close")?.focus({ preventScroll: true });   // Esc ловит само окно — фокус должен быть в нём
}

function refreshDetails(id) {
  if (!details || details.id !== id) return;
  const t = cat?.themes.find((x) => x.id === id);
  if (t) fillDetails(t);
}

function fillDetails(t) {
  const { box, close } = details;
  const shots = el("div", "ws-d-shots");
  let current = 0;
  const big = el("div", "ws-d-big");
  big.append(shot(t, 0, "ws-d-shot"));
  shots.append(big);
  if ((t.previews?.length || 0) > 1) {
    const thumbs = el("div", "ws-d-thumbs");
    t.previews.forEach((_, i) => {
      const b = el("button", `ws-d-thumb${i === 0 ? " on" : ""}`);
      b.type = "button";
      b.append(shot(t, i, "ws-d-mini"));
      b.addEventListener("click", () => {
        if (i === current) return;
        current = i;
        big.replaceChildren(shot(t, i, "ws-d-shot"));
        thumbs.querySelectorAll(".ws-d-thumb").forEach((x, j) => x.classList.toggle("on", j === i));
      });
      thumbs.append(b);
    });
    shots.append(thumbs);
  }

  const info = el("div", "ws-d-info");
  const head = el("div", "ws-d-head");
  const names = el("div", "");
  names.append(el("h2", "ws-d-name", t.name), el("span", "ws-card-author", byline(t)));
  const x = el("button", "icon-btn ws-d-close");
  x.type = "button";
  x.innerHTML = icons.close;
  x.setAttribute("aria-label", "Закрыть");
  x.addEventListener("click", close);
  head.append(names, x);
  const tags = el("div", "ws-tags");
  for (const tag of kindTags(t)) tags.append(el("span", "ws-tag", tag));
  info.append(head, tags);
  if (t.description) info.append(el("p", "ws-d-text", t.description));

  const facts = el("dl", "ws-d-facts");
  const fact = (k, v) => { if (v) facts.append(el("dt", "", k), el("dd", "", v)); };
  fact("Версия", t.installed && t.installed !== t.version ? `${t.version} (у вас ${t.installed})` : t.version);
  fact("Добавлена", dateText(t.created));
  fact("Обновлена", dateText(t.updated));
  fact("Размер", t.size ? `${Math.max(1, Math.round(t.size / 1024))} КБ` : "");
  fact("Лицензия", t.license);
  fact("Скачиваний", (t.downloads || 0).toLocaleString("ru"));
  info.append(facts);

  const buttons = el("div", "ws-d-buttons");
  buttons.append(actionButton(t));
  if (t.installed) {
    if (currentThemeId(t.part) === t.themeId) {
      const off = el("button", "btn ghost", "Выключить");
      off.type = "button";
      off.addEventListener("click", () => { chooseTheme(null, t.part); draw(); fillDetails(t); });
      buttons.append(off);
    }
    const del = el("button", "btn ghost ws-danger", "Удалить");
    del.type = "button";
    del.addEventListener("click", () => remove(t));
    buttons.append(del);
  }
  const report = el("button", "ws-report", "Пожаловаться на тему");
  report.type = "button";
  report.addEventListener("click", () => openExternal("/api/workshop/open/report"));
  info.append(buttons, report);
  box.replaceChildren(shots, info);
}
