"""Значок Sono в трее (у часов Windows): закрыли окно — музыка играет дальше.

Левый щелчок по значку — открыть окно; правый — меню «Пауза / Следующий / Предыдущий / Открыть / Выход».
Подсказка значка — что сейчас играет. Крестик окна и Alt+F4 прячут окно в трей (настройка
«Закрывать в трей», по умолчанию включена); совсем выйти — «Выход» в меню значка.
Без сторонних библиотек: Shell_NotifyIcon через ctypes, у значка своё скрытое окно и свой поток.
Медиаклавиши работают и со спрятанным окном — их принимает встроенный браузер (см. desktop.py).
"""
import ctypes
import os
import sys
import threading
from ctypes import wintypes

user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32
kernel32 = ctypes.windll.kernel32
LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = LRESULT
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU,
                                   wintypes.HINSTANCE, wintypes.LPVOID]
user32.LoadImageW.restype = wintypes.HANDLE
user32.CreatePopupMenu.restype = wintypes.HMENU
user32.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.LPVOID]
user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]

WM_USER, WM_APP, WM_COMMAND, WM_DESTROY = 0x0400, 0x8000, 0x0111, 0x0002
WM_TRAY = WM_APP + 0x60          # сообщения от значка
WM_TRAY_UPDATE = WM_APP + 0x61   # обновить подсказку (из другого потока)
WM_TRAY_HOTKEYS = WM_APP + 0x62  # включить/выключить глобальные клавиши (wParam 1/0) — в потоке значка
WM_HOTKEY = 0x0312
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.SendMessageW.restype = LRESULT
user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]

# Глобальные клавиши — работают из любой программы, даже когда Sono в трее (настройка, по умолчанию выключена:
# Ctrl+Alt+стрелки заняты в некоторых программах, например в редакторах кода). id → (клавиши, VK, действие)
MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x1, 0x2, 0x4000
HOTKEYS = {
    # Пауза — P, а не пробел: Ctrl+Alt+Пробел часто занят (быстрый ввод разных программ — у автора был занят)
    1: ("Ctrl+Alt+P", 0x50, "toggle"),
    2: ("Ctrl+Alt+→", 0x27, "next"),
    3: ("Ctrl+Alt+←", 0x25, "prev"),
    4: ("Ctrl+Alt+↑", 0x26, "volup"),
    5: ("Ctrl+Alt+↓", 0x28, "voldown"),
    6: ("Ctrl+Alt+L", 0x4C, "like"),
}
WM_LBUTTONUP, WM_RBUTTONUP, WM_LBUTTONDBLCLK = 0x0202, 0x0205, 0x0203
NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO = 1, 2, 4, 0x10
SW_HIDE, SW_SHOW, SW_RESTORE = 0, 5, 9
CMD_TOGGLE, CMD_NEXT, CMD_PREV, CMD_SHOW, CMD_QUIT = 1, 2, 3, 4, 5


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND), ("uID", wintypes.UINT), ("uFlags", wintypes.UINT),
                ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HICON), ("szTip", ctypes.c_wchar * 128),
                ("dwState", wintypes.DWORD), ("dwStateMask", wintypes.DWORD), ("szInfo", ctypes.c_wchar * 256),
                ("uVersion", wintypes.UINT), ("szInfoTitle", ctypes.c_wchar * 64), ("dwInfoFlags", wintypes.DWORD),
                ("guidItem", ctypes.c_byte * 16), ("hBalloonIcon", wintypes.HICON)]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
                ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]


_window = None          # окно pywebview
_main_hwnd = None       # его HWND (titlebar.install знает его раньше всех)
_tray_hwnd = None
_proc = None            # держим ссылку на обработчик — иначе сборщик мусора удалит его
_nid = None
_state = {"tip": "Sono", "playing": False, "close_to_tray": True, "quitting": False,
          "hotkeys": False, "busy": []}   # busy — клавиши, которые уже заняла другая программа


def _icon():
    """Значок программы: в собранной — из самого .exe, из исходников — assets/sono.ico."""
    if getattr(sys, "frozen", False):
        return shell32.ExtractIconW(kernel32.GetModuleHandleW(None), sys.executable, 0)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "sono.ico")
    return user32.LoadImageW(None, path, 1, 0, 0, 0x10 | 0x40)   # IMAGE_ICON, LR_LOADFROMFILE | LR_DEFAULTSIZE


def _page(action: str) -> None:
    """Попросить страницу: пауза, следующий, предыдущий (main.js → window.sonoTray)."""
    if _window:
        threading.Thread(target=lambda: _window.evaluate_js(f"window.sonoTray && window.sonoTray('{action}')"), daemon=True).start()


def show_window() -> None:
    if _main_hwnd:
        user32.ShowWindow(_main_hwnd, SW_RESTORE if user32.IsIconic(_main_hwnd) else SW_SHOW)
        user32.SetForegroundWindow(_main_hwnd)


