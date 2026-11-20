// «Мастерская тем» на ПК («Живая обложка», шаг 9). Макет — design/ui-new/B-ekrany.html (#workshop).
// Сверху — надпись о каталоге, заголовок, «Предложить тему», «Сделать свою»; ниже поиск и чипы (метки, особенности,
// «Установленные», «Есть обновления»), «Выбор разработчиков» крупно и «Все темы» сеткой с карточкой редактора.
// Каталог, установка, обновление, удаление и окно темы — прежние (workshop.js), здесь только вид.
// Телефон — прежняя мастерская (workshop.js renderWorkshop); какую показать, решает views.js.

import { openExternal } from "./device.js";
import { openThemeEditor } from "./editor.js";
import { icons } from "./icons.js";
import { segment } from "./artistlive.js";
import { chooseTheme, currentThemeId } from "./themes.js";
import { compactNumber, el, toast } from "./ui.js";
import { byline, dateText, kindTags, matches, openDetails, refreshCatalog, shot, sorted, startWorkshopLive, state, statusText,
  TABS, wsBusy, wsCatalog } from "./workshop.js";

let box = null;              // <section id="view-workshop">
let filter = "all";          // all | part:theme | part:now | tag:<метка> | icons | font | installed | updates
let query = "";
let tab = "popular";
let parts = null;            // { kick, refresh, chips, body } — то, что перерисовывается без всего экрана
let moreTags = false;       // «Ещё N»: редкие метки раскрыты
let trial = null;            // «Примерить на 10 с»: { part, id, prev, timer, note }
const TRIAL_MS = 10000;

export function renderWorkshopLive(section) {
  box = section;
  startWorkshopLive(section, draw);   // рисует сразу и ещё раз, когда придёт каталог
}

// ---------- Целиком ----------

function draw() {
  if (!box) return;
  const input = parts?.find;
  const focused = input && document.activeElement === input;
  const caret = focused ? input.selectionStart : null;

  const root = el("div", "wsl");
  const head = el("div", "live-hd wsl-hd");
  const left = el("div", "live-hd-l");
  const kick = el("div", "live-kick");
  left.append(kick, el("h1", "live-h1", "Мастерская тем"));
  const refresh = pill(icons.refresh, "", () => refreshCatalog(), "ic wsl-refresh");
  refresh.title = "Обновить каталог";
  refresh.setAttribute("aria-label", "Обновить каталог");
  const submit = pill(icons.plus, "Предложить тему", () => openExternal("/api/workshop/open/submit"));
  submit.title = "Откроет страницу каталога на GitHub — там можно прислать свою тему";
  head.append(left, el("span", "sp"), refresh, submit, pill(icons.edit, "Сделать свою", () => openThemeEditor(), "solid"));

  const bar = el("div", "wsl-bar");
  const find = el("label", "wsl-find glass");
  find.innerHTML = icons.search;
  const field = el("input");
  field.type = "search";
  field.placeholder = "Найти тему";
  field.value = query;
  field.addEventListener("input", () => { query = field.value.trim(); drawBody(); });
  field.addEventListener("keydown", (e) => { if (e.key === "Escape" && field.value) { e.stopPropagation(); field.value = ""; query = ""; drawBody(); } });
  find.append(field);
  const chips = el("div", "wsl-chips");
  bar.append(find, chips);

  const body = el("div", "wsl-body");
  root.append(head, bar, body);
  parts = { kick, refresh, chips, body, find: field };
  drawStatus();
  drawChips();
  drawBody();
  box.replaceChildren(root);
  if (focused) {
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, caret);
  }
}

function pill(icon, label, onClick, cls = "") {
  const b = el("button", `pill${cls ? ` ${cls}` : ""}`);
  b.type = "button";
  if (icon) b.innerHTML = icon;
  if (label) b.append(label);
  b.addEventListener("click", onClick);
  return b;
}

function drawStatus() {
  const { refreshing } = wsBusy();
  parts.kick.textContent = statusText();
  parts.refresh.classList.toggle("busy", refreshing);
  parts.refresh.disabled = refreshing;
}

// ---------- Чипы: все, виды, метки, особенности, мои ----------

