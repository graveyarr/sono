// Текст песни на экране «Сейчас играет» (кнопка с микрофоном).
// Текст берёт сервер из LRCLIB. Если у песни есть тайминги строк — текущая строка
// подсвечивается и прокручивается к середине, по щелчку на строку — перемотка к ней.

import { getSetting, keyOf, setSetting } from "./library.js";
import { onTrackChange, seekTo, state, togglePlay } from "./player.js";
import { displayTrack, el } from "./ui.js";

const box = document.getElementById("lyrics");
const audio = document.getElementById("player");
const buttons = () => document.querySelectorAll('[data-np="lyrics"]');

let visible = false;
let loadedKey = null;   // для какого трека текст уже загружен
let lines = [];         // [{ time, node }] — строки с таймингами
let activeIndex = -1;
let listEl = null;      // прокручиваемый список строк
let userScrolledAt = 0; // когда человек сам крутил текст — автопрокрутка ненадолго уступает

function apply() {
  const shown = visible && !!state.current;
  document.body.classList.toggle("show-lyrics", shown);
  box.hidden = !shown;
  buttons().forEach((b) => {
    b.classList.toggle("on", visible);
    b.title = visible ? "Скрыть текст" : "Текст песни";
    b.setAttribute("aria-label", b.title);
  });
  // Текст встаёт на место «Очереди» — её кнопка не должна гореть, пока самой очереди не видно
  const queueOn = document.body.classList.contains("show-queue") && !shown;
  document.querySelectorAll('[data-np="queue"]').forEach((b) => b.classList.toggle("on", queueOn));
  box.classList.remove(...LYRICS_STYLES.map((x) => `ls-${x.id}`));
  box.classList.add(`ls-${lyricsStyle()}`);
  if (shown) load();
}

// Оформление текста (Настройки → Оформление): «Карточка» — фон цвета обложки, как в Spotify (по умолчанию);
// «Спокойный» — тонкий текст без эффектов; «Крупный» — прежний: большая светящаяся строка (другу казался смешным)
export const LYRICS_STYLES = [
  { id: "card", title: "Карточка", hint: "Фон цвета обложки, текущая строка — белая" },
  { id: "minimal", title: "Спокойный", hint: "Тонкий текст без эффектов" },
  { id: "big", title: "Крупный", hint: "Большие строки, текущая светится" },
];
export const lyricsStyle = () => {
  const id = getSetting("lyricsStyle", "card");
  return LYRICS_STYLES.some((x) => x.id === id) ? id : "card";
};
export function setLyricsStyle(id) {
  setSetting("lyricsStyle", id);
  apply();
}

// Сдвиг текста для трека (секунды, «+» — строки позже): бывает, что отметки в базе чуть не совпадают
// с нашей загрузкой — текст отстаёт или спешит (друг автора, 9 ноября). Запоминается для трека
let offset = 0;
const OFFSETS = "lyricsOffsets";
const offsetOf = (key) => Number(getSetting(OFFSETS, {})?.[key]) || 0;
function saveOffset(key, value) {
  const all = { ...getSetting(OFFSETS, {}) };
  delete all[key];
  if (value) all[key] = value;
  const keys = Object.keys(all);
  if (keys.length > 200) delete all[keys[0]];   // храним последние 200
  setSetting(OFFSETS, all);
}
const offsetText = (v) => (v ? `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1).replace(".", ",")} с` : "0 с");

function offsetControl() {
  const wrap = el("div", "lyrics-offset");
  const earlier = el("button", "", "−0,5");
  earlier.type = "button";
  earlier.title = "Текст отстаёт — показывать строки раньше";
  const value = el("button", "lyrics-offset-val", offsetText(offset));
  value.type = "button";
  value.title = "Сдвиг текста для этого трека. Щелчок — сбросить";
  const later = el("button", "", "+0,5");
  later.type = "button";
  later.title = "Текст спешит — показывать строки позже";
  const change = (v) => {
    offset = Math.max(-30, Math.min(30, Math.round(v * 10) / 10));
    saveOffset(loadedKey, offset);
    value.textContent = offsetText(offset);
    activeIndex = -2;
    sync(true);
  };
  earlier.addEventListener("click", () => change(offset - 0.5));
  later.addEventListener("click", () => change(offset + 0.5));
  value.addEventListener("click", () => change(0));
  wrap.append(earlier, value, later);
  return wrap;
}

/** Шапка панели; synced — у текста есть отметки времени (тогда кнопки сдвига). Откуда текст — внизу списка */
function head(synced = false) {
  const h = el("div", "lyrics-head");
  h.append(el("span", "lyrics-title", "Текст"));
  if (synced) h.append(offsetControl());
  return h;
}

function showMessage(text) {
  lines = [];
  listEl = null;
  box.replaceChildren(head(), el("p", "lyrics-message", text));
}

