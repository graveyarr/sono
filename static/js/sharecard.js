// «Поделиться картинкой»: карточка трека для сторис, Telegram или Discord.
// Рисуется на холсте прямо на странице: обложка, название, исполнитель и (по желанию) строчка из текста.
// «Скопировать» кладёт PNG в буфер обмена (вставляется в Telegram/Discord через Ctrl+V),
// «Сохранить» пишет файл в «Загрузки» (/api/share/image), на телефоне — системное «Поделиться».

import { isMobile, shareFile } from "./device.js";
import { fetchLyrics } from "./lyrics.js";
import { coverUrl, displayTrack, el, imageHsl, openModal, toast } from "./ui.js";

const FORMATS = {
  story: { w: 1080, h: 1920, label: "Сторис" },
  square: { w: 1080, h: 1080, label: "Квадрат" },
};
const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const SOURCE = { youtube: "YouTube", soundcloud: "SoundCloud" };

/** Картинка по адресу (обложки — с нашего сервера, холст не «портится») */
function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Строки текста, которые влезают в ширину; лишнее — многоточие на последней */
function wrap(ctx, text, width, maxLines) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width || !line) { line = next; continue; }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  // Одно длинное слово (или иероглифы без пробелов) шире строки — режем по буквам
  const fit = [];
  for (let l of lines) {
    while (ctx.measureText(l).width > width && l.length > 1) {
      let cut = l.length - 1;
      while (cut > 1 && ctx.measureText(l.slice(0, cut)).width > width) cut--;
      fit.push(l.slice(0, cut));
      l = l.slice(cut);
    }
    fit.push(l);
  }
  if (fit.length <= maxLines) return fit;
  const out = fit.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
  out[maxLines - 1] = `${last.trimEnd()}…`;
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Обложка «во весь фон», размытая и затемнённая; без обложки — цвет по имени */
function drawBackground(ctx, w, h, cover, hsl) {
  const [hue, sat] = hsl;
  ctx.fillStyle = `hsl(${hue} ${Math.min(sat, 60)}% 18%)`;
  ctx.fillRect(0, 0, w, h);
  if (cover) {
    const side = Math.max(w, h) * 1.25;
    ctx.save();
    ctx.filter = "blur(70px) saturate(1.3) brightness(0.5)";
    ctx.drawImage(cover, (w - side) / 2, (h - side) / 2, side, side);
    ctx.restore();
  }
  const shade = ctx.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, "rgba(0,0,0,0.10)");
  shade.addColorStop(0.55, "rgba(0,0,0,0.25)");
  shade.addColorStop(1, "rgba(0,0,0,0.62)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);
}

function drawCover(ctx, cover, x, y, size, radius) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = size * 0.09;
  ctx.shadowOffsetY = size * 0.03;
  roundRect(ctx, x, y, size, size, radius);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fill();
  ctx.restore();
  if (!cover) return;
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.clip();
  // Обложка YouTube бывает 16:9 или с чёрными полосами — берём середину картинки без полос квадратом
  const box = cover.sonoCrop ?? { x: 0, y: 0, w: cover.naturalWidth, h: cover.naturalHeight };
  const s = Math.min(box.w, box.h);
  ctx.drawImage(cover, box.x + (box.w - s) / 2, box.y + (box.h - s) / 2, s, s, x, y, size, size);
  ctx.restore();
}

/** Где на картинке нет чёрных полос (у превью YouTube их бывает до четверти высоты сверху и снизу) */
function trimBars(img) {
  const W = 64, H = Math.max(1, Math.round(64 * img.naturalHeight / img.naturalWidth));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const dark = (x0, y0, dx, dy, n) => {   // вся строка/столбец почти чёрные
    for (let i = 0; i < n; i++) {
      const k = ((y0 + dy * i) * W + (x0 + dx * i)) * 4;
      if (px[k] + px[k + 1] + px[k + 2] > 54) return false;
    }
    return true;
  };
  let top = 0, bottom = H, left = 0, right = W;
  while (top < H / 3 && dark(0, top, 1, 0, W)) top++;
  while (bottom > H * 2 / 3 && dark(0, bottom - 1, 1, 0, W)) bottom--;
  while (left < W / 3 && dark(left, 0, 0, 1, H)) left++;
  while (right > W * 2 / 3 && dark(right - 1, 0, 0, 1, H)) right--;
  // Совсем тёмная обложка (весь кадр чёрный) — не режем
  if (bottom - top < H / 3 || right - left < W / 3) return null;
  const kx = img.naturalWidth / W, ky = img.naturalHeight / H;
  // +1 пиксель с каждой стороны — край полосы бывает серым из-за сжатия
  const y = Math.min((top ? top + 1 : 0) * ky, img.naturalHeight), x = Math.min((left ? left + 1 : 0) * kx, img.naturalWidth);
  return { x, y, w: Math.max(1, (right - (right < W ? 1 : 0)) * kx - x), h: Math.max(1, (bottom - (bottom < H ? 1 : 0)) * ky - y) };
}

