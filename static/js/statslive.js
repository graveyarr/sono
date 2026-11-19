// Экран «Статистика» на ПК («Живая обложка», макет design/ui-new/B-ekrany.html#stats).
// Сверху — период (Неделя | Месяц | Год | Всё время) и четыре плитки: время, треки, исполнители, откуда слушаете чаще всего.
// Ниже — исполнители по времени, треки «чаще всего», музыка по дням и карточка «Итоги года».
// Данные — stats.js periodStats(). На телефоне — прежний экран (stats.js renderStats); какой показать, решает views.js.

import { segment } from "./artistlive.js";
import { icons } from "./icons.js";
import { lib } from "./library.js";
import { openArtist } from "./nav.js";
import { play } from "./player.js";
import { avatar, formatListen, periodStats } from "./stats.js";
import { coverUrl, displayTrack, el } from "./ui.js";
import { hasWrapped, openWrapped, wrappedSeason } from "./wrapped.js";

const PERIODS = [["Неделя", "week"], ["Месяц", "month"], ["Год", "year"], ["Всё время", "all"]];
let period = "month";   // помним, пока работает программа
const ARTISTS_SHORT = 6, ARTISTS_LONG = 50, TRACKS_SHORT = 5, TRACKS_LONG = 30;

/** Слово к числу без самого числа: «треков», «исполнителя» */
function word(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const num = (n) => Math.round(n).toLocaleString("ru");
const dayText = (ts) => new Date(ts).toLocaleDateString("ru", { day: "numeric", month: "long" });

function tile(big, sub, small = "", tone = "") {
  const t = el("div", "sx-tile glass");
  t.append(el("b", "", big), el("span", "", sub));
  if (small) t.append(el("small", tone, small));
  return t;
}

/** «▲ 2 ч к октябрю» / «▼ 40 мин к прошлой неделе»; разница меньше минуты — не пишем */
function deltaText(p) {
  if (p.prev == null || !p.prevLabel || (!p.prev && !p.sec)) return "";
  const diff = p.sec - p.prev;
  if (Math.abs(diff) < 60) return "";
  return `${diff > 0 ? "▲" : "▼"} ${formatListen(Math.abs(diff))} ${p.prevLabel}`;
}

function box(title, note) {
  const b = el("section", "tp-box sx-box glass");
  const h = el("h3", "tp-box-h");
  h.append(el("span", "tp-box-t", title));
  if (note) h.append(el("span", "tp-box-note", note));
  b.append(h);
  return b;
}

/** Кнопка «Все N» / «Свернуть» под списком */
function moreButton(total, short, long, onToggle) {
  if (total <= short) return null;
  const b = el("button", "meta-more sx-more");
  b.type = "button";
  let open = false;
  const draw = () => { b.textContent = open ? "Свернуть" : `Все ${Math.min(total, long)}`; };
  draw();
  b.addEventListener("click", () => { open = !open; draw(); onToggle(open); });
  return b;
}

function artistsBox(p) {
  const b = box("Исполнители", "по времени");
  const list = el("div", "sx-rows");
  const max = p.artists[0]?.sec || 1;
  const fill = (n) => list.replaceChildren(...p.artists.slice(0, n).map((a, i) => {
    const row = el("button", "tp-row sx-artist");
    row.type = "button";
    const pic = el("span", "tp-row-img round", a.name.slice(0, 1).toUpperCase());
    avatar(a, pic);
    const text = el("div", "tp-row-text");
    const bar = el("div", "sx-bar");
    const fillBar = el("i");
    fillBar.style.width = `${Math.max(2, (a.sec / max) * 100)}%`;
    bar.append(fillBar);
    text.append(el("b", "", a.name), bar);
    row.append(el("span", "tp-row-n", String(i + 1)), pic, text, el("span", "tp-row-r", formatListen(a.sec)));
    row.title = `${a.name} — ${formatListen(a.sec)}`;
    if (a.id) row.dataset.warm = `artist:${a.id}`;
    row.addEventListener("click", () => openArtist({ id: a.id, name: a.name }));
    return row;
  }));
  fill(ARTISTS_SHORT);
  b.append(list);
  const more = moreButton(p.artists.length, ARTISTS_SHORT, ARTISTS_LONG, (open) => fill(open ? ARTISTS_LONG : ARTISTS_SHORT));
  if (more) b.append(more);
  return b;
}

function tracksBox(p) {
  const b = box("Треки", "чаще всего");
  const list = el("div", "sx-rows");
  const all = p.tracks.slice(0, TRACKS_LONG).map((x) => x.t);
  const context = { type: "stats", id: p.period, name: "Статистика" };
  const fill = (n) => list.replaceChildren(...p.tracks.slice(0, n).map((x, i) => {
    const shown = displayTrack(x.t);
    const row = el("button", "tp-row");
    row.type = "button";
    const img = el("img", "tp-row-img");
    img.alt = "";
    img.loading = "lazy";
    img.src = coverUrl(x.t);
    img.onerror = () => img.classList.add("broken");
    const text = el("div", "tp-row-text");
    text.append(el("b", "", shown.title), el("span", "", shown.artist));
    row.append(el("span", "tp-row-n", String(i + 1)), img, text, el("span", "tp-row-r", `${num(x.plays)} ${word(x.plays, "раз", "раза", "раз")}`));
    row.title = `${shown.artist} — ${shown.title} · включить`;
    row.addEventListener("click", () => play(x.t, all, i, context));
    return row;
  }));
  fill(TRACKS_SHORT);
  b.append(list);
  const more = moreButton(p.tracks.length, TRACKS_SHORT, TRACKS_LONG, (open) => fill(open ? TRACKS_LONG : TRACKS_SHORT));
  if (more) b.append(more);
  return b;
}

function daysBox(p) {
  const b = box("По дням", p.barsTitle);
  b.querySelector(".tp-box-t").textContent = p.period === "year" ? "По месяцам" : p.period === "all" ? "По годам" : "По дням";
  b.querySelector(".tp-box-note").textContent = p.period === "month" ? p.barsTitle : p.period === "week" ? "7 дней" : "";
  const bars = el("div", "sx-days");
  const labeled = p.bars.length <= 12;
  bars.classList.toggle("labeled", labeled);
  const max = Math.max(...p.bars.map((x) => x.sec), 1);
  p.bars.forEach((x, i) => {
    const col = el("span", "sx-day");
    const bar = el("i");
    bar.style.height = x.sec ? `${Math.max(4, (x.sec / max) * 100)}%` : "0";
    if (i === p.bars.length - 1) col.classList.add("cur");
    col.title = `${x.title} — ${x.sec >= 30 ? formatListen(x.sec) : "без музыки"}`;
    col.append(bar);
    if (labeled) col.append(el("small", "", x.label));
    bars.append(col);
  });
  b.append(bars);
  return b;
}

/** «Итоги 2026»: есть что показать — открывает итоги, нет — «скоро» */
function yearCard() {
  const year = wrappedSeason() ?? new Date().getFullYear();
  const ready = hasWrapped(year);
  const card = el(ready ? "button" : "div", `sx-year${ready ? "" : " soon"}`);
  if (ready) {
    card.type = "button";
    card.addEventListener("click", () => openWrapped(year));
  }
  card.append(el("span", "sx-year-kick", ready ? (wrappedSeason() ? "Готово" : "Уже можно посмотреть") : "Скоро"),
    el("b", "", `Итоги ${year}`),
    el("span", "sx-year-sub", ready ? "Ваш год в музыке — карточками, как сторис" : "Послушайте ещё немного — и здесь появятся итоги года"));
  if (ready) card.insertAdjacentHTML("beforeend", `<span class="sx-year-go">${icons.chevron}</span>`);
  return card;
}

export function renderStatsLive(box) {
  const root = el("div", "sx-live");
  const head = el("div", "live-hd");
  const title = el("h1", "live-h1");
  const left = el("div", "live-hd-l");
  left.append(el("div", "live-kick", "Ваша статистика"), title);
  const body = el("div", "sx-body");
  const draw = () => {
    const p = periodStats(period);
    title.textContent = p.title;
    if (!p.sec && !p.artists.length) {
      const fresh = !(lib.stats?.total > 0);   // совсем новый человек — не «за это время», а «пока пусто»
      const empty = el("section", "sx-empty glass");
      empty.append(el("b", "", fresh ? "Здесь пока пусто" : "За это время музыки не было"),
        el("span", "", fresh ? "Слушайте музыку — здесь появятся ваши исполнители и треки, сколько и когда вы слушали."
          : "Выберите другой период или включите что-нибудь."));
      body.replaceChildren(empty);
      return;
    }
    const tiles = el("div", "sx-tiles");
    tiles.append(tile(p.sec >= 60 ? formatListen(p.sec) : "0 мин", p.timeLabel, deltaText(p)));
    // Подробности за неделю/месяц пишутся с нового вида: пока их нет — не «0 треков», а прочерк и с какого дня считаем
    const since = p.detailFrom ? `считаем с ${dayText(p.detailFrom)}` : "";
    const count = (n) => (p.detailFrom && !n ? "—" : num(n));
    tiles.append(tile(count(p.trackCount), word(p.trackCount, "трек", "трека", "треков"), p.newTracks ? `${num(p.newTracks)} — впервые` : since));
    tiles.append(tile(count(p.artistCount), word(p.artistCount, "исполнитель", "исполнителя", "исполнителей"),
      p.newArtists ? `${num(p.newArtists)} — ${word(p.newArtists, "новый", "новых", "новых")}` : since));
    if (p.source) {
      const pct = (x) => `${Math.max(1, Math.round(x * 100))} %`;
      tiles.append(tile(p.source.name, "чаще всего", p.source.mode ? `«${p.source.mode}» — ${pct(p.source.modeShare)}` : `${pct(p.source.share)} времени`));
    }
    tiles.style.setProperty("--n", tiles.childElementCount);
    const grid = el("div", "sx-grid");
    const side = el("div", "sx-side");
    side.append(daysBox(p), yearCard());
    const waiting = (title, note) => {
      const b = box(title, note);
      b.append(el("p", "sx-wait", `Появятся, когда послушаете музыку: за ${period === "week" ? "неделю" : "месяц"} Sono считает их с ${dayText(p.detailFrom ?? Date.now())}.`));
      return b;
    };
    grid.append(p.artists.length ? artistsBox(p) : waiting("Исполнители", "по времени"),
      p.tracks.length ? tracksBox(p) : waiting("Треки", "чаще всего"), side);
    const parts = [tiles, grid];
    // Неделю и месяц Sono подробно записывает только с нового вида — честно говорим, с какого дня
    if (p.detailFrom && (p.artists.length || p.tracks.length)) parts.push(el("p", "sx-note", `Исполнители и треки за ${period === "week" ? "неделю" : "месяц"} считаются с ${dayText(p.detailFrom)} — раньше Sono не записывал их по дням. Время — за весь период.`));
    body.replaceChildren(...parts);
  };
  head.append(left, el("span", "sp"), segment(PERIODS, period, (v) => { period = v; draw(); }));
  root.append(head, body);
  draw();
  box.replaceChildren(root);
}
