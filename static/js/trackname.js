// Красивое название и исполнитель трека. Отдельный модуль без зависимостей и без обращений к странице:
// им пользуются ui.js (показ) и samesong.js («та же песня»), а проверки запускают его прямо в Node.
//
// На YouTube в названиях много мусора: «【Official Video】», «(Lyrics)», «| канал», а исполнитель
// часто записан в самом названии через тире. Для показа чистим; сохранённые данные не трогаем.

const NOISE_WORDS = "official|video|audio|lyrics?|lyric video|visuali[sz]er|m/?v|hd|hq|4k|clip|клип|премьера|текст|music video|full album";
// Скобки любого вида, внутри которых есть одно из «мусорных» слов: (Official Video), 【MV】, [HD]…
const NOISE_BRACKETS = new RegExp(`\\s*[\\[(【「（][^\\])】」）]*?(?:${NOISE_WORDS})[^\\])】」）]*[\\])】」）]\\s*`, "gi");
const VERSION_MARK = /instrumental|remix|live|cover|acoustic|slowed|sped|nightcore|karaoke|кавер|ремикс|минус/i;
// «Money - 2011 Remaster», «Song - Live at …» — это не «исполнитель - название», не разбиваем
const VERSION_TAIL = /^(\d{4}\s+)?(remaster|live|version|edit|mix|acoustic|demo|bonus)/i;

export function cleanChannel(channel) {
  return (channel || "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "")
    .replace(/\s+official(\s+(artist\s+)?(youtube\s+)?channel)?$/i, "")
    .trim();
}

/** { title, artist } для показа: без мусора, исполнитель отдельно от названия */
export function displayTrack(track) {
  // Трек из импорта знает настоящих исполнителей и название — они точнее всего
  if (track.artists && track.origTitle) return { title: track.origTitle, artist: track.artists };
  const isTopic = /-\s*topic$/i.test(track.channel || "");   // автоканалы YouTube: название уже чистое
  // У SoundCloud исполнитель бывает указан отдельно от аккаунта (общий аккаунт дуэта, лейбл) — он точнее
  let artist = track.pubArtist || cleanChannel(track.channel);
  let title = (track.title || "")
    // скобки с «мусором» убираем, но не если там пометка версии: «(HQ Instrumental)», «[Live]» важно видеть
    .replace(NOISE_BRACKETS, (m) => (VERSION_MARK.test(m) ? m : " "))
    .replace(/\s*\|.*$/, "")                   // «Название | Канал»
    .replace(/\s+(lyrics?|hq|hd)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const parts = !isTopic && title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (parts && !VERSION_TAIL.test(parts[2])) {
    // «Исполнитель - Название»
    const left = parts[1].trim(), l = left.toLowerCase(), a = artist.toLowerCase();
    const sameAsChannel = !!a && (a.includes(l) || l.includes(a));
    if (sameAsChannel || left.length <= 40) {   // длинная левая часть — скорее всего не имя исполнителя
      if (!sameAsChannel) artist = left;        // канал чужой (перезалив) — исполнитель записан слева
      title = parts[2].trim();
    }
  }
  return { title: title || track.title || "Без названия", artist: artist || "Неизвестный автор" };
}
