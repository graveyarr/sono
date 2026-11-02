// Вкладка Flow: большой экран бесконечного потока.
// Фон — обложка играющего трека, превращённая в медленно текущую краску (как акварель или чернила
// в воде): шейдер WebGL сдвигает каждую точку картинки по «вихревому» шуму, который всё время меняется.
// У каждого трека фон свой — из его настоящих цветов, без неона. Сверху — зерно, как у плёнки, и виньетка.
// Музыка влияет мягко: басы сильнее раскачивают краску, громкие места чуть светлее — фон дышит, а не мигает.
// Поверх — запуск, режимы, Flow по исполнителю и по плейлисту, что Flow уже выучил.

import { analyserNode } from "./audio.js";
import { FLOW_MODES, flowMode, flowPlaying, learnedSummary, resetLearning, setFlowMode, startFlow, tasteArtists } from "./flow.js";
import { icons } from "./icons.js";
import { lib } from "./library.js";
import { artistByName } from "./meta.js";
import { isPlaying, onPlayState, onTrackChange, playNext, state, togglePlay } from "./player.js";
import { coverUrl, displayTrack, el, imgUrl, plural, toast } from "./ui.js";
import { musicLevels } from "./viz.js";

const box = document.getElementById("view-flow");
const canvas = document.getElementById("flow-bg");
const coverEl = document.getElementById("cover");   // обложка на «Сейчас играет» — из неё и делаем фон
const MODE_ICONS = { liked: icons.heart, mix: icons.shuffle, discover: icons.compass };

// ---------- Экран ----------

let ui = null;   // ссылки на части экрана (строится один раз)

