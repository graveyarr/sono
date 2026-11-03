"""Собирает программу и установщик.

Запуск:  python build.py

1. PyInstaller собирает папку dist/SonoMusic/ (SonoMusic.exe и всё, что ему нужно).
2. Рядом кладётся deno.exe — без него yt-dlp не может открыть YouTube.
3. Inno Setup упаковывает папку в один файл dist/SonoSetup-<версия>.exe —
   его и можно отдавать людям: «Далее → Далее → Готово», без консоли.

Нужно для сборки (людям, которые ставят программу, — не нужно):
  pip install pyinstaller
  winget install DenoLand.Deno
  winget install JRSoftware.InnoSetup
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import PyInstaller.__main__

VERSION = "0.6.5"
ROOT = Path(__file__).parent
DIST = ROOT / "dist"
# Файл программы — НЕ Sono.exe: в списке игр Discord есть игра «Sono» с правилом «sono/sono.exe»,
# и Discord показывал «Играет в Sono» с чужой обложкой (наша папка — Programs\Sono). Имя в окне,
# «Пуске» и диспетчере задач всё равно «Sono» (заголовок окна, ярлык, описание файла ниже).
EXE = "SonoMusic"

# Описание файла: его показывают диспетчер задач и «Свойства» — там будет «Sono», а не имя файла
nums = tuple(int(x) for x in VERSION.split(".")) + (0,)
(ROOT / "build").mkdir(exist_ok=True)
VERSION_FILE = ROOT / "build" / "version_info.txt"
VERSION_FILE.write_text(f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={nums}, prodvers={nums}, mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('041904B0', [
      StringStruct('CompanyName', 'Sono'),
      StringStruct('FileDescription', 'Sono'),
      StringStruct('FileVersion', '{VERSION}'),
      StringStruct('InternalName', 'Sono'),
      StringStruct('OriginalFilename', '{EXE}.exe'),
      StringStruct('ProductName', 'Sono'),
      StringStruct('ProductVersion', '{VERSION}')])]),
    VarFileInfo([VarStruct('Translation', [0x0419, 1200])])
  ]
)
""", encoding="utf-8")

# Какие версии yt-dlp и yt-dlp-ejs зашиты в установщик — по ним updater.py решает, новее ли скачанное
import importlib.metadata as md   # noqa: E402
BUNDLED = ROOT / "build" / "bundled_versions.json"
BUNDLED.write_text(json.dumps({"yt_dlp": md.version("yt-dlp"), "yt_dlp_ejs": md.version("yt-dlp-ejs"),
                               "app": VERSION}), encoding="utf-8")   # app — по ней appupdate.py сравнивает с GitHub

# 1. Программа — папкой (запускается быстрее, чем один большой .exe, который распаковывается при каждом старте)
PyInstaller.__main__.run([
    str(ROOT / "desktop.py"),
    "--name", EXE,
    "--version-file", str(VERSION_FILE),
    "--onedir",
    "--windowed",       # без чёрного окна консоли
    "--noconfirm",      # перезаписывать прошлую сборку без вопросов
    "--icon", str(ROOT / "assets" / "sono.ico"),
    "--add-data", f"{ROOT / 'static'}{os.pathsep}static",   # страницу кладём внутрь
    "--add-data", f"{BUNDLED}{os.pathsep}.",
    "--collect-data", "yt_dlp_ejs",                          # JS-файлы, которыми yt-dlp разбирает YouTube
    # SOCKS-прокси (режим «Свой прокси») requests подключает «на лету» — сборщик сам его не заметит
    "--hidden-import", "socks", "--hidden-import", "urllib3.contrib.socks",
    "--distpath", str(DIST),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
])

# 2. deno.exe рядом с программой
deno = shutil.which("deno")
if not deno:
    raise SystemExit("Не нашёл deno — поставь его: winget install DenoLand.Deno")
shutil.copy2(deno, DIST / EXE / "deno.exe")
shutil.copy2(ROOT / "assets" / "THIRD-PARTY-NOTICES.txt", DIST / EXE)   # лицензии того, что внутри
print(f"[build] deno: {deno}")

# 3. Установщик
iscc_places = [Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Inno Setup 6/ISCC.exe",
               Path(os.environ.get("ProgramFiles(x86)", "")) / "Inno Setup 6/ISCC.exe",
               Path(os.environ.get("ProgramFiles", "")) / "Inno Setup 6/ISCC.exe"]
iscc = next((p for p in iscc_places if p.exists()), None)
if not iscc:
    raise SystemExit("Не нашёл Inno Setup — поставь его: winget install JRSoftware.InnoSetup")
subprocess.run([str(iscc), f"/DMyAppVersion={VERSION}", f"/DMyAppExeName={EXE}", str(ROOT / "installer.iss")], check=True)
setup = DIST / f"SonoSetup-{VERSION}.exe"
# Контрольная сумма рядом — её тоже выкладываем в выпуск на GitHub: по ней автообновление
# проверяет скачанное, даже когда API GitHub недоступен (appupdate.py → _latest_from_web)
import hashlib   # noqa: E402
(DIST / f"{setup.name}.sha256").write_text(f"{hashlib.sha256(setup.read_bytes()).hexdigest()}  {setup.name}\n", encoding="utf-8")
print(f"[build] готово: {setup} (+ .sha256 — выложить в выпуск вместе с ним)")
