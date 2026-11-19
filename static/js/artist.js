// Страницы исполнителя и альбома. Данные — с сервера (/api/artist, /api/album: Яндекс Музыка + Deezer).
// Треки здесь «из базы» (source: "meta"): при включении плеер сам найдёт им пару на YouTube/SoundCloud.
// Исполнители SoundCloud (id «sc:<номер>», source: "soundcloud") — андеграунд, которого нет в Яндексе:
// у них треки сразу настоящие, вместо слушателей за месяц — подписчики, вместо дискографии — «Новые треки».

import { openTrackMenu, toggleLike } from "./actions.js";
import { startFlow } from "./flow.js";
import { icons, sourceIcons } from "./icons.js";
import { openView, takeHighlight } from "./nav.js";
import { isPlaying, play, prefetch, queueLater, queueNext, state, togglePlay } from "./player.js";
import { compactNumber, countText, el, formatTotal, iconButton, imageHsl, imgUrl, markCurrentRows, nameHue, openMenu, plural, toast, trackRow } from "./ui.js";
import { createPlaylist, isFollowing, keyOf, lib, setPlaylistCover, toggleFollow } from "./library.js";
import { liveUi } from "./motion.js";
import { bigPill, colsClass, liveHead, miniBtn, playPill, plCard, plLayout, statusLine } from "./plcard.js";
import { sharePlaylist } from "./share.js";
import { fillPlays, loadPlays, playsOf } from "./plays.js";
import { artistStatsLine } from "./stats.js";

const cache = new Map();   // адрес → ответ сервера (обещание; на время работы программы)

export function load(url) {
  if (!cache.has(url)) {
    // Храним само обещание: наведение мыши и щелчок по той же ссылке ждут один и тот же запрос
    const job = fetch(url).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Не нашлось");
      return data;
    });
    job.catch(() => cache.delete(url));   // ошибка — в следующий раз спросим заново
    cache.set(url, job);
  }
  return cache.get(url);
}

// ---------- Подготовка заранее ----------
// Ссылки на исполнителя/альбом помечены data-warm="artist:<id>" | "album:<id>". Мышь задержалась на ссылке
// дольше 150 мс — начинаем загружать страницу: пока рука дойдёт до щелчка, данные уже готовы или почти
// (незнакомый исполнитель — 0,5–2 с, а между наведением и щелчком обычно 0,3–1 с).

export function warmPage(key) {
  const [kind, id] = String(key).split(/:(.+)/);
  if (!id || (kind !== "artist" && kind !== "album")) return;
  load(`/api/${kind}/${id}`).catch(() => {});
}

let warmTimer = 0, warmFor = null;
document.addEventListener("pointerover", (e) => {
  const target = e.target.closest?.("[data-warm]");
  if (target === warmFor) return;
  warmFor = target;
  clearTimeout(warmTimer);
  if (target) warmTimer = setTimeout(() => warmPage(target.dataset.warm), 150);
});

export const TYPE_NAMES = { album: "Альбом", single: "Сингл", ep: "EP", compilation: "Сборник" };
const contextKey = (ctx) => `${ctx.type}:${ctx.id}`;
const playingFrom = (ctx) => !!state.current && state.context && contextKey(state.context) === contextKey(ctx);

// ---------- Общие кусочки ----------

