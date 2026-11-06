// Экран «Настройки»: обход блокировок, автонастройка zapret и перенос медиатеки.

import { fadeSeconds, normalizeEnabled, setFadeSeconds, setNormalize } from "./audio.js";
import { clipsEnabled, setClipsEnabled } from "./clip.js";
import { autoFlowEnabled } from "./flow.js";
import { NOW_BACKGROUNDS, nowBackground, setNowBackground } from "./nowbg.js";
import { localSection } from "./local.js";
import { LYRICS_STYLES, lyricsStyle, setLyricsStyle } from "./lyrics.js";
import { icons } from "./icons.js";
import { getSetting, lib, likeTarget, likeTargetName, motionOff, setSetting } from "./library.js";
import { setMinibarLarge, syncLikeButtons } from "./player.js";
import { presenceEnabled, updatePresence } from "./presence.js";
import { el, openMenu, syncAllRows, toast } from "./ui.js";
import { VIZ_PRESETS, applyVizColors, paletteFor, refreshViz, vizColorsSetting, vizEnabled } from "./viz.js";
import { showWelcome, startTour } from "./welcome.js";
import { CHANGELOG } from "./changelog.js";
import { showWhatsNew } from "./whatsnew.js";

const box = document.getElementById("view-settings");
let network = null;      // { mode, strategy, strategySc, fakeTtl, proxy }
let strategies = {};     // способ → подпись
let lastTest = null;     // результаты замера
let testing = false;

const MODES = [
  { value: "bypass", title: "Встроенный обход", badge: "Рекомендуем",
    text: "Плеер сам прячет от провайдера, куда идёт соединение, — как zapret, но только для плеера. Без драйверов и прав администратора." },
  { value: "proxy", title: "Свой прокси",
    text: "Если у вас есть VPN или прокси — укажите его адрес, и плеер будет ходить в интернет через него." },
  { value: "off", title: "Выключен",
    text: "Напрямую. Подходит, если у вас уже настроен zapret или VPN на весь компьютер." },
];

async function saveNetwork(change) {
  const res = await fetch("/api/network", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "не сохранилось");
  network = data.config;
}

const label = (name) => (name === "off" ? "Напрямую" : name === "proxy" ? "Свой прокси" : strategies[name] ?? name);

// ---------- Раздел «Обход блокировок» ----------

function networkSection() {
  const section = el("section", "set-card");
  section.append(el("h2", "", "Обход блокировок"),
    el("p", "set-text", "Если YouTube или SoundCloud тормозят или не открываются. Влияет только на плеер — остальные программы работают как обычно."));

  // Режимы — карточками
  const modes = el("div", "set-modes");
  for (const mode of MODES) {
    const card = el("button", `set-mode${network.mode === mode.value ? " on" : ""}`);
    card.type = "button";
    const head = el("div", "set-mode-head");
    head.append(el("span", "set-radio"), el("span", "set-mode-title", mode.title));
    card.append(head);
    if (mode.badge) card.append(el("span", "set-badge", mode.badge));
    card.append(el("p", "", mode.text));
    card.addEventListener("click", async () => {
      if (network.mode === mode.value) return;
      if (mode.value === "proxy" && !network.proxy) {   // адреса ещё нет — сначала просим его ввести
        network = { ...network, mode: "proxy" };
        render();
        box.querySelector(".set-proxy input")?.focus();
        return;
      }
      try {
        await saveNetwork({ mode: mode.value });
        toast(`Обход: ${mode.title.toLowerCase()}`);
      } catch (err) { toast(err.message, { error: true }); }
      render();
    });
    modes.append(card);
  }
  section.append(modes);

  // Детали выбранного режима
  if (network.mode === "bypass") {
    // Способ — свой для YouTube и для SoundCloud: SoundCloud провайдеры замораживают иначе
    const strategyRow = (key) => {
      const seg = el("div", "seg set-strategies");
      for (const [name, title] of Object.entries(strategies)) {
        const btn = el("button", `seg-btn${network[key] === name ? " on" : ""}`, title);
        btn.type = "button";
        btn.addEventListener("click", async () => {
          try { await saveNetwork({ [key]: name }); } catch (err) { toast(err.message, { error: true }); }
          render();
        });
        seg.append(btn);
      }
      return seg;
    };
    section.append(el("div", "set-label", "Способ для YouTube"), strategyRow("strategy"),
      el("div", "set-label", "Способ для SoundCloud"), strategyRow("strategySc"),
      el("p", "set-hint", "У разных провайдеров срабатывают разные способы. Не знаете какой — нажмите «Подобрать лучший способ». "
        + "«Подделка» — против заморозки SoundCloud: открывается, но трек не грузится."));
  }
  if (network.mode === "proxy") {
    const row = el("form", "set-proxy");
    const input = el("input", "dialog-input");
    input.placeholder = "socks5://127.0.0.1:1080";
    input.value = network.proxy || "";
    input.spellcheck = false;
    const save = el("button", "btn primary", "Сохранить");
    row.append(input, save);
    row.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await saveNetwork({ mode: "proxy", proxy: input.value });
        toast("Прокси сохранён");
        render();
      } catch (err) { toast(err.message, { error: true }); }
    });
    section.append(el("div", "set-label", "Адрес прокси"), row,
      el("p", "set-hint", "Адрес есть в настройках вашего VPN или прокси-программы (раздел «Прокси», «SOCKS5» или «HTTP»)."));
  }

  // Замер скорости
  const testRow = el("div", "set-test-row");
  const testBtn = el("button", "btn ghost set-test-btn", testing ? "Замеряю… (до минуты)" : "Подобрать лучший способ");
  testBtn.type = "button";
  testBtn.disabled = testing;
  testBtn.addEventListener("click", runTest);
  testRow.append(testBtn);
  section.append(testRow);
  if (lastTest) section.append(testResults());
  return section;
}

