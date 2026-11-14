// Панель «Звуковые эффекты» (кнопка data-np="fx" у плеера и в мини-плеере), две вкладки:
// «Эффекты» — готовые наборы (Slowed + reverb, Nightcore…) и ползунки скорости, реверба, басов;
// «Эквалайзер» — 6 полос и свои наборы (Басы, Вокал, Рок…).
// Сам звук меняет audio.js; здесь только интерфейс. Настройки запоминаются (settings.fx).

import { EQ_BANDS, EQ_PRESETS, FX_PRESETS, fxActive, getFx, onFxChange, setFx } from "./audio.js";
import { icons } from "./icons.js";
import { el } from "./ui.js";
import { isMobile } from "./device.js";

let panel = null;
let tab = "fx";

// Набор «включён», если совпадают все его поля (у наборов эффектов нет поля eq — его не сравниваем)
const matches = (fx, preset) => Object.keys(preset).every((k) => fx[k] === preset[k]);
const sameEq = (a, b) => a.every((g, i) => g === b[i]);

function slider({ label, min, max, step, value, format, onInput, vertical = false }) {
  const row = el("label", vertical ? "fx-band" : "fx-row");
  const val = el("span", "fx-val", format(value));
  const range = el("input");
  Object.assign(range, { type: "range", min, max, step, value });
  // Закрашенная часть: у полосы эквалайзера — от нуля (середины) до значения, у обычных — от начала
  const fill = () => {
    const p = ((range.value - min) / (max - min)) * 100;
    if (vertical) range.style.setProperty("--from", `${Math.min(p, 50)}%`), range.style.setProperty("--to", `${Math.max(p, 50)}%`);
    else range.style.setProperty("--p", `${p}%`);
  };
  fill();
  range.addEventListener("input", () => {
    const v = Number(range.value);
    val.textContent = format(v);
    fill();
    onInput(v);
  });
  if (vertical) {
    range.addEventListener("dblclick", () => { range.value = 0; range.dispatchEvent(new Event("input")); });   // двойной щелчок — в ноль
    row.append(val, range, el("span", "fx-band-hz", label));
  } else {
    const head = el("span", "fx-row-head");
    head.append(el("span", "", label), val);
    row.append(head, range);
  }
  return row;
}

function chips(list, isOn, apply) {
  const box = el("div", "fx-presets");
  list.forEach((p) => {
    const b = el("button", `fx-chip${isOn(p) ? " on" : ""}`, p.name);
    b.type = "button";
    b.addEventListener("click", () => { apply(p); render(); });
    box.append(b);
  });
  return box;
}

function effectsTab(fx) {
  const markChips = () => panel.querySelectorAll(".fx-chip").forEach((c, i) => c.classList.toggle("on", matches(getFx(), FX_PRESETS[i].fx)));
  const pitch = el("label", "fx-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = fx.pitch;
  box.addEventListener("change", () => { setFx({ pitch: box.checked }); render(); });
  pitch.append(box, el("span", "", "Тон меняется вместе со скоростью (как в slowed и nightcore)"));
  return [
    chips(FX_PRESETS, (p) => matches(fx, p.fx), (p) => setFx(p.fx)),
    slider({ label: "Скорость", min: 0.5, max: 1.5, step: 0.01, value: fx.speed, format: (v) => `×${v.toFixed(2)}`,
      onInput: (v) => { setFx({ speed: v }); markChips(); } }),
    pitch,
    slider({ label: "Реверберация", min: 0, max: 1, step: 0.01, value: fx.reverb, format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { setFx({ reverb: v }); markChips(); } }),
    slider({ label: "Бас-буст", min: 0, max: 12, step: 0.5, value: fx.bass, format: (v) => (v ? `+${v} дБ` : "0"),
      onInput: (v) => { setFx({ bass: v }); markChips(); } }),
  ];
}

function eqTab(fx) {
  const markChips = () => panel.querySelectorAll(".fx-chip").forEach((c, i) => c.classList.toggle("on", sameEq(getFx().eq, EQ_PRESETS[i].eq)));
  const bands = el("div", "fx-eq");
  EQ_BANDS.forEach(([, , label], i) => {
    bands.append(slider({
      label, min: -12, max: 12, step: 0.5, value: fx.eq[i], vertical: true,
      format: (v) => (v > 0 ? `+${v}` : `${v}`),
      onInput: (v) => {
        const eq = getFx().eq.slice();
        eq[i] = v;
        setFx({ eq });
        markChips();
      },
    }));
  });
  return [
    chips(EQ_PRESETS, (p) => sameEq(fx.eq, p.eq), (p) => setFx({ eq: p.eq })),
    bands,
    el("p", "fx-hint", "Полосы в децибелах: слева басы, справа верха. "
      + (isMobile ? "«Ровно» — все полосы в ноль." : "Двойной щелчок по ползунку — в ноль.")),
  ];
}

function render() {
  const fx = getFx();
  const tabs = el("div", "seg fx-tabs");
  [["fx", "Эффекты"], ["eq", "Эквалайзер"]].forEach(([key, name]) => {
    const b = el("button", `seg-btn${tab === key ? " on" : ""}`, name);
    b.type = "button";
    b.addEventListener("click", () => { tab = key; render(); });
    tabs.append(b);
  });
  panel.replaceChildren(tabs, ...(tab === "fx" ? effectsTab(fx) : eqTab(fx)));
}

function close() {
  panel?.remove();
  panel = null;
  removeEventListener("pointerdown", outside, true);
  removeEventListener("keydown", onKey, true);
}
const outside = (e) => { if (panel && !panel.contains(e.target) && !e.target.closest('[data-np="fx"]')) close(); };
const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };

function place(anchor) {
  // Над кнопкой, не вылезая за край окна; не помещается сверху — снизу
  const r = anchor.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight;
  panel.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2))}px`;
  const top = r.top - h - 10 > 12 ? r.top - h - 10 : Math.min(r.bottom + 10, innerHeight - h - 12);
  panel.style.top = `${Math.max(12, top)}px`;
}

function open(anchor) {
  if (panel) return close();
  panel = el("div", "fx-panel");
  document.body.append(panel);
  render();
  place(anchor);
  addEventListener("pointerdown", outside, true);
  addEventListener("keydown", onKey, true);
}

function syncButtons() {
  const on = fxActive();
  document.querySelectorAll('[data-np="fx"]').forEach((b) => {
    b.classList.toggle("on", on);
    b.title = on ? "Эффекты и эквалайзер (включены)" : "Эффекты и эквалайзер";
  });
}

export function initFxButton() {
  document.querySelectorAll('[data-np="fx"]').forEach((b) => {
    b.innerHTML = icons.fx;
    b.addEventListener("click", () => open(b));
  });
  onFxChange(syncButtons);
  syncButtons();
}
