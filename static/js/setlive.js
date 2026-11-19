// «Настройки» на ПК («Живая обложка», шаг 8): 4 раздела вместо 9 — «Вид», «Звук и плеер», «Медиатека»,
// «Сеть и система». Макет — design/ui-new/B-ekrany.html (#settings, #settings-look, #settings-lib, #settings-sys).
// Сами настройки — прежние (settings.js, system.js, local.js, look.js): здесь они только разложены по карточкам.
// Слева — оглавление с поиском «Найти настройку»: он ищет по всем разделам сразу.
// Телефон — прежний экран (settings.js renderSettings); какой показать, решает views.js.

import { EQ_PRESETS, FX_PRESETS, getFx, onFxChange, setFx } from "./audio.js";
import { CHANGELOG } from "./changelog.js";
import { openThemeEditor } from "./editor.js";
import { openFxPanel } from "./fx.js";
import { icons } from "./icons.js";
import { openImportDialog } from "./import.js";
import { checkLibrary, libCheckProblems, libCheckRunning, libCheckSummary, onLibCheck, showLibCheckReport } from "./libcheck.js";
import { localParts } from "./local.js";
import { lookSections, syncLookSections } from "./look.js";
import { rise } from "./motion.js";
import { openView } from "./nav.js";
import { appUpdateStatus, appUpdateText, autoFlowRow, backRow, backupButtons, bgBeatRow, bigBarRow, bookmarkletButtons,
  bookmarkletSteps, calmRow, choiceRow, clipsRow, discordRow, fadeRow, installAppUpdate, libToolsRow, likeTargetRow,
  loadSettingsData, lookForZapret, lyricsRow, net, noAnimRow, normalizeRow, nowBackgroundRow, obsRow, setNetRedraw,
  switchRow, themesRow, tipsRow, trayRow, updateText, vizColorsRow, vizStyleRow, zapretCard } from "./settings.js";
import { sleepNow, startSleep, stopSleep } from "./sleep.js";
import { autostartBlock, cacheBlock, hotkeysBlock } from "./system.js";
import { resetTips } from "./tips.js";
import { el, plural, toast } from "./ui.js";
import { showWelcome, startTour } from "./welcome.js";
import { showWhatsNew } from "./whatsnew.js";

const box = document.getElementById("view-settings");

const TABS = [
  { id: "look", name: "Вид", icon: "palette", d: "Тема, цвет, фон, «Сейчас играет»" },
  { id: "play", name: "Звук и плеер", icon: "eq", d: "Громкость, наложение, эквалайзер, таймер" },
  { id: "lib", name: "Медиатека", icon: "libraryIc", d: "Проверка, импорт, свои файлы" },
  { id: "sys", name: "Сеть и система", icon: "gear", d: "Обход блокировок, трей, обновления" },
];
let tab = "play";           // открытый раздел (как в макете: по умолчанию «Звук и плеер»)
let query = "";             // «Найти настройку»
let netOpen = false;        // «Для опытных» в «Обходе блокировок» развёрнуто
let root = null, h1 = null, kick = null, empty = null;
const panes = {};           // раздел → его колонки

// ---------- Кусочки карточек ----------

/** Карточка: заголовок со значком и строки. words — слова для поиска, которых нет в тексте */
function card(title, icon, rows, { cls = "", words = "" } = {}) {
  const c = el("section", `cfg-card glass${cls ? ` ${cls}` : ""}`);
  const h = el("h3");
  if (icon) {
    const ic = el("span", "cfg-ic");
    ic.innerHTML = icons[icon];
    h.append(ic);
  }
  h.append(title);
  c.append(h, ...rows.filter(Boolean));
  if (words) c.dataset.words = words;
  return c;
}

/** Строка: название и пояснение слева, управление справа (кнопки, точка-статус…) */
function row(title, sub, controls = [], { cls = "", words = "" } = {}) {
  const r = el("div", `cfg-row${cls ? ` ${cls}` : ""}`);
  const text = el("div", "cfg-row-text");
  if (title) text.append(el("b", "", title));
  if (sub) text.append(el("span", "", sub));
  r.append(text, ...controls.filter(Boolean));
  if (words) r.dataset.words = words;
  return r;
}

