// Подсказки к функциям: когда человек впервые встречает функцию — маленький пузырёк со стрелкой и «Понятно».
// Каждая подсказка — один раз; одновременно — не больше одной и не чаще раза в 40 секунд; никогда поверх меню,
// окна или экскурсии. Уже пользовались функцией (нажали на кнопку) — подсказка не нужна, не показываем.
// settings.seenTips — какие уже видели (или функцией уже пользовались); settings.tipsOff — подсказки выключены.
// Новому человеку — все; кто обновился со старой версии — только про новое (fresh), остальное он уже знает.

import { isMobile } from "./device.js";
import { getSetting, setSetting } from "./library.js";
import { state } from "./player.js";
import { el } from "./ui.js";

const QUIET_START = 15000;   // первые секунды — приветствие, экскурсия, «Что нового»
const GAP = 40000;           // между подсказками
const DWELL = 700;           // столько держать мышь, чтобы подсказка «при наведении» появилась

let view = "home";
let shown = null;            // { tip, anchor, box }
let lastClosed = 0;
const startedAt = Date.now();

/** Элемент виден на экране (не скрыт и в пределах окна) */
function visible(node) {
  if (!node || node.closest("[hidden]")) return null;
  const r = node.getBoundingClientRect();
  return r.width && r.height && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? node : null;
}
const firstVisible = (sel) => [...document.querySelectorAll(sel)].find((n) => visible(n)) ?? null;

// anchor(элемент под мышью или null) → к чему подсказка; hover — показывается при наведении на это;
// used — щелчок сюда значит «уже пользуется»
const TIPS = [
  {
    id: "trackMenu", fresh: true, title: "Ещё о треке",
    text: "В «⋯» — «О треке» (кто сделал, текст, похожие), «Поделиться картинкой» для сторис, скачать и добавить в плейлист.",
    hover: isMobile ? null : ".track", used: ".t-more",
    anchor: (row) => (row ? row.querySelector(".t-more") : isMobile ? firstVisible("#view-list .track .t-more") : null),
  },
  {
    id: "trackPage", fresh: true, title: "Страница трека",
    text: (isMobile ? "Коснитесь названия" : "Щёлкните по названию") + " — откроется страница трека: кто его сделал, текст, похожие и другие загрузки.",
    used: '#np-info [data-np="title"]',
    anchor: () => (view === "now" && state.current ? visible(document.querySelector('#np-info [data-np="title"]')) : null),
  },
  {
    id: "follow", fresh: true, title: "Подписка",
    text: "Подпишитесь — новые альбомы и треки исполнителя, в том числе с SoundCloud, появятся в «Новинках» на «Главной».",
    used: ".follow-pill",
    anchor: () => firstVisible("#view-list .follow-pill:not(.on)"),
  },
  {
    id: "searchLinks", fresh: true, title: "Ссылки в поиске",
    text: "Сюда можно вставить ссылку на трек, альбом, исполнителя или плейлист из Spotify, Яндекс Музыки, Apple Music, "
      + "Deezer, YouTube или SoundCloud — Sono найдёт его у себя.",
    anchor: () => (view === "home" ? visible(document.getElementById("search")) : null),
  },
  {
    id: "smartShuffle", title: "Умное перемешивание",
    text: "Список вперемешку, а через каждые два трека — похожий, которого в списке нет. Выручает, когда плейлист приелся.",
    used: ".pl-smart",
    anchor: () => firstVisible("#view-list .pl-smart"),
  },
  {
    id: "flow", title: "Flow учится на вас",
    text: "Пропущенное звучит реже, дослушанное и ♡ — чаще, а «Не нравится» убирает трек совсем. Чем больше слушаете, тем точнее подборка.",
    anchor: () => (state.context?.type === "flow" ? firstVisible('[data-np="dislike"]:not(:disabled)') : null),
  },
  {
    id: "lyrics", title: "Текст песни",
    text: (isMobile ? "Коснитесь строки" : "Щёлкните по строке") + " — песня перемотается к ней.",
    used: ".lyrics-line",
    anchor: () => firstVisible("#lyrics .lyrics-line"),
  },
  {
    id: "tray", title: "Sono останется в трее", once: true,
    text: "Если закрыть окно, музыка играет дальше, а Sono прячется в значок у часов (не видно — нажмите стрелку «^» "
      + "рядом с ними). Выйти совсем — правой кнопкой "
      + "по значку → «Выход». Выключается в «Настройках»: «Закрывать в трей».",
    hover: "#tb-close",
    anchor: (btn) => (btn && window.pywebview && getSetting("closeToTray", true) !== false ? btn : null),
  },
];

const seen = () => getSetting("seenTips", []) || [];
const isSeen = (id) => seen().includes(id);
function markSeen(id) {
  if (!isSeen(id)) setSetting("seenTips", [...seen(), id]);
}

/** Сейчас можно показать подсказку: включены, окно на виду, нет меню, окон, экскурсии */
function calm() {
  return !getSetting("tipsOff", false) && !shown && document.visibilityState === "visible"
    && Date.now() - startedAt > QUIET_START && Date.now() - lastClosed > GAP
    && !document.querySelector(".menu.open, .dialog-backdrop, .tour, .welcome");
}

