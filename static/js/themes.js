// Темы оформления и виды «Сейчас играет». Обе — папки с theme.json и theme.css (встроенные — static/themes,
// свои — %LOCALAPPDATA%\Sono\themes; сервер — themes.py), отличаются полем "part" в theme.json:
// - тема ("theme") меняет весь Sono: цвета, размеры, шрифт, вид и место кнопок, свои значки (папка icons/);
// - вид «Сейчас играет» ("now") — только этот экран: раскладку, фон, полосу перемотки. Выбирается отдельно
//   и подключается вторым <link> поверх темы — любую тему можно сочетать с любым видом.
// CSS сервер отдаёт уже очищенным (без внешних адресов и @import), значки — тоже. Как писать — THEMES.md.
// Пока выбрана своя тема/вид, страница раз в 1,5 с спрашивает время правки и перечитывает её —
// автор видит изменения сразу после сохранения файла.

import { getSetting, setSetting } from "./library.js";
import { setThemeIcons } from "./icons.js";
import { setCoverColorsMode } from "./player.js";
import { toast } from "./ui.js";

let themes = [];          // с сервера: [{id, kind, folder, part, name, author, coverColors, icons, preview, image, needs, stamp, …}]
let folder = "";          // папка своих тем (показываем в настройках)
const listeners = new Set();

// Два «места»: тема всего Sono и вид «Сейчас играет». Выбранные сервер вписывает в страницу сам (app.py index)
const SLOTS = {
  theme: { setting: "theme", linkId: "theme-css", data: "theme", title: "Тема" },
  now: { setting: "nowStyle", linkId: "now-css", data: "nowStyle", title: "Вид" },
};
const slot = {
  theme: { link: document.getElementById("theme-css"), timer: 0, stamp: null, icons: false },
  now: { link: document.getElementById("now-css"), timer: 0, stamp: null },
};

export const themeList = (part = "theme") => themes.filter((t) => t.part === part);
export const themesFolder = () => folder;
export const currentThemeId = (part = "theme") => getSetting(SLOTS[part].setting, null);
export const onThemesChange = (fn) => listeners.add(fn);

const changed = () => listeners.forEach((fn) => fn());
const base = (t) => `/api/themes/${t.kind}/${encodeURIComponent(t.folder)}`;
// Пока открыт редактор тем (editor.js), свою тему подключаем без его куска: этот кусок страница рисует
// сама из черновика, иначе убранное в редакторе (картинка фона, шрифт) оставалось бы видно из файла
let editorPreview = false;
const cssUrl = (t, stamp, part = "theme") =>
  `${base(t)}/theme.css?v=${stamp}${editorPreview && part === "theme" && t.kind === "user" ? "&editor=0" : ""}`;

export const themeById = (id) => themes.find((t) => t.id === id) ?? null;
export const themeBase = (t) => base(t);

/** Включить/выключить режим редактора для текущей темы. Вернёт обещание: тема перечитана */
export function setEditorPreview(on) {
  editorPreview = on;
  const s = slot.theme;
  const theme = themeById(currentThemeId("theme"));
  if (!s.link || !theme) return Promise.resolve();
  const href = cssUrl(theme, s.stamp ?? theme.stamp);
  if (s.link.getAttribute("href") === href) return Promise.resolve();
  return new Promise((resolve) => {
    s.link.addEventListener("load", resolve, { once: true });
    s.link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 2000);
    s.link.href = href;
  });
}

export async function loadThemes() {
  try {
    const res = await fetch("/api/themes");
    const data = await res.json();
    themes = data.themes || [];
    folder = data.folder || "";
  } catch { /* сервер не ответил — остаётся прежний список */ }
  return themes;
}

/** Свои значки темы (папка icons/). Нет их — обычные значки Sono */
async function applyIcons(theme) {
  const s = slot.theme;
  if (!theme?.icons) {
    if (s.icons) { s.icons = false; setThemeIcons({}); }
    return;
  }
  try {
    const res = await fetch(`${base(theme)}/icons?v=${theme.stamp}`);
    const { icons } = await res.json();
    if (currentThemeId("theme") !== theme.id) return;   // пока ждали ответа, тему уже сменили
    s.icons = true;
    setThemeIcons(icons || {});
  } catch { /* не ответил — значки останутся прежними */ }
}