/** Подпись внизу: «Sono · SoundCloud» */
function drawFooter(ctx, w, y, source) {
  ctx.font = `600 34px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(["Sono", SOURCE[source]].filter(Boolean).join(" · "), w / 2, y);
}

function drawText(ctx, lines, x, y, lineHeight) {
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  return y + lines.length * lineHeight;
}

/** Карточка без строчки: большая обложка, под ней название и исполнитель */
function drawPlain(ctx, f, data) {
  const { w, h } = f;
  const story = h > w;
  const size = story ? 800 : 560;
  const top = story ? 330 : 120;
  drawCover(ctx, data.cover, (w - size) / 2, top, size, story ? 36 : 28);
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${story ? 74 : 62}px ${FONT}`;
  const titleLines = wrap(ctx, data.title, w - 160, 2);
  let y = drawText(ctx, titleLines, w / 2, top + size + (story ? 150 : 110), story ? 88 : 74);
  ctx.font = `500 ${story ? 46 : 40}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  drawText(ctx, wrap(ctx, data.artist, w - 200, 1), w / 2, y + (story ? 6 : 0), 56);
  drawFooter(ctx, w, h - (story ? 110 : 56), data.source);
}

/** Карточка со строчкой (как в Spotify): крупный текст на цветной плашке, внизу маленькая обложка */
function drawLyric(ctx, f, data) {
  const { w, h } = f;
  const story = h > w;
  const pad = story ? 90 : 70;
  const boxW = w - pad * 2;
  const [hue, sat, light] = data.hsl;
  ctx.font = `700 ${story ? 70 : 58}px ${FONT}`;
  const lineH = story ? 90 : 74;
  const lyric = wrap(ctx, data.lyric, boxW - 120, story ? 9 : 6);
  const head = story ? 200 : 150;   // обложка с подписью внутри плашки
  const boxH = 70 + lyric.length * lineH + 24 + head;
  const boxY = Math.max(pad, (h - boxH) / 2 - (story ? 40 : 10));
  roundRect(ctx, pad, boxY, boxW, boxH, 40);
  ctx.fillStyle = `hsl(${hue} ${Math.max(35, Math.min(sat, 70))}% ${Math.max(28, Math.min(light, 42))}%)`;
  ctx.fill();
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${story ? 70 : 58}px ${FONT}`;
  drawText(ctx, lyric, pad + 60, boxY + 70 + lineH * 0.72, lineH);
  const coverSize = story ? 150 : 110;
  const cy = boxY + boxH - head + (head - coverSize) / 2;
  drawCover(ctx, data.cover, pad + 60, cy, coverSize, 18);
  const tx = pad + 60 + coverSize + 32;
  const tw = boxW - (tx - pad) - 60;
  ctx.font = `700 ${story ? 44 : 36}px ${FONT}`;
  ctx.fillStyle = "#fff";
  ctx.fillText(wrap(ctx, data.title, tw, 1)[0] || "", tx, cy + coverSize / 2 - (story ? 6 : 4));
  ctx.font = `500 ${story ? 36 : 30}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillText(wrap(ctx, data.artist, tw, 1)[0] || "", tx, cy + coverSize / 2 + (story ? 44 : 36));
  drawFooter(ctx, w, h - (story ? 110 : 56), data.source);
}

function draw(canvas, format, data) {
  const f = FORMATS[format];
  canvas.width = f.w;
  canvas.height = f.h;
  const ctx = canvas.getContext("2d");
  drawBackground(ctx, f.w, f.h, data.cover, data.hsl);
  (data.lyric ? drawLyric : drawPlain)(ctx, f, data);
}

/** Строки текста песни для выбора (без пустых и повторов) */
function lyricLines(lyrics) {
  const raw = lyrics?.synced?.length ? lyrics.synced.map(([, words]) => words) : String(lyrics?.plain || "").split("\n");
  const seen = new Set();
  return raw.map((s) => String(s).trim()).filter((s) => {
    const k = s.toLowerCase();
    if (!s || s.length > 160 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const fileName = (data) => `${data.artist ? `${data.artist} — ` : ""}${data.title}`;

/** shown — трек как в строке (название и обложка), real — настоящая загрузка (для текста и подписи сайта) */
export async function openShareCard(shown, real = shown) {
  const name = displayTrack(shown);
  const data = { title: name.title || "Без названия", artist: name.artist || "", source: real.source, cover: null, hsl: [0, 0, 20], lyric: "" };
  let format = "story";

  const { box, close } = openModal({ className: "sharecard-dialog" });
  box.onsubmit = (e) => e.preventDefault();
  const canvas = el("canvas", "sharecard-canvas");
  const preview = el("div", "sharecard-preview");
  preview.append(canvas);
  const side = el("div", "sharecard-side");
  const redraw = () => {
    draw(canvas, format, data);
    preview.classList.toggle("square", format === "square");
  };

  const seg = el("div", "seg");
  for (const [id, f] of Object.entries(FORMATS)) {
    const btn = el("button", `seg-btn${id === format ? " on" : ""}`, f.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      format = id;
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b === btn));
      redraw();
    });
    seg.append(btn);
  }

  // Строчка из текста: список строк, щелчок — на карточку, ещё раз — убрать
  const linesBox = el("div", "sharecard-lines");
  linesBox.append(el("div", "sharecard-note", "Ищу текст песни…"));
  const pickLine = (text, node) => {
    data.lyric = data.lyric === text ? "" : text;
    linesBox.querySelectorAll(".sharecard-line").forEach((b) => b.classList.toggle("on", b === node && !!data.lyric));
    redraw();
  };

  const buttons = el("div", "dialog-buttons");
  let coverReady = Promise.resolve();   // картинку отдаём, когда обложка уже нарисована (или точно не пришла)
  const toBlob = () => coverReady.then(() => new Promise((resolve) => canvas.toBlob(resolve, "image/png")));
  const save = el("button", "btn ghost", isMobile ? "Отправить…" : "Сохранить");
  save.type = "button";
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await coverReady;
      const res = await fetch("/api/share/image", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fileName(data), png: canvas.toDataURL("image/png") }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      if (isMobile) {
        close();
        return shareFile(out.name, "Поделиться треком");
      }
      toast(`Картинка в «Загрузках»: ${out.name}`, {
        action: { label: "Показать", run: () => fetch("/api/reveal", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: out.path }),
        }) },
      });
    } catch (e) {
      toast(`Не получилось сохранить картинку${e?.message ? `: ${e.message}` : ""}`, { error: true });
    } finally {
      save.disabled = false;
    }
  });
  buttons.append(save);
  if (!isMobile) {   // в WebView телефона картинку в буфер положить нельзя — там «Отправить…»
    const copy = el("button", "btn primary", "Скопировать");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": toBlob() })]);
        toast("Картинка скопирована — вставьте её в Telegram или Discord (Ctrl+V)");
        close();
      } catch {
        toast("Не получилось скопировать — нажмите «Сохранить»", { error: true });
      }
    });
    buttons.append(copy);
  }

  side.append(el("h2", "", "Поделиться треком"), el("div", "import-label", "Размер"), seg,
    el("div", "import-label sharecard-label", "Строчка из песни"), linesBox, buttons);
  box.append(preview, side);
  redraw();

  // Обложка и текст — по мере готовности (окно уже открыто)
  // Большая обложка не пришла (у SoundCloud при обходе бывает) — маленькая лучше пустого квадрата
  const url = (size) => coverUrl(shown, size) || coverUrl(real, size);
  coverReady = loadImage(url("large")).then((img) => img || loadImage(url("small"))).then((img) => {
    if (!img) return;
    try { img.sonoCrop = trimBars(img); } catch { /* картинка не прочиталась — берём целиком */ }
    data.cover = img;
    try { data.hsl = imageHsl(img); } catch { /* обложка не прочиталась — цвет по умолчанию */ }
    redraw();
  });
  const withText = real.source === "youtube" || real.source === "soundcloud" || real.source === "local";
  (withText ? fetchLyrics(real) : Promise.reject()).then((lyrics) => {
    const lines = lyricLines(lyrics);
    if (!lines.length) throw new Error();
    linesBox.replaceChildren(...lines.map((text) => {
      const b = el("button", "sharecard-line", text);
      b.type = "button";
      b.addEventListener("click", () => pickLine(text, b));
      return b;
    }));
  }).catch(() => {
    linesBox.replaceChildren(el("div", "sharecard-note", "Текста у этой песни нет — карточка будет с обложкой."));
  });
}
