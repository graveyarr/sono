// «Итоги года»: ваш год в музыке — несколько слайдов один за другим, как сторис.
// Данные — раздел stats.years (копит stats.js): время, исполнители, треки, месяцы, часы, дни.
// Открывается с экрана статистики (кнопка «Итоги …» — в любое время года, итоги растут)
// и карточкой на «Главной» с 1 декабря по 31 января (в январе — за прошлый год).
// Последний слайд: сохранить топ-треки плейлистом или сразу включить.

import { icons } from "./icons.js";
import { createPlaylist, lib, motionOff } from "./library.js";
import { artistByName } from "./meta.js";
import { openArtist, openView } from "./nav.js";
import { play } from "./player.js";
import { formatListen, yearData } from "./stats.js";
import { coverUrl, displayTrack, el, imgUrl, toast } from "./ui.js";

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
// Цвет фона каждого слайда — спокойные насыщенные, без неона
const COLORS = ["#3b2a6b", "#14514a", "#7a2b3a", "#2a3f7a", "#6b4a12", "#1f5a2e", "#5a2363", "#23364a"];
const MIN_SEC = 600;   // меньше 10 минут музыки за год — итоги не показываем

/** «1 минута, 2 минуты, 5 минут» — только слово (число выводим отдельно, с пробелами между разрядами) */
function word(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const num = (n) => Math.round(n).toLocaleString("ru");
const formatDay = (ts) => new Date(ts).toLocaleDateString("ru", { day: "numeric", month: "long" });

/** За какой год показывать карточку на «Главной»: декабрь — за этот, январь — за прошлый, иначе — нет */
export function wrappedSeason() {
  const d = new Date();
  if (d.getMonth() === 11) return d.getFullYear();
  if (d.getMonth() === 0) return d.getFullYear() - 1;
  return null;
}

export const hasWrapped = (year) => (yearData(year)?.total ?? 0) >= MIN_SEC;

// ---------- Подсчёт ----------

/** Один и тот же трек с разных загрузок («Районы кварталы» и «Районы, кварталы [4K]») — одна строка в итогах */
function mergeUploads(list) {
  const norm = (text) => (text || "").toLowerCase().replace(/ё/g, "е").replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const groups = new Map();
  for (const item of list) {
    const shown = displayTrack(item.t);
    const key = `${norm(shown.artist)}|${norm(shown.title)}`;
    const have = groups.get(key);
    if (!have) { groups.set(key, { ...item }); continue; }
    if (item.plays > have.plays) have.t = item.t;   // показываем загрузку, которую включали чаще
    have.sec += item.sec;
    have.plays += item.plays;
  }
  return [...groups.values()];
}

function summary(year) {
  const y = yearData(year);
  const artists = Object.values(y.artists).filter((a) => a?.name && a.sec >= 30).sort((a, b) => b.sec - a.sec);
  const tracks = mergeUploads(Object.values(y.tracks).filter((t) => t?.t?.id)).filter((t) => t.sec >= 30)
    .sort((a, b) => b.plays - a.plays || b.sec - a.sec);
  const months = y.months.map((sec, i) => ({ i, sec }));
  const bestMonth = months.reduce((a, b) => (b.sec > a.sec ? b : a));
  // Время суток: ночь 0–6, утро 6–12, день 12–18, вечер 18–24
  const parts = [0, 6, 12, 18].map((h) => y.hours.slice(h, h + 6).reduce((a, b) => a + b, 0));
  const part = parts.indexOf(Math.max(...parts));
  // Дни с музыкой и самая длинная серия подряд
  const dayKeys = Object.keys(y.days).filter((k) => y.days[k] >= 60).sort();
  let streak = 0, run = 0, prev = null;
  for (const k of dayKeys) {
    const date = new Date(year, Number(k.slice(0, 2)) - 1, Number(k.slice(2)));
    run = prev && (date - prev) / 86400000 < 1.5 ? run + 1 : 1;
    streak = Math.max(streak, run);
    prev = date;
  }
  // Новые для вас исполнители: впервые зазвучали в этом году (если Sono считал и до этого года)
  const yearStart = new Date(year, 0, 1).getTime();
  const all = lib.stats?.artists ?? {};
  const knewBefore = (lib.stats?.since ?? Date.now()) < yearStart;
  const fresh = knewBefore ? Object.values(all).filter((a) => a.first >= yearStart && a.first < new Date(year + 1, 0, 1)).length : null;
  const topGlobal = artists[0] ? Object.values(all).find((a) => a.name === artists[0].name) : null;
  return {
    year, y, artists, tracks, bestMonth, part, parts, days: dayKeys.length, streak, fresh,
    topSince: topGlobal?.first ?? null,
    // Sono начал считать не с начала года — честно говорим об этом
    from: y.from > yearStart + 7 * 86400000 ? y.from : null,
  };
}

// ---------- Слайды ----------

/** Блок, который проявляется с задержкой (по порядку) */
function line(tag, className, text, delay) {
  const node = el(tag, `wr-in ${className}`, text);
  node.style.setProperty("--d", `${delay}s`);
  return node;
}

/** Число «набегает» от нуля */
function countUp(node, value, suffix = "") {
  if (motionOff()) { node.textContent = num(value) + suffix; return; }
  const start = performance.now(), len = 1300;
  const tick = (now) => {
    const k = Math.min(1, (now - start) / len);
    node.textContent = num(value * (1 - (1 - k) ** 3)) + suffix;
    if (k < 1 && node.isConnected) requestAnimationFrame(tick);
  };
  node.textContent = "0" + suffix;
  setTimeout(() => requestAnimationFrame(tick), 350);
}

/** Фото исполнителя (ищется по имени, пока нет — первая буква) */
function artistPic(a, className) {
  const box = el("span", className, (a.name || "?").slice(0, 1).toUpperCase());
  artistByName(a.name).then((found) => {
    if (!found?.picture) return;
    const img = el("img");
    img.alt = "";
    img.src = imgUrl(found.picture);
    img.onload = () => box.replaceChildren(img);
    if (!a.id) a.id = found.id;
  }).catch(() => {});
  return box;
}

function cover(t, className, size = "small") {
  const img = el("img", className);
  img.alt = "";
  img.src = coverUrl(t, size);
  img.onerror = () => img.classList.add("broken");
  return img;
}

function minutesText(sec) {
  const min = sec / 60, hours = sec / 3600;
  if (hours >= 48) return `Это ${num(hours / 24)} ${word(Math.round(hours / 24), "сутки", "суток", "суток")} музыки без перерыва.`;
  if (hours >= 4) {
    const films = Math.round(hours / 2);
    return `Столько длятся ${num(films)} ${word(films, "фильм", "фильма", "фильмов")} подряд.`;
  }
  if (min >= 60) return "Хватит на долгую дорогу — и это только начало.";
  return "Хорошее начало — дальше будет больше.";
}

const PARTS = [
  { name: "Ночной слушатель", text: "Больше всего музыки — ночью, когда все спят." },
  { name: "Утренний слушатель", text: "Больше всего музыки — утром: так проще проснуться." },
  { name: "Дневной слушатель", text: "Больше всего музыки — днём, за делами." },
  { name: "Вечерний слушатель", text: "Больше всего музыки — вечером, когда дела позади." },
];

function slides(sum) {
  const { year, y, artists, tracks } = sum;
  const minutes = Math.round(y.total / 60);
  const list = [];

  // 1. Заставка
  list.push(() => {
    const box = el("div", "wr-slide wr-intro");
    box.append(line("div", "wr-kicker", "sono. · итоги", 0.1), line("div", "wr-year", String(year), 0.25),
      line("p", "wr-text", new Date().getFullYear() === year && new Date().getMonth() < 11
        ? "Ваш год в музыке — пока он ещё идёт." : "Ваш год в музыке.", 0.5));
    if (sum.from) box.append(line("p", "wr-note", `Sono считает с ${formatDay(sum.from)} — всё, что раньше, сюда не попало.`, 0.7));
    box.append(line("p", "wr-hint", "Нажмите, чтобы продолжить →", 1));
    return box;
  });

  // 2. Сколько слушали
  list.push(() => {
    const box = el("div", "wr-slide");
    const big = line("div", "wr-big", "", 0.25);
    countUp(big, minutes);
    box.append(line("div", "wr-kicker", "В этом году вы слушали", 0.1), big,
      line("div", "wr-unit", word(minutes, "минуту", "минуты", "минут") + " музыки", 0.35),
      line("p", "wr-text", minutesText(y.total), 0.7));
    if (sum.days > 1) {
      box.append(line("p", "wr-text wr-dim", `Музыка звучала ${sum.days} ${word(sum.days, "день", "дня", "дней")}`
        + (sum.streak > 2 ? `, а самая длинная серия — ${sum.streak} ${word(sum.streak, "день", "дня", "дней")} подряд.` : "."), 0.9));
    }
    return box;
  });

  // 3. Исполнитель года
  const top = artists[0];
  if (top) list.push(() => {
    const box = el("div", "wr-slide");
    const share = Math.round((top.sec / y.total) * 100);
    const photo = artistPic(top, "wr-in wr-photo");
    photo.style.setProperty("--d", "0.25s");
    box.append(line("div", "wr-kicker", "Ваш исполнитель года", 0.1), photo,
      line("div", "wr-name", top.name, 0.45),
      line("p", "wr-text", `${formatListen(top.sec)} · ${num(top.plays)} ${word(top.plays, "прослушивание", "прослушивания", "прослушиваний")}`, 0.6));
    if (share >= 5) box.append(line("p", "wr-text wr-dim", `Это ${share}% всей вашей музыки за год.`, 0.8));
    if (sum.fresh !== null && sum.topSince && sum.topSince >= new Date(year, 0, 1).getTime()) {
      box.append(line("p", "wr-text wr-dim", `А ведь эту музыку вы впервые включили только ${formatDay(sum.topSince)}.`, 0.95));
    }
    const open = line("button", "wr-link", "Открыть исполнителя", 1.1);
    open.type = "button";
    open.addEventListener("click", (e) => { e.stopPropagation(); close(); openArtist({ id: top.id, name: top.name }); });
    box.append(open);
    return box;
  });

  // 4. Топ-5 исполнителей
  if (artists.length >= 3) list.push(() => {
    const box = el("div", "wr-slide");
    const ol = el("ol", "wr-list");
    artists.slice(0, 5).forEach((a, i) => {
      const li = line("li", "wr-row", "", 0.25 + i * 0.12);
      const info = el("span", "wr-row-info");
      info.append(el("span", "wr-row-title", a.name), el("span", "wr-row-sub", formatListen(a.sec)));
      li.append(el("span", "wr-rank", String(i + 1)), artistPic(a, "wr-row-pic round"), info);
      ol.append(li);
    });
    box.append(line("div", "wr-kicker", "Ваши исполнители", 0.1), ol);
    return box;
  });

  // 5. Трек года
  const best = tracks[0];
  if (best) list.push(() => {
    const box = el("div", "wr-slide");
    const shown = displayTrack(best.t);
    const art = cover(best.t, "wr-in wr-cover", "large");
    art.style.setProperty("--d", "0.25s");
    const listen = line("button", "wr-play", "", 1);
    listen.type = "button";
    listen.innerHTML = icons.play;
    listen.append(el("span", "", "Послушать"));
    listen.addEventListener("click", (e) => { e.stopPropagation(); play(best.t, [best.t], 0); });
    box.append(line("div", "wr-kicker", "Ваш трек года", 0.1), art,
      line("div", "wr-name small", shown.title, 0.45), line("div", "wr-artist", shown.artist, 0.55),
      line("p", "wr-text", best.plays > 1
        ? `Вы включали его ${num(best.plays)} ${word(best.plays, "раз", "раза", "раз")} — ${formatListen(best.sec)}.`
        : `${formatListen(best.sec)} — больше, чем любой другой трек.`, 0.75), listen);
    return box;
  });

  // 6. Топ-5 треков
  if (tracks.length >= 3) list.push(() => {
    const box = el("div", "wr-slide");
    const ol = el("ol", "wr-list");
    tracks.slice(0, 5).forEach((t, i) => {
      const shown = displayTrack(t.t);
      const li = line("li", "wr-row", "", 0.25 + i * 0.12);
      const info = el("span", "wr-row-info");
      info.append(el("span", "wr-row-title", shown.title), el("span", "wr-row-sub", shown.artist));
      li.append(el("span", "wr-rank", String(i + 1)), cover(t.t, "wr-row-pic"), info,
        el("span", "wr-row-count", t.plays ? `${num(t.plays)}×` : ""));
      ol.append(li);
    });
    box.append(line("div", "wr-kicker", "Ваши треки", 0.1), ol);
    return box;
  });

  // 7. Ритм: месяцы и время суток
  const monthsKnown = y.months.filter((s) => s > 0).length;
  if (y.hours.some((h) => h > 0)) list.push(() => {
    const box = el("div", "wr-slide");
    const p = PARTS[sum.part];
    box.append(line("div", "wr-kicker", "Когда вы слушаете", 0.1), line("div", "wr-name", p.name, 0.25),
      line("p", "wr-text", p.text, 0.4));
    if (monthsKnown >= 2) {
      const chart = line("div", "wr-months", "", 0.6);
      const max = Math.max(...y.months, 1);
      y.months.forEach((sec, i) => {
        const col = el("span", `wr-month${i === sum.bestMonth.i ? " best" : ""}`);
        const bar = el("i");
        bar.style.setProperty("--h", `${Math.max(3, (sec / max) * 100)}%`);
        bar.style.setProperty("--d", `${0.7 + i * 0.04}s`);
        col.append(bar, el("b", "", MONTHS_SHORT[i]));
        chart.append(col);
      });
      box.append(chart, line("p", "wr-text wr-dim", `Ваш месяц — ${MONTHS[sum.bestMonth.i].toLowerCase()}: ${formatListen(sum.bestMonth.sec)}.`, 1.1));
    }
    return box;
  });

  // 8. Разнообразие
  list.push(() => {
    const box = el("div", "wr-slide");
    const nA = artists.length, nT = tracks.length;
    const share = top ? top.sec / y.total : 0;
    box.append(line("div", "wr-kicker", "Ваша музыка", 0.1),
      line("div", "wr-pair", "", 0.25));
    const pair = box.querySelector(".wr-pair");
    const a = el("span", "wr-pair-item"), t = el("span", "wr-pair-item");
    const aBig = el("b"), tBig = el("b");
    countUp(aBig, nA); countUp(tBig, nT);
    a.append(aBig, el("span", "", word(nA, "исполнитель", "исполнителя", "исполнителей")));
    t.append(tBig, el("span", "", word(nT, "трек", "трека", "треков")));
    pair.append(a);
    if (nT) pair.append(t);   // у статистики до «Итогов» треков нет — не пишем «0 треков»
    if (sum.fresh) box.append(line("p", "wr-text", `Новых для вас исполнителей за год — ${num(sum.fresh)}.`, 0.6));
    box.append(line("p", "wr-text wr-dim", share >= 0.3 && top
      ? `Вы верны любимым: ${Math.round(share * 100)}% времени — ${top.name}.`
      : nA >= 30 ? "Вы любите разное: ни один исполнитель не забрал себе весь год."
        : "У вас свой круг — и он понемногу растёт.", 0.8));
    return box;
  });

  // 9. Итог: всё на одной карточке + плейлист
  list.push(() => {
    const box = el("div", "wr-slide wr-final");
    const grid = line("div", "wr-grid", "", 0.2);
    const cell = (label, value) => { const c = el("div", "wr-cell"); c.append(el("span", "", label), el("b", "", value)); return c; };
    grid.append(cell("Минут музыки", num(minutes)), cell("Исполнитель года", top?.name ?? "—"),
      ...(best ? [cell("Трек года", displayTrack(best.t).title)] : []),
      y.hours.some((h) => h > 0) ? cell("Вы", PARTS[sum.part].name) : cell("Исполнителей", num(artists.length)));
    const actions = line("div", "wr-actions", "", 0.6);
    const picks = tracks.slice(0, 50).map((t) => t.t);
    if (picks.length >= 3) {
      const save = el("button", "wr-btn primary", `Сохранить «Топ-треки ${year}»`);
      save.type = "button";
      save.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = `Топ-треки ${year}`;
        const p = lib.playlists.find((x) => x.name === name) ?? createPlaylist(name, picks);
        toast(`Плейлист «${name}» — в медиатеке`);
        close();
        openView(`playlist:${p.id}`);
      });
      const listen = el("button", "wr-btn", "Включить");
      listen.type = "button";
      listen.addEventListener("click", (e) => { e.stopPropagation(); play(picks[0], picks, 0); toast(`Играют ваши топ-треки ${year}`); });
      actions.append(save, listen);
    }
    const again = el("button", "wr-btn ghost", "Сначала");
    again.type = "button";
    again.addEventListener("click", (e) => { e.stopPropagation(); go(0); });
    actions.append(again);
    box.append(line("div", "wr-kicker", `Ваш ${year}`, 0.1), grid, actions);
    return box;
  });
  return list;
}