/** Цвет шапки — по картинке (фото исполнителя или обложка) */
export function paintHero(hero, url, fallbackName) {
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
export function picture(url, className, name = "") {
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
    box.style.color = "rgb(255 255 255 / 0.8)";   // фон тёмный при любой теме — значок светлый
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

export function section(title, ...children) {
  const s = el("section", "meta-section");
  s.append(el("h2", "meta-h", title), ...children);
  return s;
}

/** Экран ошибки: что не открылось, почему, и «Повторить» (раньше — серая строка с пунктиром в углу) */
export function failBox(what, err, retry) {
  const box = el("div", "meta-fail");
  const icon = el("span", "meta-fail-icon");
  icon.innerHTML = icons.compass;
  const again = el("button", "meta-fail-btn", "Повторить");
  again.type = "button";
  again.addEventListener("click", retry);
  box.append(icon, el("h2", "meta-fail-title", `Не получилось открыть ${what}`),
    el("p", "meta-fail-text", err.message || "Нет связи"), again);
  return box;
}

// ---------- Страница исполнителя ----------

export async function renderArtist(box, id, stillHere) {
  box.replaceChildren(el("p", "meta-loading", "Загружаю исполнителя…"));
  let a;
  try {
    a = await load(`/api/artist/${id}`);
  } catch (err) {
    if (stillHere()) box.replaceChildren(failBox("исполнителя", err, () => renderArtist(box, id, stillHere)));
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
        const trend = el("span", `artist-trend ${pct > 0 ? "up" : "down"}`, `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0).replace(".", ",")} %`);
        trend.title = `${pct > 0 ? "+" : "−"}${compactNumber(Math.abs(a.listenersDelta))} за месяц`;
        line.append(trend);
      }
    }
    line.title = "По данным Яндекс Музыки";
    info.append(line);
  }
  const fromSc = a.source === "soundcloud";
  if (fromSc && a.followers) {
    const line = el("div", "artist-listeners");
    const [num, ...word] = countText(a.followers, "подписчик", "подписчика", "подписчиков").split(" ");
    const big = a.followers >= 1e4;
    line.append(el("b", "", big ? `${num} ${word.shift()}` : num), ` ${word.join(" ")} на SoundCloud`);
    info.append(line);
  }
  info.append(el("div", "pl-meta", facts + (facts ? (fromSc ? " · SoundCloud" : " · Яндекс Музыка") : "")));
  // Сколько вы сами слушаете этого исполнителя и с какого дня
  const mine = artistStatsLine({ id: a.id, name: a.name });
  if (mine) info.append(el("div", "artist-mine", mine));
  header.append(picture(a.pictureLarge, "artist-photo", a.name), info);
  // У артиста SoundCloud популярные могут быть только отрывками (их убираем) — тогда ▶ включает новые треки
  const actions = playButtons(a.top.length ? a.top : a.latest || [], context);
  // Flow по исполнителю: он сам и похожие на него — бесконечно
  const flowBtn = el("button", "flow-pill");
  flowBtn.type = "button";
  flowBtn.innerHTML = `${icons.flow}<span>Flow</span>`;
  flowBtn.title = `Бесконечный поток: ${a.name} и похожие`;
  flowBtn.addEventListener("click", () => startFlow({ artist: { id: a.id, name: a.name } }));
  // Подписка: новинки этого исполнителя появятся на «Главной», о новом релизе Sono напомнит
  const follow = el("button", "follow-pill");
  follow.type = "button";
  const drawFollow = () => {
    const on = isFollowing(a.id);
    follow.classList.toggle("on", on);
    follow.textContent = on ? "Вы подписаны" : "Подписаться";
    follow.title = on ? "Отписаться" : "Новые релизы — на «Главной» и уведомлением";
  };
  follow.addEventListener("click", () => {
    const on = toggleFollow({ id: a.id, name: a.name, picture: a.picture });
    drawFollow();
    toast(on ? `Подписка на ${a.name}: новые релизы — на «Главной»` : `Вы отписались от ${a.name}`);
  });
  drawFollow();
  actions.append(flowBtn, follow);
  hero.append(header, actions);
  paintHero(hero, a.pictureLarge && imgUrl(a.pictureLarge), a.name);

  const body = el("div", "pl-body");

  // Новый релиз (за последние 3 месяца) — крупной карточкой первым
  if (a.newRelease) body.append(section("Новинка", newReleaseCard(a.newRelease)));
  // SoundCloud: загрузки за последние 3 месяца
  if (a.latest?.length) {
    const latestCtx = { type: "artist", id: `${a.id}-new`, name: `${a.name} · новые треки` };
    const card = trackList(a.latest, latestCtx, 5);
    body.append(section("Новые треки", card));
    loadPlays(a.latest.slice(0, 5), { alive: stillHere, onUpdate: () => { if (stillHere()) fillPlays(card, a.latest); } });
  }

  // Популярные треки: 5, по кнопке — все. Порядок — как в Яндексе (по популярности) или по прослушиваниям
  // на YouTube/SoundCloud: для этого трекам ищутся пары (по 4 сразу), числа приходят по мере готовности
  if (a.top.length) {
    const holder = el("div");
    let shown = 5;
    let byPlays = false;
    const order = () => (byPlays ? a.top.slice().sort((x, y) => (playsOf(y) ?? -1) - (playsOf(x) ?? -1)) : a.top);
    let drawn = "";   // какие треки сейчас видны и в каком порядке — чтобы не перерисовывать зря
    const render = () => {
      const tracks = order();
      const card = trackList(tracks, context, shown);
      holder.replaceChildren(card);
      if (a.top.length > 5) {
        const more = el("button", "meta-more", shown < a.top.length ? "Ещё" : "Свернуть");
        more.type = "button";
        more.addEventListener("click", () => { shown = shown < a.top.length ? a.top.length : 5; draw(); });
        holder.append(more);
      }
      fillPlays(card, tracks);
      markCurrentRows(state.current ? keyOf(state.current) : null);
      drawn = tracks.slice(0, shown).map(keyOf).join("|");
      return card;
    };
    // Числа пришли: в порядке «по прослушиваниям» треки могли поменяться местами — тогда перерисовать,
    // иначе просто вписать числа в строки
    const refresh = () => {
      if (!stillHere() || !holder.isConnected) return;
      const tracks = order();
      if (byPlays && tracks.slice(0, shown).map(keyOf).join("|") !== drawn) render();
      else { const card = holder.querySelector(".tracklist-card"); if (card) fillPlays(card, tracks); }
    };
    const draw = () => {
      render();
      // Видимые треки: найти пары и прослушивания, вписывать по мере готовности
      loadPlays(order().slice(0, shown), { resolve: true, alive: stillHere, onUpdate: refresh });
    };
    const sortSeg = el("div", "seg meta-sort");
    for (const [label, value] of [["По популярности", false], ["По прослушиваниям", true]]) {
      const b = el("button", `seg-btn${value === byPlays ? " on" : ""}`, label);
      b.type = "button";
      b.addEventListener("click", async () => {
        if (byPlays === value) return;
        byPlays = value;
        sortSeg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
        draw();   // сразу — по уже известным числам
        if (!byPlays) return;
        // Остальным популярным (до 50) ищем пары по 4 сразу — список пересортировывается по мере готовности
        b.classList.add("busy");
        await loadPlays(a.top, { resolve: true, alive: () => stillHere() && byPlays, onUpdate: refresh });
        b.classList.remove("busy");
      });
      sortSeg.append(b);
    }
    draw();
    const head = el("div", "meta-h-row");
    head.append(el("h2", "meta-h", "Популярные треки"), sortSeg);
    const sec = el("section", "meta-section");
    sec.append(head, holder);
    body.append(sec);
  }

  // Дискография: вкладки «Альбомы» / «Синглы и EP». Альбомы с SoundCloud, которых нет в Яндексе,
  // приходят отдельно и чуть позже — тогда раздел перерисовывается (открытая вкладка остаётся)
  const disco = el("div");
  body.append(disco);
  const drawDiscography = (releases) => {
    const albums = releases.filter((r) => r.type === "album" || r.type === "compilation");
    const singles = releases.filter((r) => r.type === "single" || r.type === "ep");
    if (!releases.length) return disco.replaceChildren();
    const wasSingles = disco.querySelector(".meta-tabs .seg-btn.on")?.dataset.tab === "singles";
    const grid = el("div", "release-grid");
    const tabs = el("div", "seg meta-tabs");
    // На странице артиста SoundCloud оттуда всё — значок «с SoundCloud» не нужен
    const showTab = (list) => grid.replaceChildren(...list.map((r) => releaseCard(r, !fromSc)));
    for (const [label, list, name] of [[`Альбомы · ${albums.length}`, albums, "albums"], [`Синглы и EP · ${singles.length}`, singles, "singles"]]) {
      if (!list.length) continue;
      const tab = el("button", "seg-btn", label);
      tab.type = "button";
      tab.dataset.tab = name;
      tab.addEventListener("click", () => {
        tabs.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b === tab));
        showTab(list);
      });
      tabs.append(tab);
    }
    const first = (wasSingles && singles.length) || !albums.length ? singles : albums;
    tabs.querySelector(`[data-tab="${first === singles ? "singles" : "albums"}"]`)?.classList.add("on");
    showTab(first);
    disco.replaceChildren(section("Дискография", tabs, grid));
  };
  a.releases ||= [];
  drawDiscography(a.releases);
  if (!fromSc) {
    load(`/api/artist/${a.id}/soundcloud`).then((sc) => {
      if (!stillHere() || !disco.isConnected || !sc.releases?.length) return;
      // Как у Яндекса: новые сверху (год, потом дата)
      const all = [...a.releases, ...sc.releases].sort((x, y) =>
        `${y.year || "0"}${y.date || ""}`.localeCompare(`${x.year || "0"}${x.date || ""}`));
      drawDiscography(all);
    }).catch(() => {});   // SoundCloud не ответил — остаётся дискография из Яндекса
  }

  // Похожие исполнители
  if (a.related?.length) {
    const grid = el("div", "artist-grid");
    for (const r of a.related) {
      const card = el("button", "artist-card");
      card.type = "button";
      card.append(picture(r.picture, "artist-card-photo", r.name), el("span", "artist-card-name", r.name));
      card.dataset.warm = `artist:${r.id}`;
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
    const source = a.bioSource ? el("p", "meta-bio-source", `Источник: ${a.bioSource}`) : "";
    body.append(section("Об исполнителе", text, toggle, source));
  }

  box.replaceChildren(hero, body);
  prefetchTop(a.top, stillHere);
}