function button(label, onClick, main = false) {
  const b = el("button", `btn ${main ? "primary" : "ghost"}`, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const dot = (warn) => el("span", `cfg-dot${warn ? " warn" : ""}`);
const words = (node, w) => { node.dataset.words = w; return node; };

/** Подписка, пока карточка на странице: экран перерисовали — старая карточка отписывается сама.
    subscribe(fn) — onFxChange/onLibCheck; возвращает отписку или Set (onFxChange) */
function whileShown(node, subscribe, draw) {
  const fn = () => {
    if (!node.isConnected) { if (typeof off === "function") off(); else off?.delete?.(fn); return; }
    draw();
  };
  const off = subscribe(fn);
}

// ---------- «Вид» ----------

function lookPane(pane) {
  const [theme, color, bg, now, seek, queue] = lookSections(pane);
  [[theme, "тема тёмная светлая как в системе ночь"], [color, "цвет акцент кнопки под обложку"],
    [bg, "фон живая обложка без движения свой фон картинка gif обои однотонный размытие приглушить"],
    [now, "сейчас играет пластинка большой вид"], [seek, "полоска времени волна трека живая перемотка капсула"],
    [queue, "очередь далее справа снизу"]].forEach(([s, w]) => s && words(s, w));
  const more = el("div", "cfg-more-tiles");
  const tile = (title, sub, cls, go, w) => {
    const t = el("button", `cfg-tile ${cls}`);
    t.type = "button";
    t.append(el("b", "", title), el("span", "", sub));
    t.addEventListener("click", go);
    return words(t, w);
  };
  more.append(
    tile("Мастерская", "Темы целиком", "ws", () => openView("workshop"), "мастерская тем темы от слушателей"),
    tile("Редактор тем", "Своя — без кода", "ed", () => openThemeEditor(), "редактор тем своя тема создать"));
  const left = [theme, color, bg, now,
    card("Визуализация", "", [vizStyleRow(), vizColorsRow()], { words: "визуализация под музыку столбики цвета" }),
    card("Темы", "", [themesRow("theme")], { cls: "cfg-themes", words: "тема свои темы мастерская папка тем создать редактор" })];
  const right = [seek, queue,
    card("Движение", "", [bgBeatRow(), calmRow(), noAnimRow()], { words: "анимации движение слабый компьютер эффекты" }),
    more,
    card("Экран «Сейчас играет»", "", [nowBackgroundRow(), lyricsRow(), clipsRow()], { words: "сейчас играет фон текст песни клип" }),
    card("Виды «Сейчас играет» из тем", "", [themesRow("now")], { cls: "cfg-themes", words: "вид сейчас играет мастерская" }),
    card("Окно и медиатека", "", [bigBarRow("Большая капсула плеера", "Крупнее обложка, название и кнопки в плеере внизу."),
      backRow(), libToolsRow()], { words: "нижний плеер капсула назад папки фильтры медиатека" })];
  return [left, right];
}

// ---------- «Звук и плеер» ----------

const sameEq = (a, b) => a.every((g, i) => g === b[i]);

function eqCard() {
  const c = card("Эквалайзер и эффекты", "eq", [], { words: "эквалайзер эффекты басы slowed nightcore реверб скорость пресеты" });
  const draw = () => {
    const fx = getFx();
    const preset = EQ_PRESETS.find((p) => sameEq(fx.eq, p.eq));
    const bars = el("button", "cfg-eq");
    bars.type = "button";
    bars.title = "Открыть эквалайзер";
    bars.append(...fx.eq.map((g) => {
      const i = el("i");
      i.style.height = `${Math.round(30 + ((g + 12) / 24) * 70)}%`;
      return i;
    }));
    bars.addEventListener("click", () => openFxPanel(bars));
    const chips = el("div", "cfg-chips");
    for (const p of EQ_PRESETS) {
      const b = el("button", p === preset ? "on" : "", p.name);
      b.type = "button";
      b.addEventListener("click", () => setFx({ eq: p.eq }));
      chips.append(b);
    }
    const fxp = FX_PRESETS.find((p) => Object.keys(p.fx).every((k) => fx[k] === p.fx[k]));
    const fxText = fxp === FX_PRESETS[0] ? `Выключены. Можно ${FX_PRESETS.slice(1, 3).map((p) => `«${p.name}»`).join(", ")}, скорость, реверберация, бас-буст`
      : `Сейчас: «${fxp?.name ?? "свои"}»`;
    const open = button("Открыть", (e) => openFxPanel(e.currentTarget));
    c.replaceChildren(c.firstChild,
      row("Эквалайзер", `Сейчас: «${preset?.name ?? "Свой"}»`, [bars]),
      row("Пресеты", "", [], { cls: "wrap" }),
      row("Эффекты", fxText, [open]));
    c.children[2].append(chips);
  };
  draw();
  whileShown(c, onFxChange, draw);
  return c;
}

const SLEEP = [[0, "Выкл"], [15, "15 мин"], [30, "30 мин"], [60, "1 ч"], ["track", "Конец трека"]];

function sleepCard() {
  const c = card("Таймер сна", "moon", [], { words: "таймер сна выключить музыку ночь" });
  const seg = el("div", "seg cfg-seg");
  const r = row("Остановить музыку", "", [], { cls: "wrap" });
  r.append(seg);
  for (const [v, label] of SLEEP) {
    const b = el("button", "seg-btn", label);
    b.type = "button";
    b.dataset.v = v;
    b.addEventListener("click", () => (v ? startSleep(v) : stopSleep()));
    seg.append(b);
  }
  const draw = () => {
    const now = sleepNow();
    seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", String(now ? now.picked : 0) === b.dataset.v));
    r.querySelector(".cfg-row-text span")?.remove();
    r.querySelector(".cfg-row-text").append(el("span", "", !now ? "Мягко затихнет в конце"
      : now.picked === "track" ? "Выключится в конце трека" : `Выключится через ${now.left} мин`));
  };
  c.append(r);
  draw();
  whileShown(c, (fn) => { document.addEventListener("sono:sleep", fn); return () => document.removeEventListener("sono:sleep", fn); }, draw);
  return c;
}

function playPane() {
  return [
    [card("Громкость", "vol", [normalizeRow(), words(fadeRow(), "кроссфейд переход между треками")], { words: "громкость звук" }), eqCard()],
    [card("Очередь и сердечко", "heart", [likeTargetRow(), autoFlowRow()], { words: "лайк избранное сердечко flow очередь" }), sleepCard()],
  ];
}

// ---------- «Медиатека» ----------

function checkCard() {
  const c = card("Проверка медиатеки", "spark", [], { words: "проверка медиатеки удалили не открываются замена" });
  const text = el("div", "cfg-row-text");
  const st = dot(false);
  const head = el("div", "cfg-row");
  head.append(text, st);
  const again = button("Проверить сейчас", () => checkLibrary({ force: true }));
  const more = button("Подробнее", showLibCheckReport, true);
  const acts = el("div", "cfg-row cfg-acts");
  acts.append(more, again);
  c.append(head, acts);
  const sync = () => {
    const bad = libCheckProblems();
    text.replaceChildren(el("b", "", libCheckSummary()), el("span", "", "Раз в несколько дней Sono сам проверяет, не удалили ли треки "
      + "из избранного и плейлистов с YouTube и SoundCloud, и заранее находит им другую загрузку — название и обложка остаются прежними."));
    st.classList.toggle("warn", !!bad);
    st.hidden = libCheckRunning();
    again.disabled = libCheckRunning();
    again.textContent = libCheckSummary().startsWith("Ещё") ? "Проверить сейчас" : "Проверить ещё раз";
    more.hidden = !bad;
    more.textContent = bad ? `Показать ${plural(bad, "трек", "трека", "треков")}` : "Подробнее";
  };
  whileShown(c, onLibCheck, sync);
  sync();
  return c;
}

function importCard() {
  const onOpen = (id) => openView(`playlist:${id}`);
  return card("Перенести музыку", "upload", [
    row("Плейлист или альбом по ссылке", "Яндекс Музыка, Spotify, YouTube, SoundCloud — или просто список треков. Sono найдёт те же песни.",
      [button("Вставить ссылку", () => openImportDialog({ onOpen }))], { words: "импорт ссылка плейлист spotify яндекс список" }),
    row("Переезд целиком", "Все плейлисты, лайки и подписки — из Яндекс Музыки или со SoundCloud.",
      [button("Яндекс Музыка", () => openImportDialog({ yandex: true, onOpen })),
        button("SoundCloud", () => openImportDialog({ move: "soundcloud", onOpen }))], { cls: "wrap", words: "переезд импорт яндекс soundcloud лайки" }),
  ]);
}

function localCard() {
  const c = card("Свои файлы", "disc", [], { words: "свои файлы мои файлы папки с музыкой mp3 flac компьютер" });
  const [folders, status, buttons] = localParts(c);
  status.className = "cfg-sub";   // «Папок пока нет» / «Треков: N» — пояснением под названием строки
  buttons.className = "cfg-btns";
  buttons.querySelector(".btn.primary")?.classList.replace("primary", "ghost");   // как в макете — обычная кнопка
  const r = row("Папки с музыкой", "", [buttons]);
  r.querySelector(".cfg-row-text").append(status);
  c.append(r, folders, el("p", "set-hint", "mp3, flac, m4a, ogg и другие — подпапки тоже просмотрятся. Треки появятся в медиатеке "
    + "в разделе «Мои файлы» и будут играть без интернета."));
  return c;
}

function backupCard() {
  const result = el("div", "set-result-line");
  const [save, load, picker] = backupButtons(result, { saveLabel: "Сохранить", restoreLabel: "Загрузить" });
  const btns = el("div", "cfg-btns");
  btns.append(save, load, picker);
  return card("Резервная копия", "pin", [
    row("Сохранить медиатеку в файл", "Плейлисты, «Избранное», история — чтобы перенести на другой компьютер или телефон или восстановить после переустановки.",
      [btns], { cls: "wrap" }),
    result,
    el("p", "set-hint", "Загрузка ничего не удаляет: новое добавляется к тому, что уже есть. Поделиться отдельным плейлистом — «⋯» у плейлиста → «Поделиться»."),
  ], { words: "резервная копия бэкап экспорт восстановить файл перенести" });
}

function browserCard() {
  const btns = el("div", "cfg-btns");
  btns.append(...bookmarkletButtons());
  return card("Из браузера", "link", [
    row("Кнопка «+ Sono» на панели закладок", "Нашли трек на YouTube или SoundCloud в браузере? Нажмите её — трек включится в Sono, "
      + "а если что-то уже играет, встанет следующим. Ссылку можно и просто вставить в поиск Sono.", [btns], { cls: "wrap" }),
    bookmarkletSteps(),
  ], { words: "браузер закладка + sono букмарклет chrome" });
}

function libPane() {
  return [[checkCard(), importCard()], [localCard(), backupCard(), browserCard()]];
}

// ---------- «Сеть и система» ----------

function netBody(c) {
  const cfg = net.config;
  const shown = net.proxyDraft ? "proxy" : cfg.mode;
  const modes = net.modes();
  const mode = modes.find((m) => m.value === shown) ?? modes[0];
  const seg = el("div", "seg cfg-seg");
  const SHORT = { bypass: "Встроенный", proxy: "Свой прокси", off: "Выключен" };
  for (const m of modes) {
    const b = el("button", `seg-btn${m.value === shown ? " on" : ""}`, SHORT[m.value] ?? m.title);
    b.type = "button";
    b.disabled = !!net.saving;
    b.title = m.text;
    b.addEventListener("click", () => pickMode(m));
    seg.append(b);
  }
  const rows = [row("Режим", net.saving ? "Сохраняю…" : `${mode.title}${mode.badge ? " — рекомендуем" : ""}. ${mode.text}`, [], { cls: "wrap", words: "режим встроенный обход выключен напрямую" })];
  rows[0].append(seg);
  if (shown === "proxy") {
    const form = el("form", "set-proxy");
    const input = el("input", "dialog-input");
    input.placeholder = "socks5://127.0.0.1:1080";
    input.value = cfg.proxy || "";
    input.spellcheck = false;
    form.append(input, button("Сохранить", () => {}, true));
    form.lastChild.type = "submit";
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await net.save({ mode: "proxy", proxy: input.value });
        net.proxyDraft = false;
        toast("Прокси сохранён");
        redrawNet();
      } catch (err) { toast(err.message, { error: true }); }
    });
    const r = row("Адрес прокси", "Есть в настройках вашего VPN или прокси-программы (раздел «Прокси», «SOCKS5» или «HTTP»).", [], { cls: "wrap", words: "прокси socks vpn адрес" });
    r.append(form);
    rows.push(r);
  }
  const test = button(net.testing ? "Замеряю… (до минуты)" : "Подобрать лучший способ", () => net.test());
  test.disabled = net.testing;
  rows.push(row("Если тормозит", "Sono проверит каждый способ на YouTube и SoundCloud и покажет, какой быстрее.", [test], { words: "замер скорость подобрать способ" }));
  if (net.lastTest) rows.push(net.results());

  // Для опытных: способы, «Мимо VPN», zapret
  const more = el("button", `cfg-more${netOpen ? " open" : ""}`);
  more.type = "button";
  more.innerHTML = `<span>Для опытных: ${shown === "bypass" ? "способы обхода, " : ""}${shown !== "proxy" ? "«мимо VPN», " : ""}zapret</span>${icons.chevron}`;
  more.addEventListener("click", () => { netOpen = !netOpen; redrawNet(); });
  const adv = el("div", "cfg-adv");
  adv.hidden = !netOpen;
  if (shown === "bypass") {
    const strategyRow = (key, title) => {
      const s = el("div", "seg cfg-seg");
      for (const [name, label] of Object.entries(net.strategies)) {
        const b = el("button", `seg-btn${cfg[key] === name ? " on" : ""}`, label);
        b.type = "button";
        b.addEventListener("click", async () => {
          try { await net.save({ [key]: name }); } catch (err) { toast(err.message, { error: true }); }
          redrawNet();
        });
        s.append(b);
      }
      const r = row(title, "", [], { cls: "wrap", words: "способ обхода стратегия подделка" });
      r.append(s);
      return r;
    };
    adv.append(strategyRow("strategy", "Способ для YouTube"), strategyRow("strategySc", "Способ для SoundCloud"),
      el("p", "set-hint", "У разных провайдеров срабатывают разные способы. Не знаете какой — «Подобрать лучший способ». "
        + "«Подделка» — против заморозки SoundCloud: открывается, но трек не грузится."));
  }
  if (shown !== "proxy") {
    const sub = cfg.direct
      ? (net.card ? `Плеер ходит в интернет прямо через сетевую карту (${net.card}), в обход VPN. Остальные программы — как раньше.`
        : "Не нашёл сетевую карту — плеер ходит как обычно.")
      : "Если на компьютере включён VPN, а музыку хочется слушать без него (или проверить, как работает обход без VPN).";
    adv.append(words(switchRow("Мимо VPN", sub, !!cfg.direct, async (on) => {
      try {
        await net.save({ direct: on });
        toast(on ? (net.card ? "Плеер ходит мимо VPN" : "Сетевая карта не найдена") : "Плеер ходит как обычно");
      } catch (err) { toast(err.message, { error: true }); }
      redrawNet();
    }), "vpn мимо сетевая карта"));
  }
  adv.append(words(zapretCard(), "zapret запрет flowseal служба стратегия"));
  c.replaceChildren(c.firstChild, ...rows, more, adv);
}

