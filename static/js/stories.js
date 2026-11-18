// Праздничные «сторис» большого обновления (1.0): после обновления один раз, перед обычным «Что нового».
// Слайды — поле stories у записи в changelog.js: {art, title, text, mobile, kicker}. art — какая картинка
// нарисуется сверху (живой кусочек Sono из обложек вашей медиатеки, см. ART ниже).
// Полоски сверху: слайд листается сам; касание/щелчок справа — дальше, слева — назад, удержание — пауза.
// На ПК — карточка 9:16 по центру и стрелки по бокам, на телефоне — во весь экран.

import { isMobile, openExternal } from "./device.js";
import { icons, sourceIcons } from "./icons.js";
import { keyOf, lib, motionOff } from "./library.js";
import { coverUrl, displayTrack, el } from "./ui.js";

const HOLD = 220;   // дольше — это удержание (пауза), а не касание

/** Текст слайда для этого устройства: mobile — свой текст для телефона, false — слайд только для ПК */
const textOf = (slide) => (isMobile && slide.mobile !== undefined ? slide.mobile : slide.text);

/** Сколько показывать слайд: чем больше текста, тем дольше (4–9 с) */
const durationOf = (slide) => Math.min(9000, 4000 + String(textOf(slide) || "").length * 28 + (slide.items?.length ?? 0) * 900);

// ---------- Обложки для картинок ----------