/** Открыли страницу — готовим два первых трека (найти пару на YouTube/SoundCloud и начало звука), по одному */
export function prefetchTop(tracks, stillHere) {
  setTimeout(async () => {
    for (const t of tracks.slice(0, 2)) {
      if (!stillHere()) return;
      await prefetch(t);
    }
  }, 500);
}

/** Крупная карточка нового релиза: обложка, «Сингл · 12 октября», ▶ */
function newReleaseCard(r) {
  const card = el("button", "new-release");
  card.type = "button";
  const art = picture(r.cover, "new-release-art", r.title);
  const when = r.date ? new Date(r.date).toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" }) : r.year;
  const text = el("div", "new-release-text");
  text.append(el("div", "new-release-kind", `${TYPE_NAMES[r.type] ?? "Альбом"} · ${when}`), el("div", "new-release-title", r.title),
    el("div", "new-release-sub", r.tracks ? plural(r.tracks, "трек", "трека", "треков") : ""));
  const playBtn = el("span", "play new-release-play");
  playBtn.innerHTML = icons.play;
  playBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const album = await load(`/api/album/${r.id}`);
      if (album.tracks.length) play(album.tracks[0], album.tracks.slice(), 0, { type: "album", id: album.id, name: album.title });
    } catch {}
  });
  card.append(art, text, playBtn);
  card.dataset.warm = `album:${r.id}`;
  card.addEventListener("click", () => openView(`album:${r.id}`));
  return card;
}

