// Треки с цензурой. Сейчас песни «чистят» так: заменяют слова («наркотик» → «компотик») или вырезают их,
// оставляя музыку. По звуку это не распознать (нужно распознавание речи), поэтому Sono ищет ДРУГИЕ
// загрузки того же трека (/api/versions): подписанные «без цензуры»/«оригинал» и старые — выложенные
// до переделки. Человек слушает их с того же места и выбирает; выбор запоминается (library.js → altVersions),
// и дальше вместо трека с цензурой везде играет выбранная версия.

import { censoredKeys, getSetting, keyOf, markCensored, setAltVersion } from "./library.js";
import { play, state, swapCurrent } from "./player.js";
import { SOURCE_NAMES, displayTrack, el, formatTime, openModal, playsText, toast } from "./ui.js";

/** Трек, вместо которого играет track (если track — выбранная замена), иначе сам track */
function originalOf(track) {
  const key = keyOf(track);
  for (const [orig, alt] of Object.entries(getSetting("altVersions", {}))) {
    if (keyOf(alt) === key) {
      const [source, ...id] = orig.split(":");
      return { source, id: id.join(":") };
    }
  }
  return track;
}

export const hasAltVersion = (track) => !!track && originalOf(track) !== track;

/** Убрать замену: дальше снова играет исходная версия */
export function restoreOriginal(track) {
  setAltVersion(originalOf(track), null);
}

/** Окно «Другие версии»: найти загрузки без цензуры, дать послушать и выбрать */
export async function findOriginal(track = state.current) {
  if (!track) return;
  const original = originalOf(track);
  const shown = displayTrack(track);
  markCensored(track);

  const { box, close } = openModal({ className: "versions" });
  box.addEventListener("submit", (e) => e.preventDefault());
  box.append(el("h2", "", "Найти версию без цензуры"),
    el("p", "set-text", `«${shown.title}» — ${shown.artist}. Ищу другие загрузки: подписанные «без цензуры» `
      + "и старые — выложенные до того, как трек переделали. Послушайте и выберите ту, где слова на месте."));
  const list = el("div", "versions-list");
  list.append(el("p", "meta-loading", "Ищу на YouTube и SoundCloud…"));
  const done = el("button", "btn ghost", "Закрыть");
  done.type = "button";
  done.addEventListener("click", close);
  const foot = el("div", "dialog-buttons");
  foot.append(done);
  box.append(list, foot);

  let versions;
  try {
    const res = await fetch("/api/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: track.source, id: track.id, artist: shown.artist, title: shown.title,
        duration: track.duration, exclude: [...censoredKeys(), keyOf(original)] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "ошибка сервера");
    versions = data.versions;
  } catch (err) {
    list.replaceChildren(el("p", "pl-empty", `Не получилось поискать: ${err.message}`));
    return;
  }
  if (!versions.length) {
    list.replaceChildren(el("p", "pl-empty", "Других версий не нашлось ни на YouTube, ни на SoundCloud. "
      + "Похоже, исполнитель заменил трек везде."));
    return;
  }

  const isPlaying = () => state.current && [keyOf(track), ...versions.map(keyOf)].includes(keyOf(state.current));
  const rows = versions.map((v) => {
    const row = el("div", "version-row");
    const text = el("div", "version-text");
    const facts = [v.channel, SOURCE_NAMES[v.source], formatTime(v.duration), v.year, playsText(v.plays, v.source)].filter(Boolean);
    text.append(el("div", "version-title", v.title), el("div", "version-sub", facts.join(" · ")));
    if (v.why?.length) text.append(el("div", "version-why", v.why.join(" · ")));
    const listen = el("button", "btn ghost", "Слушать");
    listen.type = "button";
    listen.title = "Включить с того же места";
    listen.addEventListener("click", () => {
      if (isPlaying()) swapCurrent(v);   // с того же места — так проще сравнить
      else play(v);
      rows.forEach((r) => r.classList.toggle("on", r === row));
    });
    const pick = el("button", "btn primary", "Выбрать");
    pick.type = "button";
    pick.addEventListener("click", () => {
      setAltVersion(original, v);
      if (isPlaying() && keyOf(state.current) !== keyOf(v)) swapCurrent(v);
      toast("Запомнил: дальше будет играть эта версия");
      close();
    });
    row.append(text, listen, pick);
    return row;
  });
  list.replaceChildren(...rows);
}
