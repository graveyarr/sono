// Звуковая цепочка Sono (Web Audio). Звук плеера (<audio id="player">) идёт так:
//   источник → басы (полка 110 Гц) → «сухой» звук + реверб → выравнивание громкости → плавность → анализатор → колонки
// - басы, реверб, скорость — «Звуковые эффекты» (кнопка у плеера, settings.fx);
// - выравнивание громкости — мягкий компрессор: тихие треки ближе к громким (settings.normalize);
// - наложение треков — конец трека звучит вместе с началом следующего (settings.fadeSec, секунды);
//   конец доигрывает второй плеер-«хвост», он идёт через те же эффекты. Следующего нет — просто затухание;
// - анализатор читают визуализация и маленькие «эквалайзеры» (viz.js).
// Создать цепочку можно только после действия человека (щелчок, клавиша) — иначе браузер «заморозит» звук.

import { getSetting, setSetting } from "./library.js";

const audio = document.getElementById("player");
// Второй плеер — «хвост»: при наложении доигрывает конец прошлого трека, пока основной уже играет следующий
const tail = new Audio();
tail.preload = "auto";

// Эквалайзер — 6 полос, как в Spotify: [частота, тип фильтра, подпись]
export const EQ_BANDS = [[60, "lowshelf", "60"], [150, "peaking", "150"], [400, "peaking", "400"],
  [1000, "peaking", "1к"], [2400, "peaking", "2.4к"], [15000, "highshelf", "15к"]];
const FLAT = [0, 0, 0, 0, 0, 0];
export const EQ_PRESETS = [
  { name: "Ровно", eq: FLAT },
  { name: "Басы", eq: [8, 6, 2, 0, 0, 0] },
  { name: "Басы и верха", eq: [6, 4, 0, -1, 2, 5] },
  { name: "Вокал", eq: [-2, -1, 2, 4, 3, 1] },
  { name: "Электроника", eq: [6, 4, 0, -1, 2, 4] },
  { name: "Рок", eq: [4, 2, -2, 1, 3, 4] },
  { name: "Хип-хоп", eq: [7, 5, 1, 0, 1, 2] },
  { name: "Тише верха", eq: [0, 0, 0, -1, -3, -6] },
];

export const FX_DEFAULT = { speed: 1, pitch: true, reverb: 0, bass: 0, eq: FLAT };
// pitch: true — тон меняется вместе со скоростью (как в slowed / nightcore), false — только темп.
// Наборы эффектов не трогают эквалайзер (у него свои наборы)
export const FX_PRESETS = [
  { name: "Обычный", fx: { speed: 1, pitch: true, reverb: 0, bass: 0 } },
  { name: "Slowed + reverb", fx: { speed: 0.85, pitch: true, reverb: 0.4, bass: 3 } },
  { name: "Nightcore", fx: { speed: 1.25, pitch: true, reverb: 0, bass: 0 } },
  { name: "Больше баса", fx: { speed: 1, pitch: true, reverb: 0, bass: 9 } },
  { name: "Концертный зал", fx: { speed: 1, pitch: true, reverb: 0.55, bass: 2 } },
];

let ctx = null;
const n = {};   // узлы цепочки

// Выравнивание громкости: мягкое сжатие и поправка на «автоподъём» компрессора (подобрано замером)
const COMP = { threshold: -20, knee: 18, ratio: 2.2, attack: 0.025, release: 0.3 };
const COMP_LEVEL_DB = -3;   // замер: громкий трек с выравниванием ≈ без него (−1 дБ), пики ниже
const readyListeners = new Set();
const fxListeners = new Set();

/** fn() — цепочка создана (визуализация ждёт анализатор) */
export const onAudioReady = (fn) => { readyListeners.add(fn); if (ctx) fn(); };
/** fn() — эффекты поменялись (кнопка «Эффекты» подсвечивается) */
export const onFxChange = (fn) => fxListeners.add(fn);
export const audioContext = () => ctx;
export const analyserNode = () => n.analyser ?? null;

export const getFx = () => {
  const fx = { ...FX_DEFAULT, ...getSetting("fx", {}) };
  if (!Array.isArray(fx.eq) || fx.eq.length !== EQ_BANDS.length) fx.eq = FLAT;
  return fx;
};
export const fxActive = () => {
  const fx = getFx();
  return fx.speed !== 1 || fx.reverb > 0 || fx.bass > 0 || fx.eq.some((g) => g !== 0);
};
export const normalizeEnabled = () => getSetting("normalize", false) === true;
export const fadeSeconds = () => Number(getSetting("fadeSec", 0)) || 0;

