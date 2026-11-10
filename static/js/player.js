// Плеер: звук, очередь, кнопки управления, обложка и фон под неё.
// Элементы управления помечены data-np="..." — их два набора (большой экран
// «Сейчас играет» и мини-плеер внизу), и оба обновляются одновременно.

import { icons } from "./icons.js";
import { setCrossfadeHandler } from "./audio.js";
import { addToHistory, altVersionOf, getSetting, isDisliked, isLiked, keyOf, lib, sessionChanged, setSetting, slim } from "./library.js";
import { isMeta, missingReason, resolveMeta, toReal } from "./meta.js";
import { SOURCE_NAMES, artistLinks, compactNumber, coverUrl, displayTrack, formatTime, imageHsl, playsText, replay, toast, trackPath } from "./ui.js";

const audio = document.getElementById("player");
const coverEl = document.getElementById("cover");
const infoEl = document.getElementById("np-info");
const statusEl = document.getElementById("status");
const sourceBadge = document.getElementById("source-badge");

const all = (role) => document.querySelectorAll(`[data-np="${role}"]`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const state = {
  current: null,   // трек, который сейчас играет
  queue: [],       // очередь: список, из которого его включили (для «назад/вперёд»), её можно менять
  index: -1,       // место текущего трека в очереди
  context: null,   // откуда включили: { type: "playlist", id } | { type: "liked" } | { type: "search" } ...
  shuffle: false,  // перемешивание
  repeat: "off",   // повтор: off | all (всю очередь) | one (один трек)
  original: null,  // очередь в исходном порядке — чтобы вернуть его, когда перемешивание выключат
  stopAfterTrack: null,   // таймер сна «до конца трека»: функция — вызвать, когда трек доиграет (дальше не идём)
};

const shuffled = (list) => {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
const queueChanged = () => { updateNavButtons(); prefetchNext(); trackListeners.forEach((fn) => fn()); };
let seeking = false;   // пользователь тянет ползунок перемотки

const trackListeners = new Set();
/** fn() — сменился трек */
export const onTrackChange = (fn) => trackListeners.add(fn);
const playListeners = new Set();
/** fn(playing) — играет или пауза */
export const onPlayState = (fn) => playListeners.add(fn);

const endListeners = new Set();
/** fn() — последний трек очереди доиграл, а дальше ничего нет */
export const onQueueEnd = (fn) => endListeners.add(fn);

export const isPlaying = () => !audio.paused;

// ---------- Подготовка заранее ----------
// Подготовка трека занимает несколько секунд (YouTube — получить ссылку,
// SoundCloud — начать скачивание), поэтому делаем её до нажатия:
// для первых результатов поиска, для трека под курсором и для следующего в очереди.

const prefetched = new Set();
export function prefetch(track) {
  if (!track) return Promise.resolve();
  if (isMeta(track)) return resolveMeta(track, { prefetch: true }).catch(() => {});   // найти пару и подготовить звук
  const path = trackPath("prefetch", track);
  if (prefetched.has(path)) return Promise.resolve();
  prefetched.add(path);
  return fetch(path, { method: "POST" }).catch(() => {});
}

/** Пока играет трек — готовим два следующих, чтобы «вперёд» (даже дважды подряд) и автопереход были мгновенными.
    Второй — после первого: не занимаем YouTube двумя запросами сразу, пока играет музыка */
function prefetchNext() {
  const i = nextPlayable(state.index, 1);
  if (i < 0) return;
  prefetch(state.queue[i]).then(() => {
    const j = nextPlayable(i, 1);
    if (j >= 0 && j !== state.index) prefetch(state.queue[j]);
  });
}

export function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
  if (text) console.log("[status]", text);
  // Строка состояния есть только на «Сейчас играет» — на других экранах ошибку показываем уведомлением,
  // иначе трек молча не играет. Во Flow пропуск ненайденного трека — обычное дело, не шумим
  if (isError && text && !document.body.classList.contains("on-now") && state.context?.type !== "flow") {
    toast(text, { error: true });
  }
}

// ---------- Включение трека ----------

/** Включить трек из списка: queue — весь список, index — где в нём трек.
    При включённом перемешивании выбранный трек играет первым, остальные — вперемешку. */
export function play(track, queue = [track], index = 0, context = null) {
  if (state.shuffle && queue.length > 1) {
    state.original = queue.slice();
    queue = [track, ...shuffled(queue.filter((_, i) => i !== index))];
    index = 0;
  } else {
    state.original = null;
  }
  playAt(track, queue, index, context);
}

/** Включить трек, который уже стоит в очереди (кнопки «назад/вперёд», щелчок в очереди) */
export function playFromQueue(i) {
  if (state.queue[i]) playAt(state.queue[i], state.queue, i, state.context);
}

// Трек «из базы» (страница исполнителя/альбома): сначала ищем ему пару на YouTube или SoundCloud.
// Название и обложку показываем сразу, пока ищем; нет нигде — сообщаем и идём дальше.
let metaToken = 0;   // чтобы ответ старого поиска не включил трек, когда уже выбрали другой

async function playMeta(track, queue, index, context) {
  const token = ++metaToken;
  Object.assign(state, { queue, index, current: track, context });
  const shown = displayTrack(track);
  all("title").forEach((n) => { n.textContent = shown.title; n.title = track.title; });
  all("artist").forEach((n) => n.replaceChildren(artistLinks(track, shown.artist)));
  all("cover-mini").forEach((img) => { img.classList.remove("broken"); img.src = coverUrl(track); });
  replay(infoEl, "swap");
  showCover(track);
  audio.pause();
  all("play").forEach((b) => { b.classList.add("loading"); b.disabled = false; });
  document.body.classList.add("has-track");
  setStatus("Ищу трек на YouTube и SoundCloud…");
  trackListeners.forEach((fn) => fn());

  let real;
  try {
    real = await toReal(track);
  } catch (err) {
    if (token !== metaToken) return;
    all("play").forEach((b) => b.classList.remove("loading"));
    return setStatus("Не получилось найти трек: " + err.message, true);
  }
  if (token !== metaToken) return;   // пока искали, включили другое
  if (!real) {
    all("play").forEach((b) => b.classList.remove("loading"));
    setStatus(`${missingReason(track)} — включаю следующий`, true);
    // Во Flow не задерживаемся — это просто следующий трек подборки
    setTimeout(() => { if (token === metaToken) playNext(); }, context?.type === "flow" ? 300 : 1500);
    return;
  }
  queue[index] = real;   // дальше в очереди уже настоящий трек
  playAt(real, queue, index, context);
}

function playAt(track, queue, index, context) {
  if (isMeta(track)) return playMeta(track, queue, index, context);
  // Этот трек запикан, и уже нашлась версия без цензуры — играем её
  const alt = altVersionOf(track);
  if (alt) { track = alt; queue[index] = alt; }
  metaToken++;   // если до этого искали трек из базы — его ответ уже не нужен
  state.queue = queue;
  state.index = index;
  state.current = track;
  state.context = context;
  restored = null;

  showTrackInfo(track, 0);
  setStatus("");
  all("play").forEach((b) => b.classList.add("loading"));

  pendingSeek = null;
  audio.dataset.trackDuration = track.duration || "";   // для плавного затухания в конце (audio.js)
  audio.src = trackPath("stream", track);
  audio.play().catch(() => {});   // ошибки показывает обработчик "error" ниже
  warnIfSlow(track);

  addToHistory(track);
  updateMediaSession(track);
  trackListeners.forEach((fn) => fn());
}

/** Название, исполнитель, обложка, ползунок (на месте at секунд) — всё, кроме самого звука */
function showTrackInfo(track, at) {
  const shown = displayTrack(track);
  all("title").forEach((n) => { n.textContent = shown.title; n.title = track.title; });
  all("artist").forEach((n) => n.replaceChildren(artistLinks(track, shown.artist)));
  all("cover-mini").forEach((img) => { img.classList.remove("broken"); img.src = coverUrl(track); });
  sourceBadge.textContent = SOURCE_NAMES[track.source] ?? "";
  showTrackStats(track);
  replay(infoEl, "swap");
  showCover(track);

  const fraction = track.duration ? Math.min(at / track.duration, 1) : 0;
  all("play").forEach((b) => { b.disabled = false; });
  all("seek").forEach((r) => { r.disabled = false; r.value = fraction * 1000; setFill(r, fraction); });
  all("time-current").forEach((n) => { n.textContent = formatTime(at); });
  all("time-total").forEach((n) => { n.textContent = formatTime(track.duration); });
  ["like", "dislike", "add", "lyrics"].forEach((role) => all(role).forEach((b) => { b.disabled = false; }));
  syncLikeButtons();
  updateNavButtons();
  document.body.classList.add("has-track");
}

// ---------- Прошлый сеанс ----------
// Запоминаем, что играло (трек, до 100 треков очереди, место) — при следующем запуске трек уже стоит
// в плеере на паузе и подгружается заранее: ▶ играет сразу и с того же места, без тишины и поиска.

let restored = null;   // { failed } — трек вернули из прошлого сеанса, но ещё не включали

/** Только простые поля откуда включили (в контексте Flow бывают списки треков — их не храним) */
const plainContext = (ctx) => (ctx && typeof ctx === "object"
  ? Object.fromEntries(Object.entries(ctx).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)))
  : null);

