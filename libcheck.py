"""Проверка медиатеки: заранее находим треки, которые больше не открываются, и подбираем им другую загрузку.

Раньше замена искалась, только когда трек не включился (player.js → /api/replacement): человек ждал, слышал
тишину и уведомление. Теперь страница раз в несколько дней присылает треки медиатеки (POST /api/libcheck),
а здесь в фоне:
  - SoundCloud — пачками по 50 (/tracks?ids=): трека нет в ответе → удалён/закрыт (проверяем ещё раз по одному),
    есть — смотрим, можно ли его играть (DRM, «только отрывок», закрыт в стране — importer._sc_track);
  - YouTube — oEmbed (быстро, без yt-dlp). Он «не узнаёт» и видео, которые просто запрещено встраивать на сайты,
    поэтому подозрительные проверяем настоящей попыткой получить звук (resolve_stream);
  - сломанным ищем замену так же, как /api/replacement (поиск мимо сломанной загрузки).
Ответ сети непонятный (обрыв, «проверка на робота») — трек НЕ считаем сломанным, проверим в другой раз:
лучше пропустить сломанный, чем «починить» рабочий.

Результаты — DATA_DIR/libcheck.json: {"tracks": {ключ: {t, ok, why, alt, title, artist}}, "lastRun": время}.
Трек перепроверяется не чаще раза в RECHECK; за один запуск — не больше LIMIT треков (большая медиатека
проверится за несколько запусков).
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

RECHECK = 14 * 24 * 3600   # рабочий трек проверяем снова через две недели
RECHECK_BAD = 2 * 24 * 3600  # сломанный без замены — через два дня (вдруг замена появилась)
LIMIT = 300


class Checker:
    def __init__(self, path, yt_check, sc_check, find_replacement):
        """yt_check(id) → (True|False|None, причина); sc_check([id]) → {id: (True|False|None, причина)};
        find_replacement(трек) → настоящий трек или None."""
        self.path = path
        self.yt_check, self.sc_check, self.find_replacement = yt_check, sc_check, find_replacement
        self.lock = threading.Lock()
        self.job = {"running": False, "total": 0, "done": 0}
        try:
            self.state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.state = {}
        self.state.setdefault("tracks", {})

    def _save(self):
        try:
            self.path.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
        except OSError as e:
            print(f"[libcheck] не сохранилось: {e}")

    def status(self, keys: set | None = None) -> dict:
        """Что сейчас и какие треки сломаны (keys — только эти: медиатека могла измениться)."""
        with self.lock:
            broken = {k: {kk: v.get(kk) for kk in ("why", "alt", "t")}
                      for k, v in self.state["tracks"].items()
                      if v.get("ok") is False and (keys is None or k in keys)}
            return {**self.job, "lastRun": self.state.get("lastRun"), "broken": broken}

    def start(self, tracks: list[dict], force: bool = False) -> bool:
        """tracks: [{source, id, artist, title, duration, metaId?}] (ключ «source:id»). False — уже идёт."""
        now = time.time()
        with self.lock:
            if self.job["running"]:
                return False
            todo = []
            for t in tracks:
                key = f"{t['source']}:{t['id']}"
                saved = self.state["tracks"].get(key)
                wait = RECHECK_BAD if saved and saved.get("ok") is False and not saved.get("alt") else RECHECK
                if force or not saved or now - saved.get("t", 0) > wait:
                    todo.append(t)
            todo = todo[:LIMIT]
            self.job = {"running": True, "total": len(todo), "done": 0}
        threading.Thread(target=self._run, args=(todo,), daemon=True).start()
        return True

    def _mark(self, track: dict, ok, why: str = "", alt: dict | None = None):
        key = f"{track['source']}:{track['id']}"
        with self.lock:
            if ok is None:   # непонятно — оставляем прежний результат, проверим в другой раз
                pass
            else:
                self.state["tracks"][key] = {"t": time.time(), "ok": ok, "why": why, "alt": alt,
                                             "title": track.get("title"), "artist": track.get("artist")}
            self.job["done"] += 1

    def _run(self, todo: list[dict]):
        started = time.time()
        bad: list[tuple[dict, str]] = []
        try:
            sc = [t for t in todo if t["source"] == "soundcloud"]
            yt = [t for t in todo if t["source"] == "youtube"]
            for i in range(0, len(sc), 50):
                part = sc[i:i + 50]
                try:
                    res = self.sc_check([t["id"] for t in part])
                except Exception as e:
                    print(f"[libcheck] SoundCloud не ответил: {e}")
                    res = {}
                for t in part:
                    ok, why = res.get(t["id"], (None, ""))
                    if ok is False:
                        bad.append((t, why))
                    else:
                        self._mark(t, ok)

            def one(t):
                try:
                    return t, *self.yt_check(t["id"])
                except Exception as e:
                    print(f"[libcheck] YouTube {t['id']}: {e}")
                    return t, None, ""
            with ThreadPoolExecutor(4) as pool:
                for t, ok, why in pool.map(one, yt):
                    if ok is False:
                        bad.append((t, why))
                    else:
                        self._mark(t, ok)

            for t, why in bad:   # сломанным — замену (по одному: это поиск на YouTube и SoundCloud)
                try:
                    alt = self.find_replacement(t)
                except Exception as e:
                    print(f"[libcheck] замена для {t.get('artist')} — {t.get('title')}: {e}")
                    alt = None
                print(f"[libcheck] не открывается {t['source']}:{t['id']} ({why}) -> "
                      f"{(alt['source'] + ':' + str(alt['id'])) if alt else 'замены нет'}")
                self._mark(t, False, why, alt)
        finally:
            with self.lock:
                self.state["lastRun"] = time.time()
                self.job["running"] = False
                self._save()
            print(f"[libcheck] проверено {len(todo)}, не открывается {len(bad)}, {time.time() - started:.0f} с")