const sameNetwork = (a) => a.mode === network.mode && (a.mode !== "bypass"
  || (a.strategy === network.strategy && a.strategySc === network.strategySc && a.fakeTtl === network.fakeTtl));

function testResults() {
  const { results, best, error } = lastTest;
  const wrap = el("div", "set-results");
  if (error) {
    wrap.append(el("p", "import-error", error));
    return wrap;
  }
  const max = Math.max(...results.map((r) => r.youtube || 0), 0.1);
  for (const r of results) {
    const isBest = best && (best.mode === "proxy" ? r.name === "proxy" : r.name === best.strategy || r.name === best.strategySc);
    const row = el("div", `set-result${isBest ? " best" : ""}`);
    const bar = el("div", "set-bar");
    const fill = el("i");
    fill.style.width = `${((r.youtube || 0) / max) * 100}%`;
    bar.append(fill);
    row.append(el("span", "set-result-name", label(r.name)), bar,
      el("span", "set-result-num", r.youtube ? `${r.youtube} МБ/с` : "не работает"),
      el("span", "set-result-sc", r.soundcloud ? `SC ${r.soundcloud} мс` : "SC —"));
    wrap.append(row);
  }
  if (!best) {
    wrap.append(el("p", "set-hint", "Ни YouTube, ни SoundCloud не открылись ни одним способом. Попробуйте «Свой прокси» с адресом из вашего VPN."));
    return wrap;
  }
  const direct = results.find((r) => r.name === "off");
  const notes = [];
  if (best.mode === "proxy") notes.push("Лучше всего — через ваш прокси.");
  else {
    notes.push(`YouTube — «${label(best.strategy)}», SoundCloud — «${label(best.strategySc)}».`);
    if (!results.some((r) => r.youtube)) notes.push("YouTube не открылся ни одним способом.");
    if (!results.some((r) => r.soundcloud)) notes.push("SoundCloud не открылся ни одним способом.");
    if (direct?.youtube && direct?.soundcloud) notes.push("Напрямую и так всё работает — обход вам, скорее всего, не нужен (но и не мешает).");
  }
  wrap.append(el("p", "set-hint", notes.join(" ")));
  if (!sameNetwork(best)) {
    const use = el("button", "btn primary", "Включить лучшее");
    use.type = "button";
    use.addEventListener("click", async () => {
      await saveNetwork(best);
      toast("Включено лучшее по замеру");
      render();
    });
    wrap.append(use);
  }
  return wrap;
}

async function runTest() {
  testing = true;
  render();
  try {
    const res = await fetch("/api/network/test", { method: "POST" });
    const data = await res.json();
    lastTest = res.ok ? data : { error: data.error || "замер не удался" };
  } catch (err) {
    lastTest = { error: err.message };
  }
  testing = false;
  render();
}

// ---------- Раздел «Оформление»: визуализация и статус в Discord ----------

let presenceInfo = null;   // { available, connected, error } — с сервера

function switchRow(title, text, on, onToggle) {
  const row = el("label", "set-switch");
  const textBox = el("span", "set-switch-text");
  textBox.append(el("span", "set-switch-title", title), el("span", "set-switch-sub", text));
  const input = el("input");
  input.type = "checkbox";
  input.checked = on;
  input.addEventListener("change", () => onToggle(input.checked));
  row.append(textBox, input, el("span", "set-switch-knob"));
  return row;
}

