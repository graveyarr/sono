// Проверка медиатеки: раз в несколько дней Sono сам проверяет, не удалили ли треки из избранного и плейлистов
// с YouTube и SoundCloud (сервер — libcheck.py, /api/libcheck), и заранее подбирает им другую загрузку.
// Найденная замена запоминается как у трека с цензурой (settings.altVersions): дальше везде играет она,
// а название и обложка в медиатеке — прежние. Замены нет — строка серая с причиной («видео удалено с YouTube»).
//   settings.libCheckAt   — когда проверяли (раз в EVERY);
//   settings.libCheckSeen — о каких сломанных уже сказали (чтобы уведомление было только о новых);
//   settings.libCheckKeep — где человек сам вернул прежнюю загрузку (больше не подменяем).

import { isDownloaded } from "./downloads.js";
import { altVersionOf, getSetting, keyOf, lib, setSetting, slim } from "./library.js";
import { SOURCE_NAMES, displayTrack, el, openModal, plural, setBrokenTracks, toast } from "./ui.js";

const EVERY = 3 * 24 * 3600e3;
const FIRST_DELAY = 90e3;   // после запуска — когда всё уже загрузилось и играет
let status = null;          // последний ответ сервера
let running = false;
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

/** Подписка на изменения (строка в настройках перерисовывается) */
export function onLibCheck(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const libCheckRunning = () => running;

/** Треки медиатеки: { orig — как сохранён, eff — что играет (замена или он сам) }.
    Скачанные не проверяем: они играют с диска, даже если с сайта их удалили */
function libraryItems() {
  const map = new Map();
  for (const t of [...lib.liked, ...lib.playlists.flatMap((p) => p.tracks)]) {
    if (!t || map.has(keyOf(t)) || isDownloaded(t)) continue;
    const eff = altVersionOf(t) ?? t;
    if (eff.source !== "youtube" && eff.source !== "soundcloud") continue;
    map.set(keyOf(t), { orig: t, eff });
  }
  return [...map.values()];
}

/** Проверить сейчас (force — и то, что проверяли недавно). Ждёт конца проверки */
export async function checkLibrary({ force = false, quiet = false } = {}) {
  if (running) return;
  const items = libraryItems();
  if (!items.length) return;
  running = true;
  changed();
  try {
    const tracks = items.map(({ orig, eff }) => {
      const shown = displayTrack(orig);
      return { source: eff.source, id: eff.id, artist: shown.artist, title: shown.title,
               duration: orig.duration, metaId: orig.metaId };
    });
    let res = await fetch("/api/libcheck", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracks, force }),
    });
    status = await res.json();
    do {   // и в конце — полный ответ: там и сломанные оригиналы, у которых уже стоит замена
      if (status.running) await new Promise((r) => setTimeout(r, 4000));
      res = await fetch("/api/libcheck");
      status = await res.json();
    } while (status.running);
    setSetting("libCheckAt", Date.now());
    apply({ quiet });
  } catch {
    if (!quiet) toast("Не получилось проверить медиатеку — нет связи", { error: true });
  } finally {
    running = false;
    changed();
  }
}

/** Что сломано у треков медиатеки: [{ orig, why, alt }] (alt — найденная замена или null) */
function problems() {
  const broken = status?.broken ?? {};
  const keep = new Set(getSetting("libCheckKeep", []));
  return libraryItems().flatMap(({ orig, eff }) => {
    // Сломан тот, что играет сейчас, — или оригинал, которому замену уже поставили (её проверяем отдельно: eff)
    const b = broken[keyOf(eff)] ?? broken[keyOf(orig)];
    if (!b) return [];
    return [{ orig, why: b.why, alt: keep.has(keyOf(orig)) ? null : b.alt, kept: keep.has(keyOf(orig)) }];
  });
}

