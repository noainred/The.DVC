"""설정 백업 — 즉시 백업 · 정기 자동 백업 · 보관 수량 유지 · 복원.

백업 대상은 설정 파일 5종(바로가기 · 데이터센터 · 카테고리 · 사용자 · 포탈 설정)이며 한 개의
JSON 스냅샷으로 묶는다. 점검 이력 DB(수십만 행)는 대상이 아니다 — 설정 복구가 목적이지
시계열 아카이브가 아니다.

⚠ 백업 파일에는 **users.json(비밀번호 해시)** 이 들어간다. 곧 자격증명 사본이므로
설정 세션(로그인)만 목록/다운로드/복원할 수 있어야 하고, 파일 권한은 0600 이다.
"""

from __future__ import annotations

import os
import re
import threading
import time
from contextlib import ExitStack
from pathlib import Path

from .jsonfile import read_json, write_json

# 결정(56~75 남긴 것): 이름은 backup-<YYYYMMDD>-<HHMMSS>-<밀리초 3자리>-<auto|manual>[-<순번>].json — 예전 이름(밀리초 · 순번 없음 ·
#   backup-<날짜>-<시각>[-<사유>].json)도 그대로 읽는다(목록 · 받기 · 복원 · 삭제 · 정리). 같은 초에 만든 백업이 같은 이름으로 덮이던 것
#   (복원 직전 자동 백업이 방금 만든 수동 백업을 덮음)을 막는다.
NAME_RE = re.compile(r"^backup-([0-9]{8}-[0-9]{6})(?:-([0-9]{3}))?(?:-([a-z]+))?(?:-([0-9]{1,4}))?\.json$")
MAX_KEEP = 200
MAX_SEQ = 9999


def _name_key(name: str):
    """정렬 키(최신이 큼) — (날짜 · 시각, 밀리초(예전 이름은 -1), 순번(없으면 1), 이름). 문자열 정렬은 '-2' 를 순번 없는 이름보다,
    '-10' 을 '-2' 보다 오래된 것으로 놓고 예전 이름을 같은 초의 새 이름보다 최신으로 놓아 정리(보관 수량)가 엉뚱한 파일을 지울 수 있다."""
    m = NAME_RE.match(name)
    if not m:
        return ("", -2, 0, name)
    return (m.group(1), int(m.group(2)) if m.group(2) else -1, int(m.group(4)) if m.group(4) else 1, name)


def _write_json_new(path: Path, data) -> bool:
    """path 가 없을 때만 만든다(있으면 False — **덮어쓰지 않는다**). 임시 파일을 다 쓴 뒤 하드 링크로 붙여 '없을 때만' 을 원자적으로 한다."""
    if path.exists():
        return False
    tmp = path.with_name(path.name + f".part.{os.getpid()}")
    write_json(tmp, data)   # 0600 · fsync
    try:
        try:
            os.link(tmp, path)
            return True
        except FileExistsError:
            return False
        except OSError:
            # 하드 링크를 못 거는 파일 시스템 — 백업 잠금 안에서 다시 확인하고 옮긴다(이 프로세스 안에서는 겹치지 않는다).
            if path.exists():
                return False
            os.replace(tmp, path)
            return True
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

# 백업에 담는 파일과 그 안에서 쓰는 키. app.py 가 넘기는 files dict 와 반드시 일치해야 한다 —
# 여기 빠진 키(과거 categories 누락)는 스냅샷에 담기지도, 복원되지도 않아 시점 복원이 불완전해진다.
MEMBERS = ("shortcuts", "datacenters", "categories", "users", "settings")