function appearanceSection() {
  const section = el("section", "set-card");
  section.append(el("h2", "", "Оформление"));
  section.append(switchRow("Большой нижний плеер",
    "Крупнее обложка, название и кнопки — удобнее, если плеер внизу нужен под рукой.",
    !!getSetting("minibarLarge", false), (on) => { setSetting("minibarLarge", on); setMinibarLarge(on); }));
  // Медиатека как в Spotify: папки, фильтр «Плейлисты / Исполнители», поиск и сортировка (libtools.js)
  section.append(switchRow("Папки и фильтры в медиатеке",
    "Папки для плейлистов, подписки на исполнителей, поиск и сортировка над медиатекой. Выключите — будет простой список.",
    getSetting("libTools", true) !== false, (on) => setSetting("libTools", on)));
  section.append(switchRow("Визуализация под музыку",
    "Эквалайзер цветов обложки за экраном «Сейчас играет» — двигается по настоящему звуку.",
    vizEnabled(), (on) => { setSetting("visualizer", on); refreshViz(); }));
  section.append(vizColorsRow());
  section.append(nowBackgroundRow());
  section.append(choiceRow("Текст песни", LYRICS_STYLES, lyricsStyle, setLyricsStyle));
  section.append(switchRow("Без анимаций",
    "Для слабых компьютеров: ничего не движется само — без плавных переходов, визуализации и живых фонов. "
      + "Sono работает так же, только меньше нагружает компьютер.",
    motionOff(), (on) => { setSetting("reduceMotion", on); applyMotion(); refreshViz(); }));
  section.append(switchRow("Клипы вместо обложки",
    "Если у трека есть официальный клип на YouTube, на «Сейчас играет» вместо обложки идёт он — без звука, вместе с музыкой. "
      + "Берёт больше интернета (примерно 2–4 МБ в минуту).",
    clipsEnabled(), (on) => setClipsEnabled(on)));

  const p = presenceInfo;
  const status = !p ? "" : !p.available ? "Пока не подключено: нужен id приложения Discord (см. README)."
    : p.connected ? "Discord подключён." : `Discord не найден${p.error ? ` (${p.error})` : ""} — запустите его, плеер подключится сам.`;
  section.append(switchRow("Статус в Discord",
    `Друзья видят, что вы слушаете: название, исполнитель, обложка. ${status}`,
    presenceEnabled(), (on) => { setSetting("discord", on); updatePresence(0); }));
  return section;
}

/** Строка выбора из нескольких вариантов (кнопки-сегменты) с подсказкой под названием */
function choiceRow(title, options, current, choose) {
  const row = el("div", "set-switch set-choice");
  const text = el("span", "set-switch-text");
  const sub = el("span", "set-switch-sub");
  text.append(el("span", "set-switch-title", title), sub);
  const seg = el("div", "seg");
  const draw = () => {
    const on = current();
    sub.textContent = options.find((o) => o.id === on)?.hint ?? "";
    seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.id === on));
  };
  for (const o of options) {
    const btn = el("button", "seg-btn", o.title);
    btn.type = "button";
    btn.dataset.id = o.id;
    btn.title = o.hint;
    btn.addEventListener("click", () => { choose(o.id); draw(); });
    seg.append(btn);
  }
  draw();
  row.append(text, seg);
  return row;
}

/** Фон «Сейчас играет»: Свет (по умолчанию) / Тихий / Градиент */
function nowBackgroundRow() {
  const row = el("div", "set-switch set-choice");
  const text = el("span", "set-switch-text");
  const sub = el("span", "set-switch-sub");
  text.append(el("span", "set-switch-title", "Фон «Сейчас играет»"), sub);
  const seg = el("div", "seg");
  const draw = () => {
    const on = nowBackground();
    sub.textContent = NOW_BACKGROUNDS.find((b) => b.id === on).hint;
    seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.id === on));
  };
  for (const b of NOW_BACKGROUNDS) {
    const btn = el("button", "seg-btn", b.title);
    btn.type = "button";
    btn.dataset.id = b.id;
    btn.title = b.hint;
    btn.addEventListener("click", () => { setNowBackground(b.id); draw(); });
    seg.append(btn);
  }
  draw();
  row.append(text, seg);
  return row;
}

/** Цвета визуализации: кружки-образцы наборов + «Свои» (два цвета, перелив от первого ко второму) */
function vizColorsRow() {
  const row = el("div", "set-viz-colors");
  const textBox = el("span", "set-switch-text");
  textBox.append(el("span", "set-switch-title", "Цвета визуализации"),
    el("span", "set-switch-sub", "По умолчанию столбики берут цвета обложки. Можно выбрать свой набор — он не меняется от трека к треку."));
  const swatches = el("div", "viz-swatches");
  const pickers = el("div", "viz-pickers");
  const saved = vizColorsSetting();
  let custom = (saved && saved.custom) || getSetting("vizCustom", ["#ff3d7f", "#5b8cff"]);
  const selected = () => (typeof vizColorsSetting() === "object" ? "custom" : vizColorsSetting());
  const gradient = (cols) => `linear-gradient(135deg, ${cols.map(([h, s, l]) => `hsl(${h} ${s}% ${l}%)`).join(", ")})`;

  const choose = (id) => {
    setSetting("vizColors", id === "custom" ? { custom } : id);
    applyVizColors();
    draw();
  };
  const draw = () => {
    const on = selected();
    swatches.replaceChildren(...VIZ_PRESETS.map((p) => {
      const b = el("button", `viz-swatch${p.id === on ? " on" : ""}`);
      b.type = "button";
      b.title = p.title;
      b.setAttribute("aria-label", p.title);
      const dot = el("span", "viz-swatch-dot");
      if (p.id === "cover") dot.innerHTML = icons.album;
      dot.style.background = p.id === "cover" ? "rgba(255,255,255,0.1)"
        : gradient(p.id === "custom" ? paletteFor({ custom }) : p.colors);
      b.append(dot, el("span", "viz-swatch-name", p.title));
      b.addEventListener("click", () => choose(p.id));
      return b;
    }));
    pickers.hidden = on !== "custom";
  };
  // Два своих цвета — системная палитра Windows
  custom.forEach((color, i) => {
    const input = el("input", "viz-picker");
    input.type = "color";
    input.value = color;
    input.title = i ? "Цвет справа (верха)" : "Цвет слева (басы)";
    input.addEventListener("input", () => {
      custom = custom.map((c, n) => (n === i ? input.value : c));
      setSetting("vizCustom", custom);
      choose("custom");
    });
    pickers.append(input);
  });
  pickers.prepend(el("span", "set-switch-sub", "Слева → справа:"));
  draw();
  row.append(textBox, swatches, pickers);
  return row;
}

