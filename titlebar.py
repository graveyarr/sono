"""Своя полоска заголовка окна вместо системной (только Windows).

Системную полоску убираем, но окно остаётся обычным окном Windows: тянется за края,
прилипает к краям экрана (Aero Snap), сворачивается с анимацией, у него тень и скруглённые углы.
Для этого перехватываем сообщение WM_NCCALCSIZE (Windows спрашивает, где внутри окна «содержимое»)
и говорим, что содержимое начинается с самого верха — заголовка не остаётся. Левый, правый и нижний
края остаются системными — за них окно тянется как обычно.

Свою полоску рисует страница (static/js/titlebar.js). Перетаскивание, кнопки и верхний край —
через WindowApi: страница зовёт его методы (window.pywebview.api.*), а мы передаём окну те же
сообщения, что послала бы ему системная полоска (WM_NCLBUTTONDOWN, WM_SYSCOMMAND).
"""
import ctypes
import os
import sys
import threading
from ctypes import wintypes

if sys.platform == "win32":
    user32 = ctypes.windll.user32
    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    user32.GetWindowLongPtrW.restype = ctypes.c_void_p
    user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetWindowLongPtrW.restype = ctypes.c_void_p
    user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
    user32.CallWindowProcW.restype = LRESULT
    user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.SendMessageW.restype = LRESULT
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.MonitorFromWindow.restype = ctypes.c_void_p
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]

WM_NCCALCSIZE = 0x0083
WM_NCLBUTTONDOWN = 0x00A1
WM_SYSCOMMAND = 0x0112
GWLP_WNDPROC = -4
SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE, SC_CLOSE = 0xF020, 0xF030, 0xF120, 0xF060
HT = {"caption": 2, "top": 12, "topleft": 13, "topright": 14}
SWP_FRAMECHANGED = 0x0020 | 0x0001 | 0x0002 | 0x0004   # + не двигать, не менять размер, не трогать порядок


class NCCALCSIZE_PARAMS(ctypes.Structure):
    _fields_ = [("rgrc", wintypes.RECT * 3), ("lppos", ctypes.c_void_p)]


class WINDOWPOS(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("after", wintypes.HWND), ("x", ctypes.c_int), ("y", ctypes.c_int),
                ("cx", ctypes.c_int), ("cy", ctypes.c_int), ("flags", wintypes.UINT)]


WM_SIZE, WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED, WM_ENTERSIZEMOVE = 0x0005, 0x0046, 0x0047, 0x0231
SWP_NOSIZE = 0x0001
# Своё сообщение «начни тянуть»: страница зовёт Python из стороннего потока, а отпустить мышь у встроенного
# браузера (ReleaseCapture) может только поток самого окна — поэтому передаём команду ему (была ошибка:
# окно не тащилось). wParam — что тянем: заголовок или край (HT…)
WM_SONO_DRAG = 0x8000 + 0x51
# Мини-плеер: окно сжимается в маленькую плашку поверх всех окон (wParam 1 — включить, 0 — вернуть)
WM_SONO_MINI = 0x8000 + 0x52
WM_GETMINMAXINFO = 0x0024
MINI_SIZE = (400, 132)       # в «пикселях страницы» — умножаем на масштаб экрана
HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
SW_RESTORE = 9


class MINMAXINFO(ctypes.Structure):
    _fields_ = [("reserved", wintypes.POINT), ("max_size", wintypes.POINT), ("max_pos", wintypes.POINT),
                ("min_track", wintypes.POINT), ("max_track", wintypes.POINT)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD)]


_mini = False
_before_mini = None   # (x, y, ширина, высота) обычного окна — вернуть после мини-плеера
_mini_pos = None      # где мини-плеер стоял в прошлый раз (его могли перетащить)

_hwnd = None
_old_proc = None
_new_proc = None   # держим ссылку, иначе сборщик мусора удалит обработчик, и окно упадёт
# WinForms (на нём pywebview строит окно) после «развернуть → вернуть» восстанавливает размер содержимого
# и прибавляет высоту системного заголовка, которого у нас нет: окно росло на 31 px за каждый раз.
# Помним обычный размер окна и после возврата не даём его увеличить
_normal = None       # (ширина, высота) в обычном состоянии
_restoring = False   # окно было развёрнуто/свёрнуто — следующая подгонка размера может быть лишней


