"""설정 화면 접근 인증 — 초기 비밀번호 파일 · 사용자 계정 · 세션.

설계 의도
- **첫 기동 시 임의 비밀번호를 생성**해 서버 디렉터리에 `initial-settings-password.txt`
  (0600)로 남긴다. 서버에 들어갈 수 있는 사람만 읽을 수 있으므로 '아는 사람만 설정 진입'이
  성립한다. 비밀번호를 바꾸면 그 파일을 삭제한다(낡은 비밀번호가 유효한 것처럼 남지 않게).
- 로그인은 **사용자명 + 비밀번호**를 받는다(v2.216). 이전에는 비밀번호만 받아 일치하는 계정을
  찾았는데, 그러면 **비밀번호가 곧 계정 식별자**가 되어 ① 계정끼리 같은 비밀번호를 못 쓰고
  ② 한 번 새어 나간 비밀번호로 '누구인지'까지 드러나며 ③ 계정별 잠금을 걸 수 없다.
- 해시는 pbkdf2_hmac(sha256) — 표준 라이브러리만으로 가능한 범위에서 반복 횟수를 높게 잡는다.
- 무차별 대입에는 **출발지(IP)별 실패 카운터 + 잠금**을 건다(`SessionStore`).
  사용자명이 틀렸는지 비밀번호가 틀렸는지는 **구분해서 알려 주지 않는다**(계정 열거 차단).
"""

from __future__ import annotations

import base64
from collections import deque
import hashlib
import hmac
import json
import secrets
import threading
import time
from pathlib import Path

from .config import config
from .jsonfile import now_iso, read_json, write_json, write_text

PBKDF2_ROUNDS = 210_000
ROLES = ("admin", "viewer")
BOOTSTRAP_USERNAME = "admin"


class AuthError(Exception):
    """사용자에게 그대로 보여줄 수 있는 인증/검증 실패."""


def hash_password(password: str) -> dict:
    if not isinstance(password, str) or len(password) < 8:
        raise AuthError("비밀번호는 8자 이상이어야 합니다.")
    if len(password) > 200:
        raise AuthError("비밀번호가 너무 깁니다(200자 이하).")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return {
        "algo": "pbkdf2_sha256",
        "rounds": PBKDF2_ROUNDS,
        "salt": salt.hex(),
        "hash": digest.hex(),
    }


_DUMMY_SALT = secrets.token_bytes(16)


def _burn_password_work(password: str) -> None:
    """비밀번호 해시와 같은 비용의 더미 KDF.

    없는 계정·중지 계정도 존재 계정과 같은 시간을 쓰게 해, 응답시간으로 계정을 열거하지
    못하게 한다(v2.500 감사 M1 — 실측 100배 차이였다). 결과는 쓰지 않는다.
    """
    try:
        hashlib.pbkdf2_hmac("sha256", str(password or "").encode("utf-8"), _DUMMY_SALT, PBKDF2_ROUNDS)
    except Exception:
        pass


def verify_password(record, password: str) -> bool:
    if not isinstance(record, dict) or not isinstance(password, str) or not password:
        return False
    try:
        salt = bytes.fromhex(record.get("salt", ""))
        rounds = int(record.get("rounds", PBKDF2_ROUNDS))
        expected = bytes.fromhex(record.get("hash", ""))
    except (ValueError, TypeError):
        return False
    if not salt or not expected:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(digest, expected)