async function pickMode(m) {
  if (net.saving) return;
  // Адреса прокси ещё нет — сначала просим его ввести (на сервере пока остаётся прежний режим)
  if (m.value === "proxy" && !net.config.proxy) {
    net.proxyDraft = true;
    redrawNet();
    root?.querySelector(".cfg-net .set-proxy input")?.focus();
    return;
  }
  net.proxyDraft = false;
  if (net.config.mode === m.value) { redrawNet(); return; }
  net.saving = m.value;
  redrawNet();
  try {
    await net.save({ mode: m.value });
    toast(`Обход: ${m.title.toLowerCase()}`);
  } catch (err) { toast(err.message, { error: true }); }
  net.saving = null;
  redrawNet();
}

function redrawNet() {
  const c = root?.querySelector(".cfg-net");
  if (!c) return;
  netBody(c);
  if (query) filter();
}

function updatesCard() {
  const app = el("div", "cfg-row");
  const ytdlp = el("div", "cfg-row");
  let dismissed = false;   // «Не сейчас» — вопрос прячется до следующей проверки
  const drawApp = (u) => {
    const version = !u ? (CHANGELOG[0]?.version ?? "?") : u.current === "0" ? "(из исходников)" : u.current;
    const asking = u && ["available", "ready"].includes(u.state);
    const text = el("div", "cfg-row-text");
    text.append(el("b", "", `Sono ${version}`), el("span", "", asking && dismissed ? `Есть версия ${u.latest}.` : appUpdateText(u)));
    app.replaceChildren(text);
    if (asking && !dismissed) {
      app.append(button("Обновить", () => installAppUpdate(drawApp), true), button("Не сейчас", () => { dismissed = true; pollApp(); }));
    } else if (u?.enabled && !["downloading", "installing", "checking"].includes(u?.state)) {
      app.append(button("Проверить", async () => { dismissed = false; await fetch("/api/app-update/check", { method: "POST" }); setTimeout(pollApp, 300); }));
    }
    if (u) app.append(dot(asking || u.state === "error"));
  };
  const pollApp = async () => {
    const u = await appUpdateStatus();
    drawApp(u);
    if (u && ["checking", "downloading"].includes(u.state) && app.isConnected) setTimeout(pollApp, 700);
  };
  const drawYt = (u) => {
    const text = el("div", "cfg-row-text");
    text.append(el("b", "", `Движок YouTube (yt-dlp) ${u?.current ?? ""}`.trim()), el("span", "", updateText(u) || "Проверяю…"));
    ytdlp.replaceChildren(text, button("Проверить", async () => { await fetch("/api/update/check", { method: "POST" }); setTimeout(pollYt, 300); }));
    if (u) ytdlp.append(dot(u.state === "error"));
  };
  const pollYt = async () => {
    const u = await (await fetch("/api/update")).json().catch(() => null);
    drawYt(u);
    if (u && ["checking", "downloading"].includes(u.state) && ytdlp.isConnected) setTimeout(pollYt, 1000);
  };
  drawApp(null);
  drawYt(null);
  pollApp();
  pollYt();
  return card("Обновления", "upload", [app, ytdlp,
    el("p", "set-hint", "Sono сам узнаёт о новой версии и спрашивает, обновиться ли. yt-dlp — часть, которая достаёт музыку, — "
      + "ломается чаще всего (YouTube часто меняет сайт), поэтому его свежая версия скачивается сама, при каждом запуске.")],
  { words: "обновления версия yt-dlp движок обновить" });
}

