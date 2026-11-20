// Панель «Вид» (ПК, «Живая обложка»; кнопка «Вид» в верхней полосе): тема, цвет, фон и «Свой фон»,
// вид «Сейчас играет», полоска времени в капсуле, очередь на «Сейчас играет». Меняется сразу — панель справа,
// окно слева сужается и показывает изменения. Макет — design/ui-new/B-vid.html.
// Настройки — settings.look (медиатека на сервере), тема — прежняя settings.theme (themes.js).
// Свои фоны — файлы на сервере (backgrounds.py, /api/backgrounds). Телефон — отдельным шагом (там всё прежнее).

import { icons } from "./icons.js";
import { getSetting, isDisliked, keyOf, setSetting } from "./library.js";
import { liveUi } from "./motion.js";
import { playFromQueue, prefetch, setFixedAccent, state } from "./player.js";
import { chooseTheme, currentThemeId, onThemesChange, themeById } from "./themes.js";
import { coverUrl, displayTrack, el, toast } from "./ui.js";
import { spectrumLevels } from "./viz.js";
import { animFrame } from "./raf.js";

const LIGHT = "builtin:light";
const COLORS = [
  ["Розовый", "#ff7ad9"], ["Сирень", "#a78bfa"], ["Синий", "#5aa8ff"], ["Небо", "#7dd3fc"], ["Бирюза", "#4fd1c5"], ["Мята", "#5be49b"], ["Лайм", "#c6f24e"],
  ["Жёлтый", "#ffd23f"], ["Оранжевый", "#ff9f43"], ["Красный", "#ff4d5e"], ["Вишня", "#d6336c"], ["Графит", "#9aa0a6"], ["Белый", "#f2f2f2"],
];
const DEFAULTS = {
  system: false,        // тема «как в системе» (тёмная/светлая — по Windows)
  color: "cover",       // "cover" — под обложку, иначе #rrggbb
  bg: "live",           // live | still | own | plain
  own: "", ownSrc: "", ownAcc: "", ownColor: true, dim: 35, blur: 0,
  now: "normal",        // normal | vinyl | big
  seek: "edge",         // edge | wave | live
  queue: "hidden",      // hidden | right | bottom
  mini: "capsule",      // мини-плеер поверх окон (compact.js): capsule | square
  miniPin: true,        // мини-плеер поверх всех окон
};
const sysLight = matchMedia("(prefers-color-scheme: light)");

const look = () => ({ ...DEFAULTS, ...getSetting("look", {}) });
let st = look();
let panel = null, body = null, bgItems = [];
// Где нарисованы разделы «Вида»: тело панели справа и раздел «Вид» в «Настройках» на ПК (setlive.js)
const roots = new Set();
/** Живые места с разделами (раздел настроек, который уже убрали со страницы, забываем) */
function liveRoots() {
  for (const r of roots) {
    if (r.isConnected) r.lookShown = true;
    else if (r !== body && r.lookShown) roots.delete(r);   // ещё не вставлен на страницу — не трогаем
  }
  return [...roots];
}

// ---------- Что меняет каждая настройка ----------

/** Тема сейчас: dark (обычная Sono), light (встроенная «Светлая»), system или other (другая тема) */
function themeMode() {
  const id = currentThemeId();
  if (st.system && (!id || id === LIGHT)) return "system";
  return !id ? "dark" : id === LIGHT ? "light" : "other";
}

function applySystemTheme() {
  if (!st.system) return;
  const id = currentThemeId();
  if (id && id !== LIGHT) return;   // выбрали другую тему в «Настройках» — системе не мешаем
  const want = sysLight.matches ? LIGHT : null;
  if (id !== want) chooseTheme(want);
}

function applyBackground() {
  const b = document.body;
  b.dataset.lookBg = st.bg;
  const own = ownLayer();
  if (st.bg === "own" && st.ownSrc) {
    own.style.setProperty("--own", `url("${st.ownSrc}")`);
    own.style.setProperty("--own-blur", `${st.blur}px`);
    own.style.setProperty("--own-dim", (st.dim / 100).toFixed(2));
  }
  // Цвет: выбранный → из своей картинки → из обложки
  const acc = st.color !== "cover" ? st.color : st.bg === "own" && st.ownColor && st.ownAcc ? st.ownAcc : null;
  b.classList.toggle("look-fixed", st.color !== "cover");
  setFixedAccent(acc);
}

