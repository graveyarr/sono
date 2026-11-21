// Экран Flow на ПК («Живая обложка», макет design/ui-new/B-ekrany.html#flow).
// Шапка: размытая обложка играющего трека, большое «Flow», ▶ / Пропустить / Не то; справа — «Дальше в потоке»
// (следующие треки и почему Flow их выбрал). Ниже — три режима карточками, «Настроить Flow» (занятие, настроение,
// язык, чему Flow научился), «Flow по исполнителю» и «Flow по плейлисту» рядами карточек.
// Нет вкуса — сначала «С чего начнём?» (выбрать исполнителей). Телефон (шаг 11г) — тот же экран, в одну колонку.

import { toggleDislike } from "./actions.js";
import { headRow } from "./artistlive.js";
import { FLOW_MODES, FLOW_TUNE, flowMode, flowPlaying, flowTune, hasTaste, learnedSummary, resetLearning, seedTaste, setFlowMode,
  setFlowTune, startFlow, tasteArtists, tuneSummary, warmFlow } from "./flow.js";
import { STARTER, loadAvatar } from "./flowview.js";
import { icons } from "./icons.js";
import { lib } from "./library.js";
import { artistByName } from "./meta.js";
import { isPlaying, onPlayState, onTrackChange, playNext, state, togglePlay } from "./player.js";
import { collectionCover, coverUrl, displayTrack, el, plural, toast } from "./ui.js";

const box = document.getElementById("view-flow");
const MODE_SUBS = { liked: "То, что уже нравится", mix: "Любимое и новое", discover: "Кого вы ещё не слышали" };
const NEXT_ROWS = 4;
const mainPlaying = () => flowPlaying() && state.context?.id === "main";
const cssUrl = (url) => `url("${String(url).replace(/["\\\n]/g, encodeURIComponent)}")`;

let ui = null;           // части экрана (строится один раз)
let coversOf = () => []; // обложки для карточек режимов (views.js — те же, что у карточек Flow на главной)

function pill(label, icon, onClick, cls = "") {
  const b = el("button", `pill ${cls}`.trim());
  b.type = "button";
  b.innerHTML = `${icon}<span>${label}</span>`;
  b.addEventListener("click", onClick);
  return b;
}

function build() {
  // ---------- Шапка ----------
  const hero = el("section", "fw-hero");
  const info = el("div", "fw-info");
  const kick = el("div", "fw-kick");
  const sub = el("p", "fw-sub");
  const play = el("button", "fw-play");
  play.type = "button";
  play.innerHTML = `<span class="i-play">${icons.play}</span><span class="i-pause">${icons.pause}</span>`;
  play.addEventListener("click", () => {
    if (flowPlaying()) return togglePlay();
    if (!hasTaste()) return ui.starter.scrollIntoView({ behavior: "smooth", block: "center" });
    startFlow({ mode: flowMode() });
  });
  play.addEventListener("pointerenter", () => warmFlow());
  const skip = pill("Пропустить", icons.next, () => { if (flowPlaying()) playNext(); });
  skip.title = "Следующий трек Flow (пропуск в первые 30 секунд — Flow запомнит)";
  const dislike = pill("Не то", icons.dislike, () => { if (flowPlaying() && state.current) toggleDislike(state.current); });
  dislike.title = "Не нравится — Flow больше не поставит этот трек";
  const acts = el("div", "fw-acts");
  acts.append(play, skip, dislike);
  info.append(kick, el("h1", "fw-title", "Flow"), sub, acts);
  const next = el("div", "fw-next");
  hero.append(info, next);

  // ---------- Нет вкуса: выбрать исполнителей ----------
  const starter = el("section", "fw-starter glass");

  // ---------- Режимы ----------
  const modes = el("div", "fw-modes");
  for (const m of FLOW_MODES) {
    const card = el("button", "fl-card fw-mode");
    card.type = "button";
    card.dataset.mode = m.value;
    card.title = m.hint;
    const ck = el("span", "fw-ck");
    ck.innerHTML = icons.check;
    card.append(el("span", "fl-bg"), el("b", "", m.title), el("span", "fl-sub", MODE_SUBS[m.value] ?? m.hint), ck);
    card.addEventListener("pointerenter", () => { if (!flowPlaying()) warmFlow(m.value); });
    card.addEventListener("click", () => {
      if (m.value === flowMode()) return;
      setFlowMode(m.value);
      if (mainPlaying()) toast(`Flow: «${m.title}» — со следующего трека`);
      sync();
    });
    modes.append(card);
  }

  // ---------- Настроить Flow ----------
  const tune = el("section", "fw-tune glass");
  const lead = el("div", "fw-tune-lead");
  lead.append(el("h3", "", "Настроить Flow"), el("span", "", "меняется сразу, со следующего трека"));
  tune.append(lead);
  for (const row of FLOW_TUNE) {
    const col = el("div", "fw-tune-col");
    const chips = el("div", "fw-chips");
    for (const [value, label] of row.options) {
      const b = el("button", "fw-chip", label);
      b.type = "button";
      b.dataset.key = row.key;
      b.dataset.value = value;
      b.addEventListener("click", () => {
        if ((flowTune()[row.key] ?? "any") === value) return;
        setFlowTune(row.key, value);
        if (mainPlaying()) toast(`Flow: ${tuneSummary() || "без настроек"} — со следующего трека`);
        sync();
      });
      chips.append(b);
    }
    col.append(el("h5", "", row.title), chips);
    tune.append(col);
  }
  const learn = el("div", "fw-tune-col fw-learn");
  tune.append(learn);

  // ---------- Flow по исполнителю и по плейлисту ----------
  const artists = el("div");
  const playlists = el("div");

  const root = el("div", "fw-live");
  root.append(hero, starter, modes, tune, artists, playlists);
  ui = { root, hero, kick, sub, play, skip, dislike, next, starter, modes, tune, learn, artists, playlists };
}

