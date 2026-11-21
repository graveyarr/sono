// Конец заставки программы (desktop.py рисует её в окне, index.html продолжает на странице — #boot, boot.css).
// Когда Sono готов: заставка держится всего не меньше ~2,2 с (просьба автора — «секунды две»), потом
// логотип улетает на место «sono.» в медиатеке, а заставка тает и открывает программу.

const MIN_SHOWN = 2200;   // мс — сколько заставка видна всего (окно + страница), если Sono загрузился быстрее

export function finishBoot() {
  const box = document.getElementById("boot");
  if (!box) return;
  const shown = Number(box.dataset.shown) || 0;   // сколько она шла в окне до загрузки страницы
  const wait = Math.max(0, MIN_SHOWN - shown - performance.now());
  // Два кадра — чтобы программа под заставкой уже была нарисована
  setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => leave(box))), wait);
}

function leave(box) {
  const logo = box.querySelector(".boot-logo");
  const target = document.querySelector(".side-word");
  const calm = box.classList.contains("calm") || matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Рамка самих букв, без отступов вокруг «sono.» (иначе логотип садился на 7 px ниже)
  let t = null;
  if (target) { const range = document.createRange(); range.selectNodeContents(target); t = range.getBoundingClientRect(); }
  if (logo && !calm && t?.width && t.height) {
    // Логотип — поверх страницы (с цветами заставки), заставка под ним тает
    const fly = logo.cloneNode(true);
    fly.classList.add("boot-fly");
    fly.style.cssText = box.style.cssText;
    document.body.append(fly);
    const r = fly.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(fly);
    const g = range.getBoundingClientRect();   // сами буквы летящего логотипа — меряем так же, как цель
    const scale = parseFloat(getComputedStyle(target).fontSize) / parseFloat(getComputedStyle(fly).fontSize);
    // Масштаб — вокруг transform-origin (левый край рамки по середине), потом сдвиг: левый край и середина
    // букв встают ровно на буквы «sono.» в медиатеке
    const ox = r.left, oy = r.top + r.height / 2;
    const dx = t.left - ox - scale * (g.left - ox);
    const dy = (t.top + t.height / 2) - oy - scale * (g.top + g.height / 2 - oy);
    logo.style.visibility = "hidden";
    target.style.opacity = "0";   // настоящий «sono.» — до посадки (иначе на миг два логотипа)
    requestAnimationFrame(() => {
      fly.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${scale})`;
      fly.classList.add("gone");
    });
    setTimeout(() => {   // прилетел: настоящий проявляется, летящий тает (boot.css) — меняются местами
      target.style.transition = "opacity .18s ease";
      target.style.opacity = "";
      setTimeout(() => { target.style.transition = ""; }, 250);
    }, 720);
    setTimeout(() => fly.remove(), 1000);
  }
  box.classList.add("out");
  setTimeout(() => box.remove(), calm ? 700 : 900);
}
