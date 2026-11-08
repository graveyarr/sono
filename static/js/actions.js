// Действия с треками и плейлистами: меню «⋯», лайки/дизлайки, создание, переименование, удаление.
// Всё, что показывает пользователю уведомление после действия, живёт здесь.

import { findOriginal, hasAltVersion, restoreOriginal } from "./censor.js";
import { download, isDownloaded, isDownloading, removeDownload } from "./downloads.js";
import { startFlow } from "./flow.js";
import { icons, sourceIcons } from "./icons.js";
import { sharePlaylist } from "./share.js";
import * as library from "./library.js";
import { keyOf, lib } from "./library.js";
import { folderMenuItem } from "./libtools.js";
import { isMeta, missingReason, resolvedOf, toReal } from "./meta.js";
import { openAlbumAt, openArtist, splitArtists } from "./nav.js";
import { playNext, queueNext, returnToQueue, state } from "./player.js";
import { confirmDialog, displayTrack, el, openMenu, plural, promptDialog, toast } from "./ui.js";

const isCurrent = (track) => !!state.current && keyOf(state.current) === keyOf(track);

// У трека из базы (страница исполнителя) нет звука: в медиатеку кладём найденную пару с YouTube/SoundCloud.
// Пока ищем — уведомление; нет нигде — говорим об этом и ничего не делаем.
function withReal(fn) {
  return async (track, ...rest) => {
    if (!isMeta(track)) return fn(track, ...rest);
    if (!resolvedOf(track)) toast("Ищу трек на YouTube и SoundCloud…");
    let real;
    try {
      real = await toReal(track);
    } catch (err) {
      return toast("Не получилось найти трек: " + err.message, { error: true });
    }
    if (!real) return toast(missingReason(track));
    return fn(real, ...rest);
  };
}

export const toggleLike = withReal((track) => {
  const where = library.likeTarget() ? `«${library.likeTargetName()}»` : null;   // ♡ кладёт в плейлист из настроек
  const added = library.toggleLike(track);
  toast(where ? (added ? `Добавлено в ${where}` : `Удалено из ${where}`) : (added ? "Добавлено в избранное" : "Удалено из избранного"));
});

export const toggleDislike = withReal((track) => {
  // Запоминаем, что было до дизлайка, — для «Отменить» (промахнуться мимо кнопки легко)
  const liked = library.likePlace(track);
  const wasCurrent = isCurrent(track);
  const index = state.index;
  const pos = document.getElementById("player").currentTime;
  if (library.toggleDislike(track)) {
    const undo = () => {
      if (library.isDisliked(track)) library.toggleDislike(track);
      library.restoreLike(track, liked);
      // Переключились дальше из-за дизлайка — возвращаемся на то же место трека
      if (wasCurrent && !isCurrent(track) && keyOf(state.queue[index] ?? {}) === keyOf(track)) returnToQueue(index, pos);
    };
    toast("Не нравится — этот трек будет пропускаться", { action: { label: "Отменить", run: undo } });
    if (wasCurrent) playNext();   // как у всех: дизлайк на играющем треке переключает дальше
  } else {
    toast("Дизлайк убран");
  }
});

// ---------- Плейлисты ----------

/** Спрашивает название и создаёт плейлист; если передан трек — сразу кладёт его туда */
export async function createPlaylist(track = null) {
  const name = await promptDialog({
    title: "Новый плейлист",
    value: `Мой плейлист №${lib.playlists.length + 1}`,
    placeholder: "Название",
    okLabel: "Создать",
  });
  if (!name) return null;
  if (track && isMeta(track)) {
    track = await toReal(track).catch(() => null);
    if (!track) { toast("Трек не нашёлся ни на YouTube, ни на SoundCloud"); return null; }
  }
  const playlist = library.createPlaylist(name);
  if (track) {
    library.addToPlaylist(playlist.id, track);
    toast(`Добавлено в «${playlist.name}»`);
  } else {
    toast(`Плейлист «${playlist.name}» создан`);
  }
  return playlist;
}

export async function renamePlaylist(playlist) {
  const name = await promptDialog({ title: "Переименовать плейлист", value: playlist.name, okLabel: "Сохранить" });
  if (name) library.renamePlaylist(playlist.id, name);
}

// ---------- Своя обложка плейлиста ----------
// Картинку обрезаем по центру в квадрат 400×400 и сжимаем в JPEG (~30 КБ) — так она хранится прямо
// в медиатеке и попадает в её резервную копию
const COVER_SIZE = 400;

/** Выбрать картинку с компьютера и поставить обложкой */
export function pickPlaylistCover(playlist) {
  const input = el("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      library.setPlaylistCover(playlist.id, await squareJpeg(file));
      toast("Обложка обновлена");
    } catch {
      toast("Не получилось открыть картинку", { error: true });
    }
  });
  input.click();
}

