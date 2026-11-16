"""설정 백업 — 즉시 백업 · 정기 자동 백업 · 보관 수량 유지 · 복원.

백업 대상은 설정 파일 5종(바로가기 · 데이터센터 · 카테고리 · 사용자 · 포탈 설정)이며 한 개의
JSON 스냅샷으로 묶는다. 점검 이력 DB(수십만 행)는 대상이 아니다 — 설정 복구가 목적이지
시계열 아카이브가 아니다.

⚠ 백업 파일에는 **users.json(비밀번호 해시)** 이 들어간다. 곧 자격증명 사본이므로
설정 세션(로그인)만 목록/다운로드/복원할 수 있어야 하고, 파일 권한은 0600 이다.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path

from .jsonfile import read_json, write_json

NAME_RE = re.compile(r"^backup-[0-9]{8}-[0-9]{6}(-[a-z]+)?\.json$")
MAX_KEEP = 200

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
    def __init__(self, backup_dir: Path, files: dict, settings_store):
        """files: {"shortcuts": Path, "datacenters": Path, "users": Path, "settings": Path}"""
        self._dir = Path(backup_dir)
        self._files = {key: Path(value) for key, value in files.items()}
        self._settings = settings_store
        self._lock = threading.RLock()
        self._last_run = 0.0
        self._last_result = None
        self._last_error = None   # 37회차 R6: 마지막 자동 백업 실패 {at, reason} — 성공하면 지운다
        self._retry_after = 0.0

    # ---------- 생성 ----------

    def create(self, reason: str = "manual") -> dict:
        with self._lock:
            self._dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
            suffix = "auto" if reason == "auto" else "manual"
            name = f"backup-{stamp}-{suffix}.json"
            path = self._dir / name

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

            write_json(path, payload)
            self._last_run = time.time()
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
        for path in sorted(self._dir.glob("backup-*.json"), reverse=True):
            if not NAME_RE.match(path.name):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            entries.append({
                "name": path.name,
                "sizeBytes": stat.st_size,
                "modifiedTs": int(stat.st_mtime),
                "reason": "auto" if path.name.endswith("-auto.json") else "manual",
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
        return read_json(path, None, expect=dict)

    def delete(self, name: str) -> bool:
        with self._lock:
            path = self._resolve(name)
            if not path.exists():
                return False
            path.unlink()
            return True

    def restore(self, name: str) -> dict:
        """스냅샷을 설정 파일로 되돌린다. 되돌리기 직전 상태도 백업해 둔다."""
        with self._lock:
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
            return {"restored": restored, "name": Path(str(name)).name}

    # ---------- 보관 수량 ----------

    def _prune_locked(self):
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
        except ValueError as exc:
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
            "lastError": dict(self._last_error) if self._last_error else None,   # 37회차 R6
        }
