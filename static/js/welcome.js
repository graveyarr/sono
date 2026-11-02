// Первый запуск: приветствие в несколько шагов (что такое Sono → чтобы не тормозило → перенести музыку)
// и экскурсия по интерфейсу — подсветка частей окна с подсказками.
// Показывается один раз (settings.onboarded); снова — кнопкой в настройках.

import { openImportDialog } from "./import.js";
import { getSetting, lib, setSetting } from "./library.js";
import { openView } from "./nav.js";
import { el, openModal, toast } from "./ui.js";

// ---------- Приветствие ----------

const STEPS = ["hello", "network", "import", "tour"];

export function showWelcome() {
  const { box, close } = openModal({ className: "welcome", onClose: () => setSetting("onboarded", true) });
  box.onsubmit = (e) => e.preventDefault();
  let step = 0;

  // skip — подпись второй кнопки, которая закрывает приветствие («Пропустить», «Не сейчас»)
  const nav = (primaryLabel, onPrimary, { skip = null } = {}) => {
    const row = el("div", "welcome-nav");
    const dots = el("div", "welcome-dots");
    STEPS.forEach((_, i) => dots.append(el("i", i === step ? "on" : "")));
    const buttons = el("div", "welcome-buttons");
    if (skip) {
      const later = el("button", "btn ghost", skip);
      later.type = "button";
      later.addEventListener("click", close);
      buttons.append(later);
    }
    const primary = el("button", "btn primary", primaryLabel);
    primary.type = "button";
    primary.addEventListener("click", onPrimary);
    buttons.append(primary);
    row.append(dots, buttons);
    return row;
  };

  const go = (i) => {
    step = i;
    box.replaceChildren(...{ hello, network, import: importStep, tour }[STEPS[i]]());
    box.classList.remove("step-in");
    void box.offsetWidth;
    box.classList.add("step-in");
  };

  function hello() {
    const logo = el("div", "welcome-logo", "sono.");
    return [logo, el("h2", "", "Привет! Это Sono"),
      el("p", "", "Музыка с YouTube и SoundCloud в одном красивом плеере: без рекламы, без аккаунтов, с плейлистами, "
        + "текстами песен, бесконечным Flow и скачиванием для офлайна."),
      el("p", "welcome-muted", "Пара минут настройки — и всё будет работать как надо."),
      nav("Начнём", () => go(1), { skip: "Пропустить" })];
  }

  function network() {
    const result = el("div", "welcome-result");
    const test = el("button", "btn ghost", "Проверить скорость");
    test.type = "button";
    test.addEventListener("click", () => runNetworkTest(result, test));
    const zap = el("button", "btn ghost", "У меня есть zapret");
    zap.type = "button";
    zap.addEventListener("click", () => {
      close();
      openView("settings");
      setTimeout(() => document.querySelector(".zapret-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    });
    const actions = el("div", "welcome-actions");
    actions.append(test, zap);
    return [el("h2", "", "Чтобы музыка не тормозила"),
      el("p", "", "В России YouTube и SoundCloud часто замедляют. В Sono есть встроенный обход — он уже включён. "
        + "Проверьте, какой способ быстрее у вашего провайдера, — это займёт до минуты."),
      el("p", "welcome-muted", "Если у вас скачан zapret, Sono может настроить и его — сам подберёт стратегию."),
      actions, result,
      nav("Дальше", () => go(2))];
  }

  function importStep() {
    const link = el("button", "btn ghost", "Плейлист по ссылке");
    link.type = "button";
    link.addEventListener("click", () => {
      close();
      openImportDialog({ onOpen: (id) => openView(`playlist:${id}`) });
    });
    const restore = el("button", "btn ghost", "Копия медиатеки Sono");
    restore.type = "button";
    const picker = el("input");
    Object.assign(picker, { type: "file", accept: ".json,application/json", hidden: true });
    restore.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => restoreBackup(picker));
    const actions = el("div", "welcome-actions");
    actions.append(link, restore, picker);
    return [el("h2", "", "Перенесите свою музыку"),
      el("p", "", "Плейлисты и альбомы можно перенести по ссылке из Spotify, Яндекс Музыки, Apple Music, Deezer, "
        + "YouTube и SoundCloud — или просто списком «Исполнитель — Название» (например, из VK)."),
      el("p", "welcome-muted", "Если вы уже пользовались Sono на другом компьютере — восстановите копию медиатеки."),
      actions,
      nav("Дальше", () => go(3))];
  }

  function tour() {
    return [el("h2", "", "Покажу, что где?"),
      el("p", "", "Короткая экскурсия: поиск, медиатека, Flow, плеер и настройки. Меньше минуты."),
      nav("Показать", () => { close(); startTour(); }, { skip: "Не сейчас" })];
  }

  go(0);
}

async function runNetworkTest(result, button) {
  button.disabled = true;
  button.textContent = "Проверяю… (до минуты)";
  result.replaceChildren(el("div", "welcome-spinner"));
  try {
    const [res, net] = await Promise.all([fetch("/api/network/test", { method: "POST" }), fetch("/api/network")]);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "замер не удался");
    const names = Object.fromEntries((await net.json()).strategies);
    const ok = data.results.filter((r) => r.youtube);
    const best = ok.sort((a, b) => b.youtube - a.youtube)[0];
    const direct = data.results.find((r) => r.name === "off");
    if (!best) {
      result.replaceChildren(el("p", "import-error", "YouTube не открылся ни одним способом. Попробуйте zapret или свой VPN — это в настройках."));
    } else if (best.name === "off" || (direct?.youtube && direct.youtube >= best.youtube * 0.8)) {
      result.replaceChildren(el("p", "welcome-ok", `Всё хорошо: YouTube и так работает быстро (${direct.youtube} МБ/с).`));
    } else {
      const label = names[best.name] ?? best.name;
      await fetch("/api/network", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "bypass", strategy: best.name }) });
      result.replaceChildren(el("p", "welcome-ok",
        `Готово: включил «${label}» — ${best.youtube} МБ/с${direct?.youtube ? ` (напрямую — ${direct.youtube} МБ/с)` : ""}.`));
    }
  } catch (err) {
    result.replaceChildren(el("p", "import-error", `Не получилось проверить: ${err.message}`));
  }
  button.disabled = false;
  button.textContent = "Проверить ещё раз";
}