// ---------- Пузырёк ----------

/** Где элемент. У строки текста (название на «Сейчас играет» во всю ширину) — где сам текст: стрелка на него */
function rectOf(anchor) {
  const box = anchor.getBoundingClientRect();
  if (anchor.matches("button, input, a")) return box;
  const range = document.createRange();
  range.selectNodeContents(anchor);
  const text = range.getBoundingClientRect();
  return text.width && text.width < box.width ? text : box;
}

function place() {
  if (!shown) return;
  const { anchor, box } = shown;
  if (!visible(anchor) || !anchor.isConnected) return hide(false);   // ушли со страницы, прокрутили — уберём
  const r = rectOf(anchor), gap = 12;
  const w = box.offsetWidth, h = box.offsetHeight;
  const below = r.bottom + gap + h < innerHeight - 8 || r.top - gap - h < 8;
  const x = Math.max(10, Math.min(innerWidth - w - 10, r.left + r.width / 2 - w / 2));
  const y = below ? r.bottom + gap : r.top - gap - h;
  box.classList.toggle("above", !below);
  box.style.left = `${x}px`;
  box.style.top = `${Math.max(8, y)}px`;
  box.style.setProperty("--arrow-x", `${Math.max(16, Math.min(w - 16, r.left + r.width / 2 - x))}px`);
}

/** Убрать подсказку. read — человек её видел («Понятно», Esc, щелчок мимо): больше не показываем */
function hide(read = true) {
  if (!shown) return;
  const { tip, anchor, box } = shown;
  shown = null;
  lastClosed = Date.now();
  if (read) markSeen(tip.id);
  anchor.classList.remove("tip-target");
  box.classList.add("leaving");
  setTimeout(() => box.remove(), 200);
}

function show(tip, anchor) {
  document.querySelectorAll(".tip.leaving").forEach((old) => old.remove());
  const box = el("div", "tip");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", tip.title);
  const ok = el("button", "btn primary tip-ok", "Понятно");
  ok.type = "button";
  ok.addEventListener("click", () => hide());
  box.append(el("div", "tip-title", tip.title), el("p", "tip-text", tip.text), ok);
  document.body.append(box);
  anchor.classList.add("tip-target");   // кнопки «⋯» видны только при наведении — пока подсказка, держим видимой
  shown = { tip, anchor, box };
  if (tip.once) markSeen(tip.id);
  place();
}

/** Ищем подсказку, которую пора показать (то, что видно сейчас на экране) */
function check() {
  if (!calm()) return;
  for (const tip of TIPS) {
    if (isSeen(tip.id) || tip.hover && !isMobile) continue;
    const anchor = tip.anchor(null);
    if (anchor) return show(tip, anchor);
  }
}

// ---------- Включение ----------

let hoverTimer = 0;

/** newcomer — новый человек (ему все подсказки); иначе при первом запуске с подсказками — только новые */
export function initTips(newcomer) {
  if (getSetting("seenTips", null) === null) {
    setSetting("seenTips", newcomer ? [] : TIPS.filter((t) => !t.fresh).map((t) => t.id));
  }
  document.addEventListener("sono:view", (e) => {
    view = e.detail;
    if (shown) hide(false);
    setTimeout(check, 900);
  });
  setInterval(check, 2500);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && shown) hide();
  });
  // Щелчок: по подсказке — ничего; по функции — «уже пользуется»; куда угодно ещё — подсказка прочитана
  document.addEventListener("pointerdown", (e) => {
    const target = e.target;
    for (const tip of TIPS) if (tip.used && target.closest?.(tip.used)) markSeen(tip.id);
    if (shown && !shown.box.contains(target)) hide();
  }, true);
  document.addEventListener("paste", (e) => {
    if (e.target.id === "search" && /https?:\/\//.test(e.clipboardData?.getData("text") || "")) markSeen("searchLinks");
  }, true);
  // Подсказки «при наведении»: держим мышь на строке трека (или на крестике окна) — появляется пузырёк
  if (!isMobile) {
    document.addEventListener("pointerover", (e) => {
      clearTimeout(hoverTimer);
      if (!calm()) return;
      const tip = TIPS.find((t) => t.hover && !isSeen(t.id) && e.target.closest?.(t.hover));
      if (!tip) return;
      const over = e.target.closest(tip.hover);
      hoverTimer = setTimeout(() => {
        if (!over.matches(":hover") || !calm()) return;
        const anchor = tip.anchor(over);
        if (anchor) show(tip, anchor);
      }, tip.id === "tray" ? 350 : DWELL);
    });
  }
}

/** Настройки: включить/выключить и показать все заново */
export const tipsOn = () => !getSetting("tipsOff", false);
export function setTipsOn(on) {
  setSetting("tipsOff", !on);
  if (!on) hide(false);
}
export function resetTips() {
  setSetting("tipsOff", false);
  setSetting("seenTips", []);
  lastClosed = 0;
}
