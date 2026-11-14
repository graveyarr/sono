// Редактор тем без кода (ступень 1): панель справа (на телефоне — шторка снизу) с цветами, формой, шрифтом
// и фоном. Sono рядом продолжает работать — можно листать экраны и слушать музыку, правки видны сразу.
//
// Как устроен живой просмотр: настройки лежат в объекте-черновике (values). Каждое движение ползунка
// собирает из него текст CSS (buildCss) и кладёт в <style id="theme-draft"> сразу после CSS темы —
// браузер перекрашивает окно в том же кадре, ничего не перезагружается и не пишется на диск.
// Сама тема на это время подключена без куска редактора (themes.js setEditorPreview, ?editor=0),
// чтобы убранное в черновике (картинка фона, шрифт) не оставалось видно из файла.
//
// Результат — обычная своя тема (папка с theme.json и theme.css в папке тем): «Сохранить» пишет кусок CSS
// в конец theme.css между метками (всё, что выше, — ручное, не трогается; themes.py save_from_editor),
// а положения ползунков — в theme.json → "editor". Тему можно дальше править руками и отправить в мастерскую.
//
// Панель лежит в Shadow DOM: стили редактируемой темы её не задевают (иначе «Светлая» сделала бы
// редактор нечитаемым, а «Кубики» — квадратным).

import { icons } from "./icons.js";
import { isMobile } from "./device.js";
import { openView } from "./nav.js";
import { setCoverColorsMode } from "./player.js";
import { confirmDialog, el, openMenu, openModal, toast } from "./ui.js";
import { chooseTheme, currentThemeId, loadThemes, setEditorPreview, themeBase, themeById } from "./themes.js";

// Как в обычной Sono (style.css :root) — с этого начинается новая тема
const DEFAULTS = {
  bg: "#161616",          // фон окна (--bg и --tint)
  panel: "#0a0a0a",       // цвет панелей-«стёкол»
  panelClear: 68,         // прозрачность панелей, %
  text: "#ffffff",
  accent: "#ffffff",
  cover: "on",            // что брать из обложки: on / tint / accent / off
  radius: 14,
  gap: 8,
  font: "default",        // id из FONTS
  headFont: "same",       // шрифт заголовков: "same" — как основной
  fontFile: "",           // свой файл шрифта (в папке темы)
  image: "",              // картинка фона (в папке темы)
  imageDim: 45,           // затемнение картинки, %
  imageBlur: 0,           // размытие картинки, px
  art: 60,                // размытая обложка на фоне, % (60 — как обычно)
  menu: "",               // цвет меню и окон ("" — подобрать самому)
  search: "",             // цвет строки поиска ("" — подобрать самому)
};

const PRESETS = [
  { name: "Тёмная", values: { bg: "#161616", panel: "#0a0a0a", panelClear: 68, text: "#ffffff", accent: "#ffffff", cover: "on", art: 60 } },
  { name: "Светлая", values: { bg: "#ebe8e3", panel: "#ffffff", panelClear: 38, text: "#161616", accent: "#3a3a3a", cover: "off", art: 18 } },
  { name: "Полночь", values: { bg: "#0b1020", panel: "#121a33", panelClear: 45, text: "#e8eeff", accent: "#8fb0ff", cover: "off", art: 25 } },
  { name: "Тёплая", values: { bg: "#1d140e", panel: "#2b1d14", panelClear: 45, text: "#fff1e2", accent: "#ffb46b", cover: "off", art: 25 } },
  { name: "Лес", values: { bg: "#0e1712", panel: "#13241a", panelClear: 40, text: "#e6f5ea", accent: "#7ddc9a", cover: "off", art: 20 } },
];

// Шрифты: системные Windows (на телефоне их нет — там только общие и встроенные в Sono)
// и шрифты из static/fonts — их файл при сохранении копируется в свою тему (themes.py BUNDLED_FONTS)
const FONTS = [
  { id: "default", label: "Обычный" },
  { id: "bahnschrift", label: "Bahnschrift — узкий", stack: '"Bahnschrift", "Segoe UI", sans-serif', pc: true },
  { id: "trebuchet", label: "Trebuchet MS", stack: '"Trebuchet MS", "Segoe UI", sans-serif', pc: true },
  { id: "verdana", label: "Verdana — широкий", stack: 'Verdana, "Segoe UI", sans-serif', pc: true },
  { id: "georgia", label: "С засечками", stack: 'Georgia, "Noto Serif", serif' },
  { id: "mono", label: "Моноширинный", stack: '"Cascadia Mono", Consolas, "Roboto Mono", monospace' },
  { id: "comic", label: "Comic Sans MS", stack: '"Comic Sans MS", "Segoe UI", cursive', pc: true },
  { id: "unbounded", label: "Unbounded — крупный", family: "Unbounded", file: "Unbounded-Variable.ttf", weight: "200 900" },
  { id: "gothic", label: "Sono Gothic — готика", family: "Sono Gothic", file: "SonoGothic.ttf", weight: "100 900" },
  { id: "marck", label: "Marck Script — рукописный", family: "Marck Script", file: "MarckScript-Regular.ttf" },
  { id: "custom", label: "Свой файл…", family: "Sono Custom" },
];
const fontById = (id) => FONTS.find((f) => f.id === id) ?? FONTS[0];
// Заголовки, которые меняет «Шрифт заголовков»
const HEADINGS = ".home-greet, .home-h, .flow-title, .pl-name, .info h1, .set-card h2";
const BASE_STACK = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