/** Подключить тему или вид (null — обычные Sono) без сохранения в настройки */
function apply(part, theme) {
  const s = slot[part];
  const { linkId, data } = SLOTS[part];
  clearTimeout(s.timer);
  if (!theme) {
    s.link?.remove();
    s.link = null;
    s.stamp = null;
    delete document.documentElement.dataset[data];
    if (part === "theme") { setCoverColorsMode("on"); applyIcons(null); }
    return;
  }
  if (!s.link) {
    s.link = document.createElement("link");
    s.link.rel = "stylesheet";
    s.link.id = linkId;
    // Вид «Сейчас играет» всегда после темы — он главнее на своём экране
    if (part === "theme" && slot.now.link) slot.now.link.before(s.link);
    else document.head.append(s.link);
  }
  s.stamp = theme.stamp;
  const href = cssUrl(theme, theme.stamp, part);
  if (s.link.getAttribute("href") !== href) s.link.href = href;   // уже подключена сервером — не перечитываем
  document.documentElement.dataset[data] = theme.folder;   // для тем, которым нужно знать себя (THEMES.md)
  if (part === "theme") { setCoverColorsMode(theme.coverColors); applyIcons(theme); }
  if (theme.kind === "user") watch(part, theme);
}

/** Своя тема: перечитываем, как только сохранили theme.css или значки (заодно и theme.json —
    вдруг поменяли название или coverColors) */
function watch(part, theme) {
  const s = slot[part];
  const tick = async () => {
    if (currentThemeId(part) !== theme.id) return;
    if (document.visibilityState === "visible") {
      try {
        const res = await fetch(`${base(theme)}/stamp`);
        const { stamp } = await res.json();
        if (stamp == null) {                // папку удалили или переименовали
          toast(`${SLOTS[part].title} «${theme.name}» пропал${part === "theme" ? "а" : ""} из папки — включен${part === "theme" ? "а обычная" : " обычный"}`);
          setSetting(SLOTS[part].setting, null);
          apply(part, null);
          await loadThemes();
          changed();
          return;
        }
        if (stamp !== s.stamp) {
          s.stamp = stamp;
          s.link.href = cssUrl(theme, stamp, part);
          await loadThemes();               // вдруг поменяли и theme.json (название, coverColors)
          const fresh = themes.find((t) => t.id === theme.id);
          if (fresh) {
            theme = fresh;
            if (part === "theme") { setCoverColorsMode(fresh.coverColors); applyIcons(fresh); }
          }
          changed();
        }
      } catch { /* не ответил — спросим в следующий раз */ }
    }
    s.timer = setTimeout(tick, 1500);
  };
  s.timer = setTimeout(tick, 1500);
}

/** Выбрать тему (part "theme") или вид «Сейчас играет» (part "now"); id null — обычные */
export function chooseTheme(id, part = "theme") {
  const theme = id ? themes.find((t) => t.id === id && t.part === part) : null;
  if (id && !theme) return;
  if (theme?.needs) {
    toast(`«${theme.name}» сделан${part === "theme" ? "а" : ""} для Sono ${theme.needs} или новее — обновите Sono`, { error: true });
    return;
  }
  setSetting(SLOTS[part].setting, theme ? theme.id : null);
  apply(part, theme);
  changed();
}

/** «Создать свою тему» / «Создать свой вид»: копия заготовки + сразу включить её и открыть папку */
export async function createTheme(name, part = "theme") {
  const res = await fetch("/api/themes/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, part }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "не получилось");
  await loadThemes();
  chooseTheme(data.id, part);
  return data;
}

/** Удалить свою тему или вид (встроенные нельзя). Был включён — возвращаем обычный. */
export async function deleteTheme(id) {
  const theme = themes.find((t) => t.id === id && t.kind === "user");
  if (!theme) return null;
  if (currentThemeId(theme.part) === id) chooseTheme(null, theme.part);   // сначала выключить — иначе слежка решит, что папка «пропала»
  const res = await fetch(`/api/themes/user/${encodeURIComponent(theme.folder)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  await loadThemes();
  changed();
  if (!res.ok) throw new Error(data.error || "не получилось удалить");
  return data;
}

export async function openThemesFolder() {
  const res = await fetch("/api/themes/open-folder", { method: "POST" });
  return res.json().catch(() => ({}));
}

export async function initThemes() {
  if (!currentThemeId("theme") && !currentThemeId("now")) return;
  await loadThemes();
  // До 0.9.7 «Горизонт», «Волна» и «Луна» были темами. Теперь это виды «Сейчас играет» — переносим выбор
  const old = themes.find((t) => t.id === currentThemeId("theme"));
  if (old?.part === "now") {
    if (!currentThemeId("now")) setSetting("nowStyle", old.id);
    setSetting("theme", null);
  }
  for (const part of ["theme", "now"]) {
    const theme = themes.find((t) => t.id === currentThemeId(part) && t.part === part);
    // Тему удалили или она для более новой Sono — молча возвращаем обычную, настройку не трогаем:
    // папку могли временно переименовать
    apply(part, theme && !theme.needs ? theme : null);
  }
}