// ---------- «С чего начнём?» ----------

function fillStarter() {
  const show = !hasTaste();
  ui.starter.hidden = !show;
  if (!show || ui.starter.childElementCount) return;
  const picked = new Map();
  const go = el("button", "pill solid fw-start");
  go.type = "button";
  const update = () => {
    go.disabled = !picked.size;
    go.textContent = picked.size ? `Начать Flow · ${plural(picked.size, "исполнитель", "исполнителя", "исполнителей")}` : "Выберите хотя бы одного";
  };
  update();
  const chips = el("div", "fw-chips fw-pick");
  for (const name of STARTER) {
    const chip = el("button", "fw-chip pick");
    chip.type = "button";
    const pic = el("span", "fw-chip-pic", name.slice(0, 1).toUpperCase());
    chip.append(pic, el("span", "", name));
    loadAvatar(name, pic);
    chip.addEventListener("click", () => {
      if (picked.has(name)) picked.delete(name); else picked.set(name, { name });
      chip.classList.toggle("on", picked.has(name));
      update();
    });
    chips.append(chip);
  }
  go.addEventListener("click", () => {
    seedTaste([...picked.values()]);
    ui.starter.hidden = true;
    startFlow({ mode: flowMode() });
    fillLists();
    sync();
  });
  const lead = el("div", "fw-tune-lead");
  lead.append(el("h3", "", "С чего начнём?"), el("span", "", "выберите исполнителей, которые вам нравятся, — Flow начнёт с похожего и будет учиться на вас"));
  ui.starter.append(lead, chips, go);
}

// ---------- Ряды «по исполнителю» и «по плейлисту» ----------

function artistCard({ name, id }) {
  const card = el("button", "home-card live-artist-card");
  card.type = "button";
  const art = el("span", "home-card-art fw-letter", name.slice(0, 1).toUpperCase());
  card.append(art, el("span", "home-card-title", name), el("span", "home-card-artist", "Flow"));
  card.title = `Flow по исполнителю «${name}»`;
  // Не нашёлся в базе (часто это название YouTube-канала, а не исполнитель) — карточку убираем
  loadAvatar(name, art, () => card.remove());
  card.addEventListener("click", async () => {
    const found = id ? { id, name } : await artistByName(name).catch(() => null);
    if (!found?.id) return toast(`Не нашёл «${name}» в базе`, { error: true });
    startFlow({ artist: { id: found.id, name: found.name || name } });
  });
  return card;
}

function playlistCard(id, name, tracks, cover = null) {
  const card = el("button", "home-card fw-pl-card");
  card.type = "button";
  const art = el("span", "home-card-art");
  art.append(collectionCover(id === "liked" ? "liked" : "playlist", { name, tracks, cover }));
  card.append(art, el("span", "home-card-title", name), el("span", "home-card-artist", plural(tracks.length, "трек", "трека", "треков")));
  card.title = `Flow по плейлисту «${name}»`;
  card.addEventListener("click", () => startFlow({ playlist: { id, name, tracks } }));
  return card;
}

function fillLists() {
  // Названия каналов («Официальный канал группы…», «… Official Channel») — не исполнители
  const notChannel = (a) => !/официальн\w*\s+канал|\bканал\b|official\s+(youtube\s+)?channel/i.test(a.name);
  const artists = tasteArtists(14).filter(notChannel).slice(0, 12);
  const aSec = el("section", "meta-section");
  const aRow = el("div", "pl-more-row");
  aRow.append(...artists.map(artistCard));
  aSec.append(headRow("Flow по исполнителю", el("span", "live-h-sub", "похожая музыка от одного имени")),
    artists.length ? aRow : el("p", "fw-empty", "Здесь появятся ваши исполнители — послушайте и полайкайте что-нибудь."));
  ui.artists.replaceChildren(aSec);

  const lists = [];
  if (lib.liked.length) lists.push(playlistCard("liked", "Избранное", lib.liked));
  lib.playlists.filter((p) => p.tracks.length).forEach((p) => lists.push(playlistCard(p.id, p.name, p.tracks, p.cover)));
  const pSec = el("section", "meta-section");
  const pRow = el("div", "pl-more-row");
  pRow.append(...lists);
  pSec.append(headRow("Flow по плейлисту", el("span", "live-h-sub", "музыка в духе плейлиста")),
    lists.length ? pRow : el("p", "fw-empty", "Создайте плейлист — и Flow сможет играть музыку в его духе."));
  ui.playlists.replaceChildren(pSec);

  // Чему Flow научился — четвёртая колонка «Настроить Flow»
  const { more, less } = learnedSummary();
  const parts = [more && `${plural(more, "исполнитель звучит", "исполнителя звучат", "исполнителей звучат")} чаще`,
    less && `${more ? "" : `${plural(less, "исполнитель звучит", "исполнителя звучат", "исполнителей звучат")} `}${more ? `${less} — ` : ""}реже`].filter(Boolean);
  const text = el("p", "fw-learn-text", parts.length
    ? `${parts.join(", ")}: так Flow запомнил ваши пропуски и дослушивания.`
    : "Пропущенное в первые 30 секунд звучит реже, дослушанное — чаще.");
  ui.learn.replaceChildren(el("h5", "", "Flow учится на вас"), text);
  if (more || less) {
    const reset = el("button", "meta-more fw-reset", "Начать заново");
    reset.type = "button";
    reset.addEventListener("click", () => { resetLearning(); fillLists(); toast("Flow забыл пропуски и дослушивания"); });
    ui.learn.append(reset);
  }
}