/** Строка «♡ добавляет в: [Избранное ▾]» — выбор плейлиста для сердечка */
function likeTargetRow() {
  const row = el("div", "set-switch set-choice");
  const textBox = el("span", "set-switch-text");
  textBox.append(el("span", "set-switch-title", "Куда добавляет сердечко ♡"),
    el("span", "set-switch-sub", "По умолчанию — в «Избранное». Можно выбрать любой свой плейлист: ♡ у трека и клавиша L будут класть туда."));
  const pick = el("button", "btn ghost set-choice-btn", `${likeTargetName()} ▾`);
  pick.type = "button";
  pick.addEventListener("click", () => {
    const current = likeTarget()?.id ?? "liked";
    const choose = (id) => () => {
      setSetting("likeTarget", id);
      syncAllRows();          // сердечки во всех списках — по новому плейлисту
      syncLikeButtons();
      pick.textContent = `${likeTargetName()} ▾`;
      toast(`♡ теперь добавляет в «${likeTargetName()}»`);
    };
    openMenu(pick, [
      { label: "Избранное", icon: current === "liked" ? icons.check : icons.heart, action: choose("liked") },
      ...(lib.playlists.length ? [{ sep: true }] : []),
      ...lib.playlists.map((p) => ({ label: p.name, icon: current === p.id ? icons.check : "", action: choose(p.id) })),
    ]);
  });
  row.append(textBox, pick);
  return row;
}

function playbackSection() {
  const section = el("section", "set-card");
  // Порядок: сначала про звук, потом — что делают кнопки и что играет дальше
  section.append(el("h2", "", "Воспроизведение"));
  section.append(switchRow("Выравнивать громкость",
    "На YouTube одни треки тихие, другие громкие. Мягко подтягивает тихое и придерживает громкое — не нужно трогать ползунок.",
    normalizeEnabled(), (on) => setNormalize(on)));

  // Наложение треков: Выкл / 3 / 6 / 10 / 12 секунд
  const fadeRow = el("div", "set-switch set-choice");
  const text = el("span", "set-switch-text");
  text.append(el("span", "set-switch-title", "Наложение треков"),
    el("span", "set-switch-sub", "Конец трека звучит вместе с началом следующего — без тишины между ними, как на радио. В конце очереди трек просто мягко затихает."));
  const seg = el("div", "seg");
  for (const sec of [0, 3, 6, 10, 12]) {
    const b = el("button", `seg-btn${fadeSeconds() === sec ? " on" : ""}`, sec ? `${sec} с` : "Выкл");
    b.type = "button";
    b.addEventListener("click", () => {
      setFadeSeconds(sec);
      seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
    });
    seg.append(b);
  }
  fadeRow.append(text, seg);
  section.append(fadeRow, likeTargetRow());
  section.append(switchRow("Закрывать в трей",
    "Крестик прячет окно, а музыка играет дальше; значок Sono — у часов Windows (правой кнопкой — пауза, следующий, выход).",
    getSetting("closeToTray", true) !== false, (on) => {
      setSetting("closeToTray", on);
      document.dispatchEvent(new CustomEvent("sono:close-to-tray"));
    }));
  section.append(switchRow("Flow, когда очередь закончилась",
    "Плейлист или трек доиграл — дальше бесконечный Flow в том же духе: похожая музыка по исполнителям из этой очереди.",
    autoFlowEnabled(), (on) => setSetting("autoFlow", on)));
  return section;
}

// ---------- Раздел «Обновления»: yt-dlp ----------
// yt-dlp сам скачивает свежую версию при запуске (updater.py) — здесь видно, что с ним

function updateText(u) {
  if (!u) return "";
  if (u.state === "ready") return `Скачана новая версия ${u.pending} — включится, когда вы перезапустите Sono.`;
  if (u.state === "downloading") return `Скачиваю версию ${u.latest}…`;
  if (u.state === "checking") return "Проверяю, нет ли новой версии…";
  if (u.state === "error") return `Не получилось проверить: ${u.error}`;
  if (u.state === "uptodate") return "Это последняя версия.";
  return u.frozen ? "Проверяется при каждом запуске." : "В версии из исходников обновляйте через pip install -U yt-dlp.";
}