function apply() {
  if (!liveUi()) return;
  const b = document.body;
  applySystemTheme();
  applyBackground();
  b.dataset.lookNow = st.now;
  b.dataset.lookSeek = st.seek;
  b.dataset.lookQueue = st.queue;
  syncSeekBars();
  renderNowQueue();
}

function save(change) {
  st = { ...st, ...change };
  const stored = Object.fromEntries(Object.entries(st).filter(([k, v]) => v !== DEFAULTS[k]));
  setSetting("look", stored);
  apply();
  sync();
}

/** Слой своего фона — в .backdrop, над пятнами обложки */
function ownLayer() {
  let own = document.querySelector(".own-bg");
  if (!own) {
    own = el("div", "own-bg");
    own.setAttribute("aria-hidden", "true");
    own.append(el("i"));
    document.querySelector(".backdrop")?.append(own);
  }
  return own;
}

// ---------- Полоска времени в капсуле: волна трека / живая ----------

const bar = document.getElementById("minibar");
let wave = null, waveBars = [], waveShape = [], waveKey = "", waveTimer = 0;

/** Форма волны трека: своя у каждого трека (от его названия), повыше в середине — как у песни */
function shapeFor(key) {
  let x = 0;
  for (const ch of key) x = (x * 31 + ch.charCodeAt(0)) % 233280;
  return Array.from({ length: 200 }, (_, i) => {
    x = (x * 9301 + 49297) % 233280;
    const env = 0.45 + 0.55 * Math.sin((i / 200) * Math.PI) ** 0.6;
    return Math.max(0.18, (0.3 + (0.7 * x) / 233280) * env);
  });
}

function fitWave() {
  if (!wave?.offsetWidth) return;
  const n = Math.max(24, Math.floor(wave.offsetWidth / 6));
  if (n === waveBars.length) return;
  wave.replaceChildren(...Array.from({ length: n }, () => el("i")));
  waveBars = [...wave.children];
}

function tickWave(ts) {
  waveTimer = 0;
  if (st.seek === "edge" || !wave || document.hidden || !document.body.classList.contains("has-track")) return;
  fitWave();
  const key = state.current ? keyOf(state.current) : "";
  if (key !== waveKey) { waveKey = key; waveShape = shapeFor(key); }
  const seek = bar.querySelector('input[data-np="seek"]');
  const done = seek ? seek.value / (seek.max || 1000) : 0;
  const live = st.seek === "live" && document.body.classList.contains("playing") && !document.body.classList.contains("calm");
  const lv = live ? spectrumLevels(waveBars.length, ts) : null;
  waveBars.forEach((b, i) => {
    const base = waveShape[Math.floor((i / waveBars.length) * waveShape.length)] || 0.3;
    // Живая — под музыку, но на тишине не ровная черта: остаётся тихая форма волны
    const h = lv ? Math.min(1, base * 0.3 + (lv[i] ?? 0) * 0.95) : base;
    b.style.height = `${Math.round(h * 100)}%`;
    b.classList.toggle("on", i / waveBars.length < done);
  });
  // Живая — каждый кадр; волна стоит — хватает 4 раз в секунду (только закрашивать сыгранное)
  waveTimer = live ? animFrame(tickWave) : setTimeout(() => animFrame(tickWave), 250);
}

function syncSeekBars() {
  if (!bar) return;
  if (!wave) {
    wave = el("div", "cap-wave");
    wave.setAttribute("aria-hidden", "true");
    bar.append(wave);
  }
  if (st.seek !== "edge" && !waveTimer) waveTimer = animFrame(tickWave);
}

// ---------- Очередь на «Сейчас играет»: справа или снизу ----------

