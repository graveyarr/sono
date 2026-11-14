// Визуализация на «Сейчас играет» — за плеером, снизу экрана. Пять видов на выбор (VIZ_STYLES):
// «Капсулы» (закруглённые столбики), «Волна» (залитая кривая спектра), «Струна» (сама звуковая волна,
// как осциллограф), «Рассвет» (лучи полукругом), «Искры» (огоньки летят вверх).
// Движение — настоящий звук (Web Audio, AnalyserNode). Цвета — палитра обложки или выбранный набор.
// Те же цвета обложки получает фон «Сейчас играет» (событие sono:cover-colors → nowbg.js).
// Выключается в настройках (settings.visualizer), вид — settings.vizStyle. Тема может задать свой
// вид строкой «:root { --viz-style: wave; }» — он действует, пока слушатель не выбрал вид сам.

import { animFrame } from "./raf.js";
import { analyserNode, audioContext, onAudioReady } from "./audio.js";
import { getSetting, motionOff } from "./library.js";
import { isMobile } from "./device.js";

const audio = document.getElementById("player");
const coverEl = document.getElementById("cover");
const canvas = document.getElementById("viz");
const g = canvas.getContext("2d");

const MIN_HZ = 35, MAX_HZ = 16000;

let actx = null, analyser = null, freq = null;
let bars = [];
let coverColors = [[275, 80, 55], [330, 85, 58], [25, 90, 55], [55, 90, 55], [140, 75, 48], [200, 85, 55], [235, 80, 55]];
let palette = coverColors;   // чем красим сейчас: цвета обложки или выбранные в настройках
let running = false;

export const vizEnabled = () => getSetting("visualizer", true) !== false;

// ---------- Вид визуализации (Настройки → Оформление) ----------
// icon — маленькая картинка для плитки в настройках (цвет — currentColor)
const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const VIZ_STYLES = [
  { id: "bars", title: "Капсулы", hint: "Закруглённые столбики: басы слева, верха справа.",
    icon: svg('<path d="M5 20v-6M9.7 20V8M14.3 20v-9M19 20v-4"/>') },
  { id: "wave", title: "Волна", hint: "Плавная залитая кривая всех частот.",
    icon: svg('<path d="M3 19c3 0 3-9 6-9s3 5 6 5 3-8 6-8"/><path d="M3 21h18" opacity=".4"/>') },
  { id: "line", title: "Струна", hint: "Сама звуковая волна, как на экране осциллографа.",
    icon: svg('<path d="M2 12c2-6 3-6 4.5 0s2.5 6 4 0 2.5-8 4 0 2.5 5 4 0 2-3 3.5 0"/>') },
  { id: "sun", title: "Рассвет", hint: "Лучи полукругом снизу: басы в середине, верха по краям.",
    icon: svg('<path d="M7 20a5 5 0 0 1 10 0M12 11V5M7.5 13.5 4 10M16.5 13.5 20 10M5 17.5H2M19 17.5h3"/>') },
  { id: "dots", title: "Искры", hint: "Огоньки поднимаются снизу: на басах — быстрее и ярче.",
    icon: svg('<circle cx="6" cy="17" r="1.6"/><circle cx="12" cy="9" r="2.2"/><circle cx="17.5" cy="15" r="1.3"/><circle cx="16" cy="5" r="1"/><circle cx="8" cy="5.5" r=".9"/>') },
];
const STYLE_IDS = VIZ_STYLES.map((s) => s.id);

/** Вид, который задала тема строкой «--viz-style: …» (или null) */
export function themeVizStyle() {
  const v = getComputedStyle(canvas).getPropertyValue("--viz-style").trim();
  return STYLE_IDS.includes(v) ? v : null;
}
/** Что выбрано в настройках: "theme" — как в теме (по умолчанию) или id вида */
export const vizStyleSetting = () => {
  const v = getSetting("vizStyle", "theme");
  return STYLE_IDS.includes(v) ? v : "theme";
};
let style = "bars";   // чем рисуем сейчас
function readStyle() {
  const s = vizStyleSetting();
  const next = s === "theme" ? themeVizStyle() ?? "bars" : s;
  if (next !== style) { style = next; resetStyle(); }
}
/** Вид или тему поменяли — перечитать и перерисовать */
export function applyVizStyle() {
  readStyle();
  refreshViz();
}