// ---------- Цвета ----------

const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = (c) => `#${c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const rgbText = (c) => c.map(Math.round).join(" ");
function luminance(c) {
  const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** Цвета, которые редактор подбирает сам из четырёх главных */
function derive(v) {
  const bg = hexRgb(v.bg), panel = hexRgb(v.panel), text = hexRgb(v.text);
  const alpha = (100 - v.panelClear) / 100;
  const light = luminance(text) < 0.3;            // тёмный текст — значит, тема светлая
  const panelOn = mix(bg, panel, alpha);          // как панель выглядит поверх фона
  const menu = isHex(v.menu) ? hexRgb(v.menu) : light ? mix(panelOn, [255, 255, 255], 0.75) : mix(panelOn, text, 0.1);
  const search = isHex(v.search) ? hexRgb(v.search) : light ? mix(panelOn, [255, 255, 255], 0.7) : mix(panelOn, text, 0.04);
  return { bg, panel, text, alpha, light, panelOn, menu, search };
}

/** Цвета карточки темы в настройках: [фон, панели, текст, акцент] */
const previewColors = (v) => { const d = derive(v); return [v.bg, rgbHex(d.panelOn), v.text, v.accent]; };

// ---------- Черновик → CSS ----------

/** mode "draft" — для страницы (адреса файлов от корня сайта), "file" — для theme.css (адреса от папки темы) */
function buildCss(v, mode, theme) {
  const d = derive(v);
  const own = (file) => (mode === "draft" ? `${themeBase(theme)}/${encodeURIComponent(file)}` : file);
  const out = [];
  const faces = new Set();
  const stackOf = (font) => {
    if (font.stack) return font.stack;
    if (!font.family) return null;
    if (font.id === "custom" && !v.fontFile) return null;
    if (!faces.has(font.id)) {
      faces.add(font.id);
      const url = font.id === "custom" ? own(v.fontFile) : mode === "draft" ? `/fonts/${font.file}` : font.file;
      out.push(`@font-face {\n  font-family: "${font.family}";\n  src: url("${url}");\n${font.weight ? `  font-weight: ${font.weight};\n` : ""}  font-display: swap;\n}`);
    }
    return `"${font.family}", ${BASE_STACK}`;
  };
  const mainStack = stackOf(fontById(v.font));
  const headStack = v.headFont === "same" ? null : stackOf(fontById(v.headFont));

  out.push(`:root {
  color-scheme: ${d.light ? "light" : "dark"};
  --bg: ${v.bg};
  --tint: ${v.bg};
  --fg-rgb: ${rgbText(d.text)};
  --text: rgb(var(--fg-rgb));
  --muted: rgb(var(--fg-rgb) / ${d.light ? 0.66 : 0.62});
  --faint: rgb(var(--fg-rgb) / ${d.light ? 0.45 : 0.38});
  --line: rgb(var(--fg-rgb) / ${d.light ? 0.12 : 0.1});
  --hover: rgb(var(--fg-rgb) / ${d.light ? 0.07 : 0.08});
  --shade-rgb: ${d.light ? "255 255 255" : "0 0 0"};
  --glass: rgb(${rgbText(d.panel)} / ${d.alpha.toFixed(2)});
  --panel: rgb(${rgbText(d.menu)} / 0.96);
  --menu-bg: rgb(${rgbText(d.menu)} / 0.97);
  --dialog-bg: rgb(${rgbText(d.menu)} / 0.98);
  --search-bg: rgb(${rgbText(d.search)} / ${d.light ? 0.9 : 0.75});
  --search-bg-hover: rgb(${rgbText(mix(d.search, d.text, 0.06))} / ${d.light ? 1 : 0.85});
  --accent: ${v.accent};
  --error: ${d.light ? "#c62828" : "#ff8a80"};
  --radius: ${v.radius}px;
  --gap: ${v.gap}px;${mainStack ? `\n  --font: ${mainStack};` : ""}
}`);
  if (d.light) {
    // Светлая тема: «Играть», главные кнопки и шарики ползунков — тёмные (в обычной Sono они белые
    // и на светлом не видны). У тёмных тем не трогаем — у копии «Кубиков» кнопки свои.
    // На карточках со своим тёмным фоном текст остаётся светлым (как во встроенной «Светлой»)
    out.push(`button.play, .btn.primary { background: rgb(var(--fg-rgb)); color: #fff; }
input[type="range"]::-webkit-slider-thumb { background: rgb(var(--fg-rgb)); }

.flow-card, .pl-hero, .mix-art, .pick-art, .wrapped, .flowv {
  --fg-rgb: 255 255 255;
  --text: rgb(var(--fg-rgb));
  --muted: rgb(var(--fg-rgb) / 0.62);
  --faint: rgb(var(--fg-rgb) / 0.38);
  --line: rgb(var(--fg-rgb) / 0.1);
  --hover: rgb(var(--fg-rgb) / 0.08);
  color: var(--text);
}
:is(.flow-card, .pl-hero, .flowv, .mix-art, .pick-art) button.play { background: #fff; color: #000; }
.bg-art { filter: saturate(0.7) brightness(1.6); }`);
  }
  if (headStack) out.push(`${HEADINGS} { font-family: ${headStack}; }`);
  if (v.image) {
    const blur = v.imageBlur > 0 ? `\n  inset: -${v.imageBlur * 2}px;\n  filter: blur(${v.imageBlur}px);` : "";
    out.push(`.bg-tint {\n  background: var(--tint) url("${own(v.image)}") center / cover no-repeat;${blur}\n}`);
    out.push(`.bg-shade { background: rgb(${rgbText(d.bg)} / ${(v.imageDim / 100).toFixed(2)}); }`);
  }
  if (v.art === 0) out.push(".bg-art { display: none; }");
  else if (v.art !== 60) out.push(`.bg-art.on, body.on-now .bg-art.on { opacity: ${(v.art / 100).toFixed(2)} !important; }`);
  return out.join("\n\n");
}

// ---------- Начальные значения из CSS темы (если тему делали не в редакторе) ----------

const probe = document.createElement("canvas").getContext("2d");
/** Любой цвет CSS → {hex, a}; не понял (например, var(…)) — null */
function parseColor(text) {
  if (!text) return null;
  probe.fillStyle = "#010203";
  probe.fillStyle = text.trim();
  const s = probe.fillStyle;
  if (s === "#010203" && !/^#010203$/i.test(text.trim())) return null;
  if (s.startsWith("#")) return { hex: s, a: 1 };
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(",").map(Number);
  return { hex: rgbHex(p.slice(0, 3)), a: p[3] ?? 1 };
}

/** Читаем :root из CSS темы — чтобы копия «Светлой» открывалась со светлыми цветами, а не с обычными */
function valuesFromSheet(theme) {
  const v = { ...DEFAULTS, cover: theme.coverColors || "on" };
  const sheet = document.getElementById("theme-css")?.sheet;
  let rules = [];
  try { rules = [...(sheet?.cssRules ?? [])]; } catch { /* чужой источник — не бывает, но на всякий случай */ }
  const get = (name) => {
    let value = "";
    for (const r of rules) if (r.selectorText === ":root") value = r.style.getPropertyValue(name) || value;
    return value.trim();
  };
  const bg = parseColor(get("--tint")) || parseColor(get("--bg"));
  if (bg) v.bg = bg.hex;
  const glass = parseColor(get("--glass"));
  if (glass) { v.panel = glass.hex; v.panelClear = Math.round((1 - glass.a) * 100); }
  const fg = get("--fg-rgb");
  const text = fg && parseColor(`rgb(${fg})`);
  if (text) v.text = text.hex;
  const accent = parseColor(get("--accent"));
  if (accent) v.accent = accent.hex;
  const radius = parseFloat(get("--radius"));
  if (Number.isFinite(radius)) v.radius = Math.min(28, Math.max(0, Math.round(radius)));
  const gap = parseFloat(get("--gap"));
  if (Number.isFinite(gap)) v.gap = Math.min(20, Math.max(0, Math.round(gap)));
  return v;
}

/** Значения из theme.json → только известные ключи и в допустимых пределах */
function cleanValues(raw) {
  const v = { ...DEFAULTS };
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const x = raw?.[key];
    if (typeof def === "number" && Number.isFinite(x)) v[key] = x;
    else if (typeof def === "string" && typeof x === "string") v[key] = x;
  }
  for (const key of ["bg", "panel", "text", "accent"]) if (!isHex(v[key])) v[key] = DEFAULTS[key];
  if (!["on", "off", "tint", "accent"].includes(v.cover)) v.cover = "on";
  if (!FONTS.some((f) => f.id === v.font)) v.font = "default";
  if (v.headFont !== "same" && !FONTS.some((f) => f.id === v.headFont)) v.headFont = "same";
  return v;
}

// ---------- Панель ----------

const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.ed {
  height: 100%; display: flex; flex-direction: column;
  background: #141414; color: #ececec; border-left: 1px solid #2b2b2b;
  font: 13px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  color-scheme: dark; -webkit-font-smoothing: antialiased;
}
.mobile .ed { border-left: 0; border-top: 1px solid #2b2b2b; border-radius: 16px 16px 0 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
.head { display: flex; align-items: center; gap: 4px; padding: 10px 10px 8px 14px; }
.grip { display: none; }
.mobile .grip {
  display: block; position: absolute; left: 50%; top: 5px; width: 40px; height: 4px; margin-left: -20px;
  border: 0; border-radius: 2px; background: #555; padding: 0;
}
.mobile .head { position: relative; padding-top: 16px; }
.name {
  flex: 1; min-width: 0; height: 32px; padding: 0 8px; border-radius: 8px;
  border: 1px solid transparent; background: none; font-size: 15px; font-weight: 600;
}
.name:hover { border-color: #333; }
.name:focus { outline: none; border-color: #555; background: #1c1c1c; }
.ib {
  flex: none; width: 32px; height: 32px; display: grid; place-items: center;
  border: 0; border-radius: 8px; background: none; color: #aaa;
}
.ib:hover:not(:disabled) { background: #242424; color: #fff; }
.ib:disabled { opacity: 0.3; cursor: default; }
.ib svg { width: 18px; height: 18px; }
.show { display: flex; align-items: center; gap: 6px; padding: 0 14px 10px; overflow-x: auto; scrollbar-width: none; }
.show span { color: #888; font-size: 12px; flex: none; }
.chip {
  flex: none; height: 26px; padding: 0 10px; border-radius: 999px;
  border: 1px solid #333; background: none; color: #cfcfcf; font-size: 12px; white-space: nowrap;
}
.chip:hover { border-color: #555; color: #fff; }
.chip.on { background: #ececec; border-color: #ececec; color: #111; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 14px 14px; border-top: 1px solid #222; }
.scroll::-webkit-scrollbar { width: 10px; }
.scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 5px; border: 3px solid #141414; }
h3 { margin: 16px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #8a8a8a; }
.row { display: flex; align-items: center; gap: 10px; min-height: 34px; }
.row > .lbl { flex: 1; min-width: 0; }
.range { padding: 4px 0; }
.range .top { display: flex; justify-content: space-between; color: #ccc; }
.range .val { color: #8a8a8a; font-variant-numeric: tabular-nums; }
input[type="range"] { width: 100%; margin: 4px 0 0; accent-color: #e8e8e8; }
.color { display: flex; align-items: center; gap: 6px; }
input[type="color"] {
  width: 34px; height: 26px; padding: 0; border: 1px solid #3a3a3a; border-radius: 7px; background: none; cursor: pointer;
}
input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
input[type="color"]::-webkit-color-swatch { border: 0; border-radius: 5px; }
.hex {
  width: 78px; height: 26px; padding: 0 6px; border-radius: 7px; border: 1px solid #333; background: #1b1b1b;
  font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; text-transform: lowercase;
}
.hex:focus, .txt:focus, select:focus { outline: none; border-color: #666; }
.hex.bad { border-color: #b84a4a; }
select, .txt {
  height: 30px; border-radius: 7px; border: 1px solid #333; background: #1b1b1b; padding: 0 8px; max-width: 100%;
}
select { width: 180px; }
.txt { width: 100%; }
textarea.txt { height: 60px; padding: 6px 8px; resize: vertical; }
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.preset { display: flex; align-items: center; gap: 6px; }
.preset i { width: 12px; height: 12px; border-radius: 50%; border: 1px solid #0006; }
.hint { margin: 2px 0 6px; color: #8a8a8a; font-size: 12px; }
.warn { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: #3a2a12; color: #f3cf8f; font-size: 12px; }
.warn[hidden], [hidden] { display: none !important; }
.btn {
  height: 32px; padding: 0 14px; border-radius: 999px; border: 1px solid #3a3a3a; background: none; font-size: 13px; font-weight: 600;
}
.btn:hover:not(:disabled) { border-color: #666; }
.btn.primary { background: #ececec; border-color: #ececec; color: #111; }
.btn.primary:hover:not(:disabled) { background: #fff; }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn.small { height: 28px; padding: 0 12px; font-size: 12px; font-weight: 500; }
.auto { display: flex; align-items: center; gap: 4px; color: #aaa; font-size: 12px; }
details { margin-top: 14px; border-top: 1px solid #222; padding-top: 4px; }
summary { cursor: pointer; padding: 8px 0; color: #ccc; font-weight: 600; }
.foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid #222; }
.status { flex: 1; min-width: 0; color: #8a8a8a; font-size: 12px; }
.status.dirty { color: #f3cf8f; }
.mobile.collapsed .show, .mobile.collapsed .scroll, .mobile.collapsed .foot { display: none; }
`;

let ed = null;        // открытый редактор (один на всё окно)
let opening = false;

/** Открыть редактор. themeId — своя тема (правим её); встроенная или из мастерской — правим копию;
    без themeId — новая тема с нуля (base — тема, которую взять за основу) */
export async function openThemeEditor({ themeId = null } = {}) {
  if (ed || opening) return;
  opening = true;
  try {
    await loadThemes();
    const prevTheme = currentThemeId("theme");
    let theme = themeId ? themeById(themeId) : null;
    let fresh = false;
    if (!theme || theme.kind !== "user" || theme.workshop || theme.part !== "theme") {
      const res = await fetch("/api/themes/editor/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: theme ? `${theme.name} — моя` : "Моя тема", base: theme?.id ?? null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "не получилось создать тему");
      await loadThemes();
      theme = themeById(data.id);
      fresh = true;
    }
    if (!theme) throw new Error("тема не нашлась");
    if (currentThemeId("theme") !== theme.id) chooseTheme(theme.id);
    await setEditorPreview(true);
    const values = theme.editor ? cleanValues(theme.editor) : valuesFromSheet(theme);
    ed = {
      theme, fresh, prevTheme, saved: false,
      values,
      meta: { name: theme.name, author: theme.author || "", description: theme.description || "" },
      history: [JSON.stringify(values)], pos: 0,
      savedState: "",
      controls: [],        // функции «показать текущее значение» — после «Отменить» и наборов
    };
    ed.savedState = fresh ? "" : stateText();   // новую тему ещё ни разу не сохраняли
    buildPanel();
    render();
  } catch (err) {
    toast(`Редактор тем: ${err.message}`, { error: true });
    await setEditorPreview(false);
  } finally {
    opening = false;
  }
}

export const isEditingTheme = () => !!ed;

const stateText = () => JSON.stringify([ed.values, ed.meta]);
const isDirty = () => stateText() !== ed.savedState;

// ---------- Отрисовка черновика ----------

let frame = 0;
function render() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!ed) return;
    let style = document.getElementById("theme-draft");
    if (!style) {
      style = document.createElement("style");
      style.id = "theme-draft";
      // Сразу после темы и до вида «Сейчас играет» — как кусок в конце theme.css
      const now = document.getElementById("now-css");
      if (now) now.before(style); else document.head.append(style);
    }
    style.textContent = buildCss(ed.values, "draft", ed.theme);
    if (ed.cover !== ed.values.cover) {   // пересчитать цвета обложки — только когда поменяли режим
      ed.cover = ed.values.cover;
      setCoverColorsMode(ed.cover);
    }
    updateStatus();
  });
}

