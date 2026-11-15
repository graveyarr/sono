// Страница трека («⋯» → «О треке», щелчок по названию на «Сейчас играет»): всё о песне в одном месте.
// Шапка (обложка, исполнители, альбом, год, сколько слушают) → «Кто сделал» → текст → другие загрузки →
// похожие → ещё у исполнителя → в каких ваших плейлистах она лежит.
// Каждый блок приходит сам по себе: шапка — сразу, остальное — по мере ответов сервера.
// Нет данных — блока нет (лучше не показать, чем показать сомнительное).

import { openAddToPlaylist, openTrackAlbum, openTrackMenu, toggleLike } from "./actions.js";
import { failBox, load, paintHero, section } from "./artist.js";
import { listRecs, songKey, startFlow } from "./flow.js";
import { icons } from "./icons.js";
import { isLiked, keyOf, lib } from "./library.js";
import { fetchLyrics } from "./lyrics.js";
import { artistForTrack, isMeta, resolveMeta, toReal } from "./meta.js";
import { openAlbumAt, openArtist, openView, splitArtists } from "./nav.js";
import { isPlaying, play, prefetch, state, togglePlay } from "./player.js";
import { twinsIn } from "./samesong.js";
import { openShareCard } from "./sharecard.js";
import { SOURCE_NAMES, compactNumber, countText, coverUrl, displayTrack, el, formatTime, iconButton, markCurrentRows, toast, trackRow } from "./ui.js";

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const longDate = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return "";
  // «1 января» у старых песен — заглушка YouTube Music, когда точный день неизвестен: только год
  return m === 1 && d === 1 ? `в ${y}` : `${d} ${MONTHS[m - 1]} ${y}`;
};

const info = new Map();   // «источник:id» → обещание /api/trackinfo (на время работы программы)
function trackInfo(real) {
  const key = keyOf(real);
  if (!info.has(key)) {
    const job = fetch(`/api/trackinfo/${real.source}/${encodeURIComponent(real.id)}`).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data;
    });
    job.catch(() => info.delete(key));
    info.set(key, job);
  }
  return info.get(key);
}

/** Список треков: щелчок играет его (и дальше по списку) */
function rows(tracks, context, { showSource = false } = {}) {
  const card = el("div", "tracklist-card");
  const list = el("ol", "tracklist");
  tracks.forEach((track, i) => {
    const row = trackRow(track, {
      index: i, showSource,
      onPlay: () => play(track, tracks.slice(), i, context),
      onLike: toggleLike,
      onMenu: (anchor) => openTrackMenu(anchor, track, {}),
    });
    row.addEventListener("mouseenter", () => prefetch(track));
    list.append(row);
  });
  card.append(list);
  return card;
}

/** Блок, который придёт позже: сначала строка «Ищу…», потом содержимое или ничего */
function lateSection(body, title, loading) {
  const box = section(title, el("p", "tp-loading", loading));
  body.append(box);
  return {
    fill: (...children) => box.replaceChildren(el("h2", "meta-h", title), ...children),
    drop: () => box.remove(),   // повторный вызов ничего не ломает
  };
}

/** Та же песня (чтобы не показать её саму в «Похожих» и «Ещё у исполнителя») */
function sameAs(track) {
  const key = songKey(track);
  const meta = track.metaId || (isMeta(track) ? track.id : null);
  return (t) => songKey(t) === key || (meta && (t.metaId === meta || (isMeta(t) && t.id === meta)));
}

