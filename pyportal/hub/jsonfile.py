"""JSON 파일 입출력 공통 규칙 — 원자적 쓰기 + 손상 파일 보존.

바로가기·데이터센터·사용자·설정 네 파일이 같은 규칙을 쓰므로 여기 한 곳에 모은다.

왜 이렇게까지 하나:
- **원자적 쓰기**(tmp + fsync + rename): 저장 중 프로세스가 죽어도 반쪽 파일이 남지 않는다.
- **손상 보존**: 파싱 실패를 조용히 빈 값으로 넘기면, 다음 저장이 멀쩡했던 원본을 덮어써
  전체 목록이 영구 유실된다. 사본을 남기고 기본값으로 시작한다.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

FILE_MODE = 0o600


def preserve_corrupt(path: Path) -> None:
    try:
        backup = path.with_suffix(path.suffix + f".corrupt.{int(time.time())}")
        os.replace(path, backup)
        print(f"[store] 손상된 파일을 보존했습니다: {backup}", flush=True)
    except OSError as exc:
        print(f"[store] 손상 파일 보존 실패: {exc}", flush=True)


def read_json(path: Path, default, *, expect=None):
    """파일을 읽어 파싱한다. 없으면 default, 손상되면 보존 후 default.

    expect 를 주면(list/dict) 타입이 다를 때도 손상으로 취급한다.
    """
    path = Path(path)
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"[store] {path.name} 을(를) 읽을 수 없습니다({exc}) — 보존 후 기본값으로 시작합니다.",
              flush=True)
        preserve_corrupt(path)
        return default
    if expect is not None and not isinstance(data, expect):
        print(f"[store] {path.name} 형식이 올바르지 않습니다 — 보존 후 기본값으로 시작합니다.",
              flush=True)
        preserve_corrupt(path)
        return default
    return data


def _open_private(tmp: Path):
    """임시파일을 **처음부터 0o600** 으로 연다. 기본 open() 은 umask 에 따라 0o644(월드 리더블)로
    만들어, os.replace 후 os.chmod 까지의 창에서 users.json(비밀번호 해시)·session-secret 같은
    민감 파일이 잠깐 다른 로컬 사용자에게 읽힌다(감사 L6). O_EXCL 로 예측가능한 tmp 이름에 대한
    심볼릭링크 선점(symlink race)도 막는다. 같은 pid 재사용으로 남은 스테일 tmp 는 먼저 정리한다."""
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, FILE_MODE)
    return os.fdopen(fd, "w", encoding="utf-8")


def write_json(path: Path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    with _open_private(tmp) as handle:
        handle.write(json.dumps(data, ensure_ascii=False, indent=2))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    try:
        os.chmod(path, FILE_MODE)
    except OSError:
        pass


def write_text(path: Path, text: str) -> None:
    """비밀번호 파일처럼 JSON 이 아닌 민감 파일도 같은 규칙으로 쓴다."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    with _open_private(tmp) as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    try:
        os.chmod(path, FILE_MODE)
    except OSError:
        pass


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
