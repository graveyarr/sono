// Страницы исполнителя и альбома. Данные — с сервера (/api/artist, /api/album: Яндекс Музыка + Deezer).
// Треки здесь «из базы» (source: "meta"): при включении плеер сам найдёт им пару на YouTube/SoundCloud.

import { openTrackMenu, toggleLike } from "./actions.js";
import { startFlow } from "./flow.js";
import { icons } from "./icons.js";
import { openView } from "./nav.js";
import { isPlaying, play, prefetch, state, togglePlay } from "./player.js";
import { compactNumber, countText, el, formatTotal, iconButton, imageHsl, imgUrl, markCurrentRows, nameHue, plural, trackRow } from "./ui.js";
import { keyOf } from "./library.js";
import { artistStatsLine } from "./stats.js";

const cache = new Map();   // адрес → ответ сервера (на время работы программы)

async function load(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Не нашлось");
  cache.set(url, data);
  return data;
}

const TYPE_NAMES = { album: "Альбом", single: "Сингл", ep: "EP", compilation: "Сборник" };
const contextKey = (ctx) => `${ctx.type}:${ctx.id}`;
const playingFrom = (ctx) => !!state.current && state.context && contextKey(state.context) === contextKey(ctx);

// ---------- Общие кусочки ----------

/** Цвет шапки — по картинке (фото исполнителя или обложка) */
function paintHero(hero, url, fallbackName) {
  hero.style.setProperty("--hero", `hsl(${nameHue(fallbackName || "")} 40% 30%)`);
  if (!url) return;
  const img = new Image();
  img.src = url;
  img.decode().then(() => {
    const [h, s] = imageHsl(img);
    hero.style.setProperty("--hero", `hsl(${h.toFixed(0)} ${Math.min(Math.max(s, 25), 70).toFixed(0)}% 32%)`);
  }).catch(() => {});
}

/** Картинка или заглушка с нотой (у релизов из Deezer обложек нет) */
function picture(url, className, name = "") {
  const box = el("div", className);
  if (url) {
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = imgUrl(url);
    img.onerror = () => { img.remove(); box.classList.add("no-image"); box.innerHTML = icons.note; };
    box.append(img);
  } else {
    box.classList.add("no-image");
    const hue = nameHue(name);
    box.style.background = `linear-gradient(135deg, hsl(${hue} 40% 30%), hsl(${(hue + 40) % 360} 45% 16%))`;
    box.innerHTML = icons.note;
  }
  return box;
}

