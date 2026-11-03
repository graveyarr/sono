// Фон экрана «Сейчас играет» (Настройки → Оформление → «Фон»). Плавающие пятна убраны — вместо них:
//   light  — «Свет» (по умолчанию): из-за обложки «растекаются» её же цвета — каждый край своим, как фоновая
//            подсветка у телевизора; при клипе — цвета текущего кадра (холст в .np-glow, CSS сильно размывает);
//   calm   — «Тихий»: размытая обложка медленно дышит, сверху плёночное зерно (только CSS);
//   mesh   — «Градиент»: весь фон — одно мягкое поле цветов обложки, цвета медленно перетекают (WebGL).
// Был ещё вариант «Линии» (горизонтали, как на карте) — автору не понравился, убран; сохранённый выбор → «Свет».
// Холст («Градиент») рисуется в половину разрешения и не чаще 30 раз в секунду, только пока открыт «Сейчас играет».

import { getSetting, motionOff, setSetting } from "./library.js";
import { musicLevels } from "./viz.js";

export const NOW_BACKGROUNDS = [
  { id: "light", title: "Свет", hint: "Из-за обложки мягко растекаются её цвета (у клипа — цвета кадра)" },
  { id: "calm", title: "Тихий", hint: "Размытая обложка, почти без движения" },
  { id: "mesh", title: "Градиент", hint: "Цвета обложки медленно перетекают" },
];

export const nowBackground = () => {
  const id = getSetting("nowBg", "light");
  return NOW_BACKGROUNDS.some((b) => b.id === id) ? id : "light";
};

const canvas = document.getElementById("now-bg");
const audio = document.getElementById("player");
const glow = document.querySelector(".np-glow");
const coverImg = document.getElementById("cover");
const clipVideo = document.getElementById("clip");
const coverWrap = coverImg.closest(".cover-wrap");
// Крошечный холст: обложка по центру с прозрачными полями — после размытия свет мягко гаснет к краям
const glowCanvas = document.createElement("canvas");
glow.append(glowCanvas);
const glowCtx = glowCanvas.getContext("2d");
let glowTimer = 0;
let gl = null, prog = null, uni = {};
let colors = [[0.42, 0.24, 1], [1, 0.31, 0.64], [0.18, 0.66, 1], [1, 0.6, 0.24]];   // пока нет обложки
let target = colors.map((c) => c.slice());
let running = false, lastFrame = 0, shownPulse = -1;
let pulse = 0, flow = 0;

export function setNowBackground(id) {
  setSetting("nowBg", id);
  apply();
}

function apply() {
  const mode = nowBackground();
  for (const b of NOW_BACKGROUNDS) document.body.classList.toggle(`nowbg-${b.id}`, b.id === mode);
  refresh();
  refreshGlow();
}

// ---------- Цвета обложки ----------

function hslToRgb([h, s, l]) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function onCoverColors(found) {
  // Серая обложка — серо-синие приглушённые тона, без случайной радуги
  const hsl = found?.length ? found : [[220, 10, 40], [220, 8, 28], [220, 12, 52]];
  const list = [...hsl];
  while (list.length < 4) list.push([(list[list.length - 1][0] + 30) % 360, list[0][1], list[0][2] - 6]);
  target = list.slice(0, 4).map(hslToRgb);
  if (motionOff()) { running = false; lastFrame = 0; refresh(true); }   // перерисовать неподвижный фон под новую обложку
}

// ---------- «Свет»: подсветка цветами обложки / кадра клипа ----------

/** Нарисовать источник (обложку или кадр видео) в маленький холст с полями. Видео — 16:9, обложка — квадрат */
function drawGlow(source, wide) {
  const w = wide ? 64 : 40, h = wide ? 36 : 40, pad = wide ? 7 : 6;   // поля ≈ inset −22% у .np-glow
  if (glowCanvas.width !== w || glowCanvas.height !== h) { glowCanvas.width = w; glowCanvas.height = h; }
  try {
    glowCtx.clearRect(0, 0, w, h);
    glowCtx.drawImage(source, pad, pad * (wide ? 0.55 : 1), w - pad * 2, h - pad * (wide ? 1.1 : 2));
  } catch {}   // картинка ещё не загрузилась — нарисуем при следующем случае
}

function refreshGlow() {
  clearInterval(glowTimer);
  if (nowBackground() !== "light" || !document.body.classList.contains("on-now") || document.hidden) return;
  if (coverWrap.classList.contains("clip-on") && !motionOff()) {
    // Клип: обновляем подсветку 5 раз в секунду (плавность даёт CSS-размытие) — только пока он идёт
    const tick = () => { if (!clipVideo.paused && clipVideo.readyState >= 2) drawGlow(clipVideo, true); };
    drawGlow(clipVideo, true);
    glowTimer = setInterval(tick, 200);
  } else if (coverWrap.classList.contains("clip-on")) {
    drawGlow(clipVideo, true);   // «Без анимаций»: подсветка по одному кадру клипа, без обновлений
  } else if (coverImg.complete && coverImg.naturalWidth) {
    drawGlow(coverImg, false);
  }
}

