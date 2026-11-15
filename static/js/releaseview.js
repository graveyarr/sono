// Карточка новинки (ряд на «Главной» и экран «Новинки») и сам экран «Новинки» (кнопка «Все» у ряда).
// Данные — releases.js: сначала Яндекс, потом SoundCloud тех же исполнителей и «Из ваших любимых».

import { load, picture, section } from "./artist.js";
import { icons, sourceIcons } from "./icons.js";
import { openView } from "./nav.js";
import { play } from "./player.js";
import { releasesAsked, watchReleases } from "./releases.js";
import { el, plural } from "./ui.js";

const TYPE_NAMES = { album: "Альбом", single: "Сингл", ep: "EP", compilation: "Сборник", track: "Трек" };
const dayText = (date) => (date ? new Date(date).toLocaleDateString("ru", { day: "numeric", month: "long" }) : "");
const CONTEXT = { type: "releases", id: "sc", name: "Новинки" };

/** Включить новинку: трек SoundCloud — сразу (дальше — остальные треки из списка), релиз — с первого трека */
async function playRelease(r, list) {
  if (r.track) {
    const tracks = list.filter((x) => x.track).map((x) => x.track);
    return play(r.track, tracks, tracks.indexOf(r.track), CONTEXT);
  }
  try {
    const album = await load(`/api/album/${r.id}`);
    if (album.tracks.length) play(album.tracks[0], album.tracks.slice(), 0, { type: "album", id: album.id, name: album.title });
  } catch {}
}

/** Карточка: обложка (значок SoundCloud, пометка «Из ваших любимых»), название, «исполнитель · 12 ноября».
 *  list — соседние карточки (очередь для треков SoundCloud); markFav: false — когда в ряду все «из любимых» */
export function releaseCard(r, list, { markFav = true } = {}) {
  const card = el("button", "home-card release-card");
  card.type = "button";
  const art = picture(r.cover, "home-card-art", r.title);
  const playBtn = el("span", "tile-play");
  playBtn.innerHTML = icons.play;
  playBtn.title = "Слушать";
  playBtn.addEventListener("click", (e) => { e.stopPropagation(); playRelease(r, list); });
  art.append(playBtn);
  const fromSc = r.source === "soundcloud";
  if (fromSc) {
    const badge = el("span", "release-src");
    badge.innerHTML = sourceIcons.soundcloud;
    art.append(badge);
  }
  if (r.fav && markFav) art.append(el("span", "release-fav", "Из ваших любимых"));
  card.append(art, el("span", "home-card-title", r.title),
    el("span", "home-card-artist", [r.artist, dayText(r.date)].filter(Boolean).join(" · ")));
  card.title = [`${r.artist} — ${r.title}`, TYPE_NAMES[r.type] ?? "Альбом", fromSc && "с SoundCloud",
    r.fav && "из ваших любимых"].filter(Boolean).join(" · ");
  if (r.track) card.addEventListener("click", () => playRelease(r, list));   // трек SoundCloud — сразу играет
  else {
    card.dataset.warm = `album:${r.id}`;
    card.addEventListener("click", () => openView(`album:${r.id}`));
  }
  return card;
}

// ---------- Экран «Новинки» ----------

const FILTERS = [
  ["all", "Всё", () => true],
  ["albums", "Альбомы", (r) => r.type === "album" || r.type === "compilation"],
  ["singles", "Синглы и EP", (r) => r.type === "single" || r.type === "ep" || r.type === "track"],
  ["sc", "SoundCloud", (r) => r.source === "soundcloud"],
];
let filter = "all";   // помним, пока работает программа

export function renderReleases(box, stillHere) {
  const head = el("div", "nr-head");
  const meta = el("div", "pl-meta", "Ищу новинки…");
  head.append(el("div", "pl-kind", "За последние 3 месяца"), el("h1", "pl-name", "Новинки"), meta);
  const tabs = el("div", "seg meta-tabs nr-tabs");
  const status = el("p", "tp-loading nr-status");
  const groups = el("div", "nr-groups");
  const page = el("div", "nr-page");
  page.append(head, tabs, status, groups);
  box.replaceChildren(page);

  let list = [];
  const draw = () => {
    const counts = Object.fromEntries(FILTERS.map(([id, , fits]) => [id, list.filter(fits).length]));
    if (!counts[filter]) filter = "all";
    tabs.replaceChildren();
    tabs.hidden = !list.length;
    for (const [id, label] of FILTERS) {
      if (id !== "all" && !counts[id]) continue;
      const tab = el("button", `seg-btn${id === filter ? " on" : ""}`, id === "all" ? label : `${label} · ${counts[id]}`);
      tab.type = "button";
      tab.addEventListener("click", () => { filter = id; draw(); });
      tabs.append(tab);
    }
    const shown = list.filter(FILTERS.find(([id]) => id === filter)[2]);
    const onlyFav = shown.length > 0 && shown.every((r) => r.fav);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const parts = [["На этой неделе", shown.filter((r) => (r.date || "") >= weekAgo)],
      ["Раньше", shown.filter((r) => (r.date || "") < weekAgo)]];
    groups.replaceChildren(...parts.filter(([, items]) => items.length).map(([title, items]) => {
      const grid = el("div", "release-grid");
      grid.append(...items.map((r) => releaseCard(r, shown, { markFav: !onlyFav })));
      return section(title, grid);
    }));
    if (list.length && list.every((r) => r.fav)) {
      groups.append(el("p", "nr-note", "Здесь — новинки исполнителей, которых вы часто слушаете. Подпишитесь "
        + "на странице исполнителя (кнопка «Подписаться») — и его новые релизы всегда будут здесь."));
    } else if (list.some((r) => r.fav)) {
      groups.append(el("p", "nr-note", "«Из ваших любимых» — исполнители, которых вы часто слушаете, но на которых не подписаны. "
        + "Подпишитесь на странице исполнителя — его новинки всегда будут здесь."));
    }
  };

  watchReleases((got, all) => {
    if (!stillHere()) return;
    list = got;
    status.textContent = all ? "" : "Ищу ещё на SoundCloud…";
    status.hidden = all;
    if (list.length) meta.textContent = plural(list.length, "релиз", "релиза", "релизов");
    else if (all) meta.textContent = "";
    draw();
    if (all && !list.length) {
      groups.replaceChildren(el("p", "nr-empty", releasesAsked()
        ? "За последние три месяца у ваших исполнителей ничего нового не вышло."
        : "Подпишитесь на исполнителей (кнопка «Подписаться» на их странице) — их новые альбомы и треки будут здесь."));
    }
  });
}