// ---------- Цепочка ----------

/** Отклик «зала» для реверба: шум, который затухает за ~2,6 с (у каждого канала свой — звучит объёмно) */
function impulse(seconds = 2.6, decay = 2.6) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return buf;
}

export function ensureAudioGraph() {
  if (ctx) return;
  try {
    // latencyHint "playback" — бо́льший буфер: для музыки задержка не важна, а с маленьким буфером
    // на слабых компьютерах звук трещал («странный, плохое качество» — отзыв друга)
    ctx = new AudioContext({ latencyHint: "playback" });
    n.source = ctx.createMediaElementSource(audio);
    // Наложение треков: у основного плеера и у «хвоста» (доигрывает конец прошлого трека) — свои
    // регуляторы громкости, дальше оба идут в общий вход n.input → эффекты → … (звучат одинаково)
    n.main = ctx.createGain();
    n.tailSource = ctx.createMediaElementSource(tail);
    n.tailGain = ctx.createGain();
    n.tailGain.gain.value = 0;
    n.input = ctx.createGain();
    n.source.connect(n.main).connect(n.input);
    n.tailSource.connect(n.tailGain).connect(n.input);
    // Запас перед усилением: если эквалайзер или басы поднимают уровень, звук упирался в потолок и хрипел
    n.pre = ctx.createGain();
    n.eq = EQ_BANDS.map(([freq, type]) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = 1.1;
      return f;
    });
    n.bass = Object.assign(ctx.createBiquadFilter(), { type: "lowshelf" });
    n.bass.frequency.value = 110;
    n.dry = ctx.createGain();
    n.reverb = ctx.createConvolver();
    n.reverb.buffer = impulse();
    n.wet = ctx.createGain();
    n.mix = ctx.createGain();
    // Выравнивание громкости — мягкий компрессор: медленная атака (ударные проходят как есть),
    // небольшое сжатие. Компрессор браузера САМ поднимает громкость («автоподъём», ~+6 дБ при этих
    // настройках) — снимаем его обратно (n.level), иначе получалось пережатое громкое месиво, где
    // «голос выпирает, звук резкий» (отзыв друга). Жёстких ограничителей больше нет совсем.
    n.comp = ctx.createDynamicsCompressor();
    Object.entries(COMP).forEach(([k, v]) => { n.comp[k].value = v; });
    n.level = ctx.createGain();
    n.level.gain.value = 10 ** (COMP_LEVEL_DB / 20);
    n.fade = ctx.createGain();
    n.analyser = ctx.createAnalyser();
    Object.assign(n.analyser, { fftSize: 4096, smoothingTimeConstant: 0.72, minDecibels: -88, maxDecibels: -22 });

    // Полная цепочка: источник → запас → 6 полос эквалайзера → басы → сухой звук (+ реверб) → mix.
    // Когда эффекты выключены, источник идёт сразу в mix — без единого фильтра (routeFx)
    n.eq.reduce((prev, f) => prev.connect(f), n.pre).connect(n.bass);
    n.bass.connect(n.dry).connect(n.mix);
    n.reverb.connect(n.wet).connect(n.mix);
    n.reverbOn = false;   // вход реверба подключает applyFx — только когда он нужен
    n.comp.connect(n.level).connect(n.fade);
    n.sleep = ctx.createGain();   // таймер сна: затихание перед паузой (после анализатора — картинка не гаснет)
    n.fade.connect(n.analyser).connect(n.sleep).connect(ctx.destination);
    n.direct = null;
    routeNormalize();
    applyFx();
    readyListeners.forEach((fn) => fn());
  } catch (err) {
    console.log("[audio] звуковая цепочка недоступна:", err.message);
    ctx = null;
  }
}

/** Таймер сна: плавно довести громкость до level (0…1) за seconds секунд. Без звуковой цепочки — false */
export function sleepFade(level, seconds = 0) {
  if (!ctx || !n.sleep) return false;
  const g = n.sleep.gain, now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  if (seconds > 0) g.linearRampToValueAtTime(level, now + seconds);
  else g.setValueAtTime(level, now);
  return true;
}

export function resumeAudio() {
  if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
}