function set(key, value, commit = false) {
  ed.values[key] = value;
  render();
  if (commit) remember();
}

/** Запомнить шаг для «Отменить» (после того, как отпустили ползунок или выбрали цвет) */
function remember() {
  const snap = JSON.stringify(ed.values);
  if (snap === ed.history[ed.pos]) return;
  ed.history = ed.history.slice(0, ed.pos + 1);
  ed.history.push(snap);
  if (ed.history.length > 200) ed.history.shift();
  ed.pos = ed.history.length - 1;
  updateStatus();
}

function step(delta) {
  const pos = ed.pos + delta;
  if (pos < 0 || pos >= ed.history.length) return;
  ed.pos = pos;
  ed.values = JSON.parse(ed.history[pos]);
  ed.controls.forEach((sync) => sync());
  render();
}

// ---------- Построение панели ----------

function h(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function iconBtn(icon, label) {
  const b = h("button", "ib");
  b.type = "button";
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

function colorRow(key, label) {
  const row = h("div", "row");
  const box = h("span", "color");
  const picker = h("input");
  picker.type = "color";
  picker.setAttribute("aria-label", label);
  const hex = h("input", "hex");
  hex.spellcheck = false;
  hex.maxLength = 7;
  hex.setAttribute("aria-label", `${label}, код цвета`);
  const sync = () => { picker.value = ed.values[key]; hex.value = ed.values[key]; hex.classList.remove("bad"); };
  picker.addEventListener("input", () => { hex.value = picker.value; set(key, picker.value); });
  picker.addEventListener("change", () => remember());
  hex.addEventListener("input", () => {
    let v = hex.value.trim().toLowerCase();
    if (!v.startsWith("#")) v = `#${v}`;
    if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    const ok = isHex(v);
    hex.classList.toggle("bad", !ok);
    if (ok) { picker.value = v; set(key, v); }
  });
  hex.addEventListener("change", () => { sync(); remember(); });
  ed.controls.push(sync);
  sync();
  box.append(picker, hex);
  row.append(h("span", "lbl", label), box);
  return row;
}

function rangeRow(key, label, min, max, unit = "", format = null) {
  const wrap = h("div", "range");
  const top = h("div", "top");
  const val = h("span", "val");
  top.append(h("span", "", label), val);
  const input = h("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.step = 1;
  input.setAttribute("aria-label", label);
  const show = () => { val.textContent = format ? format(ed.values[key]) : `${ed.values[key]}${unit}`; };
  const sync = () => { input.value = ed.values[key]; show(); };
  input.addEventListener("input", () => { set(key, Number(input.value)); show(); });
  input.addEventListener("change", () => remember());
  ed.controls.push(sync);
  sync();
  wrap.append(top, input);
  return wrap;
}

function selectRow(key, label, options, onPick = null) {
  const row = h("div", "row");
  const select = h("select");
  select.setAttribute("aria-label", label);
  for (const [value, text] of options) {
    const opt = h("option", "", text);
    opt.value = value;
    select.append(opt);
  }
  const sync = () => { select.value = ed.values[key]; };
  select.addEventListener("change", async () => {
    if (onPick && !(await onPick(select.value))) { sync(); return; }
    set(key, select.value, true);
  });
  ed.controls.push(sync);
  sync();
  row.append(h("span", "lbl", label), select);
  return row;
}

/** Цвет «подобрать сам / свой» (меню, строка поиска) */
function autoColorRow(key, label, auto) {
  const row = h("div", "row");
  const box = h("span", "color");
  const check = h("input");
  check.type = "checkbox";
  const autoLbl = h("label", "auto");
  autoLbl.append(check, document.createTextNode("сам"));
  const picker = h("input");
  picker.type = "color";
  picker.setAttribute("aria-label", label);
  const sync = () => {
    const on = !isHex(ed.values[key]);
    check.checked = on;
    picker.disabled = on;
    picker.value = on ? rgbHex(auto()) : ed.values[key];
  };
  check.addEventListener("change", () => { set(key, check.checked ? "" : picker.value, true); sync(); });
  picker.addEventListener("input", () => set(key, picker.value));
  picker.addEventListener("change", () => remember());
  ed.controls.push(sync);
  sync();
  box.append(autoLbl, picker);
  row.append(h("span", "lbl", label), box);
  return row;
}

function section(title, ...children) {
  const box = h("section");
  box.append(h("h3", "", title), ...children);
  return box;
}

/** Файл с диска: картинка фона уменьшается до 2560 px и сжимается в JPEG (тема для мастерской ≤ 10 МБ) */
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("не получилось сжать картинку"))), "image/jpeg", 0.88));
}

