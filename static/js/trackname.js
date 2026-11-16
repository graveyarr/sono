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
    // «Официальный канал группы Сплин», «Официальный YouTube-канал Земфиры» — имя после «канал (группы)»
    .replace(/^официальн\S*\s+(youtube[\s-]*)?канал\S*\s+(групп\S*\s+|исполнител\S*\s+|певиц\S*\s+|певца\s+)?/i, "")
    // «EminemMusic» — приклеенное «Music» после имени (только так: «Swedish House Mafia Music» не трогаем)
    .replace(/(?<=[a-z\d])Music$/, "")
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
    .replace(/\s*[(\[]\s*prod\.?\s[^)\]]*[)\]]/gi, " ")   // «(prod. Flansie Skimayne)» — это о битмейкере, не название
    .replace(/\s*\|.*$/, "")                   // «Название | Канал»
    .replace(/\s+(lyrics?|hq|hd)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const a = artist.toLowerCase();
  const isArtist = (part) => !!a && (a.includes(part.toLowerCase()) || part.toLowerCase().includes(a));
  const parts = !isTopic && title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (parts && !VERSION_TAIL.test(parts[2])) {
    // «Исполнитель - Название»
    const left = parts[1].trim(), right = parts[2].trim();
    const sameAsChannel = isArtist(left);
    // Наоборот — только если справа ровно исполнитель (не «lil tracy - lil peep part 2»)
    const flat = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!sameAsChannel && flat(right) && a && flat(a).includes(flat(right)) && flat(right).length >= flat(a).length * 0.6) {
      title = left;                             // «Numb – Linkin Park» на канале Linkin Park: наоборот
    } else if (sameAsChannel || left.length <= 40) {   // длинная левая часть — скорее всего не имя исполнителя
      if (!sameAsChannel) artist = left;        // канал чужой (перезалив) — исполнитель записан слева
      title = right;
    }
  } else if (!isTopic) {
    // «NewJeans (뉴진스) 'Ditto' Performance Video» — на канале исполнителя название в кавычках
    const quoted = title.match(/^(.+?)\s+['‘’"“«]([^'‘’"”«»]+)['’"”»](.*)$/);
    if (quoted && isArtist(quoted[1].replace(/\s*\(.*?\)\s*/g, " ").trim())) {
      const tail = quoted[3].trim();
      title = quoted[2].trim() + (tail && VERSION_MARK.test(tail) ? ` (${tail})` : "");
    }
  }
  return { title: title || track.title || "Без названия", artist: artist || "Неизвестный автор" };
}