function saveSession(soon) {
  const t = state.current;
  if (!t || isMeta(t)) return;   // трек из базы, которому ещё ищут пару, — подождём настоящий
  const start = Math.max(0, state.index - 20);
  lib.session = {
    track: slim(t),
    queue: state.queue.slice(start, start + SESSION_QUEUE).map(slim),
    index: state.index - start,
    pos: Math.round(sessionPos()),
    context: plainContext(state.context),
    shuffle: state.shuffle,
    at: Date.now(),
  };
  sessionChanged(soon);
}
const SESSION_QUEUE = 100;
const sessionPos = () => (restored && pendingSeek !== null ? pendingSeek : audio.currentTime || 0);

/** Вернуть трек прошлого сеанса — на паузе, звук подгружается сразу (main.js — после всех init…) */
export function restoreSession() {
  const s = lib.session;
  const track = s?.track;
  if (state.current || !track?.source || !track.id || isMeta(track)) return;
  let queue = Array.isArray(s.queue) ? s.queue.filter((t) => t?.source && t.id) : [];
  let index = queue.findIndex((t) => keyOf(t) === keyOf(track));
  if (index < 0) { queue = [track]; index = 0; }
  const pos = Number(s.pos) > 1 && Number(s.pos) < (track.duration || Infinity) - 5 ? Number(s.pos) : 0;
  Object.assign(state, { current: track, queue, index, original: null,
    context: s.context && typeof s.context === "object" ? { ...s.context, restored: true } : null });
  restored = { failed: false };

  showTrackInfo(track, pos);
  pendingSeek = pos || null;
  audio.dataset.trackDuration = track.duration || "";
  // SoundCloud перематывается только в готовый файл — сразу просим его (сервер докачает за 1–3 с)
  audio.src = trackPath("stream", track) + (track.source === "soundcloud" && pos ? "?full=1" : "");
  updateMediaSession(track);
  trackListeners.forEach((fn) => fn());
}