export function releaseCard(r, markSource = true) {
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
  // Релиз с SoundCloud (в Яндексе его нет) — значок в углу обложки: словом в подписи не помещалось
  if (markSource && r.source === "soundcloud") {
    const badge = el("span", "release-src");
    badge.innerHTML = sourceIcons.soundcloud;
    art.append(badge);
  }
  card.append(art, el("span", "home-card-title", r.title),
    el("span", "home-card-artist", [r.year, TYPE_NAMES[r.type] ?? "Альбом"].filter(Boolean).join(" · ")));
  card.title = markSource && r.source === "soundcloud" ? `${r.title} — с SoundCloud` : r.title;
  card.dataset.warm = `album:${r.id}`;
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
    if (stillHere()) box.replaceChildren(failBox("альбом", err, () => renderAlbum(box, id, stillHere)));
    return;
  }
  if (!stillHere()) return;
  const context = { type: "album", id: al.id, name: al.title };
  if (liveUi()) return renderAlbumLive(box, al, context, stillHere);   // ПК — карточка слева, список справа

  const hero = el("div", "pl-hero");
  const header = el("header", "pl-header");
  const info = el("div", "pl-info");
  const artistLink = el("button", "meta-artist-link", al.artist.name || "");
  artistLink.type = "button";
  if (al.artist.id) artistLink.dataset.warm = `artist:${al.artist.id}`;
  artistLink.addEventListener("click", () => {
    if (al.artist.id) openView(`artist:${al.artist.id}`);
  });
  const facts = el("div", "pl-meta");
  facts.append(artistLink, document.createTextNode(
    [" ", al.year, al.tracks.length ? plural(al.tracks.length, "трек", "трека", "треков") : "", al.tracks.length ? formatTotal(al.tracks) : "",
      al.likes ? `${countText(al.likes, "лайк", "лайка", "лайков")} ${al.source === "soundcloud" ? "на SoundCloud" : "в Яндекс Музыке"}` : ""]
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
  // Прослушивания: сразу — у треков с найденной парой, остальным пары ищутся по 4, числа появляются по мере готовности
  loadPlays(al.tracks.slice(0, 40), { resolve: true, alive: stillHere, onUpdate: () => { if (stillHere()) fillPlays(body, al.tracks); } });
  // Пришли щелчком по названию трека — показываем, где он в альбоме
  const want = takeHighlight();
  const row = want && box.querySelector(`.track[data-key="${CSS.escape(want)}"]`);
  if (row) {
    row.classList.add("flash");
    requestAnimationFrame(() => row.scrollIntoView({ block: "center", behavior: "smooth" }));
  }
}

// ---------- Альбом на ПК («Живая обложка», макет B-ekrany.html#album) ----------
// Слева — карточка: обложка, «Альбом · 23 октября 2026», название, исполнитель, «Играть» / «В медиатеку»,
// кнопки с подписями, откуда альбом. Справа — треки без обложек и «Ещё у исполнителя» одним рядом

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export function releaseDate(al) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(al.date || "");
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : al.year || "";
}

