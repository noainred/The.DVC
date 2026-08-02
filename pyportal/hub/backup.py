"""설정 백업 — 즉시 백업 · 정기 자동 백업 · 보관 수량 유지 · 복원.

백업 대상은 설정 파일 4종(바로가기 · 데이터센터 · 사용자 · 포탈 설정)이며 한 개의 JSON
스냅샷으로 묶는다. 점검 이력 DB(수십만 행)는 대상이 아니다 — 설정 복구가 목적이지
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

# 백업에 담는 파일과 그 안에서 쓰는 키.
MEMBERS = ("shortcuts", "datacenters", "users", "settings")


class BackupService:
    def __init__(self, backup_dir: Path, files: dict, settings_store):
        """files: {"shortcuts": Path, "datacenters": Path, "users": Path, "settings": Path}"""
        self._dir = Path(backup_dir)
        self._files = {key: Path(value) for key, value in files.items()}
        self._settings = settings_store
        self._lock = threading.RLock()
        self._last_run = 0.0
        self._last_result = None

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
                payload["data"][key] = read_json(source, None)

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
        if not self.due():
            return None
        return self.create(reason="auto")

    def status(self):
        entries = self.list()
        cfg = self._settings.section("backup")
        return {
            "settings": cfg,
            "count": len(entries),
            "latest": entries[0] if entries else None,
            "totalBytes": sum(entry["sizeBytes"] for entry in entries),
            "directory": str(self._dir),
        }
