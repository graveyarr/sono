// Кадры для анимаций (визуализатор, полоса перемотки, фоны «Сейчас играет» и Flow).
// На телефоне с экраном 120 Гц браузер не успевал перерисовывать холсты каждый кадр: выходило ~67 кадров/с
// неровно (рывки). Поэтому там анимации обновляются не чаще ~100 раз в секунду, т.е. через кадр (60/с),
// зато ровно. Замер 10 ноября (Xiaomi, Android 13): 67 → 101 кадр/с, задержки кадров 25 → 16,7 мс.
// На компьютере и на телефонах с 60/90 Гц — обычный requestAnimationFrame, каждый кадр.
// Модуль без импортов — его можно подключать откуда угодно, без круговых импортов.

const slow = /SonoAndroid/.test(navigator.userAgent) || new URLSearchParams(location.search).has("mobile");
const MIN_GAP = 10;   // мс: 120 Гц (8,3 мс) — через кадр; 90 Гц (11,1 мс) и 60 Гц — каждый кадр
let lastTick = -1;

/** Как requestAnimationFrame, но на телефоне с частым экраном — через кадр. Все анимации — в одном и том же кадре */
export function animFrame(cb) {
  if (!slow) return requestAnimationFrame(cb);
  const wait = (t) => {
    if (t !== lastTick && t - lastTick < MIN_GAP) return requestAnimationFrame(wait);
    lastTick = t;
    cb(t);
  };
  return requestAnimationFrame(wait);
}
