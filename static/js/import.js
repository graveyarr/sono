// Импорт плейлиста: по ссылке (Spotify, Яндекс Музыка, Apple Music, Deezer, YouTube, SoundCloud)
// или списком треков, вставленным текстом (подходит для VK Музыки и любых других сервисов).
// Окно проходит три состояния: форма → прогресс → результат.
// Импорт идёт на сервере; окно можно закрыть — по окончании придёт уведомление,
// а плейлист появится в медиатеке.
// Отдельно — «Переезд из Яндекс Музыки»: по ссылке на профиль переносим всё сразу — «Мне нравится»
// в «Избранное», плейлисты, любимых исполнителей (подписка + вкус для Flow).

import { icons, sourceIcons } from "./icons.js";
import { seedTaste } from "./flow.js";
import { addLikedMany, createPlaylist, followMany, getSetting, setSetting } from "./library.js";
import { decodeShared } from "./share.js";
import { SOURCE_NAMES, el, imgUrl, openModal, plural, toast } from "./ui.js";
import { isMobile } from "./device.js";

// needsMatch — сервис отдаёт только названия, пары ищем на YouTube или SoundCloud
const KINDS = [
  { kind: "spotify", name: "Spotify", needsMatch: true, test: /open\.spotify\.com|^spotify:/i,
    note: "Из плейлистов Spotify берутся первые 100 треков." },
  { kind: "yandex", name: "Яндекс Музыка", needsMatch: true, test: /music\.yandex\./i },
  { kind: "apple", name: "Apple Music", needsMatch: true, test: /music\.apple\.com/i },
  { kind: "deezer", name: "Deezer", needsMatch: true, test: /deezer\.(com|page\.link)|link\.deezer\.com/i },
  { kind: "youtube", name: "YouTube", needsMatch: false, test: /youtube\.com|youtu\.be/i },
  { kind: "soundcloud", name: "SoundCloud", needsMatch: false, test: /soundcloud\.com/i },
];
const detectKind = (url) => KINDS.find((k) => k.test.test(url.trim())) ?? null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let job = null;        // текущий импорт (снимок с сервера) — одновременно только один
let result = null;     // { job, playlist } — чем закончился последний импорт
let render = null;     // перерисовать открытое окно (null — окно закрыто)
let onOpenPlaylist = null;
// Где искать пары для треков из сервисов без музыки (запоминается)
const MATCH_OPTIONS = [
  { value: "auto", label: "Авто",
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/></svg>',
    hint: "Сначала SoundCloud — оттуда трек потом стартует быстрее. Если там нет точного совпадения или трек защищён — YouTube." },
  { value: "youtube", label: "YouTube", icon: sourceIcons.youtube,
    hint: "Больше всего музыки. Первый запуск незнакомого трека — несколько секунд." },
  { value: "soundcloud", label: "SoundCloud", icon: sourceIcons.soundcloud,
    hint: "Треки стартуют быстрее, но музыки меньше: чаще попадаются перезаливы и ремиксы." },
];
let match = "auto";
let mode = "link";     // форма: "link" — по ссылке, "text" — списком, "share" — код/файл, "yandex" — переезд, "files" — выгрузки
let yandexProfile = null;   // что нашлось в профиле (Яндекс или SoundCloud) — экран выбора
// Переезд целиком: Яндекс Музыка или SoundCloud — одно окно, разные тексты и адреса
const MOVES = {
  yandex: {
    icon: "yandex", title: "Переезд из Яндекс Музыки", api: "yandex-profile", payload: "yandex",
    intro: "Перенесём «Мне нравится», ваши плейлисты и любимых исполнителей — по одной ссылке.",
    steps: ["Откройте music.yandex.ru в браузере и перейдите в «Мне нравится» или в любой свой плейлист.",
      "Скопируйте ссылку из адресной строки — в ней есть «/users/ваш-логин/». Можно просто вписать логин."],
    placeholder: "https://music.yandex.ru/users/логин/playlists/3",
    liked: "Мне нравится", artists: "Любимые исполнители", artistsSub: "подписка, и Flow сразу узнает ваш вкус",
    key: (pl) => pl.kind, perMinute: 250, progress: "Переношу музыку из Яндекса",
  },
  soundcloud: {
    icon: "soundcloud", title: "Переезд со SoundCloud", api: "soundcloud-profile", payload: "soundcloud",
    intro: "Перенесём ваши лайки, плейлисты и подписки. Треки останутся теми же загрузками SoundCloud — ремиксы, бутлеги и всё, чего нет на других сервисах.",
    steps: ["Откройте soundcloud.com, нажмите на свой аватар → «Profile».",
      "Скопируйте ссылку из адресной строки — вида soundcloud.com/ваш-ник. Можно просто вписать ник."],
    placeholder: "https://soundcloud.com/ваш-ник",
    liked: "Лайки", artists: "Подписки", artistsSub: "подписка — в медиатеке, и Flow сразу узнает ваш вкус",
    key: (pl) => pl.id, perMinute: 1500, progress: "Переношу музыку со SoundCloud",
  },
};
let moveSvc = "yandex";

