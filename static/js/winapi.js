// Функции окна программы (window.pywebview.api: своя полоска заголовка, мини-плеер, трей, клавиши).
// pywebview подключает их к странице в два шага: сначала пустой объект window.pywebview.api, потом —
// отдельно — сами функции и событие pywebviewready. Если проверить «api есть?» между шагами, объект
// уже есть, а функций ещё нет: полоска заголовка не появлялась, хотя системную Sono уже убрал.
// Поэтому «готово» — только когда в api уже есть функции. Модуль без импортов (нет круговых ссылок).

const ready = () => {
  const api = window.pywebview?.api;
  return !!api && Object.keys(api).length > 0;
};

/** Вызвать fn, когда функции окна готовы. В браузере (python app.py) их нет — fn не вызовется. */
export function whenWindowApi(fn) {
  if (ready()) fn();
  else addEventListener("pywebviewready", () => fn(), { once: true });
}