// ---------- Цвета на выбор (Настройки → Оформление) ----------
// settings.vizColors: "cover" — по обложке (как было), id набора или { custom: ["#rrggbb", "#rrggbb"] }
export const VIZ_PRESETS = [
  { id: "cover", title: "По обложке" },
  { id: "neon", title: "Неон", colors: [[300, 90, 58], [265, 85, 60], [190, 95, 52]] },
  { id: "sunset", title: "Закат", colors: [[22, 95, 56], [345, 85, 58], [285, 70, 55]] },
  { id: "ocean", title: "Океан", colors: [[170, 75, 45], [195, 85, 52], [225, 80, 58]] },
  { id: "forest", title: "Лес", colors: [[95, 60, 45], [140, 55, 42], [165, 60, 40]] },
  { id: "fire", title: "Огонь", colors: [[50, 95, 55], [25, 95, 52], [2, 85, 52]] },
  { id: "mono", title: "Белый", colors: [[0, 0, 88], [0, 0, 70], [0, 0, 88]] },
  { id: "custom", title: "Свои" },
];

export const vizColorsSetting = () => getSetting("vizColors", "cover");

/** «#ff8800» → [оттенок, насыщенность, яркость] — как у палитры обложки */
export function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, gg = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, gg, b), min = Math.min(r, gg, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (gg - b) / d + (gg < b ? 6 : 0) : max === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
  return [h * 60, s * 100, l * 100];
}

/** Палитра по настройке; у своих цветов яркость держим в 35–80%, иначе столбики пропадут на тёмном фоне */
export function paletteFor(setting) {
  if (setting && typeof setting === "object" && Array.isArray(setting.custom)) {
    const cols = setting.custom.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map(hexToHsl)
      .map(([h, s, l]) => [h, s, Math.min(Math.max(l, 35), 80)]);
    if (cols.length === 1) cols.push(cols[0]);
    if (cols.length) return cols;
  }
  return VIZ_PRESETS.find((p) => p.id === setting)?.colors ?? coverColors;
}

/** Настройку поменяли — перекрасить сразу */
export function applyVizColors() {
  palette = paletteFor(vizColorsSetting());
}

// ---------- Звук ----------
// Анализатор — последнее звено звуковой цепочки (audio.js); цепочка появляется после первого щелчка
function attachAnalyser() {
  actx = audioContext();
  analyser = analyserNode();
  if (!analyser) return;
  freq = new Uint8Array(analyser.frequencyBinCount);
  startEq();
}

// ---------- Палитра обложки ----------
// Гистограмма оттенков насыщенных пикселей: берём до 4 самых заметных, отстоящих друг от друга.
let coverLight = 0.6;   // средняя светлота последней обложки, 0–1

function coverPalette(img) {
  const size = 32;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0, size, size);
  const px = x.getImageData(0, 0, size, size).data;
  const bins = new Float32Array(36);   // по 10°
  const satSum = new Float32Array(36);
  let colored = 0, lightAll = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, gg, b), min = Math.min(r, gg, b), l = (max + min) / 2, d = max - min;
    lightAll += l;
    if (d < 0.12 || l < 0.12 || l > 0.92) continue;   // серое, чёрное, белое — не цвет
    let h = max === r ? (gg - b) / d + (gg < b ? 6 : 0) : max === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
    const k = Math.floor(h * 6) % 36;
    bins[k] += d;
    satSum[k] += (l > 0.5 ? d / (2 - max - min) : d / (max + min)) * d;
    colored++;
  }
  const total = size * size;
  coverLight = lightAll / total;   // для серой палитры (greyPalette)
  const share = colored / total;   // какая часть обложки вообще цветная
  // Почти вся обложка серая/белая/чёрная (карандашный рисунок, ч/б фото) — столбики серые.
  // Раньше хватало одного маленького пятна: вся палитра становилась его цветом (баг 10 ноября:
  // белая обложка с небольшим красным пятном → красно-оранжевые столбики)
  if (share < 0.06) return null;
  const picks = [];
  const order = [...bins.keys()].sort((a, b) => bins[b] - bins[a]);
  for (const i of order) {
    // Оттенок, которого на обложке в разы меньше главного, — случайные пиксели, не цвет обложки
    if (bins[i] <= bins[order[0]] * 0.18 || picks.length >= 4) break;
    if (picks.every((p) => Math.min(Math.abs(p - i), 36 - Math.abs(p - i)) >= 4)) picks.push(i);
  }
  if (!picks.length) return null;
  // Насыщенность — как на самой обложке (приглушённая обложка — приглушённые столбики), а не всегда 82%.
  // Если цветного на обложке мало (6–30%), цвет ещё бледнее: обложка в основном серая
  const muted = Math.min(1, share / 0.3);
  const satOf = (i) => Math.round(Math.min(85, Math.max(28, (satSum[i] / bins[i]) * 100 * 1.1)) * (0.45 + 0.55 * muted));
  let cols = picks.map((i) => [i * 10 + 5, satOf(i)]).sort((a, b) => a[0] - b[0]);
  // Один-два цвета — перелив соседними оттенками, но близкими (±12°): дальние (±35°) выдумывали цвета,
  // которых на обложке нет (красное пятно давало малиновый и оранжевый)
  if (cols.length === 1) cols = [[cols[0][0] - 12, cols[0][1]], cols[0], [cols[0][0] + 12, cols[0][1]]];
  if (cols.length === 2) cols = [cols[0], [(cols[0][0] + cols[1][0]) / 2, (cols[0][1] + cols[1][1]) / 2], cols[1]];
  const palette = cols.map(([h, s], i) => [((h % 360) + 360) % 360, s, 50 + (i % 2) * 6]);
  // Цветного мало — между цветами вставляем серый цвета самой обложки: она в основном серая
  if (share < 0.3) {
    const grey = [0, 0, Math.round(Math.min(80, Math.max(55, coverLight * 100)))];
    return [grey, ...palette.flatMap((c) => [c, grey])];
  }
  return palette;
}