function updateSection() {
  const section = el("section", "set-card update-card");
  section.append(el("h2", "", "Обновления"),
    el("p", "set-text", "Sono сам узнаёт о новой версии на GitHub и спрашивает, обновиться ли: согласитесь — скачает и поставит её сам. "
      + "А yt-dlp — часть, которая достаёт музыку, — ломается чаще всего (YouTube часто меняет сайт), "
      + "поэтому его свежая версия скачивается отдельно, при каждом запуске."));
  const line = el("div", "set-result-line");
  const check = el("button", "btn ghost", "Проверить сейчас");
  check.type = "button";
  const draw = (u) => line.replaceChildren(el("span", "", `yt-dlp ${u?.current ?? "?"} · ${updateText(u)}`), check);
  const poll = async () => {
    const u = await (await fetch("/api/update")).json().catch(() => null);
    draw(u);
    if (u && ["checking", "downloading"].includes(u.state) && box.contains(section)) setTimeout(poll, 1000);
  };
  check.addEventListener("click", async () => {
    await fetch("/api/update/check", { method: "POST" });
    setTimeout(poll, 300);
  });
  draw(null);
  poll();
  section.append(el("div", "set-label", "Программа"), appUpdateLine(), el("div", "set-label", "yt-dlp"));
  // Знакомство с программой — можно пройти ещё раз
  const again = el("div", "set-actions");
  const welcome = el("button", "btn ghost", "Показать приветствие");
  welcome.type = "button";
  welcome.addEventListener("click", showWelcome);
  const tour = el("button", "btn ghost", "Экскурсия по Sono");
  tour.type = "button";
  tour.addEventListener("click", startTour);
  const news = el("button", "btn ghost", "Что нового");
  news.type = "button";
  news.addEventListener("click", () => showWhatsNew(CHANGELOG.slice(0, 3)));   // последние три версии
  again.append(news, welcome, tour);
  section.append(line, el("div", "set-label", "Знакомство"), again);
  return section;
}

// ---------- Обновление самой программы (appupdate.py) ----------
// Sono сам смотрит на GitHub, нет ли новой версии, и скачивает установщик. Обновиться — одна кнопка.

function appUpdateText(u) {
  if (!u?.enabled) return "Автообновление включится, когда Sono будет выложен на GitHub.";
  if (u.state === "available" || u.state === "ready") {
    return u.error ? `Не получилось скачать версию ${u.latest}: ${u.error}` : `Доступна новая версия ${u.latest}. Обновить сейчас?`;
  }
  if (u.state === "downloading") return `Скачиваю версию ${u.latest}… ${u.progress || 0}%`;
  if (u.state === "checking") return "Проверяю, нет ли новой версии…";
  if (u.state === "installing") return "Устанавливаю — Sono сейчас перезапустится…";
  if (u.state === "error") return `Не получилось проверить: ${u.error}`;
  if (u.state === "uptodate") return "Это последняя версия.";
  return "Проверяется при запуске и раз в 6 часов. Скачивается — только если вы согласитесь.";
}

const appUpdateStatus = () => fetch("/api/app-update").then((r) => r.json()).catch(() => null);

/** Человек согласился: скачать (если ещё нет) и установить. Сервер качает в фоне, а затем сам запускает
    установщик — программа закроется и откроется уже новой. onStatus(u) — следить за ходом */
export async function installAppUpdate(onStatus) {
  const res = await fetch("/api/app-update/install", { method: "POST" });
  if (!res.ok) return toast((await res.json().catch(() => ({}))).error || "Не получилось обновить", { error: true });
  const poll = async () => {
    const u = await appUpdateStatus();
    onStatus?.(u);
    if (u?.state === "installing") return toast("Обновляю Sono — через несколько секунд он откроется снова");
    if (u?.state === "available" && u.error) return toast(`Не получилось скачать обновление: ${u.error}`, { error: true });
    setTimeout(poll, 700);
  };
  poll();
}

function appUpdateLine() {
  const line = el("div", "set-result-line");
  const check = el("button", "btn ghost", "Проверить сейчас");
  check.type = "button";
  const install = el("button", "btn primary", "Обновить");
  install.type = "button";
  const later = el("button", "btn ghost", "Не сейчас");
  later.type = "button";
  let dismissed = false;   // «Не сейчас» — вопрос прячется до следующей проверки
  const draw = (u) => {
    const version = !u ? "?" : u.current === "0" ? "(из исходников)" : u.current;
    const asking = u && ["available", "ready"].includes(u.state);
    line.replaceChildren(el("span", "", `Sono ${version} · ${asking && dismissed ? `есть версия ${u.latest}` : appUpdateText(u)}`));
    if (asking && !dismissed) line.append(install, later);
    else if (u?.enabled && !["downloading", "installing", "checking"].includes(u?.state)) line.append(check);
  };
  const poll = async () => {
    const u = await appUpdateStatus();
    draw(u);
    if (u && ["checking", "downloading"].includes(u.state) && box.contains(line)) setTimeout(poll, 700);
  };
  check.addEventListener("click", async () => {
    dismissed = false;
    await fetch("/api/app-update/check", { method: "POST" });
    setTimeout(poll, 300);
  });
  install.addEventListener("click", () => installAppUpdate(draw));
  later.addEventListener("click", () => { dismissed = true; poll(); });
  draw(null);
  poll();
  return line;
}