/** Эффекты выключены — звук идёт напрямую, мимо фильтров; включены — через полную цепочку */
function routeFx(direct) {
  if (direct === n.direct) return;
  n.input.disconnect();
  n.input.connect(direct ? n.mix : n.pre);
  n.direct = direct;
}

/** Запас под усиление эквалайзера и басов. Громкость в <audio> стоит ДО цепочки, поэтому на обычной
    громкости места хватает с избытком — убавляем, только если усиление выше этого запаса
    (иначе звук упирался бы в потолок и хрипел). Раньше тут был жёсткий ограничитель — он и давал резкость */
function updateHeadroom() {
  if (!ctx) return;
  const fx = getFx();
  const boost = Math.max(0, ...fx.eq) + fx.bass;                      // худший случай: полосы складываются
  const room = -20 * Math.log10(Math.max(audio.volume, 0.001)) - 1;   // сколько дБ до потолка (с запасом 1 дБ)
  n.pre.gain.setTargetAtTime(10 ** (-Math.max(0, boost - room) / 20), ctx.currentTime, 0.05);
}

function routeNormalize() {
  if (!ctx) return;
  n.mix.disconnect();
  n.mix.connect(normalizeEnabled() ? n.comp : n.fade);
}

// ---------- Эффекты ----------

function applyFx() {
  const fx = getFx();
  // Скорость работает и без цепочки: это свойство самого <audio>. При смене трека браузер
  // сбрасывает playbackRate к defaultPlaybackRate — поэтому ставим оба
  audio.preservesPitch = !fx.pitch;
  audio.defaultPlaybackRate = fx.speed;
  audio.playbackRate = fx.speed;
  tail.preservesPitch = audio.preservesPitch;
  tail.defaultPlaybackRate = tail.playbackRate = fx.speed;
  if (ctx) {
    const t = ctx.currentTime;
    n.bass.gain.setTargetAtTime(fx.bass, t, 0.05);
    fx.eq.forEach((g, i) => n.eq[i].gain.setTargetAtTime(g, t, 0.05));
    updateHeadroom();
    routeFx(fx.eq.every((g) => g === 0) && fx.bass === 0 && fx.reverb === 0);
    n.wet.gain.setTargetAtTime(fx.reverb * 0.85, t, 0.05);
    n.dry.gain.setTargetAtTime(1 - fx.reverb * 0.35, t, 0.05);   // с реверберацией «сухой» звук чуть тише — не громче в сумме
    // Реверберация — тяжёлый расчёт (свёртка с откликом 2,6 с). Выключена — отключаем её совсем,
    // а не просто глушим: раньше она считалась всегда и на слабых компьютерах звук трещал
    const reverbOn = fx.reverb > 0;
    if (reverbOn !== n.reverbOn) {
      if (reverbOn) n.bass.connect(n.reverb);
      else n.bass.disconnect(n.reverb);
      n.reverbOn = reverbOn;
    }
  }
  fxListeners.forEach((fn) => fn());
}

export function setFx(change) {
  setSetting("fx", { ...getFx(), ...change });
  applyFx();
}

export function setNormalize(on) {
  setSetting("normalize", on);
  routeNormalize();
}

export function setFadeSeconds(sec) {
  setSetting("fadeSec", sec);
  updateFade();
}

// ---------- Наложение треков и плавность ----------
// За N секунд до конца (settings.fadeSec) конец трека «переезжает» во второй плеер-хвост: он заранее
// загружает то же место, встаёт вровень с основным и подхватывает звук. Основной плеер сразу включает
// следующий трек (интерфейс, очередь, текст — всё уже про него), и оба звучат вместе: прошлый стихает,
// новый нарастает. Следующего трека нет, повтор одного трека или хвост не успел — как раньше:
// затухание в конце и нарастание в начале следующего.

const PREP_SEC = 4;      // за сколько секунд до наложения хвост начинает загружать конец трека
let autoNext = false;    // следующий трек включился сам после конца — нарастание без наложения
let crossHandler = null; // {canStart(), start()} — даёт player.js (очередь знает только он)
const xf = { phase: "idle", src: "", token: 0, len: 0, ramped: false, expectEmptied: false, timer: 0 };
// phase: idle → prep (хвост грузится) → sync (встаёт вровень) → fading (звучат оба)

/** player.js: canStart() — есть ли следующий трек для наложения, start() — включить его */
export const setCrossfadeHandler = (handler) => { crossHandler = handler; };
/** Для проверки из консоли: что сейчас с наложением */
export const crossfadeInfo = () => ({ phase: xf.phase, tailTime: tail.currentTime, mainTime: audio.currentTime,
  tailGain: n.tailGain?.gain.value, mainGain: n.main?.gain.value });

