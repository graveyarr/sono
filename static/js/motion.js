// Анимации «Живой обложки» (ПК): смена трека, пауза, переходы между экранами, лайк, фон под бас.
// Всё здесь — короткие анимации через element.animate(): на них не действуют правила CSS, поэтому
// каждая сама проверяет calm() — «Меньше движения» (Настройки → Оформление или настройка системы)
// и «Без анимаций». Телефон пока не трогаем (свой шаг), поэтому на нём всё выключено.
// Импортирует только library.js и device.js — его можно брать в player.js, lyrics.js и views.js.

import { isMobile } from "./device.js";
import { getSetting, motionOff } from "./library.js";

export const EASE = "cubic-bezier(.22,1,.36,1)";   // одна «пружина» на всё (как --ease в style.css)
const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");

/** Новый вид — на компьютере (телефон переделываем отдельным шагом) */
export const liveUi = () => !isMobile;
document.documentElement.classList.toggle("live-ui", liveUi());   // style.css: цвета обложки перетекают плавно

/** «Меньше движения»: только мягкие проявления, ничего не едет и не крутится */
export const calm = () => isMobile || motionOff() || reduceQuery.matches || getSetting("calmMotion", false) === true;

/** Класс body.calm — для CSS (фон не плывёт, переходы — только прозрачность) */
export function applyCalm() {
  document.body.classList.toggle("calm", liveUi() && calm());   // телефон пока прежний — его фон не трогаем
}
reduceQuery.addEventListener?.("change", applyCalm);

/** Элемент виден на экране (не в спрятанном экране) */
const shown = (node) => !!node?.isConnected && node.getClientRects().length > 0;

/** Анимация, если можно двигаться; иначе — ничего (null) */
export function anim(node, frames, options) {
  if (calm() || !shown(node)) return null;
  return node.animate(frames, { easing: EASE, fill: "both", ...options });
}

/** Загрузить картинку заранее (не дольше 4 с): старая обложка не уезжает, пока новая не готова —
    иначе, пока сервер её готовит, на месте обложки пусто */
