// Свои файлы с компьютера (сервер — localfiles.py): папки добавляются в Настройках → «Мои файлы»,
// треки собираются в одноимённый раздел медиатеки и играют прямо с диска.
// Папку выбирают обычным окном Windows (window.pywebview.api.pick_folder) — в браузере (python app.py) путь вводят руками.

import { el, promptDialog, toast } from "./ui.js";

let data = { folders: [], tracks: [], scanning: false, found: 0 };
const listeners = new Set();

/** fn() — список своих файлов изменился (просмотрели папки, добавили/убрали папку) */
export const onLocalChange = (fn) => listeners.add(fn);
export const localTracks = () => data.tracks;
export const localStatus = () => data;

let polling = 0;
export async function loadLocal() {
  try {
    const res = await fetch("/api/local");
    const next = await res.json();
    const changed = next.tracks.length !== data.tracks.length || next.scanning !== data.scanning
      || next.folders.join("|") !== data.folders.join("|");
    data = next;
    if (changed) listeners.forEach((fn) => fn());
  } catch {}
  // Пока сервер просматривает папки — спрашиваем раз в секунду, чтобы список рос на глазах
  clearTimeout(polling);
  if (data.scanning) polling = setTimeout(loadLocal, 1000);
}

/** Выбрать папку и добавить. В программе — окно Windows; в браузере — ввести путь */
export async function addLocalFolder() {
  let path = null;
  if (window.pywebview?.api?.pick_folder) {
    path = await window.pywebview.api.pick_folder().catch(() => null);
  } else {
    path = await promptDialog({ title: "Папка с музыкой", placeholder: "Например, C:\\Users\\…\\Music", okLabel: "Добавить" });
  }
  if (!path) return;
  const res = await fetch("/api/local/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return toast(out.error || "Не получилось добавить папку", { error: true });
  toast("Папка добавлена — ищу в ней музыку…");
  loadLocal();
}

export async function removeLocalFolder(path) {
  await fetch("/api/local/folders", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  loadLocal();
}

export async function rescanLocal() {
  await fetch("/api/local/rescan", { method: "POST" });
  loadLocal();
}

/** Блок настроек «Мои файлы»: папки (с кнопкой «убрать»), «Добавить папку», «Обновить» */
export function localSection() {
  const section = el("section", "set-card");
  section.append(el("h2", "", "Мои файлы"),
    el("p", "set-text", "Музыка с компьютера — mp3, flac, m4a, ogg и другие. Добавьте папку (подпапки тоже просмотрятся): "
      + "треки появятся в медиатеке в разделе «Мои файлы» и будут играть без интернета."));
  const folders = el("div", "local-folders");
  const status = el("div", "set-hint");
  const buttons = el("div", "set-actions");
  const add = el("button", "btn primary", "Добавить папку");
  add.type = "button";
  add.addEventListener("click", addLocalFolder);
  const again = el("button", "btn ghost", "Обновить");
  again.type = "button";
  again.addEventListener("click", rescanLocal);
  buttons.append(add, again);
  const draw = () => {
    folders.replaceChildren(...data.folders.map((f) => {
      const row = el("div", "local-folder");
      row.append(el("span", "local-folder-path", f));
      const x = el("button", "btn ghost", "Убрать");
      x.type = "button";
      x.addEventListener("click", () => removeLocalFolder(f));
      row.append(x);
      return row;
    }));
    status.textContent = data.scanning ? `Ищу музыку… найдено ${data.found}`
      : data.folders.length ? `Треков: ${data.tracks.length}` : "Папок пока нет.";
    again.hidden = !data.folders.length;
  };
  onLocalChange(() => { if (section.isConnected) draw(); });
  draw();
  section.append(folders, status, buttons);
  return section;
}
