// Текст песни на экране «Сейчас играет» (кнопка с микрофоном).
// Текст берёт сервер из LRCLIB. Если у песни есть тайминги строк — текущая строка
// подсвечивается и прокручивается к середине, по щелчку на строку — перемотка к ней.
// «По словам» («Живая обложка», ПК): строки едут вверх, текущая крупнее, дальние размыты, слова загораются
// по очереди (у LRCLIB отметки только у строк — слова раскладываем по времени строки). Та же строка —
// в карточке «Сейчас играет» на «Главной» (showLyricLine).

import { getSetting, keyOf, setSetting } from "./library.js";
import { isMobile } from "./device.js";
import { EASE, calm, liveUi } from "./motion.js";
import { onTrackChange, seekTo, state, togglePlay } from "./player.js";
import { displayTrack, el } from "./ui.js";

const box = document.getElementById("lyrics");
const audio = document.getElementById("player");
const buttons = () => document.querySelectorAll('[data-np="lyrics"]');

let visible = false;
let dataKey = null;     // для какого трека текст уже загружен (или грузится)
let data = null;        // ответ сервера для dataKey
let timed = [];         // [[время, строка]] — строки с отметками времени (для панели и «Главной»)
let shownKey = null;    // для какого трека нарисована панель
let lines = [];         // [{ time, node, words }] — строки панели с таймингами
let activeIndex = -1;
let listEl = null;      // прокручиваемый список строк
let userScrolledAt = 0; // когда человек сам крутил текст — автопрокрутка ненадолго уступает
let hero = null;        // строчка текста в карточке «Сейчас играет» на «Главной»
let heroIndex = -2;     // какая строка в ней сейчас
let mini = null;        // две строчки в мини-плеере «Квадрат» (compact.js)
let miniIndex = -2;

function apply() {
  const shown = visible && !!state.current;
  document.body.classList.toggle("show-lyrics", shown);
  const wasHidden = box.hidden;
  box.hidden = !shown;
  if (shown && wasHidden && lines.length) { activeIndex = -2; sync(true); }   // показали панель — к текущей строке
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
  load();
}