/** Серая палитра для обложки без цвета: чем светлее обложка, тем светлее столбики */
function greyPalette() {
  const v = Math.round(Math.min(82, Math.max(52, coverLight * 100)));
  return [[0, 0, v], [0, 0, v - 12], [0, 0, v]];
}

function colorAt(t) {
  const pos = t * (palette.length - 1);
  const i = Math.min(Math.floor(pos), palette.length - 2), f = pos - i;
  const [h1, s1, l1] = palette[i], [h2, s2, l2] = palette[i + 1];
  let dh = h2 - h1;
  if (Math.abs(dh) > 180) dh -= Math.sign(dh) * 360;   // через короткую дугу
  return [h1 + dh * f, s1 + (s2 - s1) * f, l1 + (l2 - l1) * f];
}

// ---------- Отрисовка ----------

function resize() {
  // Чёткость выше 1 тут не видна (столбики мягкие), а память на холст растёт вчетверо
  const dpr = Math.min(devicePixelRatio || 1, 1.25);
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  size = { W: width, H: height };
  const n = Math.max(24, Math.min(80, Math.round(width / 22)));
  // Число столбиков поменялось (например, прячут медиатеку и панель растёт) — пересчитываем
  // текущие высоты под новое число, а не обнуляем: иначе на время анимации всё «пропадало»
  if (bars.length !== n) {
    const old = bars;
    bars = Array.from({ length: n }, (_, i) => (old.length ? old[Math.min(old.length - 1, Math.floor((i / n) * old.length))] : 0));
  }
}

/** Свежий спектр в freq (один раз за кадр — им пользуются и большая визуализация, и маленькие «эквалайзеры») */
let spectrumAt = -1;
function readSpectrum(ts) {
  if (spectrumAt === ts) return;   // в одном кадре обе отрисовки получают одно и то же время
  spectrumAt = ts;
  // Анализатор слышит звук уже после ползунка громкости — сдвигаем шкалу на столько же децибел,
  // чтобы столбики были одинаковыми и на тихой громкости, и на громкой
  const shift = 20 * Math.log10(Math.max(audio.volume, 0.003));
  if (Math.abs(analyser.maxDecibels - (-22 + shift)) > 0.5) {
    analyser.minDecibels = -200;   // порядок важен: min всегда должен быть меньше max
    analyser.maxDecibels = -22 + shift;
    analyser.minDecibels = -88 + shift;
  }
  analyser.getByteFrequencyData(freq);
}

/** Средний уровень в полосе частот (0…1) */
function band(loHz, hiHz) {
  const hzPerBin = actx.sampleRate / analyser.fftSize;
  const a = Math.max(1, Math.floor(loHz / hzPerBin)), b = Math.min(freq.length, Math.ceil(hiHz / hzPerBin));
  let sum = 0;
  for (let k = a; k < b; k++) sum += freq[k];
  return sum / Math.max(1, b - a) / 255;
}