// ---------- WebGL ----------

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision mediump float;
uniform vec2 uRes; uniform float uTime, uPulse;
uniform vec3 uC0, uC1, uC2, uC3;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
vec3 palette(float t) {
  t = fract(t) * 4.0;
  if (t < 1.0) return mix(uC0, uC1, smoothstep(0.0, 1.0, t));
  if (t < 2.0) return mix(uC1, uC2, smoothstep(1.0, 2.0, t));
  if (t < 3.0) return mix(uC2, uC3, smoothstep(2.0, 3.0, t));
  return mix(uC3, uC0, smoothstep(3.0, 4.0, t));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime;
  // Очень низкочастотное поле, цвета обложки перетекают. Никаких отдельных кругов —
  // одно непрерывное поле с большими плавными переходами
  vec2 q = p * 0.9 + vec2(fbm(p * 0.8 + t * 0.03), fbm(p * 0.8 - t * 0.025 + 5.0)) * 0.9;
  float n = fbm(q * 0.9 + t * 0.02);
  vec3 col = palette(n * 1.4 + t * 0.012);
  col *= 0.42 + 0.12 * uPulse;
  // Виньетка и чуть «воздуха» — чтобы фон не спорил с обложкой и текстом
  col *= 1.0 - 0.55 * dot(uv - 0.5, uv - 0.5) * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

function initGl() {
  if (gl !== null) return !!gl;
  gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false }) || false;
  if (!gl) return false;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, "#extension GL_OES_standard_derivatives : enable\n" + FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
  } catch (e) {
    console.warn("[nowbg] WebGL не завёлся — фон «Градиент» недоступен", e);
    gl = false;
    return false;
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  for (const name of ["uRes", "uTime", "uPulse", "uC0", "uC1", "uC2", "uC3"]) uni[name] = gl.getUniformLocation(prog, name);
  return true;
}

function resize() {
  const scale = 0.5;   // половина разрешения: фон мягкий, а видеокарте вчетверо меньше работы
  const w = Math.max(1, Math.round(canvas.clientWidth * scale)), h = Math.max(1, Math.round(canvas.clientHeight * scale));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// ---------- Кадр ----------

// У каждого запуска рисования свой номер: новый запуск останавливает старый цикл.
// Без этого каждый перезапуск добавлял ещё один цикл, и работы становилось всё больше
let loop = 0;
function start() {
  const id = ++loop;
  running = true;
  lastFrame = 0;
  requestAnimationFrame((t) => frame(t, id));
}

function frame(ts, id) {
  if (!running || id !== loop) return;
  // «Без анимаций»: свет не «дышит» под басы; для «Градиента» ниже рисуется один кадр
  if (motionOff() && nowBackground() !== "mesh") { running = false; glow.style.setProperty("--pulse", "0"); return; }
  requestAnimationFrame((t) => frame(t, id));
  // Басы — мягко (сильно сглажено), чтобы не мигало
  const { bass = 0 } = musicLevels(ts) || {};
  const playing = !audio.paused;
  pulse += ((playing ? bass : 0) - pulse) * 0.06;
  // Только у свечения и только при заметной разнице: переменная на всём документе заставляла бы
  // браузер пересчитывать стили всей страницы каждый кадр
  if (Math.abs(pulse - shownPulse) > 0.004) {
    shownPulse = pulse;
    glow.style.setProperty("--pulse", pulse.toFixed(3));
  }

  const mode = nowBackground();
  if (mode !== "mesh") return;
  if (ts - lastFrame < 33) return;   // ~30 кадров в секунду хватает
  const dt = Math.min(0.1, (ts - lastFrame) / 1000);
  lastFrame = ts;
  flow += dt * (playing ? 1 : 0.35);   // на паузе течёт медленнее
  // смена обложки — плавно; «Без анимаций» — сразу
  colors = motionOff() ? target.map((c) => c.slice()) : colors.map((c, i) => c.map((v, k) => v + (target[i][k] - v) * 0.03));
  if (!initGl()) return;
  resize();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(uni.uRes, canvas.width, canvas.height);
  gl.uniform1f(uni.uTime, flow);
  gl.uniform1f(uni.uPulse, pulse);
  colors.forEach((c, i) => gl.uniform3f(uni[`uC${i}`], ...c));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (motionOff()) running = false;   // «Без анимаций»: один кадр — и стоп (новый — при смене обложки)
}

let wasOnNow = null;
function refresh(force = false) {
  const should = document.body.classList.contains("on-now") && !document.hidden;
  if (should !== wasOnNow) { wasOnNow = should; refreshGlow(); }   // класс body меняется часто — только на смену экрана
  if (motionOff() && running && !force) return;
  if (should && (!running || force)) {
    start();
  } else if (!should) {
    running = false;
  }
}

export function initNowBackground() {
  document.addEventListener("sono:cover-colors", (e) => onCoverColors(e.detail));
  coverImg.addEventListener("load", refreshGlow);   // сменилась обложка
  // Включили/выключили «Без анимаций» — перезапустить (или остановить) рисование
  document.addEventListener("sono:motion", () => { running = false; lastFrame = 0; refresh(true); refreshGlow(); });
  new MutationObserver(() => refreshGlow()).observe(coverWrap, { attributes: true, attributeFilter: ["class"] });   // клип появился/пропал
  clipVideo.addEventListener("loadeddata", refreshGlow);
  new MutationObserver(() => refresh()).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", () => refresh());
  apply();
}