/** onOpen(playlistId) — что делать по кнопке «Открыть плейлист»; yandex — сразу открыть «Переезд из Яндекс Музыки» */
export function openImportDialog({ onOpen, yandex = false } = {}) {
  onOpenPlaylist = onOpen;
  if (yandex) { mode = "yandex"; moveSvc = "yandex"; yandexProfile = null; }
  else if (mode === "yandex" || mode === "files") mode = "link";   // в прошлый раз закрыли окно на переезде — обычный импорт с начала
  match = getSetting("importMatch", "auto");
  if (!MATCH_OPTIONS.some((o) => o.value === match)) match = "auto";
  const { box, close } = openModal({
    className: "import-dialog",
    onClose: () => {
      render = null;
      if (!job) result = null;   // результат уже показали — в следующий раз снова форма
    },
  });
  render = () => {
    if (job && job.status === "running") renderProgress(box, close);
    else if (result) renderResult(box, close);
    else renderForm(box, close);
  };
  render();
}

// ---------- Форма ----------

function renderForm(box, close) {
  box.replaceChildren();
  box.onsubmit = null;
  if (mode === "yandex") return yandexProfile ? renderYandexPick(box, close) : renderYandexForm(box, close);
  if (mode === "files") return renderFilesForm(box, close);

  // Переключатель «По ссылке / Списком / Файл или код»
  const tabs = el("div", "seg import-tabs");
  for (const [value, label] of [["link", "По ссылке"], ["text", "Списком"], ["share", "Файл или код"]]) {
    const tab = el("button", "seg-btn", label);
    tab.type = "button";
    tab.classList.toggle("on", value === mode);
    tab.addEventListener("click", () => { if (mode !== value) { mode = value; renderForm(box, close); } });
    tabs.append(tab);
  }
  const head = el("div", "import-title-row");
  head.append(el("h2", "", "Импорт плейлиста"), tabs);
  box.append(head);
  if (mode === "share") return renderShareForm(box, close);

  let field;
  const detected = el("div", "import-detected");   // под полем — какой сервис узнали по ссылке
  if (mode === "link") {
    box.append(el("p", "", "Вставьте ссылку на открытый плейлист или альбом — он появится в медиатеке."));
    const services = el("div", "import-services");
    for (const k of KINDS) {
      const s = el("span", "import-service");
      s.innerHTML = sourceIcons[k.kind];
      s.title = k.name;
      services.append(s);
    }
    box.append(services);
    // Тем, кто переезжает, — сразу весь Яндекс, а не по одному плейлисту
    const move = el("button", "import-move");
    move.type = "button";
    move.innerHTML = `${sourceIcons.yandex}<span><b>Переезжаете с Яндекс Музыки?</b>`
      + "<small>Перенесём «Мне нравится», все плейлисты и любимых исполнителей разом</small></span><i>→</i>";
    move.addEventListener("click", () => { mode = "yandex"; moveSvc = "yandex"; yandexProfile = null; renderForm(box, close); });
    const fromSc = el("button", "import-move");
    fromSc.type = "button";
    fromSc.innerHTML = `${sourceIcons.soundcloud}<span><b>Переезжаете со SoundCloud?</b>`
      + "<small>Лайки, плейлисты и подписки по ссылке на профиль</small></span><i>→</i>";
    fromSc.addEventListener("click", () => { mode = "yandex"; moveSvc = "soundcloud"; yandexProfile = null; renderForm(box, close); });
    // Spotify без входа отдаёт только открытые плейлисты до 100 треков — остальное через выгрузку файлом
    const fromFiles = el("button", "import-move");
    fromFiles.type = "button";
    fromFiles.innerHTML = `${icons.import}<span><b>Выгрузка из Spotify или YouTube Music</b>`
      + "<small>«Любимые треки» и большие плейлисты — из файла, без ограничения в 100 треков</small></span><i>→</i>";
    fromFiles.addEventListener("click", () => { mode = "files"; renderForm(box, close); });
    box.append(move, fromSc, fromFiles);
    field = el("input", "dialog-input");
    field.placeholder = "https://music.yandex.ru/users/…/playlists/…";
  } else {
    box.append(el("p", "", "По строке на трек: «Исполнитель — Название». Или вставьте целиком страницу с музыкой — "
      + "Sono сам найдёт в ней названия, исполнителей и длительность."));
    // VK без входа треки не отдаёт, Звук и МТС Музыка закрыты капчей — но свою страницу с музыкой можно скопировать
    const vk = el("details", "import-howto");
    const sum = el("summary");
    sum.innerHTML = `${sourceIcons.vk ?? icons.note}<span>Как перенести из VK Музыки, Звука или МТС Музыки</span>`;
    const steps = el("ol", "import-steps");
    for (const step of ["Откройте свою музыку в браузере (vk.com/audio, zvuk.com, music.mts.ru) и прокрутите список до конца — чтобы загрузились все треки.",
      "Нажмите Ctrl+A, потом Ctrl+C — скопируется вся страница.",
      "Вставьте сюда (Ctrl+V) — лишнее Sono пропустит сам."]) steps.append(el("li", "", step));
    vk.append(sum, steps);
    box.append(vk);
    field = el("textarea", "dialog-input import-textarea");
    field.placeholder = "Кино — Группа крови\nМонеточка — Каждый раз\n…";
    field.rows = 7;
  }
  field.spellcheck = false;

  // Где искать пары — для сервисов, которые не отдают музыку, и для списка
  const matchBox = el("div", "import-spotify");
  const seg = el("div", "seg");
  const matchHint = el("div", "import-hint");
  const syncMatchHint = () => { matchHint.textContent = MATCH_OPTIONS.find((o) => o.value === match).hint; };
  for (const option of MATCH_OPTIONS) {
    const btn = el("button", "seg-btn");
    btn.type = "button";
    btn.innerHTML = `${option.icon}<span>${option.label}</span>`;
    btn.classList.toggle("on", option.value === match);
    btn.addEventListener("click", () => {
      match = option.value;
      setSetting("importMatch", match);
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b === btn));
      syncMatchHint();
    });
    seg.append(btn);
  }
  syncMatchHint();
  const hint = el("div", "import-hint");
  const matchInner = el("div");   // один внутренний блок — чтобы раскрытие анимировалось
  matchInner.append(el("div", "import-label", "Где искать треки"), seg, matchHint, hint);
  matchBox.append(matchInner);

  const errorText = el("p", "import-error");

  const row = el("div", "dialog-buttons");
  const cancel = el("button", "btn ghost", "Отмена");
  cancel.type = "button";
  cancel.addEventListener("click", close);
  const ok = el("button", "btn primary", "Импортировать");
  ok.type = "submit";
  row.append(cancel, ok);

  const sync = () => {
    errorText.textContent = "";
    if (mode === "text") {
      matchBox.classList.add("shown");
      hint.textContent = "Для каждой строки найдём трек по названию. Подбор приблизительный, иногда попадается другая версия.";
      ok.disabled = !field.value.trim();
      return;
    }
    const kind = detectKind(field.value);
    detected.innerHTML = kind ? `${sourceIcons[kind.kind]}<span>${kind.name}</span>` : "";
    detected.classList.toggle("shown", !!kind);
    // Выбор виден сразу; прячем его, только если ссылка — на YouTube или SoundCloud (там искать не нужно)
    matchBox.classList.toggle("shown", !kind || kind.needsMatch);
    hint.textContent = kind?.needsMatch
      ? `${kind.name} не отдаёт саму музыку — для каждого трека найдём похожий по названию и длительности. `
        + `Подбор приблизительный, иногда попадается другая версия. ${kind.note ?? ""}`
      : "";
    ok.disabled = !kind;
  };
  field.addEventListener("input", sync);
  sync();

  box.append(field, detected, matchBox, errorText, row);
  box.onsubmit = (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    const payload = mode === "text" ? { text: field.value } : { url: field.value.trim() };
    start(payload).catch((err) => { errorText.textContent = err.message; });
  };
  // Enter в списке — новая строка, а Ctrl+Enter — запуск
  field.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) box.requestSubmit(); });
  if (!isMobile) field.focus();   // на телефоне клавиатура сразу закрыла бы пол-окна
}

