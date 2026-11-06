// Медиатека как в Spotify: папки плейлистов, фильтр «Плейлисты / Исполнители», поиск и сортировка.
// Всё хранится в настройках (раздел медиатеки settings), выключается в «Настройки → Оформление»
// (settings.libTools = false — медиатека прежняя: плейлисты списком, без папок и строки фильтров).
//   settings.folders  = [{ id, name, open, items: [id плейлиста] }] — плейлист лежит не больше чем в одной папке;
//   settings.libSort  = "recent" | "added" | "alpha" | "custom";
//   settings.libRecent = { "playlist:<id>": время } — когда список открывали или включали (для «Недавние»).
// Перерисовку боковой панели views.js делает по событию «sono:libtools».

import { icons } from "./icons.js";
import { getPlaylist, getSetting, lib, setSetting } from "./library.js";
import { el, promptDialog, toast } from "./ui.js";

export const SORTS = [
  ["recent", "Недавние"],
  ["added", "Недавно добавленные"],
  ["alpha", "По алфавиту"],
  ["custom", "Свой порядок"],
];

/** Фильтр и поиск — только на время работы программы (как в Spotify), сортировка запоминается */
export const libFilter = { chip: "all", query: "", searching: false };

export const libToolsOn = () => getSetting("libTools", true) !== false;
export const libSort = () => (SORTS.some(([v]) => v === getSetting("libSort")) ? getSetting("libSort") : "recent");

const changed = () => dispatchEvent(new CustomEvent("sono:libtools"));

/** Слепок того, от чего зависит боковая панель (чтобы перерисовывать её только при нужных настройках) */
export function sidebarSignature() {
  const followed = getSetting("followed", []);
  return [libToolsOn(), libSort(), JSON.stringify(getSetting("folders", [])), followed.length, followed[0]?.id ?? ""].join("|");
}

// ---------- Недавние ----------

/** Список открыли или включили — для сортировки «Недавние» */
export function markRecent(key) {
  if (!/^(playlist:|liked$|downloads$|local$|artist:)/.test(key)) return;
  const recent = { ...getSetting("libRecent", {}), [key]: Date.now() };
  const keys = Object.keys(recent);
  if (keys.length > 300) keys.sort((a, b) => recent[a] - recent[b]).slice(0, keys.length - 300).forEach((k) => delete recent[k]);
  setSetting("libRecent", recent);
}

export const recentOf = (key) => getSetting("libRecent", {})[key] || 0;

// ---------- Папки ----------

/** Папки (без удалённых плейлистов) */
export function folders() {
  const exists = new Set(lib.playlists.map((p) => p.id));
  return getSetting("folders", []).filter((f) => f && f.id).map((f) => ({ ...f, items: (f.items || []).filter((id) => exists.has(id)) }));
}

const saveFolders = (list) => { setSetting("folders", list); changed(); };

export const folderOf = (playlistId) => folders().find((f) => f.items.includes(playlistId)) ?? null;

export async function createFolder(withPlaylist = null) {
  const name = await promptDialog({ title: "Новая папка", placeholder: "Например, «Для дороги»", okLabel: "Создать" });
  if (!name?.trim()) return null;
  const folder = { id: `f${Date.now().toString(36)}`, name: name.trim().slice(0, 100), open: true, items: [] };
  const list = folders().map((f) => ({ ...f, items: f.items.filter((id) => id !== withPlaylist) }));
  if (withPlaylist) folder.items.push(withPlaylist);
  saveFolders([...list, folder]);
  return folder;
}

export async function renameFolder(folder) {
  const name = await promptDialog({ title: "Переименовать папку", value: folder.name, okLabel: "Сохранить" });
  if (name?.trim()) saveFolders(folders().map((f) => (f.id === folder.id ? { ...f, name: name.trim().slice(0, 100) } : f)));
}

/** Удалить папку — плейлисты остаются в медиатеке */
export function deleteFolder(folder) {
  saveFolders(folders().filter((f) => f.id !== folder.id));
  toast(`Папка «${folder.name}» удалена — плейлисты остались в медиатеке`);
}