let nqSig = "";
export function renderNowQueue() {
  const stage = document.querySelector("#view-now .np-stage");
  if (!stage || !liveUi()) return;
  let box = stage.querySelector(".np-queue");
  if (st.queue === "hidden") { box?.remove(); nqSig = ""; return; }
  if (!box) {
    box = el("div", "np-queue glass");
    box.append(el("h5", "", "Далее"), el("div", "np-queue-list"));
    stage.append(box);
    nqSig = "";
  }
  const rows = [];
  for (let i = state.index + 1; i < state.queue.length && rows.length < 5; i++) {
    if (!isDisliked(state.queue[i])) rows.push(i);
  }
  box.hidden = !rows.length;
  const sig = rows.map((i) => `${i}:${keyOf(state.queue[i])}`).join("|");
  if (sig === nqSig) return;
  nqSig = sig;
  box.querySelector(".np-queue-list").replaceChildren(...rows.map((i) => {
    const track = state.queue[i], shown = displayTrack(track);
    const r = el("button", "np-queue-row");
    r.type = "button";
    const art = el("span", "nc-next-art");
    const img = el("img");
    img.alt = "";
    img.src = coverUrl(track);
    if (!img.complete) {
      img.classList.add("wait");
      img.decode().catch(() => {}).then(() => img.classList.remove("wait"));
    }
    img.onerror = () => img.classList.add("broken");
    art.append(img);
    const text = el("span", "np-queue-text");
    text.append(el("b", "", shown.title), el("span", "", shown.artist));
    r.append(art, text);
    r.title = track.title;
    r.addEventListener("click", () => playFromQueue(i));
    r.addEventListener("mouseenter", () => prefetch(track));
    return r;
  }));
}

// ---------- Свой фон: файлы ----------

/** Средний яркий цвет картинки — для «цвет кнопок из картинки» */
function accentOf(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(im, 0, 0, 32, 32);
        const d = g.getImageData(0, 0, 32, 32).data;
        let r = 0, gg = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const k = (mx - mn + 8) * (mx > 40 ? 1 : 0.1);   // насыщенные и не чёрные — весомее
          r += d[i] * k; gg += d[i + 1] * k; b += d[i + 2] * k; w += k;
        }
        // Слишком тёмный цвет кнопок не виден на тёмном фоне — поднимаем яркость
        let rgb = [r, gg, b].map((v) => v / w);
        const max = Math.max(...rgb);
        if (max < 150) rgb = rgb.map((v) => v * (150 / Math.max(1, max)));
        resolve("#" + rgb.map((v) => Math.round(Math.min(255, v)).toString(16).padStart(2, "0")).join(""));
      } catch {
        resolve("");
      }
    };
    im.onerror = () => resolve("");
    im.src = src;
  });
}

async function loadBackgrounds() {
  try {
    const res = await fetch("/api/backgrounds");
    bgItems = (await res.json()).items || [];
  } catch {
    bgItems = [];
  }
  drawLibrary();
}

async function useBackground(item) {
  const acc = await accentOf(item.src);
  if (item.own) fetch(`/api/backgrounds/${item.id.slice(5)}/used`, { method: "POST" }).catch(() => {});
  save({ bg: "own", own: item.id, ownSrc: item.src, ownAcc: acc });
}