/** Сохранённая копия альбома в медиатеке (плейлист с пометкой album) */
export const savedCopy = (al) => lib.playlists.find((p) => String(p.album) === String(al.id)) ?? null;

/** «В медиатеку»: копия альбома плейлистом, с обложкой альбома (своих альбомов в медиатеке у Sono нет) */
export function saveAlbumCopy(al) {
  const p = createPlaylist(al.title, al.tracks);
  p.album = al.id;
  const url = al.coverLarge || al.cover;
  if (url) coverData(url).then((data) => setPlaylistCover(p.id, data)).catch(() => {});   // обложка альбома — своей обложкой плейлиста
  toast(`«${al.title}» — в медиатеке`);
  return p;
}

function renderAlbumLive(box, al, context, stillHere) {
  const tracks = al.tracks;
  const kind = [TYPE_NAMES[al.type] ?? "Альбом", releaseDate(al)].filter(Boolean).join(" · ");
  const name = el("h1", "pl-name", al.title);
  const meta = document.createDocumentFragment();
  const who = el("span", "pl-who");
  const artistLink = el("button", "meta-artist-link", al.artist.name || "");
  artistLink.type = "button";
  if (al.artist.id) {
    artistLink.dataset.warm = `artist:${al.artist.id}`;
    artistLink.addEventListener("click", () => openView(`artist:${al.artist.id}`));
  }
  who.append(artistLink);
  meta.append(who);
  const facts = [tracks.length ? plural(tracks.length, "трек", "трека", "треков") : "", tracks.length ? formatTotal(tracks) : ""].filter(Boolean);
  if (facts.length) meta.append(` · ${facts.join(" · ")}`);

  const playBtn = playPill(contextKey(context), () => (playingFrom(context) ? togglePlay() : play(tracks[0], tracks.slice(), 0, context)));
  playBtn.disabled = !tracks.length;
  playBtn.classList.toggle("is-playing", playingFrom(context) && isPlaying());
  playBtn.addEventListener("mouseenter", () => prefetch(tracks[0]));
  // «В медиатеку»: копия альбома — плейлистом (своих альбомов в медиатеке у Sono нет); уже есть — открыть её
  const save = bigPill("В медиатеку", icons.heart, () => {
    const have = savedCopy(al);
    if (have) return openView(`playlist:${have.id}`);
    saveAlbumCopy(al);
    drawSave();
  });
  const drawSave = () => {
    const have = !!savedCopy(al);
    save.innerHTML = `${have ? icons.heartFilled : icons.heart}<span>${have ? "В медиатеке" : "В медиатеку"}</span>`;
    save.classList.toggle("on", have);
    save.title = have ? "Открыть копию в медиатеке" : "Сохранить альбом плейлистом в медиатеку";
  };
  drawSave();
  save.disabled = !tracks.length;

  const shuffle = miniBtn("Вперемешку", icons.shuffle, () => {
    const i = Math.floor(Math.random() * tracks.length);
    play(tracks[i], [tracks[i], ...tracks.filter((_, n) => n !== i).sort(() => Math.random() - 0.5)], 0, context);
  });
  shuffle.disabled = tracks.length < 2;
  const flow = miniBtn("Flow", icons.flow, () => startFlow({ playlist: { id: `album:${al.id}`, name: al.title, tracks } }));
  flow.title = `Бесконечный поток в духе «${al.title}»`;
  const share = miniBtn("Поделиться", icons.share, () => sharePlaylist({ name: `${al.title} — ${al.artist.name || ""}`.replace(/ — $/, ""), tracks }));
  const more = miniBtn("Ещё", icons.more, (anchor) => openMenu(anchor, [
    { label: "Играть следующими", icon: icons.playNext, disabled: !tracks.length, action: () => { tracks.slice().reverse().forEach((t) => queueNext(t)); toast(`«${al.title}» — играет следующим`); } },
    { label: "В очередь", icon: icons.queue, disabled: !tracks.length, action: () => { queueLater(tracks); toast(`«${al.title}» — в очереди`); } },
    ...(al.artist.id ? [{ label: "Исполнитель", icon: icons.user ?? icons.compass, action: () => openView(`artist:${al.artist.id}`) }] : []),
  ]));
  if (!tracks.length) [shuffle, flow, share].forEach((b) => { b.disabled = true; });

  const from = al.source === "soundcloud" ? "Альбом с SoundCloud" : String(al.id).startsWith("dz") ? "Из каталога Deezer" : "Из Яндекс Музыки";
  const extraFacts = [al.likes ? `${countText(al.likes, "лайк", "лайка", "лайков")}` : "", al.label ? `© ${al.label}` : ""].filter(Boolean);
  const status = statusLine([from, ...extraFacts].join(" · "), "ok");
  status.title = [from, ...extraFacts].join(" · ");

  const card = plCard({ cover: picture(al.coverLarge, "collection-cover album-cover", al.title), kind, name, meta,
    acts: [playBtn, save], minis: [shuffle, flow, share, more], status });

  // Треки: без обложек (у альбома она одна), колонки — как у плейлиста, без «Альбом» и «Добавлен»
  const cols = { album: false, added: false };
  const list = el("ol", "tracklist");
  tracks.forEach((track, i) => {
    const row = trackRow(track, {
      index: i, numbered: true, cols,
      onPlay: () => play(track, tracks.slice(), i, context),
      onLike: toggleLike,
      onMenu: (anchor) => openTrackMenu(anchor, track, {}),
    });
    row.addEventListener("mouseenter", () => prefetch(track));
    list.append(row);
  });
  const tl = el("div", `tracklist-card glass noart ${colsClass(cols)}`);
  tl.append(liveHead(cols), list);
  const moreBox = el("div");
  box.replaceChildren(plLayout(card, tracks.length ? tl : el("p", "pl-empty", "В этом релизе нет треков."), moreBox));

  // «Ещё у исполнителя»: его другие релизы одним рядом (страница исполнителя часто уже в памяти — наведение)
  if (al.artist.id) {
    load(`/api/artist/${al.artist.id}`).then((a) => {
      if (!stillHere() || !moreBox.isConnected) return;
      if (a.picture) {   // маленькое фото исполнителя перед именем
        const img = el("img", "pl-who-img");
        img.alt = "";
        img.src = imgUrl(a.picture);
        img.onerror = () => img.remove();
        who.prepend(img);
      }
      const others = (a.releases || []).filter((r) => String(r.id) !== String(al.id)).slice(0, 8);
      if (!others.length) return;
      const head = el("div", "meta-h-row");
      const all = el("button", "meta-more", "Все релизы");
      all.type = "button";
      all.addEventListener("click", () => openView(`artist:${al.artist.id}`));
      head.append(el("h2", "meta-h", `Ещё у ${a.name || al.artist.name}`), all);
      const row = el("div", "pl-more-row");
      row.append(...others.map((r) => releaseCard(r, a.source !== "soundcloud")));
      const sec = el("section", "meta-section");
      sec.append(head, row);
      moreBox.replaceChildren(sec);
    }).catch(() => {});
  }

  markCurrentRows(state.current ? keyOf(state.current) : null);
  prefetchTop(tracks, stillHere);
  loadPlays(tracks.slice(0, 40), { resolve: true, alive: stillHere, onUpdate: () => { if (stillHere()) fillPlays(list, tracks); } });
  const want = takeHighlight();
  const row = want && box.querySelector(`.track[data-key="${CSS.escape(want)}"]`);
  if (row) {
    row.classList.add("flash");
    requestAnimationFrame(() => row.scrollIntoView({ block: "center", behavior: "smooth" }));
  }
}

/** Картинка по адресу → маленькая JPEG data: (как «Своя обложка» плейлиста) */
async function coverData(url) {
  const img = new Image();
  img.src = imgUrl(url);
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = 300;
  c.getContext("2d").drawImage(img, 0, 0, 300, 300);
  return c.toDataURL("image/jpeg", 0.85);
}
