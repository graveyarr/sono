// Живая полоса перемотки: вместо неподвижных полосок — спектр того, что играет прямо сейчас
// (те же частоты, что у большой визуализации). Включает её тема: в theme.css «:root { --seek-viz: live; }».
// Сыгранная часть — цветом акцента, остальное — приглушённым. Сам ползунок остаётся под холстом
// (прозрачным) — перемотка щелчком и перетаскиванием работает как раньше.

import { motionOff } from "./library.js";
import { spectrumLevels } from "./viz.js";

const audio = document.getElementById("player");
const input = document.querySelector('#view-now input[data-np="seek"]');
const canvas = document.createElement("canvas");
canvas.className = "seek-viz";
canvas.setAttribute("aria-hidden", "true");
const g = canvas.getContext("2d");

const GAP = 10;          // шаг полосок, px
let bars = [], idle = [];
let running = false, size = { W: 0, H: 0 };
let colors = { on: "#fff", off: "rgba(255,255,255,0.2)" };

// Свойство читаем у самого ползунка: вид «Сейчас играет» может задать его только для своего экрана
const wanted = () => getComputedStyle(input).getPropertyValue("--seek-viz").trim() === "live";
const visible = () => document.body.classList.contains("on-now") && !document.hidden;

/** Спокойная форма, когда звука нет (пауза): холмы, как у неподвижных полосок, а не ровная линия */
function idleShape(n) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / n;
    return 0.22 + 0.2 * Math.sin(t * 9.1 + 1.3) * Math.sin(t * 3.7 + 0.4) + 0.12 * Math.sin(t * 23 + 2);
  }).map((v) => Math.max(0.08, Math.min(0.7, v)));
}

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  // Холст лежит ровно поверх ползунка
  canvas.style.top = `${input.offsetTop}px`;
  canvas.style.height = `${input.offsetHeight}px`;
  const { width, height } = input.getBoundingClientRect();
  if (!width || !height) return;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  size = { W: width, H: height };
  const n = Math.max(24, Math.round(width / GAP));
  if (bars.length !== n) {
    idle = idleShape(n);
    bars = idle.slice();
  }
}

function readColors() {
  const css = getComputedStyle(input);   // цвета вида «Сейчас играет» действуют только на его экране
  const fg = css.getPropertyValue("--fg-rgb").trim() || "255 255 255";
  colors = { on: css.getPropertyValue("--accent").trim() || "#fff", off: `rgb(${fg} / 0.2)` };
}

let frame = 0, floor = 0.2, ceil = 0.6;
function draw(ts) {
  if (!running) return;
  if (++frame % 30 === 0) readColors();   // акцент меняется вместе с обложкой/темой
  const { W, H } = size;
  const n = bars.length;
  if (!n || !W) { requestAnimationFrame(draw); return; }
  const raw = spectrumLevels(n, ts);
  const playing = !audio.paused && raw.some((v) => v > 0.01);
  // Соседние полосы сглаживаем (волна, а не частокол); без звука — плавно к спокойной форме
  let lv = idle;
  if (playing) {
    const sm = raw.map((v, i) => (raw[i - 1] ?? v) * 0.25 + v * 0.5 + (raw[i + 1] ?? v) * 0.25);
    // Уровень — относительно «коридора» громкости песни (медленно подстраивается): иначе в громкой
    // песне все полоски стоят у потолка, а в тихой — у пола, и формы не видно
    const lo = Math.min(...sm), hi = Math.max(...sm);
    floor += (lo - floor) * 0.04;
    ceil += (hi - ceil) * (hi > ceil ? 0.2 : 0.03);
    const span = Math.max(0.12, ceil - floor);
    lv = sm.map((v) => 0.1 + 0.88 * Math.min(1, Math.max(0, (v - floor) / span)) ** 1.15);
  }
  const p = Number(input.value) / Number(input.max || 1000);
  const w = Math.max(3, GAP * 0.55), r = w / 2;
  g.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i++) {
    const up = lv[i] > bars[i];
    bars[i] += (lv[i] - bars[i]) * (playing ? (up ? 0.5 : 0.14) : 0.06);
    const h = Math.max(w, bars[i] * H);
    const x = (i + 0.5) * (W / n) - w / 2;
    g.fillStyle = (i + 0.5) / n <= p ? colors.on : colors.off;
    g.beginPath();
    g.roundRect(x, H - h, w, h, r);
    g.fill();
  }
  requestAnimationFrame(draw);
}

function refresh() {
  const on = wanted();
  document.body.classList.toggle("seek-viz-on", on);
  if (on && !canvas.isConnected) input.before(canvas);
  if (!on && canvas.isConnected) canvas.remove();
  const run = on && visible() && !motionOff();
  if (run && !running) {
    running = true;
    readColors();
    resize();
    requestAnimationFrame(draw);
  } else if (!run) {
    running = false;
    if (on) { resize(); bars = idle.slice(); drawStill(); }
  }
}

/** Один кадр без анимации («Без анимаций» или экран скрыт) */
function drawStill() {
  running = true;
  draw(performance.now());
  running = false;
}

export function initSeekViz() {
  if (!input) return;
  new ResizeObserver(() => { if (canvas.isConnected) resize(); }).observe(input);
  // Тему поменяли / открыли «Сейчас играет» — проверяем, нужна ли живая полоса
  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", refresh);
  document.addEventListener("sono:motion", refresh);
  document.head.addEventListener("load", refresh, true);   // загрузился theme.css новой темы
  input.addEventListener("input", () => { if (!running && canvas.isConnected) drawStill(); });
  audio.addEventListener("timeupdate", () => { if (!running && canvas.isConnected) drawStill(); });
  refresh();
}
