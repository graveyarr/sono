// «Поделиться плейлистом»: файлом (в «Загрузки») или коротким кодом, который можно отправить в мессенджере.
// Друг вставляет код (или выбирает файл) в «+» → «Импорт…» → «Файл или код».

import { isMobile, shareFile } from "./device.js";
import { el, openModal, plural, toast } from "./ui.js";

const PREFIX = "SONO1:";
const OLD_PREFIX = "PLAYER1:";   // коды, которыми делились до переименования (программа звалась Player)

// Код: JSON плейлиста → сжатие (deflate) → base64url. Поля сокращены, чтобы код был короче
async function encode(playlist) {
  const tracks = playlist.tracks.map((t) => {
    const short = { s: t.source, i: t.id, t: t.title, c: t.channel, d: t.duration };
    if (t.artists) short.a = t.artists;
    if (t.origTitle) short.o = t.origTitle;
    return short;
  });
  const json = new TextEncoder().encode(JSON.stringify({ n: playlist.name, t: tracks }));
  const packed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
  let binary = "";
  new Uint8Array(packed).forEach((b) => { binary += String.fromCharCode(b); });
  return PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Код или содержимое файла → { name, tracks }. Ошибка — если это не плейлист Sono */
export async function decodeShared(text) {
  text = text.trim();
  if (text.startsWith("{")) {   // содержимое файла .sono.json (или старого .player.json)
    const data = JSON.parse(text);
    if (!["sono-playlist", "player-playlist"].includes(data.format) || !Array.isArray(data.tracks)) {
      throw new Error("Это не плейлист Sono");
    }
    return { name: data.name || "Плейлист", tracks: data.tracks };
  }
  const prefix = [PREFIX, OLD_PREFIX].find((p) => text.includes(p));
  if (!prefix) throw new Error(`Не похоже на код плейлиста — он начинается с «${PREFIX}»`);
  const start = text.indexOf(prefix);
  const b64 = text.slice(start + prefix.length).split(/\s/)[0].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  const data = JSON.parse(json);
  const tracks = (data.t || []).map((t) => ({
    source: t.s, id: t.i, title: t.t, channel: t.c ?? null, duration: t.d ?? null,
    ...(t.a ? { artists: t.a } : {}), ...(t.o ? { origTitle: t.o } : {}),
  }));
  return { name: data.n || "Плейлист", tracks };
}

/** Окно «Поделиться»: скопировать код или сохранить файл */
export async function sharePlaylist(playlist) {
  const code = await encode(playlist);
  const { box, close } = openModal({ className: "share-dialog" });
  box.onsubmit = (e) => e.preventDefault();
  box.append(el("h2", "", `Поделиться «${playlist.name}»`),
    el("p", "", `${plural(playlist.tracks.length, "трек", "трека", "треков")}. Отправьте другу код или файл — `
      + "он откроет его в Sono: «+» → «Импорт…» → «Файл или код»."));

  const codeBox = el("textarea", "dialog-input share-code");
  codeBox.readOnly = true;
  codeBox.value = code;
  codeBox.rows = 3;
  codeBox.addEventListener("focus", () => codeBox.select());

  const fileLine = el("div", "set-result-line");
  const row = el("div", "dialog-buttons");
  // На телефоне файл сразу уходит в системное «Поделиться»: в «Загрузки» приложение класть не может
  const fileBtn = el("button", "btn ghost", isMobile ? "Отправить файлом…" : "Сохранить файлом");
  fileBtn.type = "button";
  fileBtn.addEventListener("click", async () => {
    const res = await fetch("/api/share/playlist", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: playlist.name, tracks: playlist.tracks }),
    });
    const data = await res.json();
    if (isMobile) {   // окно больше не нужно — дальше системное «Поделиться»
      close();
      return shareFile(data.name, "Отправить плейлист");
    }
    const reveal = el("button", "btn ghost", "Показать в папке");
    reveal.type = "button";
    reveal.addEventListener("click", () => fetch("/api/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: data.path }),
    }));
    fileLine.replaceChildren(el("span", "", `Сохранено в «Загрузки»: ${data.name}`), reveal);
  });
  const copyBtn = el("button", "btn primary", "Скопировать код");
  copyBtn.type = "button";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      codeBox.select();
      document.execCommand("copy");
    }
    toast("Код скопирован — отправьте его другу");
    close();
  });
  row.append(fileBtn, copyBtn);
  box.append(codeBox, fileLine, row);
}