/** Уровни басов, середины и верхов прямо сейчас (0…1) — для живого фона Flow. Тишина/пауза — нули */
export function musicLevels(ts) {
  if (!analyser || audio.paused) return { bass: 0, mid: 0, high: 0 };
  readSpectrum(ts);
  return { bass: Math.min(1, band(40, 180)), mid: Math.min(1, band(300, 2000) * 1.25), high: Math.min(1, band(2500, 9000) * 1.7) };
}

/** Палитра текущей обложки: [[оттенок, насыщенность, светлота], …] */
export const currentPalette = () => palette;

// ---------- Маленькие «эквалайзеры» у играющего трека и плейлиста ----------
// Три палочки — басы, середина, верха настоящего звука (раньше качались по CSS-анимации, просто так).
// Работают везде, где они видны, а не только на «Сейчас играет». Пока нет звуковой цепочки
// (до первого щелчка) — остаётся прежняя CSS-анимация.
const EQ_BARS = ".lib-item.playing-from .eq i, .track.current .t-eq i, .up-next-item.now .eq i";
const EQ_BANDS = [[40, 180], [300, 2000], [2500, 9000]];
const EQ_GAIN = [1, 1.25, 1.7];   // середина и верха в музыке тише — подтягиваем
const eqLevels = [0, 0, 0];
const eqLow = [1, 1, 1], eqHigh = [0, 0, 0];   // «коридор» громкости каждой полосы в этой песне
let eqRunning = false;

function eqTick(ts) {
  if (!analyser || audio.paused || motionOff()) {   // «Без анимаций» включили на ходу — палочки замирают
    eqRunning = false;
    document.body.classList.remove("eq-live");
    document.querySelectorAll(EQ_BARS).forEach((i) => { i.style.height = ""; });
    return;
  }
  readSpectrum(ts);
  EQ_BANDS.forEach(([lo, hi], n) => {
    const raw = Math.min(1, band(lo, hi) * EQ_GAIN[n]);
    // Средний уровень полосы почти не меняется (в громкой песне всегда ~0.6) — палочки еле шевелились.
    // Поэтому меряем относительно «коридора» этой песни: нижняя и верхняя границы медленно подстраиваются,
    // и палочка ходит от низа до верха вместе с битом
    eqLow[n] = Math.min(raw, eqLow[n] + 0.0015);
    eqHigh[n] = Math.max(raw, eqHigh[n] - 0.0015);
    const v = Math.min(1, Math.max(0, (raw - eqLow[n]) / Math.max(0.12, eqHigh[n] - eqLow[n])));
    eqLevels[n] = v > eqLevels[n] ? v : eqLevels[n] + (v - eqLevels[n]) * 0.22;   // вверх сразу, вниз плавно
  });
  if (!document.body.classList.contains("eq-live")) document.body.classList.add("eq-live");
  document.querySelectorAll(EQ_BARS).forEach((i, k) => {
    // Высота целыми пикселями (4…14 px), а не scaleY: сжатие через transform размывало края
    // 3-пиксельных палочек, и у значка появлялись лишние полупрозрачные пиксели (скриншот друга).
    // Не ниже 4 px: прижатые к низу палочки выглядели как сломанные чёрточки
    i.style.height = `${Math.round(4 + 10 * eqLevels[k % 3])}px`;
  });
  animFrame(eqTick);
}

function startEq() {
  if (eqRunning || !analyser || audio.paused || motionOff()) return;   // «Без анимаций» — палочки стоят
  eqRunning = true;
  animFrame(eqTick);
}

/** Уровни полос: частоты по логарифмической шкале, как слышит ухо */
function levels(ts, n = bars.length) {
  const out = new Array(n).fill(0);
  if (!analyser || audio.paused) return out;
  readSpectrum(ts);
  const hzPerBin = actx.sampleRate / analyser.fftSize;
  for (let i = 0; i < n; i++) {
    const lo = MIN_HZ * (MAX_HZ / MIN_HZ) ** (i / n), hi = MIN_HZ * (MAX_HZ / MIN_HZ) ** ((i + 1) / n);
    const a = Math.max(1, Math.floor(lo / hzPerBin)), b = Math.max(a + 1, Math.ceil(hi / hzPerBin));
    let sum = 0, peak = 0;
    for (let k = a; k < b && k < freq.length; k++) { sum += freq[k]; peak = Math.max(peak, freq[k]); }
    const v = (sum / (b - a)) * 0.6 + peak * 0.4;
    // Верха в музыке тише — чуть приподнимаем, чтобы правая часть тоже жила
    out[i] = Math.min(1, (v / 255) * (0.9 + (i / n) * 0.45));
  }
  return stretch(out, ts);
}

