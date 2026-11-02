"""Автонастройка zapret, который у человека уже стоит (сборка Flowseal «zapret-discord-youtube»).

Что делаем:
1. Ищем папку zapret: по службе Windows «zapret» (реестр) и в обычных местах (рабочий стол, «Загрузки», корни дисков).
2. Добавляем домены SoundCloud (и YouTube, если их нет) в пользовательский список — без них стратегии
   zapret на эти сайты не действуют.
3. Подбираем стратегию: по очереди запускаем каждую general*.bat-стратегию (winws.exe с её параметрами)
   и меряем, как с ней качается звук с YouTube и SoundCloud. Лучшую ставим службой Windows — как это
   делает service.bat самой сборки (служба «zapret», в реестре — имя стратегии).

Для winws нужны права администратора, поэтому замер и установка — в отдельном скрипте PowerShell,
который запускается с запросом прав (UAC). Скрипт пишет ход работы в progress.json, а выбор лучшей
стратегии делает Python (choose_best) и кладёт в decision.json — скрипт его ждёт.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import string
import subprocess
import sys
import threading
import time
from pathlib import Path

# Домены, которые плееру нужны «через zapret». Поддомены zapret учитывает сам.
SOUNDCLOUD_DOMAINS = ["soundcloud.com", "sndcdn.com", "soundcloud.cloud"]
YOUTUBE_DOMAINS = ["googlevideo.com", "youtube.com", "youtu.be", "ytimg.com", "ggpht.com", "youtubei.googleapis.com"]
MARK = "# Добавлено плеером Sono (YouTube и SoundCloud)"

NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

WORK_DIR: Path | None = None    # сюда — скрипт, параметры и ход работы (задаёт init)
_lock = threading.Lock()
_watcher: threading.Thread | None = None


def init(data_dir: Path) -> None:
    global WORK_DIR
    WORK_DIR = data_dir / "zapret"


# ---------- Поиск ----------

def _service_info() -> dict:
    """Служба «zapret»: путь к winws из реестра, имя стратегии, запущена ли."""
    info = {"installed": False, "running": False, "strategy": None, "exe": None}
    if sys.platform != "win32":
        return info
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Services\zapret") as key:
            image = winreg.QueryValueEx(key, "ImagePath")[0]
            info["installed"] = True
            m = re.match(r'\s*"([^"]+winws\.exe)"', image, re.I) or re.match(r"\s*(\S+winws\.exe)", image, re.I)
            info["exe"] = m.group(1) if m else None
            try:
                info["strategy"] = winreg.QueryValueEx(key, "zapret-discord-youtube")[0]
            except OSError:
                pass
    except OSError:
        return info
    try:
        out = subprocess.run(["sc", "query", "zapret"], capture_output=True, text=True, timeout=5,
                             creationflags=NO_WINDOW).stdout
        info["running"] = "RUNNING" in out
    except Exception:
        pass
    return info


def _winws_running() -> bool:
    if sys.platform != "win32":
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq winws.exe", "/NH"], capture_output=True,
                             text=True, timeout=5, creationflags=NO_WINDOW).stdout
        return "winws.exe" in out.lower()
    except Exception:
        return False


def _looks_like_zapret(folder: Path) -> bool:
    return (folder / "bin" / "winws.exe").is_file()


def _search_roots() -> list[tuple[Path, int]]:
    """Где искать и на какую глубину."""
    home = Path.home()
    roots = [(home / name, 3) for name in ("Desktop", "Downloads", "Documents", "OneDrive", "Рабочий стол")]
    roots.append((home, 1))
    for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        if os.environ.get(env):
            roots.append((Path(os.environ[env]), 1))
    if sys.platform == "win32":
        mask = ctypes.windll.kernel32.GetLogicalDrives()
        for i, letter in enumerate(string.ascii_uppercase):
            if mask & (1 << i) and letter not in "AB":
                roots.append((Path(f"{letter}:\\"), 2))
    return roots


SKIP = {"windows", "$recycle.bin", "system volume information", "node_modules", ".git", "appdata",
        "programdata", "cache", "steamapps", "__pycache__", "venv", ".venv"}


def _scan(limit_dirs: int = 6000, limit_time: float = 6.0) -> list[Path]:
    found, seen, visited = [], set(), 0
    started = time.time()
    for root, depth in _search_roots():
        stack = [(root, 0)]
        while stack:
            folder, level = stack.pop()
            if visited > limit_dirs or time.time() - started > limit_time:
                return found
            visited += 1
            try:
                if _looks_like_zapret(folder):
                    key = str(folder.resolve()).lower()
                    if key not in seen:
                        seen.add(key)
                        found.append(folder)
                    continue
                if level >= depth:
                    continue
                with os.scandir(folder) as entries:
                    for e in entries:
                        if e.is_dir(follow_symlinks=False) and e.name.lower() not in SKIP and not e.name.startswith("."):
                            stack.append((Path(e.path), level + 1))
            except OSError:
                continue
    return found


def strategies(root: Path) -> list[Path]:
    """Стратегии сборки Flowseal: все .bat в корне, кроме service*.bat — по номерам, как в service.bat."""
    bats = [p for p in root.glob("*.bat") if not p.name.lower().startswith("service")]
    natural = lambda p: re.sub(r"\d+", lambda m: m.group().zfill(8), p.name.lower())
    return sorted((p for p in bats if "winws.exe" in _read(p).lower()), key=natural)


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _version(root: Path) -> str | None:
    m = re.search(r'LOCAL_VERSION=([\w.]+)', _read(root / "service.bat"))
    return m.group(1) if m else None


def describe(root: Path) -> dict:
    """Всё, что показываем человеку о найденном zapret."""
    service = _service_info()
    lists = root / "lists"
    all_lists = " ".join(_read(p).lower() for p in lists.glob("*.txt")) if lists.is_dir() else ""
    bats = strategies(root)
    service_here = bool(service["exe"]) and Path(service["exe"]).resolve().parent.parent == root.resolve()
    return {
        "path": str(root),
        "flowseal": (root / "service.bat").is_file() and bool(bats),
        "version": _version(root),
        "strategies": [p.stem for p in bats],
        "service": {**service, "here": service_here},
        "running": service["running"] or _winws_running(),
        "covers": {"youtube": "googlevideo.com" in all_lists, "soundcloud": "sndcdn.com" in all_lists},
    }


def find(extra: str | None = None) -> list[dict]:
    """Найденные папки zapret: сначала та, что стоит службой, потом остальные."""
    candidates: list[Path] = []
    if extra:
        p = Path(extra.strip().strip('"'))
        if p.name.lower() == "bin":
            p = p.parent
        if p.is_file():
            p = p.parent.parent if p.parent.name.lower() == "bin" else p.parent
        if not _looks_like_zapret(p):
            raise LookupError("В этой папке нет zapret (не нашёл bin\\winws.exe)")
        candidates.append(p)
    exe = _service_info()["exe"]
    if exe and Path(exe).is_file():
        candidates.append(Path(exe).parent.parent)
    candidates += _scan()
    unique, seen = [], set()
    for p in candidates:
        key = str(p.resolve()).lower()
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return [describe(p) for p in unique]


# ---------- Списки доменов ----------

def plan_domains(root: Path) -> tuple[Path, list[str]]:
    """Куда и какие домены дописать. Новые сборки читают list-general-user.txt (его не трогают обновления),
    старые — только list-general.txt."""
    lists = root / "lists"
    all_lists = " ".join(_read(p).lower() for p in lists.glob("*.txt"))
    need = [d for d in SOUNDCLOUD_DOMAINS if d not in all_lists]
    if "googlevideo.com" not in all_lists:
        need += [d for d in YOUTUBE_DOMAINS if d not in all_lists]
    uses_user_list = any("list-general-user.txt" in _read(b) for b in strategies(root))
    target = lists / ("list-general-user.txt" if uses_user_list else "list-general.txt")
    return target, need


def add_domains(root: Path) -> list[str]:
    """Дописывает недостающие домены. Возвращает, что добавили. PermissionError — нужна запись с правами админа."""
    target, need = plan_domains(root)
    if not need:
        return []
    old = _read(target) if target.exists() else ""
    if target.exists() and target.name == "list-general.txt":
        backup = target.with_name("list-general.txt.sono-backup")
        # .player-backup — копия, сделанная до переименования программы: она уже исходная, вторая не нужна
        if not backup.exists() and not target.with_name("list-general.txt.player-backup").exists():
            backup.write_text(old, encoding="utf-8")
    if not old and target.name == "list-general-user.txt":
        old = "# Never leave this file empty\n"   # так файл создаёт сама сборка
    text = old.rstrip("\r\n") + ("\n" if old.strip() else "") + MARK + "\n" + "\n".join(need) + "\n"
    target.write_text(text, encoding="utf-8")
    return need


# ---------- Параметры стратегии ----------

def _game_filter(root: Path) -> tuple[str, str]:
    """Порты «игрового фильтра» — как в service.bat (:game_switch_status). Выключен — «12» (пустышка)."""
    tcp_range = udp_range = "1024-65535"
    mode = "disabled"
    flag = root / "utils" / "game_filter.enabled"
    if not flag.exists():
        return "12", "12"
    for line in _read(flag).splitlines():
        k, _, v = line.strip().partition("=")
        k = k.lower()
        if k == "mode":
            mode = v.strip() or mode
        elif k == "all":
            mode = "all"
        elif k in ("tcp", "udp"):
            if not v.strip():
                mode = k
            elif re.fullmatch(r"\d{1,5}(-\d{1,5})?", v.strip()):
                if k == "tcp":
                    tcp_range = v.strip()
                else:
                    udp_range = v.strip()
    mode = mode.lower()
    if mode == "all":
        return tcp_range, udp_range
    if mode == "tcp":
        return tcp_range, "12"
    if mode == "udp":
        return "12", udp_range
    return "12", "12"


def strategy_args(root: Path, bat: Path) -> str:
    """Строка параметров winws.exe из .bat-стратегии (то же, что делает service.bat при установке службы)."""
    lines = _read(bat).splitlines()
    start = next((i for i, l in enumerate(lines) if "winws.exe" in l.lower()), None)
    if start is None:
        raise ValueError("нет строки с winws.exe")
    parts = []
    for line in lines[start:]:
        s = line.strip()
        more = s.endswith("^")
        parts.append(s[:-1].rstrip() if more else s)
        if not more:
            break
    command = " ".join(parts)
    command = re.split(r'winws\.exe"?', command, maxsplit=1, flags=re.I)[1]
    tcp, udp = _game_filter(root)
    subs = {"%BIN%": f"{root}\\bin\\", "%LISTS%": f"{root}\\lists\\", "%~dp0": f"{root}\\",
            "%GameFilterTCP%": tcp, "%GameFilterUDP%": udp, "%GameFilter%": tcp if tcp != "12" else udp}
    for k, v in subs.items():
        command = re.sub(re.escape(k), lambda _m, v=v: v, command, flags=re.I)
    command = command.replace("^!", "!")
    if re.search(r"%\w+%", command):
        raise ValueError("непонятная переменная " + re.search(r"%\w+%", command).group())
    return command.strip()


# ---------- Подбор стратегии и установка (с правами администратора) ----------

PS_SCRIPT = r"""
# Подбор стратегии zapret для плеера Sono. Запускается с правами администратора.
$ErrorActionPreference = 'Continue'
$work = $PSScriptRoot
$p = Get-Content -Raw -Encoding UTF8 (Join-Path $work 'params.json') | ConvertFrom-Json
$progressFile = Join-Path $work 'progress.json'
$decisionFile = Join-Path $work 'decision.json'
$state = [ordered]@{ state = 'starting'; total = $p.strategies.Count; done = 0; current = ''; results = @(); baseline = $null; installed = $null; error = $null }
function Save { [IO.File]::WriteAllText($progressFile, ($state | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false)) }