/** До 8 треков из медиатеки (♡, история, плейлисты) — чтобы картинки были про вашу музыку */
function myTracks() {
  const seen = new Set(), out = [];
  for (const t of [...lib.liked, ...lib.history, ...lib.playlists.flatMap((p) => p.tracks ?? [])]) {
    if (!t?.id || !t.source || t.source === "local" || seen.has(keyOf(t))) continue;
    seen.add(keyOf(t));
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** Обложка: картинка трека или цветной квадрат с нотой, если медиатека пуста */
function cover(track, className = "st-cover", hue = 265) {
  const box = el("div", className);
  box.style.setProperty("--st-c", hue);
  if (track) {
    const img = el("img");
    img.alt = "";
    img.loading = "eager";
    img.src = coverUrl(track, "small");
    img.addEventListener("error", () => img.remove(), { once: true });
    box.append(img);
  } else {
    box.innerHTML = icons.note;
  }
  return box;
}

const bar = (cls = "") => el("i", `st-line ${cls}`.trim());
const name = (t, fallback) => (t ? displayTrack(t) : fallback);
const icon = (svg, cls = "st-ico") => { const s = el("span", cls); s.innerHTML = svg ?? ""; return s; };

// ---------- Картинки слайдов ----------

const ART = {
  intro() {
    const art = el("div", "st-art st-intro");
    const logo = el("div", "st-logo");
    [..."sono"].forEach((ch, i) => { const s = el("span", "", ch); s.style.setProperty("--i", i); logo.append(s); });
    logo.append(el("span", "st-dot"));
    art.append(logo, el("div", "st-ver", "1.0"));
    return art;
  },

  track(tracks) {
    const t = tracks[0];
    const { title, artist } = name(t, { title: "Название трека", artist: "Исполнитель" });
    const art = el("div", "st-art st-mock");
    const head = el("div", "st-row");
    const words = el("div", "st-words");
    words.append(el("div", "st-t", title), el("div", "st-a", artist));
    head.append(cover(t, "st-cover big"), words);
    const credits = el("div", "st-credits");
    for (const [label, w] of [["prod.", 62], ["вышел", 44], ["лейбл", 52]]) {
      const row = el("div", "st-credit");
      row.append(el("span", "", label), bar());
      row.lastChild.style.width = `${w}%`;
      credits.append(row);
    }
    const lyric = el("div", "st-lyric");
    lyric.append(bar(), bar("short"), bar());
    art.append(head, credits, lyric);
    return art;
  },

  releases(tracks) {
    const art = el("div", "st-art st-mock");
    art.append(el("div", "st-label", "На этой неделе"));
    const row = el("div", "st-cards");
    for (let i = 0; i < 3; i++) {
      const card = el("div", "st-card");
      card.style.setProperty("--i", i);
      const c = cover(tracks[i + 1] ?? tracks[i], "st-cover", [25, 265, 200][i]);
      if (i !== 1) c.append(icon(sourceIcons.soundcloud, "st-badge"));
      card.append(c, bar(), bar("short"));
      row.append(card);
    }
    art.append(row);
    return art;
  },

  share(tracks) {
    const t = tracks[2] ?? tracks[0];
    const { title, artist } = name(t, { title: "Название трека", artist: "Исполнитель" });
    const art = el("div", "st-art");
    const card = el("div", "st-share");
    const back = cover(t, "st-share-bg", 320);
    const words = el("div", "st-words");
    words.append(el("div", "st-t", title), el("div", "st-a", artist));
    card.append(back, cover(t, "st-cover big", 320), words, el("div", "st-quote", "«строчка из песни»"), el("div", "st-mark", "sono."));
    art.append(card);
    return art;
  },

  links(tracks) {
    const art = el("div", "st-art st-mock");
    const field = el("div", "st-field");
    field.append(icon(icons.search), el("span", "st-typing", "open.spotify.com/track/…"));
    const found = el("div", "st-found");
    const t = tracks[3] ?? tracks[0];
    const { title, artist } = name(t, { title: "Та самая песня", artist: "Исполнитель" });
    const words = el("div", "st-words");
    words.append(el("div", "st-t", title), el("div", "st-a", artist));
    found.append(cover(t, "st-cover", 145), words, icon(icons.play, "st-play"));
    const services = el("div", "st-services");
    for (const s of ["spotify", "yandex", "apple", "deezer", "soundcloud", "youtube"]) services.append(icon(sourceIcons[s]));
    art.append(field, found, services);
    return art;
  },

  soundcloud(tracks) {
    const art = el("div", "st-art st-mock");
    const grid = el("div", "st-albums");
    for (let i = 0; i < 4; i++) {
      const c = cover(tracks[(i + 4) % Math.max(1, tracks.length)] ?? null, "st-cover", 30 + i * 60);
      c.style.setProperty("--i", i);
      c.append(icon(sourceIcons.soundcloud, "st-badge"));
      grid.append(c);
    }
    const recs = el("div", "st-recs");
    for (let i = 0; i < 2; i++) {
      const row = el("div", "st-rec");
      row.append(bar(), icon(icons.plus, "st-plus"));
      recs.append(row);
    }
    art.append(grid, el("div", "st-label", "Рекомендуемые"), recs);
    return art;
  },

  phone(tracks) {
    const art = el("div", "st-art");
    const phone = el("div", "st-phone");
    const t = tracks[0];
    phone.append(cover(t, "st-cover big", 160), bar(), bar("short"));
    const controls = el("div", "st-controls");
    controls.append(icon(icons.play, "st-play"));
    phone.append(controls);
    art.append(phone);
    return art;
  },

  end(tracks) {
    // Веер из обложек вашей музыки
    const art = el("div", "st-art st-end");
    const fan = el("div", "st-fan");
    for (let i = 0; i < 5; i++) {
      const c = cover(tracks[i] ?? null, "st-cover big", 265 + i * 25);
      c.style.setProperty("--i", i - 2);
      fan.append(c);
    }
    art.append(fan);
    return art;
  },
};

// ---------- Сторис ----------

/** Показать сторис записи changelog. onFinish — когда досмотрели до конца (не по ✕) */
export function showStories(entry, onFinish) {
  const slides = (entry.stories ?? []).filter((s) => textOf(s) !== false);
  if (!slides.length) { onFinish?.(); return; }
  const tracks = myTracks();
  const still = motionOff();   // «Меньше движения» — без анимаций и без автоперелистывания

  const root = el("div", "dialog-backdrop stories-backdrop");
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `Что нового в Sono ${entry.version}`);
  if (still) root.classList.add("still");
  const card = el("div", "stories");
  const bars = el("div", "st-bars");
  const fills = slides.map(() => { const b = el("i", "st-bar"); const f = el("b"); b.append(f); bars.append(b); return f; });
  const top = el("div", "st-top");
  top.append(el("span", "st-brand", `sono. · ${entry.version}`));
  const closeBtn = el("button", "st-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Закрыть");
  closeBtn.innerHTML = icons.close;
  top.append(closeBtn);
  const stage = el("div", "st-stage");
  card.append(bars, top, stage);
  const prevBtn = el("button", "st-nav prev");
  const nextBtn = el("button", "st-nav next");
  prevBtn.type = nextBtn.type = "button";
  prevBtn.setAttribute("aria-label", "Назад");
  nextBtn.setAttribute("aria-label", "Дальше");
  prevBtn.innerHTML = icons.back;
  nextBtn.innerHTML = icons.chevron;
  root.append(prevBtn, card, nextBtn);

  let index = -1, closed = false;

  const close = (finished) => {
    if (closed) return;
    closed = true;
    root.classList.remove("open");
    window.removeEventListener("blur", pause);
    window.removeEventListener("focus", unpause);
    document.removeEventListener("visibilitychange", onVisibility);
    setTimeout(() => root.remove(), 300);
    if (finished) setTimeout(() => onFinish?.(), 320);
  };

  function slideBody(slide) {
    const page = el("div", "st-slide");
    page.style.setProperty("--st-hue", slide.hue ?? 265);
    page.append((ART[slide.art] ?? ART.end)(tracks));
    const words = el("div", "st-text");
    if (slide.kicker) words.append(el("div", "st-kicker", slide.kicker));
    words.append(el("h2", "", slide.title));
    const sub = textOf(slide);
    if (sub) words.append(el("p", "", sub));
    if (slide.items) {
      const list = el("ul", "st-items");
      for (const item of slide.items) {
        const li = el("li");
        li.append(icon(icons.check), el("span", "", item));
        list.append(li);
      }
      words.append(list);
    }
    if (slide.art === "phone") {
      const link = el("button", "btn ghost st-btn", "Открыть страницу выпуска");
      link.type = "button";
      link.addEventListener("click", () => openExternal("/api/open-releases").catch(() => {}));
      words.append(link);
    }
    if (index === slides.length - 1 || slide.art === "end") {
      const row = el("div", "st-buttons");
      const all = el("button", "btn primary st-btn", "Весь список изменений");
      all.type = "button";
      all.addEventListener("click", () => close(true));
      const listen = el("button", "btn ghost st-btn", "Слушать");
      listen.type = "button";
      listen.addEventListener("click", () => close(false));
      row.append(all, listen);
      words.append(row);
    }
    page.append(words);
    return page;
  }

  function go(to) {
    if (to >= slides.length) { close(true); return; }
    to = Math.max(0, to);
    if (to === index) return;
    const back = to < index;
    index = to;
    fills.forEach((f, i) => {
      f.className = i < index ? "done" : "";
      f.style.animationDuration = "";
    });
    const fill = fills[index];
    fill.style.animationDuration = `${durationOf(slides[index])}ms`;
    void fill.offsetWidth;   // анимация полоски — заново, даже если вернулись на тот же слайд
    fill.className = still ? "" : "run";
    // Все прежние слайды уходят (при быстром листании их может быть два)
    for (const old of stage.querySelectorAll(".st-slide:not(.leaving)")) {
      old.classList.add("leaving");
      setTimeout(() => old.remove(), 350);
    }
    const page = slideBody(slides[index]);
    page.classList.add(back ? "from-left" : "from-right");
    stage.append(page);
    prevBtn.disabled = index === 0;
    unpause();
  }

  // Полоска дошла до конца — следующий слайд (на последнем — стоим: там кнопки)
  bars.addEventListener("animationend", (e) => {
    if (e.target !== fills[index]) return;
    e.target.className = "done";
    if (index < slides.length - 1) go(index + 1);
  });

  function pause() { root.classList.add("paused"); }
  function unpause() { root.classList.remove("paused"); }
  function onVisibility() { if (document.hidden) pause(); else unpause(); }

  // Касание/щелчок: слева — назад, справа — дальше; удержание — пауза, пока держат
  let downAt = 0, holdTimer = 0;
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    downAt = Date.now();
    holdTimer = setTimeout(pause, HOLD);
  });
  card.addEventListener("pointerup", (e) => {
    if (!downAt || e.target.closest("button")) return;
    clearTimeout(holdTimer);
    const held = Date.now() - downAt;
    downAt = 0;
    if (held >= HOLD) { unpause(); return; }
    const box = card.getBoundingClientRect();
    go((e.clientX - box.left) < box.width * 0.3 ? index - 1 : index + 1);
  });
  card.addEventListener("pointercancel", () => { clearTimeout(holdTimer); downAt = 0; unpause(); });
  closeBtn.addEventListener("click", () => close(false));
  prevBtn.addEventListener("click", () => go(index - 1));
  nextBtn.addEventListener("click", () => go(index + 1));
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(false); });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(false); return; }
    if (e.target.closest?.("button") && (e.key === "Enter" || e.key === " ")) return;   // кнопка сама
    if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") { e.preventDefault(); go(index + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(index - 1); }
  });
  window.addEventListener("blur", pause);
  window.addEventListener("focus", unpause);
  document.addEventListener("visibilitychange", onVisibility);

  document.body.append(root);
  go(0);
  root.focus();
  requestAnimationFrame(() => root.classList.add("open"));
  return { close: () => close(false) };
}