// ---------- «Коридор» громкости песни ----------
// Шкала децибел у анализатора одна на все песни. Громко сведённый трек (баг 14 ноября: bleood «peeley»)
// держал столбики на 60–95 % высоты — они стояли «забором» и еле шевелились. Поэтому, как у маленьких
// «эквалайзеров», каждая полоса меряется относительно своего коридора в этой песне: нижняя и верхняя
// границы медленно подстраиваются (~0,1 в секунду). Немного исходного уровня оставляем, чтобы басы
// всё равно были выше верхов — форма спектра не теряется. Коридор свой для каждого числа полос.
const corridors = new Map();   // n → { lo, hi, at }
const CORRIDOR_SPEED = 0.1;    // на сколько за секунду границы ползут навстречу звуку
const CORRIDOR_MIN = 0.28;     // уже нельзя: в ровной полосе (тянущийся 808) раздувался бы шум

function stretch(raw, ts) {
  const n = raw.length;
  let c = corridors.get(n);
  if (!c) {
    c = { lo: Float32Array.from(raw), hi: Float32Array.from(raw), at: ts };
    corridors.set(n, c);
  }
  const step = Math.min(0.05, Math.max(0, (ts - c.at) / 1000) * CORRIDOR_SPEED);
  c.at = ts;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    c.lo[i] = Math.min(v, c.lo[i] + step);
    c.hi[i] = Math.max(v, c.hi[i] - step);
    const width = Math.max(CORRIDOR_MIN, c.hi[i] - c.lo[i]);
    const norm = Math.min(1, Math.max(0, (v - c.lo[i]) / width));
    raw[i] = v * 0.3 + norm * 0.7;
  }
  return raw;
}

/** Уровни n полос спектра прямо сейчас (0…1) — для живой полосы перемотки (seekviz.js). Пауза — нули */
export const spectrumLevels = (n, ts) => levels(ts, n);

let size = { W: 0, H: 0 };

let needResize = false;

/** Высоты полос с «инерцией»: растут быстро, опадают плавно и с замедлением. true — ещё что-то видно */
function settle(target, lv) {
  let alive = false;
  for (let i = 0; i < target.length; i++) {
    const v = lv[i] ?? 0, b = target[i];
    target[i] = v > b ? b + (v - b) * 0.55 : Math.max(v, b - Math.max(0.008, (b - v) * 0.12));
    if (target[i] > 0.004) alive = true;
  }
  return alive;
}

/** Соседние полосы немного сглаживаем — получается плавная «волна», а не частокол */
const smooth = (raw) => raw.map((v, i) => (raw[i - 1] ?? v) * 0.22 + v * 0.56 + (raw[i + 1] ?? v) * 0.22);

const hsl = ([h, s, l], dl = 0, a = 1) => `hsl(${h} ${s}% ${l + dl}% / ${a})`;

/** Горизонтальный перелив палитры на всю ширину (для «Волны» и «Струны») */
function paletteGradient(W, dl = 0, a = 1) {
  const gr = g.createLinearGradient(0, 0, W, 0);
  const steps = Math.max(2, palette.length);
  for (let k = 0; k < steps; k++) gr.addColorStop(k / (steps - 1), hsl(colorAt(k / (steps - 1)), dl, a));
  return gr;
}

// ---------- «Капсулы» ----------
function drawBars(ts, W, H) {
  const lv = smooth(levels(ts));
  const n = bars.length;
  const alive = settle(bars, lv);
  const colW = W / n, w = Math.max(4, colW * 0.56), r = w / 2;
  const base = H - 6, maxH = H * 0.9;
  for (let i = 0; i < n; i++) {
    const h = bars[i] * maxH;
    if (h < 1) continue;
    const c = colorAt(i / Math.max(1, n - 1));
    const x = i * colW + (colW - w) / 2, top = base - Math.max(h, w);
    // Капсула: к верху — насыщенный цвет обложки, к низу растворяется
    const grad = g.createLinearGradient(0, top, 0, base);
    grad.addColorStop(0, hsl(c, 8));
    grad.addColorStop(0.55, hsl(c, 0, 0.75));
    grad.addColorStop(1, hsl(c, -10, 0.08));
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(x, top, w, base - top, [r, r, r * 0.4, r * 0.4]);
    g.fill();
  }
  return alive;
}