function Measure-Url($url, $maxTime) {
  $out = & curl.exe -s -o NUL -r 0-2097151 -m $maxTime -w '%{http_code} %{size_download} %{time_total}' $url 2>$null
  $f = "$out".Trim() -split ' '
  if ($f.Count -lt 3) { return @{ code = 0; bytes = 0; time = $maxTime } }
  return @{ code = [int]$f[0]; bytes = [double]$f[1]; time = [double]::Parse($f[2], [Globalization.CultureInfo]::InvariantCulture) }
}
function Measure-All {
  $yt = Measure-Url $p.youtube 7
  $ytSpeed = if (($yt.code -in @(200, 206)) -and ($yt.time -gt 0)) { [math]::Round($yt.bytes / $yt.time / 1048576, 2) } else { 0 }
  $scBytes = 0; $scTime = 0; $scOk = $true
  foreach ($u in $p.soundcloud) {
    $r = Measure-Url $u 4
    $scBytes += $r.bytes; $scTime += $r.time
    if ($r.code -notin @(200, 206)) { $scOk = $false }
  }
  $scSpeed = if ($scOk -and ($scTime -gt 0)) { [math]::Round($scBytes / $scTime / 1048576, 2) } else { 0 }
  $dc = Measure-Url 'https://discord.com' 4
  return [ordered]@{ youtube = $ytSpeed; soundcloud = $scSpeed; discord = (($dc.code -gt 0) -and ($dc.code -lt 500)) }
}
function Stop-Winws { Get-Process winws -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700 }

