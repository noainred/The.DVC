"""런타임 설정 — 전부 환경변수로만 조정한다(설정 파일 없음).

의도적으로 표준 라이브러리만 쓴다. 오프라인 Rocky Linux 9 서버에 pip 없이
그대로 복사해 띄울 수 있어야 하기 때문이다.
"""

from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
BASE_DIR = PACKAGE_DIR.parent
STATIC_DIR = BASE_DIR / "static"

# 폴백 버전 — pyportal 을 저장소 밖으로 단독 복사(/opt/dc-service-hub)한 배포에서 쓰인다.
# pyportal 을 변경하는 릴리스마다 package.json 과 함께 올릴 것(방치하면 화면 버전이 낡는다).
_FALLBACK_VERSION = "2.219.0"


def _resolve_version() -> str:
    """허브 표시 버전 결정: env HUB_VERSION → 저장소 루트 package.json → 폴백 상수.

    저장소째 배포(설치 패키지의 app/pyportal)에서는 옆의 package.json 을 읽어 포탈과
    같은 버전이 표시되고, 단독 복사본은 폴백 상수(또는 env)를 쓴다.
    """
    env = os.environ.get("HUB_VERSION", "").strip()
    if env:
        return env[:32]
    try:
        pkg = BASE_DIR.parent / "package.json"  # <repo>/package.json (pyportal/ 의 부모)
        if pkg.is_file():
            import json
            value = str(json.loads(pkg.read_text(encoding="utf-8")).get("version", "")).strip()
            if value:
                return value[:32]
    except (OSError, ValueError):
        pass
    return _FALLBACK_VERSION


VERSION = _resolve_version()
APP_NAME = "Global DC Service Hub"


def _env_str(key: str, default: str) -> str:
    value = os.environ.get(key)
    return value.strip() if value and value.strip() else default


def _env_int(key: str, default: int, *, low: int, high: int) -> int:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        return default
    return max(low, min(high, value))


def _env_float(key: str, default: float, *, low: float, high: float) -> float:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        value = float(raw.strip())
    except ValueError:
        return default
    return max(low, min(high, value))


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class Config:
    """한 번 읽어서 고정한다 — 서버 기동 시점의 값을 그대로 쓴다."""

    def __init__(self) -> None:
        self.host = _env_str("HUB_HOST", "0.0.0.0")
        self.port = _env_int("HUB_PORT", 8095, low=1, high=65535)
        self.data_dir = Path(_env_str("HUB_DATA_DIR", str(BASE_DIR / "data")))

        # 선택적 접근 토큰. 설정하면 모든 /api 요청에 X-Hub-Token(또는 hub_token 쿠키)이 필요하다.
        self.token = os.environ.get("HUB_TOKEN", "").strip()

        # 링크 상태 점검
        self.health_timeout = _env_float("HUB_HEALTH_TIMEOUT", 4.0, low=0.5, high=30.0)
        # 사내망 서비스 수십 개를 한꺼번에 찌르면 순간 부하가 커진다 — 동시 수를 제한한다.
        self.health_concurrency = _env_int("HUB_HEALTH_CONCURRENCY", 8, low=1, high=32)
        # 사내 자체서명 인증서가 흔하지만 기본값은 '검증 ON'이다(끄려면 명시적으로 false).
        self.health_tls_verify = _env_bool("HUB_HEALTH_TLS_VERIFY", True)
        # RFC1918(사내망)은 허용, 루프백/링크로컬/메타데이터 주소는 차단한다.
        self.health_allow_private = _env_bool("HUB_HEALTH_ALLOW_PRIVATE", True)

        # 요청 본문 상한(바이트) — 대용량 POST 로 메모리를 밀어 넣지 못하게.
        self.max_body_bytes = _env_int("HUB_MAX_BODY", 1_048_576, low=4096, high=16_777_216)

        # 설정 화면 로그인 세션 유지 시간(분) + 실패 잠금
        self.session_ttl_min = _env_int("HUB_SESSION_TTL_MIN", 480, low=5, high=10080)
        self.login_max_fails = _env_int("HUB_LOGIN_MAX_FAILS", 8, low=3, high=100)
        self.login_lockout_sec = _env_int("HUB_LOGIN_LOCKOUT_SEC", 300, low=30, high=86400)

        # 링크 점검 이력 보관 기간(일). 한 달 차트를 그리려면 최소 31일이 필요하다.
        self.history_retention_days = _env_int("HUB_HISTORY_RETENTION_DAYS", 40, low=2, high=730)

        # 메인 모니터링 포탈(The.DVC) 주소. 설정하면 헤더에 상호 이동 링크가 생긴다.
        # 두 포탈은 별도 프로세스라 서로의 주소를 모른다 — 하드코딩 대신 env 로 받는다.
        self.portal_url = _env_str("HUB_PORTAL_URL", "").rstrip("/")
        if not self.portal_url.lower().startswith(("http://", "https://")):
            self.portal_url = ""      # 스킴이 없으면 링크로 쓰지 않는다

    @property
    def shortcuts_file(self) -> Path:
        return self.data_dir / "shortcuts.json"

    @property
    def datacenters_file(self) -> Path:
        return self.data_dir / "datacenters.json"

    @property
    def users_file(self) -> Path:
        return self.data_dir / "users.json"

    @property
    def settings_file(self) -> Path:
        return self.data_dir / "settings.json"

    @property
    def history_db(self) -> Path:
        return self.data_dir / "health-history.db"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def session_secret_file(self) -> Path:
        """세션 서명 키(0600). 이 파일이 있어야 재시작해도 로그인이 유지된다."""
        return self.data_dir / "session-secret"

    @property
    def audit_log(self) -> Path:
        return self.data_dir / "audit.log"

    @property
    def initial_password_file(self) -> Path:
        """최초 기동 시 생성한 설정 비밀번호를 적어 두는 파일(0600).

        비밀번호를 바꾸면 삭제된다 — 파일이 남아 있으면 초기 비밀번호가 계속
        유효한 것으로 오해할 수 있다.
        """
        return self.data_dir / "initial-settings-password.txt"

    def describe(self) -> dict:
        """기동 로그·/api/meta 용 요약(비밀값은 넣지 않는다)."""
        return {
            "app": APP_NAME,
            "version": VERSION,
            "dataDir": str(self.data_dir),
            "authRequired": bool(self.token),
            "healthTimeout": self.health_timeout,
            "healthConcurrency": self.health_concurrency,
            "healthTlsVerify": self.health_tls_verify,
        }


config = Config()