// ---------- «Волна» ----------
// Две кривые: спереди — сам спектр, сзади — его «эхо» (опадает медленнее), бледнее.
let wave = [], waveEcho = [];

/** Плавная кривая через точки (середины отрезков + quadraticCurveTo) */
function curve(pts, startOnBase, H) {
  g.beginPath();
  if (startOnBase) g.moveTo(0, H);
  pts.forEach(([x, y], i) => {
    if (!i) { startOnBase ? g.lineTo(x, y) : g.moveTo(x, y); return; }
    const [px, py] = pts[i - 1];
    g.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
  });
  const [lx, ly] = pts[pts.length - 1];
  g.lineTo(lx, ly);
  if (startOnBase) { g.lineTo(lx, H); g.closePath(); }
}

function drawWave(ts, W, H) {
  const n = Math.max(20, Math.min(64, Math.round(W / 26)));
  if (wave.length !== n) { wave = new Array(n).fill(0); waveEcho = new Array(n).fill(0); }
  const lv = smooth(smooth(levels(ts, n)));
  const alive = settle(wave, lv);
  // Эхо держит вершины и опадает медленно
  for (let i = 0; i < n; i++) waveEcho[i] = Math.max(wave[i], waveEcho[i] - 0.006);
  if (!alive && waveEcho.every((v) => v < 0.004)) return false;
  const base = H - 2, maxH = H * 0.85;
  const toPts = (arr) => arr.map((v, i) => [(i / (n - 1)) * W, base - v * maxH]);
  // Вертикальное растворение — маской холста (CSS), здесь только перелив по ширине
  g.globalAlpha = 0.28;
  g.fillStyle = paletteGradient(W, 6);
  curve(toPts(waveEcho), true, H);
  g.fill();
  const front = toPts(wave);
  const fill = g.createLinearGradient(0, base - maxH, 0, base);
  fill.addColorStop(0, "rgba(0,0,0,0)");
  fill.addColorStop(1, "rgba(0,0,0,0.55)");
  g.globalAlpha = 0.7;
  g.fillStyle = paletteGradient(W);
  curve(front, true, H);
  g.fill();
  g.globalAlpha = 1;
  g.fillStyle = fill;   // к низу темнее — объём
  g.fill();
  g.strokeStyle = paletteGradient(W, 14);
  g.lineWidth = 2.5;
  g.lineJoin = "round";
  curve(front, false, H);
  g.stroke();
  return true;
}

// ---------- «Струна» ----------
// Сама звуковая волна (не спектр). Чтобы не дрожала: смягчаем верха простым фильтром, начинаем
// с места, где волна идёт вверх через ноль (как «синхронизация» у осциллографа), и смешиваем с прошлым кадром.
let tbuf = null, line = null, lineGain = 0.25;

