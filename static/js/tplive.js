// Страница трека на ПК («Живая обложка», макет design/ui-new/B-ekrany.html#track).
// Шапка-стекло: обложка, «Трек · из альбома «…»», название, исполнитель с фото, плашки (сайт, прослушивания,
// лайки, жанр, дата, длительность), кнопки; справа — начало текста (у играющей песни строки идут вслед за звуком).
// Ниже три окошка: «Ещё у исполнителя», «Авторы», «Из альбома «…»», потом «Похожие» карточками и
// «В ваших плейлистах». Каждое окошко приходит само по себе; нет данных — окошка нет.
// На телефоне — прежняя страница (trackpage.js renderTrack); какую показать, решает views.js.

import { openAddToPlaylist, openTrackMenu, toggleLike } from "./actions.js";
import { load } from "./artist.js";
import { listRecs, songKey, startFlow } from "./flow.js";
import { icons } from "./icons.js";
import { isLiked, keyOf, lib } from "./library.js";
import { fetchLyrics, isLyricsVisible, setLyricsVisible } from "./lyrics.js";
import { artistForTrack, isMeta, resolveMeta, toReal } from "./meta.js";
import { openAlbumAt, openArtist, openTrack, openView, splitArtists } from "./nav.js";
import { isPlaying, play, prefetch, state, togglePlay } from "./player.js";
import { bigPill, playPill } from "./plcard.js";
import { twinsIn } from "./samesong.js";
import { openShareCard } from "./sharecard.js";
import { longDate, sameAs, trackInfo } from "./trackpage.js";
import { SOURCE_NAMES, compactNumber, countText, coverUrl, displayTrack, el, formatTime, imgUrl, plural, toast } from "./ui.js";

const audio = document.getElementById("player");
const SRC_ICONS = { youtube: icons.srcYoutube, soundcloud: icons.srcSoundcloud };

/** Окошко под шапкой: заголовок (+ подпись справа), сначала «Ищу…», потом содержимое или ничего */
function lateBox(grid, title, loading) {
  const box = el("section", "tp-box glass");
  const head = el("h3", "tp-box-h");
  head.append(el("span", "tp-box-t", title));
  box.append(head, el("p", "tp-loading", loading));
  grid.append(box);
  return {
    box,
    fill: (note, ...children) => {
      if (note) head.append(note);
      box.replaceChildren(head, ...children);
    },
    drop: () => box.remove(),
    title: (text) => { head.querySelector(".tp-box-t").textContent = text; },
  };
}

/** Строка окошка: [номер | обложка], название, подпись, справа — длительность */
function boxRow({ n = null, cover = null, title, sub = "", right = "", cur = false, onClick }) {
  const row = el("button", `tp-row${cur ? " cur" : ""}`);
  row.type = "button";
  if (n != null) row.append(el("span", "tp-row-n", String(n)));
  if (cover) {
    const img = el("img", "tp-row-img");
    img.alt = "";
    img.loading = "lazy";
    img.src = cover;
    img.onerror = () => img.classList.add("broken");
    row.append(img);
  }
  const text = el("span", "tp-row-text");
  text.append(el("b", "", title));
  if (sub) text.append(el("span", "", sub));
  row.append(text);
  if (right) row.append(el("span", "tp-row-r", right));
  row.title = title;
  row.addEventListener("click", onClick);
  return row;
}

/** Карточка песни для «Похожих»: щелчок — её страница, ▶ — слушать */
function songCard(track, list, index, context) {
  const shown = displayTrack(track);
  const card = el("button", "home-card");
  card.type = "button";
  card.dataset.key = keyOf(track);
  const art = el("div", "home-card-art");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = coverUrl(track, "large");
  img.onerror = () => img.classList.add("broken");
  const playBtn = el("span", "tile-play");
  playBtn.innerHTML = icons.play;
  playBtn.title = "Слушать";
  playBtn.addEventListener("click", (e) => { e.stopPropagation(); play(track, list.slice(), index, context); });
  art.append(img, playBtn);
  card.append(art, el("span", "home-card-title", shown.title), el("span", "home-card-artist", shown.artist));
  card.title = `${shown.artist} — ${shown.title}`;
  card.addEventListener("click", () => openTrack(track));
  card.addEventListener("mouseenter", () => prefetch(track));
  return card;
}