function chipList() {
  const all = wsCatalog()?.themes ?? [];
  const count = (fn) => all.filter(fn).length;
  const list = [["all", "Все", all.length]];
  const nows = count((t) => t.part === "now");
  if (nows) list.push(["part:theme", "Темы", count((t) => t.part === "theme")], ["part:now", "Виды «Сейчас играет»", nows]);
  const tags = new Map();
  for (const t of all) for (const tag of t.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
  // Частые метки (у 2+ тем, но не меньше 4) — сразу, редкие — за чипом «Ещё N» (как в макете: чипы в одну строку)
  const sortedTags = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  const rare = sortedTags.filter(([tag, n], i) => n < 2 && i >= 4);
  if (rare.some(([tag]) => filter === `tag:${tag}`)) moreTags = true;   // выбранная метка не прячется
  sortedTags.forEach(([tag, n]) => { if (moreTags || !rare.some((r) => r[0] === tag)) list.push([`tag:${tag}`, tag, n]); });
  const icon = count((t) => t.icons), font = count((t) => t.font), updates = count((t) => t.hasUpdate);
  if (icon) list.push(["icons", "Свои значки", icon]);
  if (font) list.push(["font", "Свой шрифт", font]);
  list.push(["installed", "Установленные", count((t) => t.installed)]);
  if (updates || filter === "updates") list.push(["updates", "Есть обновления", updates]);
  if (rare.length) list.push([moreTags ? "less" : "more", moreTags ? "Меньше меток" : "Ещё", moreTags ? "" : rare.length]);
  return list;
}

function drawChips() {
  const list = chipList();
  if (!list.some(([key]) => key === filter)) filter = "all";   // метка пропала из каталога
  parts.chips.replaceChildren(...list.map(([key, label, n]) => {
    const b = el("button", `wsl-chip${filter === key ? " on" : ""}${key === "more" || key === "less" ? " wsl-more" : ""}`);
    b.type = "button";
    b.append(label);
    if (n !== "") b.append(el("small", "", String(n)));
    b.addEventListener("click", () => {
      if (key === "more" || key === "less") {   // раскрыть / свернуть редкие метки
        moreTags = key === "more";
        drawChips();
        return;
      }
      filter = filter === key && key !== "all" ? "all" : key;   // повторный щелчок — снова «Все»
      parts.chips.querySelectorAll(".wsl-chip").forEach((c, i) => c.classList.toggle("on", list[i][0] === filter));
      drawBody();
    });
    return b;
  }));
}

// ---------- «Выбор разработчиков» и «Все темы» ----------

function drawBody() {
  const cat = wsCatalog();
  const { loading, refreshing } = wsBusy();
  const body = parts.body;
  const nodes = [];
  if (!cat || (!cat.themes.length && (loading || refreshing))) {
    nodes.push(allSection([empty("Загружаю каталог…")]));
  } else if (!cat.themes.length) {
    nodes.push(allSection([empty(cat.error ? "Каталог не загрузился. Проверьте интернет и нажмите «Обновить каталог» (стрелка вверху)." : "В каталоге пока пусто.")]));
  } else {
    const front = filter === "all" && !query;
    const picks = front ? cat.featured.map((id) => cat.themes.find((t) => t.id === id)).filter(Boolean) : [];
    if (picks.length) {
      const sec = section("Выбор разработчиков", el("small", "", "аккуратные и проверены на компьютере и телефоне"));
      const row = el("div", "wsl-picks");
      row.append(...picks.map((t) => card(t, true)));
      sec.append(row);
      nodes.push(sec);
    }
    // Без поиска и фильтра «Выбор разработчиков» уже выше — в сетке остальные (как в макете)
    const list = sorted(cat.themes.filter((t) => matches(t, filter, query) && !picks.includes(t)), tab);
    const cards = list.map((t) => card(t));
    if (!cards.length && !picks.length) cards.push(empty(query ? `По запросу «${query}» ничего не нашлось`
      : filter === "updates" ? "Все установленные темы — последней версии" : "Здесь пока пусто"));
    nodes.push(allSection(cards));
  }
  body.replaceChildren(...nodes);
}

function section(title, ...rest) {
  const sec = el("section", "wsl-sec");
  const h = el("h3", "wsl-h", title);
  h.append(...rest);
  sec.append(h);
  return sec;
}

function allSection(cards) {
  const seg = segment(TABS.map((t) => [t.title, t.id]), tab, (v) => { tab = v; drawBody(); });
  seg.querySelectorAll(".seg-btn").forEach((b, i) => { b.title = TABS[i].hint; });
  const sec = section("Все темы", seg);
  const grid = el("div", "wsl-grid");
  grid.append(...cards, mineCard());
  sec.append(grid);
  return sec;
}

function empty(text) {
  return el("div", "wsl-empty glass", text);
}

/** Карточка «Своя тема — без кода» в конце сетки */
function mineCard() {
  const c = el("div", "wsl-mine glass");
  c.append(el("b", "", "Своя тема — без кода"),
    el("span", "", "Редактор тем: цвета, фон, шрифт, форма кнопок. Сохраните себе — а прислать в мастерскую можно через «Предложить тему»."));
  const acts = el("div", "wsl-mine-acts");
  acts.append(pill(icons.edit, "Открыть редактор", () => openThemeEditor(), "solid"));
  c.append(acts);
  return c;
}

/** Карточка темы: снимок 16:10, название, описание · автор · скачивания, кнопка, метки */
function card(t, pick = false) {
  const c = el("article", `wsl-card glass${pick ? " pick" : ""}`);
  c.tabIndex = 0;
  c.dataset.id = t.id;
  const s = state(t);
  const pv = el("div", "wsl-pv");
  pv.append(shot(t, 0, "wsl-shot"));
  if (pick) pv.append(el("span", "wsl-badge on-pic", "Выбор разработчиков"));
  if (s.key === "enable") {
    const tryBtn = el("button", "wsl-try");
    tryBtn.type = "button";
    tryBtn.innerHTML = icons.image;
    tryBtn.append(`Примерить на ${TRIAL_MS / 1000} с`);
    tryBtn.title = "Тема включится на 10 секунд, потом вернётся прежняя";
    tryBtn.addEventListener("click", (e) => { e.stopPropagation(); tryOn(t); });
    pv.append(tryBtn);
  }

  const tf = el("div", "wsl-tf");
  const text = el("div", "wsl-text");
  text.append(el("b", "wsl-name", t.name));
  if (t.description) {   // описание — одной строкой (целиком — в подсказке и в окне темы)
    const desc = el("span", "wsl-desc", t.description);
    desc.title = t.description;
    text.append(desc);
  }
  // Автор · скачивания · когда обновлена (как в прежней карточке)
  const meta = el("span", "wsl-meta");
  if (t.author) meta.append(el("span", "wsl-author", t.author), " · ");
  const dl = el("span", "wsl-dl");
  dl.innerHTML = icons.download;
  const n = t.downloads || 0;
  dl.append(n >= 1e4 ? compactNumber(n) : String(n));
  dl.title = `Скачиваний: ${n.toLocaleString("ru")}`;
  meta.append(dl);
  if (t.updated) meta.append(` · обновлена ${dateText(t.updated)}`);
  text.append(meta);
  tf.append(text, actionButton(t, s));

  const tags = el("div", "wsl-tags");
  tags.append(...kindTags(t).map((tag) => el("span", "wsl-badge", tag)));
  c.append(pv, tf, tags);
  c.title = byline(t);
  c.addEventListener("click", (e) => { if (!e.target.closest("button")) openDetails(t); });
  c.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === c) openDetails(t); });
  return c;
}

