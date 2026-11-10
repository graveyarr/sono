// Раздел настроек «Система»: запуск вместе с Windows, глобальные клавиши и кэш на диске.
// Автозапуск и кэш — сервер (app.py: /api/autostart, /api/cache), клавиши — значок в трее (tray.py, RegisterHotKey).
// Клавиши срабатывают из любой программы и зовут window.sonoTray(действие) из main.js.

import { getSetting, setSetting } from "./library.js";
import { confirmDialog, el, toast } from "./ui.js";

const api = () => window.pywebview?.api?.set_hotkeys ? window.pywebview.api : null;

let hotkeys = null;   // ответ tray.set_hotkeys: { ok, keys: [[подпись, действие]], busy: [подписи] }

/** Включить/выключить глобальные клавиши по настройке. Значок в трее появляется чуть позже окна —
    если его ещё нет (ok: false), пробуем ещё пару раз. */
async function applyHotkeys(tries = 3) {
  const a = api();
  if (!a) return null;
  try {
    hotkeys = await a.set_hotkeys(!!getSetting("globalHotkeys", false));
  } catch {
    hotkeys = null;
  }
  if (!hotkeys?.ok && tries > 1) setTimeout(() => applyHotkeys(tries - 1), 2000);
  return hotkeys;
}

export function initSystem() {
  if (window.pywebview?.api) applyHotkeys();
  else addEventListener("pywebviewready", () => applyHotkeys(), { once: true });
}

// ---------- Кэш ----------

const LIMITS = [
  { id: "1", title: "1 ГБ", hint: "Прослушанные треки — не больше 1 ГБ: самые давние удаляются сами." },
  { id: "2", title: "2 ГБ", hint: "Прослушанные треки — не больше 2 ГБ: самые давние удаляются сами." },
  { id: "5", title: "5 ГБ", hint: "Прослушанные треки — не больше 5 ГБ: самые давние удаляются сами." },
  { id: "10", title: "10 ГБ", hint: "Прослушанные треки — не больше 10 ГБ: самые давние удаляются сами." },
  { id: "0", title: "Без предела", hint: "Всё прослушанное остаётся на диске — папка будет только расти." },
];