export async function renderTrackLive(box, track, stillHere) {
  const shown = displayTrack(track);
  const context = { type: "track", id: keyOf(track), name: shown.title };
  const isThis = () => !!state.current && (keyOf(state.current) === keyOf(track) || songKey(state.current) === songKey(track));
  const root = el("div", "tp-live");

  // ---------- Шапка: сразу, из того, что уже известно ----------
  const hero = el("section", "tp-hero glass");
  const cover = el("div", "tp-cover");
  const img = el("img");
  img.alt = "";
  img.src = coverUrl(track, "large");
  img.onerror = () => { img.remove(); cover.classList.add("no-image"); cover.innerHTML = icons.note; };
  cover.append(img);

  const info = el("div", "tp-info");
  // «Трек · из альбома «turn sour»» — альбом ссылкой; у трека не «из базы» альбом ищется в базе Яндекса
  const kind = el("div", "pl-kind tp-kind", "Трек");
  let albumRef = track.albumId ? { albumId: track.albumId, trackKey: isMeta(track) ? keyOf(track) : track.metaId ? `meta:${track.metaId}` : null } : null;
  const albumLink = el("button", "tp-album-link", "");
  albumLink.type = "button";
  albumLink.addEventListener("click", () => albumRef && openAlbumAt(albumRef.albumId, albumRef.trackKey));
  const drawKind = (title) => {
    if (!title) return;
    albumLink.textContent = `«${title}»`;
    kind.replaceChildren("Трек · из альбома ", albumLink);
  };
  drawKind(track.album);

  const by = el("div", "tp-by");
  const firstArtist = splitArtists(track, shown.artist)[0];
  splitArtists(track, shown.artist).forEach(({ name, id }, i) => {
    if (i) by.append(el("span", "tp-by-sep", ","));
    const link = el("button", "tp-by-name", name);
    link.type = "button";
    if (id) link.dataset.warm = `artist:${id}`;
    link.addEventListener("click", async () => {
      if (!await openArtist({ id, name, track, title: shown.title })) toast(`Не нашёл страницу «${name}»`);
    });
    by.append(link);
  });

  // Плашки: сайт · прослушивания · лайки · жанр · дата · длительность (приходят по мере ответов)
  const chips = el("div", "tp-tags");
  const chipParts = { source: null, plays: null, likes: null, genre: null, date: null, label: null };
  if (track.year) chipParts.date = String(track.year);
  const drawChips = () => {
    const list = [];
    if (chipParts.source) {
      const c = el("span", "tp-tag");
      c.innerHTML = SRC_ICONS[chipParts.source] ?? "";
      c.append(SOURCE_NAMES[chipParts.source] ?? chipParts.source);
      list.push(c);
    }
    for (const k of ["plays", "likes", "genre", "date"]) if (chipParts[k]) list.push(chipParts[k] instanceof Node ? chipParts[k] : el("span", "tp-tag", chipParts[k]));
    if (track.duration) list.push(el("span", "tp-tag", formatTime(track.duration)));
    if (chipParts.label) list.push(el("span", "tp-tag", chipParts.label));
    chips.replaceChildren(...list);
  };
  drawChips();

  // Кнопки: Играть, В избранное, В плейлист, Flow от трека, Картинкой, «⋯»
  const acts = el("div", "pl-acts tp-acts");
  const playBtn = playPill(`track:${keyOf(track)}`, () => (isThis() ? togglePlay() : play(track, [track], 0, context)));
  // «Пауза», пока играет эта песня (из любого списка — поэтому не по data-collection, а по самому треку)
  delete playBtn.dataset.collection;
  const syncPlay = () => {
    if (!root.isConnected) {   // ушли со страницы — больше не слушаем
      for (const ev of ["play", "pause", "emptied"]) audio.removeEventListener(ev, syncPlay);
      return;
    }
    playBtn.classList.toggle("is-playing", isThis() && isPlaying());
  };
  playBtn.classList.toggle("is-playing", isThis() && isPlaying());
  for (const ev of ["play", "pause", "emptied"]) audio.addEventListener(ev, syncPlay);
  playBtn.addEventListener("mouseenter", () => prefetch(track));
  const like = bigPill("", icons.heart, async () => { await toggleLike(track); syncLike(); });
  const syncLike = () => {
    const on = isLiked(track);
    like.innerHTML = `${on ? icons.heartFilled : icons.heart}<span>${on ? "В избранном" : "В избранное"}</span>`;
    like.classList.toggle("on", on);
    like.title = on ? "Убрать из избранного" : "В избранное";
  };
  syncLike();
  const add = bigPill("В плейлист", icons.plus, () => openAddToPlaylist(add, track));
  const flow = bigPill("Flow от трека", icons.flow, async () => startFlow({ track: await resolveMeta(track).catch(() => null) || track }));
  flow.title = "Бесконечный поток в духе этой песни";
  const share = bigPill("Картинкой", icons.image, async () => openShareCard(track, await resolveMeta(track).catch(() => null) || track));
  share.title = "Поделиться картинкой";
  const more = el("button", "pill big ic");
  more.type = "button";
  more.innerHTML = icons.more;
  more.title = "Ещё";
  more.addEventListener("click", () => openTrackMenu(more, track, {}));
  acts.append(playBtn, like, add, flow, share, more);

  info.append(kind, el("h1", "tp-name", shown.title), by, chips, acts);
  hero.append(cover, info);
  root.append(hero);

  const grid = el("div", "tp-grid");
  root.append(grid);
  const lower = el("div");   // «Похожие» и «В ваших плейлистах»
  root.append(lower);
  box.replaceChildren(root);

  // ---------- Настоящая загрузка (у трека «из базы» — найденная пара) ----------
  let real = null;
  try {
    real = isMeta(track) ? await toReal(track) : track;
  } catch { /* сеть — окошки, которым нужна загрузка, просто не появятся */ }
  if (!stillHere()) return;
  if (isMeta(track) && !real) info.append(el("p", "tp-note", "Этой песни нет ни на YouTube, ни на SoundCloud — послушать не получится."));
  if (real && real.source !== "local") { chipParts.source = real.source; drawChips(); }

  // Порядок окошек задаём сразу, заполняются они по мере готовности
  const byArtist = firstArtist?.name ? lateBox(grid, `Ещё у ${firstArtist.name}`, "Загружаю…") : null;
  const credits = real && real.source !== "local" ? lateBox(grid, "Авторы", "Смотрю описание…") : null;
  const albumBox = real?.source !== "local" ? lateBox(grid, "Из альбома", "Ищу альбом…") : null;
  const similarBox = el("div");
  lower.append(similarBox);
  playlistsSection(lower, track);

  // Сколько слушают, дата, жанр, «Авторы»
  if (credits) {
    // Сайт долго не отвечает (бывает 30–40 с) — «Авторы» не висят на «Смотрю описание…»: окошко убираем,
    // а плашки встанут, когда ответ всё же придёт
    let late = false, answered = false;
    setTimeout(() => { if (answered) return; late = true; if (stillHere()) credits.drop(); }, 15000);
    trackInfo(real).then((data) => {
      answered = true;
      if (!stillHere()) return;
      const yt = real.source === "youtube";
      if (data.plays != null) chipParts.plays = countText(data.plays, yt ? "просмотр" : "прослушивание", yt ? "просмотра" : "прослушивания", yt ? "просмотров" : "прослушиваний");
      if (data.likes != null) {
        const c = el("span", "tp-tag");
        c.append(compactNumber(data.likes));
        c.insertAdjacentHTML("beforeend", icons.heart);
        c.title = `${data.likes.toLocaleString("ru")} лайков на ${SOURCE_NAMES[real.source]}`;
        chipParts.likes = c;
      }
      if (data.genre) chipParts.genre = data.genre;
      if (data.label) chipParts.label = `℗ ${data.label}`;
      // Дата: «вышел …» (точная) → год альбома → «загружен …» (дата загрузки ролика — только если другого нет)
      if (data.date && (data.dateKind === "release" || !chipParts.date)) {
        const d = longDate(data.date);
        chipParts.date = data.dateKind === "release" ? d.replace(/^в /, "") : `загружен ${d}`;
      }
      drawChips();
      // «При участии» тех, кто уже назван в шапке, не повторяем
      const named = shown.artist.toLowerCase();
      const roles = (data.credits || []).map((c) => (c.role === "При участии"
        ? { ...c, names: c.names.filter((n) => !named.includes(n.toLowerCase())) } : c)).filter((c) => c.names.length);
      if (late || !roles.length) return credits.drop();
      const list = el("dl", "tp-kv");
      for (const c of roles) list.append(el("dt", "", c.role), el("dd", "", c.names.join(", ")));
      credits.fill(el("small", "tp-box-note", `из описания на ${SOURCE_NAMES[real.source]}`), list);
    }).catch(() => { if (stillHere()) credits.drop(); });
  }

  // Альбом: у трека из базы он уже есть, остальным ищем в базе Яндекса (как «Перейти к альбому»)
  if (albumBox) {
    (async () => {
      if (!albumRef) {
        const res = await fetch("/api/track-album", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artist: shown.artist, title: shown.title, duration: track.duration }),
        });
        const found = res.ok ? await res.json() : null;
        if (!found?.albumId) return albumBox.drop();
        albumRef = { albumId: found.albumId, trackKey: `meta:${found.trackId}` };
        if (stillHere()) drawKind(found.albumTitle);
      }
      const al = await load(`/api/album/${albumRef.albumId}`);
      if (!stillHere()) return;
      if (!al.tracks?.length) return albumBox.drop();
      drawKind(al.title);
      albumBox.title(`Из альбома «${al.title}»`);
      const here = al.tracks.findIndex((t) => keyOf(t) === albumRef.trackKey);
      // Длинный альбом — 8 строк вокруг этой песни
      const start = Math.max(0, Math.min(here - 2, al.tracks.length - 8));
      const ctx = { type: "album", id: al.id, name: al.title };
      const rows = al.tracks.slice(start, start + 8).map((t, k) => {
        const i = start + k;
        const row = boxRow({ n: i + 1, title: displayTrack(t).title, right: t.duration ? formatTime(t.duration) : "", cur: i === here,
          onClick: () => play(t, al.tracks.slice(), i, ctx) });
        row.addEventListener("mouseenter", () => prefetch(t));
        return row;
      });
      const note = el("button", "tp-box-note link", plural(al.tracks.length, "трек", "трека", "треков"));
      note.type = "button";
      note.title = "Открыть альбом";
      note.addEventListener("click", () => openAlbumAt(albumRef.albumId, albumRef.trackKey));
      albumBox.fill(note, ...rows);
    })().catch(() => { if (stillHere()) albumBox.drop(); });
  }

  // Текст: справа в шапке; у играющей песни строки идут вслед за звуком
  if (real) {
    fetchLyrics(real).then((data) => {
      if (!stillHere()) return;
      const synced = data.synced?.length ? data.synced.map(([t, w]) => [t, String(w).trim()]).filter(([, w]) => w) : null;
      const lines = synced ? synced.map(([, w]) => w) : String(data.plain || "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return;
      hero.append(lyricsCard(lines, synced, isThis));
      hero.classList.add("has-lyr");
    }).catch(() => {});
  }

  // Ещё у исполнителя: топ его страницы без этой песни
  if (byArtist) {
    (async () => {
      const found = firstArtist.id ? { id: firstArtist.id } : await artistForTrack(firstArtist.name, shown.title, track);
      if (!found?.id) return byArtist.drop();
      const a = await load(`/api/artist/${found.id}`);
      if (!stillHere()) return;
      if (a.picture) {   // фото исполнителя перед именем в шапке
        const face = el("img", "tp-by-img");
        face.alt = "";
        face.src = imgUrl(a.picture);
        face.onerror = () => face.remove();
        by.prepend(face);
      }
      const skip = sameAs(real || track);
      const skipToo = sameAs(track);
      const top = (a.top?.length ? a.top : a.latest || []).filter((t) => !skip(t) && !skipToo(t)).slice(0, 4);
      if (!top.length) return byArtist.drop();
      const ctx = { type: "artist", id: found.id, name: a.name || firstArtist.name };
      const rows = top.map((t, i) => {
        // Подпись — альбом; у сингла альбом = название, его не повторяем
        const row = boxRow({ cover: coverUrl(t), title: displayTrack(t).title, sub: t.album && t.album !== t.title ? t.album : "",
          right: t.duration ? formatTime(t.duration) : "", onClick: () => play(t, top.slice(), i, ctx) });
        row.dataset.key = keyOf(t);
        row.addEventListener("mouseenter", () => prefetch(t));
        return row;
      });
      const note = el("button", "tp-box-note link", "Все треки");
      note.type = "button";
      note.title = "Страница исполнителя";
      note.addEventListener("click", () => openView(`artist:${found.id}`));
      byArtist.title(`Ещё у ${a.name || firstArtist.name}`);
      byArtist.fill(note, ...rows);
    })().catch(() => { if (stillHere()) byArtist.drop(); });
  }

  // Похожие: как «Рекомендуемые» под плейлистом — по самой песне; только те, что можно включить.
  // Песни того же исполнителя — в «Ещё у …» выше, здесь — другие люди («key vs. locket» = «keyvslocket»)
  const bare = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const mainArtist = bare(firstArtist?.name);
  const sameArtist = (t) => !!mainArtist && bare(displayTrack(t).artist.split(/\s*,\s*/)[0]) === mainArtist;
  listRecs([real || track], { size: 24 }).then(async (list) => {
    const base = sameAs(real || track);
    const skip = (t) => base(t) || sameArtist(t);
    // Пары ищем сразу для дюжины кандидатов (по одному — 10–20 с), берём первые 8, которые можно включить
    const found = await Promise.all(list.filter((t) => !skip(t)).slice(0, 12)
      .map((t) => (isMeta(t) ? toReal(t).catch(() => null) : t)));
    const out = found.filter((r) => r && !skip(r)).slice(0, 8);
    if (!stillHere() || !out.length) return;
    const ctx = { type: "recs", id: `track-${keyOf(track)}`, name: `Похоже на «${shown.title}»` };
    const sec = el("section", "meta-section");
    const head = el("div", "meta-h-row live-h");
    head.append(el("h2", "meta-h", "Похожие"), el("small", "live-h-sub", "другие исполнители в том же духе"));
    const row = el("div", "pl-more-row");
    row.append(...out.map((t, i) => songCard(t, out, i, ctx)));
    sec.append(head, row);
    similarBox.replaceChildren(sec);
  }).catch(() => {});
}