function actionButton(t, s) {
  const cls = { on: " on", update: " upd", busy: " idle", needs: " idle" }[s.key] ?? "";
  const b = el("button", `wsl-btn${cls}`);
  b.type = "button";
  if (s.key === "on") b.innerHTML = icons.check;
  if (s.key === "update") b.innerHTML = icons.download;
  b.append(s.key === "update" && t.version ? `Обновить до ${t.version}` : s.label);
  b.disabled = !!s.disabled;
  if (!s.run && !s.disabled) b.tabIndex = -1;   // «Включена» — просто надпись
  b.addEventListener("click", (e) => { e.stopPropagation(); s.run?.(); });
  return b;
}

// ---------- «Примерить на 10 с» ----------

function tryOn(t) {
  if (trial) endTrial(trial.id !== t.themeId);
  const prev = currentThemeId(t.part);
  chooseTheme(t.themeId, t.part);
  if (currentThemeId(t.part) !== t.themeId) return;   // не включилась (например, нужна новее Sono — chooseTheme сказал)
  const note = toast(`«${t.name}» — примерка на ${TRIAL_MS / 1000} с`, {
    duration: TRIAL_MS,
    action: { label: "Оставить", run: () => keep(t) },
  });
  trial = { part: t.part, id: t.themeId, prev, note, timer: setTimeout(() => endTrial(true), TRIAL_MS) };
}

function keep(t) {
  if (!trial) return;
  clearTimeout(trial.timer);
  trial = null;
  toast(`«${t.name}» включена`);
}

/** Конец примерки: back — вернуть прежнюю тему (если её за это время не сменили руками) */
function endTrial(back) {
  const tr = trial;
  if (!tr) return;
  trial = null;
  clearTimeout(tr.timer);
  tr.note.close();
  if (back && currentThemeId(tr.part) === tr.id) chooseTheme(tr.prev, tr.part);
}