export async function renderTrack(box, track, stillHere) {
  const shown = displayTrack(track);
  const context = { type: "track", id: keyOf(track), name: shown.title };
  const isThis = () => !!state.current && (keyOf(state.current) === keyOf(track) || songKey(state.current) === songKey(track));

  // ---------- Шапка: сразу, из того, что уже известно ----------
  const hero = el("div", "pl-hero");
  const header = el("header", "pl-header");
  const cover = el("div", "collection-cover album-cover");
  const img = el("img");
  img.alt = "";
  img.src = coverUrl(track, "large");
  img.onerror = () => { img.remove(); cover.classList.add("no-image"); cover.innerHTML = icons.note; };
  cover.append(img);

  const infoBox = el("div", "pl-info");
  const facts = el("div", "pl-meta");
  splitArtists(track, shown.artist).forEach(({ name, id }, i) => {
    if (i) facts.append(document.createTextNode(", "));
    const link = el("button", "meta-artist-link", name);
    link.type = "button";
    if (id) link.dataset.warm = `artist:${id}`;
    link.addEventListener("click", async () => {
      if (!await openArtist({ id, name, track, title: shown.title })) toast(`Не нашёл страницу «${name}»`);
    });
    facts.append(link);
  });
  const factText = document.createTextNode("");
  facts.append(factText);
  // Дата: «вышел …» (точная) → год альбома → «загружен …» (дата загрузки ролика — только если другого нет)
  const factParts = { album: null, release: null, albumYear: null, upload: null, duration: track.duration ? formatTime(track.duration) : "" };
  const albumLink = el("button", "meta-artist-link tp-album", "");
  albumLink.type = "button";
  albumLink.hidden = true;
  let foundAlbum = null;   // альбом, найденный в базе Яндекса для трека не «из базы»
  albumLink.addEventListener("click", () => (foundAlbum ? openAlbumAt(foundAlbum.albumId, `meta:${foundAlbum.trackId}`) : openTrackAlbum(track)));
  const drawFacts = () => {
    const rest = [factParts.release || factParts.albumYear || factParts.upload, factParts.duration].filter(Boolean);
    factText.textContent = factParts.album || rest.length ? " · " : "";
    albumLink.hidden = !factParts.album;
    albumLink.textContent = factParts.album ? `«${factParts.album}»` : "";
    tail.textContent = rest.length ? (factParts.album ? " · " : "") + rest.join(" · ") : "";
  };
  const tail = document.createTextNode("");
  facts.append(albumLink, tail);
  if (track.album) factParts.album = track.album;
  if (track.year) factParts.albumYear = String(track.year);
  drawFacts();
  const stats = el("div", "meta-label tp-stats");
  infoBox.append(el("div", "pl-kind", "Трек"), el("h1", "pl-name", shown.title), facts, stats);
  header.append(cover, infoBox);

  // Кнопки: ▶ (эта песня), ♡, «+» в плейлист, радио, поделиться, «⋯»
  const actions = el("div", "pl-actions");
  const playBtn = el("button", "play big-play");
  playBtn.type = "button";
  playBtn.dataset.collection = `track:${keyOf(track)}`;
  playBtn.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`;
  playBtn.title = "Слушать";
  playBtn.classList.toggle("is-playing", isThis() && isPlaying());
  playBtn.addEventListener("click", () => (isThis() ? togglePlay() : play(track, [track], 0, context)));
  playBtn.addEventListener("mouseenter", () => prefetch(track));
  const like = iconButton(isLiked(track) ? icons.heartFilled : icons.heart, "В избранное", "tp-like");
  const syncLike = () => {
    const on = isLiked(track);
    like.innerHTML = on ? icons.heartFilled : icons.heart;
    like.classList.toggle("on", on);
    like.title = on ? "Убрать из избранного" : "В избранное";
  };
  syncLike();
  like.addEventListener("click", async () => { await toggleLike(track); syncLike(); });
  const add = iconButton(icons.plus, "Добавить в плейлист");
  add.addEventListener("click", () => openAddToPlaylist(add, track));
  const radio = iconButton(icons.flow, "Радио по треку");
  radio.addEventListener("click", async () => startFlow({ track: await resolveMeta(track) || track }));
  const share = iconButton(icons.image, "Поделиться картинкой");
  share.addEventListener("click", async () => openShareCard(track, await resolveMeta(track).catch(() => null) || track));
  const more = iconButton(icons.more, "Ещё");
  more.addEventListener("click", () => openTrackMenu(more, track, {}));
  actions.append(playBtn, like, add, radio, share, more);
  hero.append(header, actions);
  paintHero(hero, coverUrl(track, "large"), shown.title);

  const body = el("div", "pl-body tp-body");
  box.replaceChildren(hero, body);

  // ---------- Настоящая загрузка (у трека «из базы» — найденная пара) ----------
  let real = null;
  const waiting = el("p", "tp-loading", "Загружаю…");   // у трека «из базы» сначала ищется пара (1–3 с)
  body.append(waiting);
  try {
    real = isMeta(track) ? await toReal(track) : track;
  } catch { /* сеть — блоки, которым нужна загрузка, просто не появятся */ }
  waiting.remove();
  if (!stillHere()) return;
  if (isMeta(track) && !real) body.append(el("p", "tp-note", "Этой песни нет ни на YouTube, ни на SoundCloud — послушать не получится."));

  // Порядок блоков на экране задаём сразу, заполняются они по мере готовности
  const credits = real && real.source !== "local" ? lateSection(body, "Кто сделал", "Смотрю описание…") : null;
  const lyricsBox = real ? lateSection(body, "Текст", "Ищу текст…") : null;
  const uploads = real && real.source !== "local" ? lateSection(body, "Другие загрузки", "Ищу другие загрузки…") : null;
  const similar = lateSection(body, "Похожие", "Подбираю похожие…");
  const byArtist = lateSection(body, shown.artist ? `Ещё: ${splitArtists(track, shown.artist)[0]?.name || shown.artist}` : "Ещё у исполнителя", "Загружаю…");
  playlistsBlock(body, track);

  // Сколько слушают, дата, жанр, «кто сделал»
  if (real && real.source !== "local") {
    // Сайт долго не отвечает (бывает 30–40 с) — «Кто сделал» не висит на «Смотрю описание…»: блок убираем,
    // а цифры и дата встанут в шапку, когда ответ всё же придёт
    let late = false, answered = false;
    setTimeout(() => { if (answered) return; late = true; if (stillHere()) credits.drop(); }, 15000);
    trackInfo(real).then((data) => {
      answered = true;
      if (!stillHere()) return;
      const site = SOURCE_NAMES[real.source];
      const bits = [];
      if (data.plays != null) bits.push(`${countText(data.plays, real.source === "youtube" ? "просмотр" : "прослушивание",
        real.source === "youtube" ? "просмотра" : "прослушивания", real.source === "youtube" ? "просмотров" : "прослушиваний")}`);
      if (data.likes != null) bits.push(`${compactNumber(data.likes)} ♥`);
      if (bits.length) bits[bits.length - 1] += ` на ${site}`;
      if (data.genre) bits.push(data.genre);
      if (data.label) bits.push(`℗ ${data.label}`);
      stats.textContent = bits.join(" · ");
      if (data.date) {
        factParts[data.dateKind === "release" ? "release" : "upload"] = `${data.dateKind === "release" ? "вышел" : "загружен"} ${longDate(data.date)}`;
        drawFacts();
      }
      // «При участии» тех, кто уже назван в шапке, не повторяем
      const named = shown.artist.toLowerCase();
      const roles = (data.credits || []).map((c) => (c.role === "При участии"
        ? { ...c, names: c.names.filter((n) => !named.includes(n.toLowerCase())) } : c)).filter((c) => c.names.length);
      if (late || !roles.length) return credits.drop();
      const list = el("dl", "tp-credits");
      for (const c of roles) list.append(el("dt", "", c.role), el("dd", "", c.names.join(", ")));
      credits.fill(list, el("p", "tp-source", `Из названия и описания на ${site}`));
    }).catch(() => { if (stillHere()) credits?.drop(); });
  }

  // Альбом: у трека из базы он уже есть, остальным ищем в базе Яндекса (как «Перейти к альбому»)
  if (!track.album && real?.source !== "local") {
    fetch("/api/track-album", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: shown.artist, title: shown.title, duration: track.duration }),
    }).then((res) => (res.ok ? res.json() : null)).then((found) => {
      if (!stillHere() || !found?.albumTitle) return;
      foundAlbum = found;
      factParts.album = found.albumTitle;
      if (found.year) factParts.albumYear = String(found.year);
      drawFacts();
    }).catch(() => {});
  }

  // Текст: первые строки, «Показать весь»
  if (lyricsBox) {
    fetchLyrics(real).then((data) => {
      if (!stillHere()) return;
      const lines = (data.synced?.length ? data.synced.map(([, w]) => w) : String(data.plain || "").split("\n"))
        .map((s) => String(s).trim());
      while (lines.length && !lines[0]) lines.shift();
      if (!lines.filter(Boolean).length) return lyricsBox.drop();
      const text = el("div", "tp-lyrics");
      const short = lines.length > 8;
      text.textContent = (short ? lines.slice(0, 8) : lines).join("\n");
      const children = [text];
      if (short) {
        const toggle = el("button", "meta-more", "Показать весь");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          const open = toggle.textContent === "Показать весь";
          text.textContent = (open ? lines : lines.slice(0, 8)).join("\n");
          toggle.textContent = open ? "Свернуть" : "Показать весь";
        });
        children.push(toggle);
      }
      lyricsBox.fill(...children);
    }).catch(() => { if (stillHere()) lyricsBox.drop(); });
  }

  // Другие загрузки той же песни (YouTube/SoundCloud, «без цензуры», клип) — как «Трек с цензурой»
  if (uploads) {
    fetch("/api/versions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: real.source, id: real.id, artist: shown.artist, title: shown.title, duration: real.duration || track.duration }),
    }).then((res) => (res.ok ? res.json() : Promise.reject())).then(({ versions }) => {
      if (!stillHere()) return;
      // Только заметные: перезаливы случайных людей (3 прослушивания) и десятки копий хита не нужны
      const top = Math.max(0, ...(versions || []).map((v) => v.plays || 0));
      const list = (versions || []).filter((v) => (v.plays || 0) >= Math.max(1000, top * 0.02))
        .sort((a, b) => (b.plays || 0) - (a.plays || 0)).slice(0, 3);
      if (!list.length) return uploads.drop();
      uploads.fill(rows(list, { ...context, name: `${shown.title} — загрузки` }, { showSource: true }));
      markCurrentRows(state.current ? keyOf(state.current) : null);
    }).catch(() => { if (stillHere()) uploads.drop(); });
  }

  // Похожие: как «Рекомендуемые» под плейлистом — по самой песне; показываем только те, что можно включить
  // Песни того же исполнителя — в «Ещё у …» ниже, здесь — другие люди
  // «key vs. locket» = «keyvslocket»: сравниваем только буквы и цифры
  const bare = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const mainArtist = bare(splitArtists(track, shown.artist)[0]?.name);
  const sameArtist = (t) => !!mainArtist && bare(displayTrack(t).artist.split(/\s*,\s*/)[0]) === mainArtist;
  listRecs([real || track], { size: 24 }).then(async (list) => {
    const base = sameAs(real || track);
    const skip = (t) => base(t) || sameArtist(t);
    // Пары ищем сразу для дюжины кандидатов (по одному — 10–20 с), берём первые 8, которые можно включить
    const found = await Promise.all(list.filter((t) => !skip(t)).slice(0, 12)
      .map((t) => (isMeta(t) ? toReal(t).catch(() => null) : t)));
    const out = found.filter((r) => r && !skip(r)).slice(0, 8);
    if (!stillHere()) return;
    if (!out.length) return similar.drop();
    similar.fill(rows(out, { type: "recs", id: `track-${keyOf(track)}`, name: `Похоже на «${shown.title}»` }));
    markCurrentRows(state.current ? keyOf(state.current) : null);
  }).catch(() => { if (stillHere()) similar.drop(); });

  // Ещё у исполнителя: топ его страницы без этой песни
  (async () => {
    const first = splitArtists(track, shown.artist)[0];
    if (!first?.name) return byArtist.drop();
    const found = first.id ? { id: first.id } : await artistForTrack(first.name, shown.title, track);
    if (!found?.id) return byArtist.drop();
    const a = await load(`/api/artist/${found.id}`);
    if (!stillHere()) return;
    const skip = sameAs(real || track);
    const top = (a.top?.length ? a.top : a.latest || []).filter((t) => !skip(t) && !(real && skip(t))).slice(0, 5);
    if (!top.length) return byArtist.drop();
    const all = el("button", "meta-more", "Страница исполнителя");
    all.type = "button";
    all.addEventListener("click", () => openView(`artist:${found.id}`));
    byArtist.fill(rows(top, { type: "artist", id: found.id, name: a.name || first.name }), all);
    markCurrentRows(state.current ? keyOf(state.current) : null);
  })().catch(() => { if (stillHere()) byArtist.drop(); });
}

/** «В ваших плейлистах»: где эта песня уже лежит (любой загрузкой) */
function playlistsBlock(body, track) {
  const where = [];
  if (twinsIn(lib.liked, track).length) where.push({ name: "Избранное", view: "liked" });
  for (const p of lib.playlists) if (twinsIn(p.tracks, track).length) where.push({ name: p.name, view: `playlist:${p.id}` });
  if (!where.length) return;
  const chips = el("div", "tp-chips");
  for (const w of where) {
    const chip = el("button", "tp-chip", w.name);
    chip.type = "button";
    chip.addEventListener("click", () => openView(w.view));
    chips.append(chip);
  }
  body.append(section("В ваших плейлистах", chips));
}