// Трек не начался за 6 с — говорим, что происходит, а не молчим. Обычно это редкое видео YouTube:
// кэш-сервер провайдера сначала сам скачивает его у Google (замер 3 ноября 2026: 15–25 с), потом отдаёт
let slowTimer = 0;
function warnIfSlow(track) {
  clearTimeout(slowTimer);
  const src = audio.src;
  slowTimer = setTimeout(() => {
    if (audio.src !== src || audio.currentTime > 0 || audio.error || audio.paused) return;
    const text = track.source === "youtube"
      ? "YouTube долго отдаёт этот трек — редкие видео он сначала загружает к себе. Ещё немного…"
      : "Трек долго загружается — ещё немного…";
    setStatus(text);
    if (!document.body.classList.contains("on-now")) toast(text);
  }, 6000);
}

/** Заменить играющий трек другой версией (например, без цензуры) и продолжить с того же места */
let resumeAt = null;
export function swapCurrent(alt) {
  if (!state.current) return;
  const pos = audio.currentTime;
  state.queue[state.index] = alt;
  playAt(alt, state.queue, state.index, state.context);
  resumeAt = pos > 1 ? pos : null;
}

/** Вернуться к треку очереди и продолжить с того же места (например, «Отменить» после дизлайка) */
export function returnToQueue(i, pos = 0) {
  if (!state.queue[i]) return;
  playFromQueue(i);
  resumeAt = pos > 1 ? pos : null;
}