function showLoading() {
  lines = [];
  const skeleton = el("div", "lyrics-lines");
  for (let i = 0; i < 6; i++) skeleton.append(el("div", "lyrics-skeleton"));
  box.replaceChildren(head(), skeleton);
}

// Тексты, которые уже спрашивали (обещания): следующий трек очереди спрашиваем заранее, пока открыт текст, —
// при переключении он появляется сразу, а не через 0,5–1 с «скелета»
const fetched = new Map();
function fetchLyrics(track) {
  const key = keyOf(track);
  if (!fetched.has(key)) {
    const shown = displayTrack(track);
    const params = new URLSearchParams({ artist: shown.artist, title: shown.title, duration: track.duration || 0 });
    const job = fetch(`/api/lyrics/${track.source}/${track.id}?${params}`).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "сервер не ответил");
      return data;
    });
    job.catch(() => fetched.delete(key));
    fetched.set(key, job);
    if (fetched.size > 30) fetched.delete(fetched.keys().next().value);
  }
  return fetched.get(key);
}

function prefetchNextLyrics() {
  const next = state.queue[state.index + 1];
  if (visible && next && next.source !== "meta") fetchLyrics(next).catch(() => {});
}

async function load() {
  const track = state.current;
  if (!track || loadedKey === keyOf(track)) return;
  const key = loadedKey = keyOf(track);
  showLoading();
  let data;
  try {
    data = await fetchLyrics(track);
    setTimeout(prefetchNextLyrics, 3000);   // следующий — чуть позже: сначала звук текущего
  } catch (err) {
    if (loadedKey === key) { loadedKey = null; showMessage(err.message); }   // null — чтобы можно было повторить
    return;
  }
  if (loadedKey !== key) return;   // пока ждали, включили другой трек
  render(data);
}

function render(data) {
  activeIndex = -1;
  if (!data.found) return showMessage("Текст для этого трека не нашёлся.");
  if (data.instrumental) return showMessage("♪ Инструментальная композиция — без слов.");

  listEl = el("div", "lyrics-lines");
  lines = [];
  offset = offsetOf(loadedKey);
  if (data.synced.length) {
    for (const [time, words] of data.synced) {
      const line = el("button", "lyrics-line", words || "♪");
      line.type = "button";
      line.addEventListener("click", () => {
        seekTo(Math.max(0, time + offset));
        if (audio.paused) togglePlay();
        userScrolledAt = 0;   // щёлкнули по строке — снова следим за песней
      });
      listEl.append(line);
      lines.push({ time, node: line });
    }
  } else {
    listEl.append(el("div", "lyrics-plain", data.plain), el("p", "lyrics-note", "У этого текста нет таймингов — он не прокручивается за песней."));
  }
  if (data.source) listEl.append(el("p", "lyrics-note lyrics-source", `Текст — ${data.source}`));   // откуда текст
  // Человек крутит текст сам — несколько секунд не мешаем
  const userScroll = () => { userScrolledAt = Date.now(); };
  listEl.addEventListener("wheel", userScroll, { passive: true });
  listEl.addEventListener("pointerdown", userScroll);
  box.replaceChildren(head(lines.length > 0), listEl);
  sync(true);
}

/** Подсветить строку, которая звучит сейчас, и прокрутить к ней */
function sync(instant = false) {
  if (!visible || !lines.length) return;
  const t = audio.currentTime + 0.3 - offset;   // чуть заранее — строка загорается к моменту, когда её поют
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1].time <= t) i++;
  if (i === activeIndex) return;
  activeIndex = i;
  lines.forEach((line, n) => {
    line.node.classList.toggle("active", n === i);
    line.node.classList.toggle("past", n < i);
  });
  if (i < 0 || Date.now() - userScrolledAt < 4000) return;
  const node = lines[i].node;
  listEl.scrollTo({ top: node.offsetTop - listEl.clientHeight * 0.38, behavior: instant ? "auto" : "smooth" });
}

export const isLyricsVisible = () => visible;

/** Показать/спрятать текст (например, кнопка «Очередь» прячет текст, чтобы показать очередь) */
export function setLyricsVisible(show) {
  visible = show;
  setSetting("showLyrics", visible);
  apply();
}

export function initLyrics() {
  visible = !!getSetting("showLyrics", false);
  buttons().forEach((b) => b.addEventListener("click", () => {
    visible = !visible;
    setSetting("showLyrics", visible);
    apply();
  }));
  onTrackChange(apply);
  audio.addEventListener("timeupdate", () => sync());
  // timeupdate приходит лишь ~4 раза в секунду — строка загоралась с опозданием до 0,25 с. Чаще — только пока играет
  setInterval(() => { if (!audio.paused) sync(); }, 100);
  audio.addEventListener("seeked", () => { activeIndex = -2; userScrolledAt = 0; sync(true); });   // перемотали — сразу к нужной строке
  apply();
}
