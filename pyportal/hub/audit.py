"""감사 로그 — 누가 언제 무엇을 바꿨는지 파일로 남긴다.

왜 stdout 만으로는 부족한가: 표준 출력은 journald 로 흘러가 보존 기간·검색이 서비스 설정에
좌우된다. 로그인·설정 변경·백업 인출처럼 **나중에 반드시 되짚어야 하는 사건**은 별도 파일에
한 줄 = 한 사건(JSON Lines)으로 남겨야 `grep`·`jq` 로 바로 조회할 수 있다.

규칙
- **JSON Lines**: 줄 단위로 완결 → 중간에 잘려도 앞부분은 유효하다.
- **크기 기반 회전**: 무한히 커지면 디스크를 먹는다. 상한을 넘으면 `.1` 로 밀어 두고 새로 쓴다.
- **비밀값 금지**: 비밀번호·토큰은 절대 기록하지 않는다(사건과 주체만).
- **실패해도 요청을 막지 않는다**: 기록 실패로 기능이 멈추면 안 된다(best effort).
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

MAX_BYTES = 2 * 1024 * 1024      # 2MB 넘으면 회전
KEEP = 3                          # audit.log.1 ~ .3

# 값에 이런 키가 있으면 기록하지 않는다(실수로 넘겨도 새지 않게).
_SECRET_KEYS = ("password", "token", "secret", "passphrase", "hash")


class AuditLog:
    def __init__(self, path):
        self._path = Path(path)
        self._lock = threading.Lock()

    def _rotate_if_needed(self) -> None:
        try:
            if not self._path.exists() or self._path.stat().st_size < MAX_BYTES:
                return
            for index in range(KEEP, 0, -1):
                older = self._path.with_suffix(self._path.suffix + f".{index}")
                newer = (self._path if index == 1
                         else self._path.with_suffix(self._path.suffix + f".{index - 1}"))
                if newer.exists():
                    if index == KEEP and older.exists():
                        older.unlink()
                    os.replace(newer, older)
        except OSError:
            pass

    @staticmethod
    def _clean(detail):
        """비밀값 후보를 걸러 낸 사본을 만든다."""
        if not isinstance(detail, dict):
            return {}
        safe = {}
        for key, value in detail.items():
            if any(secret in str(key).lower() for secret in _SECRET_KEYS):
                continue
            if isinstance(value, (str, int, float, bool)) or value is None:
                safe[key] = value if not isinstance(value, str) else value[:200]
            elif isinstance(value, (list, tuple)):
                safe[key] = [str(item)[:80] for item in list(value)[:20]]
        return safe

    def write(self, action: str, *, actor: str = "-", client: str = "-",
              result: str = "ok", detail=None) -> None:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
            "action": str(action)[:60],
            "actor": str(actor)[:64],
            "client": str(client)[:64],
            "result": str(result)[:32],
        }
        clean = self._clean(detail)
        if clean:
            entry["detail"] = clean

        line = json.dumps(entry, ensure_ascii=False) + "\n"
        with self._lock:
            self._rotate_if_needed()
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                # 0600 으로 만들고 append — 누가 무엇을 했는지도 운영 정보다.
                fd = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, "a", encoding="utf-8") as handle:
                    handle.write(line)
            except OSError as exc:
                print(f"[audit] 기록 실패({exc}) — 기능은 계속합니다.", flush=True)

    def tail(self, limit: int = 200):
        """최근 기록을 최신순으로 돌려준다(설정 화면 조회용)."""
        try:
            raw = self._path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        entries = []
        for line in raw[-max(1, min(limit, 1000)):]:
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
        entries.reverse()
        return entries