function drawLine(ts, W, H) {
  const pts = Math.max(90, Math.min(260, Math.round(W / 6)));
  if (!line || line.length !== pts) line = new Float32Array(pts);
  let amp = 0;
  if (analyser && !audio.paused) {
    if (!tbuf || tbuf.length !== analyser.fftSize) tbuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(tbuf);
    // Громкость ползунка уже в звуке — делим обратно, чтобы струна была одинаковой на любой громкости
    const vol = Math.max(audio.volume, 0.003);
    // Оставляем басы и низ середины (фильтр дважды, ~280 Гц): с верхами линия превращалась в «ёжика»
    const a = 1 - Math.exp((-2 * Math.PI * 280) / actx.sampleRate);
    const N = tbuf.length;
    let y = 0, y2 = 0;
    for (let i = 0; i < N; i++) { y += a * (tbuf[i] / vol - y); y2 += a * (y - y2); tbuf[i] = y2; }
    const span = Math.round(actx.sampleRate * 0.045);   // на экране — 45 мс звука: несколько волн баса
    // Синхронизация: первый переход через ноль вверх во второй четверти записи
    let start = Math.floor(N / 4);
    for (let i = start; i < N - span - 1; i++) if (tbuf[i] <= 0 && tbuf[i + 1] > 0) { start = i; break; }
    let peak = 0;
    for (let k = 0; k < pts; k++) {
      const v = tbuf[Math.min(N - 1, start + Math.floor((k / (pts - 1)) * span))];
      peak = Math.max(peak, Math.abs(v));
      line[k] = line[k] * 0.45 + v * 0.55;
    }
    // Своя «громкость» под песню: тихая и громкая одинаково заполняют экран
    lineGain = peak > lineGain ? lineGain + (peak - lineGain) * 0.3 : Math.max(0.04, lineGain * 0.995);
    amp = 1;
  } else {
    for (let k = 0; k < pts; k++) line[k] *= 0.85;   // пауза — струна успокаивается
  }
  const mid = H * 0.62, reach = H * 0.42;
  let still = true;
  const xy = [];
  for (let k = 0; k < pts; k++) {
    // К краям струна «закреплена» — затухает, как настоящая
    const edge = Math.sin((k / (pts - 1)) * Math.PI) ** 0.6;
    const v = Math.max(-1, Math.min(1, line[k] / (lineGain * 1.15))) * edge;
    if (Math.abs(v) > 0.01) still = false;
    xy.push([(k / (pts - 1)) * W, mid - v * reach]);
  }
  g.lineJoin = g.lineCap = "round";
  // Мягкое свечение — та же линия толще и прозрачнее (shadowBlur на телефоне дорогой)
  g.strokeStyle = paletteGradient(W, 6, 0.16);
  g.lineWidth = 10;
  curve(xy, false, H);
  g.stroke();
  g.strokeStyle = paletteGradient(W, 16);
  g.lineWidth = 2.5;
  g.stroke();
  return amp > 0 || !still;
}

// ---------- «Рассвет» ----------
let rays = [];

function drawSun(ts, W, H) {
  const half = Math.max(12, Math.min(28, Math.round(W / 60)));   // лучей на половину круга
  if (rays.length !== half) rays = new Array(half).fill(0);
  const lv = smooth(levels(ts, half));
  const alive = settle(rays, lv);
  const cx = W / 2, cy = H + 4;
  const r0 = Math.min(W * 0.11, H * 0.3);
  const reach = Math.min(H * 0.92 - r0, W * 0.5 - r0);
  const n = half * 2;
  const step = Math.PI / n;
  const width = Math.max(3, Math.min(14, r0 * step * 1.4));
  // Солнце: круг дышит басами
  const bass = (rays[0] + rays[1] + rays[2]) / 3;
  const sun = g.createRadialGradient(cx, cy, 0, cx, cy, r0 * (0.95 + bass * 0.25));
  sun.addColorStop(0, hsl(colorAt(0), 12, 0.55));
  sun.addColorStop(1, hsl(colorAt(0), 0, 0));
  g.fillStyle = sun;
  g.beginPath();
  g.arc(cx, cy, r0 * (0.95 + bass * 0.25), Math.PI, 0);
  g.fill();
  g.lineCap = "round";
  g.lineWidth = width;
  for (let i = 0; i < n; i++) {
    // Басы — в середине (наверху), верха — у горизонта, слева и справа одинаково
    const k = i < half ? half - 1 - i : i - half;
    const v = rays[k];
    const ang = Math.PI + (i + 0.5) * step;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const a = r0 + width, b = a + 4 + v * reach;
    const c = colorAt(k / Math.max(1, half - 1));
    const gr = g.createLinearGradient(cx + cos * a, cy + sin * a, cx + cos * b, cy + sin * b);
    gr.addColorStop(0, hsl(c, -6, 0.35));
    gr.addColorStop(1, hsl(c, 10));
    g.strokeStyle = gr;
    g.beginPath();
    g.moveTo(cx + cos * a, cy + sin * a);
    g.lineTo(cx + cos * b, cy + sin * b);
    g.stroke();
  }
  return alive;
}

// ---------- «Искры» ----------
// Огоньки рождаются снизу, чем громче — тем чаще; басы разгоняют их и делают крупнее.
// Цвет — по месту на экране (как перелив у столбиков). Цвета считаем раз за кадр — 12 оттенков.
let sparks = [], sparkBass = 0;
const SPARK_MAX = isMobile ? 70 : 150;