def _menu() -> None:
    menu = user32.CreatePopupMenu()
    user32.AppendMenuW(menu, 0, CMD_TOGGLE, "Пауза" if _state["playing"] else "Играть")
    user32.AppendMenuW(menu, 0, CMD_NEXT, "Следующий")
    user32.AppendMenuW(menu, 0, CMD_PREV, "Предыдущий")
    user32.AppendMenuW(menu, 0x800, 0, None)   # MF_SEPARATOR
    user32.AppendMenuW(menu, 0, CMD_SHOW, "Открыть Sono")
    user32.AppendMenuW(menu, 0, CMD_QUIT, "Выход")
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    user32.SetForegroundWindow(_tray_hwnd)   # иначе меню не закрывается щелчком мимо
    cmd = user32.TrackPopupMenu(menu, 0x0100 | 0x0020, pt.x, pt.y, 0, _tray_hwnd, None)   # TPM_RETURNCMD | TPM_RIGHTBUTTON
    user32.DestroyMenu(menu)
    {CMD_TOGGLE: lambda: _page("toggle"), CMD_NEXT: lambda: _page("next"), CMD_PREV: lambda: _page("prev"),
     CMD_SHOW: show_window, CMD_QUIT: quit_app}.get(cmd, lambda: None)()


def _wndproc(hwnd, msg, wparam, lparam):
    if msg == WM_TRAY:
        if lparam in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
            show_window()
        elif lparam == WM_RBUTTONUP:
            _menu()
        return 0
    if msg == WM_TRAY_UPDATE and _nid:
        _nid.uFlags = NIF_TIP
        _nid.szTip = _state["tip"][:127]
        shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(_nid))
        return 0
    if msg == WM_TRAY_HOTKEYS:
        # RegisterHotKey привязывает клавиши к окну, поэтому (раз)регистрируем в потоке окна значка
        for hid in HOTKEYS:
            user32.UnregisterHotKey(hwnd, hid)
        busy = []
        if wparam:
            for hid, (label, vk, _action) in HOTKEYS.items():
                if not user32.RegisterHotKey(hwnd, hid, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk):
                    busy.append(label)   # уже заняла другая программа — у неё и останется
        _state["busy"] = busy
        return 0
    if msg == WM_HOTKEY and wparam in HOTKEYS:
        _page(HOTKEYS[wparam][2])
        return 0
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)


def _run() -> None:
    global _tray_hwnd, _proc, _nid
    _proc = WNDPROC(_wndproc)
    wc = WNDCLASSW(lpfnWndProc=_proc, hInstance=kernel32.GetModuleHandleW(None), lpszClassName="SonoTray")
    user32.RegisterClassW(ctypes.byref(wc))
    _tray_hwnd = user32.CreateWindowExW(0, "SonoTray", "Sono tray", 0, 0, 0, 0, 0, None, None, wc.hInstance, None)
    _nid = NOTIFYICONDATAW(cbSize=ctypes.sizeof(NOTIFYICONDATAW), hWnd=_tray_hwnd, uID=1,
                           uFlags=NIF_MESSAGE | NIF_ICON | NIF_TIP, uCallbackMessage=WM_TRAY, hIcon=_icon())
    _nid.szTip = _state["tip"]
    shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(_nid))
    if _state["hotkeys"]:   # страница успела включить клавиши раньше, чем появилось окно значка
        _wndproc(_tray_hwnd, WM_TRAY_HOTKEYS, 1, 0)
    msg = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def remove() -> None:
    if _nid:
        shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(_nid))


def quit_app() -> None:
    """«Выход» в меню значка: закрыть по-настоящему."""
    _state["quitting"] = True
    remove()
    if _window:
        threading.Thread(target=_window.destroy, daemon=True).start()


def _on_closing() -> bool | None:
    """Окно закрывают (крестик, Alt+F4, панель задач). В трей — вместо выхода, если так настроено."""
    if _state["quitting"] or not _state["close_to_tray"] or not _main_hwnd:
        remove()
        return None
    # Без уведомления Windows «Sono продолжает играть» — автор попросил убрать (6 ноября 2026)
    user32.ShowWindow(_main_hwnd, SW_HIDE)
    return False   # отменить закрытие


def install(window, hwnd_getter) -> None:
    """Вызвать до webview.start: значок, перехват закрытия. hwnd_getter() — HWND окна (после показа)."""
    global _window, _main_hwnd
    if sys.platform != "win32" or os.environ.get("SONO_NO_TRAY"):
        return
    _window = window

    def shown():
        global _main_hwnd
        _main_hwnd = hwnd_getter()
    window.events.shown += shown
    window.events.closing += _on_closing
    window.events.closed += remove
    threading.Thread(target=_run, daemon=True, name="tray").start()


def set_status(title: str, playing: bool) -> None:
    """Страница сообщает, что играет: подсказка значка и пункт «Пауза/Играть» в меню."""
    _state["tip"] = f"Sono — {title}" if title else "Sono"
    _state["playing"] = bool(playing)
    if _tray_hwnd:
        user32.PostMessageW(_tray_hwnd, WM_TRAY_UPDATE, 0, 0)


def set_close_to_tray(on: bool) -> None:
    _state["close_to_tray"] = bool(on)


def set_hotkeys(on: bool) -> dict:
    """Глобальные клавиши вкл/выкл. Вернёт {ok, keys: [[клавиши, действие]], busy: [занятые другими]}."""
    _state["hotkeys"] = bool(on)
    keys = [[label, action] for label, _vk, action in HOTKEYS.values()]
    if not _tray_hwnd:   # значок ещё не появился — _run включит клавиши сам, как только появится
        return {"ok": False, "keys": keys, "busy": []}
    user32.SendMessageW(_tray_hwnd, WM_TRAY_HOTKEYS, 1 if on else 0, 0)   # ждёт, пока поток значка выполнит
    return {"ok": True, "keys": keys, "busy": _state["busy"]}
