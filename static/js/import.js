// Импорт плейлиста: по ссылке (Spotify, Яндекс Музыка, Apple Music, Deezer, YouTube, SoundCloud)
// или списком треков, вставленным текстом (подходит для VK Музыки и любых других сервисов).
// Окно проходит три состояния: форма → прогресс → результат.
// Импорт идёт на сервере; окно можно закрыть — по окончании придёт уведомление,
// а плейлист появится в медиатеке.

import { sourceIcons } from "./icons.js";
import { createPlaylist, getSetting, setSetting } from "./library.js";
import { decodeShared } from "./share.js";
import { SOURCE_NAMES, el, openModal, plural, toast } from "./ui.js";

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
let mode = "link";     // форма: "link" — по ссылке, "text" — списком

/** onOpen(playlistId) — что делать по кнопке «Открыть плейлист» */
export function openImportDialog({ onOpen } = {}) {
  onOpenPlaylist = onOpen;
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
    box.append(el("p", "", "Вставь ссылку на открытый плейлист или альбом — он появится в медиатеке."));
    const services = el("div", "import-services");
    for (const k of KINDS) {
      const s = el("span", "import-service");
      s.innerHTML = sourceIcons[k.kind];
      s.title = k.name;
      services.append(s);
    }
    box.append(services);
    field = el("input", "dialog-input");
    field.placeholder = "https://music.yandex.ru/users/…/playlists/…";
  } else {
    box.append(el("p", "", "По строке на трек: «Исполнитель — Название». Так можно перенести музыку "
      + "из VK Музыки или любого другого сервиса: скопируй список и вставь сюда."));
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
  field.focus();
}

// ---------- Плейлист, которым поделился друг (код или файл) ----------
// Тут ничего искать не нужно: в коде уже лежат готовые треки — плейлист появляется сразу.

function renderShareForm(box, close) {
  box.append(el("p", "", "Вставь код плейлиста (начинается с «SONO1:») или выбери файл .sono.json, который тебе прислали."));
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
  field.focus();
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
    head.innerHTML = `<span class="import-source">${sourceIcons[job.kind] ?? ""}</span><h2></h2>`;
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
  box.querySelector(".import-head h2").textContent = job.name ? `Импортирую «${job.name}»` : "Читаю плейлист…";
  box.querySelector(".import-count").textContent = total ? `${job.done} из ${plural(total, "трека", "треков", "треков")}` : "Получаю список треков…";
  const searching = job.kind === "text" || KINDS.find((k) => k.kind === job.kind)?.needsMatch;
  box.querySelector(".import-wait").textContent = searching
    ? `Ищу каждый трек ${match === "auto" ? "на SoundCloud и YouTube" : "на " + SOURCE_NAMES[match]} — это займёт немного времени. Окно можно свернуть.`
    : "Окно можно свернуть — импорт продолжится.";
  bar.style.width = `${Math.max(fraction * 100, total ? 2 : 0)}%`;
  bar.parentElement.classList.toggle("indeterminate", !total);
}

// ---------- Результат ----------

function renderResult(box, close) {
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

  const playlist = job.status === "done" && job.tracks.length ? createPlaylist(job.name, job.tracks) : null;
  result = { job, playlist };
  job = null;
  if (!render) {   // окно свернули — сообщаем уведомлением
    if (playlist) toast(`Импорт готов: «${playlist.name}», ${plural(playlist.tracks.length, "трек", "трека", "треков")}`);
    else toast("Импорт не удался: " + (result.job.error || "треки не найдены"), { error: true });
  }
  render?.();
}