async function upload(what, blob) {
  const res = await fetch(`/api/themes/editor/upload?folder=${encodeURIComponent(ed.theme.folder)}&what=${what}`, {
    method: "POST", body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "не получилось добавить файл");
  return data.file;
}

async function chooseImage(button) {
  const file = await pickFile("image/*");
  if (!file || !ed) return;
  button.disabled = true;
  try {
    const name = await upload("image", await shrinkImage(file));
    if (!ed) return;
    if (!ed.values.image && ed.values.art === 60) ed.values.art = 0;   // обложка поверх картинки её бы закрыла
    set("image", name, true);
    ed.controls.forEach((sync) => sync());
  } catch (err) {
    toast(`Картинка: ${err.message}`, { error: true });
  } finally {
    button.disabled = false;
  }
}

async function chooseFontFile() {
  const file = await pickFile(".ttf,.otf,.woff,.woff2");
  if (!file || !ed) return false;
  try {
    ed.values.fontFile = await upload("font", file);
    return true;
  } catch (err) {
    toast(`Шрифт: ${err.message}`, { error: true });
    return false;
  }
}

function buildPanel() {
  const host = document.createElement("div");
  host.id = "theme-editor";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  const wrap = h("div", isMobile ? "mobile" : "");
  wrap.style.height = "100%";
  const box = h("div", "ed");
  wrap.append(box);
  root.append(style, wrap);

  // Шапка: название, «Отменить», «Вернуть», «Закрыть»
  const head = h("div", "head");
  const grip = h("button", "grip");
  grip.type = "button";
  grip.setAttribute("aria-label", "Свернуть или развернуть редактор");
  grip.addEventListener("click", () => setCollapsed(!wrap.classList.contains("collapsed")));
  const name = h("input", "name");
  name.value = ed.meta.name;
  name.maxLength = 60;
  name.spellcheck = false;
  name.setAttribute("aria-label", "Название темы");
  name.addEventListener("input", () => { ed.meta.name = name.value; updateStatus(); });
  const undo = iconBtn(icons.undo ?? UNDO_ICON, "Отменить (Ctrl+Z)");
  const redo = iconBtn(icons.redo ?? REDO_ICON, "Вернуть (Ctrl+Y)");
  undo.addEventListener("click", () => step(-1));
  redo.addEventListener("click", () => step(1));
  const close = iconBtn(icons.close, "Закрыть редактор");
  close.addEventListener("click", () => closeThemeEditor());
  head.append(grip, name, undo, redo, close);

  // Куда посмотреть: правки видны на настоящих экранах Sono
  const show = h("div", "show");
  show.append(h("span", "", "Показать:"));
  const views = [["Главная", "home"], ["Сейчас играет", "now"], ["Избранное", "liked"], ["Настройки", "settings"]];
  for (const [label, key] of views) {
    const chip = h("button", "chip", label);
    chip.type = "button";
    chip.addEventListener("click", () => openView(key));
    show.append(chip);
  }
  const menuChip = h("button", "chip", "Меню");
  menuChip.type = "button";
  menuChip.addEventListener("click", (e) => {
    e.stopPropagation();
    // Меню — рядом с панелью, а не под ней (панель выше меню по слоям)
    const panel = ed.host.getBoundingClientRect();
    const r = menuChip.getBoundingClientRect();
    const at = isMobile ? { x: 16, y: Math.max(16, panel.top - 170) } : { x: Math.max(8, panel.left - 250), y: r.bottom + 6 };
    openMenu(at, [
      { label: "Так выглядит меню «⋯»", icon: icons.palette, action: () => {} },
      { label: "Добавить в плейлист", icon: icons.addTo, action: () => {} },
      { label: "Удалить", icon: icons.trash, danger: true, action: () => {} },
    ]);
  });
  const dialogChip = h("button", "chip", "Окно");
  dialogChip.type = "button";
  dialogChip.addEventListener("click", () => confirmDialog({
    title: "Так выглядят окна", text: "Цвет окон и меню — в разделе «Тонко» внизу редактора.", okLabel: "Понятно", danger: false,
  }));
  show.append(menuChip, dialogChip);

  // Настройки
  const scroll = h("div", "scroll");
  const presets = h("div", "presets");
  for (const p of PRESETS) {
    const chip = h("button", "chip preset");
    chip.type = "button";
    const dot = h("i");
    dot.style.background = `linear-gradient(135deg, ${p.values.bg} 50%, ${p.values.accent} 50%)`;
    chip.append(dot, document.createTextNode(p.name));
    chip.addEventListener("click", () => {
      Object.assign(ed.values, p.values, { menu: "", search: "" });
      ed.controls.forEach((sync) => sync());
      render();
      remember();
    });
    presets.append(chip);
  }

  const warn = h("p", "warn");
  warn.hidden = true;
  ed.warn = warn;
  const coverHint = h("p", "hint");
  ed.coverHint = coverHint;

  const fontOptions = FONTS.filter((f) => !(isMobile && f.pc)).map((f) => [f.id, f.label]);
  const pickFont = async (value) => (value === "custom" ? chooseFontFile() : true);

  const imageBtns = h("div", "row");
  const imageLbl = h("span", "lbl", "Картинка");
  const imagePick = h("button", "btn small", "Выбрать…");
  imagePick.type = "button";
  imagePick.addEventListener("click", () => chooseImage(imagePick));
  const imageDrop = h("button", "btn small", "Убрать");
  imageDrop.type = "button";
  imageDrop.addEventListener("click", () => { set("image", "", true); ed.controls.forEach((sync) => sync()); });
  imageBtns.append(imageLbl, imagePick, imageDrop);
  const imageOnly = h("div");
  imageOnly.append(rangeRow("imageDim", "Затемнение картинки", 0, 90, " %"), rangeRow("imageBlur", "Размытие картинки", 0, 30, " px"));
  ed.controls.push(() => {
    imageDrop.hidden = !ed.values.image;
    imageOnly.hidden = !ed.values.image;
    imageLbl.textContent = ed.values.image ? "Картинка выбрана" : "Картинка";
  });

  const author = h("input", "txt");
  author.value = ed.meta.author;
  author.maxLength = 60;
  author.placeholder = "Ваш ник";
  author.addEventListener("input", () => { ed.meta.author = author.value; updateStatus(); });
  const desc = h("textarea", "txt");
  desc.value = ed.meta.description;
  desc.maxLength = 300;
  desc.placeholder = "Пара слов о теме — видно при наведении на карточку";
  desc.addEventListener("input", () => { ed.meta.description = desc.value; updateStatus(); });

  const fine = h("details");
  fine.append(h("summary", "", "Тонко: меню, окна, поиск"),
    autoColorRow("menu", "Меню и окна", () => derive(ed.values).menu),
    autoColorRow("search", "Строка поиска", () => derive(ed.values).search));

  scroll.append(
    section("Готовые наборы", presets),
    section("Цвета",
      colorRow("bg", "Фон окна"),
      colorRow("panel", "Панели"),
      colorRow("text", "Текст"),
      colorRow("accent", "Акцент"),
      selectRow("cover", "Цвета от обложки", [["off", "Не брать"], ["tint", "Только фон"], ["accent", "Только акцент"], ["on", "Фон и акцент"]]),
      coverHint, warn),
    section("Форма",
      rangeRow("panelClear", "Прозрачность панелей", 0, 100, " %"),
      rangeRow("radius", "Скругление", 0, 28, " px"),
      rangeRow("gap", "Промежутки между панелями", 0, 20, " px")),
    section("Шрифт",
      selectRow("font", "Основной", fontOptions, pickFont),
      selectRow("headFont", "Заголовки", [["same", "Как основной"], ...fontOptions.filter(([id]) => id !== "default")], pickFont)),
    section("Фон",
      imageBtns, imageOnly,
      rangeRow("art", "Размытая обложка трека", 0, 100, " %")),
    fine,
    section("О теме", h("p", "hint", "Автор"), author, h("p", "hint", "Описание"), desc),
  );

  // Низ: состояние и «Сохранить»
  const foot = h("div", "foot");
  const status = h("span", "status");
  const save = h("button", "btn primary", "Сохранить");
  save.type = "button";
  save.addEventListener("click", () => saveTheme());
  foot.append(status, save);
  box.append(head, show, scroll, foot);
  Object.assign(ed, { host, wrap, undo, redo, status, save, name });

  // Клавиши внутри редактора — его (иначе пробел в поле названия ставил бы музыку на паузу)
  box.addEventListener("keydown", (e) => {
    const typing = e.target.matches?.("input:not([type=range]):not([type=color]):not([type=checkbox]), textarea");
    if ((e.ctrlKey || e.metaKey) && !typing) {
      if (e.code === "KeyZ") { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
      else if (e.code === "KeyY") { e.preventDefault(); step(1); }
      else if (e.code === "KeyS") { e.preventDefault(); saveTheme(); }
    }
    e.stopPropagation();
  });
  document.addEventListener("keydown", onDocKey, true);
  addEventListener("sono:editor-back", onBack);

  // Место: справа во весь рост (под своей полоской заголовка) или шторкой снизу на телефоне
  const top = document.body.classList.contains("custom-titlebar")
    ? getComputedStyle(document.documentElement).getPropertyValue("--titlebar").trim() || "36px" : "0px";
  const css = isMobile
    ? { position: "fixed", left: "0", right: "0", bottom: "0", height: "var(--editor-h)", "z-index": "350", display: "block" }
    : { position: "fixed", top, right: "0", bottom: "0", width: "var(--editor-w)", "z-index": "350", display: "block" };
  for (const [k, v] of Object.entries(css)) host.style.setProperty(k, v, "important");
  document.body.append(host);
  document.body.classList.add("theme-editing");
  setCollapsed(false);
  ed.controls.forEach((sync) => sync());
}

// Свои значки «Отменить» / «Вернуть» (в icons.js таких нет)
const UNDO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const REDO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>';

function setCollapsed(on) {
  if (!ed) return;
  ed.wrap.classList.toggle("collapsed", on && isMobile);
  document.documentElement.style.setProperty("--editor-h", on && isMobile ? "64px" : "46vh");
}

/** Ctrl+Z вне полей ввода, пока открыт редактор, — отменяет шаг редактора */
function onDocKey(e) {
  if (!ed || !(e.ctrlKey || e.metaKey) || e.target === ed.host) return;
  if (e.target.matches?.("input:not([type=range]), textarea, [contenteditable]") || e.target.closest?.(".dialog-backdrop")) return;
  if (e.code === "KeyZ" || e.code === "KeyY") {
    e.preventDefault();
    e.stopPropagation();
    step(e.code === "KeyY" || e.shiftKey ? 1 : -1);
  }
}

function onBack() { closeThemeEditor(); }

function updateStatus() {
  if (!ed?.status) return;
  const dirty = isDirty();
  ed.status.textContent = dirty ? "Есть несохранённые изменения" : ed.saved ? "Сохранено" : "Без изменений";
  ed.status.classList.toggle("dirty", dirty);
  ed.save.disabled = !dirty;
  ed.undo.disabled = ed.pos <= 0;
  ed.redo.disabled = ed.pos >= ed.history.length - 1;
  // Подсказки: цвета от обложки и читаемость текста
  const v = ed.values;
  ed.coverHint.textContent = v.cover === "on" ? "Пока играет трек, фон и акцент берутся из обложки — заданные здесь видны без музыки."
    : v.cover === "tint" ? "Пока играет трек, фон берётся из обложки." : v.cover === "accent" ? "Пока играет трек, акцент берётся из обложки." : "";
  ed.coverHint.hidden = !ed.coverHint.textContent;
  const d = derive(v);
  const textC = contrast(d.text, d.panelOn);
  const accentC = contrast(hexRgb(v.accent), d.panelOn);
  const problems = [];
  if (textC < 4.5) problems.push(`Текст на панелях читается плохо (контраст ${textC.toFixed(1)} из нужных 4,5). Сделайте текст ${d.light ? "темнее" : "светлее"} или панели плотнее.`);
  if (accentC < 2) problems.push("Акцент почти не виден на панелях — ползунок и играющий трек сольются с фоном.");
  ed.warn.textContent = problems.join(" ");
  ed.warn.hidden = !problems.length;
}

// ---------- Сохранить и закрыть ----------

function usedFonts(v) {
  return [v.font, v.headFont].filter((id) => FONTS.some((f) => f.id === id && f.file));
}

async function saveTheme() {
  if (!ed) return false;
  const v = ed.values;
  ed.save.disabled = true;
  try {
    const res = await fetch("/api/themes/editor/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: ed.theme.folder,
        name: ed.meta.name.trim() || ed.theme.folder,
        author: ed.meta.author,
        description: ed.meta.description,
        coverColors: v.cover,
        preview: previewColors(v),
        editor: v,
        css: buildCss(v, "file", ed.theme),
        fonts: usedFonts(v),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "не получилось сохранить");
    ed.saved = true;
    ed.fresh = false;
    ed.savedState = stateText();
    await loadThemes();
    ed.theme = themeById(ed.theme.id) ?? ed.theme;
    toast(`Тема «${ed.theme.name}» сохранена`);
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  } finally {
    updateStatus();
  }
}

/** Сохранить / Не сохранять / Отмена */
function askSave() {
  return new Promise((resolve) => {
    let result = "cancel";
    const { box, close } = openModal({ onClose: () => resolve(result) });
    box.append(el("h2", "", "Сохранить изменения в теме?"),
      el("p", "", ed.fresh ? "Если не сохранить, новая тема не появится." : "Если не сохранить, тема останется как была."));
    const row = el("div", "dialog-buttons");
    const button = (label, cls, value) => {
      const b = el("button", `btn ${cls}`, label);
      b.type = "button";
      b.addEventListener("click", () => { result = value; close(); });
      return b;
    };
    const ok = button("Сохранить", "primary", "save");
    row.append(button("Отмена", "ghost", "cancel"), button("Не сохранять", "ghost", "discard"), ok);
    box.append(row);
    box.addEventListener("submit", (e) => { e.preventDefault(); result = "save"; close(); });
    ok.focus();
  });
}

export async function closeThemeEditor() {
  if (!ed || ed.closing) return;
  ed.closing = true;
  if (isDirty()) {
    const answer = await askSave();
    if (answer === "cancel" || (answer === "save" && !(await saveTheme()))) { ed.closing = false; return; }
  }
  const { theme, saved, prevTheme, host } = ed;
  ed = null;
  cancelAnimationFrame(frame);
  frame = 0;
  document.getElementById("theme-draft")?.remove();
  document.removeEventListener("keydown", onDocKey, true);
  removeEventListener("sono:editor-back", onBack);
  host.remove();
  document.body.classList.remove("theme-editing");
  document.documentElement.style.removeProperty("--editor-h");
  await setEditorPreview(false);
  // Ничего не сохранили — всё как было до редактора (новую тему убираем). Сохранили — тема остаётся включённой
  if (!saved) chooseTheme(prevTheme);
  else chooseTheme(theme.id);
  try {
    await fetch("/api/themes/editor/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: theme.folder }),
    });
  } catch { /* не ответил — лишние файлы уберутся при следующем сохранении */ }
  await loadThemes();
  if (!saved) chooseTheme(prevTheme);   // перерисовать карточки тем
}
