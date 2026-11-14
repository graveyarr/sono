// На чём открыт Sono. Модуль без импортов — его можно брать в любом другом, не боясь круговых импортов.

/** Телефон: приложение для Android (MainActivity.kt) дописывает «SonoAndroid» к имени браузера;
    ?mobile в адресе — посмотреть вид телефона на компьютере */
export const isMobile = /SonoAndroid/.test(navigator.userAgent) || new URLSearchParams(location.search).has("mobile");

/** Мост в приложение Android (MainActivity.Bridge): шторка, ссылки, «Поделиться». На компьютере — null */
export const android = window.SonoAndroid ?? null;

/** Открыть сайт через сервер (/api/open-link/…, /api/open-releases). На компьютере браузер открывает сам сервер,
    на телефоне он не может — присылает адрес, и его открывает приложение. true — получилось */
export async function openExternal(apiPath) {
  const res = await fetch(apiPath, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.url && android?.openUrl) android.openUrl(data.url);
  return res.ok;
}

/** Телефон: файл, который сервер только что положил в папку экспорта, — в системное «Поделиться»
    (Telegram, Диск, «Файлы»…). title — заголовок окна выбора */
export function shareFile(name, title) {
  android?.shareFile?.(name, title);
}