/** Кнопки «Слушать» и «Перемешать» для списка треков */
function playButtons(tracks, context) {
  const actions = el("div", "pl-actions");
  const playBtn = el("button", "play big-play");
  playBtn.type = "button";
  playBtn.dataset.collection = contextKey(context);
  playBtn.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`;
  playBtn.disabled = !tracks.length;
  playBtn.classList.toggle("is-playing", playingFrom(context) && isPlaying());
  playBtn.addEventListener("click", () => (playingFrom(context) ? togglePlay() : play(tracks[0], tracks.slice(), 0, context)));
  playBtn.addEventListener("mouseenter", () => prefetch(tracks[0]));
  const shuffle = iconButton(icons.shuffle, "Перемешать и слушать");
  shuffle.disabled = tracks.length < 2;
  shuffle.addEventListener("click", () => {
    const i = Math.floor(Math.random() * tracks.length);
    play(tracks[i], [tracks[i], ...tracks.filter((_, n) => n !== i).sort(() => Math.random() - 0.5)], 0, context);
  });
  actions.append(playBtn, shuffle);
  return actions;
}

function trackList(tracks, context, limit = tracks.length) {
  const card = el("div", "tracklist-card");
  const list = el("ol", "tracklist");
  tracks.slice(0, limit).forEach((track, i) => {
    const row = trackRow(track, {
      index: i, numbered: true,
      onPlay: () => play(track, tracks.slice(), i, context),
      onLike: toggleLike,
      onMenu: (anchor) => openTrackMenu(anchor, track, {}),
    });
    row.addEventListener("mouseenter", () => prefetch(track));   // пока ведут курсор — ищем пару и готовим звук
    list.append(row);
  });
  card.append(list);
  return card;
}

function section(title, ...children) {
  const s = el("section", "meta-section");
  s.append(el("h2", "meta-h", title), ...children);
  return s;
}

// ---------- Страница исполнителя ----------

export async function renderArtist(box, id, stillHere) {
  box.replaceChildren(el("p", "meta-loading", "Загружаю исполнителя…"));
  let a;
  try {
    a = await load(`/api/artist/${id}`);
  } catch (err) {
    if (stillHere()) box.replaceChildren(el("p", "pl-empty", `Не получилось открыть исполнителя: ${err.message}`));
    return;
  }
  if (!stillHere()) return;
  const context = { type: "artist", id: a.id, name: a.name };

  // Шапка: круглое фото, имя, лайки
  const hero = el("div", "pl-hero artist-hero");
  const header = el("header", "pl-header");
  const info = el("div", "pl-info");
  const facts = [a.likes ? countText(a.likes, "лайк", "лайка", "лайков") : "",
    a.tracksTotal ? plural(a.tracksTotal, "трек", "трека", "треков") : ""].filter(Boolean).join(" · ");
  info.append(el("div", "pl-kind", "Исполнитель"), el("h1", "pl-name", a.name));
  // Слушатели за месяц (Яндекс Музыка) — крупно, как в Spotify; рядом — стало больше или меньше
  if (a.listeners) {
    const line = el("div", "artist-listeners");
    const [num, ...word] = countText(a.listeners, "слушатель", "слушателя", "слушателей").split(" ");
    const big = a.listeners >= 1e4;   // «4,8 млн» — число из двух слов
    line.append(el("b", "", big ? `${num} ${word.shift()}` : num), ` ${word.join(" ")} за месяц`);
    if (a.listenersDelta && a.listeners) {
      const pct = (a.listenersDelta / (a.listeners - a.listenersDelta)) * 100;
      if (Math.abs(pct) >= 0.5) {
        const trend = el("span", `artist-trend ${pct > 0 ? "up" : "down"}`, `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`);
        trend.title = `${pct > 0 ? "+" : "−"}${compactNumber(Math.abs(a.listenersDelta))} за месяц`;
        line.append(trend);
      }
    }
    line.title = "По данным Яндекс Музыки";
    info.append(line);
  }
  info.append(el("div", "pl-meta", facts + (facts ? " · Яндекс Музыка" : "")));
  // Сколько вы сами слушаете этого исполнителя и с какого дня
  const mine = artistStatsLine({ id: a.id, name: a.name });
  if (mine) info.append(el("div", "artist-mine", mine));
  header.append(picture(a.pictureLarge, "artist-photo", a.name), info);
  const actions = playButtons(a.top, context);
  // Flow по исполнителю: он сам и похожие на него — бесконечно
  const flowBtn = el("button", "flow-pill");
  flowBtn.type = "button";
  flowBtn.innerHTML = `${icons.flow}<span>Flow</span>`;
  flowBtn.title = `Бесконечный поток: ${a.name} и похожие`;
  flowBtn.addEventListener("click", () => startFlow({ artist: { id: a.id, name: a.name } }));
  actions.append(flowBtn);
  hero.append(header, actions);
  paintHero(hero, a.pictureLarge && imgUrl(a.pictureLarge), a.name);

  const body = el("div", "pl-body");

  // Популярные треки: 5, по кнопке — все
  if (a.top.length) {
    const holder = el("div");
    let shown = 5;
    const draw = () => {
      holder.replaceChildren(trackList(a.top, context, shown));
      if (a.top.length > 5) {
        const more = el("button", "meta-more", shown < a.top.length ? "Ещё" : "Свернуть");
        more.type = "button";
        more.addEventListener("click", () => { shown = shown < a.top.length ? a.top.length : 5; draw(); });
        holder.append(more);
      }
      markCurrentRows(state.current ? keyOf(state.current) : null);
    };
    draw();
    body.append(section("Популярные треки", holder));
  }

  // Дискография: вкладки «Альбомы» / «Синглы и EP»
  const albums = a.releases.filter((r) => r.type === "album" || r.type === "compilation");
  const singles = a.releases.filter((r) => r.type === "single" || r.type === "ep");
  if (a.releases.length) {
    const grid = el("div", "release-grid");
    const tabs = el("div", "seg meta-tabs");
    const showTab = (list) => grid.replaceChildren(...list.map(releaseCard));
    for (const [label, list] of [[`Альбомы · ${albums.length}`, albums], [`Синглы и EP · ${singles.length}`, singles]]) {
      if (!list.length) continue;
      const tab = el("button", "seg-btn", label);
      tab.type = "button";
      tab.addEventListener("click", () => {
        tabs.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b === tab));
        showTab(list);
      });
      tabs.append(tab);
    }
    tabs.firstElementChild?.classList.add("on");
    showTab(albums.length ? albums : singles);
    body.append(section("Дискография", tabs, grid));
  }

  // Похожие исполнители
  if (a.related.length) {
    const grid = el("div", "artist-grid");
    for (const r of a.related) {
      const card = el("button", "artist-card");
      card.type = "button";
      card.append(picture(r.picture, "artist-card-photo", r.name), el("span", "artist-card-name", r.name));
      card.addEventListener("click", () => openView(`artist:${r.id}`));
      grid.append(card);
    }
    body.append(section("Похожие исполнители", grid));
  }

  // Биография (свёрнутая)
  if (a.bio) {
    const text = el("p", "meta-bio collapsed", a.bio);
    const toggle = el("button", "meta-more", "Читать полностью");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      const open = text.classList.toggle("collapsed");
      toggle.textContent = open ? "Читать полностью" : "Свернуть";
    });
    body.append(section("Об исполнителе", text, toggle));
  }

  box.replaceChildren(hero, body);
  prefetchTop(a.top, stillHere);
}

/** Открыли страницу — готовим два первых трека (найти пару на YouTube/SoundCloud и начало звука), по одному */
function prefetchTop(tracks, stillHere) {
  setTimeout(async () => {
    for (const t of tracks.slice(0, 2)) {
      if (!stillHere()) return;
      await prefetch(t);
    }
  }, 500);
}

function releaseCard(r) {
  const card = el("button", "home-card release-card");
  card.type = "button";
  const art = picture(r.cover, "home-card-art", r.title);
  const playBtn = el("span", "tile-play");
  playBtn.innerHTML = icons.play;
  playBtn.title = "Слушать";
  playBtn.addEventListener("click", async (e) => {   // включить релиз прямо из сетки
    e.stopPropagation();
    try {
      const album = await load(`/api/album/${r.id}`);
      if (album.tracks.length) play(album.tracks[0], album.tracks.slice(), 0, { type: "album", id: album.id, name: album.title });
    } catch {}
  });
  art.append(playBtn);
  card.append(art, el("span", "home-card-title", r.title),
    el("span", "home-card-artist", [r.year, TYPE_NAMES[r.type] ?? "Альбом"].filter(Boolean).join(" · ")));
  card.title = r.title;
  card.addEventListener("click", () => openView(`album:${r.id}`));
  return card;
}

// ---------- Страница альбома ----------

export async function renderAlbum(box, id, stillHere) {
  box.replaceChildren(el("p", "meta-loading", "Загружаю альбом…"));
  let al;
  try {
    al = await load(`/api/album/${id}`);
  } catch (err) {
    if (stillHere()) box.replaceChildren(el("p", "pl-empty", `Не получилось открыть альбом: ${err.message}`));
    return;
  }
  if (!stillHere()) return;
  const context = { type: "album", id: al.id, name: al.title };

  const hero = el("div", "pl-hero");
  const header = el("header", "pl-header");
  const info = el("div", "pl-info");
  const artistLink = el("button", "meta-artist-link", al.artist.name || "");
  artistLink.type = "button";
  artistLink.addEventListener("click", () => {
    if (al.artist.id) openView(`artist:${al.artist.id}`);
  });
  const facts = el("div", "pl-meta");
  facts.append(artistLink, document.createTextNode(
    [" ", al.year, al.tracks.length ? plural(al.tracks.length, "трек", "трека", "треков") : "", al.tracks.length ? formatTotal(al.tracks) : "",
      al.likes ? `${countText(al.likes, "лайк", "лайка", "лайков")} в Яндекс Музыке` : ""]
      .filter((x) => x && x.trim()).map((x, i) => (i ? " · " : " · ") + x).join("")));
  info.append(el("div", "pl-kind", TYPE_NAMES[al.type] ?? "Альбом"), el("h1", "pl-name", al.title), facts);
  if (al.label) info.append(el("div", "meta-label", `© ${al.label}`));
  const cover = picture(al.coverLarge, "collection-cover album-cover", al.title);
  header.append(cover, info);
  hero.append(header, playButtons(al.tracks, context));
  paintHero(hero, al.coverLarge && imgUrl(al.coverLarge), al.title);

  const body = el("div", "pl-body");
  body.append(al.tracks.length ? trackList(al.tracks, context) : el("p", "pl-empty", "В этом релизе нет треков."));
  box.replaceChildren(hero, body);
  markCurrentRows(state.current ? keyOf(state.current) : null);
  prefetchTop(al.tracks, stillHere);
}
