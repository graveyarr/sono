// «Живая обложка» (ПК): экран плейлиста, «Избранного» и альбома — слева стеклянная карточка (обложка, название,
// кнопки с подписями, строка «все треки открываются»), справа список с колонками. Макет —
// design/ui-new/B-ekrany.html (#playlist, #album). Здесь — общие кусочки для views.js и artist.js
// (модуль без зависимостей от экранов: только ui.js и icons.js).

import { icons } from "./icons.js";
import { el } from "./ui.js";

/** Колонки «Альбом» и «Добавлен» — только если они заполнены хотя бы у четверти песен.
    Иначе колонка стоит пустой (у большинства треков с YouTube/SoundCloud альбома нет) — «метр пустоты» */
export function listColumns(tracks) {
  const n = tracks.length || 1;
  const share = (f) => tracks.filter(f).length / n;
  return { album: share((t) => t.album) >= 0.25, added: share((t) => t.added) >= 0.25 };
}

/** Каркас экрана: карточка слева, список справа */
export function plLayout(card, ...right) {
  const page = el("div", "pl-live");
  const main = el("div", "pl-main");
  main.append(...right.filter(Boolean));
  page.append(card, main);
  return page;
}

/** Карточка: { cover, kind, name (узел), meta (строка или узел), desc, acts, minis, extra, status } */
export function plCard({ cover, kind, name, meta, desc, acts = [], minis = [], extra = [], status = null }) {
  const card = el("aside", "pl-card glass");
  cover.classList.add("pl-cover");
  const side = el("div", "pl-side");   // всё, кроме обложки: в узком окне — колонкой справа от неё
  const text = el("div", "pl-text");
  text.append(el("div", "pl-kind", kind), name);
  if (meta) {
    const line = el("div", "pl-meta");
    line.append(meta);
    text.append(line);
  }
  side.append(text);
  if (desc) side.append(el("div", "pl-desc", desc));
  if (acts.length) {
    const row = el("div", "pl-acts");
    row.append(...acts);
    side.append(row);
  }
  const shownMinis = minis.filter(Boolean);
  if (shownMinis.length) {
    const row = el("div", "pl-minis");
    row.style.setProperty("--n", shownMinis.length);
    row.append(...shownMinis);
    side.append(row);
  }
  side.append(...extra.filter(Boolean));
  if (status) side.append(status);
  card.append(cover, side);
  return card;
}

/** Большая кнопка-пилюля («Играть», «Вперемешку», «В медиатеку») */
export function bigPill(label, icon, onClick, solid = false) {
  const b = el("button", `pill big${solid ? " solid" : ""}`);
  b.type = "button";
  b.innerHTML = `${icon}<span>${label}</span>`;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/** «Играть» ⇄ «Пауза» (класс .is-playing ставит views.js → syncPlayButtons по data-collection) */
export function playPill(collection, onClick) {
  const b = el("button", "pill big solid pl-play");
  b.type = "button";
  b.dataset.collection = collection;
  b.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`
    + `<span class="l-play">Играть</span><span class="l-pause">Пауза</span>`;
  b.addEventListener("click", onClick);
  return b;
}

/** Маленькая кнопка с подписью под значком (Flow, Скачать, Поделиться, Ещё) */
export function miniBtn(label, icon, onClick, cls = "") {
  const b = el("button", `pl-mini ${cls}`.trim());
  b.type = "button";
  b.innerHTML = `${icon}<span class="pl-mini-l"></span>`;
  b.querySelector(".pl-mini-l").textContent = label;
  if (onClick) b.addEventListener("click", (e) => onClick(e.currentTarget));
  return b;
}

/** Строка внизу карточки: точка (ok — зелёная, bad — оранжевая, без — серая) и текст */
export function statusLine(text, tone = "", onClick = null) {
  const line = el(onClick ? "button" : "div", `pl-status ${tone}`.trim());
  if (onClick) {
    line.type = "button";
    line.addEventListener("click", onClick);
  }
  line.append(el("i"), el("span", "", text));
  return line;
}

/** Подписи колонок (те же колонки, что у строк trackRow({ cols })) */
export function liveHead(cols, { removable = false } = {}) {
  const head = el("div", "tl-head");
  head.innerHTML = `<span class="t-num">#</span><span class="h-title">Название</span>`
    + (cols.album ? `<span class="t-album">Альбом</span>` : "")
    + (cols.added ? `<span class="t-added">Добавлен</span>` : "")
    + `<span class="t-plays" title="Сколько раз слушали на YouTube/SoundCloud">Прослуш.</span><span class="h-btn"></span>`
    + `<span class="t-dur" title="Длительность">${icons.clock}</span>`
    + (removable ? '<span class="h-btn"></span>' : "") + `<span class="h-btn"></span>`;
  return head;
}

/** Класс списка по колонкам — от него зависит раскладка строк в CSS */
export const colsClass = (cols, removable = false) =>
  `tl-live${cols.album ? "" : " no-album"}${cols.added ? "" : " no-added"}${removable ? " removable" : ""}`;