// ---------- Что играет и что дальше ----------

/** «похоже на bladee» — с маленькой буквы, как пометка */
const whyText = (because) => (because ? because.replace(/^Рекомендация · /, "").replace(/^./, (c) => c.toLowerCase()) : "");

function nextRow(t) {
  const shown = displayTrack(t);
  const row = el("div", "fw-row");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = coverUrl(t);
  img.onerror = () => img.classList.add("broken");
  const text = el("div", "fw-row-text");
  text.append(el("b", "", shown.title), el("span", "", shown.artist));
  row.append(img, text);
  const why = whyText(t.because);
  if (why) row.append(el("span", "fw-why", why));
  row.title = `${shown.artist} — ${shown.title}${t.because ? ` · ${t.because}` : ""}`;
  return row;
}

function sync() {
  if (!ui || !ui.root.isConnected) return;
  const mode = flowMode();
  const m = FLOW_MODES.find((x) => x.value === mode);
  const playing = flowPlaying();
  const t = state.current;
  // Фон шапки — обложка того, что играет (или ничего: тогда цветные пятна)
  const url = t ? coverUrl(t, "large") : "";
  const want = url ? cssUrl(url) : "";
  if (ui.hero.style.getPropertyValue("--img") !== want) ui.hero.style.setProperty("--img", want);
  ui.hero.classList.toggle("no-img", !url);
  ui.kick.textContent = playing ? (state.context?.id === "main" ? `Сейчас играет Flow · «${m?.title ?? ""}»` : `Сейчас играет · ${state.context?.name ?? "Flow"}`)
    : `Flow · «${m?.title ?? ""}»`;
  const tuned = tuneSummary();
  ui.sub.replaceChildren(document.createTextNode(`Бесконечно и под ваш вкус: ${(m?.hint ?? "").replace(/^./, (c) => c.toLowerCase())}.`));
  if (tuned) ui.sub.append(el("br"), document.createTextNode(`Настроено: ${tuned}.`));
  ui.play.classList.toggle("is-playing", playing && isPlaying());
  ui.play.title = playing ? (isPlaying() ? "Пауза" : "Продолжить") : "Слушать Flow";
  ui.skip.hidden = ui.dislike.hidden = !playing;

  // «Дальше в потоке» — только пока играет Flow
  const upcoming = playing ? state.queue.slice(state.index + 1, state.index + 1 + NEXT_ROWS) : [];
  ui.hero.classList.toggle("has-next", playing);
  if (playing) {
    ui.next.replaceChildren(el("h5", "", "Дальше в потоке"),
      ...(upcoming.length ? upcoming.map(nextRow) : [el("p", "fw-next-wait", "Подбираю следующие треки…")]));
  } else ui.next.replaceChildren();

  ui.modes.querySelectorAll(".fw-mode").forEach((c) => c.classList.toggle("on", c.dataset.mode === mode));
  const covers = coversOf();
  ui.modes.querySelectorAll(".fw-mode").forEach((card, i) => {
    const img = covers[i] ? cssUrl(covers[i]) : "";
    if (card.style.getPropertyValue("--img") !== img) card.style.setProperty("--img", img);
    card.classList.toggle("no-img", !img);
  });
  const tune = flowTune();
  ui.tune.querySelectorAll(".fw-chip").forEach((b) => b.classList.toggle("on", (tune[b.dataset.key] ?? "any") === b.dataset.value));
}

/** Обложки карточек режимов досчитались (views.js) — перекрасить */
export function syncFlowLive() { sync(); }

let listening = false;
export function renderFlowLive({ covers } = {}) {
  if (covers) coversOf = covers;
  if (!ui) build();
  if (!listening) {
    listening = true;
    onTrackChange(sync);   // и смена трека, и пополнение очереди
    onPlayState(sync);
  }
  box.replaceChildren(ui.root);
  fillStarter();
  fillLists();
  sync();
}