function introCard() {
  const btns = el("div", "cfg-btns");
  btns.append(button("Что нового", () => showWhatsNew(CHANGELOG.slice(0, 3))), button("Приветствие", showWelcome),
    button("Экскурсия по Sono", startTour),
    button("Подсказки заново", () => { resetTips(); toast("Подсказки появятся снова, когда вы встретите функции"); }));
  return card("Знакомство с Sono", "info", [tipsRow(),
    row("Пройти ещё раз", "Приветствие, экскурсия по экранам и пояснения к функциям.", [btns], { cls: "wrap" })],
  { words: "знакомство подсказки приветствие экскурсия что нового" });
}

function sysPane() {
  const netC = card("Обход блокировок", "spark", [], { cls: "cfg-net", words: "обход блокировок youtube soundcloud тормозит замедляют" });
  netBody(netC);
  return [
    [netC, card("Окно и трей", "windowIc", [words(trayRow(), "трей крестик закрыть"), words(autostartBlock(switchRow), "автозапуск windows"),
      words(hotkeysBlock(switchRow), "горячие клавиши глобальные медиаклавиши")], { words: "окно трей" }),
    card("Кэш на диске", "folder", [cacheBlock(choiceRow)], { words: "кэш диск место очистить предел гб" })],
    [updatesCard(), card("Discord и стрим", "mic", [discordRow(), obsRow()], { words: "discord дискорд статус obs стрим трансляция" }), introCard()],
  ];
}