/** Под ползунком рядом с «YouTube»/«SoundCloud» — сколько раз трек слушали и лайкали */
async function showTrackStats(track) {
  const key = keyOf(track);
  const put = (s) => {
    if (state.current && keyOf(state.current) !== key) return;   // пока ждали, включили другой
    const parts = [SOURCE_NAMES[track.source] ?? "", playsText(s.plays, track.source)];
    if (s.likes) parts.push(`${compactNumber(s.likes)} ♥`);
    sourceBadge.textContent = parts.filter(Boolean).join(" · ");
  };
  if (track.plays != null && track.likes != null) return put(track);
  try {
    // Не мешаем старту звука: сведения спрашиваем чуть позже (у YouTube они придут вместе со ссылкой)
    await wait(1500);
    if (state.current && keyOf(state.current) !== key) return;
    const res = await fetch(trackPath("stats", track));
    if (res.ok) put(await res.json());
  } catch {}
}

/** Следующий трек без дизлайка (-1 — такого нет). При повторе всей очереди после конца — снова с начала */
function nextPlayable(from, step) {
  for (let i = from + step; i >= 0 && i < state.queue.length; i += step) {
    if (!isDisliked(state.queue[i])) return i;
  }
  if (step > 0 && state.repeat === "all") {
    for (let i = 0; i <= from && i < state.queue.length; i++) {
      if (!isDisliked(state.queue[i])) return i;
    }
  }
  return -1;
}

function updateNavButtons() {
  all("prev").forEach((b) => { b.disabled = !state.current; });
  all("next").forEach((b) => { b.disabled = nextPlayable(state.index, 1) < 0; });
}

