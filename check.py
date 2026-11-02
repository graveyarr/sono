"""Проверка без интерфейса: работают ли поиск, потоковая отдача и скачивание.

Запуск:  python check.py            (ищет тестовый запрос)
         python check.py "запрос"
"""
import sys
import time

from app import get_audio_file, open_upstream, search

query = sys.argv[1] if len(sys.argv) > 1 else "never gonna give you up"


def check_search(source: str) -> dict:
    print(f"Поиск на {source}: «{query}»")
    results = search(source, query, limit=5)
    if not results:
        sys.exit("   ОШИБКА: ничего не найдено")
    for r in results:
        print(f"   {r['id']}  {r['title']}  [{r['duration']:.0f} c]")
    print("   OK\n")
    return results[0]


# ----- YouTube -----
first = check_search("youtube")

print(f"YouTube, потоковая отдача: {first['title']}")
t0 = time.time()
resp, total, mime = open_upstream(first["id"], 0, 65535)
data = resp.content
resp.close()
print(f"   получено {len(data)} байт за {time.time() - t0:.1f} с; всего в файле {total / 1048576:.1f} МБ; тип {mime}")
if len(data) < 1000:
    sys.exit("   ОШИБКА: YouTube отдал слишком мало данных")
resp, _, _ = open_upstream(first["id"], total // 2, total // 2 + 1023)
mid = resp.content
resp.close()
print(f"   кусок из середины файла (перемотка): {len(mid)} байт")
if len(mid) != 1024:
    sys.exit("   ОШИБКА: перемотка не работает")
print("   OK\n")


def check_download(track: dict):
    print(f"{track['source']}, скачивание в cache/: {track['title']}")
    t0 = time.time()
    path = get_audio_file(track["source"], track["id"])
    size_mb = path.stat().st_size / 1048576
    print(f"   файл: {path}  ({size_mb:.1f} МБ, {time.time() - t0:.1f} с)")
    if size_mb < 0.1:
        sys.exit("   ОШИБКА: файл подозрительно маленький")
    print("   OK\n")


check_download(first)

# ----- SoundCloud (играет только через скачивание) -----
check_download(check_search("soundcloud"))

print("Всё работает. Теперь запусти: python desktop.py")