function drawDots(ts, W, H) {
  const playing = analyser && !audio.paused;
  let bass = 0, loud = 0;
  if (playing) {
    readSpectrum(ts);
    bass = Math.min(1, band(40, 160) * 1.05);
    loud = Math.min(1, band(200, 6000) * 1.4);
  }
  // Удар — басы резко выше привычного уровня
  const kick = Math.max(0, bass - sparkBass) * 3;
  sparkBass += (bass - sparkBass) * 0.08;
  const rate = playing ? (0.15 + loud * 1.6 + kick * 6) * (W / 1200) : 0;
  let born = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
  while (born-- > 0 && sparks.length < SPARK_MAX) {
    sparks.push({ x: Math.random() * W, y: H + 4, v: 0.5 + Math.random() * 0.9, r: 1.6 + Math.random() * 2.6 + kick * 3, ph: Math.random() * 6.3 });
  }
  const tones = Array.from({ length: 12 }, (_, k) => hsl(colorAt(k / 11), 12));
  const boost = 1 + bass * 1.6 + kick * 3;
  const next = [];
  for (const p of sparks) {
    p.y -= p.v * boost * (H / 420);
    p.x += Math.sin(p.y * 0.03 + p.ph) * 0.35;
    if (p.y < -8) continue;
    next.push(p);
    const life = Math.min(1, p.y / (H * 0.85));   // к верху гаснут
    g.globalAlpha = Math.max(0, life) * (0.55 + bass * 0.45);
    g.fillStyle = tones[Math.max(0, Math.min(11, Math.floor((p.x / W) * 12)))];
    g.beginPath();
    g.arc(p.x, p.y, p.r * (0.8 + bass * 0.5), 0, 6.2832);
    g.fill();
  }
  g.globalAlpha = 1;
  sparks = next;
  return sparks.length > 0;
}

/** Вид поменяли — забываем состояние прошлого, чтобы новый начинал с нуля */
function resetStyle() {
  wave = []; waveEcho = []; rays = []; sparks = []; line = null;
  if (size.W) g.clearRect(0, 0, size.W, size.H);
}

const DRAW = { bars: drawBars, wave: drawWave, line: drawLine, sun: drawSun, dots: drawDots };

function draw(ts) {
  // Размер меняем здесь, в начале кадра: изменение размера стирает холст, и если делать это
  // в ResizeObserver (он срабатывает уже после отрисовки), то пока панель анимируется
  // (прячут медиатеку), каждый кадр оставался пустым — визуализация «пропадала»
  if (needResize) { needResize = false; resize(); }
  const { W, H } = size;
  g.clearRect(0, 0, W, H);
  const alive = (DRAW[style] ?? drawBars)(ts, W, H);
  // Ушли с «Сейчас играет» (или выключили визуализацию) — не рисуем скрытый холст; вернутся — refreshViz запустит снова
  if (running && shouldRun() && (alive || !audio.paused)) animFrame(draw);
  else running = false;
}

function shouldRun() {
  return vizEnabled() && !motionOff() && document.body.classList.contains("on-now") && !document.hidden;
}

export function refreshViz() {
  canvas.hidden = !vizEnabled() || motionOff();
  if (!shouldRun() || running) return;
  running = true;
  resize();
  animFrame(draw);
}

export function initViz() {
  onAudioReady(attachAnalyser);
  audio.addEventListener("play", () => { refreshViz(); startEq(); });
  audio.addEventListener("playing", startEq);
  // Новый трек — свой коридор громкости (громкий прошлый трек не должен «приплющивать» тихий)
  audio.addEventListener("loadstart", () => corridors.clear());
  coverEl.addEventListener("load", () => {
    let found = null;
    try { found = coverPalette(coverEl); } catch {}
    // Обложка без цвета — серые столбики (раньше оставались цвета прошлого трека)
    coverColors = found ?? greyPalette();
    applyVizColors();   // по обложке — новые цвета; свой набор — остаётся
    // Цвета обложки нужны и фону «Сейчас играет» (nowbg.js); null — серая обложка без цветов
    document.dispatchEvent(new CustomEvent("sono:cover-colors", { detail: found }));
  });
  applyVizColors();
  readStyle();
  // Тема может задать свой вид (--viz-style): перечитываем, когда загрузился её theme.css или её выключили
  document.head.addEventListener("load", applyVizStyle, true);
  new MutationObserver(applyVizStyle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-now-style"] });
  new ResizeObserver(() => { needResize = true; }).observe(canvas);
  // Экран «Сейчас играет» открыли/закрыли
  new MutationObserver(refreshViz).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", refreshViz);
  // «Без анимаций» выключили — палочки-«эквалайзеры» снова идут за звуком
  document.addEventListener("sono:motion", () => { refreshViz(); startEq(); });
  refreshViz();
}