/** Текст в шапке: 5 строк; у играющей песни с таймингами — текущая строка ярче и строки идут за звуком.
 *  «Открыть текст»: у играющей — «Сейчас играет» с текстом, у другой — весь текст здесь же */
function lyricsCard(lines, synced, isThis) {
  const card = el("div", "tp-lyr");
  const head = el("h5", "tp-lyr-h");
  head.innerHTML = icons.mic;
  head.append("Текст");
  const body = el("div", "tp-lyr-lines");
  const btn = el("button", "pill tp-lyr-btn");
  btn.type = "button";
  let open = false;
  const drawBtn = () => { btn.innerHTML = `<span>${open ? "Свернуть" : "Открыть текст"}</span>${icons.chevron}`; btn.classList.toggle("up", open); };
  drawBtn();
  let at = -2;
  const paint = (force = false) => {
    const live = !open && synced && isThis();
    let i = -1;
    if (live) {
      const t = audio.currentTime;
      for (let k = 0; k < synced.length && synced[k][0] <= t + 0.15; k++) i = k;
    }
    const key = open ? -3 : live ? i : -1;
    if (key === at && !force) return;
    at = key;
    const from = open ? 0 : live ? Math.max(0, Math.min(i - 1, lines.length - 5)) : 0;
    const shownLines = open ? lines : lines.slice(from, from + 5);
    body.replaceChildren(...shownLines.map((text, k) => el("p", from + k === i ? "hi" : "", text)));
    card.classList.toggle("live", live);
    card.classList.toggle("open", open);
  };
  btn.addEventListener("click", () => {
    if (!open && isThis()) {
      openView("now");
      if (!isLyricsVisible()) setLyricsVisible(true);
      return;
    }
    open = !open;
    drawBtn();
    paint(true);
  });
  const tick = () => {
    if (!card.isConnected) return audio.removeEventListener("timeupdate", tick);
    paint();
  };
  if (synced) audio.addEventListener("timeupdate", tick);
  paint(true);
  card.append(head, body, btn);
  return card;
}

/** «В ваших плейлистах»: где эта песня уже лежит (любой загрузкой) */
function playlistsSection(parent, track) {
  const where = [];
  if (twinsIn(lib.liked, track).length) where.push({ name: "Избранное", view: "liked" });
  for (const p of lib.playlists) if (twinsIn(p.tracks, track).length) where.push({ name: p.name, view: `playlist:${p.id}` });
  if (!where.length) return;
  const chips = el("div", "tp-chips tp-where");
  for (const w of where) {
    const chip = el("button", "tp-chip", w.name);
    chip.type = "button";
    chip.addEventListener("click", () => openView(w.view));
    chips.append(chip);
  }
  const sec = el("section", "meta-section");
  const head = el("div", "meta-h-row live-h");
  head.append(el("h2", "meta-h", "В ваших плейлистах"));
  sec.append(head, chips);
  parent.append(sec);
}