async function squareJpeg(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = COVER_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, COVER_SIZE, COVER_SIZE);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Удалить треки из плейлиста с кнопкой «Отменить» в уведомлении (вернёт их на прежние места) */
export function removeTracksWithUndo(playlistId, tracks) {
  const p = library.getPlaylist(playlistId);
  const before = library.removeManyFromPlaylist(playlistId, tracks);
  if (!before) return;
  const what = tracks.length === 1 ? "Удалено" : `Удалено ${plural(tracks.length, "трек", "трека", "треков")}`;
  toast(`${what} из «${p?.name ?? "плейлиста"}»`, { action: { label: "Отменить", run: () => library.setPlaylistTracks(playlistId, before) } });
}

/** Ссылка на трек на YouTube/SoundCloud — в буфер обмена */
async function copyTrackLink(track) {
  try {
    const res = await fetch(`/api/link/${track.source}/${encodeURIComponent(track.id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await navigator.clipboard.writeText(data.url);
    toast("Ссылка скопирована");
  } catch (e) {
    toast(`Не получилось скопировать ссылку${e?.message ? `: ${e.message}` : ""}`, { error: true });
  }
}

/** Открыть альбом/сингл, где есть этот трек, и подсветить его. У треков из базы альбом известен,
    для остальных ищем в базе Яндекса по исполнителю и названию (/api/track-album) */
export async function openTrackAlbum(track) {
  if (!track) return;
  if (track.albumId) return openAlbumAt(track.albumId, isMeta(track) ? keyOf(track) : track.metaId ? `meta:${track.metaId}` : null);
  const shown = displayTrack(track);
  toast("Ищу альбом с этим треком…");
  try {
    const res = await fetch("/api/track-album", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: shown.artist, title: shown.title, duration: track.duration }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    openAlbumAt(data.albumId, `meta:${data.trackId}`);
  } catch (e) {
    toast(e?.message || "Не нашёл альбом с этим треком", { error: true });
  }
}

/** true — удалили */
export async function deletePlaylist(playlist) {
  const ok = await confirmDialog({
    title: `Удалить «${playlist.name}»?`,
    text: "Плейлист исчезнет из медиатеки. Сами треки останутся в избранном и истории, если они там были.",
  });
  if (ok) {
    library.deletePlaylist(playlist.id);
    toast(`Плейлист «${playlist.name}» удалён`);
  }
  return ok;
}

const addTo = withReal((track, p) => {
  toast(library.addToPlaylist(p.id, track) ? `Добавлено в «${p.name}»` : `Уже есть в «${p.name}»`);
});

const downloadOne = withReal((track) => {
  download([track]);
  toast("Скачиваю — трек будет играть без интернета");
});

/** Меню «В плейлист»: один трек или несколько (выбранные в списке) */
export function addToPlaylistItems(track) {
  if (Array.isArray(track)) return addManyItems(track);
  const items = [{ label: "Новый плейлист…", icon: icons.plus, action: () => createPlaylist(track) }];
  if (lib.playlists.length) items.push({ sep: true });
  const real = resolvedOf(track);   // у трека из базы «уже есть» проверяем по найденной паре
  for (const p of lib.playlists) {
    const already = !!real && p.tracks.some((t) => keyOf(t) === keyOf(real));
    items.push({ label: p.name, icon: already ? icons.check : "", action: () => addTo(track, p) });
  }
  return items;
}

// Несколько треков сразу (выбраны Ctrl/Shift). Треки «из базы» в списках не бывают выбраны — там уже пары
function addManyItems(tracks) {
  const addAll = (p) => {
    const added = tracks.filter((t) => library.addToPlaylist(p.id, t)).length;
    toast(added ? `Добавлено в «${p.name}»: ${plural(added, "трек", "трека", "треков")}` : `Уже есть в «${p.name}»`);
  };
  const items = [{ label: "Новый плейлист…", icon: icons.plus, action: async () => {
    const name = await promptDialog({ title: "Новый плейлист", value: `Мой плейлист №${lib.playlists.length + 1}`,
      placeholder: "Название", okLabel: "Создать" });
    if (!name) return;
    const playlist = library.createPlaylist(name, tracks);
    toast(`Создан «${playlist.name}»: ${plural(playlist.tracks.length, "трек", "трека", "треков")}`);
  } }];
  if (lib.playlists.length) items.push({ sep: true });
  for (const p of lib.playlists) items.push({ label: p.name, icon: "", action: () => addAll(p) });
  return items;
}

// ---------- Меню трека ----------
// ctx: { playlistId } — открыто из плейлиста (можно удалить оттуда); { history: true } — из истории

function trackMenuItems(track, ctx = {}) {
  const real = resolvedOf(track) ?? track;
  const liked = library.isLiked(real), disliked = library.isDisliked(real);
  const items = [
    { label: "Играть следующим", icon: icons.playNext, action: () => { queueNext(track); toast("Будет играть следующим"); } },
    { label: "Радио по треку", icon: icons.flow, action: () => startFlow({ track: real }) },
    { label: "Добавить в плейлист", icon: icons.plus, submenu: () => addToPlaylistItems(track) },
    { sep: true },
    { label: library.likeTarget()
        ? (liked ? `Убрать из «${library.likeTargetName()}»` : `В «${library.likeTargetName()}» (♡)`)
        : (liked ? "Убрать из избранного" : "Добавить в избранное"),
      icon: liked ? icons.heartFilled : icons.heart, action: () => toggleLike(track) },
    { label: disliked ? "Убрать дизлайк" : "Не нравится", icon: disliked ? icons.dislikeFilled : icons.dislike, action: () => toggleDislike(track) },
  ];
  // Свой файл с компьютера: скачивать нечего, других «версий» нет — эти пункты не нужны
  const fromDisk = real.source === "local";
  if (!fromDisk) {
    items.push(isDownloaded(real) || isDownloading(real)
      ? { label: "Удалить загрузку", icon: icons.download, action: async () => {
        toast(await removeDownload([real]) ? "Не получилось удалить — трек сейчас играет" : "Загрузка удалена");
      } }
      : { label: "Скачать", icon: icons.download, action: () => downloadOne(track) });
    // Трек с цензурой (слова заменены или вырезаны) — найти другую загрузку; выбор не понравился — вернуть
    items.push({ label: "Трек с цензурой — найти оригинал", icon: icons.censor, action: () => withReal((t) => findOriginal(t))(track) });
  }
  if (hasAltVersion(real)) {
    items.push({ label: "Вернуть исходную версию", icon: icons.censor, action: () => { restoreOriginal(real); toast("Исходная версия вернётся при следующем включении"); } });
  }
  // Импорт списком «Название - Исполнитель» вместо «Исполнитель - Название»: поправить вручную
  if (real.artists && real.origTitle) {
    items.push({ label: "Поменять исполнителя и название", icon: icons.swap, action: () => {
      library.updateTrack(real, { artists: real.origTitle, origTitle: real.artists });
      toast("Исполнитель и название поменялись местами");
    } });
  }
  // Переходы: к исполнителю (по id из базы или по имени) и к альбому (если трек со страницы альбома/исполнителя)
  // Несколько исполнителей — подменю с каждым
  const people = splitArtists(track, displayTrack(track).artist);
  const goTo = ({ id, name }) => async () => {
    if (!await openArtist({ id, name, track, title: displayTrack(track).title })) toast(`Не нашёл страницу «${name}»`);
  };
  items.push({ sep: true }, people.length > 1
    ? { label: "Перейти к исполнителю", icon: icons.artist, submenu: () => people.map((p) => ({ label: p.name, icon: icons.artist, action: goTo(p) })) }
    : { label: "Перейти к исполнителю", icon: icons.artist, action: goTo(people[0] ?? { name: "" }) });
  // Альбом есть у любого трека: у треков из базы он известен, остальным Sono найдёт его в базе Яндекса
  if (real.source !== "local") items.push({ label: "Перейти к альбому", icon: icons.album, action: () => openTrackAlbum(track) });
  // Ссылка на сам трек — на YouTube или SoundCloud
  if (real.source === "youtube" || real.source === "soundcloud") {
    const site = real.source === "youtube" ? "YouTube" : "SoundCloud";
    items.push({ label: "Скопировать ссылку", icon: icons.share, action: () => copyTrackLink(real) },
      { label: `Открыть на ${site}`, icon: sourceIcons[real.source],
        action: () => fetch(`/api/open-link/${real.source}/${encodeURIComponent(real.id)}`, { method: "POST" })
          .then((r) => { if (!r.ok) toast("Не получилось открыть", { error: true }); }) });
  }
  if (ctx.playlistId) {
    items.push({ sep: true }, {
      label: "Удалить из этого плейлиста", icon: icons.trash, danger: true,
      action: () => removeTracksWithUndo(ctx.playlistId, [track]),
    });
  }
  if (ctx.history) {
    items.push({ sep: true }, { label: "Убрать из истории", icon: icons.close, action: () => library.removeFromHistory(track) });
  }
  return items;
}

export function openTrackMenu(anchor, track, ctx = {}) {
  openMenu(anchor, trackMenuItems(track, ctx));
}

/** Кнопка «+» у текущего трека: сразу список плейлистов */
export function openAddToPlaylist(anchor, track) {
  openMenu(anchor, trackMenuItems(track), "Добавить в плейлист");
}

/** Меню плейлиста (в боковой панели и в шапке плейлиста) */
export function openPlaylistMenu(anchor, playlist, { onPlay, onDeleted } = {}) {
  openMenu(anchor, [
    { label: "Слушать", icon: icons.play, disabled: !playlist.tracks.length, action: () => onPlay?.() },
    { label: "Переименовать", icon: icons.edit, action: () => renamePlaylist(playlist) },
    { label: playlist.cover ? "Сменить обложку…" : "Своя обложка…", icon: icons.image, action: () => pickPlaylistCover(playlist) },
    ...(playlist.cover ? [{ label: "Убрать свою обложку", icon: icons.close, action: () => library.setPlaylistCover(playlist.id, null) }] : []),
    { label: "Поделиться", icon: icons.share, disabled: !playlist.tracks.length, action: () => sharePlaylist(playlist) },
    ...folderMenuItem(playlist),
    { sep: true },
    { label: "Удалить плейлист", icon: icons.trash, danger: true, action: async () => { if (await deletePlaylist(playlist)) onDeleted?.(); } },
  ]);
}