// ---------- Показ ----------

let ui = null;

function go(i) {
  if (!ui || i < 0 || i >= ui.slides.length) return;
  ui.i = i;
  const node = ui.slides[i]();
  ui.card.style.setProperty("--wr-bg", COLORS[i % COLORS.length]);
  ui.stage.replaceChildren(node);
  ui.bars.forEach((b, k) => b.classList.toggle("done", k <= i));
}

function close() {
  if (!ui) return;
  const { root } = ui;
  ui = null;
  removeEventListener("keydown", onKey, true);
  document.body.classList.remove("wrapped-open");
  root.classList.add("leaving");
  setTimeout(() => root.remove(), motionOff() ? 0 : 250);
}

function onKey(e) {
  if (!ui) return;
  if (e.key === "Escape") close();
  else if (e.key === "ArrowRight" || e.key === "Enter") go(ui.i + 1);
  else if (e.key === "ArrowLeft") go(ui.i - 1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

export function openWrapped(year) {
  if (!hasWrapped(year)) { toast("Пока мало музыки для итогов — послушайте ещё немного"); return; }
  close();
  const list = slides(summary(year));
  const root = el("div", "wrapped");
  const card = el("div", "wr-card");
  const top = el("div", "wr-top");
  const bars = list.map(() => el("i", "wr-bar"));
  const progress = el("div", "wr-progress");
  progress.append(...bars);
  const x = el("button", "wr-close");
  x.type = "button";
  x.setAttribute("aria-label", "Закрыть");
  x.innerHTML = icons.close;
  x.addEventListener("click", (e) => { e.stopPropagation(); close(); });
  top.append(progress, x);
  const stage = el("div", "wr-stage");
  const grain = el("div", "wr-grain");
  card.append(grain, top, stage);
  root.append(card);
  // Щелчок по правой части — дальше, по левой трети — назад; мимо карточки — закрыть
  card.addEventListener("click", (e) => {
    if (e.target.closest("button, a")) return;
    const r = card.getBoundingClientRect();
    go(e.clientX - r.left < r.width / 3 ? ui.i - 1 : ui.i + 1);
  });
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  document.body.append(root);
  ui = { root, card, stage, bars, slides: list, i: 0 };
  addEventListener("keydown", onKey, true);
  document.body.classList.add("wrapped-open");
  go(0);
}

/** Кнопка для экрана статистики: «Итоги 2026» */
export function wrappedButton() {
  const year = wrappedSeason() ?? new Date().getFullYear();
  if (!hasWrapped(year)) return null;
  const b = el("button", "wr-open-btn");
  b.type = "button";
  b.append(el("span", "", `Итоги ${year}`));
  b.insertAdjacentHTML("beforeend", icons.chevron);
  b.addEventListener("click", () => openWrapped(year));
  return b;
}

/** Карточка на «Главной» (декабрь и январь) */
export function wrappedCard() {
  const year = wrappedSeason();
  if (!year || !hasWrapped(year)) return null;
  const card = el("button", "wr-home-card");
  card.type = "button";
  card.append(el("span", "wr-home-kicker", "Готово"), el("span", "wr-home-title", `Ваш ${year} в музыке`),
    el("span", "wr-home-sub", "Исполнитель и трек года, сколько вы слушали и когда"));
  card.addEventListener("click", () => openWrapped(year));
  return card;
}