/** Нашлась новая версия — спросить внизу плашкой, обновиться ли (один раз за запуск). Ничего не качаем без согласия */
export function watchAppUpdate() {
  let shown = false;
  const look = async () => {
    const u = await appUpdateStatus();
    if (!u?.enabled) return;
    if (["available", "ready"].includes(u.state) && !u.error && !shown) {
      shown = true;
      const bar = el("div", "update-pill");
      const text = el("span", "", `Доступна новая версия Sono ${u.latest}. Обновить?`);
      const go = el("button", "btn", "Обновить");
      go.type = "button";
      const later = el("button", "btn ghost", "Потом");
      later.type = "button";
      later.addEventListener("click", () => bar.remove());
      go.addEventListener("click", () => {
        go.remove();
        later.remove();
        text.textContent = "Скачиваю обновление…";
        installAppUpdate((s) => {
          if (s?.state === "downloading") text.textContent = `Скачиваю обновление… ${s.progress || 0}%`;
          else if (s?.state === "installing") text.textContent = "Устанавливаю — Sono сейчас перезапустится…";
          else if (s?.error) bar.remove();
        });
      });
      bar.append(text, go, later);
      document.body.append(bar);
      return;
    }
    setTimeout(look, u.state === "checking" ? 5000 : 30 * 60 * 1000);
  };
  setTimeout(look, 30000);   // проверка на сервере начинается через 20 с после запуска
}

// ---------- Раздел «zapret» ----------
// Если у человека уже скачан zapret (сборка Flowseal), плеер сам подберёт ему стратегию для YouTube и SoundCloud.

const zap = { found: null, index: 0, searching: false, error: "", progress: null, note: "" };
let zapTimer = null;
const ACTIVE = ["starting", "testing", "tested", "installing"];