// ---------- Плейлист, которым поделился друг (код или файл) ----------
// Тут ничего искать не нужно: в коде уже лежат готовые треки — плейлист появляется сразу.

function renderShareForm(box, close) {
  box.append(el("p", "", "Вставьте код плейлиста (начинается с «SONO1:») или выберите файл .sono.json, который вам прислали."));
  const field = el("textarea", "dialog-input import-textarea");
  field.placeholder = "SONO1:…";
  field.rows = 4;
  field.spellcheck = false;
  const errorText = el("p", "import-error");

  const picker = el("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.hidden = true;

  const create = async (text) => {
    errorText.textContent = "";
    let shared;
    try { shared = await decodeShared(text); } catch (err) { errorText.textContent = err.message || "Не получилось прочитать"; return; }
    const playlist = createPlaylist(shared.name, shared.tracks);
    toast(`Плейлист «${playlist.name}» добавлен: ${plural(playlist.tracks.length, "трек", "трека", "треков")}`);
    close();
    onOpenPlaylist?.(playlist.id);
  };

  const row = el("div", "dialog-buttons");
  const fileBtn = el("button", "btn ghost", "Выбрать файл…");
  fileBtn.type = "button";
  fileBtn.addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => {
    const file = picker.files[0];
    picker.value = "";
    if (file) create(await file.text());
  });
  const ok = el("button", "btn primary", "Добавить");
  ok.type = "submit";
  const sync = () => { ok.disabled = !field.value.trim(); };
  field.addEventListener("input", sync);
  sync();
  row.append(fileBtn, ok, picker);
  box.onsubmit = (e) => { e.preventDefault(); if (field.value.trim()) create(field.value); };
  box.append(field, errorText, row);
  if (!isMobile) field.focus();   // на телефоне клавиатура сразу закрыла бы пол-окна
}