def generate_password(length: int = 20) -> str:
    """사람이 옮겨 적을 수 있게 헷갈리는 글자(0/O/l/1)는 뺀다."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _fresh_token_version() -> int:
    """새 계정의 tokenVersion 시작값 — v2.768(점검 R3-C3-5).

    예전에는 1 로 시작했다. 삭제 시점의 발급시각 컷오프(SessionStore._user_revoked)는 메모리에만 있어
    재기동하면 사라지므로, 계정을 지우고 재기동한 뒤 같은 이름을 다시 만들면 삭제 전 토큰(v=1, TTL 안)이
    새 계정으로 통과했다(역할은 새 계정 것). 시작값을 무작위(2^20 ~ 2^31)로 두면 옛 토큰의 v(작은 값에서
    시작해 인상으로만 자란 값)와 겹칠 확률이 사실상 없다. 기존 계정의 값은 건드리지 않는다.
    """
    return (1 << 20) + secrets.randbelow((1 << 31) - (1 << 20))


class UserStore:
    """설정 접근 계정 목록(`users.json`)."""

    def __init__(self, path, initial_password_file=None):
        self._path = path
        self._initial_file = initial_password_file
        self._lock = threading.RLock()
        self._users = None
        self._mtime = None   # 파일 변경 감지(아래 _load) — 외부 프로세스의 수정을 재시작 없이 반영
        self._unreadable = False   # 31회차 F3: 파일은 있는데 읽지 못함(권한) — 저장 · 부트스트랩을 막는다(fail-closed)

    # ---------- 로드/저장 ----------

    def _load(self):
        # 콘솔 복구(app.py --reset-password)는 별도 프로세스에서 users.json 을 고쳐 쓴다.
        # 메모리 캐시만 믿으면 실행 중인 서버가 재시작 전까지 새 비밀번호를 모른다 —
        # mtime 이 바뀌면 다시 읽는다(호출당 stat 1회, 로그인 경로라 비용 무시 가능).
        try:
            mtime = self._path.stat().st_mtime_ns
        except OSError:
            mtime = None
        if self._users is None or mtime != self._mtime:
            try:
                raw = read_json(self._path, [], expect=list, strict_io=True, quiet=self._unreadable)
            except OSError:
                # 31회차 F3: 읽지 못함은 손상이 아니다 — 원본을 옮기지 않고, 직전 목록이 있으면 그대로 쓴다(mtime 은 두어 다음에 다시 읽는다).
                #   처음부터 못 읽었으면 빈 목록 + 표지(저장 · 새 admin 생성 금지). 로그는 상태가 바뀔 때 한 번(35회차 R6 — 요청마다 찍혔다).
                self._unreadable = True
                if self._users is None:
                    self._users = []
                return self._users
            self._users = [u for u in (self._clean(entry) for entry in raw) if u]
            self._mtime = mtime
            self._unreadable = False
        return self._users

    def _refuse_if_unreadable(self):
        """35회차 R6(재현): 못 읽음 상태의 쓰기는 **바꾸기 전에** 거절한다 — 예전에는 메모리 목록을 먼저 고친 뒤 저장에서 실패해, 400 을 주고도
        새 비밀번호 · 중지 · 삭제가 메모리에서 효력을 가졌고 파일이 다시 읽히면 조용히 되돌아갔다."""
        if self._unreadable:
            raise AuthError(f"{self._path.name} 을(를) 읽지 못해 저장하지 않습니다 — 파일 소유자 · 권한을 확인하세요"
                            "(서비스 계정이 읽을 수 있어야 합니다).")

    def _save(self):
        self._refuse_if_unreadable()
        write_json(self._path, self._users)
        try:
            self._mtime = self._path.stat().st_mtime_ns
        except OSError:
            self._mtime = None

    @staticmethod
    def _clean(entry):
        if not isinstance(entry, dict):
            return None
        username = str(entry.get("username", "")).strip()[:64]
        if not username:
            return None
        role = entry.get("role")
        try:
            version = int(entry.get("tokenVersion", 1))
        except (TypeError, ValueError):
            version = 1
        return {
            "username": username,
            "role": role if role in ROLES else "viewer",
            "enabled": bool(entry.get("enabled", True)),
            "password": entry.get("password") if isinstance(entry.get("password"), dict) else None,
            # 서명 토큰(무상태 세션)을 한 번에 무효화하는 카운터. 비밀번호 변경·계정 중지·
            # 삭제 시 올리면 그 계정으로 발급된 기존 토큰이 전부 못 쓰게 된다.
            "tokenVersion": max(1, version),
            "createdAt": entry.get("createdAt") or now_iso(),
            "updatedAt": entry.get("updatedAt") or now_iso(),
        }

    # ---------- 부트스트랩 ----------

    def bootstrap(self):
        """계정이 하나도 없으면 admin 을 만들고 초기 비밀번호 파일을 남긴다.

        반환값은 (생성된 비밀번호 | None) — 기동 로그에 경로를 안내하기 위한 것이며
        비밀번호 자체는 로그에 찍지 않는다.
        """
        with self._lock:
            users = self._load()
            if users:
                return None
            if self._unreadable:
                # 31회차 F3: 파일이 있는데 읽지 못했다 — 계정이 없는 것이 아니다. 새 admin 을 만들면 기존 계정 전부를 덮는다.
                print(f"[auth] {self._path.name} 을(를) 읽지 못해 초기 admin 을 만들지 않습니다 — 소유자 · 권한을 고친 뒤 재시작하세요.",
                      flush=True)
                return None
            password = generate_password()
            users.append({
                "username": BOOTSTRAP_USERNAME,
                "role": "admin",
                "enabled": True,
                "password": hash_password(password),
                # users.json 이 비어(지워져) 다시 만드는 경우도 같은 이름(admin) 재생성이다 — 무작위 시작(R3-C3-5).
                "tokenVersion": _fresh_token_version(),
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            })
            self._save()
            if self._initial_file:
                write_text(self._initial_file, (
                    "# Global DC Service Hub — 설정 화면 초기 비밀번호\n"
                    "# 설정에서 비밀번호를 변경하면 이 파일은 자동 삭제됩니다.\n"
                    f"username: {BOOTSTRAP_USERNAME}\n"
                    f"password: {password}\n"
                ))
            return password

    def initial_password_present(self) -> bool:
        return bool(self._initial_file) and self._initial_file.exists()

    def drop_initial_password_file(self) -> None:
        if self._initial_file and self._initial_file.exists():
            try:
                self._initial_file.unlink()
            except OSError as exc:
                print(f"[auth] 초기 비밀번호 파일 삭제 실패: {exc}", flush=True)

    # ---------- 조회 ----------

    def public_list(self):
        with self._lock:
            return [{
                "username": u["username"],
                "role": u["role"],
                "enabled": u["enabled"],
                "hasPassword": bool(u["password"]),
                "createdAt": u["createdAt"],
                "updatedAt": u["updatedAt"],
            } for u in self._load()]

    def get(self, username):
        with self._lock:
            for user in self._load():
                if user["username"] == username:
                    return user
        return None

    def authenticate(self, username: str, password: str):
        """사용자명 + 비밀번호 대조. 실패 사유(없는 계정/중지/비밀번호 불일치)는 구분하지 않는다.

        구분해서 알려 주면 '어떤 사용자명이 존재하는지'가 드러나 계정 열거가 된다.
        """
        name = str(username or "").strip()
        if not name or not isinstance(password, str) or not password:
            return None
        with self._lock:
            for user in self._load():
                if user["username"].lower() != name.lower():
                    continue
                if not user["enabled"] or not user["password"]:
                    # v2.500(감사 M1): 중지·비번없는 계정도 **같은 비용**을 태운다. 아래 주석 참조.
                    _burn_password_work(password)
                    return None
                if verify_password(user["password"], password):
                    return {"username": user["username"], "role": user["role"],
                            "tokenVersion": user["tokenVersion"]}
                return None
        # v2.500(감사 M1): 없는 계정은 PBKDF2 를 돌리지 않아 응답이 훨씬 빨랐다(로컬 실측:
        # 존재 계정 오답 ~128ms vs 없는 계정 ~1.5ms, 약 100배). 문구는 같아도 **타이밍으로**
        # 계정 열거가 됐다 — 이 함수의 문서화된 의도가 우회된 것이다. 더미 해시로 비용을 맞춘다.
        _burn_password_work(password)
        return None

    def token_version(self, username: str):
        """서명 토큰 검증용 현재 카운터. 계정이 없거나 중지면 None(=무효)."""
        with self._lock:
            for user in self._load():
                if user["username"] == username:
                    return user["tokenVersion"] if user["enabled"] else None
        return None

    def role_of(self, username: str):
        """현재 저장된 역할(세션 판정의 진실의 원천). 계정이 없거나 중지면 None."""
        with self._lock:
            for user in self._load():
                if user["username"] == username:
                    return str(user["role"]) if user["enabled"] else None
        return None

    def bump_token_version(self, username: str) -> None:
        """그 계정으로 발급된 모든 토큰을 즉시 무효화한다."""
        with self._lock:
            users = self._load()
            self._refuse_if_unreadable()   # 35회차 R6
            for user in users:
                if user["username"] == username:
                    user["tokenVersion"] = int(user["tokenVersion"]) + 1
                    user["updatedAt"] = now_iso()
                    self._save()
                    return

    # ---------- 변경 ----------

    def add(self, username: str, role: str, password: str):
        username = str(username or "").strip()
        if not username or len(username) > 64:
            raise AuthError("사용자명을 입력하세요(64자 이하).")
        if username in (".", "..") or "/" in username:
            # 35회차 R5: 브라우저가 URL 경로의 점 조각을 정규화해 이 이름의 계정은 화면에서 관리(중지 · 삭제 · 비밀번호)할 수 없다.
            raise AuthError("사용자명으로 '.' · '..' 과 '/' 는 쓸 수 없습니다.")
        if role not in ROLES:
            raise AuthError("역할은 admin 또는 viewer 여야 합니다.")
        with self._lock:
            users = self._load()
            self._refuse_if_unreadable()   # 35회차 R6
            if any(u["username"].lower() == username.lower() for u in users):
                raise AuthError("이미 존재하는 사용자명입니다.")
            record = hash_password(password)
            users.append({
                "username": username, "role": role, "enabled": True,
                "password": record, "tokenVersion": _fresh_token_version(),  # R3-C3-5: 1 로 재시작 금지
                "createdAt": now_iso(), "updatedAt": now_iso(),
            })
            self._save()
            return self.public_list()

    def update(self, username: str, *, role=None, enabled=None):
        with self._lock:
            users = self._load()
            self._refuse_if_unreadable()   # 35회차 R6
            target = None
            for user in users:
                if user["username"] == username:
                    target = user
                    break
            if not target:
                raise AuthError("사용자를 찾을 수 없습니다.")
            if role is not None:
                if role not in ROLES:
                    raise AuthError("역할은 admin 또는 viewer 여야 합니다.")
                # v2.447(감사 S3): 역할이 바뀌면 tokenVersion 을 올려 **기존 세션을 즉시 무효화**한다.
                # 예전에는 enabled=False 일 때만 올렸기 때문에 admin→viewer 강등이 세션 TTL(기본 8시간)
                # 동안 반영되지 않아, 강등된 계정이 사용자 생성·백업 다운로드를 계속 할 수 있었다.
                if str(target.get("role")) != role:
                    target["tokenVersion"] = int(target["tokenVersion"]) + 1
                target["role"] = role
            if enabled is not None:
                if bool(enabled) is False and target["enabled"]:
                    target["tokenVersion"] = int(target["tokenVersion"]) + 1
                target["enabled"] = bool(enabled)
            self._assert_admin_remains(users)
            target["updatedAt"] = now_iso()
            self._save()
            return self.public_list()

    def set_password(self, username: str, password: str):
        with self._lock:
            users = self._load()
            self._refuse_if_unreadable()   # 35회차 R6
            target = next((u for u in users if u["username"] == username), None)
            if not target:
                raise AuthError("사용자를 찾을 수 없습니다.")
            record = hash_password(password)
            target["password"] = record
            target["tokenVersion"] = int(target["tokenVersion"]) + 1   # 기존 토큰 즉시 무효
            target["updatedAt"] = now_iso()
            self._save()
            # 비밀번호가 바뀌었으면 초기 비밀번호 파일은 더 이상 유효하지 않다.
            if username == BOOTSTRAP_USERNAME:
                self.drop_initial_password_file()
            return True

    def recover(self, username: str) -> dict:
        """콘솔 복구(v2.225) — 비밀번호를 잊어 아무도 설정에 못 들어가는 잠금의 복구 경로.

        서버 파일시스템 접근 권한이 있는 운영자만 실행할 수 있다(app.py --reset-password).
        · 계정이 있으면: 새 임의 비밀번호로 초기화 + 활성화 + tokenVersion 인상(기존 세션 전부 무효)
        · 계정이 없으면: 그 이름의 admin 계정을 새로 만든다(전원 삭제/중지 사고 대비)
        반환: { username, role, password(새 값), created(신규 생성 여부) }
        """
        password = generate_password()
        existing = self.get(username)
        if not existing:
            # 31회차 F10(재현): 로그인은 대소문자를 무시하는데 복구는 정확 일치만 찾아, 'Admin2' 를 'admin2' 로 부르면
            #   add 의 중복 검사(대소문자 무시)에 걸려 예외로 끝났다. 대소문자만 다른 기존 계정을 찾아 그 이름으로 초기화한다.
            name = str(username or "").strip().lower()
            with self._lock:
                existing = next((u for u in self._load() if u["username"].lower() == name), None)
            if existing:
                username = existing["username"]
        if existing:
            self.set_password(username, password)      # tokenVersion 인상 포함
            if not existing.get("enabled", True):
                self.update(username, enabled=True)    # 중지된 계정도 복구 대상
            return {"username": username, "role": existing.get("role", "viewer"),
                    "password": password, "created": False}
        self.add(username, "admin", password)
        return {"username": username, "role": "admin", "password": password, "created": True}

    def delete(self, username: str):
        with self._lock:
            users = self._load()
            self._refuse_if_unreadable()   # 35회차 R6
            remaining = [u for u in users if u["username"] != username]
            if len(remaining) == len(users):
                raise AuthError("사용자를 찾을 수 없습니다.")
            if not remaining:
                raise AuthError("마지막 계정은 삭제할 수 없습니다(설정에 영영 못 들어갑니다).")
            self._assert_admin_remains(remaining)
            self._users = remaining
            self._save()
            return self.public_list()

    @staticmethod
    def _assert_admin_remains(users):
        """admin 이 하나도 없으면 사용자·백업 관리를 아무도 못 하게 된다 — 잠금 방지."""
        if not any(u["role"] == "admin" and u["enabled"] and u["password"] for u in users):
            raise AuthError("활성 admin 계정이 최소 1개는 있어야 합니다.")


class SessionStore:
    """**무상태 서명 세션**(v2.215) + 출발지별 실패 잠금.

    이전에는 세션을 메모리 dict 에 들고 있어서 **서버를 재시작하면 전원 로그아웃**됐다.
    설정 변경·업그레이드로 재기동이 잦은 운영에서는 그 자체가 불편이다. 이제 토큰은
    `payload.signature` 형태로 **서명해서 발급**하고 서버는 검증만 한다.

    무효화는 어떻게 하나(무상태의 약점 보완):
    - **계정 단위**: `users.json` 의 `tokenVersion` 을 올리면 그 계정 토큰이 전부 죽는다
      (비밀번호 변경·계정 중지·삭제 시 자동). 서명 안에 발급 시점 버전이 들어 있다.
    - **개별 로그아웃**: 만료 전까지만 유지되는 폐기 목록에 담는다. 전체 점검 31회차 F5(재현): 예전에는 메모리에만 두어
      재기동하면 로그아웃한 토큰이 TTL 안에서 다시 통과했다(옛 주석의 'tokenVersion 으로 통제' 는 사실이 아니었다 — 로그아웃은
      tokenVersion 을 올리지 않는다). 이제 `session-revoked.json`(토큰 SHA-256 → 만료시각, 0600, 원자적 쓰기)에도 남긴다.

    서명 키는 데이터 폴더에 0600 으로 보관한다 — 키가 새면 임의 계정 토큰을 위조할 수 있다.
    """

    GLOBAL_FACTOR = 10          # 전역 임계값 = max_fails × 이 배수

    def __init__(self, ttl_seconds: int, max_fails: int, lockout_seconds: int,
                 secret_path=None, users=None, revoked_path=None):
        self._ttl = ttl_seconds
        self._max_fails = max_fails
        self._lockout = lockout_seconds
        self._users = users
        self._secret = self._load_secret(secret_path)
        self._revoked_path = Path(revoked_path) if revoked_path else None
        self._revoked_user = {}   # sha256(token) -> 계정(37회차 R5 — 상한을 넘치면 계정 단위 폐기로 접는다)
        self._revoked = self._load_revoked()   # sha256(token) -> 만료시각(개별 로그아웃 — 31회차 F5: 파일에도)
        self._user_revoked = {}  # username -> 이 시각 이전 발급 토큰 거부(계정 단위 폐기)
        # 마지막 발급시각 — time.time() 이 같은 마이크로초에 같은 값을 돌려주면 '폐기 직후
        # 재로그인' 토큰의 i 가 컷오프와 같아져(i <= cutoff) 튕긴다. 발급시각을 단조 증가로
        # 보정해 폐기(cutoff=마지막 발급시각 이상) / 재발급(i > cutoff)을 결정적으로 만든다.
        self._last_issued = 0.0
        self._fails = {}         # client -> [실패수, 잠금해제시각, 창 시작(첫 실패) 시각]
        self._global_fails = deque()   # 창 안 실패 시각들(31회차 F6 — 예전에는 성공 전까지 기간 없이 쌓였다)
        self._global_until = 0.0
        self._lock = threading.RLock()

    # ---------- 서명 키 ----------

    @staticmethod
    def _load_secret(secret_path):
        """키 파일을 읽고 없으면 만든다. 파일이 없으면 재시작마다 세션이 끊긴다."""
        if not secret_path:
            return secrets.token_bytes(32)
        path = Path(secret_path)
        try:
            if path.exists():
                raw = path.read_text(encoding="utf-8").strip()
                if len(raw) >= 32:
                    return bytes.fromhex(raw) if all(c in "0123456789abcdef" for c in raw) \
                        else raw.encode("utf-8")
        except (OSError, ValueError):
            pass
        secret = secrets.token_bytes(32)
        try:
            write_text(path, secret.hex() + "\n")
        except OSError as exc:
            print(f"[auth] 세션 서명 키 저장 실패({exc}) — 재시작 시 로그아웃됩니다.", flush=True)
        return secret

    # ---------- 개별 로그아웃 폐기 목록(31회차 F5) ----------

    @staticmethod
    def _token_id(token) -> str:
        return hashlib.sha256(str(token).encode("utf-8", "surrogateescape")).hexdigest()

    def _load_revoked(self) -> dict:
        if not self._revoked_path:
            return {}
        raw = read_json(self._revoked_path, {}, expect=dict)
        now = time.time()
        out = {}
        for key, val in raw.items():
            # 값은 [만료, 계정](37회차 R5) — 옛 꼴(만료 숫자만)도 읽는다(계정 모름).
            user = None
            if isinstance(val, list) and val:
                user = val[1] if len(val) > 1 and isinstance(val[1], str) else None
                val = val[0]
            try:
                exp = float(val)
            except (TypeError, ValueError):
                continue
            if isinstance(key, str) and len(key) == 64 and exp >= now:
                out[key] = exp
                if user:
                    self._revoked_user[key] = user
        return out

    def _save_revoked(self) -> None:
        if not self._revoked_path:
            return
        try:
            write_json(self._revoked_path, {k: [exp, self._revoked_user.get(k, "")] for k, exp in self._revoked.items()})
        except OSError as exc:   # 저장 실패가 로그아웃을 막지는 않는다(이 프로세스에서는 메모리로 막힌다)
            print(f"[auth] 로그아웃 폐기 목록 저장 실패({exc}) — 재기동하면 그 토큰이 만료까지 다시 통할 수 있습니다.", flush=True)

    # ---------- 잠금 ----------

    def _fail_window(self) -> float:
        """실패를 세는 창(31회차 F6) — 잠금 시간의 3배, 최소 15분. 이보다 오래된 실패는 세지 않는다."""
        return max(self._lockout * 3, 900)

    def lock_remaining(self, client: str = "-") -> int:
        with self._lock:
            self._purge_fails()
            entry = self._fails.get(client)
            remaining = max(0, int(entry[1] - time.time())) if entry else 0
            return max(remaining, max(0, int(self._global_until - time.time())))

    def note_failure(self, client: str = "-") -> None:
        with self._lock:
            now = time.time()
            window = self._fail_window()
            entry = self._fails.setdefault(client, [0, 0.0, now])
            # 31회차 F6(재현): 창이 지난 실패는 세지 않는다 — 예전에는 30일 전 7회 + 오타 1회로 잠겼다.
            if entry[0] and now - entry[2] > window:
                entry[0] = 0
            if entry[0] == 0:
                entry[2] = now
            entry[0] += 1
            if entry[0] >= self._max_fails:
                entry[1] = now + self._lockout
                entry[0] = 0
            self._global_fails.append(now)
            while self._global_fails and now - self._global_fails[0] > window:
                self._global_fails.popleft()
            if len(self._global_fails) >= self._max_fails * self.GLOBAL_FACTOR:
                self._global_until = now + self._lockout
                self._global_fails.clear()

    def note_success(self, client: str = "-") -> None:
        with self._lock:
            self._fails.pop(client, None)
            self._global_fails.clear()

    def _purge_fails(self) -> None:
        now = time.time()
        window = self._fail_window()
        for client, entry in list(self._fails.items()):
            # 잠금이 끝났고 남은 실패가 없거나 창 밖이면 지운다(31회차 F6 — 1~7회 항목이 영구히 남아 메모리가 자랐다).
            if entry[1] < now and (entry[0] == 0 or now - entry[2] > window):
                self._fails.pop(client, None)

    # ---------- 토큰 ----------

    def _sign(self, payload: bytes) -> str:
        digest = hmac.new(self._secret, payload, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    def create(self, user) -> dict:
        expires = int(time.time() + self._ttl)
        body = {
            "u": user["username"],
            "r": user.get("role", "viewer"),
            "v": int(user.get("tokenVersion", 1)),
            "e": expires,
            # 발급 시각 — 계정 단위 폐기가 '폐기 이전 발급분'만 정확히 자르기 위해 필요하다.
            # 이게 없으면 폐기 후의 재로그인까지 막힌다. 단조 증가 보정(_next_issued)으로
            # 같은 마이크로초 내 '폐기 → 재로그인'에서도 i > cutoff 가 보장된다.
            "i": self._next_issued(),
        }
        raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
        encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
        token = encoded + "." + self._sign(encoded.encode("ascii"))
        return {"token": token,
                "user": {"username": body["u"], "role": body["r"]},
                "expiresAt": expires}

    def resolve(self, token):
        if not token or "." not in token:
            return None
        encoded, _, signature = token.rpartition(".")
        if not encoded or not signature:
            return None
        # v2.767(점검 R2-B5-6): compare_digest 에 str 을 넣으면 비-ASCII 서명부에서 TypeError 가 난다(파이썬 사양) —
        # _dispatch 가 잡지 않는 예외라 응답 없이 연결이 끊겼다(미인증 헤더·쿠키 한 줄). _hub_token_ok(v2.500 L1)처럼
        # 바이트로 비교하고, 인코딩·비교 예외는 '없는 세션'(None)으로 접는다.
        try:
            expected = self._sign(encoded.encode("ascii")).encode("ascii")
            supplied = str(signature).encode("utf-8", "surrogateescape")
            if not hmac.compare_digest(expected, supplied):
                return None
        except (TypeError, ValueError, UnicodeError):
            return None
        try:
            padding = "=" * (-len(encoded) % 4)
            body = json.loads(base64.urlsafe_b64decode(encoded + padding).decode("utf-8"))
        except (ValueError, TypeError):
            return None
        if not isinstance(body, dict) or float(body.get("e", 0)) < time.time():
            return None

        username = str(body.get("u", ""))
        with self._lock:
            self._purge_revoked()
            if self._token_id(token) in self._revoked:
                return None
            cutoff = self._user_revoked.get(username)
            if cutoff is not None and float(body.get("i", 0)) <= cutoff:
                return None

        role = str(body.get("r", "viewer"))
        if self._users is not None:
            current = self._users.token_version(username)
            # 계정이 사라졌거나 중지됐거나, 비밀번호가 바뀐 뒤 발급된 토큰이 아니면 거부.
            if current is None or int(body.get("v", 0)) != int(current):
                return None
            # v2.447(감사 S3): 역할은 **저장소가 진실의 원천**이다. 토큰 payload 의 r 을 그대로 믿으면
            # 위 tokenVersion 인상이 어떤 경로로든 누락됐을 때 강등이 반영되지 않는다(이중 방어).
            live = self._users.role_of(username)
            if live is not None:
                role = live
        return {"username": username, "role": role}

    def _next_issued(self) -> float:
        """단조 증가 발급시각 — 같은 마이크로초 충돌로 폐기/재발급 경계가 무너지지 않게."""
        with self._lock:
            issued = max(time.time(), self._last_issued + 1e-6)
            self._last_issued = issued
            return issued

    REVOKED_MAX = 5000      # 35회차 R1: 폐기 목록 전체 상한
    REVOKED_PER_USER = 50   # 37회차 R5: 계정당 상한 — 넘치면 그 계정 단위 폐기(tokenVersion 인상)로 접는다

    def destroy(self, token) -> None:
        if not token:
            return
        # 35회차 R1(재현): 서명 · 만료가 유효한 토큰만 기록한다 — 예전에는 아무 문자열이나 받아(미인증 로그아웃 요청) 폐기 파일이 끝없이 자라고
        #   요청마다 전체 파일을 세션 잠금 안에서 다시 써 정상 세션 판정이 수 초씩 밀렸다. 이미 무효인 토큰은 기록할 필요가 없다.
        user = self.resolve(token)
        if user is None:
            return
        uname = str(user.get("username", ""))
        fold = set()
        with self._lock:
            key = self._token_id(token)
            self._revoked[key] = time.time() + self._ttl
            self._revoked_user[key] = uname
            self._purge_revoked()
            # 37회차 R5(반증 — 재현): 상한을 넘칠 때 남의 항목을 버리면 그 계정이 로그아웃한 토큰이 되살아났다(유효 계정 하나로 5,000번 로그인 ·
            #   로그아웃). 버리는 대신 **그 계정 단위 폐기로 접는다** — 계정당 상한을 넘은 계정, 그리고 전체 상한을 넘으면 만료가 가까운 항목의 계정.
            if sum(1 for u in self._revoked_user.values() if u == uname) > self.REVOKED_PER_USER:
                fold.add(uname)
            if len(self._revoked) > self.REVOKED_MAX:
                for k, _exp in sorted(self._revoked.items(), key=lambda kv: kv[1])[: len(self._revoked) - self.REVOKED_MAX]:
                    fold.add(self._revoked_user.get(k, ""))
        for name in fold:
            if name:
                self.destroy_user(name)   # tokenVersion 인상(재기동 뒤에도) + 메모리 컷오프 — 그 계정의 남은 세션도 끊긴다(남용일 때만)
        with self._lock:
            for k in [k for k, u in self._revoked_user.items() if u in fold]:
                self._revoked.pop(k, None)
                self._revoked_user.pop(k, None)
            if len(self._revoked) > self.REVOKED_MAX:   # 계정을 모르는 옛 항목만 남았을 때의 마지막 방어
                for k, _exp in sorted(self._revoked.items(), key=lambda kv: kv[1])[: len(self._revoked) - self.REVOKED_MAX]:
                    self._revoked.pop(k, None)
                    self._revoked_user.pop(k, None)
            self._save_revoked()

    def destroy_user(self, username) -> None:
        """그 계정의 모든 토큰을 무효화한다.

        1차 수단은 `tokenVersion` 인상(재시작해도 유지). 여기에 더해 **발급시각 컷오프**를
        메모리에도 남긴다 — 사용자 저장소 없이 만든 SessionStore(테스트·임베드)에서도
        폐기가 실제로 동작해야 하고, 저장소 쓰기가 실패해도 현재 프로세스에서는 즉시 끊긴다.
        """
        if not username:
            return
        if self._users is not None:
            self._users.bump_token_version(username)
        with self._lock:
            # 컷오프는 '지금'과 '마지막 발급시각' 중 큰 값 — 폐기 이전 발급분은 전부 걸리고,
            # 이후 재로그인(단조 증가 i)은 항상 컷오프보다 커서 통과한다.
            self._user_revoked[username] = max(time.time(), self._last_issued)

    def _purge_revoked(self) -> None:
        now = time.time()
        for token, expires in list(self._revoked.items()):
            if expires < now:
                self._revoked.pop(token, None)
                self._revoked_user.pop(token, None)
        # 컷오프는 TTL 이 지나면 의미가 없다(그 이전 토큰은 어차피 만료).
        for username, cutoff in list(self._user_revoked.items()):
            if cutoff + self._ttl < now:
                self._user_revoked.pop(username, None)


def build_auth():
    users = UserStore(config.users_file, config.initial_password_file)
    sessions = SessionStore(config.session_ttl_min * 60, config.login_max_fails,
                            config.login_lockout_sec,
                            secret_path=config.session_secret_file, users=users)
    return users, sessions