async function findZapret(path = "") {
  zap.searching = true;
  zap.error = "";
  refreshZapret();
  try {
    const res = await fetch(`/api/zapret${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "не получилось");
    zap.found = data.found;
    zap.index = 0;
  } catch (err) {
    zap.error = err.message;
    zap.found ??= [];
  }
  zap.searching = false;
  // Подбор мог идти, пока экран был закрыт, — продолжаем следить
  const p = await (await fetch("/api/zapret/progress")).json().catch(() => null);
  if (p && ACTIVE.includes(p.state)) { zap.progress = p; pollZapret(); }
  refreshZapret();
}

function pollZapret() {
  clearInterval(zapTimer);
  zapTimer = setInterval(async () => {
    try {
      zap.progress = await (await fetch("/api/zapret/progress")).json();
    } catch { return; }
    const state = zap.progress.state;
    if (state === "idle" && Date.now() - zap.startedAt > 90000) {   // права так и не дали
      zap.progress = null;
      zap.error = "Подбор не начался — похоже, окно с запросом прав закрыли.";
    }
    if (!zap.progress || ["done", "error"].includes(state)) {
      clearInterval(zapTimer);
      if (zap.progress?.switchedOff) {
        network = { ...network, mode: "off" };
        render();
        return;
      }
      if (state === "done") findZapret(zap.found?.[zap.index]?.path ?? "");   // обновить «служба стоит, работает»
    }
    refreshZapret();
  }, 1000);
}

async function zapretPost(url, path) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "не получилось");
  return data;
}

async function startSetup(info) {
  zap.error = "";
  zap.progress = { state: "starting", done: 0, total: info.strategies.length };
  zap.startedAt = Date.now();
  refreshZapret();
  try {
    await zapretPost("/api/zapret/setup", info.path);
    toast("Подтвердите запрос прав администратора — без них zapret не настроить");
    pollZapret();
  } catch (err) {
    zap.progress = null;
    zap.error = err.message;
    refreshZapret();
  }
}

function zapretStatus(info) {
  const s = info.service;
  if (s.installed && s.here) {
    return `Стоит службой Windows${s.strategy ? `, стратегия «${s.strategy}»` : ""} — ${s.running ? "работает" : "сейчас выключен"}.`;
  }
  if (info.running) return "Запущен вручную (окно general.bat). После выключения компьютера его снова нужно включать самому.";
  return "Скачан, но не запущен и не настроен.";
}

function zapretResults(p) {
  const wrap = el("div", "set-results");
  const rows = [...(p.results || [])].sort((a, b) => b.youtube - a.youtube).slice(0, 6);
  const max = Math.max(...rows.map((r) => r.youtube), p.baseline?.youtube || 0, 0.1);
  const line = (name, r, best) => {
    const row = el("div", `set-result${best ? " best" : ""}`);
    const bar = el("div", "set-bar");
    const fill = el("i");
    fill.style.width = `${(r.youtube / max) * 100}%`;
    bar.append(fill);
    row.append(el("span", "set-result-name", name), bar,
      el("span", "set-result-num", r.youtube > 0.05 ? `${r.youtube} МБ/с` : "не работает"),
      el("span", "set-result-sc", r.soundcloud > 0 ? "SC ✓" : "SC —"));
    return row;
  };
  if (p.baseline) wrap.append(line("Без zapret", p.baseline, false));
  rows.forEach((r) => wrap.append(line(r.name, r, r.name === p.installed)));
  return wrap;
}

function zapretCard() {
  const section = el("section", "set-card zapret-card");
  section.append(el("h2", "", "zapret"),
    el("p", "set-text", "Если zapret уже скачан, но не настроен (или YouTube и SoundCloud с ним всё равно тормозят), "
      + "плеер подберёт стратегию сам: по очереди проверит каждую и поставит лучшую службой Windows."));

  if (zap.found === null || zap.searching) {
    section.append(el("p", "set-hint", "Ищу zapret на компьютере…"));
    return section;
  }

  // Ничего не нашлось — можно указать папку вручную
  const manual = el("form", "set-proxy");
  const input = el("input", "dialog-input");
  input.placeholder = "Папка zapret, например C:\\zapret-discord-youtube";
  input.spellcheck = false;
  const check = el("button", "btn ghost", "Проверить");
  manual.append(input, check);
  manual.addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) findZapret(input.value.trim()); });

  if (!zap.found.length) {
    section.append(el("p", "set-hint", "zapret на компьютере не нашёлся. Если он есть — укажите его папку (ту, где лежат general.bat и папка bin)."),
      manual);
    if (zap.error) section.append(el("p", "import-error", zap.error));
    return section;
  }

  // Несколько папок — выбор
  if (zap.found.length > 1) {
    const seg = el("div", "seg zapret-paths");
    zap.found.forEach((f, i) => {
      const btn = el("button", `seg-btn${i === zap.index ? " on" : ""}`, f.path.split("\\").slice(-2).join("\\"));
      btn.type = "button";
      btn.title = f.path;
      btn.addEventListener("click", () => { zap.index = i; refreshZapret(); });
      seg.append(btn);
    });
    section.append(el("div", "set-label", "Найдено несколько"), seg);
  }

  const info = zap.found[zap.index];
  const facts = el("div", "zapret-facts");
  facts.append(el("div", "zapret-path", info.path),
    el("div", "", `${info.version ? `Версия ${info.version} · ` : ""}${zapretStatus(info)}`),
    el("div", "", `YouTube в списках: ${info.covers.youtube ? "да" : "нет"} · SoundCloud: ${info.covers.soundcloud ? "да" : "нет"}`));
  section.append(facts);

  if (!info.flowseal) {
    section.append(el("p", "set-hint", "Это не сборка Flowseal (zapret-discord-youtube) — автонастройка пока умеет только её. "
      + "Встроенный обход плеера работает и без zapret."));
    return section;
  }

  const p = zap.progress;
  if (p && ACTIVE.includes(p.state)) {
    const total = p.total || info.strategies.length;
    const text = p.state === "starting" ? "Жду разрешения администратора…"
      : p.state === "testing" ? `Проверяю ${p.done + 1} из ${total}${p.current ? `: «${p.current}»` : ""}…`
      : p.state === "tested" ? "Выбираю лучшую…" : "Ставлю службой…";
    const bar = el("div", "zapret-progress");
    const fill = el("i");
    fill.style.width = `${Math.round((p.done / Math.max(total, 1)) * 100)}%`;
    bar.append(fill);
    section.append(el("p", "set-text", text), bar,
      el("p", "set-hint", "Займёт 3–5 минут. Пока идёт проверка, YouTube и Discord могут на секунду пропадать."));
    return section;
  }

  if (p?.state === "done") {
    section.append(el("p", "zapret-done", p.installed
      ? `Готово: стратегия «${p.installed}» стоит службой — zapret включается сам вместе с Windows.`
        + (network.mode === "off" ? " Встроенный обход плеера выключен — он больше не нужен." : "")
      : "Ни одна стратегия не оказалась лучше, чем без zapret, — вернул всё как было."));
    if (p.results?.length) section.append(zapretResults(p));
  }
  if (p?.state === "error") section.append(el("p", "import-error", `Не получилось: ${p.error}`));

  const row = el("div", "set-actions");
  const go = el("button", "btn primary", p?.state === "done" ? "Подобрать заново" : "Настроить автоматически");
  go.type = "button";
  go.addEventListener("click", () => startSetup(info));
  row.append(go);
  if (!info.covers.soundcloud) {
    const lists = el("button", "btn ghost", "Только добавить SoundCloud в списки");
    lists.type = "button";
    lists.addEventListener("click", async () => {
      try {
        const data = await zapretPost("/api/zapret/lists", info.path);
        zap.found[zap.index] = data.info;
        toast(info.running ? "Добавлено. Перезапустите zapret, чтобы он увидел новые адреса" : "Добавлено в список zapret");
      } catch (err) { toast(err.message, { error: true }); }
      refreshZapret();
    });
    row.append(lists);
  }
  section.append(row,
    el("p", "set-hint", `Попросит права администратора. Плеер проверит все ${info.strategies.length} стратегий на YouTube и SoundCloud `
      + "(и что Discord открывается), поставит лучшую и сам добавит SoundCloud в списки zapret. Если лучше не станет — вернёт как было."));
  if (zap.error) section.append(el("p", "import-error", zap.error));
  return section;
}

function refreshZapret() {
  const old = box.querySelector(".zapret-card");
  if (old) old.replaceWith(zapretCard());
}

// ---------- Раздел «Медиатека» ----------

function revealButton(path) {
  const btn = el("button", "btn ghost", "Показать в папке");
  btn.type = "button";
  btn.addEventListener("click", () => fetch("/api/reveal", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
  }));
  return btn;
}

function librarySection() {
  const section = el("section", "set-card");
  section.append(el("h2", "", "Медиатека"),
    el("p", "set-text", "Резервная копия плейлистов, избранного и истории — одним файлом. С ним можно перенести всё на другой компьютер или восстановить после переустановки."));

  const row = el("div", "set-actions");
  const exportBtn = el("button", "btn primary", "Сохранить копию");
  exportBtn.type = "button";
  const result = el("div", "set-result-line");
  exportBtn.addEventListener("click", async () => {
    const data = await (await fetch("/api/library/export", { method: "POST" })).json();
    result.replaceChildren(el("span", "", `Сохранено в «Загрузки»: ${data.name}`), revealButton(data.path));
  });

  const importBtn = el("button", "btn ghost", "Восстановить из файла…");
  importBtn.type = "button";
  const picker = el("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.hidden = true;
  importBtn.addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => {
    const file = picker.files[0];
    picker.value = "";
    if (!file) return;
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { return toast("Файл не читается — это не копия медиатеки", { error: true }); }
    const res = await fetch("/api/library/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error, { error: true });
    const a = data.added;
    toast(`Добавлено: плейлистов ${a.playlists}, в избранное ${a.liked}, в историю ${a.history}`);
    setTimeout(() => location.reload(), 1200);   // перечитать медиатеку целиком
  });
  row.append(exportBtn, importBtn, picker);
  section.append(row, result,
    el("p", "set-hint", "Восстановление ничего не удаляет: новое добавляется к тому, что уже есть. Поделиться отдельным плейлистом — «⋯» у плейлиста → «Поделиться»."));
  return section;
}

/** Включить/выключить «Без анимаций» на странице (класс body.no-anim); живые фоны перечитают настройку сами */
export function applyMotion() {
  document.body.classList.toggle("no-anim", motionOff());
  document.dispatchEvent(new CustomEvent("sono:motion"));
}

// ---------- Сборка экрана ----------

let navSpy = null;   // подсветка раздела в оглавлении при прокрутке

function render() {
  const title = el("div", "set-title");
  title.innerHTML = `<span class="set-title-icon">${icons.settings}</span>`;
  title.append(el("h1", "", "Настройки"));
  // Порядок разделов — от того, что меняют чаще, к тому, что настраивают один раз
  const sections = [
    ["Воспроизведение", playbackSection()],
    ["Оформление", appearanceSection()],
    ["Медиатека", librarySection()],
    ["Мои файлы", localSection()],
    ["Обход блокировок", networkSection()],
    ["zapret", zapretCard()],
    ["Обновления", updateSection()],
  ];
  // Оглавление сверху: щелчок — прокрутить к разделу; пока листают — подсвечен тот, что на экране
  const nav = el("nav", "set-nav");
  // Каждый раздел — в своей обёртке: карточка zapret перерисовывает себя заменой целиком,
  // а обёртка остаётся — оглавление не теряет на неё ссылку
  const links = sections.map(([name, section], i) => {
    const anchor = el("div", "set-anchor");
    anchor.id = `set-${i}`;
    anchor.append(section);
    const b = el("button", "set-nav-btn", name);
    b.type = "button";
    b.addEventListener("click", () => anchor.scrollIntoView({ behavior: "smooth", block: "start" }));
    nav.append(b);
    return [b, anchor];
  });
  box.replaceChildren(title, nav, ...links.map(([, a]) => a));
  // Экран перерисовывается при многих щелчках — старый обработчик прокрутки снимаем, чтобы не копились
  const scroller = box.closest(".views") ?? box.parentElement;
  if (navSpy) scroller.removeEventListener("scroll", navSpy);
  navSpy = () => {
    const top = nav.getBoundingClientRect().bottom + 40;
    let current = links[0];
    for (const pair of links) {
      const shown = pair[1].offsetHeight > 0;   // карточка zapret прячется, если zapret не найден
      pair[0].hidden = !shown;
      if (shown && pair[1].getBoundingClientRect().top <= top) current = pair;
    }
    // Долистали до конца — последний раздел до верха не поднимется, но смотрят именно его
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = links[links.length - 1];
    links.forEach(([b]) => b.classList.toggle("on", b === current[0]));
  };
  scroller.addEventListener("scroll", navSpy, { passive: true });
  navSpy();
  if (zap.found === null && !zap.searching) findZapret();
}

export async function renderSettings() {
  if (!network) {
    box.replaceChildren(el("p", "set-text", "Загружаю настройки…"));
    try {
      const data = await (await fetch("/api/network")).json();
      network = data.config;
      strategies = Object.fromEntries(data.strategies);   // пары [способ, подпись] — в нужном порядке
      presenceInfo = await (await fetch("/api/presence")).json().catch(() => null);
    } catch {
      box.replaceChildren(el("p", "import-error", "Не получилось загрузить настройки"));
      return;
    }
  }
  render();
}