/** 1 234 567 890 → «1,1 ГБ» */
function bytes(n) {
  if (!n) return "0 МБ";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace(".", ",")} ГБ`;
  const mb = n / 1024 ** 2;
  return `${mb < 10 ? mb.toFixed(1).replace(".", ",") : Math.round(mb)} МБ`;
}

function usageLine(box, usage) {
  const parts = [
    ["Прослушанная музыка", usage.music],
    ["Обложки и картинки", usage.images],
    ["Тексты и страницы исполнителей", usage.other],
    ["Скачанное вами (не удаляется)", usage.downloaded],
  ];
  const list = el("div", "cache-usage");
  for (const [name, size] of parts) {
    const row = el("div", "cache-row");
    row.append(el("span", "", name), el("b", "", bytes(size)));
    list.append(row);
  }
  box.replaceChildren(el("div", "cache-total", `Всего: ${bytes(usage.total)}`), list);
}

function cacheBlock(choiceRow) {
  const wrap = el("div", "set-cache");
  wrap.append(el("p", "set-text", "Sono оставляет прослушанные треки на диске — второй раз они включаются мгновенно и без интернета. "
    + "Чтобы папка не росла без конца, самые давние удаляются сами."));
  const usage = el("div", "cache-box", "Считаю, сколько занято…");
  const current = () => String(getSetting("cacheLimitGb", 5));
  const choose = async (id) => {
    const limitGb = Number(id);
    setSetting("cacheLimitGb", limitGb);
    if (!limitGb) return;
    try {
      const data = await (await fetch("/api/cache/trim", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limitGb }),
      })).json();
      usageLine(usage, data.usage);
      if (data.freed) toast(`Освобождено ${bytes(data.freed)}`);
    } catch { /* посчитается при следующем открытии */ }
  };
  const actions = el("div", "set-actions");
  const clear = el("button", "btn ghost", "Очистить кэш");
  clear.type = "button";
  clear.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Очистить кэш?",
      text: "Удалятся прослушанные треки, обложки и сохранённые страницы — потом они снова загрузятся из интернета. "
        + "Скачанное вами, плейлисты и избранное останутся.",
      okLabel: "Очистить",
    });
    if (!ok) return;
    clear.disabled = true;
    try {
      const data = await (await fetch("/api/cache/clear", { method: "POST" })).json();
      usageLine(usage, data.usage);
      toast(data.freed ? `Освобождено ${bytes(data.freed)}` : "Удалять нечего — кэш уже пустой");
    } catch (err) {
      toast("Не получилось очистить кэш: " + err.message, { error: true });
    } finally {
      clear.disabled = false;
    }
  });
  actions.append(clear);
  wrap.append(usage, choiceRow("Предел кэша", LIMITS, current, choose), actions,
    el("p", "set-hint", "Трек, который сейчас играет или только что скачался, не удаляется."));
  fetch("/api/cache").then((r) => r.json()).then((data) => usageLine(usage, data.usage))
    .catch(() => { usage.textContent = "Не получилось посчитать — сервер не ответил."; });
  return wrap;
}

// ---------- Сам раздел ----------

/** helpers — switchRow/choiceRow из settings.js (передаём, чтобы не было круговых импортов) */
export function systemSection({ switchRow, choiceRow }) {
  const section = el("section", "set-card");
  section.append(el("h2", "", "Система"));

  // Запуск вместе с Windows — сразу в трей
  const autostart = el("div", "set-autostart");
  section.append(autostart);
  const drawAutostart = (info) => {
    const sub = info.available
      ? "Sono запускается при входе в Windows и ждёт в трее (у часов) — окно не выскакивает. Открыть — щелчком по значку."
      : `${info.why || "Нет связи с сервером"}.`;
    const row = switchRow("Запускать вместе с Windows", sub, !!info.on, async (on) => {
      try {
        const res = await fetch("/api/autostart", {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        drawAutostart(data);
      } catch (err) {
        toast(err.message, { error: true });
        drawAutostart({ ...info });
      }
    });
    row.querySelector("input").disabled = !info.available;
    row.classList.toggle("off", !info.available);
    autostart.replaceChildren(row);
  };
  drawAutostart({ available: false, why: "проверяю…" });
  fetch("/api/autostart").then((r) => r.json()).then(drawAutostart).catch(() => drawAutostart({ available: false }));

  // Глобальные клавиши
  const keysBox = el("div", "set-hotkeys");
  const drawKeys = () => {
    const inApp = !!api();
    const on = !!getSetting("globalHotkeys", false);
    const sub = inApp
      ? "Пауза, переключение треков и громкость — из любой программы, даже когда Sono свёрнут или в трее."
      : "Работает только в программе Sono (сейчас открыто в браузере).";
    const row = switchRow("Глобальные клавиши", sub, on, async (value) => {
      setSetting("globalHotkeys", value);
      await applyHotkeys(1);
      drawKeys();
      if (value && hotkeys?.busy?.length) toast(`Заняты другой программой: ${hotkeys.busy.join(", ")}`, { error: true });
    });
    row.querySelector("input").disabled = !inApp;
    row.classList.toggle("off", !inApp);
    const list = el("div", "hotkey-list");
    const names = { toggle: "пауза / играть", next: "следующий трек", prev: "предыдущий трек",
      volup: "громче", voldown: "тише", like: "в избранное ♡" };
    const keys = hotkeys?.keys ?? [["Ctrl+Alt+P", "toggle"], ["Ctrl+Alt+→", "next"], ["Ctrl+Alt+←", "prev"],
      ["Ctrl+Alt+↑", "volup"], ["Ctrl+Alt+↓", "voldown"], ["Ctrl+Alt+L", "like"]];
    const busy = new Set(hotkeys?.busy ?? []);
    for (const [label, action] of keys) {
      const item = el("div", `hotkey${busy.has(label) && on ? " busy" : ""}`);
      item.append(el("kbd", "", label), el("span", "", busy.has(label) && on ? `${names[action]} — занята другой программой` : names[action]));
      list.append(item);
    }
    keysBox.replaceChildren(row, list);
  };
  drawKeys();
  section.append(keysBox);

  section.append(el("h3", "set-sub-title", "Кэш на диске"), cacheBlock(choiceRow));
  return section;
}