def _proc(hwnd, msg, wparam, lparam):
    global _normal, _restoring
    if msg == WM_SONO_DRAG:
        # Мы в потоке окна: забираем мышь у встроенного браузера и говорим окну «нажали на заголовок/край»
        # в той точке, где сейчас курсор, — дальше Windows сама ведёт окно (с прилипанием к краям экрана)
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        user32.ReleaseCapture()
        user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, wparam, (pt.y & 0xFFFF) << 16 | (pt.x & 0xFFFF))
        return 0
    if msg == WM_SONO_MINI:
        _set_mini(hwnd, bool(wparam))
        return 0
    if msg == WM_GETMINMAXINFO and _mini:
        # Обычное окно не даёт сжать себя меньше 860×600 — мини-плееру можно
        result = user32.CallWindowProcW(_old_proc, hwnd, msg, wparam, lparam)
        info = ctypes.cast(lparam, ctypes.POINTER(MINMAXINFO)).contents
        scale = _scale(hwnd)
        info.min_track.x, info.min_track.y = int(300 * scale), int(100 * scale)
        return result
    if msg == WM_SIZE and wparam in (1, 2):   # свернули / развернули
        _restoring = True
    elif msg == WM_ENTERSIZEMOVE:              # человек сам тянет за край — его размер не трогаем
        _restoring = False
    elif msg == WM_WINDOWPOSCHANGING and _restoring and _normal:
        pos = ctypes.cast(lparam, ctypes.POINTER(WINDOWPOS)).contents
        if not pos.flags & SWP_NOSIZE and pos.cx == _normal[0] and pos.cy > _normal[1] \
                and not user32.IsZoomed(hwnd) and not user32.IsIconic(hwnd):
            pos.cy = _normal[1]
    elif msg == WM_WINDOWPOSCHANGED and not user32.IsZoomed(hwnd) and not user32.IsIconic(hwnd):
        pos = ctypes.cast(lparam, ctypes.POINTER(WINDOWPOS)).contents
        if not pos.flags & SWP_NOSIZE and not _restoring and not _mini:
            _normal = (pos.cx, pos.cy)
    if msg == WM_NCCALCSIZE and wparam:
        params = ctypes.cast(lparam, ctypes.POINTER(NCCALCSIZE_PARAMS)).contents
        top, left = params.rgrc[0].top, params.rgrc[0].left
        result = user32.CallWindowProcW(_old_proc, hwnd, msg, wparam, lparam)   # Windows считает рамки как обычно
        # …а сверху ни заголовка, ни рамки. У развёрнутого окна края уходят за экран на толщину рамки —
        # сверху её оставляем, иначе полоска уедет за край монитора
        params.rgrc[0].top = top + (params.rgrc[0].left - left if user32.IsZoomed(hwnd) else 0)
        return result
    return user32.CallWindowProcW(_old_proc, hwnd, msg, wparam, lparam)


def _scale(hwnd) -> float:
    try:
        return (user32.GetDpiForWindow(hwnd) or 96) / 96
    except Exception:
        return 1.0


def _rect(hwnd) -> tuple[int, int, int, int]:
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def _set_mini(hwnd, on: bool) -> None:
    """Мы в потоке окна. Включить: запомнить обычное окно, сжать в плашку в правом нижнем углу экрана
    (или туда, где она стояла в прошлый раз) и поставить поверх всех окон. Выключить: всё вернуть."""
    global _mini, _before_mini, _mini_pos, _restoring
    if on == _mini:
        return
    if on:
        if user32.IsZoomed(hwnd) or user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        _before_mini = _rect(hwnd)
        _mini = True
        scale = _scale(hwnd)
        w, h = int(MINI_SIZE[0] * scale), int(MINI_SIZE[1] * scale)
        mon = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
        user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(mon))   # MONITOR_DEFAULTTONEAREST
        work, margin = mon.rcWork, int(20 * scale)
        x, y = _mini_pos or (work.right - w - margin, work.bottom - h - margin)
        x = max(work.left, min(x, work.right - w))   # прошлое место за пределами экрана (сменился монитор) — подвинуть
        y = max(work.top, min(y, work.bottom - h))
        user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, 0x0040)   # SWP_SHOWWINDOW
    else:
        _mini_pos = _rect(hwnd)[:2]
        _mini = False
        _restoring = False
        x, y, w, h = _before_mini or (100, 100, 1100, 760)
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, x, y, w, h, 0x0040)