export function togglePlay() {
  if (!state.current) return;
  if (restored) {
    // Трек прошлого сеанса: подгруженный — просто играем; не подгрузился (ссылка устарела, файл удалён) —
    // включаем заново, с того же места
    const { failed } = restored;
    const at = sessionPos();
    restored = null;
    addToHistory(state.current);
    if (failed) { playAt(state.current, state.queue, state.index, state.context); resumeAt = at > 1 ? at : null; return; }
    warnIfSlow(state.current);
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

export function playNext() {
  const i = nextPlayable(state.index, 1);
  if (i >= 0) playFromQueue(i);
  return i >= 0;
}

export function playPrev() {
  if (!state.current) return;
  const i = nextPlayable(state.index, -1);
  if (audio.currentTime > 3 || i < 0) audio.currentTime = 0;   // как в Spotify: сначала в начало трека
  else playFromQueue(i);
}

// ---------- Перемешивание и повтор ----------

export function toggleShuffle() {
  state.shuffle = !state.shuffle;
  setSetting("shuffle", state.shuffle);
  if (state.current && state.queue.length > 1) {
    if (state.shuffle) {
      // Текущий трек остаётся первым, всё остальное — вперемешку
      state.original = state.queue.slice();
      state.queue = [state.current, ...shuffled(state.queue.filter((_, i) => i !== state.index))];
      state.index = 0;
    } else if (state.original) {
      // Возвращаем исходный порядок и продолжаем с того же трека
      state.queue = state.original;
      state.index = Math.max(0, state.queue.findIndex((t) => keyOf(t) === keyOf(state.current)));
      state.original = null;
    }
  }
  syncModeButtons();
  queueChanged();
}

export function cycleRepeat() {
  state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
  setSetting("repeat", state.repeat);
  syncModeButtons();
  updateNavButtons();
}

function syncModeButtons() {
  all("shuffle").forEach((b) => {
    b.innerHTML = icons.shuffle;
    b.classList.toggle("on", state.shuffle);
    b.title = state.shuffle ? "Перемешивание включено" : "Перемешать";
    b.setAttribute("aria-label", b.title);
  });
  all("repeat").forEach((b) => {
    b.innerHTML = state.repeat === "one" ? icons.repeatOne : icons.repeat;
    b.classList.toggle("on", state.repeat !== "off");
    b.title = { off: "Повтор выключен", all: "Повтор очереди", one: "Повтор трека" }[state.repeat];
    b.setAttribute("aria-label", b.title);
  });
  all("queue").forEach((b) => { b.innerHTML = icons.queue; b.title ||= "Очередь"; });
}

// ---------- Очередь ----------

/** «Играть следующим»: вставляет трек в очередь сразу после текущего */
export function queueNext(track) {
  if (!state.current) return play(track);
  const rest = state.queue.slice(state.index + 1).filter((t) => keyOf(t) !== keyOf(track));
  state.queue = [...state.queue.slice(0, state.index + 1), track, ...rest];
  prefetch(track);
  queueChanged();
}

/** Дописать треки в конец очереди (Flow подкладывает новые, пока играет) */
export function extendQueue(tracks) {
  const have = new Set(state.queue.map(keyOf));
  const fresh = tracks.filter((t) => !have.has(keyOf(t)));
  state.queue = [...state.queue, ...fresh];
  if (state.original) state.original = [...state.original, ...fresh];
  queueChanged();
}

/** Заменить всё, что впереди (Flow сменил режим) */
export function replaceUpcoming(tracks) {
  state.queue = [...state.queue.slice(0, state.index + 1), ...tracks];
  state.original = null;
  queueChanged();
}

/** Убрать трек из очереди (только из тех, что ещё впереди) */
export function removeFromQueue(i) {
  if (i <= state.index || !state.queue[i]) return;
  state.queue = state.queue.filter((_, n) => n !== i);
  queueChanged();
}

/** Перетаскивание в очереди: трек с места from встаёт на место to (оба — впереди текущего) */
export function moveInQueue(from, to) {
  if (from <= state.index || to <= state.index || from === to || !state.queue[from]) return;
  const queue = state.queue.slice();
  const [track] = queue.splice(from, 1);
  queue.splice(to, 0, track);
  state.queue = queue;
  queueChanged();
}

/** Очистить всё, что впереди */
export function clearQueue() {
  state.queue = state.queue.slice(0, state.index + 1);
  state.original = null;
  queueChanged();
}

export function seekBy(seconds) {
  if (!state.current) return;
  seekTo(audio.currentTime + seconds);
}

/** Сердечко и дизлайк у текущего трека (после изменений в медиатеке) */
export function syncLikeButtons() {
  const liked = !!state.current && isLiked(state.current);
  const disliked = !!state.current && isDisliked(state.current);
  all("like").forEach((b) => {
    b.innerHTML = liked ? icons.heartFilled : icons.heart;
    b.classList.toggle("on", liked);
    b.title = liked ? "Убрать из избранного" : "В избранное";
    b.setAttribute("aria-label", b.title);
  });
  all("dislike").forEach((b) => {
    b.innerHTML = disliked ? icons.dislikeFilled : icons.dislike;
    b.classList.toggle("on", disliked);
    b.title = disliked ? "Убрать дизлайк" : "Не нравится";
    b.setAttribute("aria-label", b.title);
  });
  updateNavButtons();
}

// ---------- Обложка и фон под неё ----------

// Что берём из обложки — решает тема (themes.js, «coverColors» в theme.json):
// on — фон и акцент, accent — только акцент, tint — только фон, off — ничего (цвета задаёт сама тема)
let coverMode = document.getElementById("theme-css")?.dataset.cover || "on";   // тему вписал сервер (app.py index)
let lastCoverImg = null;

function applyCoverColors(img) {
  lastCoverImg = img;
  resetCoverColors();
  if (coverMode === "off") return;
  let h, s, l;
  try { [h, s, l] = imageHsl(img); } catch { return; }
  const root = document.documentElement.style;
  // Фон — тёмный вариант цвета обложки, чтобы белый текст всегда читался
  if (coverMode !== "accent") {
    root.setProperty("--tint", `hsl(${h.toFixed(0)} ${Math.min(s, 65).toFixed(0)}% ${Math.min(Math.max(l * 0.45, 9), 20).toFixed(0)}%)`);
  }
  // Акцент (ползунок, текущий трек) — светлый вариант; у серых обложек — просто белый
  if (coverMode !== "tint") {
    root.setProperty("--accent", s < 12 ? "hsl(0 0% 92%)" : `hsl(${h.toFixed(0)} ${Math.max(s, 55).toFixed(0)}% 72%)`);
  }
}

function resetCoverColors() {
  document.documentElement.style.removeProperty("--tint");
  document.documentElement.style.removeProperty("--accent");
}

export function setCoverColorsMode(mode) {
  coverMode = ["on", "off", "accent", "tint"].includes(mode) ? mode : "on";
  if (lastCoverImg && state.current) applyCoverColors(lastCoverImg);
  else resetCoverColors();
}

// Два слоя размытой обложки: новый проявляется, старый гаснет
const artLayers = document.querySelectorAll(".bg-art");
let artFront = 0;

/** Размытая обложка заранее: крошечная копия (48×48) с размытием и насыщенностью.
    Растянутая на весь экран, она выглядит как сильное размытие, но видеокарте не нужно
    размывать огромный слой каждый кадр (раньше это делал CSS filter: blur(80px)) */
function blurredCover(img) {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 48;
    const x = c.getContext("2d");
    x.filter = "blur(5px) saturate(1.6)";
    x.drawImage(img, -8, -8, 64, 64);   // с запасом по краям — чтобы размытие не темнело к краю
    return c.toDataURL("image/jpeg", 0.9);
  } catch {
    return null;
  }
}

function setBackdrop(url) {
  artFront ^= 1;
  const next = artLayers[artFront], prev = artLayers[artFront ^ 1];
  if (url) {
    next.style.backgroundImage = `url("${url}")`;
    next.classList.add("on");
  }
  prev.classList.remove("on");
}

async function showCover(track) {
  coverEl.classList.remove("shown");
  const url = coverUrl(track, "large");
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch {
    if (state.current !== track) return;
    lastCoverImg = null;
    resetCoverColors();
    setBackdrop(null);
    return;   // обложки нет — остаётся заглушка с нотой
  }
  if (state.current !== track) return;   // пока грузили, включили другой трек
  await wait(150);                       // даём старой обложке погаснуть
  if (state.current !== track) return;
  coverEl.src = url;
  coverEl.classList.add("shown");
  setBackdrop(blurredCover(img));
  applyCoverColors(img);
}

// ---------- Перемотка, время, громкость ----------

// Длительность трека. Пока трек SoundCloud ещё докачивается, браузер её не знает
// или считает по уже пришедшему куску (например, «0:10») — тогда берём ту,
// что пришла вместе с треком из поиска
function trackDuration() {
  const known = state.current?.duration || 0;
  const browser = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (known && Math.abs(browser - known) > 3) return known;
  return browser || known;
}

// Перемотка. Если место ещё не скачано (трек SoundCloud отдаётся по мере скачивания,
// и браузер не умеет перематывать такой поток), берём готовый файл — сервер
// отдаст его, как только трек докачается (обычно 1–3 секунды), — и ставим позицию.
let pendingSeek = null;
function canSeekTo(seconds) {
  for (let i = 0; i < audio.seekable.length; i++) {
    if (audio.seekable.start(i) <= seconds && seconds <= audio.seekable.end(i)) return true;
  }
  return false;
}

export function seekTo(seconds) {
  const track = state.current;
  if (!track) return;
  seconds = Math.min(Math.max(0, seconds), trackDuration() || seconds);
  if (track.source === "soundcloud" && !canSeekTo(seconds)) {
    pendingSeek = seconds;
    audio.src = trackPath("stream", track) + "?full=1";
    audio.play().catch(() => {});
    return;
  }
  audio.currentTime = seconds;
}

// Закрашенная часть ползунка
function setFill(range, fraction) {
  range.style.setProperty("--p", `${(fraction * 100).toFixed(2)}%`);
}

function bindSeek(range) {
  range.addEventListener("input", () => {
    seeking = true;
    const fraction = range.value / 1000;
    all("seek").forEach((r) => { r.value = range.value; setFill(r, fraction); });
    all("time-current").forEach((n) => { n.textContent = formatTime(fraction * trackDuration()); });
  });
  range.addEventListener("change", () => {
    if (trackDuration()) seekTo((range.value / 1000) * trackDuration());
    seeking = false;
  });
}

// Ползунок громкости — в децибелах: каждый шаг ползунка добавляет одинаковую «на слух» громкость.
// От −40 дБ (едва слышно) до −4 дБ (громко, но не «уши болят»); в самом низу — плавно до тишины.
// Раньше было положение³: внизу ползунка звук пропадал совсем (−60 дБ), а вся громкость
// сидела в верхней части — «на тихом ничего не слышно, на максимуме слишком громко» (отзыв друга).
const MIN_DB = -40, MAX_DB = -4;
const DEFAULT_LEVEL = 0.6;   // ≈ −18 дБ — как прежняя громкость по умолчанию
const toVolume = (level) => (level <= 0 ? 0
  : 10 ** ((MIN_DB + (MAX_DB - MIN_DB) * level) / 20) * Math.min(1, level / 0.06));
/** Старое положение ползунка (громкость = положение³) → новое (та же громкость, где это возможно) */
const fromCubic = (old) => (old > 0 ? Math.min(1, Math.max(0.02, (60 * Math.log10(old) - MIN_DB) / (MAX_DB - MIN_DB))) : 0);
let volumeLevel = DEFAULT_LEVEL;

function setVolumeLevel(level) {
  volumeLevel = Math.min(Math.max(Number(level) || 0, 0), 1);
  audio.volume = toVolume(volumeLevel);
}

/** Громче/тише на шаг (глобальные клавиши Ctrl+Alt+↑/↓ из трея — tray.py). Возвращает новое положение 0…1 */
export function stepVolume(delta) {
  setVolumeLevel(volumeLevel + delta);
  audio.muted = false;
  setSetting("volumePos", volumeLevel);
  applyVolume();
  return volumeLevel;
}

// Громкость показана в двух местах (большой экран и мини-плеер) — обновляем оба
function applyVolume() {
  const level = audio.muted ? 0 : volumeLevel;
  all("volume").forEach((r) => { r.value = level; setFill(r, level); r.title = `Громкость ${Math.round(level * 100)}%`; });
  all("volume-pct").forEach((n) => { n.textContent = `${Math.round(level * 100)}%`; });
  placeVolumeTips(level);
  document.querySelectorAll(".volume").forEach((box) => box.classList.toggle("muted", level === 0));
}

/** «Пилюля» с процентами над шариком ползунка в нижнем плеере: ставим ровно над ним.
    Шарик 12 px, его центр ходит от 6 px до (ширина − 6 px) — так считает и сам браузер */
function placeVolumeTips(level) {
  all("volume-tip").forEach((tip) => {
    const range = tip.parentElement.querySelector('input[type="range"]');
    if (!range) return;
    tip.textContent = `${Math.round(level * 100)}%`;
    tip.style.left = `${range.offsetLeft + 6 + level * (range.offsetWidth - 12)}px`;
  });
}

// ---------- Системные медиаклавиши и панель Windows ----------

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  const shown = displayTrack(track);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: shown.title,
    artist: shown.artist,
    artwork: [{ src: location.origin + coverUrl(track, "large"), type: "image/jpeg" }],
  });
}

