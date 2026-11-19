// Страница исполнителя на ПК («Живая обложка», макет design/ui-new/B-ekrany.html#artist).
// Шапка: размытое фото фоном, круглое фото, имя, слушатели, «Вы слушаете с …», кнопки; справа — новинка.
// Ниже: треки (Популярные / По прослушиваниям / Новые / Вы слушали) и «Об исполнителе» с цифрами,
// «Альбомы и синглы» одним рядом (Всё / Альбомы / Синглы и EP, «Все N»), «Похожие исполнители».
// На телефоне — прежняя страница (artist.js renderArtist); какую показать, решает views.js.

import { openTrackMenu, toggleLike } from "./actions.js";
import { TYPE_NAMES, failBox, load, picture, prefetchTop, releaseCard } from "./artist.js";
import { startFlow } from "./flow.js";
import { icons, sourceIcons } from "./icons.js";
import { isFollowing, keyOf, toggleFollow } from "./library.js";
import { openTrack, openView } from "./nav.js";
import { isPlaying, play, prefetch, queueLater, queueNext, state, togglePlay } from "./player.js";
import { fillPlays, loadPlays, playsOf } from "./plays.js";
import { bigPill, colsClass, playPill } from "./plcard.js";
import { artistLikedCount, artistStats, artistStatsLine, artistTracks } from "./stats.js";
import { compactNumber, coverUrl, displayTrack, el, formatTime, imgUrl, markCurrentRows, openMenu, plural, toast, trackRow } from "./ui.js";

