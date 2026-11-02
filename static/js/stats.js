// Статистика прослушивания: сколько вы слушаете каждого исполнителя и с какого дня.
// Время копится, только пока трек действительно играет (перемотка и пауза не считаются).
// У трека нескольких исполнителей («A, B feat. C») время засчитывается каждому.
// Хранится в медиатеке, раздел stats: { since, total, artists: { ключ: { name, id, sec, plays, first, last } } }.
// Показывается на экране «Ваша статистика» (из «Главной») и строкой на странице исполнителя.

import { lib, statsChanged } from "./library.js";
import { artistByName } from "./meta.js";
import { openArtist, openView, splitArtists } from "./nav.js";
import { onTrackChange, state } from "./player.js";
import { displayTrack, el, imgUrl, plural } from "./ui.js";

const audio = document.getElementById("player");
const PLAY_AFTER = 30;    // столько секунд трека — уже «прослушивание»
const KEEP = 1000;        // столько исполнителей храним (самых слушаемых)

export const artistKey = (name) => (name || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function data() {
  const s = lib.stats;
  if (!s.artists) Object.assign(s, { since: Date.now(), total: 0, artists: {} });
  return s;
}

// ---------- Подсчёт ----------

let lastPos = null;     // где был трек при прошлом «тике»
let trackSec = 0;       // сколько прослушано текущего трека
let counted = false;    // уже засчитали «прослушивание» этому треку

function credit(seconds) {
  const t = state.current;
  if (!t || t.source === "meta") return;
  const s = data();
  const now = Date.now();
  s.total += seconds;
  trackSec += seconds;
  const countPlay = !counted && trackSec >= PLAY_AFTER;
  if (countPlay) counted = true;
  for (const { name, id } of splitArtists(t, displayTrack(t).artist)) {
    const key = artistKey(name);
    if (!key || key === "неизвестный автор") continue;
    const a = s.artists[key] ?? (s.artists[key] = { name, id: null, sec: 0, plays: 0, first: now, last: now });
    a.sec += seconds;
    a.last = now;
    if (id && !a.id) a.id = id;
    if (countPlay) a.plays += 1;
  }
  statsChanged();
}

function onTime() {
  const pos = audio.currentTime;
  if (!audio.paused && lastPos !== null) {
    const delta = (pos - lastPos) / (audio.playbackRate || 1);   // в настоящих секундах (со скоростью эффектов)
    if (delta > 0 && delta < 2) credit(delta);                     // больше 2 с за «тик» — это перемотка
  }
  lastPos = pos;
}

function trim() {
  const s = data();
  const keys = Object.keys(s.artists);
  if (keys.length <= KEEP * 1.1) return;
  keys.sort((a, b) => s.artists[b].sec - s.artists[a].sec).slice(KEEP).forEach((k) => delete s.artists[k]);
}

export function initStats() {
  audio.addEventListener("timeupdate", onTime);
  audio.addEventListener("seeking", () => { lastPos = null; });
  audio.addEventListener("emptied", () => { lastPos = null; });
  let key = null;
  onTrackChange(() => {
    const k = state.current ? `${state.current.source}:${state.current.id}` : null;
    if (k === key) return;
    key = k;
    trackSec = 0;
    counted = false;
    lastPos = null;
    trim();
  });
}

// ---------- Вид ----------

/** «4 ч 12 мин», «37 мин», «меньше минуты» */
export function formatListen(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин`;
  return "меньше минуты";
}

const formatDate = (ts) => new Date(ts).toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" });
const daysAgo = (ts) => Math.max(0, Math.floor((Date.now() - ts) / 86400000));

/** Статистика по исполнителю (для его страницы): по id из базы или по имени */
export function artistStats({ id, name }) {
  const s = lib.stats?.artists;
  if (!s) return null;
  return s[artistKey(name)] ?? Object.values(s).find((a) => id && a.id === id) ?? null;
}

/** Строка для страницы исполнителя: «Вы слушаете с 3 ноября 2026 · 4 ч 12 мин · 37 прослушиваний» */
export function artistStatsLine(artist) {
  const a = artistStats(artist);
  if (!a || a.sec < 30) return null;
  const days = daysAgo(a.first);
  return `Вы слушаете с ${formatDate(a.first)}${days ? ` (${plural(days, "день", "дня", "дней")})` : " — с сегодня"}`
    + ` · ${formatListen(a.sec)} · ${plural(a.plays, "прослушивание", "прослушивания", "прослушиваний")}`;
}

/** Самые слушаемые исполнители */
export function topArtists(n = 50) {
  const s = lib.stats?.artists ?? {};
  return Object.values(s).filter((a) => a.sec >= 30).sort((a, b) => b.sec - a.sec).slice(0, n);
}

/** Карточка на «Главной»: «Вы слушали 12 ч · больше всего — Звери» → экран статистики */
export function statsCard() {
  const top = topArtists(3);
  if (!top.length) return null;
  const card = el("button", "stats-card");
  card.type = "button";
  const total = lib.stats.total || 0;
  card.append(el("span", "stats-card-kicker", "Ваша статистика"),
    el("span", "stats-card-big", formatListen(total)),
    el("span", "stats-card-sub", `больше всего — ${top.map((a) => a.name).join(", ")}`));
  card.addEventListener("click", () => openView("stats"));
  return card;
}

const pictures = new Map();   // имя → адрес фото (или null)

function avatar(a, box) {
  const fill = (url) => {
    if (!url) return;
    const img = el("img");
    img.alt = "";
    img.src = imgUrl(url);
    img.onload = () => box.replaceChildren(img);
  };
  if (pictures.has(a.name)) return fill(pictures.get(a.name));
  artistByName(a.name).then((f) => { pictures.set(a.name, f?.picture ?? null); if (f && !a.id) a.id = f.id; fill(f?.picture); })
    .catch(() => {});
}

/** Экран «Ваша статистика» */
export function renderStats(box) {
  const s = data();
  const top = topArtists(50);
  const head = el("div", "stats-head");
  head.append(el("div", "pl-kind", "Ваша статистика"), el("h1", "pl-name", formatListen(s.total || 0)),
    el("div", "pl-meta", `музыки с ${formatDate(s.since)} · ${plural(Object.keys(s.artists).length, "исполнитель", "исполнителя", "исполнителей")}`));
  const list = el("ol", "stats-list");
  const max = top[0]?.sec || 1;
  top.forEach((a, i) => {
    const li = el("li", "stats-row");
    li.style.setProperty("--i", Math.min(i, 20));
    const pic = el("span", "stats-pic", a.name.slice(0, 1).toUpperCase());
    avatar(a, pic);
    const info = el("div", "stats-info");
    const bar = el("div", "stats-bar");
    const fill = el("i");
    fill.style.width = `${Math.max(2, (a.sec / max) * 100)}%`;
    bar.append(fill);
    info.append(el("div", "stats-name", a.name), bar,
      el("div", "stats-sub", `с ${formatDate(a.first)} · ${plural(a.plays, "прослушивание", "прослушивания", "прослушиваний")}`));
    li.append(el("span", "stats-rank", String(i + 1)), pic, info, el("span", "stats-time", formatListen(a.sec)));
    li.addEventListener("click", () => openArtist({ id: a.id, name: a.name }));
    list.append(li);
  });
  const body = el("div", "pl-body");
  body.append(top.length ? list : el("p", "pl-empty", "Здесь появятся исполнители, которых вы слушаете, — со временем и датой, когда начали."));
  const hero = el("div", "pl-hero stats-hero");
  hero.style.setProperty("--hero", "hsl(250 45% 30%)");
  hero.append(head);
  box.replaceChildren(hero, body);
}