// Оформление текста (Настройки → Оформление): «Карточка» — фон цвета обложки, как в Spotify (по умолчанию);
// «Спокойный» — тонкий текст без эффектов; «Крупный» — прежний: большая светящаяся строка (другу казался смешным)
// «По словам» — новый вид (по умолчанию там): ПК и телефон (шаг 11б)
export const LYRICS_STYLES = [
  ...(liveUi() || isMobile ? [{ id: "words", title: "По словам", hint: "Строки плывут вверх, слова загораются по очереди" }] : []),
  { id: "card", title: "Карточка", hint: "Фон цвета обложки, текущая строка — белая" },
  { id: "minimal", title: "Спокойный", hint: "Тонкий текст без эффектов" },
  { id: "big", title: "Крупный", hint: "Большие строки, текущая светится" },
];
export const lyricsStyle = () => {
  const fallback = liveUi() || isMobile ? "words" : "card";
  const id = getSetting("lyricsStyle", fallback);
  return LYRICS_STYLES.some((x) => x.id === id) ? id : fallback;
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
    saveOffset(dataKey, offset);
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
export function fetchLyrics(track) {
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

/** Нужен ли текст: открыт на «Сейчас играет» или есть строчка на «Главной» */
const wanted = () => !!state.current && (visible || (!!hero && hero.isConnected) || !!mini);

async function load() {
  const track = state.current;
  if (!wanted()) return;
  const key = keyOf(track);
  if (dataKey === key) {   // текст уже есть (или грузится) — дорисовать панель, если её открыли
    if (visible && data && shownKey !== key) renderPanel();
    return;
  }
  dataKey = key;
  data = null;
  timed = [];
  shownKey = null;
  heroIndex = -2;
  if (hero) { hero.replaceChildren(); hero.classList.add("empty"); }
  drawMini(-3);
  if (visible) showLoading();
  let got;
  try {
    got = await fetchLyrics(track);
    setTimeout(prefetchNextLyrics, 3000);   // следующий — чуть позже: сначала звук текущего
  } catch (err) {
    if (dataKey === key) { dataKey = null; if (visible) showMessage(err.message); }   // null — чтобы можно было повторить
    return;
  }
  if (dataKey !== key) return;   // пока ждали, включили другой трек
  data = got;
  timed = got.found && !got.instrumental ? got.synced : [];
  offset = offsetOf(key);
  if (visible) renderPanel();
  activeIndex = -2;
  sync(true);
}

/** Строка — отдельные слова (для «По словам»; в остальных видах слова просто стоят подряд) */
function wordsOf(text) {
  const frag = document.createDocumentFragment(), words = [];
  String(text).split(/(\s+)/).forEach((part) => {
    if (!part) return;
    if (/^\s+$/.test(part)) { frag.append(" "); return; }
    const w = el("span", "lw", part);
    frag.append(w);
    words.push(w);
  });
  return { frag, words };
}

function renderPanel() {
  shownKey = dataKey;
  activeIndex = -1;
  if (!data.found) return showMessage("Текст для этого трека не нашёлся.");
  if (data.instrumental) return showMessage("♪ Инструментальная композиция — без слов.");

  listEl = el("div", "lyrics-lines");
  lines = [];
  offset = offsetOf(dataKey);
  if (data.synced.length) {
    for (const [time, text] of data.synced) {
      const line = el("button", "lyrics-line");
      line.type = "button";
      const { frag, words } = wordsOf(text || "♪");
      line.append(frag);
      line.addEventListener("click", () => {
        seekTo(Math.max(0, time + offset));
        if (audio.paused) togglePlay();
        userScrolledAt = 0;   // щёлкнули по строке — снова следим за песней
      });
      listEl.append(line);
      lines.push({ time, node: line, words });
    }
  } else {
    listEl.append(el("div", "lyrics-plain", data.plain), el("p", "lyrics-note", "У этого текста нет таймингов — он не прокручивается за песней."));
  }
  if (data.source) listEl.append(el("p", "lyrics-note lyrics-source", `Текст — ${data.source}`));   // откуда текст
  // Человек крутит текст сам — несколько секунд не мешаем
  const userScroll = () => { userScrolledAt = Date.now(); scrollAnim++; };
  listEl.addEventListener("wheel", userScroll, { passive: true });
  listEl.addEventListener("pointerdown", userScroll);
  box.replaceChildren(head(lines.length > 0), listEl);
  sync(true);
  // Вход на экран: строки выплывают из размытия по очереди
  if (!calm() && box.classList.contains("ls-words") && box.getClientRects().length) {
    const from = Math.max(0, activeIndex - 3);   // видны строки вокруг текущей — они и выплывают
    lines.slice(from, from + 10).forEach((l, i) => l.node.animate([{ offset: 0, opacity: 0, transform: "translateY(26px)", filter: "blur(12px)" }],
      { duration: 800, delay: 120 + i * 60, easing: EASE, fill: "backwards" }));
  }
}

/** Прокрутка к строке за 0,9 с той же «пружиной», что и всё остальное (обычная плавная — резче и короче) */
let scrollAnim = 0;
function glide(target) {
  const list = listEl, from = list.scrollTop, t0 = performance.now(), id = ++scrollAnim;
  const step = (now) => {
    if (id !== scrollAnim || list !== listEl) return;
    const k = Math.min(1, (now - t0) / 900), e = 1 - (1 - k) ** 4;
    list.scrollTop = from + (target - from) * e;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Подсветить строку, которая звучит сейчас, и прокрутить к ней; в «По словам» — ещё и слова */
function sync(instant = false) {
  // Строчка на «Главной»: пустая она спрятана — смотрим, видна ли сама карточка
  const heroOn = !!hero && hero.isConnected && (hero.parentElement?.getClientRects().length ?? 0) > 0;
  if (mini && !timed.length && miniIndex !== -3) drawMini(-3);
  if ((!visible && !heroOn && !mini) || !timed.length) return;
  const t = audio.currentTime + 0.3 - offset;   // чуть заранее — строка загорается к моменту, когда её поют
  let i = -1;
  while (i + 1 < timed.length && timed[i + 1][0] <= t) i++;
  // Сколько строки уже спето: слова загораются равномерно за время строки (на четверть быстрее —
  // последние слова обычно тянут). Пауза до следующей строки считается не длиннее 8 с
  const start = i < 0 ? 0 : timed[i][0], end = timed[i + 1]?.[0] ?? start + 4;
  const frac = i < 0 ? 0 : Math.min(1, (t - start) / Math.max(0.6, Math.min(end - start, 8)));
  const words = visible && box.classList.contains("ls-words");
  if (mini && i !== miniIndex) drawMini(i);
  if (i !== activeIndex) {
    activeIndex = i;
    lines.forEach((line, n) => {
      line.node.classList.toggle("active", n === i);
      line.node.classList.toggle("past", n < i);
      line.node.classList.toggle("far", Math.abs(n - Math.max(i, 0)) >= 2);
    });
    if (visible && listEl && i >= 0 && lines[i] && Date.now() - userScrolledAt >= 4000) {
      const top = lines[i].node.offsetTop - listEl.clientHeight * (words ? 0.3 : 0.38);
      if (words && !instant && !calm()) glide(top);
      else { scrollAnim++; listEl.scrollTo({ top, behavior: instant ? "auto" : "smooth" }); }
    }
  }
  if (heroOn && heroIndex !== Math.max(i, 0)) drawHero(Math.max(i, 0), i >= 0);
  const lit = (count) => Math.ceil(frac * 1.25 * count);
  if (words && lines[i]) { const ws = lines[i].words, n = lit(ws.length); ws.forEach((w, k) => w.classList.toggle("lit", k < n)); }
  if (heroOn) { const ws = hero.querySelectorAll(".lw"), n = hero.classList.contains("ahead") ? 0 : lit(ws.length); ws.forEach((w, k) => w.classList.toggle("lit", k < n)); }
}

/** Строчка в карточке на «Главной»: новая выплывает снизу из размытия */
function drawHero(i, singing) {
  heroIndex = i;
  // Проигрыш (пустая строка) — показываем бледной следующую строку со словами
  let k = i;
  while (k < timed.length && !(timed[k][1] || "").trim()) k++;
  const text = timed[k]?.[1] || "";
  hero.replaceChildren(wordsOf(text).frag);
  hero.classList.toggle("empty", !text);
  hero.classList.toggle("ahead", !singing || k !== i);   // её ещё не поют — бледная
  if (!calm()) hero.animate([{ opacity: 0, transform: "translateY(10px)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
    { duration: 600, easing: EASE });
}

/** Мини-плеер «Квадрат»: строка, которую поют (бледная — если её ещё не поют), и следующая под ней.
 *  i = -3 — текста нет (пусто) */
function drawMini(i) {
  miniIndex = i;
  if (!mini) return;
  let k = Math.max(i, 0);
  while (i > -3 && k < timed.length && !(timed[k][1] || "").trim()) k++;
  const cur = i > -3 ? timed[k]?.[1] || "" : "";
  const next = cur ? timed.slice(k + 1).find((x) => (x[1] || "").trim())?.[1] || "" : "";
  mini.replaceChildren(...(cur ? [el("b", "", cur), el("span", "", next)] : []));
  mini.classList.toggle("empty", !cur);
  mini.classList.toggle("ahead", !!cur && k !== i);
}

/** Мини-плеер «Квадрат» показывает строки текста (null — убрать) */
export function showMiniLyric(node) {
  mini = node;
  miniIndex = -2;
  if (!mini) return;
  if (!timed.length) drawMini(-3);
  load();
  sync(true);
}

/** Карточка «Сейчас играет» на «Главной» показывает строку текста (null — убрать) */
export function showLyricLine(node) {
  if (hero !== node) heroIndex = -2;
  hero = node;
  if (!hero) return;
  if (!timed.length) { hero.replaceChildren(); hero.classList.add("empty"); }
  load();
  sync(true);
}

export const isLyricsVisible = () => visible;

/** Показать/спрятать текст (например, кнопка «Очередь» прячет текст, чтобы показать очередь) */
export function setLyricsVisible(show) {
  visible = show;
  setSetting("showLyrics", visible);
  apply();
}

export function initLyrics() {
  visible = !!getSetting("showLyrics", liveUi());   // в новом виде «Сейчас играет» — обложка и текст
  buttons().forEach((b) => b.addEventListener("click", () => {
    visible = !visible;
    setSetting("showLyrics", visible);
    apply();
  }));
  onTrackChange(apply);
  audio.addEventListener("timeupdate", () => sync());
  // timeupdate приходит лишь ~4 раза в секунду — строка загоралась с опозданием до 0,25 с. Чаще — только пока играет
  setInterval(() => { if (!audio.paused) sync(); }, 100);
  audio.addEventListener("play", () => sync(true));
  audio.addEventListener("seeked", () => { activeIndex = -2; userScrolledAt = 0; sync(true); });   // перемотали — сразу к нужной строке
  // Открыли «Сейчас играет» — текст мог нарисоваться, пока экран был спрятан (строки были без размеров):
  // сразу ставим на текущую строку, без проезда
  document.addEventListener("sono:view", (e) => { if (e.detail === "now" && visible) { activeIndex = -2; userScrolledAt = 0; sync(true); } });
  apply();
}
