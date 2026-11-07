// Иконки интерфейса (SVG). Цвет берут из CSS через currentColor.

const filled = (body) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;
const outline = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// Залитая версия контурной иконки (сердце «лайкнуто» и т.п.)
const solid = (body) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const HEART = '<path d="M12 20s-7.4-4.5-9.1-9.2C1.8 7.6 3.9 4.5 7.1 4.5c2 0 3.6 1.1 4.9 3 1.3-1.9 2.9-3 4.9-3 3.2 0 5.3 3.1 4.2 6.3C19.4 15.5 12 20 12 20z"/>';
// Палец вниз: кисть и «манжета» — две отдельные фигуры с зазором, чтобы контуры не наезжали друг на друга
const DISLIKE = '<rect x="18" y="4" width="2.5" height="9.5" rx="1"/><path d="M15 4H7.3a2 2 0 0 0-1.95 1.56L3.7 12.1a2 2 0 0 0 1.95 2.4H10l-.85 3.4a1.75 1.75 0 0 0 3.12 1.43L15 14.5z"/>';

export const icons = {
  play: filled('<path d="M8 5.6v12.8a.6.6 0 0 0 .92.5l10.1-6.4a.6.6 0 0 0 0-1L8.92 5.1A.6.6 0 0 0 8 5.6z"/>'),
  pause: filled('<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>'),
  heart: outline(HEART),
  heartFilled: solid(HEART),
  dislike: outline(DISLIKE),
  dislikeFilled: solid(DISLIKE),
  plus: outline('<path d="M12 5v14M5 12h14"/>'),
  more: filled('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'),
  close: outline('<path d="M7 7l10 10M17 7L7 17"/>'),
  back: outline('<path d="M15 5l-7 7 7 7"/>'),
  chevron: outline('<path d="M9 5l7 7-7 7"/>'),
  check: outline('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  trash: outline('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  edit: outline('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>'),
  shuffle: outline('<path d="M16 4h4v4M4 20L20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/>'),
  // Облачко реплики со звёздочкой — «запиканное слово»
  censor: outline('<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M12 8.5v5M9.8 9.8l4.4 2.4M14.2 9.8l-4.4 2.4"/>'),
  image: outline('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8.5 8.5"/>'),
  swap: outline('<path d="M7 4L4 7l3 3M4 7h13M17 20l3-3-3-3M20 17H7"/>'),
  folder: outline('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  sort: outline('<path d="M7 5v14M4 16l3 3 3-3M13 7h7M13 12h5M13 17h3"/>'),
  playNext: outline('<path d="M4 6h12M4 12h12M4 18h7M17 15v6M14 18h6"/>'),
  note: filled('<path d="M9 17.5a2.5 2.5 0 1 1-2-2.45V6l11-2v11.5a2.5 2.5 0 1 1-2-2.45V7.4l-7 1.27v8.83z"/>'),
  nowPlaying: filled('<rect x="4" y="10" width="3" height="10" rx="1"/><rect x="10.5" y="4" width="3" height="16" rx="1"/><rect x="17" y="13" width="3" height="7" rx="1"/>'),
  settings: outline('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1z"/>'),
  share: outline('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>'),
  repeat: outline('<path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-1a5 5 0 0 1 5-5h11"/><path d="M7 21.5l-3-3 3-3"/><path d="M20 12.5v1a5 5 0 0 1-5 5H4"/>'),
  repeatOne: outline('<path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-1a5 5 0 0 1 5-5h11"/><path d="M7 21.5l-3-3 3-3"/><path d="M20 12.5v1a5 5 0 0 1-5 5H4"/><path d="M11 10.5l1.5-1v5.5"/>'),
  queue: outline('<path d="M4 6h12M4 11h12M4 16h7"/><path d="M15.5 13.5v7l5-3.5z" fill="currentColor"/>'),
  download: outline('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>'),
  downloaded: filled('<circle cx="12" cy="12" r="10"/><path d="M12 7v7.5M8.5 11.5 12 15l3.5-3.5" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  import: outline('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>'),
  // Умное перемешивание: перемешать + искорка
  smartShuffle: outline('<path d="M16 4h4v4M4 20L20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/><path d="M6.5 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="currentColor"/>'),
  search: outline('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>'),
  sortList: outline('<path d="M4 7h16M4 12h11M4 17h6"/>'),
  moon: outline('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  clock: outline('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  remove: outline('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  artist: outline('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>'),
  fx: outline('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/><path d="M4 12h5M13 12h7"/><circle cx="11" cy="12" r="2"/>'),
  compass: outline('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  // Палитра художника — темы оформления
  palette: outline('<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'),
  next: filled('<path d="M16 5h2v14h-2zM5 5.5v13a.5.5 0 0 0 .77.42L15 12.4a.5.5 0 0 0 0-.82L5.77 5.08A.5.5 0 0 0 5 5.5z"/>'),
  flow: outline('<path d="M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 3.5-3 5-1.5"/><path d="M2 17c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 7c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/>'),
  album: outline('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>'),
};

export const sourceIcons = {
  yandex: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fc3f1d"/><text x="12" y="16.6" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#fff">Я</text></svg>`,
  apple: `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb5c74"/><stop offset="1" stop-color="#fa233b"/></linearGradient></defs><rect x="2" y="2" width="20" height="20" rx="5.5" fill="url(#ag)"/><path d="M10 15.6a1.9 1.9 0 1 1-1.4-1.83V7.2l7-1.4v8.3a1.9 1.9 0 1 1-1.4-1.83V8.6L10 9.5z" fill="#fff"/></svg>`,
  deezer: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5.5" fill="#a238ff"/><path d="M6 17h2.4M6 14.5h2.4M10.8 17h2.4M10.8 14.5h2.4M10.8 12h2.4M15.6 17H18M15.6 14.5H18M15.6 12H18M15.6 9.5H18M15.6 7H18" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>`,
  spotify: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#1ed760"/><path d="M6.8 9.6c3.6-1.1 7.7-.8 10.6 1M7.4 12.7c2.9-.8 6.2-.5 8.7.9M8 15.6c2.3-.6 4.8-.4 6.8.7" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  youtube: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4.5" fill="#ff0033"/><path d="M10 9.2v5.6l4.8-2.8z" fill="#fff"/></svg>`,
  soundcloud: `<svg viewBox="0 0 24 24" fill="#ff5500" aria-hidden="true"><path d="M1.5 14h1v3h-1zM3.5 12.5h1V17h-1zM5.5 11.5h1V17h-1zM7.5 10.5h1V17h-1zM9.5 9h1v8h-1z"/><path d="M11.5 8.3a5 5 0 0 1 2.6-.7c2.6 0 4.7 1.9 5 4.4a2.6 2.6 0 0 1 3.4 2.5c0 1.4-1.2 2.5-2.6 2.5h-8.4z"/></svg>`,
};
