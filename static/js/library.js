// Медиатека: избранное, дизлайки, плейлисты, история, настройки.
// Данные лежат на сервере (library.json). Здесь — копия в памяти и все операции над ней;
// после каждого изменения раздел отправляется на сервер, а интерфейс получает событие.

export const lib = { liked: [], disliked: [], playlists: [], history: [], settings: {}, downloads: [], stats: {}, picks: {}, session: {} };

const HISTORY_LIMIT = 12;

export const keyOf = (t) => `${t.source}:${t.id}`;

// В медиатеке храним только то, что нужно, чтобы показать и включить трек
export const slim = (t) => ({
  source: t.source,
  id: t.id,
  title: t.title ?? "Без названия",
  channel: t.channel ?? null,
  duration: t.duration ?? null,
  // Из импорта: исполнители и название из исходного сервиса (у найденной пары — только один канал)
  ...(t.artists ? { artists: t.artists } : {}),
  ...(t.origTitle ? { origTitle: t.origTitle } : {}),
  // Со страниц исполнителей: обложка альбома и id исполнителя в базе
  ...(t.cover ? { cover: t.cover, coverLarge: t.coverLarge } : {}),
  ...(t.artistId ? { artistId: t.artistId } : {}),
  ...(t.albumId ? { albumId: t.albumId } : {}),
  ...(t.album ? { album: t.album } : {}),
  ...(t.artistRefs ? { artistRefs: t.artistRefs } : {}),
  ...(t.metaId ? { metaId: t.metaId } : {}),
});

// ---------- События ----------

const listeners = new Set();
/** fn(section) вызывается после каждого изменения раздела ("liked", "playlists", ...) */
export const onChange = (fn) => listeners.add(fn);

const errorListeners = new Set();
export const onSaveError = (fn) => errorListeners.add(fn);

// ---------- Сохранение ----------
// Частые изменения (например, громкость) склеиваем: отправляем через 300 мс тишины.
// Отправки одного раздела идут строго по очереди, чтобы старая не обогнала новую.

const timers = {};
const chains = {};