const SHORT_MONTHS = ["янв.", "февр.", "марта", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."];
const LONG_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const contextKey = (ctx) => `${ctx.type}:${ctx.id}`;
const playingFrom = (ctx) => !!state.current && state.context && contextKey(state.context) === contextKey(ctx);
const shuffled = (list) => {
  const i = Math.floor(Math.random() * list.length);
  return { first: list[i], queue: [list[i], ...list.filter((_, n) => n !== i).sort(() => Math.random() - 0.5)] };
};

/** Слово к числу: 6 741 подписчик, 12 тыс. слушателей (у сокращённого числа — всегда «многих», как у countText) */
const wordFor = (n, one, few, many) => (n >= 1e4 ? many : plural(n, one, few, many).replace(/^\S+\s/, ""));

/** «6 ноября» (в этом году) / «6 ноября 2025»; short — «6 нояб.» / «2025» */
function dayText(iso, short = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return "";
  const thisYear = +m[1] === new Date().getFullYear();
  if (short) return thisYear ? `${+m[3]} ${SHORT_MONTHS[+m[2] - 1]}` : m[1];
  return `${+m[3]} ${LONG_MONTHS[+m[2] - 1]}${thisYear ? "" : ` ${m[1]}`}`;
}

/** Переключатель-«капсула» (Популярные | Вы слушали…): [[подпись, значение]], текущее, щелчок */
export function segment(options, current, onPick) {
  const seg = el("div", "seg live-seg");
  for (const [label, value] of options) {
    const b = el("button", `seg-btn${value === current ? " on" : ""}`, label);
    b.type = "button";
    b.dataset.value = value;
    b.addEventListener("click", () => {
      if (b.classList.contains("on")) return;
      seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
      onPick(value, b);
    });
    seg.append(b);
  }
  return seg;
}

/** Заголовок раздела: «Популярные треки» [переключатель] … [ссылка справа] */
export function headRow(title, ...rest) {
  const head = el("div", "meta-h-row live-h");
  head.append(el("h2", "meta-h", title), ...rest.filter(Boolean));
  return head;
}

export async function renderArtistLive(box, id, stillHere) {
  box.replaceChildren(el("p", "meta-loading", "Загружаю исполнителя…"));
  let a;
  try {
    a = await load(`/api/artist/${id}`);
  } catch (err) {
    if (stillHere()) box.replaceChildren(failBox("исполнителя", err, () => renderArtistLive(box, id, stillHere)));
    return;
  }
  if (!stillHere()) return;
  const context = { type: "artist", id: a.id, name: a.name };
  const fromSc = a.source === "soundcloud";
  const root = el("div", "ar-live");
  root.append(hero(a, context, fromSc));

  // ---------- Треки и «Об исполнителе» ----------
  const grid = el("div", "ar-grid");
  const tracksBox = tracksBlock(a, context, stillHere);
  const about = aboutBox(a, fromSc);
  grid.append(...[tracksBox, about].filter(Boolean));
  grid.classList.toggle("single", !tracksBox || !about);
  if (tracksBox || about) root.append(grid);

  // ---------- Альбомы и синглы ----------
  const disco = el("div");
  root.append(disco);
  let discoKind = "all", discoAll = false;
  const drawDiscography = (releases) => {
    if (!releases.length) return disco.replaceChildren();
    const albums = releases.filter((r) => r.type === "album" || r.type === "compilation");
    const singles = releases.filter((r) => r.type === "single" || r.type === "ep");
    const row = el("div", "pl-more-row");
    const more = el("button", "meta-more", "");
    more.type = "button";
    const fill = () => {
      const list = discoKind === "albums" ? albums : discoKind === "singles" ? singles : releases;
      // На странице артиста SoundCloud оттуда всё — значок «с SoundCloud» не нужен
      row.replaceChildren(...list.map((r) => releaseCard(r, !fromSc)));
      row.classList.toggle("all", discoAll);
      more.hidden = list.length <= 4;
      more.textContent = discoAll ? "Свернуть" : `Все ${list.length}`;
    };
    more.addEventListener("click", () => { discoAll = !discoAll; fill(); });
    const seg = albums.length && singles.length
      ? segment([["Всё", "all"], ["Альбомы", "albums"], ["Синглы и EP", "singles"]], discoKind, (v) => { discoKind = v; fill(); })
      : null;
    fill();
    const sec = el("section", "meta-section");
    sec.append(headRow("Альбомы и синглы", seg, more), row);
    disco.replaceChildren(sec);
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

  // ---------- Похожие исполнители ----------
  if (a.related?.length) {
    const row = el("div", "pl-more-row");
    for (const r of a.related) {
      const card = el("button", "home-card live-artist-card");
      card.type = "button";
      card.append(picture(r.picture, "home-card-art", r.name), el("span", "home-card-title", r.name), el("span", "home-card-artist", "Исполнитель"));
      card.title = r.name;
      card.dataset.warm = `artist:${r.id}`;
      card.addEventListener("click", () => openView(`artist:${r.id}`));
      row.append(card);
    }
    const sec = el("section", "meta-section");
    sec.append(headRow("Похожие исполнители"), row);
    root.append(sec);
  }

  box.replaceChildren(root);
  markCurrentRows(state.current ? keyOf(state.current) : null);
  prefetchTop(a.top, stillHere);
}

// ---------- Шапка ----------

function hero(a, context, fromSc) {
  const section = el("section", "ar-hero");
  const big = a.pictureLarge || a.picture;
  if (big) section.style.setProperty("--img", `url("${imgUrl(big)}")`);
  const info = el("div", "ar-info");
  info.append(el("div", "pl-kind ar-kind", fromSc ? "Исполнитель · SoundCloud" : "Исполнитель · Яндекс Музыка"),
    el("h1", "ar-name", a.name));

  // «12 тыс. слушателей за месяц ▲ 13 % · 58 лайков · 30 треков»
  const stat = el("div", "ar-stat");
  const count = fromSc ? a.followers : a.listeners;
  if (count) {
    const words = fromSc ? `${wordFor(count, "подписчик", "подписчика", "подписчиков")} на SoundCloud`
      : `${wordFor(count, "слушатель", "слушателя", "слушателей")} за месяц`;
    const line = el("span");
    line.append(el("b", "", compactNumber(count)), ` ${words}`);
    if (!fromSc) line.title = "По данным Яндекс Музыки";
    stat.append(line);
    if (!fromSc && a.listenersDelta && a.listeners) {
      const pct = (a.listenersDelta / (a.listeners - a.listenersDelta)) * 100;
      if (Math.abs(pct) >= 0.5) {
        const trend = el("span", `ar-trend ${pct > 0 ? "up" : "down"}`, `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0).replace(".", ",")} %`);
        trend.title = `${pct > 0 ? "+" : "−"}${compactNumber(Math.abs(a.listenersDelta))} за месяц`;
        stat.append(trend);
      }
    }
  }
  const facts = [a.likes ? plural(a.likes, "лайк", "лайка", "лайков") : "", a.tracksTotal ? plural(a.tracksTotal, "трек", "трека", "треков") : ""].filter(Boolean);
  if (facts.length) stat.append(el("span", "", `${count ? "· " : ""}${facts.join(" · ")}`));
  if (stat.childNodes.length) info.append(stat);

  // «Вы слушаете с 17 ноября · 2 ч · 31 прослушивание»
  const mine = artistStatsLine({ id: a.id, name: a.name });
  if (mine) {
    const since = el("div", "ar-since");
    since.innerHTML = icons.clock;
    since.append(el("span", "", mine));
    info.append(since);
  }

  // Кнопки: Играть, Вперемешку, Flow, Следить за новинками, «⋯»
  const tracks = a.top.length ? a.top : a.latest || [];   // у артиста SoundCloud популярных может не быть
  const acts = el("div", "pl-acts ar-acts");
  const playBtn = playPill(contextKey(context), () => (playingFrom(context) ? togglePlay() : play(tracks[0], tracks.slice(), 0, context)));
  playBtn.disabled = !tracks.length;
  playBtn.classList.toggle("is-playing", playingFrom(context) && isPlaying());
  playBtn.addEventListener("mouseenter", () => prefetch(tracks[0]));
  const shuffle = bigPill("Вперемешку", icons.shuffle, () => { const s = shuffled(tracks); play(s.first, s.queue, 0, context); });
  shuffle.disabled = tracks.length < 2;
  const flow = bigPill("Flow", icons.flow, () => startFlow({ artist: { id: a.id, name: a.name } }));
  flow.title = `Бесконечный поток: ${a.name} и похожие`;
  // Подписка: новинки этого исполнителя появятся на «Главной» и в «Новинках», о новом релизе Sono напомнит
  const follow = bigPill("", icons.bell, () => {
    const on = toggleFollow({ id: a.id, name: a.name, picture: a.picture });
    drawFollow();
    toast(on ? `Следим за ${a.name}: новые релизы — на «Главной» и в «Новинках»` : `Больше не следим за ${a.name}`);
  });
  const drawFollow = () => {
    const on = isFollowing(a.id);
    follow.classList.toggle("on", on);
    follow.querySelector("span").textContent = on ? "Вы следите" : "Следить за новинками";
    follow.title = on ? "Не следить" : "Новые релизы — на «Главной» и в «Новинках»";
  };
  drawFollow();
  const more = el("button", "pill big ic");
  more.type = "button";
  more.innerHTML = icons.more;
  more.title = "Ещё";
  more.addEventListener("click", () => openMenu(more, [
    { label: "Играть следующими", icon: icons.playNext, disabled: !tracks.length, action: () => { tracks.slice(0, 10).reverse().forEach((t) => queueNext(t)); toast(`${a.name} — играет следующим`); } },
    { label: "В очередь", icon: icons.queue, disabled: !tracks.length, action: () => { queueLater(tracks.slice(0, 10)); toast(`${a.name} — в очереди`); } },
    ...(a.link ? [{ label: "Открыть на SoundCloud", icon: sourceIcons.soundcloud, action: () => window.open(a.link, "_blank") }] : []),
  ]));
  acts.append(playBtn, shuffle, flow, follow, more);
  info.append(acts);

  section.append(picture(a.pictureLarge, "ar-photo", a.name), info);
  const fresh = freshCard(a, context);
  if (fresh) section.append(fresh);
  section.classList.toggle("no-fresh", !fresh);
  return section;
}

/** Справа в шапке — новинка: релиз за 3 месяца (Яндекс) или свежий трек (SoundCloud) */
function freshCard(a, context) {
  const r = a.newRelease;
  const t = !r && a.source === "soundcloud" ? a.latest?.[0] : null;
  if (!r && !t) return null;
  const card = el("div", "ar-fresh glass");
  card.tabIndex = 0;
  const text = el("div", "ar-fresh-text");
  const listen = el("button", "pill solid ar-fresh-play");
  listen.type = "button";
  listen.innerHTML = `${icons.play}<span>Слушать</span>`;
  if (r) {
    const when = dayText(r.date) || r.year || "";
    text.append(el("span", "ar-badge", `Новинка · ${TYPE_NAMES[r.type] ?? "Альбом"}`), el("b", "", r.title),
      el("span", "ar-fresh-sub", [when, r.tracks ? plural(r.tracks, "трек", "трека", "треков") : ""].filter(Boolean).join(" · ")), listen);
    card.prepend(picture(r.cover, "ar-fresh-art", r.title));
    card.title = r.title;
    card.dataset.warm = `album:${r.id}`;
    card.addEventListener("click", () => openView(`album:${r.id}`));
    listen.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const album = await load(`/api/album/${r.id}`);
        if (album.tracks.length) play(album.tracks[0], album.tracks.slice(), 0, { type: "album", id: album.id, name: album.title });
      } catch { toast("Не получилось открыть релиз"); }
    });
  } else {
    const shown = displayTrack(t);
    const ctx = { type: "artist", id: `${a.id}-new`, name: `${a.name} · новые треки` };
    text.append(el("span", "ar-badge", "Новинка · Трек"), el("b", "", shown.title),
      el("span", "ar-fresh-sub", [t.duration ? formatTime(t.duration) : "", "SoundCloud"].filter(Boolean).join(" · ")), listen);
    const art = el("div", "ar-fresh-art");
    const img = el("img");
    img.alt = "";
    img.src = coverUrl(t, "large");
    img.onerror = () => img.remove();
    art.append(img);
    card.prepend(art);
    card.title = shown.title;
    card.addEventListener("click", () => openTrack(t));
    listen.addEventListener("click", (e) => { e.stopPropagation(); play(t, a.latest.slice(), 0, ctx); });
    card.addEventListener("mouseenter", () => prefetch(t));
  }
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === card) card.click(); });
  card.append(text);
  return card;
}

