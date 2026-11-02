// Звуковая цепочка Sono (Web Audio). Звук плеера (<audio id="player">) идёт так:
//   источник → басы (полка 110 Гц) → «сухой» звук + реверб → выравнивание громкости → плавность → анализатор → колонки
// - басы, реверб, скорость — «Звуковые эффекты» (кнопка у плеера, settings.fx);
// - выравнивание громкости — мягкий компрессор: тихие треки ближе к громким (settings.normalize);
// - плавность — громкость гаснет в конце трека и нарастает в начале следующего (settings.fadeSec);
// - анализатор читают визуализация и маленькие «эквалайзеры» (viz.js).
// Создать цепочку можно только после действия человека (щелчок, клавиша) — иначе браузер «заморозит» звук.

import { getSetting, setSetting } from "./library.js";

const audio = document.getElementById("player");

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
    n.fade.connect(n.analyser).connect(ctx.destination);
    n.direct = null;
    routeNormalize();
    applyFx();
    readyListeners.forEach((fn) => fn());
  } catch (err) {
    console.log("[audio] звуковая цепочка недоступна:", err.message);
    ctx = null;
  }
}

export function resumeAudio() {
  if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
}

/** Эффекты выключены — звук идёт напрямую, мимо фильтров; включены — через полную цепочку */
function routeFx(direct) {
  if (direct === n.direct) return;
  n.source.disconnect();
  n.source.connect(direct ? n.mix : n.pre);
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

// ---------- Плавные переходы ----------
// Не наложение двух треков (для этого нужен второй плеер), а мягкое затухание в конце трека
// и нарастание в начале следующего, если он включился сам (а не по щелчку).

let autoNext = false;

function trackLength() {
  // Пока трек SoundCloud докачивается, браузер врёт про длительность — длительность из данных трека надёжнее
  const known = Number(audio.dataset.trackDuration);
  return known > 0 ? known : audio.duration;
}

function updateFade() {
  if (!ctx) return;
  const sec = fadeSeconds();
  let gain = 1;
  if (sec > 0) {
    const t = audio.currentTime, dur = trackLength(), speed = audio.playbackRate || 1;
    const left = (dur - t) / speed;   // сколько осталось в настоящих секундах (со скоростью)
    if (Number.isFinite(left) && dur > sec * 3) gain = Math.min(gain, Math.max(0, left / sec));
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
  audio.addEventListener("ended", () => { autoNext = true; });   // следующий трек включится сам — с нарастанием
  audio.addEventListener("timeupdate", updateFade);
  audio.addEventListener("volumechange", updateHeadroom);   // запас под эквалайзер зависит от громкости
  audio.addEventListener("seeked", updateFade);
  audio.addEventListener("emptied", () => { if (ctx) n.fade.gain.setValueAtTime(autoNext && fadeSeconds() ? 0 : 1, ctx.currentTime); });
  applyFx();   // скорость — сразу, даже до цепочки
}
