// Экран «Новинки» на ПК («Живая обложка», макет design/ui-new/B-ekrany.html#releases).
// Шапка: «За последние 3 месяца · от ваших исполнителей», «Новинки», переключатель Всё | Альбомы | Синглы и EP |
// SoundCloud с числами, «За кем следить». Ниже: «На этой неделе» — большие карточки со «Слушать» и «В медиатеку»,
// «Раньше» — по месяцам: плитка месяца и его релизы. Данные — releases.js; на телефоне — прежний экран (releaseview.js).

import { toggleLike } from "./actions.js";
import { load, picture, saveAlbumCopy, savedCopy } from "./artist.js";
import { headRow, segment } from "./artistlive.js";
import { icons } from "./icons.js";
import { followedArtists, isLiked } from "./library.js";
import { openView } from "./nav.js";
import { RELEASE_TYPES, playRelease, releaseCard, releaseDay } from "./releaseview.js";
import { isHeard, releasesAsked, watchReleases, weekAgo } from "./releases.js";
import { el, openMenu, plural, toast } from "./ui.js";

const FILTERS = [
  ["all", "Всё", () => true],
  ["albums", "Альбомы", (r) => r.type === "album" || r.type === "compilation"],
  ["singles", "Синглы и EP", (r) => r.type === "single" || r.type === "ep" || r.type === "track"],
  ["sc", "SoundCloud", (r) => r.source === "soundcloud"],
];
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
let filter = "all";   // помним, пока работает программа

function pill(label, icon, onClick, cls = "") {
  const b = el("button", `pill ${cls}`.trim());
  b.type = "button";
  b.innerHTML = `${icon}<span>${label}</span>`;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
  return b;
}

/** «В медиатеку»: трек SoundCloud — в «Избранное», альбом — копией-плейлистом; уже есть — «В медиатеке» */
function saveButton(r) {
  const b = pill("В медиатеку", icons.plus, async () => {
    if (r.track) { toggleLike(r.track); return draw(); }
    const have = savedCopy({ id: r.id });
    if (have) return openView(`playlist:${have.id}`);
    b.disabled = true;
    try {
      const al = await load(`/api/album/${r.id}`);
      if (!al.tracks?.length) throw new Error("пусто");
      saveAlbumCopy(al);
    } catch {
      toast("Не получилось загрузить релиз — попробуйте ещё раз", { error: true });
    }
    b.disabled = false;
    draw();
  });
  const draw = () => {
    const have = r.track ? isLiked(r.track) : !!savedCopy({ id: r.id });
    b.innerHTML = `${have ? icons.check : icons.plus}<span>${have ? (r.track ? "В избранном" : "В медиатеке") : "В медиатеку"}</span>`;
    b.classList.toggle("on", have);
    b.title = have ? (r.track ? "Убрать из «Избранного»" : "Открыть копию в медиатеке") : r.track ? "В «Избранное»" : "Сохранить плейлистом в медиатеку";
  };
  draw();
  return b;
}

/** Большая карточка «На этой неделе» */
function weekCard(r, list) {
  const card = el("div", "nr-wk glass");
  const fromSc = r.source === "soundcloud";
  const text = el("div", "nr-wk-text");
  const kind = RELEASE_TYPES[r.type] ?? "Альбом";
  text.append(el("span", "ar-badge", fromSc ? `${kind} · SoundCloud` : kind), el("b", "", r.title),
    el("span", "nr-wk-sub", [r.artist, releaseDay(r.date)].filter(Boolean).join(" · ")));
  if (r.fav) text.append(el("span", "nr-wk-fav", "Из ваших любимых"));
  const acts = el("div", "nr-wk-acts");
  acts.append(pill("Слушать", icons.play, () => playRelease(r, list), "solid"), saveButton(r));
  text.append(acts);
  card.append(picture(r.cover, "nr-wk-art", r.title), text);
  card.title = `${r.artist} — ${r.title}`;
  if (r.track) card.addEventListener("click", () => playRelease(r, list));
  else {
    card.dataset.warm = `album:${r.id}`;
    card.addEventListener("click", () => openView(`album:${r.id}`));
  }
  return card;
}

/** Плитка месяца в «Раньше»: «Октябрь · 3 релиза» */
function monthTile(ym, count) {
  const [y, m] = ym.split("-").map(Number);
  const tile = el("div", "nr-month glass");
  const name = m ? MONTHS[m - 1] + (y !== new Date().getFullYear() ? ` ${y}` : "") : "Раньше";
  tile.append(el("b", "", name), el("span", "", plural(count, "релиз", "релиза", "релизов")));
  return tile;
}

