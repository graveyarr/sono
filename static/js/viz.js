// Визуализация на «Сейчас играет»: мягкие закруглённые столбики за плеером.
// Высота — настоящий спектр звука (Web Audio, AnalyserNode): басы слева, верха справа.
// Цвета — палитра обложки (несколько её цветов, переливом слева направо), к низу растворяются.
// Те же цвета обложки получает фон «Сейчас играет» (событие sono:cover-colors → nowbg.js).
// Выключается в настройках (settings.visualizer).

import { analyserNode, audioContext, onAudioReady } from "./audio.js";
import { getSetting, motionOff } from "./library.js";

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
function coverPalette(img) {
  const size = 32;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0, size, size);
  const px = x.getImageData(0, 0, size, size).data;
  const bins = new Float32Array(36);   // по 10°
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, gg, b), min = Math.min(r, gg, b), l = (max + min) / 2, d = max - min;
    if (d < 0.12 || l < 0.12 || l > 0.92) continue;   // серое, чёрное, белое — не цвет
    let h = max === r ? (gg - b) / d + (gg < b ? 6 : 0) : max === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
    bins[Math.floor(h * 6) % 36] += d;
  }
  const picks = [];
  const order = [...bins.keys()].sort((a, b) => bins[b] - bins[a]);
  for (const i of order) {
    if (bins[i] <= 0 || picks.length >= 4) break;
    if (picks.every((p) => Math.min(Math.abs(p - i), 36 - Math.abs(p - i)) >= 4)) picks.push(i);
  }
  if (!picks.length) return null;
  let hues = picks.map((i) => i * 10 + 5).sort((a, b) => a - b);
  // Один-два цвета — дополняем соседними оттенками, чтобы был перелив
  if (hues.length === 1) hues = [hues[0] - 35, hues[0], hues[0] + 35];
  if (hues.length === 2) hues = [hues[0], (hues[0] + hues[1]) / 2, hues[1]];
  return hues.map((h, i) => [((h % 360) + 360) % 360, 82, 50 + (i % 2) * 6]);
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
  requestAnimationFrame(eqTick);
}

function startEq() {
  if (eqRunning || !analyser || audio.paused || motionOff()) return;   // «Без анимаций» — палочки стоят
  eqRunning = true;
  requestAnimationFrame(eqTick);
}

/** Уровни полос: частоты по логарифмической шкале, как слышит ухо */
function levels(ts) {
  const n = bars.length, out = new Array(n).fill(0);
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
  return out;
}

let size = { W: 0, H: 0 };

let needResize = false;

function draw(ts) {
  // Размер меняем здесь, в начале кадра: изменение размера стирает холст, и если делать это
  // в ResizeObserver (он срабатывает уже после отрисовки), то пока панель анимируется
  // (прячут медиатеку), каждый кадр оставался пустым — визуализация «пропадала»
  if (needResize) { needResize = false; resize(); }
  const { W, H } = size;
  g.clearRect(0, 0, W, H);
  const raw = levels(ts);
  const n = bars.length;
  // Соседние полосы немного сглаживаем — получается плавная «волна», а не частокол
  const lv = raw.map((v, i) => (raw[i - 1] ?? v) * 0.22 + v * 0.56 + (raw[i + 1] ?? v) * 0.22);
  const colW = W / n, w = Math.max(4, colW * 0.56), r = w / 2;
  const base = H - 6, maxH = H * 0.9;
  let alive = false;

  for (let i = 0; i < n; i++) {
    // Растут быстро, опадают плавно и с замедлением
    bars[i] = lv[i] > bars[i] ? bars[i] + (lv[i] - bars[i]) * 0.55 : Math.max(lv[i], bars[i] - Math.max(0.008, (bars[i] - lv[i]) * 0.12));
    if (bars[i] > 0.004) alive = true;
    const h = bars[i] * maxH;
    if (h < 1) continue;

    const [hue, s, l] = colorAt(i / Math.max(1, n - 1));
    const x = i * colW + (colW - w) / 2, top = base - Math.max(h, w);
    // Капсула: к верху — насыщенный цвет обложки, к низу растворяется
    const grad = g.createLinearGradient(0, top, 0, base);
    grad.addColorStop(0, `hsl(${hue} ${s}% ${l + 8}%)`);
    grad.addColorStop(0.55, `hsl(${hue} ${s}% ${l}% / 0.75)`);
    grad.addColorStop(1, `hsl(${hue} ${s}% ${l - 10}% / 0.08)`);
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(x, top, w, base - top, [r, r, r * 0.4, r * 0.4]);
    g.fill();
  }

  // Ушли с «Сейчас играет» (или выключили визуализацию) — не рисуем скрытый холст; вернутся — refreshViz запустит снова
  if (running && shouldRun() && (alive || !audio.paused)) requestAnimationFrame(draw);
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
  requestAnimationFrame(draw);
}

export function initViz() {
  onAudioReady(attachAnalyser);
  audio.addEventListener("play", () => { refreshViz(); startEq(); });
  audio.addEventListener("playing", startEq);
  coverEl.addEventListener("load", () => {
    let found = null;
    try { found = coverPalette(coverEl); } catch {}
    if (found) coverColors = found;
    applyVizColors();   // по обложке — новые цвета; свой набор — остаётся
    // Цвета обложки нужны и фону «Сейчас играет» (nowbg.js); null — серая обложка без цветов
    document.dispatchEvent(new CustomEvent("sono:cover-colors", { detail: found }));
  });
  applyVizColors();
  new ResizeObserver(() => { needResize = true; }).observe(canvas);
  // Экран «Сейчас играет» открыли/закрыли
  new MutationObserver(refreshViz).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", refreshViz);
  // «Без анимаций» выключили — палочки-«эквалайзеры» снова идут за звуком
  document.addEventListener("sono:motion", () => { refreshViz(); startEq(); });
  refreshViz();
}