function trackLength() {
  // Пока трек SoundCloud докачивается, браузер врёт про длительность (например, 0:10) — тогда берём
  // длительность из данных трека. Иначе точнее сам файл: в данных бывает округлено на секунду-две
  const known = Number(audio.dataset.trackDuration), real = audio.duration;
  if (Number.isFinite(real) && real > 0 && (!(known > 0) || Math.abs(real - known) < 10)) return real;
  return known > 0 ? known : real;
}

/** Сколько осталось до конца в настоящих секундах (с учётом скорости) */
const secondsLeft = () => (trackLength() - audio.currentTime) / (audio.playbackRate || 1);

function canCross(sec) {
  return sec > 0 && !!ctx && !!crossHandler && xf.src !== audio.currentSrc && !audio.paused
    && trackLength() > sec * 3 && crossHandler.canStart();
}

/** Остановить хвост. soft — коротко притушить (человек сам переключил трек посреди наложения) */
function stopTail(soft = false) {
  clearTimeout(xf.timer);
  xf.token++;
  const wasFading = xf.phase === "fading";
  xf.phase = "idle";
  if (ctx) {
    const t = ctx.currentTime;
    n.tailGain.gain.cancelScheduledValues(t);
    if (soft && wasFading) n.tailGain.gain.setTargetAtTime(0, t, 0.06);
    else n.tailGain.gain.setValueAtTime(0, t);
    if (wasFading) {   // новый трек — на полную, даже если нарастание не успело
      n.main.gain.cancelScheduledValues(t);
      n.main.gain.setTargetAtTime(1, t, 0.08);
    }
  }
  const release = () => { tail.pause(); tail.removeAttribute("src"); tail.load(); };
  if (soft && wasFading) xf.timer = setTimeout(release, 300);
  else release();
}

function prepTail() {
  xf.phase = "prep";
  xf.src = audio.currentSrc;   // этот трек уже пробовали — второй раз не начинаем (и после неудачи)
  xf.token++;
  const speed = audio.playbackRate || 1;
  tail.src = audio.currentSrc;
  tail.preservesPitch = audio.preservesPitch;
  tail.defaultPlaybackRate = tail.playbackRate = speed;
  tail.volume = audio.volume;
  tail.muted = audio.muted;
  // Грузим чуть раньше места, где начнётся наложение, — к тому времени оно уже будет в буфере
  const sec = fadeSeconds();
  tail.currentTime = Math.max(audio.currentTime, trackLength() - sec * speed - 1.5);
}

function syncTail() {
  xf.phase = "sync";
  const token = xf.token;
  const fail = () => { if (token === xf.token) { stopTail(); updateFade(); } };   // дальше — обычное затухание
  const guard = setTimeout(fail, 2500);   // хвост не успел — не мешаем
  const ready = () => {
    if (token !== xf.token) return;
    const drift = audio.currentTime - tail.currentTime;
    // Хвост заиграл совсем не с того места (докачивающийся SoundCloud не перематывается) — без наложения
    if (Math.abs(drift) > 1.5) { clearTimeout(guard); return fail(); }
    if (Math.abs(drift) > 0.06 && !xf.corrected) {   // поправка внутри буфера — почти мгновенная
      xf.corrected = true;
      tail.currentTime = audio.currentTime + 0.02;
      tail.addEventListener("seeked", ready, { once: true });
      return;
    }
    clearTimeout(guard);
    handover();
  };
  xf.corrected = false;
  tail.currentTime = audio.currentTime + 0.05;
  tail.addEventListener("playing", ready, { once: true });
  tail.play().catch(fail);
}

function handover() {
  const t = ctx.currentTime;
  n.tailGain.gain.cancelScheduledValues(t);
  n.tailGain.gain.setValueAtTime(1, t);
  n.main.gain.cancelScheduledValues(t);
  n.main.gain.setValueAtTime(0, t);
  Object.assign(xf, { phase: "fading", ramped: false, expectEmptied: true, len: fadeSeconds() });
  crossHandler.start();   // основной плеер включает следующий трек
}

