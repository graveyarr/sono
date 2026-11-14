// Удары в такт музыке — для тем. Тема включает их строкой «:root { --beat: on; }» в theme.css.
// На каждый удар баса у <html> меняется атрибут data-beat: 1 → 2 → 3 → 4 → 1 … (4 — каждый четвёртый
// удар, «сильная доля»). Тема вешает на эти значения короткие анимации: вспышку, рывок, дрожь.
// Значение всегда новое — поэтому анимация с другим именем на соседнем ударе запускается заново.
// Меняется только атрибут, а не переменная: браузер пересчитывает лишь то, что тема на него завязала.
// Не работает: на паузе, в скрытом окне, при «Без анимаций» и в темах, которые об этом не просили.

import { animFrame } from "./raf.js";
import { motionOff } from "./library.js";
import { analyserNode, audioContext } from "./audio.js";

const audio = document.getElementById("player");
const root = document.documentElement;

let wanted = false, running = false;
let buf = null, alpha = 0;
let lastBeat = 0, count = 0, prev = 0;
const hist = [];   // [время, энергия басов] за последние 0,6 с

/** Энергия басов (до ~150 Гц) за последние ~16 мс звука.
 *  Берём саму звуковую волну, а не спектр: спектр у анализатора сглажен (smoothingTimeConstant),
 *  и в песнях с тянущимся 808 уровень басов почти не меняется — удары в нём не видны */
function bassEnergy(an) {
  if (!buf || buf.length !== an.fftSize) {
    buf = new Float32Array(an.fftSize);
    alpha = 1 - Math.exp((-2 * Math.PI * 150) / (audioContext()?.sampleRate || 48000));
  }
  an.getFloatTimeDomainData(buf);
  // Простой фильтр низких частот по всей записи (начало — «разгон»), энергия — по её хвосту
  const n = buf.length, tail = Math.min(768, n);
  let y = 0, e = 0;
  for (let i = 0; i < n; i++) {
    y += alpha * (buf[i] - y);
    if (i >= n - tail) e += y * y;
  }
  return Math.sqrt(e / tail);
}

function tick(ts) {
  if (!running) return;
  animFrame(tick);
  const an = analyserNode();
  if (!an) return;   // звуковая цепочка появляется после первого щелчка
  const e = bassEnergy(an);
  hist.push([ts, e]);
  while (hist.length && ts - hist[0][0] > 600) hist.shift();
  const avg = hist.reduce((s, h) => s + h[1], 0) / hist.length;
  // Удар — басы заметно выше своего среднего за полсекунды и ещё растут.
  // Чаще ~5 раз в секунду не мигаем — это неприятно глазам
  if (e > avg * 1.45 && e > prev && e > 0.004 && ts - lastBeat > 200) {
    lastBeat = ts;
    count = (count % 4) + 1;
    root.dataset.beat = String(count);
  }
  prev = e;
}

function refresh() {
  const run = wanted && !audio.paused && !document.hidden && !motionOff();
  if (run && !running) {
    running = true;
    hist.length = 0;
    animFrame(tick);
  } else if (!run && running) {
    running = false;
    delete root.dataset.beat;
  }
}

/** Тему поменяли — спрашиваем, нужны ли ей удары */
function readTheme() {
  wanted = getComputedStyle(root).getPropertyValue("--beat").trim() === "on";
  refresh();
}

export function initBeat() {
  audio.addEventListener("play", refresh);
  audio.addEventListener("pause", refresh);
  audio.addEventListener("ended", refresh);
  document.addEventListener("visibilitychange", refresh);
  document.addEventListener("sono:motion", refresh);
  document.head.addEventListener("load", readTheme, true);   // загрузился theme.css новой темы
  // Тему выключили (ссылку убрали) — события load нет, но меняется html[data-theme]
  new MutationObserver(readTheme).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-now-style"] });
  readTheme();
}