// ---------- Подключение ----------

/** Нижний плеер — маленький или большой (Настройки → Оформление, settings.minibarLarge) */
export function setMinibarLarge(on) {
  document.body.classList.toggle("minibar-large", !!on);
}

export function initPlayer() {
  // Наложение треков (audio.js): можно ли сейчас наложить следующий трек и как его включить
  setCrossfadeHandler({
    canStart: () => !!state.current && !state.stopAfterTrack && state.repeat !== "one" && nextPlayable(state.index, 1) >= 0,
    start: () => playNext(),
  });
  all("play").forEach((b) => b.addEventListener("click", togglePlay));
  all("prev").forEach((b) => b.addEventListener("click", playPrev));
  all("next").forEach((b) => b.addEventListener("click", playNext));
  all("seek").forEach(bindSeek);
  all("cover-mini").forEach((img) => { img.onerror = () => img.classList.add("broken"); });

  audio.addEventListener("timeupdate", () => {
    if (seeking || !trackDuration()) return;
    const fraction = Math.min(audio.currentTime / trackDuration(), 1);
    all("seek").forEach((r) => { r.value = fraction * 1000; setFill(r, fraction); });
    all("time-current").forEach((n) => { n.textContent = formatTime(audio.currentTime); });
  });
  audio.addEventListener("durationchange", () => {
    if (trackDuration()) all("time-total").forEach((n) => { n.textContent = formatTime(trackDuration()); });
  });
  // Готовый файл для перемотки загрузился — ставим позицию, которую просили
  audio.addEventListener("loadedmetadata", () => {
    if (resumeAt !== null) {   // заменили версию трека — продолжаем с того же места
      const at = resumeAt;
      resumeAt = null;
      seekTo(at);
      return;
    }
    if (pendingSeek === null) return;
    audio.currentTime = pendingSeek;
    pendingSeek = null;
  });

  const syncPlaying = () => {
    const playing = !audio.paused;
    document.body.classList.toggle("playing", playing);
    all("play").forEach((b) => b.setAttribute("aria-label", playing ? "Пауза" : "Играть"));
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    playListeners.forEach((fn) => fn(playing));
  };
  audio.addEventListener("play", syncPlaying);
  audio.addEventListener("pause", syncPlaying);

  const loading = (on) => all("play").forEach((b) => b.classList.toggle("loading", on));
  audio.addEventListener("waiting", () => loading(true));
  audio.addEventListener("playing", () => { loading(false); setStatus(""); prefetchNext(); });
  audio.addEventListener("canplay", () => loading(false));
  audio.addEventListener("ended", () => {
    if (state.stopAfterTrack) {   // таймер сна «до конца трека» — дальше не играем
      const done = state.stopAfterTrack;
      state.stopAfterTrack = null;
      syncPlaying();
      done();
    } else if (state.repeat === "one") {   // повтор трека — с начала
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else if (!playNext()) {
      syncPlaying();
      endListeners.forEach((fn) => fn());   // очередь закончилась (Flow может продолжить)
    }
  });
  audio.addEventListener("error", async () => {
    if (!state.current) return;
    if (restored) { restored.failed = true; return; }   // трек прошлого сеанса — молча, включим заново по ▶
    loading(false);
    const src = audio.src;
    let msg = "не получилось воспроизвести трек";
    try {   // спрашиваем у сервера, что именно пошло не так
      const r = await fetch(src, { headers: { Range: "bytes=0-1" } });
      if (!r.ok) msg = (await r.json()).error || msg;
    } catch {}
    // Пока спрашивали (до 15 с), могли включить другой трек — тогда эта ошибка уже не про него
    if (audio.src !== src) return;
    setStatus("Ошибка: " + msg, true);
  });

  // Громкость (запоминается как положение ползунка — volumePos). Старые настройки пересчитываем:
  // volumeLevel — положение при прежней шкале «положение³», volume — сама громкость (ещё раньше)
  const oldVolume = getSetting("volume", null), oldLevel = getSetting("volumeLevel", null);
  const saved = getSetting("volumePos", null);
  setVolumeLevel(saved !== null ? saved
    : oldLevel !== null ? fromCubic(Number(oldLevel))
    : oldVolume !== null ? fromCubic(Math.cbrt(Number(oldVolume))) : DEFAULT_LEVEL);
  // Пока тянут ползунок, пилюля с процентами не прячется, даже если курсор ушёл с него
  all("volume").forEach((range) => {
    const box = range.closest(".volume");
    range.addEventListener("pointerdown", () => {
      box.classList.add("dragging");
      placeVolumeTips(audio.muted ? 0 : volumeLevel);
      addEventListener("pointerup", () => box.classList.remove("dragging"), { once: true });
    });
    range.addEventListener("pointerenter", () => placeVolumeTips(audio.muted ? 0 : volumeLevel));
  });
  all("volume").forEach((range) => range.addEventListener("input", () => {
    setVolumeLevel(range.value);
    audio.muted = false;
    setSetting("volumePos", volumeLevel);
    applyVolume();
  }));
  all("mute").forEach((btn) => btn.addEventListener("click", () => {
    if (audio.muted || volumeLevel === 0) {
      audio.muted = false;
      if (volumeLevel === 0) setVolumeLevel(DEFAULT_LEVEL);
    } else {
      audio.muted = true;
    }
    applyVolume();
  }));
  applyVolume();
  syncLikeButtons();   // нарисовать значки, пока ничего не играет

  // Перемешивание и повтор (запоминаются)
  state.shuffle = !!getSetting("shuffle", false);
  state.repeat = ["off", "all", "one"].includes(getSetting("repeat")) ? getSetting("repeat") : "off";
  all("shuffle").forEach((b) => b.addEventListener("click", toggleShuffle));
  all("repeat").forEach((b) => b.addEventListener("click", cycleRepeat));
  syncModeButtons();
  setMinibarLarge(getSetting("minibarLarge", false));

  // Прошлый сеанс: запоминаем при смене трека/очереди и паузе (через 2 с), место — пока играет (раз в 15 с)
  trackListeners.add(() => saveSession(true));
  audio.addEventListener("pause", () => saveSession(true));
  audio.addEventListener("timeupdate", () => {
    if (audio.paused || !lib.session?.track || !state.current || keyOf(lib.session.track) !== keyOf(state.current)) return;
    lib.session.pos = Math.round(audio.currentTime);
    sessionChanged();
  });

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", togglePlay);
    navigator.mediaSession.setActionHandler("pause", togglePlay);
    navigator.mediaSession.setActionHandler("previoustrack", playPrev);
    navigator.mediaSession.setActionHandler("nexttrack", playNext);
  }
}
