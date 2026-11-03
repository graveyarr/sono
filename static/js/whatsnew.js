// Окно «Что нового»: после обновления один раз коротко рассказывает, что изменилось.
// Какая версия запущена — спрашиваем сервер (/api/app-update → current, её пишет build.py).
// settings.seenVersion — версия, о которой человеку уже рассказали.
// Новому пользователю не показываем (у него приветствие), из исходников (версии нет) — только по кнопке.

import { CHANGELOG } from "./changelog.js";
import { icons } from "./icons.js";
import { getSetting, setSetting } from "./library.js";
import { el, openModal } from "./ui.js";

const parts = (v) => String(v).split(".").map((x) => parseInt(x, 10) || 0);
/** −1, 0, 1 — как сравнивать номера версий «0.6.10» и «0.6.9» */
function compare(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  return 0;
}

/** Окно с изменениями: entries — записи из CHANGELOG (новые сверху) */
export function showWhatsNew(entries = CHANGELOG.slice(0, 1)) {
  if (!entries.length) return;
  const { box, close } = openModal({ className: "whatsnew" });
  box.addEventListener("submit", (e) => { e.preventDefault(); close(); });
  const head = el("div", "wn-head");
  head.append(el("div", "wn-kicker", entries.length > 1 ? `Вы обновились до ${entries[0].version}` : entries[0].date),
    el("h2", "", entries.length > 1 ? "Что нового в Sono" : `Что нового в Sono ${entries[0].version}`));
  const list = el("div", "wn-list");
  for (const entry of entries) {
    if (entries.length > 1) list.append(el("div", "wn-version", `${entry.version} · ${entry.date}`));
    for (const item of entry.items) {
      const row = el("div", "wn-item");
      const icon = el("span", "wn-icon");
      icon.innerHTML = icons[item.icon] ?? icons.check;
      const text = el("div", "wn-text");
      text.append(el("div", "wn-title", item.title), el("div", "wn-sub", item.text));
      row.append(icon, text);
      list.append(row);
    }
  }
  const buttons = el("div", "dialog-buttons");
  const all = el("button", "btn ghost", "Все выпуски на GitHub");
  all.type = "button";
  all.addEventListener("click", () => fetch("/api/open-releases", { method: "POST" }).catch(() => {}));
  const ok = el("button", "btn primary", "Понятно");
  ok.type = "submit";
  buttons.append(all, ok);
  box.append(head, list, buttons);
  ok.focus();
}

/** При запуске: обновились — показать, что изменилось с прошлой виденной версии (не больше трёх версий) */
export async function maybeWhatsNew() {
  const current = await fetch("/api/app-update").then((r) => r.json()).then((u) => u.current).catch(() => null);
  if (!current || current === "0") return;   // запуск из исходников — версии нет
  const seen = getSetting("seenVersion", null);
  if (seen === current) return;
  setSetting("seenVersion", current);
  if (!getSetting("onboarded", false)) return;   // новый человек — ему показывают приветствие, не список изменений
  // Раньше версию не запоминали (до 0.6.3) — покажем только текущую
  const entries = CHANGELOG.filter((e) => compare(e.version, current) <= 0 && (!seen || compare(e.version, seen) > 0));
  showWhatsNew((seen ? entries : entries.slice(0, 1)).slice(0, 3));
}