function send(section) {
  const body = JSON.stringify(lib[section]);
  chains[section] = (chains[section] || Promise.resolve()).then(() =>
    fetch(`/api/library/${section}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,   // чтобы запрос дошёл, даже если окно закрывают
    })
      .then((r) => { if (!r.ok) throw new Error(`сервер ответил ${r.status}`); })
      .catch((err) => errorListeners.forEach((fn) => fn(err))),
  );
}

function changed(section) {
  clearTimeout(timers[section]);
  timers[section] = setTimeout(() => { delete timers[section]; send(section); }, 300);
  listeners.forEach((fn) => fn(section));
}

// Окно закрывается — отправляем всё, что ещё ждёт
export function flush() {
  for (const section of Object.keys(timers)) {
    clearTimeout(timers[section]);
    delete timers[section];
    send(section);
  }
}

export async function loadLibrary() {
  const res = await fetch("/api/library");
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  Object.assign(lib, await res.json());
  migrateFromLocalStorage();
}

// Раньше история и настройки жили в localStorage браузера — переносим один раз
function migrateFromLocalStorage() {
  try {
    if (lib.history.length || Object.keys(lib.settings).length) return;
    const read = (key) => JSON.parse(localStorage.getItem(key) ?? "null");
    const history = read("history"), source = read("source"), volume = read("volume");
    if (Array.isArray(history) && history.length) {
      lib.history = history.map(slim).slice(0, HISTORY_LIMIT);
      changed("history");
    }
    if (source !== null || volume !== null) {
      if (source !== null) lib.settings.source = source;
      if (volume !== null) lib.settings.volume = volume;
      changed("settings");
    }
    ["history", "source", "volume"].forEach((key) => localStorage.removeItem(key));
  } catch {}
}

// ---------- Избранное и дизлайки ----------

const has = (list, track) => list.some((t) => keyOf(t) === keyOf(track));
const without = (list, track) => list.filter((t) => keyOf(t) !== keyOf(track));

/** Куда кладёт сердечко ♡: плейлист, выбранный в настройках (settings.likeTarget), или «Избранное» (null).
    Плейлист удалили — снова «Избранное» */
export function likeTarget() {
  const id = lib.settings.likeTarget;
  return id && id !== "liked" ? getPlaylist(id) : null;
}
export const likeTargetName = () => likeTarget()?.name ?? "Избранное";

export const isLiked = (track) => has(likeTarget()?.tracks ?? lib.liked, track);
export const isDisliked = (track) => has(lib.disliked, track);

function unlike(track) {
  const target = likeTarget();
  if (target) {
    target.tracks = without(target.tracks, track);
    changed("playlists");
  } else {
    lib.liked = without(lib.liked, track);
    changed("liked");
  }
}

/** Возвращает новое состояние: true — теперь в избранном (или в выбранном для ♡ плейлисте) */
export function toggleLike(track) {
  if (isLiked(track)) {
    unlike(track);
    return false;
  }
  const target = likeTarget();
  if (target) {
    target.tracks.push(slim(track));
    changed("playlists");
  } else {
    lib.liked = [slim(track), ...lib.liked];
    changed("liked");
  }
  if (isDisliked(track)) {   // лайк и дизлайк сразу не бывают
    lib.disliked = without(lib.disliked, track);
    changed("disliked");
  }
  return true;
}

/** Где лежит лайк трека (для «Отменить» после дизлайка): {playlist, index} или null — лайка нет */
export function likePlace(track) {
  const target = likeTarget();
  const index = (target?.tracks ?? lib.liked).findIndex((t) => keyOf(t) === keyOf(track));
  return index < 0 ? null : { playlist: target?.id ?? null, index };
}

/** Вернуть лайк на прежнее место (то, что запомнил likePlace) */
export function restoreLike(track, place) {
  if (!place) return;
  const list = place.playlist ? getPlaylist(place.playlist)?.tracks : lib.liked;
  if (!list || has(list, track)) return;
  list.splice(Math.min(place.index, list.length), 0, slim(track));
  changed(place.playlist ? "playlists" : "liked");
}

/** Возвращает новое состояние: true — теперь с дизлайком */
export function toggleDislike(track) {
  if (isDisliked(track)) {
    lib.disliked = without(lib.disliked, track);
    changed("disliked");
    return false;
  }
  lib.disliked = [slim(track), ...lib.disliked];
  changed("disliked");
  if (isLiked(track)) unlike(track);
  return true;
}

// ---------- Плейлисты ----------

const newId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export const getPlaylist = (id) => lib.playlists.find((p) => p.id === id) ?? null;

/** tracks — сразу положить треки (например, при импорте); повторы отбрасываются */
/** Переезд из другого сервиса: много треков в «Избранное» сразу — сверху, в том же порядке, без повторов.
 *  Возвращает, сколько добавилось */
export function addLikedMany(tracks) {
  const fresh = [...new Map(tracks.filter((t) => !has(lib.liked, t)).map((t) => [keyOf(t), slim(t)])).values()];
  if (!fresh.length) return 0;
  lib.liked = [...fresh, ...lib.liked];
  changed("liked");
  return fresh.length;
}

/** Подписаться сразу на многих исполнителей ({id, name, picture}); возвращает, на скольких новых */
export function followMany(artists) {
  const list = followedArtists();
  const fresh = artists.filter((a) => a.id && !list.some((f) => String(f.id) === String(a.id)));
  if (fresh.length) setSetting("followed", [...fresh.map(({ id, name, picture }) => ({ id, name, picture: picture || null })), ...list]);
  return fresh.length;
}

export function createPlaylist(name, tracks = []) {
  const unique = [...new Map(tracks.map((t) => [keyOf(t), slim(t)])).values()];
  const playlist = { id: newId(), name: name.trim() || "Новый плейлист", created: Date.now(), tracks: unique };
  lib.playlists = [...lib.playlists, playlist];
  changed("playlists");
  return playlist;
}

export function renamePlaylist(id, name) {
  const p = getPlaylist(id);
  if (!p || !name.trim()) return;
  p.name = name.trim();
  changed("playlists");
}

/** Своя обложка плейлиста (картинка data:… ~30 КБ) или null — снова мозаика из обложек треков */
export function setPlaylistCover(id, cover) {
  const p = getPlaylist(id);
  if (!p) return;
  if (cover) p.cover = cover;
  else delete p.cover;
  changed("playlists");
}

export function deletePlaylist(id) {
  lib.playlists = lib.playlists.filter((p) => p.id !== id);
  changed("playlists");
}

/** false — трек уже есть в плейлисте */
export function addToPlaylist(id, track) {
  const p = getPlaylist(id);
  if (!p || has(p.tracks, track)) return false;
  p.tracks.push(slim(track));
  changed("playlists");
  return true;
}

export function removeFromPlaylist(id, track) {
  const p = getPlaylist(id);
  if (!p) return;
  p.tracks = without(p.tracks, track);
  changed("playlists");
}

/** Удалить несколько треков из плейлиста сразу. Возвращает прежний список — для «Отменить» */
export function removeManyFromPlaylist(id, tracks) {
  const p = getPlaylist(id);
  if (!p) return null;
  const before = p.tracks.slice();
  const keys = new Set(tracks.map(keyOf));
  p.tracks = p.tracks.filter((t) => !keys.has(keyOf(t)));
  changed("playlists");
  return before;
}

/** «Отменить»: вернуть плейлисту прежний список треков (если плейлист ещё есть) */
export function setPlaylistTracks(id, tracks) {
  const p = getPlaylist(id);
  if (!p) return;
  p.tracks = tracks.slice();
  changed("playlists");
}

/** Перетаскивание: трек с позиции from встаёт на позицию to */
export function moveInPlaylist(id, from, to) {
  const p = getPlaylist(id);
  if (!p || from === to || !p.tracks[from]) return;
  const [track] = p.tracks.splice(from, 1);
  p.tracks.splice(to, 0, track);
  changed("playlists");
}

// ---------- Скачанное ----------

/** Запомнить, что человек скачал эти треки (новые — сверху) */
export function addDownloads(tracks) {
  const fresh = tracks.filter((t) => !has(lib.downloads, t)).map(slim);
  if (!fresh.length) return;
  lib.downloads = [...fresh, ...lib.downloads];
  changed("downloads");
}

export function removeDownloads(tracks) {
  const keys = new Set(tracks.map(keyOf));
  lib.downloads = lib.downloads.filter((t) => !keys.has(keyOf(t)));
  changed("downloads");
}

// ---------- История и настройки ----------

export function addToHistory(track) {
  lib.history = [slim(track), ...without(lib.history, track)].slice(0, HISTORY_LIMIT);
  changed("history");
}

export function removeFromHistory(track) {
  lib.history = without(lib.history, track);
  changed("history");
}

export function clearHistory() {
  lib.history = [];
  changed("history");
}

export const getSetting = (name, fallback) => lib.settings[name] ?? fallback;

/** «Без анимаций» (Настройки → Оформление): для слабых компьютеров — ничего не движется само,
    визуализация и живые фоны не рисуются каждый кадр (body.no-anim, проверяют viz/nowbg/flowview) */
export const motionOff = () => lib.settings.reduceMotion === true;

export function setSetting(name, value) {
  lib.settings[name] = value;
  changed("settings");
}

/** Поправить сведения о треке везде, где он сохранён (избранное, плейлисты, история, скачанное) */
export function updateTrack(track, patch) {
  const key = keyOf(track);
  const fix = (list) => {
    let hit = false;
    list.forEach((t, i) => { if (keyOf(t) === key) { list[i] = { ...t, ...patch }; hit = true; } });
    return hit;
  };
  for (const section of ["liked", "disliked", "history", "downloads"]) {
    if (Array.isArray(lib[section]) && fix(lib[section])) changed(section);
  }
  if (lib.playlists.some((p) => fix(p.tracks))) changed("playlists");
  Object.assign(track, patch);   // и у того же трека, что на экране / в очереди
}

// ---------- Подписки на исполнителей ----------
// settings.followed = [{ id (Яндекс), name, picture }] — их новые релизы на «Главной» (views.js → newReleasesRow)

export const followedArtists = () => getSetting("followed", []);
export const isFollowing = (id) => followedArtists().some((a) => String(a.id) === String(id));

/** Подписаться/отписаться. Возвращает true, если теперь подписан */
export function toggleFollow(artist) {
  const list = followedArtists();
  const on = !isFollowing(artist.id);
  setSetting("followed", on ? [{ id: artist.id, name: artist.name, picture: artist.picture || null }, ...list]
    : list.filter((a) => String(a.id) !== String(artist.id)));
  return on;
}

// ---------- Версии без цензуры ----------
// Трек оказался запикан, и нашлась другая версия — запоминаем: дальше вместо него всегда играет она.
// settings.altVersions = { "youtube:abc": { …трек-замена } }; censored — какие версии оказались запиканы

export const altVersionOf = (track) => (track ? getSetting("altVersions", {})[keyOf(track)] ?? null : null);

export function setAltVersion(track, alt) {
  const map = { ...getSetting("altVersions", {}) };
  if (alt) map[keyOf(track)] = slim(alt);
  else delete map[keyOf(track)];
  setSetting("altVersions", map);
}

export const censoredKeys = () => getSetting("censored", []);
export function markCensored(track) {
  const keys = censoredKeys();
  if (!keys.includes(keyOf(track))) setSetting("censored", [...keys, keyOf(track)].slice(-500));
}

// ---------- Статистика прослушивания ----------
// Меняется каждую секунду, пока играет музыка, — поэтому сохраняем редко (раз в 15 с)
// и никому не сообщаем: перерисовывать экраны из-за неё не нужно (stats.js сам знает, когда показать)

/** Подборки «Собрано для вас» обновились (picks.js) — сохранить и перерисовать «Главную» */
export const picksChanged = () => changed("picks");

/** Что играет сейчас (player.js) — чтобы при следующем запуске вернуть трек, очередь и место.
    Тоже тихо: soon — сохранить через 2 с (сменился трек, пауза), иначе не чаще раза в 15 с */
export function sessionChanged(soon = false) {
  if (timers.session && !soon) return;
  clearTimeout(timers.session);
  timers.session = setTimeout(() => { delete timers.session; send("session"); }, soon ? 2000 : 15000);
}

export function statsChanged() {
  if (timers.stats) return;
  timers.stats = setTimeout(() => { delete timers.stats; send("stats"); }, 15000);
}