// ---------- Прогресс ----------

function renderProgress(box, close) {
  const total = job.total || 0;
  const fraction = total ? job.done / total : 0;
  let bar = box.querySelector(".import-bar i");
  if (!bar) {   // строим окно один раз, дальше только обновляем цифры — так полоска плавно растёт
    box.replaceChildren();
    box.onsubmit = (e) => e.preventDefault();
    const head = el("div", "import-head");
    const kindIcon = { files: icons.import, yandex_all: sourceIcons.yandex, sc_all: sourceIcons.soundcloud }[job.kind] ?? sourceIcons[job.kind];
    head.innerHTML = `<span class="import-source">${kindIcon ?? ""}</span><h2></h2>`;
    const progress = el("div", "import-bar");
    progress.append(el("i"));
    const row = el("div", "dialog-buttons");
    const hide = el("button", "btn ghost", "Свернуть");
    hide.type = "button";
    hide.title = "Импорт продолжится, когда закончится — придёт уведомление";
    hide.addEventListener("click", close);
    const stop = el("button", "btn ghost", "Остановить");
    stop.type = "button";
    stop.addEventListener("click", () => fetch(`/api/import/${job.id}`, { method: "DELETE" }));
    row.append(stop, hide);
    box.append(head, el("p", "import-count"), progress, el("p", "import-hint import-wait"), row);
    bar = box.querySelector(".import-bar i");
  }
  box.querySelector(".import-head h2").textContent = job.kind === "yandex_all" ? "Переношу музыку из Яндекса"
    : job.kind === "files" ? "Переношу музыку из файлов"
    : job.kind === "sc_all" ? MOVES.soundcloud.progress
    : job.name ? `Импортирую «${job.name}»` : "Читаю плейлист…";
  box.querySelector(".import-count").textContent = total ? `${job.done} из ${plural(total, "трека", "треков", "треков")}` : "Получаю список треков…";
  const searching = job.kind === "text" || job.kind === "yandex_all" || job.kind === "files" || KINDS.find((k) => k.kind === job.kind)?.needsMatch;
  box.querySelector(".import-wait").textContent = searching
    ? `Ищу каждый трек ${match === "auto" ? "на SoundCloud и YouTube" : "на " + SOURCE_NAMES[match]} — это займёт немного времени. Окно можно свернуть.`
    : "Окно можно свернуть — импорт продолжится.";
  bar.style.width = `${Math.max(fraction * 100, total ? 2 : 0)}%`;
  bar.parentElement.classList.toggle("indeterminate", !total);
}