function preload(src) {
  const pic = new Image();
  pic.src = src;
  return Promise.race([pic.decode().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
}

/** Обложка сменилась: старая уходит вбок с размытием, новая выезжает навстречу. dir: 1 — вперёд, −1 — назад */
export async function swapImage(img, src, dir = 1) {
  if (!img) return;
  if (calm() || !shown(img) || !img.getAttribute("src")) { img.dataset.want = src; img.src = src; return; }
  img.dataset.want = src;
  await preload(src);
  if (img.dataset.want !== src) return;   // пока грузилась, включили ещё один трек
  await img.animate([{ opacity: 1, transform: "none", filter: "blur(0)" },
    { opacity: 0, transform: `translateX(${-dir * 22}px) scale(.94)`, filter: "blur(8px)" }],
  { duration: 210, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
  if (img.dataset.want !== src) return;   // пока уходила, включили ещё один трек — его обложка уже едет
  img.src = src;
  await img.decode().catch(() => {});
  img.animate([{ opacity: 0, transform: `translateX(${dir * 28}px) scale(1.05)`, filter: "blur(12px)" },
    { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 620, easing: EASE, fill: "forwards" });
}

/** Обложка в капсуле переворачивается, как монетка */
export async function flipImage(img, src, dir = 1) {
  if (!img) return;
  if (calm() || !shown(img) || !img.getAttribute("src")) { img.dataset.want = src; img.src = src; return; }
  img.dataset.want = src;
  await preload(src);
  if (img.dataset.want !== src) return;
  await img.animate([{ transform: "rotateY(0)" }, { transform: `rotateY(${dir * 90}deg)` }],
    { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
  if (img.dataset.want !== src) return;
  img.src = src;
  await img.decode().catch(() => {});
  img.animate([{ transform: `rotateY(${-dir * 90}deg)` }, { transform: "rotateY(0)" }],
    { duration: 520, easing: "cubic-bezier(.3,1.4,.5,1)", fill: "forwards" });
}

/** Крупное название: слова поднимаются по одному. Возвращает узлы слов */
export function riseWords(node, text, { delay = 140, animate = true } = {}) {
  node.replaceChildren();
  const words = String(text || "").split(/(\s+)/);
  const spans = [];
  for (const part of words) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { node.append(" "); continue; }
    const w = document.createElement("span");
    w.className = "wd";
    w.textContent = part;
    node.append(w);
    spans.push(w);
  }
  if (animate && !calm() && shown(node)) {
    spans.forEach((w, i) => w.animate([{ opacity: 0, transform: "translateY(.4em)", filter: "blur(8px)" },
      { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 560, delay: delay + Math.min(i, 12) * 60, easing: EASE, fill: "backwards" }));
  }
  return spans;
}

/** Мелкий текст: мягко поднимается (подпись, исполнитель) */
export function fadeUp(node, delay = 200) {
  anim(node, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 450, delay, fill: "backwards" });
}

/** Блик по стеклу (верхняя карточка, капсула): внутри — .sheen-box > i */
export function sheen(box) {
  const i = box?.querySelector(":scope > .sheen-box > i");
  if (i) anim(i, [{ translate: "-120% 0" }, { translate: "260% 0" }], { duration: 1100, delay: 120, easing: "cubic-bezier(.45,0,.2,1)", fill: "none" });
}

/** Кусок экрана выплывает из размытия (вход на экран). Один кадр — с offset: 0, иначе он считается КОНЕЧНЫМ */
export function rise(node, delay = 0, dist = 18, duration = 650) {
  return anim(node, [{ offset: 0, opacity: 0, transform: `translateY(${dist}px)`, filter: "blur(10px)" }],
    { duration, delay, fill: "backwards" });
}

// ---------- Пауза: пластинка в капсуле плавно останавливается и разгоняется ----------

let spin = null, rampTimer = 0;
/** Обложка-пластинка в капсуле крутится (16 с на оборот); на паузе — плавно тормозит за 0,9 с */
export function setDiscSpinning(img, playing) {
  if (!img || !liveUi()) return;
  if (!spin || spin.effect?.target !== img) {
    spin?.cancel();
    spin = img.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: 16000, iterations: Infinity });
    if (!playing) spin.pause();
  }
  clearInterval(rampTimer);
  if (calm()) { spin.pause(); return; }   // «Меньше движения» и «Без анимаций» — пластинка стоит
  const from = spin.playState === "paused" ? 0 : spin.playbackRate, to = playing ? 1 : 0, t0 = performance.now();
  if (playing && spin.playState === "paused") { spin.updatePlaybackRate(0.0001); spin.play(); }
  rampTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / 900), e = 1 - (1 - k) ** 3;
    spin.updatePlaybackRate(from + (to - from) * e || 0.0001);
    if (k >= 1) { clearInterval(rampTimer); if (!playing) spin.pause(); }
  }, 30);
}

// Включили или выключили «Меньше движения» / «Без анимаций» (settings.js → событие sono:motion)
document.addEventListener("sono:motion", () => {
  applyCalm();
  if (spin) setDiscSpinning(spin.effect?.target, !document.getElementById("player")?.paused);
});

// ---------- Лайк: сердечко подпрыгивает, искры цвета обложки ----------

/** Сердечки текущего трека на экране (капсула, карточка на «Главной», «Сейчас играет») */
export function burstLike() {
  if (!liveUi()) return;
  // После лайка значки перерисовываются (player.js → syncLikeButtons) — ждём новый svg
  setTimeout(() => {
    for (const b of document.querySelectorAll('[data-np="like"]')) {
      if (!shown(b)) continue;
      const svg = b.querySelector("svg");
      if (svg) anim(svg, [{ scale: 1 }, { scale: 0.6 }, { scale: 1.35 }, { scale: 1 }], { duration: 560, easing: "ease-out", fill: "none" });
      if (calm()) continue;
      for (let k = 0; k < 10; k++) {
        const sp = document.createElement("i");
        sp.className = "spark";
        b.append(sp);
        const a = (k / 10) * Math.PI * 2 + Math.random() * 0.4, d = 22 + Math.random() * 16;
        sp.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 },
          { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px) scale(0)`, opacity: 0 }],
        { duration: 650, easing: EASE }).finished.then(() => sp.remove(), () => sp.remove());
      }
    }
  }, 0);
}

// ---------- Переход между экранами (View Transitions) ----------

/** Сменить экран с переходом: обложка перелетает, старый экран тает, новый собирается по кусочкам.
    update() меняет экран; enter() — анимации входа. Возвращает обещание «экран уже сменился» */
export function withTransition(update, enter) {
  const can = liveUi() && !calm() && !document.hidden && typeof document.startViewTransition === "function";
  if (!can) { update(); return Promise.resolve(); }
  const t = document.startViewTransition(() => { update(); enter?.(); });
  t.finished.catch(() => {});
  return t.updateCallbackDone.catch(() => {});
}

// ---------- Фон под бас (выключен по умолчанию; Настройки → Оформление) ----------

export const bgBeatOn = () => liveUi() && getSetting("bgBeat", false) === true;

/** Удар баса (beat.js): фон чуть «толкается», снизу — свечение цвета обложки. strong — сильная доля */
export function bgBeat(strong) {
  if (!bgBeatOn() || calm()) return;
  const bg = document.querySelector(".backdrop");
  const glow = document.querySelector(".bg-beat");
  bg?.animate([{ scale: 1, easing: "cubic-bezier(.2,.9,.3,1)" }, { scale: strong ? 1.035 : 1.015, offset: 0.14, easing: "cubic-bezier(.4,0,.2,1)" }, { scale: 1 }],
    { duration: 700 });
  glow?.animate([{ opacity: 0, easing: "cubic-bezier(.2,.9,.3,1)" }, { opacity: strong ? 0.55 : 0.25, offset: 0.12, easing: "cubic-bezier(.4,0,.2,1)" }, { opacity: 0 }],
    { duration: 820 });
}