// ---------- Поиск по настройкам ----------

const norm = (s) => s.toLowerCase().replace(/ё/g, "е");

/** «Найти настройку»: показать только то, где есть все слова запроса — по всем разделам сразу.
    Совпала тема карточки (заголовок или её слова) — карточка целиком, иначе — только совпавшие строки */
function filter() {
  const q = norm(query.trim()).split(/\s+/).filter(Boolean);
  const has = (text) => { const hay = norm(text); return q.every((w) => hay.includes(w)); };
  const fits = (node) => has(`${node.textContent} ${node.dataset?.words ?? ""}`);
  root.classList.toggle("searching", !!q.length);
  let found = 0;
  for (const t of TABS) {
    const pane = panes[t.id];
    let inPane = 0;
    pane.querySelectorAll(".cfg-card, .lk-sec, .cfg-more-tiles").forEach((c) => {
      const title = c.querySelector(":scope > h3");
      const parts = [...c.children].filter((n) => n !== title);
      parts.forEach((p) => p.classList.remove("cfg-hide"));
      c.querySelectorAll(".cfg-adv > *").forEach((n) => n.classList.remove("cfg-hide"));
      if (!q.length) { c.hidden = false; return; }
      const whole = has(`${title?.textContent ?? ""} ${c.dataset.words ?? ""}`);
      let shown = 0;
      for (const p of parts) {
        if (p.classList.contains("cfg-more")) { p.classList.add("cfg-hide"); continue; }   // «Для опытных» при поиске раскрыто
        if (p.classList.contains("cfg-adv")) {
          const inner = [...p.children].filter((n) => whole || fits(n));
          [...p.children].forEach((n) => n.classList.toggle("cfg-hide", !inner.includes(n)));
          p.hidden = !inner.length;
          shown += inner.length;
          continue;
        }
        const ok = whole || fits(p);
        p.classList.toggle("cfg-hide", !ok);
        if (ok) shown++;
      }
      c.hidden = !shown;
      if (shown) inPane++;
    });
    pane.hidden = q.length ? !inPane : t.id !== tab;
    found += inPane;
  }
  if (!q.length) root.querySelectorAll(".cfg-adv").forEach((a) => { a.hidden = !netOpen; });
  empty.hidden = !q.length || !!found;
  drawHead();
  if (!panes.look.hidden) syncLookSections();   // бегунок «Тёмная/Светлая» меряется только на видимом
}