def _bump_token_versions(restored, current):
    """복원할 계정 목록의 tokenVersion 을 계정별 max(복원값, 현재값) + 1 로 — 전체 점검 31회차 F2(재현).

    백업은 그 시점의 tokenVersion 을 담고 있어 그대로 쓰면, 그 뒤 비밀번호 변경 · 중지 · 삭제로 폐기한 토큰(v=옛 값)이
    복원 뒤(재기동이 끼면 즉시) 다시 통과했다. 메인 포탈 v2.769 와 같은 처방 — 복원하면 모든 세션이 다시 로그인한다(의도).
    지금 파일에 없는 계정(삭제됨)은 무작위 시작값(auth._fresh_token_version)으로.
    """
    from .auth import _fresh_token_version   # 순환 import 를 피해 여기서

    if not isinstance(restored, list):
        return restored
    cur = {}
    for user in current if isinstance(current, list) else []:
        if isinstance(user, dict) and isinstance(user.get("username"), str):
            try:
                cur[user["username"].lower()] = int(user.get("tokenVersion") or 0)
            except (TypeError, ValueError):
                cur[user["username"].lower()] = 0
    out = []
    for user in restored:
        if not isinstance(user, dict) or not isinstance(user.get("username"), str):
            out.append(user)
            continue
        try:
            old = int(user.get("tokenVersion") or 0)
        except (TypeError, ValueError):
            old = 0
        name = user["username"].lower()
        out.append({**user, "tokenVersion": (max(old, cur[name]) + 1) if name in cur else _fresh_token_version()})
    return out


