// Капсула-плеер («Живая обложка», ПК): светящийся край-полоска и время у курсора над ним.
// Полоска — тонкий край по низу капсулы (style.css → .minibar .mini-progress). Наводите — над капсулой
// белая пилюля «1:24 / 3:05» ровно над курсором; тянете — она едет вместе с ним. Сама перемотка — как
// раньше (player.js слушает этот же ползунок). Без зависимостей от других модулей: длительность читаем
// из того же текста «0:00», что пишет player.js.

const bar = document.getElementById("minibar");
const input = bar?.querySelector('.mini-progress input[data-np="seek"]');
const total = bar?.querySelector('[data-np="time-total"]');
const strip = input?.parentElement;   // .mini-progress — рисует закрашенное и подсветку (style.css)

/** «3:05» или «1:02:03» → секунды */
function seconds(text) {
  const parts = String(text || "").trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

export function initCapsule() {
  if (!bar || !input) return;
  const tip = document.createElement("div");
  tip.className = "seek-tip";
  tip.setAttribute("aria-hidden", "true");
  bar.append(tip);
  let dragging = false;
  // Сколько закрашено: player.js пишет --p в сам ползунок, а светящуюся линию рисует его родитель —
  // переносим значение туда (переменная не доходит от ребёнка к родителю сама)
  const syncFill = () => strip.style.setProperty("--p", input.style.getPropertyValue("--p") || "0%");
  new MutationObserver(syncFill).observe(input, { attributes: true, attributeFilter: ["style"] });
  syncFill();

  const show = (x) => {
    const r = input.getBoundingClientRect(), box = bar.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.max(0, Math.min(1, (x - r.left) / r.width));
    strip.style.setProperty("--h", `${(k * 100).toFixed(2)}%`);   // подсветка до курсора
    const dur = seconds(total?.textContent);
    tip.style.left = `${Math.max(48, Math.min(box.width - 48, x - box.left))}px`;
    tip.innerHTML = dur ? `${fmt(k * dur)} <span>/ ${fmt(dur)}</span>` : fmt(0);
  };
  const hide = () => { if (!dragging) bar.classList.remove("seeking"); };

  input.addEventListener("pointerenter", (e) => {
    if (input.disabled) return;
    show(e.clientX);
    bar.classList.add("seeking");
  });
  input.addEventListener("pointermove", (e) => { if (!input.disabled) show(e.clientX); });
  input.addEventListener("pointerleave", hide);
  input.addEventListener("pointerdown", () => { dragging = true; });
  addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    const r = input.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) bar.classList.remove("seeking");
  });
}