function drawHead() {
  const t = TABS.find((x) => x.id === tab);
  kick.textContent = "Настройки";
  h1.textContent = query.trim() ? "Поиск" : t.name;
  root.querySelectorAll(".cfg-tab").forEach((b) => b.classList.toggle("on", !query.trim() && b.dataset.tab === tab));
}

// ---------- Экран ----------

function showTab(id, { animate = true } = {}) {
  tab = id;
  if (query) { query = ""; root.querySelector(".cfg-find input").value = ""; }
  filter();
  box.closest(".views")?.scrollTo?.({ top: 0 });
  if (animate) panes[id].querySelectorAll(".cfg-card, .lk-sec, .cfg-more-tiles").forEach((c, i) => rise(c, 30 + Math.min(i, 8) * 40, 14, 500));
}

function build() {
  root = el("div", "cfg");
  const nav = el("aside", "cfg-nav glass");
  const find = el("label", "cfg-find");
  find.innerHTML = icons.search;
  const input = el("input");
  input.placeholder = "Найти настройку";
  input.spellcheck = false;
  input.addEventListener("input", () => { query = input.value; filter(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) { e.stopPropagation(); input.value = ""; query = ""; filter(); }
  });
  find.append(input);
  nav.append(find);
  for (const t of TABS) {
    const b = el("button", "cfg-tab");
    b.type = "button";
    b.dataset.tab = t.id;
    const ic = el("span", "cfg-tab-ic");
    ic.innerHTML = icons[t.icon];
    const text = el("div");
    text.append(el("b", "", t.name), el("span", "", t.d));
    b.append(ic, text);
    b.addEventListener("click", () => showTab(t.id));
    nav.append(b);
  }
  const foot = el("div", "cfg-foot");
  const ver = el("span", "", `Sono ${CHANGELOG[0]?.version ?? ""}`);
  appUpdateStatus().then((u) => {
    if (!u) return;
    const v = u.current && u.current !== "0" ? u.current : CHANGELOG[0]?.version;
    const state = ["available", "ready"].includes(u.state) ? ` · есть версия ${u.latest}` : u.state === "uptodate" ? " · последняя версия" : "";
    ver.textContent = `Sono ${v}${state}`;
  });
  const link = (icon, text, go) => {
    const a = el("button", "cfg-foot-link");
    a.type = "button";
    a.innerHTML = icons[icon];
    a.append(text);
    a.addEventListener("click", go);
    return a;
  };
  foot.append(ver, link("spark", "Что нового", () => showWhatsNew(CHANGELOG.slice(0, 3))), link("info", "Экскурсия по Sono", startTour));
  nav.append(foot);

  const body = el("div", "cfg-body");
  const hd = el("div", "live-hd");
  const hdl = el("div", "live-hd-l");
  kick = el("div", "live-kick");
  h1 = el("h1", "live-h1");
  hdl.append(kick, h1);
  hd.append(hdl);
  body.append(hd);
  const builders = { look: lookPane, play: playPane, lib: libPane, sys: sysPane };
  for (const t of TABS) {
    const pane = el("div", "cfg-pane");
    pane.dataset.tab = t.id;
    pane.append(el("h2", "cfg-pane-h", t.name));   // видно только в поиске
    const cols = el("div", "cfg-cols");
    // Две колонки как в макете; в узком окне — одна: сначала левая, потом правая (как CSS columns в макете)
    for (const list of builders[t.id](pane)) {
      const col = el("div", "cfg-col");
      col.append(...list);
      cols.append(col);
    }
    pane.append(cols);
    panes[t.id] = pane;
    body.append(pane);
  }
  empty = el("div", "cfg-empty");
  empty.append(el("b", "", "Ничего не нашлось"), el("span", "", "Попробуйте другое слово — например, «трей», «кэш» или «zapret»."));
  body.append(empty);
  root.append(nav, body);
  box.replaceChildren(root);
}

let pendingGo = null;   // куда перейти, когда экран нарисуется

function go(where) {
  if (where === "zapret") {
    netOpen = true;
    showTab("sys");
    redrawNet();
    setTimeout(() => root.querySelector(".zapret-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  }
}

/** Показать «Настройки» на ПК. Медиатеку не трогает: пишется только то, что человек сам переключил */
export async function renderSettingsLive() {
  if (!(await loadSettingsData())) return;
  setNetRedraw(redrawNet);
  build();
  showTab(tab, { animate: false });
  lookForZapret();
  if (pendingGo) { go(pendingGo); pendingGo = null; }
}

/** Открыть нужное место настроек (например, «У меня есть zapret» в приветствии) */
document.addEventListener("sono:settings-go", (e) => {
  if (root?.isConnected && !box.hidden) go(e.detail);
  else pendingGo = e.detail;
});
