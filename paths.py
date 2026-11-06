"""Где лежат данные Sono (медиатека, кэш, лог). Отдельно от app.py, чтобы окно (desktop.py)
знало папку сразу — ещё до того, как загрузится тяжёлый сервер (yt-dlp, Flask)."""
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent
# В собранном .exe код распаковывается во временную папку, которая удаляется при выходе.
# Поэтому данные тогда храним в %LOCALAPPDATA%\Sono, а при обычном запуске — рядом с кодом.
if os.environ.get("SONO_DATA_DIR"):
    # Приложение для Android (папка android/) передаёт свою личную папку приложения
    DATA_DIR = Path(os.environ["SONO_DATA_DIR"])
elif getattr(sys, "frozen", False):
    _appdata = Path(os.environ.get("LOCALAPPDATA", Path.home()))
    DATA_DIR = _appdata / "Sono"
    # Раньше программа называлась Player — переносим медиатеку и кэш из старой папки (один раз).
    # Не вышло (файлы чем-то заняты) — продолжаем работать со старой папкой, ничего не теряя.
    if not DATA_DIR.exists() and (_appdata / "Player" / "library.json").exists():
        try:
            os.rename(_appdata / "Player", DATA_DIR)
        except OSError:
            DATA_DIR = _appdata / "Player"
    # Установщик кладёт deno.exe рядом с SonoMusic.exe — добавляем эту папку в PATH,
    # чтобы yt-dlp нашёл deno (без него YouTube не работает), даже если у человека его нет
    os.environ["PATH"] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")
else:
    DATA_DIR = BASE_DIR
DATA_DIR.mkdir(parents=True, exist_ok=True)