async function restoreBackup(picker) {
  const file = picker.files[0];
  picker.value = "";
  if (!file) return;
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { return toast("Файл не читается — это не копия медиатеки", { error: true }); }
  const res = await fetch("/api/library/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup) });
  const data = await res.json();
  if (!res.ok) return toast(data.error, { error: true });
  setSetting("onboarded", true);
  toast(`Восстановлено: плейлистов ${data.added.playlists}, в избранное ${data.added.liked}`);
  setTimeout(() => location.reload(), 1200);
}

// ---------- Экскурсия ----------
// Затемняем всё, кроме одной части окна («прожектор»), рядом — карточка с подсказкой

const TOUR = [
  { sel: "#search", title: "Поиск", text: "Ищите что угодно: трек, исполнителя, альбом. Имя исполнителя откроет его страницу — с дискографией и похожими." },
  { sel: "#source-btn", title: "Где искать", text: "Эта кнопка переключает поиск между YouTube и SoundCloud." },
  { sel: ".flow-card", title: "Flow", text: "Бесконечная музыка под ваш вкус. Учится на лайках и пропусках: пропущенное звучит реже, дослушанное — чаще." },
  { sel: "#lib-list", title: "Медиатека", text: "Избранное и ваши плейлисты. В каждом плейлисте есть кнопка Flow — поток в его духе." },
  { sel: "#new-playlist", title: "Новый плейлист или импорт", text: "Создайте плейлист или перенесите его по ссылке из Spotify, Яндекс Музыки и других сервисов." },
  { sel: "#nav-now", title: "Сейчас играет", text: "Большая обложка, визуализация под музыку, очередь, текст песни и звуковые эффекты (slowed + reverb, басы)." },
  { sel: "#nav-settings", title: "Настройки", text: "Обход блокировок, zapret, оформление, Discord и копия медиатеки. Это знакомство тоже можно повторить там." },
];

export function startTour() {
  openView("home");
  const steps = TOUR.filter((s) => !(document.body.classList.contains("sidebar-hidden") && s.sel.startsWith("#lib") ));
  const layer = el("div", "tour");
  const hole = el("div", "tour-hole");
  const card = el("div", "tour-card");
  layer.append(hole, card);
  document.body.append(layer);
  let i = 0;

  const finish = () => {
    layer.classList.add("leaving");
    setTimeout(() => layer.remove(), 250);
    removeEventListener("keydown", onKey, true);
    removeEventListener("resize", place);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); if (i > 0) show(i - 1); }
  };
  const next = () => (i < steps.length - 1 ? show(i + 1) : finish());

  function place() {
    const target = document.querySelector(steps[i].sel);
    if (!target) return;
    const r = target.getBoundingClientRect(), pad = 8;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    // Карточка: справа от узких частей слева (медиатека), иначе снизу или сверху — где есть место
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 16;
    let x, y;
    if (r.right < innerWidth * 0.3) { x = r.right + gap + pad; y = r.top + r.height / 2 - ch / 2; }
    else {
      x = r.left + r.width / 2 - cw / 2;
      y = r.bottom + gap + pad + ch < innerHeight ? r.bottom + gap + pad : r.top - gap - pad - ch;
    }
    card.style.left = `${Math.max(12, Math.min(innerWidth - cw - 12, x))}px`;
    card.style.top = `${Math.max(12, Math.min(innerHeight - ch - 12, y))}px`;
  }

  function show(n) {
    i = n;
    const s = steps[i];
    const close = el("button", "icon-btn tour-close", "×");
    close.type = "button";
    close.title = "Закончить";
    close.addEventListener("click", finish);
    const row = el("div", "tour-row");
    row.append(el("span", "tour-count", `${i + 1} из ${steps.length}`));
    if (i > 0) {
      const back = el("button", "btn ghost", "Назад");
      back.type = "button";
      back.addEventListener("click", () => show(i - 1));
      row.append(back);
    }
    const nextBtn = el("button", "btn primary", i < steps.length - 1 ? "Далее" : "Готово");
    nextBtn.type = "button";
    nextBtn.addEventListener("click", next);
    row.append(nextBtn);
    card.replaceChildren(close, el("div", "tour-title", s.title), el("p", "tour-text", s.text), row);
    card.classList.remove("step-in");
    void card.offsetWidth;
    card.classList.add("step-in");
    place();
    nextBtn.focus();
  }

  addEventListener("keydown", onKey, true);
  addEventListener("resize", place);
  layer.addEventListener("pointerdown", (e) => { if (e.target === layer) next(); });
  requestAnimationFrame(() => show(0));
}

/** При запуске: новичку — приветствие. У кого медиатека уже есть (обновились со старой версии) — не показываем */
export function maybeWelcome() {
  if (getSetting("onboarded", false)) return;
  if (lib.history.length || lib.liked.length || lib.playlists.length) {
    setSetting("onboarded", true);
    return;
  }
  setTimeout(showWelcome, 600);
}