async function addFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast("Это не картинка — подходят JPG, PNG, GIF и WebP", { error: true }); return; }
  if (file.size > 20 * 1024 * 1024) { toast("Файл больше 20 МБ — выберите поменьше", { error: true }); return; }
  try {
    const keep = st.own.startsWith("user:") ? st.own.slice(5) : "";
    const res = await fetch(`/api/backgrounds?keep=${encodeURIComponent(keep)}`, { method: "POST", body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "не получилось");
    await loadBackgrounds();
    await useBackground({ id: data.id, src: data.src, own: true });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function removeBackground(item) {
  await fetch(`/api/backgrounds/${item.id.slice(5)}`, { method: "DELETE" }).catch(() => {});
  if (st.own === item.id) save({ own: "", ownSrc: "", ownAcc: "", bg: "live" });
  loadBackgrounds();
}

// ---------- Панель ----------

const sec = (title, ...children) => {
  const s = el("section", "lk-sec");
  s.append(el("h3", "", title), ...children);
  return s;
};

function seg(key, items) {
  const s = el("div", "lk-seg");
  s.dataset.k = key;
  s.append(el("i"));
  for (const [value, label, icon] of items) {
    const b = el("button");
    b.type = "button";
    b.dataset.v = value;
    b.innerHTML = icon ?? "";
    b.append(label);
    s.append(b);
  }
  return s;
}

function tiles(key, items, cls = "") {
  const g = el("div", `lk-tiles ${cls}`);
  g.dataset.k = key;
  for (const [value, label, preview] of items) {
    const b = el("button", "lk-tile");
    b.type = "button";
    b.dataset.v = value;
    const pv = el("span", "pv");
    pv.innerHTML = preview;
    b.append(pv, label);
    g.append(b);
  }
  return g;
}

const lines = (x, y) => `<i class="ln hi" style="left:${x}px;top:${y}px;width:34%"></i><i class="ln" style="left:${x}px;top:${y + 10}px;width:26%"></i><i class="ln" style="left:${x}px;top:${y + 20}px;width:20%"></i>`;
const bars = (n, live) => `<span class="bars${live ? " jump" : ""}">${Array.from({ length: n }, (_, i) => `<i class="${i < n * 0.45 ? "on" : ""}" style="height:${30 + Math.round(70 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45)))}%;animation-delay:${-(i * 137 % 900)}ms"></i>`).join("")}</span>`;

function build() {
  panel = el("aside", "lk-panel glass");
  panel.id = "look-panel";
  panel.setAttribute("aria-label", "Вид");
  const head = el("div", "lk-head");
  const titles = el("div");
  titles.append(el("h2", "", "Вид"), el("p", "", "Меняется сразу — смотрите на окно слева"));
  const close = el("button", "lk-x");
  close.type = "button";
  close.innerHTML = icons.close;
  close.title = "Закрыть";
  close.setAttribute("aria-label", "Закрыть");
  close.addEventListener("click", () => openLook(false));
  head.append(titles, close);

  body = el("div", "lk-body");
  body.append(...makeSections());

  const foot = el("div", "lk-foot");
  const reset = el("button", "", "Сбросить всё");
  reset.type = "button";
  reset.addEventListener("click", () => {
    st = { ...DEFAULTS };
    setSetting("look", {});
    if (currentThemeId() === LIGHT) chooseTheme(null);
    apply();
    sync();
  });
  const go = el("button", "go");
  go.type = "button";
  go.innerHTML = `Темы целиком — мастерская ${icons.chevron}`;
  go.addEventListener("click", openWorkshop);
  foot.append(reset, go);
  panel.append(head, body, foot);
  document.body.append(panel);
  attach(body, panel);   // перетащить картинку можно на всю панель
}

/** Разделы «Вида» в root: щелчки, перетаскивание картинки (на dropArea) и синхронизация с настройками */
function attach(root, dropArea = root) {
  roots.add(root);
  root.addEventListener("click", onPick);
  const drop = () => root.querySelector(".lk-drop");
  dropArea.addEventListener("dragover", (e) => { e.preventDefault(); drop()?.classList.add("over"); });
  dropArea.addEventListener("dragleave", (e) => { if (!dropArea.contains(e.relatedTarget)) drop()?.classList.remove("over"); });
  dropArea.addEventListener("drop", (e) => { e.preventDefault(); drop()?.classList.remove("over"); addFile(e.dataTransfer.files[0]); });
  if (!bgItems.length) loadBackgrounds();
  else if (root.isConnected) drawLibrary();   // список уже есть (загрузили для настроек) — сразу в панель
}

/** «Настройки → Вид» на ПК (setlive.js): те же разделы, что в панели справа. root — раздел настроек
    (разделы можно разложить внутри него как угодно). Возвращает массив разделов .lk-sec */
export function lookSections(root) {
  if (!liveUi()) return [];
  const list = makeSections();
  attach(root);
  return list;
}

/** Раздел «Вид» в настройках показали — выделить выбранное (бегунок переключателя меряется по видимым кнопкам) */
export function syncLookSections() {
  drawLibrary();   // в нём и sync()
  requestAnimationFrame(() => liveRoots().forEach((r) => r.querySelectorAll(".lk-seg").forEach(placeSeg)));
}

/** Разделы «Вида»: тема, цвет, фон и свой фон, «Сейчас играет», полоска времени, очередь.
    Возвращает массив разделов (.lk-sec); куда их положить — решает вызывающий (панель или «Настройки») */
function makeSections() {
  const out = [];
  const themeNote = el("div", "lk-note");
  themeNote.dataset.themenote = "";
  out.push(sec("Тема", seg("theme", [["dark", "Тёмная", icons.moon], ["light", "Светлая", icons.sun], ["system", "Как в системе", icons.monitor]]), themeNote));
  // Цвет
  const sw = el("div", "lk-sw");
  sw.dataset.k = "color";
  const coverBtn = el("button", "cover");
  coverBtn.type = "button";
  coverBtn.dataset.v = "cover";
  coverBtn.title = "Под обложку";
  coverBtn.append(el("b", "", "авто"));
  sw.append(coverBtn, ...COLORS.map(([name, c]) => {
    const b = el("button");
    b.type = "button";
    b.dataset.v = c;
    b.title = name;
    b.style.setProperty("--c", c);
    return b;
  }));
  const colorNote = el("div", "lk-note");
  colorNote.dataset.colornote = "";
  out.push(sec("Цвет", sw, colorNote));
  // Фон + свой фон
  const own = el("div", "lk-own");
  own.dataset.own = "";
  const drop = el("label", "lk-drop");
  drop.innerHTML = `<span class="ic">${icons.image}</span><span><b>Картинка или GIF</b>Перетащите сюда или нажмите, чтобы выбрать файл</span>`;
  const file = el("input");
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/gif,image/webp";
  file.addEventListener("change", () => { addFile(file.files[0]); file.value = ""; });
  drop.append(file);
  const lib = el("div", "lk-lib");
  lib.dataset.lib = "";
  const range = (key, label, min, max) => {
    const box = el("div", "lk-range");
    const lab = el("label", "", label);
    const out = el("span");
    out.dataset.out = key;
    lab.append(out);
    const input = el("input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.dataset.r = key;
    input.addEventListener("input", () => {
      st[key] = +input.value;
      applyBackground();
      sync();
    });
    input.addEventListener("change", () => save({ [key]: +input.value }));
    box.append(lab, input);
    return box;
  };
  const toggle = el("div", "lk-sw-row");
  toggle.dataset.t = "ownColor";
  toggle.innerHTML = '<div><b>Цвет кнопок — из картинки</b><span>Иначе — из обложки или выбранный выше</span></div><span class="lk-tg"></span>';
  own.append(drop, lib, range("dim", "Приглушить картинку", 0, 85), range("blur", "Размытие", 0, 40), toggle);
  out.push(sec("Фон", tiles("bg", [
    ["live", "Живая обложка", '<i class="blob move"></i>'],
    ["still", "Без движения", '<i class="blob"></i>'],
    ["own", "Свой фон", '<i class="own" data-ownpv></i>'],
    ["plain", "Однотонный", '<i class="plain"></i>'],
  ], "four"), own));
  // «Сейчас играет»
  const more = el("button", "lk-link");
  more.type = "button";
  more.innerHTML = `Ещё виды — в мастерской тем ${icons.chevron}`;
  more.addEventListener("click", openWorkshop);
  out.push(sec("«Сейчас играет»", tiles("now", [
    ["normal", "Обычный", `<i class="cv" style="left:10px;top:13px;width:40px;height:40px"></i>${lines(58, 20)}`],
    ["vinyl", "Пластинка", '<i class="disc spin" style="left:calc(50% - 26px);top:7px;width:52px;height:52px"></i>'],
    ["big", "Большой", '<i class="cv" style="left:calc(50% - 21px);top:6px;width:42px;height:42px"></i><i class="ln hi" style="left:calc(50% - 18px);top:53px;width:36px"></i>'],
  ]), more));
  // Полоска времени
  out.push(sec("Полоска времени", tiles("seek", [
    ["edge", "Тонкий край", '<span class="cpill"><i class="edge"></i></span>'],
    ["wave", "Волна трека", bars(18)],
    ["live", "Живая", bars(18, true)],
  ])));
  // Очередь
  out.push(sec("Очередь на «Сейчас играет»", tiles("queue", [
    ["hidden", "Только кнопкой", `<i class="cv" style="left:12px;top:14px;width:36px;height:36px"></i>${lines(56, 18)}`],
    ["right", "Справа", `<i class="cv" style="left:8px;top:16px;width:30px;height:30px"></i><i class="ln hi" style="left:44px;top:22px;width:24%"></i><i class="ln" style="left:44px;top:32px;width:18%"></i>${[10, 24, 38].map((y) => `<i class="ln" style="right:8px;top:${y + 4}px;width:20%;height:10px;border-radius:3px"></i>`).join("")}`],
    ["bottom", "Снизу", `<i class="cv" style="left:12px;top:8px;width:28px;height:28px"></i><i class="ln hi" style="left:48px;top:14px;width:34%"></i><i class="ln" style="left:48px;top:24px;width:24%"></i>${[0, 1, 2, 3].map((k) => `<i class="ln" style="left:${12 + k * 22}%;top:44px;width:17%;height:12px;border-radius:3px"></i>`).join("")}`],
  ])));
  // Мини-плеер (Ctrl+M или кнопка в полоске окна): какой формы окно и стоит ли оно поверх всех окон
  const pin = el("div", "lk-sw-row");
  pin.dataset.t = "miniPin";
  pin.innerHTML = '<div><b>Поверх всех окон</b><span>Мини-плеер не прячется за браузером и играми в окне</span></div><span class="lk-tg"></span>';
  out.push(sec("Мини-плеер", tiles("mini", [
    ["capsule", "Капсула", '<i class="mp-pv cap"><i class="cv"></i><i class="ln hi"></i><i class="ln"></i><i class="dot"></i></i>'],
    ["square", "Квадрат", '<i class="mp-pv sq"><i class="cv"></i><i class="ln hi"></i><i class="ln"></i><i class="dot"></i></i>'],
  ]), pin));
  return out;
}

function onPick(e) {
  const t = e.target.closest("[data-t]");
  if (t) { save({ [t.dataset.t]: !st[t.dataset.t] }); return; }
  const del = e.target.closest(".lk-lib-del");
  if (del) { e.stopPropagation(); removeBackground(bgItems.find((it) => it.id === del.dataset.id)); return; }
  const libBtn = e.target.closest("[data-lib] button[data-id]");
  if (libBtn) { useBackground(bgItems.find((it) => it.id === libBtn.dataset.id)); return; }
  const b = e.target.closest("[data-v]"), g = b?.closest("[data-k]");
  if (!g) return;
  const key = g.dataset.k, value = b.dataset.v;
  if (key === "theme") {
    if (value === "system") { st.system = true; save({ system: true }); return; }
    chooseTheme(value === "light" ? LIGHT : null);
    save({ system: false });
    return;
  }
  if (key === "bg" && value === "own" && !st.ownSrc) {
    // Свой фон ещё не выбран — сразу первый из списка (свой или пример), чтобы было видно, что это
    const first = bgItems[0];
    if (first) { useBackground(first); return; }
  }
  save({ [key]: value });
}

function drawLibrary() {
  for (const root of liveRoots()) {
    const lib = root.querySelector("[data-lib]");
    if (!lib) continue;
    lib.replaceChildren(...bgItems.map((it) => {
      const b = el("button");
      b.type = "button";
      b.dataset.id = it.id;
      b.style.setProperty("--img", `url("${it.src}")`);
      b.title = it.own ? "Ваш фон" : "Пример";
      if (it.gif) b.append(el("span", "", "GIF"));
      if (it.own) {
        const del = el("i", "lk-lib-del");
        del.dataset.id = it.id;
        del.title = "Убрать из списка";
        del.innerHTML = icons.close;
        b.append(del);
      }
      return b;
    }));
  }
  sync();
}

function placeSeg(s) {
  const b = s.querySelector(".on"), i = s.querySelector("i");
  if (!i) return;
  i.style.opacity = b ? "1" : "0";
  if (b) { i.style.width = `${b.offsetWidth}px`; i.style.translate = `${b.offsetLeft}px 0`; }
}

/** Вид панели (и раздела «Вид» в настройках) — по настройкам */
function sync() {
  const values = { ...st, theme: themeMode() };
  const other = themeMode() === "other" ? themeById(currentThemeId()) : null;
  const name = COLORS.find((c) => c[1] === st.color)?.[0];
  // Свой фон ещё не выбран — в образце первый из списка (его и включит щелчок по плитке)
  const pvSrc = st.ownSrc || bgItems[0]?.src;
  // Образцы — с обложкой того, что играет
  const cv = state.current ? `url("${coverUrl(state.current)}")` : "none";
  for (const root of liveRoots()) {
    root.querySelectorAll("[data-k]").forEach((g) => {
      g.querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === String(values[g.dataset.k])));
      if (g.classList.contains("lk-seg")) placeSeg(g);
    });
    root.querySelectorAll("[data-t]").forEach((r) => r.classList.toggle("on", !!st[r.dataset.t]));
    root.querySelectorAll("[data-r]").forEach((r) => {
      r.value = st[r.dataset.r];
      r.style.setProperty("--p", `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
    });
    root.querySelector("[data-out=dim]").textContent = `${st.dim}%`;
    root.querySelector("[data-out=blur]").textContent = st.blur ? `${st.blur} px` : "нет";
    root.querySelector("[data-own]").classList.toggle("show", st.bg === "own");
    root.querySelector("[data-ownpv]")?.style.setProperty("--own", pvSrc ? `url("${pvSrc}")` : "none");
    root.querySelectorAll("[data-lib] button").forEach((b) => b.classList.toggle("on", b.dataset.id === st.own));
    const tn = root.querySelector("[data-themenote]");
    tn.textContent = other ? `Сейчас включена тема «${other.name}». Нажмите «Тёмная» или «Светлая», чтобы вернуться к обычной.` : "";
    tn.hidden = !other;
    root.querySelector("[data-colornote]").textContent = st.color === "cover"
      ? (st.bg === "own" && st.ownColor && st.ownAcc ? "Сейчас цвет берётся из вашей картинки." : "Под обложку — цвет меняется с каждой песней.")
      : `${name ?? "Свой"} — один цвет для всех песен; фон тоже этого цвета.`;
    root.style.setProperty("--cv", cv);
  }
}

function openWorkshop() {
  openLook(false);
  document.getElementById("nav-workshop")?.click();
}

export function openLook(open = !document.body.classList.contains("look-open")) {
  if (!liveUi()) return;
  if (open && !panel) build();
  document.body.classList.toggle("look-open", open);
  document.getElementById("look-btn")?.classList.toggle("on", open);
  if (open) {
    sync();
    requestAnimationFrame(() => body.querySelectorAll(".lk-seg").forEach(placeSeg));
    panel.querySelector(".lk-x").focus({ preventScroll: true });
  }
  setTimeout(fitWave, 650);   // капсула стала уже — столбики под новую ширину
}

export function initLook() {
  if (!liveUi()) return;
  // Медиатека загружается уже после того, как модуль прочитал настройки (main.js: loadLibrary) — читаем заново,
  // иначе после перезапуска «Вид» был обычным, а следующий выбор стирал прежние
  st = look();
  document.getElementById("look-btn")?.addEventListener("click", () => openLook());
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("look-open") && !document.querySelector(".menu.open, .modal-backdrop")) openLook(false);
  });
  sysLight.addEventListener("change", applySystemTheme);
  onThemesChange(() => sync());
  addEventListener("resize", () => { fitWave(); liveRoots().forEach((r) => r.querySelectorAll(".lk-seg").forEach(placeSeg)); });
  apply();
}

/** Мини-плеер: форма (capsule / square) и «поверх всех окон» — compact.js */
export const miniLook = () => ({ shape: st.mini === "square" ? "square" : "capsule", pin: st.miniPin !== false });
/** Кнопка-булавка в самом мини-плеере */
export const setMiniPin = (on) => save({ miniPin: !!on });

/** Сменился трек — образцы в панели и очередь на «Сейчас играет» */
export function lookTrackChanged() {
  if (!liveUi()) return;
  renderNowQueue();
  if (document.body.classList.contains("look-open") || liveRoots().some((r) => r !== body)) sync();
}