class BackupService:
    def __init__(self, backup_dir: Path, files: dict, settings_store, load_errors=None,
                 store_locks=None, on_restored=None):
        """files: {"shortcuts": Path, "datacenters": Path, "users": Path, "settings": Path}
        load_errors: 47회차 #5 — () -> {파일 이름: 'corrupt'|'unreadable'} 데이터 파일을 못 읽는 동안 정리를 멈춘다.
        store_locks: 결정(31회차 E2) — () -> [저장소 잠금 …](잡는 순서대로). 복원은 이 잠금을 모두 쥔 채 파일을 쓰고 on_restored(캐시 비우기)를 부른다."""
        self._dir = Path(backup_dir)
        self._files = {key: Path(value) for key, value in files.items()}
        self._settings = settings_store
        self._load_errors = load_errors
        self._store_locks = store_locks
        self._on_restored = on_restored
        self._lock = threading.RLock()
        self._last_run = 0.0
        self._last_result = None
        self._last_error = None   # 37회차 R6: 마지막 자동 백업 실패 {at, reason} — 성공하면 지운다
        self._retry_after = 0.0

    # ---------- 생성 ----------

    def create(self, reason: str = "manual") -> dict:
        with self._lock:
            self._dir.mkdir(parents=True, exist_ok=True)
            now = time.time()
            # 결정(56~75 남긴 것): 밀리초까지 넣고, 그래도 같은 이름이 있으면 순번(-2, -3 …) — 기존 백업을 절대 덮어쓰지 않는다.
            base = "backup-{}-{:03d}-{}".format(time.strftime("%Y%m%d-%H%M%S", time.localtime(now)),
                                                int((now % 1) * 1000), "auto" if reason == "auto" else "manual")

            payload = {
                "meta": {
                    "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                    "reason": reason,
                    "app": "Global DC Service Hub",
                },
                "data": {},
            }
            for key in MEMBERS:
                source = self._files.get(key)
                if not source or not source.exists():
                    payload["data"][key] = None
                    continue
                # 35회차 R2(재현): 읽기 오류(권한)는 손상이 아니다 — non-strict 로 읽으면 users.json 을 .corrupt 로 옮겨 전원 로그인 불가 ·
                #   재기동 때 새 admin 하나만 남았다(31회차 F3 가 UserStore 만 고쳤다). 못 읽으면 백업을 만들지 않고 실패로 끝낸다
                #   (그 멤버를 None 으로 두면 복원 때 '없음' 으로 오해된다).
                try:
                    payload["data"][key] = read_json(source, None, strict_io=True)
                except OSError as exc:
                    raise ValueError(f"{source.name} 을(를) 읽지 못해 백업을 만들지 않았습니다({exc.strerror or exc}) — 파일 소유자 · 권한을 확인하세요.") from exc

            for seq in range(1, MAX_SEQ + 1):
                name = base + (f"-{seq}" if seq > 1 else "") + ".json"
                path = self._dir / name
                if _write_json_new(path, payload):
                    break
            else:
                raise ValueError("같은 시각의 백업 이름이 모두 쓰여 있어 백업을 만들지 않았습니다 — 잠시 뒤 다시 시도하세요.")
            self._last_run = time.time()
            self._last_error = None   # 39회차 R6: 어떤 백업이든 성공하면 지난 자동 백업 실패 경고를 지운다
            kept, removed = self._prune_locked()
            self._last_result = {
                "name": name,
                "createdAt": payload["meta"]["createdAt"],
                "reason": reason,
                "sizeBytes": path.stat().st_size,
                "removed": removed,
                "kept": kept,
            }
            return dict(self._last_result)

    # ---------- 목록/삭제/복원 ----------

    def list(self):
        if not self._dir.exists():
            return []
        entries = []
        for path in sorted(self._dir.glob("backup-*.json"), key=lambda p: _name_key(p.name), reverse=True):
            match = NAME_RE.match(path.name)
            if not match:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            entries.append({
                "name": path.name,
                "sizeBytes": stat.st_size,
                "modifiedTs": int(stat.st_mtime),
                "reason": "auto" if match.group(3) == "auto" else "manual",   # '-auto-2.json' 도 자동
            })
        return entries

    def _resolve(self, name: str) -> Path:
        # 이름 화이트리스트 + basename 으로 백업 디렉터리 밖 경로 접근을 차단한다.
        safe = Path(str(name)).name
        if not NAME_RE.match(safe):
            raise ValueError("백업 파일명이 올바르지 않습니다.")
        path = (self._dir / safe).resolve()
        if path.parent != self._dir.resolve():
            raise ValueError("백업 디렉터리 밖은 접근할 수 없습니다.")
        return path

    def read(self, name: str):
        path = self._resolve(name)
        if not path.exists():
            raise FileNotFoundError(name)
        # 56회차 F3(재현): 읽기 오류(권한 — 예: root 가 옮겨 둔 0600 백업)는 손상이 아니다 — 예전에는 받기 · 복원을 누르는 순간 그 백업을
        #   <이름>.corrupt.* 로 옮겨 목록에서 사라지게 하고 '찾을 수 없음' · '형식 오류' 로 답했다(31회차 F3 · 35회차 R2 와 같은 꼴).
        try:
            return read_json(path, None, expect=dict, strict_io=True)
        except FileNotFoundError:
            raise   # 그 사이 지워졌다 — 404
        except OSError as exc:
            raise ValueError(f"백업 파일을 읽지 못했습니다({exc.strerror or exc}) — 파일 소유자 · 권한을 확인하세요"
                             "(서비스 계정이 읽을 수 있어야 합니다).") from None

    def delete(self, name: str) -> bool:
        with self._lock:
            path = self._resolve(name)
            if not path.exists():
                return False
            path.unlink()
            return True

    def restore(self, name: str) -> dict:
        """스냅샷을 설정 파일로 되돌린다. 되돌리기 직전 상태도 백업해 둔다.

        결정(56~75 남긴 것 · 31회차 E2): 저장소 잠금(store_locks — 정해진 순서)을 모두 쥔 채 직전 백업 · 파일 쓰기 · 캐시 비우기까지 한다.
        예전에는 잠금 없이 파일을 쓴 뒤 라우트가 캐시를 비워, 그 사이 다른 요청이 옛 메모리 목록으로 저장하면 복원 내용이 덮였다
        (응답은 restored 로 성공). 이제 그 저장은 복원이 끝날 때까지 기다렸다가 복원된 파일을 다시 읽고 그 위에 쓴다.
        """
        with self._lock, ExitStack() as held:
            for lock in (self._store_locks() if callable(self._store_locks) else []):
                held.enter_context(lock)
            snapshot = self.read(name)
            if not isinstance(snapshot, dict) or not isinstance(snapshot.get("data"), dict):
                raise ValueError("백업 파일 형식이 올바르지 않습니다.")

            # 복원이 잘못됐을 때 돌아올 지점을 먼저 만든다.
            self.create(reason="manual")

            restored = []
            for key in MEMBERS:
                value = snapshot["data"].get(key)
                target = self._files.get(key)
                if value is None or target is None:
                    continue
                if key == "users":
                    try:
                        current = read_json(target, [], expect=list, strict_io=True)
                    except OSError:
                        current = []   # 지금 파일을 못 읽으면 전 계정을 무작위 시작값으로(옛 토큰과 겹치지 않는다)
                    value = _bump_token_versions(value, current)
                write_json(target, value)
                restored.append(key)
            if callable(self._on_restored):
                self._on_restored()   # 잠금을 쥔 채 캐시를 비운다 — 풀리자마자 들어오는 저장이 복원된 파일을 읽게
            return {"restored": restored, "name": Path(str(name)).name}

    # ---------- 보관 수량 ----------

    def _prune_locked(self):
        # 46회차 H1(재현): 설정을 못 읽는 동안(기본 보관 14개)에는 지우지 않는다 — 관리자가 정한 보관 수량을 모른다.
        load_error = getattr(self._settings, "load_error", None)
        if (callable(load_error) and load_error()) or self.data_load_errors():
            # 47회차 #5(재현): 센터 · 분류 · 바로가기 파일이 손상된 동안에도 정리하면 keep 회 뒤 정상 목록이 든 마지막 백업이 지워져
            #   안내 문구의 '백업에서 복원' 이 불가능해졌다 — 못 읽는 동안에는 지우지 않는다.
            return len(self.list()), 0
        keep = int(self._settings.section("backup").get("keep", 14))
        keep = max(1, min(MAX_KEEP, keep))
        entries = self.list()
        removed = 0
        for entry in entries[keep:]:
            try:
                (self._dir / entry["name"]).unlink()
                removed += 1
            except OSError:
                pass
        return min(len(entries), keep), removed

    def data_load_errors(self) -> dict:
        """47회차 #5: 못 읽은 데이터 파일 {이름: 상태} — 없으면 {}."""
        if not callable(self._load_errors):
            return {}
        try:
            return {k: v for k, v in (self._load_errors() or {}).items() if v}
        except Exception:  # noqa: BLE001 — 표지 수집 실패가 백업을 막지 않게(정리는 아래에서 보수적으로 멈춘다)
            return {"unknown": "unreadable"}

    # ---------- 스케줄 ----------

    def due(self) -> bool:
        cfg = self._settings.section("backup")
        if not cfg.get("enabled"):
            return False
        interval = max(1, int(cfg.get("intervalMinutes", 1440))) * 60
        newest = self.list()
        last = self._last_run
        if newest:
            last = max(last, newest[0]["modifiedTs"])
        return (time.time() - last) >= interval

    def run_if_due(self):
        if time.time() < self._retry_after or not self.due():
            return None
        # 37회차 R6(반증): 자동 백업 실패(예: users.json 을 읽지 못함)는 상태에 남기고 사유가 바뀔 때만 한 줄 — 예전에는 60초마다
        #   traceback 이 쌓이고 화면은 마지막 성공 백업만 보여 실패를 알 수 없었다. 재시도 간격은 그대로(다음 틱).
        try:
            result = self.create(reason="auto")
        except (ValueError, OSError) as exc:   # 39회차 R5: 디스크 가득 등 쓰기 실패(OSError)도 같은 처리(매 분 traceback 대신)
            reason = str(exc)[:300]
            if not self._last_error or self._last_error.get("reason") != reason:
                print(f"[backup] 자동 백업 실패: {reason}", flush=True)
            self._last_error = {"at": time.time(), "reason": reason}
            self._retry_after = time.time() + 600   # 실패하면 10분 뒤 다시(매 분 재시도 · 로그 폭주 대신)
            return None
        self._last_error = None
        return result

    def status(self):
        entries = self.list()
        cfg = self._settings.section("backup")
        return {
            "settings": cfg,
            "count": len(entries),
            "latest": entries[0] if entries else None,
            "totalBytes": sum(entry["sizeBytes"] for entry in entries),
            "directory": str(self._dir),
            # 37회차 R6 · 39회차 R6: 자동 백업이 켜져 있을 때만(꺼면 지난 실패를 경고로 남기지 않는다) — 수동 · 자동 백업이 성공하면 create 가 지운다.
            "lastError": dict(self._last_error) if (self._last_error and cfg.get("enabled")) else None,
            # 46회차 H1: 설정 파일을 못 읽어 기본값으로 동작 중이면 표지(그동안 오래된 백업 정리를 멈춘다)
            "settingsLoadError": (self._settings.load_error() if callable(getattr(self._settings, "load_error", None)) else None),
            "dataLoadErrors": self.data_load_errors() or None,   # 47회차 #5 · #6
        }