// ---------- Результат ----------

function renderResult(box, close) {
  if (result.moved) return renderYandexResult(box, close);
  const { job: done, playlist } = result;
  box.replaceChildren();
  box.onsubmit = (e) => e.preventDefault();

  const head = el("div", "import-head");
  head.innerHTML = `<span class="import-source">${sourceIcons[done.kind] ?? ""}</span><h2></h2>`;
  const title = head.querySelector("h2");
  box.append(head);

  if (playlist) {
    title.textContent = "Готово!";
    box.append(el("p", "", `«${playlist.name}»: ${plural(playlist.tracks.length, "трек добавлен", "трека добавлено", "треков добавлено")}`
      + (done.failed.length ? `, ${plural(done.failed.length, "трек пропущен", "трека пропущено", "треков пропущено")}.` : ".")));
  } else {
    title.textContent = done.status === "cancelled" ? "Импорт остановлен" : "Не получилось";
    box.append(el("p", "import-error", done.error || (done.status === "cancelled"
      ? "Плейлист не создан." : "Не удалось найти ни одного трека из этого плейлиста.")));
  }
  if (done.note) box.append(el("p", "import-hint", done.note));

  // Что не получилось и почему — свёрнутым списком
  if (done.failed.length) {
    const details = el("details", "import-failed");
    details.append(el("summary", "", `Пропущенные треки (${done.failed.length})`));
    const list = el("ul");
    for (const f of done.failed.slice(0, 200)) {
      const li = el("li");
      li.append(el("span", "", f.title), el("span", "import-reason", f.reason));
      list.append(li);
    }
    details.append(list);
    box.append(details);
  }

  const row = el("div", "dialog-buttons");
  const again = el("button", "btn ghost", "Импортировать ещё");
  again.type = "button";
  again.addEventListener("click", () => { result = null; render?.(); });
  row.append(again);
  if (playlist) {
    const open = el("button", "btn primary", "Открыть плейлист");
    open.type = "button";
    open.addEventListener("click", () => { close(); result = null; onOpenPlaylist?.(playlist.id); });
    row.append(open);
  } else {
    const ok = el("button", "btn primary", "Закрыть");
    ok.type = "button";
    ok.addEventListener("click", () => { close(); result = null; });
    row.append(ok);
  }
  box.append(row);
}

// ---------- Запуск и опрос сервера ----------

/** payload: { url } — по ссылке или { text } — списком */
async function start(payload) {
  const res = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, match }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "сервер не ответил");
  job = data;
  result = null;
  render?.();

  // Спрашиваем сервер, сколько готово, пока импорт не закончится
  while (job.status === "running") {
    await wait(700);
    try {
      const r = await fetch(`/api/import/${job.id}`);
      if (r.ok) job = await r.json();
      else if (r.status === 404) job = { ...job, status: "error", error: "Сервер потерял задачу импорта (его перезапускали?)" };
    } catch {}
    render?.();
  }

  if (job.kind === "yandex_all" || job.kind === "files" || job.kind === "sc_all") {
    // Остановили — раскладываем то, что успело найтись
    result = { job, moved: job.status === "done" || (job.status === "cancelled" && job.collections) ? applyYandex(job) : null };
    job = null;
    if (!render) {
      const m = result.moved;
      if (m && (m.liked || m.playlists.length || m.artists)) toast(`Переезд готов: ${movedText(m)}`);
      else toast("Переезд не удался: " + (result.job.error || "треки не найдены"), { error: true });
    }
    render?.();
    return;
  }
  const playlist = job.status === "done" && job.tracks.length ? createPlaylist(job.name, job.tracks) : null;
  result = { job, playlist };
  job = null;
  if (!render) {   // окно свернули — сообщаем уведомлением
    if (playlist) toast(`Импорт готов: «${playlist.name}», ${plural(playlist.tracks.length, "трек", "трека", "треков")}`);
    else toast("Импорт не удался: " + (result.job.error || "треки не найдены"), { error: true });
  }
  render?.();
}

// ---------- Выгрузки из Spotify, YouTube Music и других (файлы) ----------