function build() {
  const hero = el("div", "flowv-hero");
  const title = el("h1", "flowv-title", "Flow");
  const sub = el("p", "flowv-sub");
  const play = el("button", "play big-play flowv-play");
  play.type = "button";
  play.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`;
  play.addEventListener("click", () => (flowPlaying() ? togglePlay() : startFlow({ mode: flowMode() })));
  const next = el("button", "flowv-next");
  next.type = "button";
  next.title = "Следующий трек Flow";
  next.innerHTML = icons.next;
  next.addEventListener("click", () => { if (flowPlaying()) playNext(); });
  const controls = el("div", "flowv-controls");
  controls.append(play, next);
  const now = el("div", "flowv-now");
  hero.append(el("div", "flowv-kicker", "Бесконечный поток под ваш вкус"), title, sub, controls, now);

  const modes = el("div", "flowv-modes");
  for (const m of FLOW_MODES) {
    const card = el("button", "flowv-mode");
    card.type = "button";
    card.dataset.mode = m.value;
    const icon = el("span", "flowv-mode-icon");
    icon.innerHTML = MODE_ICONS[m.value];
    card.append(icon, el("span", "flowv-mode-title", m.title), el("span", "flowv-mode-hint", m.hint));
    card.addEventListener("click", () => {
      if (m.value === flowMode()) return;
      setFlowMode(m.value);
      if (flowPlaying() && state.context?.id === "main") toast(`Flow: «${m.title}» — со следующего трека`);
      sync();
    });
    modes.append(card);
  }

  const artists = el("div", "flowv-chips");
  const playlists = el("div", "flowv-chips");
  const learn = el("p", "flowv-learn");
  const content = el("div", "flowv");
  content.append(hero, modes,
    el("h2", "flowv-h", "Flow по исполнителю"), artists,
    el("h2", "flowv-h", "Flow по плейлисту"), playlists, learn);
  box.replaceChildren(content);
  ui = { sub, play, next, now, modes, artists, playlists, learn };
}

const avatars = new Map();   // имя → { id, picture } (или null — не нашёлся)

function artistChip({ name, id }) {
  const chip = el("button", "flowv-chip");
  chip.type = "button";
  const pic = el("span", "flowv-chip-pic", name.slice(0, 1).toUpperCase());
  chip.append(pic, el("span", "flowv-chip-name", name));
  const show = (found) => {
    if (!found?.picture) return;
    const img = el("img");
    img.alt = "";
    img.src = imgUrl(found.picture);
    img.onload = () => pic.replaceChildren(img);
  };
  // Не нашёлся в базе (часто это название YouTube-канала, а не исполнитель) — карточку убираем
  const check = (found) => { if (found) show(found); else chip.remove(); };
  if (avatars.has(name)) check(avatars.get(name));
  else artistByName(name).then((found) => { avatars.set(name, found); check(found); }).catch(() => {});
  chip.addEventListener("click", async () => {
    const found = id ? { id, name } : (avatars.get(name) ?? await artistByName(name).catch(() => null));
    if (!found?.id) return toast(`Не нашёл «${name}» в базе`, { error: true });
    startFlow({ artist: { id: found.id, name: found.name || name } });
  });
  return chip;
}

function playlistChip(id, name, tracks) {
  const chip = el("button", "flowv-chip playlist");
  chip.type = "button";
  const pic = el("span", "flowv-chip-pic square");
  const first = tracks.find((t) => coverUrl(t));
  if (first) {
    const img = el("img");
    img.alt = "";
    img.src = coverUrl(first);
    pic.append(img);
  } else pic.innerHTML = icons.note;
  chip.append(pic, el("span", "flowv-chip-name", name), el("span", "flowv-chip-sub", plural(tracks.length, "трек", "трека", "треков")));
  chip.addEventListener("click", () => startFlow({ playlist: { id, name, tracks } }));
  return chip;
}

function sync() {
  if (!ui) return;
  const mode = flowMode();
  ui.sub.textContent = FLOW_MODES.find((m) => m.value === mode)?.hint ?? "";
  ui.modes.querySelectorAll(".flowv-mode").forEach((c) => c.classList.toggle("on", c.dataset.mode === mode));
  const playing = flowPlaying();
  ui.play.classList.toggle("is-playing", playing && isPlaying());
  ui.play.title = playing ? (isPlaying() ? "Пауза" : "Продолжить") : "Слушать Flow";
  ui.next.disabled = !playing;
  // Что играет во Flow сейчас
  const t = playing ? state.current : null;
  ui.now.classList.toggle("shown", !!t);
  if (t) {
    const shown = displayTrack(t);
    const img = el("img");
    img.alt = "";
    img.src = coverUrl(t);
    img.onerror = () => img.classList.add("broken");
    const text = el("div", "flowv-now-text");
    text.append(el("div", "flowv-now-title", shown.title), el("div", "flowv-now-artist", `${shown.artist} · ${state.context?.name ?? "Flow"}`));
    ui.now.replaceChildren(img, text);
  }
}

/** Списки «по исполнителю / по плейлисту» и «что выучил» — при каждом открытии экрана */
function fillLists() {
  // Названия каналов («Официальный канал группы…», «… Official Channel») — не исполнители
  const notChannel = (a) => !/официальн\w*\s+канал|\bканал\b|official\s+(youtube\s+)?channel/i.test(a.name);
  const artists = tasteArtists(14).filter(notChannel).slice(0, 10);
  ui.artists.replaceChildren(...(artists.length ? artists.map(artistChip)
    : [el("p", "flowv-empty", "Здесь появятся ваши исполнители — послушайте и полайкайте что-нибудь.")]));
  const lists = [];
  if (lib.liked.length) lists.push(playlistChip("liked", "Избранное", lib.liked));
  lib.playlists.filter((p) => p.tracks.length).forEach((p) => lists.push(playlistChip(p.id, p.name, p.tracks)));
  ui.playlists.replaceChildren(...(lists.length ? lists
    : [el("p", "flowv-empty", "Создайте плейлист — и Flow сможет играть музыку в его духе.")]));
  const { more, less } = learnedSummary();
  const reset = el("button", "flowv-link", "Начать заново");
  reset.type = "button";
  reset.addEventListener("click", () => { resetLearning(); fillLists(); toast("Flow забыл пропуски и дослушивания"); });
  ui.learn.replaceChildren(document.createTextNode(more || less
    ? `Flow учится на вас: ${plural(more, "исполнитель звучит", "исполнителя звучат", "исполнителей звучат")} чаще, ${less} — реже. `
    : "Flow учится на вас: пропущенное в первые 30 секунд звучит реже, дослушанное — чаще. "), ...(more || less ? [reset] : []));
}

export function renderFlowView() {
  if (!ui) build();
  fillLists();
  sync();
  refreshAnim();
}

// ---------- Живой фон: обложка как текущая краска ----------

const TEX = 128;   // обложка уменьшается до 128×128 и размывается — текут цветовые пятна, а не мелкие детали

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Каждая точка картинки сдвигается по «вихревому» полю: шум, искажённый шумом, искажённым шумом
// (domain warping). Поле медленно течёт во времени — краска будто растекается в воде.
const FRAGMENT = `
precision highp float;
uniform sampler2D uA, uB;            // новая и прежняя обложки (плавная смена)
uniform float uMix, uTime, uWarp, uZoom, uLight;
uniform vec2 uRes;
varying vec2 vUv;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0) * 1.6;
  float t = uTime;
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.07)), fbm(p + vec2(5.2, 1.3) - t * 0.06));
  vec2 r = vec2(fbm(p + 2.6 * q + vec2(1.7, 9.2) + t * 0.09), fbm(p + 2.6 * q + vec2(8.3, 2.8) - t * 0.08));
  vec2 cuv = 0.5 + (uv - 0.5) * uZoom + (r - 0.5) * uWarp;
  vec3 col = mix(texture2D(uB, cuv).rgb, texture2D(uA, cuv).rgb, uMix);
  // Тон: яркость обложки сжимаем в глубокий тёмный диапазон (светлая обложка — не белый экран,
  // а мягкий серо-цветной туман; тёмная — не чёрная дыра), оттенки и рисунок — сохраняем
  float L = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(L), col, 1.3);                                 // чуть насыщеннее
  col *= (0.05 + pow(L, 1.15) * 0.4) / max(L, 0.02);
  // Блик по «гребням» течения — как свет на поверхности жидкости
  float sheen = smoothstep(0.55, 0.92, fbm(p * 1.3 + 3.0 * r + t * 0.05));
  col += sheen * 0.045;
  col = clamp(col, 0.0, 1.0) * uLight;
  float vig = smoothstep(1.2, 0.2, length((uv - 0.5) * vec2(asp * 0.8, 1.0)));
  col *= mix(0.42, 1.0, vig);                                   // края темнее — текст читается
  col += (hash(gl_FragCoord.xy + fract(t * 7.0) * 317.0) - 0.5) * 0.045;   // плёночное зерно
  gl_FragColor = vec4(col, 1.0);
}`;

let gl = null, g2 = null, prog = null, uni = {};
let texA = null, texB = null, mix = 1, mixFrom = 0;
let running = false, loop = 0, last = 0, time = 0, needResize = true;
const lv = { bass: 0, mid: 0 };
let fallback = null;   // для запасного варианта без WebGL: текущая картинка-холст

/** Обложка (или заглушка) → маленький размытый квадрат, из которого шейдер и «льёт» краску */
function paint(source) {
  const c = document.createElement("canvas");
  c.width = c.height = TEX;
  const x = c.getContext("2d");
  if (source) {
    x.filter = "blur(4px) saturate(1.12)";
    x.drawImage(source, -8, -8, TEX + 16, TEX + 16);
  } else {
    // Пока ничего не играет — спокойная тёмная палитра: чернильно-синий, слива, тёплый янтарь
    x.fillStyle = "#0c1226";
    x.fillRect(0, 0, TEX, TEX);
    for (const [cx, cy, r, color] of [[30, 34, 70, "#3a1c4c"], [100, 50, 60, "#1b4b57"], [70, 104, 66, "#8a4a2a"], [18, 110, 40, "#16223f"]]) {
      const grad = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "rgba(12, 18, 38, 0)");
      x.fillStyle = grad;
      x.fillRect(0, 0, TEX, TEX);
    }
  }
  return c;
}

function makeTexture(img) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Зеркальный повтор: если течение вынесло точку за край обложки — без шва
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  return tex;
}

/** Новая картинка для фона: прежняя остаётся вторым слоем и плавно растворяется */
function setPicture(source) {
  const img = paint(source);
  if (!gl) { fallback = { img, prev: fallback?.img ?? img }; mix = 0; mixFrom = performance.now(); return; }
  if (texB && texB !== texA) gl.deleteTexture(texB);
  texB = texA ?? makeTexture(img);
  texA = makeTexture(img);
  mix = 0;
  mixFrom = performance.now();
}

function initGL() {
  gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) { g2 = canvas.getContext("2d"); return; }
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.log("[flow] шейдер не собрался, рисую попроще:", err.message);
    gl = null;
    g2 = null;   // 2D на этом холсте уже не получить — запасной вариант нарисует пустоту, фон даст CSS
    return;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  for (const name of ["uA", "uB", "uMix", "uTime", "uWarp", "uZoom", "uLight", "uRes"]) uni[name] = gl.getUniformLocation(prog, name);
  gl.uniform1i(uni.uA, 0);
  gl.uniform1i(uni.uB, 1);
}

function resize() {
  const { width, height } = canvas.getBoundingClientRect();
  // Половинное разрешение: картинка и так мягкая, а работы видеокарте вчетверо меньше
  const scale = gl ? 0.5 : 0.35;
  canvas.width = Math.max(2, Math.round(width * scale));
  canvas.height = Math.max(2, Math.round(height * scale));
  if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
}

function drawGL(warp, zoom, light) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texA);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texB);
  gl.uniform1f(uni.uMix, mix);
  gl.uniform1f(uni.uTime, time);
  gl.uniform1f(uni.uWarp, warp);
  gl.uniform1f(uni.uZoom, zoom);
  gl.uniform1f(uni.uLight, light);
  gl.uniform2f(uni.uRes, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/** Без WebGL: та же размытая обложка, растянутая во весь экран, медленно плывёт и дышит */
function draw2D(zoom, light) {
  if (!g2 || !fallback) return;
  const W = canvas.width, H = canvas.height, s = Math.max(W, H) * (1.5 / zoom);
  g2.save();
  g2.translate(W / 2 + Math.sin(time * 0.11) * W * 0.06, H / 2 + Math.cos(time * 0.09) * H * 0.06);
  g2.rotate(Math.sin(time * 0.05) * 0.2);
  g2.globalAlpha = 1;
  g2.drawImage(fallback.prev, -s / 2, -s / 2, s, s);
  g2.globalAlpha = mix;
  g2.drawImage(fallback.img, -s / 2, -s / 2, s, s);
  g2.restore();
  g2.fillStyle = `rgba(0, 0, 0, ${0.45 - (light - 0.8) * 0.8})`;
  g2.fillRect(0, 0, W, H);
}

function frame(ts, id) {
  if (!running || id !== loop) return;   // ушли с экрана или уже идёт новый цикл
  if (needResize) { needResize = false; resize(); }
  const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
  last = ts;
  // Музыка — мягко: уровни сильно сглажены, чтобы фон дышал, а не дёргался
  const m = analyserNode() ? musicLevels(ts) : { bass: 0, mid: 0 };
  lv.bass += (m.bass - lv.bass) * (m.bass > lv.bass ? 0.18 : 0.04);
  lv.mid += (m.mid - lv.mid) * 0.05;
  time += dt * (1.25 + lv.bass * 1.1 + lv.mid * 0.4);   // громче — течёт чуть быстрее
  mix = Math.min(1, (ts - mixFrom) / 1800);           // смена обложки — 1,8 с
  const warp = 0.2 + lv.bass * 0.12;                  // басы сильнее раскачивают краску
  const zoom = 0.6 - lv.bass * 0.035;                 // и чуть «наплывают» на зрителя
  const light = 0.82 + lv.mid * 0.16;                 // громкие места чуть светлее
  if (gl) drawGL(warp, zoom, light);
  else draw2D(zoom, light);
  requestAnimationFrame((t) => frame(t, id));
}

function refreshAnim() {
  const want = document.body.classList.contains("on-flow") && !document.hidden;
  if (want && !running) {
    running = true;
    last = 0;
    needResize = true;
    const id = ++loop;
    requestAnimationFrame((t) => frame(t, id));
  } else if (!want) {
    running = false;
  }
}

function useCurrentCover() {
  const ready = state.current && coverEl.complete && coverEl.naturalWidth > 0;
  setPicture(ready ? coverEl : null);
}

export function initFlowView() {
  initGL();
  useCurrentCover();
  coverEl.addEventListener("load", useCurrentCover);   // сменилась обложка — новая краска
  new ResizeObserver(() => { needResize = true; }).observe(canvas);
  new MutationObserver(refreshAnim).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", refreshAnim);
  onTrackChange(() => { if (document.body.classList.contains("on-flow")) sync(); });
  onPlayState(() => { if (document.body.classList.contains("on-flow")) sync(); });
}