// ---------- Треки: Популярные / По прослушиваниям / Новые / Вы слушали ----------

function tracksBlock(a, context, stillHere) {
  const mine = artistTracks({ name: a.name });
  const options = [];
  if (a.top.length) options.push(["Популярные", "top"]);
  if (a.top.length > 1) options.push(["По прослушиваниям", "plays"]);
  if (a.latest?.length) options.push(["Новые", "latest"]);
  if (mine.length) options.push(["Вы слушали", "mine"]);
  if (!options.length) return null;
  let mode = options[0][1];
  let shown = 5;
  let drawn = "";   // какие треки видны и в каком порядке — чтобы не перерисовывать зря
  const contexts = {
    top: context, plays: context,
    latest: { type: "artist", id: `${a.id}-new`, name: `${a.name} · новые треки` },
    mine: { type: "artist", id: `${a.id}-mine`, name: `${a.name} · вы слушали` },
  };
  const order = () => (mode === "plays" ? a.top.slice().sort((x, y) => (playsOf(y) ?? -1) - (playsOf(x) ?? -1))
    : mode === "latest" ? a.latest : mode === "mine" ? mine : a.top);
  const cols = { album: false, added: false };
  const holder = el("div");
  const render = () => {
    const tracks = order();
    const ctx = contexts[mode];
    const list = el("ol", "tracklist");
    tracks.slice(0, shown).forEach((track, i) => {
      const row = trackRow(track, {
        index: i, numbered: true, cols,
        onPlay: () => play(track, tracks.slice(), i, ctx),
        onLike: toggleLike,
        onMenu: (anchor) => openTrackMenu(anchor, track, {}),
      });
      row.addEventListener("mouseenter", () => prefetch(track));
      list.append(row);
    });
    const card = el("div", `tracklist-card glass ${colsClass(cols)}`);
    card.append(list);
    holder.replaceChildren(card);
    if (tracks.length > 5) {
      const more = el("button", "meta-more", shown < tracks.length ? "Ещё" : "Свернуть");
      more.type = "button";
      more.addEventListener("click", () => { shown = shown < tracks.length ? Math.min(tracks.length, 50) : 5; draw(); });
      holder.append(more);
    }
    fillPlays(card, tracks);
    markCurrentRows(state.current ? keyOf(state.current) : null);
    drawn = tracks.slice(0, shown).map(keyOf).join("|");
  };
  // Числа пришли: в порядке «по прослушиваниям» треки могли поменяться местами — перерисовать, иначе вписать числа
  const refresh = () => {
    if (!stillHere() || !holder.isConnected) return;
    const tracks = order();
    if (mode === "plays" && tracks.slice(0, shown).map(keyOf).join("|") !== drawn) render();
    else { const card = holder.querySelector(".tracklist-card"); if (card) fillPlays(card, tracks); }
  };
  const draw = () => {
    render();
    loadPlays(order().slice(0, shown), { resolve: true, alive: stillHere, onUpdate: refresh });
  };
  const seg = options.length > 1 ? segment(options, mode, async (value, b) => {
    mode = value;
    shown = 5;
    draw();
    if (mode !== "plays") return;
    // Остальным популярным (до 50) ищем пары по 4 сразу — список пересортировывается по мере готовности
    b.classList.add("busy");
    await loadPlays(a.top, { resolve: true, alive: () => stillHere() && mode === "plays", onUpdate: refresh });
    b.classList.remove("busy");
  }) : null;
  draw();
  const titles = { top: "Популярные треки", plays: "Популярные треки", latest: "Новые треки", mine: "Популярные треки" };
  const box = el("section", "ar-tracks");
  box.append(headRow(options.length > 1 ? "Популярные треки" : titles[mode], seg), holder);
  return box;
}