const FILE_HOWTO = [
  { icon: "spotify", name: "Spotify — за пару минут",
    steps: ["Откройте exportify.net, нажмите «Get Started» и войдите через Spotify (на их сайте, не в Sono).",
      "Нажмите «Export All» — скачается архив .zip со всеми плейлистами и «Любимыми треками».",
      "Выберите этот архив здесь — распаковывать не нужно."] },
  { icon: "spotify", name: "Spotify — официально",
    steps: ["spotify.com → Профиль → Аккаунт → «Конфиденциальность» → «Скачать данные» → «Данные аккаунта».",
      "Письмо со ссылкой придёт в течение нескольких дней — скачайте архив.",
      "Выберите архив или файлы YourLibrary.json и Playlist1.json."] },
  { icon: "youtube", name: "YouTube и YouTube Music",
    steps: ["Откройте takeout.google.com → «Отменить выбор» → отметьте только «YouTube и YouTube Music».",
      "«Выбраны все данные» → оставьте только «плейлисты» и «музыка»; формат — CSV.",
      "Когда архив будет готов, выберите его здесь."] },
];

function readFile(file) {
  // Архив — целиком (сервер распакует сам), таблицы и JSON — текстом
  if (/\.zip$/i.test(file.name)) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, zip: String(reader.result).split(",", 2)[1] || "" });
      reader.onerror = () => reject(new Error(`Не получилось прочитать «${file.name}»`));
      reader.readAsDataURL(file);
    });
  }
  return file.text().then((text) => ({ name: file.name, text }));
}

function renderFilesForm(box, close) {
  const head = el("div", "import-head");
  head.innerHTML = `<span class="import-source">${icons.import}</span><h2>Перенос из файлов</h2>`;
  box.append(head, el("p", "", "Сервисы не отдают «Любимые треки» без входа, а Spotify — больше 100 треков плейлиста. "
    + "Но любой сервис даёт скачать свою музыку файлом — выберите его, и Sono разложит всё по местам."));
  for (const how of FILE_HOWTO) {
    const d = el("details", "import-howto");
    const sum = el("summary");
    sum.innerHTML = `${sourceIcons[how.icon] ?? ""}<span></span>`;
    sum.querySelector("span").textContent = how.name;
    const ol = el("ol", "import-steps");
    how.steps.forEach((step) => ol.append(el("li", "", step)));
    d.append(sum, ol);
    box.append(d);
  }
  box.append(el("p", "import-hint", "Подойдёт и любой CSV с колонками «исполнитель» и «название» — например, из TuneMyMusic или Soundiiz. "
    + "«Любимые треки» попадут в «Избранное», плейлисты — в медиатеку."));
  const errorText = el("p", "import-error");
  const picker = el("input");
  picker.type = "file";
  picker.multiple = true;
  picker.accept = ".zip,.csv,.json,application/zip,text/csv,application/json";
  picker.hidden = true;
  const row = el("div", "dialog-buttons");
  const back = el("button", "btn ghost", "Назад");
  back.type = "button";
  back.addEventListener("click", () => { mode = "link"; renderForm(box, close); });
  const pick = el("button", "btn primary", "Выбрать файлы…");
  pick.type = "button";
  pick.addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => {
    const chosen = [...picker.files];
    picker.value = "";
    if (!chosen.length) return;
    errorText.textContent = "";
    pick.disabled = true;
    pick.textContent = "Читаю…";
    try {
      await start({ files: await Promise.all(chosen.map(readFile)) });
    } catch (err) {
      errorText.textContent = err.message;
    } finally {
      pick.disabled = false;
      pick.textContent = "Выбрать файлы…";
    }
  });
  row.append(back, pick, picker);
  box.onsubmit = (e) => e.preventDefault();
  box.append(errorText, row);
}

// ---------- Переезд из Яндекс Музыки ----------

