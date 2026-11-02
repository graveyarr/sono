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
  if (shown) load();
}

function head() {
  const h = el("div", "lyrics-head");
  h.append(el("span", "lyrics-title", "Текст"), el("span", "lyrics-source", "LRCLIB"));
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

async function load() {
  const track = state.current;
  if (!track || loadedKey === keyOf(track)) return;
  const key = loadedKey = keyOf(track);
  showLoading();
  const shown = displayTrack(track);
  const params = new URLSearchParams({ artist: shown.artist, title: shown.title, duration: track.duration || 0 });
  let data;
  try {
    const res = await fetch(`/api/lyrics/${track.source}/${track.id}?${params}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "сервер не ответил");
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
  if (data.synced.length) {
    for (const [time, words] of data.synced) {
      const line = el("button", "lyrics-line", words || "♪");
      line.type = "button";
      line.addEventListener("click", () => {
        seekTo(time);
        if (audio.paused) togglePlay();
        userScrolledAt = 0;   // щёлкнули по строке — снова следим за песней
      });
      listEl.append(line);
      lines.push({ time, node: line });
    }
  } else {
    listEl.append(el("div", "lyrics-plain", data.plain), el("p", "lyrics-note", "У этого текста нет таймингов — он не прокручивается за песней."));
  }
  // Человек крутит текст сам — несколько секунд не мешаем
  const userScroll = () => { userScrolledAt = Date.now(); };
  listEl.addEventListener("wheel", userScroll, { passive: true });
  listEl.addEventListener("pointerdown", userScroll);
  box.replaceChildren(head(), listEl);
  sync(true);
}

/** Подсветить строку, которая звучит сейчас, и прокрутить к ней */
function sync(instant = false) {
  if (!visible || !lines.length) return;
  const t = audio.currentTime + 0.3;   // чуть заранее — строка загорается к моменту, когда её поют
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
  audio.addEventListener("seeked", () => { activeIndex = -2; userScrolledAt = 0; sync(true); });   // перемотали — сразу к нужной строке
  apply();
}