// ---------- Об исполнителе ----------

function aboutBox(a, fromSc) {
  const facts = [];
  const count = fromSc ? a.followers : a.listeners;
  if (count) facts.push([compactNumber(count), fromSc ? `${wordFor(count, "подписчик", "подписчика", "подписчиков")} на SoundCloud`
    : `${wordFor(count, "слушатель", "слушателя", "слушателей")} за месяц`]);
  const last = (a.releases || []).map((r) => r.date || "").filter(Boolean).sort().pop();
  if (last) facts.push([dayText(last, true), "последний релиз"]);
  const st = artistStats({ id: a.id, name: a.name });
  if (st?.plays) facts.push([String(st.plays), wordFor(st.plays, "ваше прослушивание", "ваших прослушивания", "ваших прослушиваний")]);
  const liked = artistLikedCount({ name: a.name });
  if (liked) facts.push([String(liked), `${wordFor(liked, "трек", "трека", "треков")} в «Избранном»`]);
  if (!a.bio && !facts.length) return null;

  const box = el("aside", "ar-about glass");
  box.append(el("h2", "meta-h", "Об исполнителе"));
  if (a.bio) {
    const text = el("p", "ar-bio collapsed", a.bio);
    box.append(text);
    const foot = el("div", "ar-bio-foot");
    const toggle = el("button", "meta-more", "Читать полностью");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      const closed = text.classList.toggle("collapsed");
      toggle.textContent = closed ? "Читать полностью" : "Свернуть";
    });
    foot.append(toggle);
    if (a.bioSource) foot.append(el("span", "ar-bio-source", `Источник: ${a.bioSource}`));
    box.append(foot);
    // Короткая биография помещается целиком — кнопка не нужна
    requestAnimationFrame(() => { if (text.scrollHeight <= text.clientHeight + 2) toggle.hidden = true; });
  }
  if (facts.length) {
    const grid = el("div", "ar-facts");
    for (const [big, label] of facts) {
      const cell = el("div");
      cell.append(el("b", "", big), el("span", "", label));
      grid.append(cell);
    }
    box.append(grid);
  }
  return box;
}