try {
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'В системе нет curl.exe (нужна Windows 10 1803 или новее)' }
  # Домены, которые плеер не смог дописать сам (папка защищена от записи)
  if ($p.append) { Add-Content -LiteralPath $p.append.path -Value $p.append.lines -Encoding UTF8 }

  # Что было до нас: служба или запущенный вручную winws — чтобы вернуть, если ничего не подойдёт
  $svc = Get-Service zapret -ErrorAction SilentlyContinue
  $hadService = [bool]$svc
  $wasRunning = $svc -and $svc.Status -eq 'Running'
  $manual = Get-CimInstance Win32_Process -Filter "Name='winws.exe'" | Select-Object -First 1 ExecutablePath, CommandLine
  if ($hadService) { Stop-Service zapret -Force -ErrorAction SilentlyContinue }
  Stop-Winws

  $state.state = 'testing'; $state.current = 'без zapret'; Save
  $state.baseline = Measure-All; Save
  foreach ($s in $p.strategies) {
    $state.current = $s.name; Save
    Start-Process -FilePath $p.exe -ArgumentList $s.args -WorkingDirectory (Split-Path $p.exe) -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 2
    $m = Measure-All
    $m.name = $s.name
    $state.results += $m
    $state.done += 1
    Stop-Winws
    Save
  }

  # Выбор делает плеер (decision.json); ждём до 2 минут
  $state.state = 'tested'; $state.current = ''; Save
  $decision = $null
  for ($i = 0; $i -lt 240 -and -not $decision; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $decisionFile) { $decision = Get-Content -Raw -Encoding UTF8 $decisionFile | ConvertFrom-Json }
  }
  $choice = if ($decision) { $decision.install } else { $null }

  if ($choice) {
    $state.state = 'installing'; Save
    $s = $p.strategies | Where-Object { $_.name -eq $choice } | Select-Object -First 1
    if ($hadService) { & sc.exe delete zapret | Out-Null; Start-Sleep -Seconds 1 }
    New-Service -Name zapret -BinaryPathName ('"' + $p.exe + '" ' + $s.args) -DisplayName 'zapret' -StartupType Automatic -Description 'Zapret DPI bypass software' | Out-Null
    New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\zapret' -Name 'zapret-discord-youtube' -Value $choice -PropertyType String -Force | Out-Null
    Start-Service zapret
    $state.installed = $choice
  } else {
    # Ничего не подошло (или человек закрыл плеер) — возвращаем как было
    if ($wasRunning) { Start-Service zapret -ErrorAction SilentlyContinue }
    elseif ($manual -and $manual.ExecutablePath) {
      $rest = ($manual.CommandLine -replace '^\s*("[^"]*"|\S+)\s*', '')
      Start-Process -FilePath $manual.ExecutablePath -ArgumentList $rest -WorkingDirectory (Split-Path $manual.ExecutablePath) -WindowStyle Hidden | Out-Null
    }
  }
  $state.state = 'done'; Save
} catch {
  $state.state = 'error'; $state.error = "$_"; Save
  if ($wasRunning) { Start-Service zapret -ErrorAction SilentlyContinue }
}
"""


def _write_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def progress() -> dict:
    try:
        text = (WORK_DIR / "progress.json").read_text(encoding="utf-8-sig")
        return json.loads(text)
    except (OSError, ValueError):
        return {"state": "idle"}


def choose_best(results: list[dict], baseline: dict | None) -> str | None:
    """Лучшая стратегия: сначала те, где работают и YouTube, и SoundCloud; среди почти самых быстрых
    (не медленнее половины лучшей скорости YouTube) — та, при которой ещё и Discord открывается."""
    if not results:
        return None
    works = lambda r: (r["youtube"] > 0.05) + (r["soundcloud"] > 0)
    top = max(works(r) for r in results)
    if top == 0:
        return None
    pool = [r for r in results if works(r) == top]
    fastest = max(r["youtube"] for r in pool)
    pool = [r for r in pool if r["youtube"] >= fastest * 0.5]
    best = max(pool, key=lambda r: (bool(r.get("discord")), r["youtube"]))
    # Если без zapret всё и так работает не хуже — ставить нечего
    if baseline and works(baseline) >= top and baseline["youtube"] >= best["youtube"] * 0.9:
        return None
    return best["name"]


def _watch(started: float) -> None:
    """Ждём, пока скрипт замерит стратегии, и сообщаем ему выбор."""
    deadline = started + 15 * 60
    while time.time() < deadline:
        time.sleep(1)
        state = progress()
        if state.get("state") == "tested":
            best = choose_best(state.get("results") or [], state.get("baseline"))
            _write_json(WORK_DIR / "decision.json", {"install": best})
            return
        if state.get("state") in ("done", "error"):
            return
        if state.get("state") == "idle" and time.time() - started > 90:
            return   # скрипт так и не стартовал (человек отказал в правах)


def start_setup(root: Path, youtube_url: str, soundcloud_urls: list[str]) -> None:
    """Запускает подбор стратегии с запросом прав администратора. PermissionError — человек отказал."""
    global _watcher
    with _lock:
        if _watcher and _watcher.is_alive():
            raise RuntimeError("Подбор уже идёт")
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        for name in ("progress.json", "decision.json"):
            (WORK_DIR / name).unlink(missing_ok=True)
        items = []
        for bat in strategies(root):
            try:
                items.append({"name": bat.stem, "args": strategy_args(root, bat)})
            except ValueError as e:
                print(f"[zapret] пропускаю {bat.name}: {e}")
        if not items:
            raise LookupError("Не нашёл в папке ни одной стратегии (general*.bat)")
        params = {"exe": str(root / "bin" / "winws.exe"), "strategies": items,
                  "youtube": youtube_url, "soundcloud": soundcloud_urls}
        try:
            add_domains(root)
        except PermissionError:
            target, need = plan_domains(root)
            params["append"] = {"path": str(target), "lines": [MARK, *need]}
        _write_json(WORK_DIR / "params.json", params)
        script = WORK_DIR / "setup.ps1"
        script.write_text(PS_SCRIPT, encoding="utf-8-sig")   # с BOM — иначе PowerShell 5 испортит русские буквы
        args = f'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{script}"'
        code = ctypes.windll.shell32.ShellExecuteW(None, "runas", "powershell.exe", args, None, 0)
        if code <= 32:
            raise PermissionError("Без прав администратора zapret не настроить")
        _watcher = threading.Thread(target=_watch, args=(time.time(),), daemon=True)
        _watcher.start()