function renderYandexForm(box, close) {
  const cfg = MOVES[moveSvc];
  const head = el("div", "import-head");
  head.innerHTML = `<span class="import-source">${sourceIcons[cfg.icon]}</span><h2></h2>`;
  head.querySelector("h2").textContent = cfg.title;
  box.append(head, el("p", "", cfg.intro));
  const how = el("ol", "import-steps");
  for (const step of cfg.steps) how.append(el("li", "", step));
  box.append(how);
  const field = el("input", "dialog-input");
  field.placeholder = cfg.placeholder;
  field.spellcheck = false;
  const errorText = el("p", "import-error");
  const row = el("div", "dialog-buttons");
  const back = el("button", "btn ghost", "Назад");
  back.type = "button";
  back.addEventListener("click", () => { mode = "link"; renderForm(box, close); });
  const ok = el("button", "btn primary", "Найти мою музыку");
  ok.type = "submit";
  const sync = () => { ok.disabled = !field.value.trim(); errorText.textContent = ""; };
  field.addEventListener("input", sync);
  sync();
  row.append(back, ok);
  box.append(field, errorText, row);
  box.onsubmit = async (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    ok.disabled = true;
    ok.textContent = "Ищу…";
    try {
      const res = await fetch(`/api/import/${cfg.api}?url=${encodeURIComponent(field.value.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "сервер не ответил");
      yandexProfile = { ...data, pick: { liked: data.liked > 0, artists: data.artists > 0,
                                         playlists: new Set(data.playlists.map(cfg.key)) } };
      renderForm(box, close);
    } catch (err) {
      errorText.textContent = err.message;
      ok.disabled = false;
      ok.textContent = "Найти мою музыку";
    }
  };
  if (!isMobile) field.focus();   // на телефоне клавиатура сразу закрыла бы пол-окна
}

/** Что нашлось — человек снимает галочки с лишнего и запускает перенос */
function renderYandexPick(box, close) {
  const profile = yandexProfile;
  const pick = profile.pick;
  const cfg = MOVES[moveSvc];
  const head = el("div", "import-head");
  head.innerHTML = `<span class="import-source">${sourceIcons[cfg.icon]}</span><h2>Нашёл вашу музыку</h2>`;
  box.append(head, el("p", "", "Отметьте, что перенести. Медиатека Sono не сотрётся — всё добавится к ней."));

  const list = el("div", "ya-pick");
  const row = (title, sub, checked, onChange, cover = null) => {
    const label = el("label", "ya-row");
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", () => { onChange(box.checked); summary(); });
    const pic = el("span", "ya-cover");
    if (cover) pic.style.backgroundImage = `url("${imgUrl(cover)}")`;
    const text = el("span", "ya-text");
    text.append(el("b", "", title), el("small", "", sub));
    label.append(box, pic, text);
    return label;
  };
  if (profile.liked) {
    const r = row(cfg.liked, `${plural(profile.liked, "трек", "трека", "треков")} → в «Избранное»`, pick.liked, (v) => { pick.liked = v; });
    Object.assign(r.querySelector(".ya-cover"), { className: "ya-cover liked", innerHTML: icons.heartFilled });
    list.append(r);
  }
  if (profile.artists) {
    const r = row(cfg.artists, `${plural(profile.artists, "исполнитель", "исполнителя", "исполнителей")} → ${cfg.artistsSub}`,
      pick.artists, (v) => { pick.artists = v; });
    Object.assign(r.querySelector(".ya-cover"), { className: "ya-cover artists", innerHTML: icons.artist });
    list.append(r);
  }
  if (profile.playlists.length) {
    const all = el("button", "ya-all", "");
    all.type = "button";
    const syncAll = () => { all.textContent = pick.playlists.size === profile.playlists.length ? "Снять все" : "Выбрать все"; };
    all.addEventListener("click", () => {
      const on = pick.playlists.size !== profile.playlists.length;
      pick.playlists = new Set(on ? profile.playlists.map(cfg.key) : []);
      list.querySelectorAll(".ya-row[data-kind] input").forEach((b) => { b.checked = on; });
      syncAll();
      summary();
    });
    syncAll();
    const h = el("div", "ya-head");
    h.append(el("span", "", `Плейлисты · ${profile.playlists.length}`), all);
    list.append(h);
    for (const p of profile.playlists) {
      const r = row(p.title, plural(p.count, "трек", "трека", "треков"), pick.playlists.has(cfg.key(p)), (v) => {
        if (v) pick.playlists.add(cfg.key(p)); else pick.playlists.delete(cfg.key(p));
        syncAll();
      }, p.cover);
      r.dataset.kind = cfg.key(p);
      list.append(r);
    }
  }
  const total = el("p", "import-hint");
  const buttons = el("div", "dialog-buttons");
  const back = el("button", "btn ghost", "Назад");
  back.type = "button";
  back.addEventListener("click", () => { yandexProfile = null; renderForm(box, close); });
  const ok = el("button", "btn primary", "Перенести");
  ok.type = "submit";
  buttons.append(back, ok);
  const errorText = el("p", "import-error");

  function summary() {
    // Одинаковые треки в разных списках ищутся один раз — это оценка сверху
    const count = (pick.liked ? profile.liked : 0)
      + profile.playlists.filter((p) => pick.playlists.has(cfg.key(p))).reduce((n, p) => n + p.count, 0);
    const minutes = Math.max(1, Math.round(count / cfg.perMinute));   // замер: Яндекс ~4 трека в секунду, SoundCloud — сразу
    total.textContent = count
      ? `До ${plural(count, "трека", "треков", "треков")} — займёт около ${plural(minutes, "минуты", "минут", "минут")}. Окно можно свернуть, музыка будет играть.`
      : pick.artists ? "Перенесём только исполнителей — это мгновенно." : "Ничего не выбрано.";
    ok.disabled = !count && !pick.artists;
  }
  summary();
  box.append(list, total, errorText, buttons);
  box.onsubmit = (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    start({ [cfg.payload]: { login: profile.login, liked: pick.liked, artists: pick.artists, playlists: [...pick.playlists] } })
      .catch((err) => { errorText.textContent = err.message; });
  };
}

/** Разложить найденное по медиатеке: «Мне нравится» → «Избранное», плейлисты, исполнители */
function applyYandex(done) {
  const moved = { liked: 0, playlists: [], artists: 0 };
  for (const c of done.collections || []) {
    if (!c.tracks.length) continue;
    if (c.kind === "liked") moved.liked = addLikedMany(c.tracks);
    else moved.playlists.push(createPlaylist(c.name, c.tracks));
  }
  if (done.artists?.length) {
    moved.artists = followMany(done.artists);
    seedTaste(done.artists);   // Flow сразу знает, что вы любите
  }
  yandexProfile = null;
  mode = "link";
  return moved;
}

const movedText = (m) => [
  m.liked ? `${plural(m.liked, "трек", "трека", "треков")} в «Избранном»` : "",
  m.playlists.length ? plural(m.playlists.length, "плейлист", "плейлиста", "плейлистов") : "",
  m.artists ? plural(m.artists, "исполнитель", "исполнителя", "исполнителей") : "",
].filter(Boolean).join(", ");

function renderYandexResult(box, close) {
  const { job: done, moved } = result;
  box.replaceChildren();
  box.onsubmit = (e) => e.preventDefault();
  const head = el("div", "import-head");
  head.innerHTML = `<span class="import-source">${done.kind === "files" ? icons.import : sourceIcons[done.kind === "sc_all" ? "soundcloud" : "yandex"]}</span><h2></h2>`;
  box.append(head);
  const ok = moved && (moved.liked || moved.playlists.length || moved.artists);
  const stopped = done.status === "cancelled";
  head.querySelector("h2").textContent = stopped ? "Перенос остановлен" : ok ? "Добро пожаловать в Sono!" : "Не получилось";
  if (ok) {
    box.append(el("p", "", `${stopped ? "Успели перенести" : "Перенесено"}: ${movedText(moved)}.`
      + (done.failed.length ? ` ${plural(done.failed.length, "трек не нашёлся", "трека не нашлись", "треков не нашлись")} на YouTube и SoundCloud.` : "")));
    if (moved.artists) box.append(el("p", "import-hint", "Откройте Flow — он уже подстроился под ваших исполнителей."));
  } else {
    box.append(el("p", "import-error", done.error || (done.status === "cancelled" ? "Ничего не добавлено." : "Не удалось найти ни одного трека.")));
  }
  if (done.note) box.append(el("p", "import-hint", done.note));
  if (done.failed.length) {
    const details = el("details", "import-failed");
    details.append(el("summary", "", `Не нашлись (${done.failed.length})`));
    const list = el("ul");
    for (const f of done.failed.slice(0, 300)) {
      const li = el("li");
      li.append(el("span", "", f.title), el("span", "import-reason", f.reason));
      list.append(li);
    }
    details.append(list);
    box.append(details);
  }
  const row = el("div", "dialog-buttons");
  const closeBtn = el("button", "btn primary", "Готово");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", () => { close(); result = null; });
  row.append(closeBtn);
  box.append(row);
}
