// Темы оформления. Тема — папка с theme.json и theme.css (встроенные — static/themes, свои —
// %LOCALAPPDATA%\Sono\themes; сервер — themes.py). CSS темы подключается поверх style.css отдельным
// <link>, сервер отдаёт его уже очищенным (без внешних адресов и @import). Как писать темы — THEMES.md.
// Пока выбрана своя тема, страница раз в 1,5 с спрашивает время правки theme.css и перечитывает её —
// автор темы видит изменения сразу после сохранения файла.

import { getSetting, setSetting } from "./library.js";
import { setCoverColorsMode } from "./player.js";
import { toast } from "./ui.js";

let themes = [];          // с сервера: [{id, kind, folder, name, author, coverColors, preview, image, needs, stamp, …}]
let folder = "";          // папка своих тем (показываем в настройках)
let link = document.getElementById("theme-css");   // <link> с CSS темы (выбранную сервер вписывает в страницу сам — app.py index)
let watchTimer = 0;
let shownStamp = null;
const listeners = new Set();

export const themeList = () => themes;
export const themesFolder = () => folder;
export const currentThemeId = () => getSetting("theme", null);
export const onThemesChange = (fn) => listeners.add(fn);

const changed = () => listeners.forEach((fn) => fn());
const cssUrl = (t, stamp) => `/api/themes/${t.kind}/${encodeURIComponent(t.folder)}/theme.css?v=${stamp}`;

export async function loadThemes() {
  try {
    const res = await fetch("/api/themes");
    const data = await res.json();
    themes = data.themes || [];
    folder = data.folder || "";
  } catch { /* сервер не ответил — остаётся прежний список */ }
  return themes;
}

/** Применить тему (id или null — стандартная Sono) без сохранения в настройки */
function apply(theme) {
  clearTimeout(watchTimer);
  if (!theme) {
    link?.remove();
    link = null;
    shownStamp = null;
    delete document.documentElement.dataset.theme;
    setCoverColorsMode("on");
    return;
  }
  if (!link) {
    link = document.createElement("link");
    link.rel = "stylesheet";
    link.id = "theme-css";
    document.head.append(link);
  }
  shownStamp = theme.stamp;
  const href = cssUrl(theme, theme.stamp);
  if (link.getAttribute("href") !== href) link.href = href;   // уже подключена сервером — не перечитываем
  document.documentElement.dataset.theme = theme.folder;   // для тем, которым нужно знать себя (THEMES.md)
  setCoverColorsMode(theme.coverColors);
  if (theme.kind === "user") watch(theme);
}

/** Своя тема: перечитываем, как только сохранили theme.css (заодно перечитываем и theme.json —
    вдруг поменяли название или coverColors) */
function watch(theme) {
  const tick = async () => {
    if (currentThemeId() !== theme.id) return;
    if (document.visibilityState === "visible") {
      try {
        const res = await fetch(`/api/themes/${theme.kind}/${encodeURIComponent(theme.folder)}/stamp`);
        const { stamp } = await res.json();
        if (stamp == null) {                // папку темы удалили или переименовали
          toast(`Тема «${theme.name}» пропала из папки — включена обычная`);
          setSetting("theme", null);
          apply(null);
          await loadThemes();
          changed();
          return;
        }
        if (stamp !== shownStamp) {
          shownStamp = stamp;
          link.href = cssUrl(theme, stamp);
          await loadThemes();               // вдруг поменяли и theme.json (название, coverColors)
          const fresh = themes.find((t) => t.id === theme.id);
          if (fresh) { theme = fresh; setCoverColorsMode(fresh.coverColors); }
          changed();
        }
      } catch { /* не ответил — спросим в следующий раз */ }
    }
    watchTimer = setTimeout(tick, 1500);
  };
  watchTimer = setTimeout(tick, 1500);
}

export function chooseTheme(id) {
  const theme = id ? themes.find((t) => t.id === id) : null;
  if (id && !theme) return;
  if (theme?.needs) {
    toast(`Тема «${theme.name}» сделана для Sono ${theme.needs} или новее — обновите Sono`, { error: true });
    return;
  }
  setSetting("theme", theme ? theme.id : null);
  apply(theme);
  changed();
}

/** «Создать свою тему»: копия заготовки + сразу включить её и открыть папку */
export async function createTheme(name) {
  const res = await fetch("/api/themes/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "не получилось");
  await loadThemes();
  chooseTheme(data.id);
  return data;
}

export async function openThemesFolder() {
  const res = await fetch("/api/themes/open-folder", { method: "POST" });
  return res.json().catch(() => ({}));
}

export async function initThemes() {
  const id = currentThemeId();
  if (!id) return;
  await loadThemes();
  const theme = themes.find((t) => t.id === id);
  if (!theme || theme.needs) {
    // Тему удалили или она для более новой Sono — молча возвращаем обычную, настройку не трогаем:
    // папку могли временно переименовать
    apply(null);
    return;
  }
  apply(theme);
}