export function toggleFolder(folder) {
  saveFolders(folders().map((f) => (f.id === folder.id ? { ...f, open: !f.open } : f)));
}

/** Положить плейлист в папку (folderId = null — достать из папки) */
export function moveToFolder(playlistId, folderId) {
  const list = folders().map((f) => ({ ...f, items: f.items.filter((id) => id !== playlistId) }));
  const target = list.find((f) => f.id === folderId);
  if (target) target.items.push(playlistId);
  saveFolders(list);
  const name = getPlaylist(playlistId)?.name ?? "Плейлист";
  toast(target ? `«${name}» — в папке «${target.name}»` : `«${name}» больше не в папке`);
}

/** Пункт «В папку» для меню «⋯» плейлиста (подменю: папки, «Новая папка…», «Убрать из папки») */
export function folderMenuItem(playlist) {
  if (!libToolsOn()) return [];
  return [{
    label: "В папку", icon: icons.folder, submenu: () => {
      const current = folderOf(playlist.id);
      return [
        ...folders().map((f) => ({ label: f.name, icon: f.id === current?.id ? icons.check : icons.folder,
                                   disabled: f.id === current?.id, action: () => moveToFolder(playlist.id, f.id) })),
        { label: "Новая папка…", icon: icons.plus, action: () => createFolder(playlist.id) },
        ...(current ? [{ sep: true }, { label: "Убрать из папки", icon: icons.close, action: () => moveToFolder(playlist.id, null) }] : []),
      ];
    },
  }];
}

// ---------- Строка фильтров над медиатекой ----------

/** Чипы «Плейлисты / Исполнители», поиск по медиатеке и сортировка. rerender — перерисовать список */
export function toolsRow(rerender, openSortMenu, hasArtists) {
  const row = el("div", "lib-tools");
  const chips = el("div", "lib-chips");
  for (const [value, label] of [["playlists", "Плейлисты"], ["artists", "Исполнители"]]) {
    if (value === "artists" && !hasArtists) continue;
    const chip = el("button", `lib-chip${libFilter.chip === value ? " on" : ""}`, label);
    chip.type = "button";
    chip.addEventListener("click", () => {
      libFilter.chip = libFilter.chip === value ? "all" : value;   // второй щелчок — снять фильтр
      rerender();
    });
    chips.append(chip);
  }
  const bar = el("div", "lib-bar");
  const search = el("label", `lib-search${libFilter.searching || libFilter.query ? " open" : ""}`);
  const icon = el("button", "icon-btn small");
  icon.type = "button";
  icon.innerHTML = icons.search;
  icon.title = "Искать в медиатеке";
  const input = el("input");
  input.placeholder = "Искать в медиатеке";
  input.value = libFilter.query;
  input.addEventListener("input", () => { libFilter.query = input.value; rerender({ keepFocus: true }); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); libFilter.query = ""; libFilter.searching = false; rerender(); }
  });
  input.addEventListener("blur", () => {
    if (!libFilter.query) { libFilter.searching = false; search.classList.remove("open"); }
  });
  icon.addEventListener("click", () => { libFilter.searching = true; search.classList.add("open"); input.focus(); });
  search.append(icon, input);
  const sort = el("button", "lib-sort");
  sort.type = "button";
  sort.innerHTML = `<span></span>${icons.sortList ?? ""}`;
  sort.querySelector("span").textContent = SORTS.find(([v]) => v === libSort())[1];
  sort.title = "Сортировка";
  sort.addEventListener("click", () => openSortMenu(sort));
  bar.append(search, sort);
  row.append(chips, bar);
  return row;
}

/** Меню сортировки */
export function sortMenuItems() {
  const now = libSort();
  return [
    { note: "Сортировка" },
    ...SORTS.map(([value, label]) => ({ label, icon: value === now ? icons.check : "", action: () => { setSetting("libSort", value); changed(); } })),
  ];
}