/** Подставить замены, пометить остальные серым, сказать о новых */
function apply({ quiet = false } = {}) {
  const list = problems();
  const alts = { ...getSetting("altVersions", {}) };
  let replacedNow = 0;
  for (const { orig, alt } of list) {
    if (alt && keyOf(alts[keyOf(orig)] ?? {}) !== keyOf(alt)) {
      alts[keyOf(orig)] = slim(alt);
      replacedNow++;
    }
  }
  if (replacedNow) setSetting("altVersions", alts);
  setBrokenTracks(Object.fromEntries(list.filter((p) => !p.alt).map((p) => [keyOf(p.orig), p.why])));

  const seen = new Set(getSetting("libCheckSeen", []));
  const fresh = list.filter((p) => !seen.has(keyOf(p.orig)));
  if (fresh.length) setSetting("libCheckSeen", [...seen, ...fresh.map((p) => keyOf(p.orig))].slice(-500));
  if (!fresh.length || quiet) return;
  const fixed = fresh.filter((p) => p.alt).length;
  const text = fixed === fresh.length
    ? `${plural(fresh.length, "трек", "трека", "треков")} из медиатеки больше не открывались — Sono нашёл им другие загрузки`
    : `${plural(fresh.length, "трек", "трека", "треков")} из медиатеки больше не открываются` + (fixed ? `, для ${fixed} нашлась другая загрузка` : "");
  toast(text, { action: { label: "Подробнее", run: showLibCheckReport } });
}

/** Строка для настроек: «Проверено 15 ноября · не открывались 3 (2 заменены)» */
export function libCheckSummary() {
  const at = getSetting("libCheckAt", 0);
  if (running) return "Проверяю медиатеку…";
  if (!at) return "Ещё не проверялась";
  const when = new Date(at).toLocaleString("ru", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const list = problems();
  if (!list.length) return `Проверено ${when} · всё открывается`;
  const fixed = list.filter((p) => p.alt).length;
  return `Проверено ${when} · не открываются ${list.length}` + (fixed ? ` (${fixed} заменено)` : "");
}
export const libCheckProblems = () => problems().length;

/** Окно «Подробнее»: какие треки не открывались, что вместо них играет, вернуть прежнее / найти вручную */
export function showLibCheckReport() {
  const { box, close } = openModal({ className: "libcheck-dialog" });
  const draw = () => {
    const list = problems();
    box.replaceChildren(el("h2", "", "Проверка медиатеки"),
      el("p", "", list.length
        ? "Эти треки удалили или закрыли на YouTube или SoundCloud. Где нашлась другая загрузка того же трека — играет она, а в медиатеке всё как было."
        : "Все треки медиатеки открываются."));
    const ul = el("ul", "libcheck-list");
    for (const p of list) {
      const shown = displayTrack(p.orig);
      const li = el("li", "libcheck-item");
      const text = el("div", "libcheck-text");
      text.append(el("div", "libcheck-name", `${shown.title}${shown.artist ? ` — ${shown.artist}` : ""}`),
        el("div", "libcheck-why", p.why || "не открывается"));
      if (p.alt) {
        text.append(el("div", "libcheck-alt", `Играет другая загрузка: ${SOURCE_NAMES[p.alt.source] ?? p.alt.source}${p.alt.channel ? ` · ${p.alt.channel}` : ""}`));
      } else {
        text.append(el("div", "libcheck-why", p.kept ? "Вы оставили прежнюю загрузку" : "Другой загрузки не нашлось"));
      }
      const btn = el("button", "btn ghost", p.alt ? "Вернуть прежнюю" : "Найти вручную");
      btn.type = "button";
      btn.addEventListener("click", () => {
        if (p.alt) {   // человек против замены — убираем её и больше не подставляем
          const alts = { ...getSetting("altVersions", {}) };
          delete alts[keyOf(p.orig)];
          setSetting("altVersions", alts);
          setSetting("libCheckKeep", [...new Set([...getSetting("libCheckKeep", []), keyOf(p.orig)])].slice(-500));
          apply({ quiet: true });
          draw();
        } else {   // в строку поиска — «исполнитель название»
          close();
          const q = document.getElementById("query");
          q.value = `${shown.artist} ${shown.title}`.trim();
          q.focus();
          q.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      li.append(text, btn);
      ul.append(li);
    }
    const row = el("div", "dialog-buttons");
    const ok = el("button", "btn primary", "Готово");
    ok.type = "button";
    ok.addEventListener("click", close);
    row.append(ok);
    box.append(ul, row);
    changed();
  };
  draw();
}

export function initLibCheck() {
  // Прошлые результаты — сразу (серые строки и замены), без новой проверки
  fetch("/api/libcheck").then((r) => r.json()).then((s) => { status = s; apply({ quiet: true }); changed(); }).catch(() => {});
  setTimeout(() => {
    if (Date.now() - getSetting("libCheckAt", 0) > EVERY) checkLibrary({ quiet: false });
  }, FIRST_DELAY);
}