/** Новый трек зазвучал — прошлый стихает, новый нарастает (кривые «равной мощности» — без провала посередине) */
function rampCross() {
  xf.ramped = true;
  const rate = tail.playbackRate || 1;
  const left = Number.isFinite(tail.duration) ? (tail.duration - tail.currentTime) / rate : xf.len;
  const len = Math.max(0.4, Math.min(xf.len, left));
  const steps = 64, down = new Float32Array(steps), up = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    down[i] = Math.cos(x * Math.PI / 2);
    up[i] = Math.sin(x * Math.PI / 2);
  }
  down[steps - 1] = 0;
  up[steps - 1] = 1;
  const t = ctx.currentTime;
  n.tailGain.gain.cancelScheduledValues(t);
  n.main.gain.cancelScheduledValues(t);
  n.tailGain.gain.setValueCurveAtTime(down, t, len);
  n.main.gain.setValueCurveAtTime(up, t, len);
  const token = xf.token;
  clearTimeout(xf.timer);
  xf.timer = setTimeout(() => { if (token === xf.token) stopTail(); }, len * 1000 + 150);
}

function updateFade() {
  if (!ctx) return;
  const sec = fadeSeconds();
  const left = secondsLeft();
  if (xf.phase === "idle" && Number.isFinite(left) && left <= sec + PREP_SEC && canCross(sec)) prepTail();
  if (xf.phase === "prep" && left <= sec) syncTail();
  // Наложение будет (или уже готовится) — затухать основному не нужно, конец доиграет хвост
  const crossing = xf.phase === "prep" || xf.phase === "sync" || (xf.phase === "idle" && canCross(sec));
  let gain = 1;
  if (sec > 0) {
    const t = audio.currentTime, dur = trackLength(), speed = audio.playbackRate || 1;
    if (!crossing && Number.isFinite(left) && dur > sec * 3) gain = Math.min(gain, Math.max(0, left / sec));
    if (autoNext) {
      const fadeIn = sec * 0.6;
      if (t / speed < fadeIn) gain = Math.min(gain, t / speed / fadeIn);
      else autoNext = false;
    }
  }
  n.fade.gain.setTargetAtTime(gain, ctx.currentTime, 0.12);
}

export function initAudio() {
  // Первое действие человека — создаём цепочку
  const firstGesture = () => { ensureAudioGraph(); resumeAudio(); };
  addEventListener("pointerdown", firstGesture, true);
  addEventListener("keydown", firstGesture, true);
  audio.addEventListener("play", resumeAudio);
  audio.addEventListener("ended", () => {
    if (xf.phase === "prep" || xf.phase === "sync") stopTail();   // хвост не успел — обычный переход
    autoNext = true;   // следующий трек включится сам — с нарастанием
  });
  audio.addEventListener("timeupdate", updateFade);
  audio.addEventListener("volumechange", () => {
    updateHeadroom();   // запас под эквалайзер зависит от громкости
    tail.volume = audio.volume;
    tail.muted = audio.muted;
  });
  audio.addEventListener("seeked", updateFade);
  // Перемотали, пока хвост готовился, — начнём заново, когда снова дойдём до конца
  audio.addEventListener("seeking", () => {
    if (xf.phase === "prep" || xf.phase === "sync") { stopTail(); xf.src = ""; }
  });
  audio.addEventListener("pause", () => {
    if (xf.phase === "prep" || xf.phase === "sync") { stopTail(); xf.src = ""; }
    // Пауза посреди наложения — прошлый трек не ждёт, новый сразу на полную. Пока основной ещё
    // не переключился (трек «из базы» ищет пару и сам ставит паузу) — это не человек, хвост играет
    else if (xf.phase === "fading" && !xf.expectEmptied) stopTail();
  });
  audio.addEventListener("playing", () => {
    if (xf.phase === "fading" && !xf.expectEmptied && !xf.ramped) rampCross();
  });
  tail.addEventListener("ended", () => { if (xf.phase === "fading") stopTail(); });
  tail.addEventListener("error", () => { if (xf.phase !== "idle" && tail.getAttribute("src")) stopTail(); });
  audio.addEventListener("emptied", () => {
    xf.src = "";
    if (xf.expectEmptied) xf.expectEmptied = false;   // это мы сами включили следующий трек
    else if (xf.phase !== "idle") stopTail(true);      // человек выбрал другой трек посреди наложения
    if (ctx) n.fade.gain.setValueAtTime(autoNext && fadeSeconds() ? 0 : 1, ctx.currentTime);
  });
  applyFx();   // скорость — сразу, даже до цепочки
}