/** «За кем следить»: исполнители с подпиской — переход на их страницу */
function openFollows(anchor) {
  const list = followedArtists();
  const items = list.length ? list.map((a) => ({ label: a.name, icon: icons.mic, action: () => openView(`artist:${a.id}`) }))
    : [{ label: "Пока ни за кем — нажмите «Следить за новинками» на странице исполнителя", icon: icons.bell, disabled: true }];
  openMenu(anchor, items);
}

export function renderReleasesLive(box, stillHere) {
  const root = el("div", "nr-live");
  const head = el("div", "live-hd");
  const left = el("div", "live-hd-l");
  left.append(el("div", "live-kick", "За последние 3 месяца · от ваших исполнителей"), el("h1", "live-h1", "Новинки"));
  const segBox = el("div", "nr-seg");
  const follow = pill("За кем следить", icons.bell, (b) => openFollows(b), "nr-follow");
  head.append(left, el("span", "sp"), segBox, follow);
  const status = el("p", "tp-loading nr-status", "Ищу новинки…");
  const body = el("div", "nr-body");
  root.append(head, status, body);
  box.replaceChildren(root);

  let list = [], all = false;
  const draw = () => {
    if (!stillHere() || !root.isConnected) return;
    const counts = Object.fromEntries(FILTERS.map(([id, , fits]) => [id, list.filter(fits).length]));
    if (!counts[filter]) filter = "all";
    const options = FILTERS.filter(([id]) => id === "all" || counts[id]).map(([id, label]) => [label, id]);
    const seg = segment(options, filter, (v) => { filter = v; draw(); });
    seg.querySelectorAll(".seg-btn").forEach((b) => b.append(el("small", "", String(counts[b.dataset.value]))));
    segBox.replaceChildren(...(list.length && options.length > 1 ? [seg] : []));

    const shown = list.filter(FILTERS.find(([id]) => id === filter)[2]);
    const onlyFav = shown.length > 0 && shown.every((r) => r.fav);
    const since = weekAgo();
    const week = shown.filter((r) => (r.date || "") >= since);
    const earlier = shown.filter((r) => (r.date || "") < since);
    const parts = [];
    if (week.length) {
      const fresh = week.filter((r) => !isHeard(r)).length;
      const grid = el("div", "nr-week");
      grid.append(...week.map((r) => weekCard(r, shown)));
      const sec = el("section", "meta-section nr-sec");
      sec.append(headRow("На этой неделе", fresh
        ? el("span", "live-h-sub", `${plural(fresh, "новый", "новых", "новых")} — значок у «Новинок» пропадёт, когда послушаете`)
        : el("span", "live-h-sub", "всё уже послушано")), grid);
      parts.push(sec);
    }
    if (earlier.length) {
      const grid = el("div", "nr-grid");
      const months = new Map();
      for (const r of earlier) {
        const ym = (r.date || "").slice(0, 7);
        if (!months.has(ym)) months.set(ym, []);
        months.get(ym).push(r);
      }
      for (const [ym, items] of months) {
        grid.append(monthTile(ym, items.length), ...items.map((r) => releaseCard(r, shown, { markFav: !onlyFav, live: true })));
      }
      const sec = el("section", "meta-section nr-sec");
      sec.append(headRow("Раньше", el("span", "live-h-sub", "по месяцам")), grid);
      parts.push(sec);
    }
    if (list.length && list.every((r) => r.fav)) {
      parts.push(el("p", "nr-note", "Здесь — новинки исполнителей, которых вы часто слушаете. Нажмите «Следить за новинками» "
        + "на странице исполнителя — и его новые релизы всегда будут здесь."));
    } else if (list.some((r) => r.fav)) {
      parts.push(el("p", "nr-note", "«Из ваших любимых» — исполнители, которых вы часто слушаете, но за которыми не следите. "
        + "Нажмите «Следить за новинками» на странице исполнителя — его новинки всегда будут здесь."));
    }
    if (all && !list.length) {
      parts.push(el("section", "nr-empty-box glass", releasesAsked()
        ? "За последние три месяца у ваших исполнителей ничего нового не вышло."
        : "Нажмите «Следить за новинками» на странице исполнителя — его новые альбомы и треки будут здесь."));
    }
    body.replaceChildren(...parts);
  };

  watchReleases((got, done) => {
    if (!stillHere()) return;
    list = got;
    all = done;
    status.textContent = done ? "" : list.length ? "Ищу ещё на SoundCloud…" : "Ищу новинки…";
    status.hidden = done;
    draw();
  });
  // Послушали новинку — подпись «N новых» обновится
  const onHeard = () => { if (!root.isConnected) return document.removeEventListener("sono:releases", onHeard); draw(); };
  document.addEventListener("sono:releases", onHeard);
}
