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


_ABSENT = object()


class StoreUnavailable(RuntimeError):
    """46회차 H2: 참조 저장소(데이터센터 · 카테고리)를 못 읽음 — 바로가기는 분류 · 센터 값을 바꾸지 않고 그대로 둔다."""


def has_corrupt_copy(path: Path) -> bool:
    """이전 기동이 옮겨 둔 손상 보존본(<이름>.corrupt.<ts>)이 남아 있는가."""
    path = Path(path)
    try:
        return any(path.parent.glob(path.name + ".corrupt.*"))
    except OSError:
        return False


def read_json_state(path: Path, *, expect=None, quiet: bool = False):
    """46회차(전체 점검): (값, 상태) — 상태는 None(정상) · 'missing'(첫 기동) · 'corrupt'(손상) · 'unreadable'(읽기 오류).

    손상은 보존본으로 옮기고, 읽기 오류는 옮기지 않는다(31회차 F3 과 같은 규칙). 파일이 없어도 손상 보존본이 남아 있으면
    'corrupt' 다 — 손상으로 옮긴 뒤 재기동하면 '첫 기동' 으로 보고 내장 seed · 기본값을 파일에 굳혀, 바로가기 연결 · 보관 수량을
    잃던 것(46회차 H1 · H2)을 막는다. 관리자가 복구(백업 복원 · 보존본 되살리기)하거나 보존본을 지우면 풀린다.
    """
    path = Path(path)
    # 134회차(재현): Path.exists() 는 폴더 수준 읽기 오류(데이터 폴더 탐색 권한 — PermissionError)를 **올린다**(os.path.exists 와 다르다).
    #   이 줄이 try 밖이라 '읽기 오류' 상태 대신 예외가 호출부(저장소 로드)로 나갔다 — 같은 원인의 파일 수준 오류와 결과가 갈렸다.
    try:
        existed = path.exists()
    except OSError:
        return None, "unreadable"
    try:
        data = read_json(path, _ABSENT, expect=expect, strict_io=True, quiet=quiet)
    except OSError:
        return None, "unreadable"
    if data is _ABSENT:
        if existed or has_corrupt_copy(path):
            return None, "corrupt"
        return None, "missing"
    return data, None


def load_error_text(name: str, state: str) -> str:
    """손상 · 읽기 오류 상태의 안내 문구(쓰기 거절 · 화면 표지 공용)."""
    if state == "unreadable":
        return f"{name} 을(를) 읽지 못했습니다(권한 · 입출력) — 파일 소유자 · 권한을 고칠 때까지 저장하지 않습니다."
    return (f"{name} 이(가) 손상되어 {name}.corrupt.* 로 옮겼습니다 — 백업에서 복원하거나 보존본을 고쳐 되살리세요"
            f"(처음부터 다시 쓰려면 보존본을 지우고 다시 시작). 그때까지 저장하지 않습니다.")


def read_json(path: Path, default, *, expect=None, strict_io: bool = False, quiet: bool = False):
    """파일을 읽어 파싱한다. 없으면 default, 손상되면 보존 후 default.

    expect 를 주면(list/dict) 타입이 다를 때도 손상으로 취급한다.
    strict_io=True 면 읽기 오류(권한 · 입출력 — OSError)는 손상이 아니다: 옮기지 않고 그대로 올린다
    (전체 점검 31회차 F3 — root 로 콘솔 복구를 돌려 users.json 이 root 소유가 되면, 서비스가 'Permission denied' 를 손상으로 보고
    원본을 옮긴 뒤 빈 목록으로 돌았고 재기동 때 새 admin 하나만 남았다). 계정 파일처럼 '못 읽음' 을 따로 다뤄야 하는 쪽이 쓴다.
    """
    path = Path(path)
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:   # UnicodeDecodeError 는 ValueError — 깨진 바이트는 손상이다
        if strict_io and isinstance(exc, OSError):
            if not quiet:   # 35회차 R6: 같은 상태가 이어지면 호출부가 quiet 으로 — 요청마다 로그가 쌓이지 않게
                print(f"[store] {path.name} 을(를) 읽지 못했습니다({exc}) — 파일을 옮기지 않습니다(권한 · 소유자를 확인하세요).",
                      flush=True)
            raise
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