def install(window) -> bool:
    """Вызывать в window.events.before_show (это поток окна, ещё до показа — без мелькания)."""
    global _hwnd, _old_proc, _new_proc
    if sys.platform != "win32" or os.environ.get("SONO_NATIVE_TITLEBAR"):
        return False
    try:
        _hwnd = int(window.native.Handle.ToInt64())
        _new_proc = WNDPROC(_proc)
        _old_proc = user32.SetWindowLongPtrW(_hwnd, GWLP_WNDPROC, ctypes.cast(_new_proc, ctypes.c_void_p))
        user32.SetWindowPos(_hwnd, None, 0, 0, 0, 0, SWP_FRAMECHANGED)   # пересчитать рамки сейчас
        rect = wintypes.RECT()
        user32.GetWindowRect(_hwnd, ctypes.byref(rect))
        global _normal
        _normal = (rect.right - rect.left, rect.bottom - rect.top)
        return True
    except Exception as e:   # что-то пошло не так — остаётся обычная системная полоска
        print(f"[titlebar] не получилось убрать системный заголовок: {e}")
        _hwnd = None
        return False


class WindowApi:
    """Методы, которые страница вызывает через window.pywebview.api (кнопки своей полоски)."""

    def custom_titlebar(self):
        return _hwnd is not None

    def drag(self):
        """Начать перетаскивание окна — как если бы схватили системный заголовок (с прилипанием к краям)."""
        if _hwnd:
            user32.PostMessageW(_hwnd, WM_SONO_DRAG, HT["caption"], 0)

    def resize(self, edge):
        """Тянуть за верхний край / верхние углы (остальные края системные)."""
        if _hwnd and edge in HT:
            user32.PostMessageW(_hwnd, WM_SONO_DRAG, HT[edge], 0)

    def minimize(self):
        if _hwnd:
            user32.PostMessageW(_hwnd, WM_SYSCOMMAND, SC_MINIMIZE, 0)

    def toggle_maximize(self):
        if _hwnd:
            user32.PostMessageW(_hwnd, WM_SYSCOMMAND, SC_RESTORE if user32.IsZoomed(_hwnd) else SC_MAXIMIZE, 0)

    def is_maximized(self):
        return bool(_hwnd and user32.IsZoomed(_hwnd))

    def set_mini(self, on):
        """Мини-плеер: маленькое окно поверх остальных (static/js/compact.js). True — сжать, False — вернуть."""
        if _hwnd:
            user32.PostMessageW(_hwnd, WM_SONO_MINI, 1 if on else 0, 0)
        return bool(_hwnd)

    def is_mini(self):
        return _mini

    def tray_status(self, title, playing):
        """Что играет — для подсказки значка в трее и пункта «Пауза/Играть» в его меню."""
        import tray
        tray.set_status(str(title or "")[:120], bool(playing))

    def set_close_to_tray(self, on):
        """Настройка «Закрывать в трей»: крестик прячет окно, музыка играет дальше."""
        import tray
        tray.set_close_to_tray(bool(on))

    def pick_folder(self):
        """Окно Windows «Выбор папки» — для «Мои файлы» в настройках. Возвращает путь или None."""
        import webview
        if not webview.windows:
            return None
        kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or webview.FOLDER_DIALOG
        picked = webview.windows[0].create_file_dialog(kind)
        return picked[0] if picked else None

    def close(self):
        # Чуть позже: сначала pywebview должен вернуть странице ответ на этот вызов —
        # если окно закроется раньше, .NET падает с ошибкой на выходе (было в проверке)
        if _hwnd:
            threading.Timer(0.15, user32.PostMessageW, (_hwnd, WM_SYSCOMMAND, SC_CLOSE, 0)).start()
