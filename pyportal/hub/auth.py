"""설정 화면 접근 인증 — 초기 비밀번호 파일 · 사용자 계정 · 세션.

설계 의도
- **첫 기동 시 임의 비밀번호를 생성**해 서버 디렉터리에 `initial-settings-password.txt`
  (0600)로 남긴다. 서버에 들어갈 수 있는 사람만 읽을 수 있으므로 '아는 사람만 설정 진입'이
  성립한다. 비밀번호를 바꾸면 그 파일을 삭제한다(낡은 비밀번호가 유효한 것처럼 남지 않게).
- 로그인은 **비밀번호만** 입력받는다(요청 사양). 입력값을 활성 계정들의 해시와 대조해
  일치하는 계정으로 로그인한다. 그래서 계정끼리 **같은 비밀번호를 못 쓰게** 막는다.
- 해시는 pbkdf2_hmac(sha256) — 표준 라이브러리만으로 가능한 범위에서 반복 횟수를 높게 잡는다.
- 무차별 대입에는 **전역 실패 카운터 + 잠금**을 건다(계정을 특정하지 않는 로그인이라 계정별
  잠금은 의미가 없다).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time

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


class UserStore:
    """설정 접근 계정 목록(`users.json`)."""

    def __init__(self, path, initial_password_file=None):
        self._path = path
        self._initial_file = initial_password_file
        self._lock = threading.RLock()
        self._users = None

    # ---------- 로드/저장 ----------

    def _load(self):
        if self._users is None:
            raw = read_json(self._path, [], expect=list)
            self._users = [u for u in (self._clean(entry) for entry in raw) if u]
        return self._users

    def _save(self):
        write_json(self._path, self._users)

    @staticmethod
    def _clean(entry):
        if not isinstance(entry, dict):
            return None
        username = str(entry.get("username", "")).strip()[:64]
        if not username:
            return None
        role = entry.get("role")
        return {
            "username": username,
            "role": role if role in ROLES else "viewer",
            "enabled": bool(entry.get("enabled", True)),
            "password": entry.get("password") if isinstance(entry.get("password"), dict) else None,
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
            password = generate_password()
            users.append({
                "username": BOOTSTRAP_USERNAME,
                "role": "admin",
                "enabled": True,
                "password": hash_password(password),
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

    def authenticate(self, password: str):
        """비밀번호만으로 계정을 찾는다. 일치하는 활성 계정이 없으면 None."""
        with self._lock:
            for user in self._load():
                if not user["enabled"] or not user["password"]:
                    continue
                if verify_password(user["password"], password):
                    return {"username": user["username"], "role": user["role"]}
        return None

    def _password_in_use(self, password: str, *, exclude=None) -> bool:
        for user in self._load():
            if exclude and user["username"] == exclude:
                continue
            if user["password"] and verify_password(user["password"], password):
                return True
        return False

    # ---------- 변경 ----------

    def add(self, username: str, role: str, password: str):
        username = str(username or "").strip()
        if not username or len(username) > 64:
            raise AuthError("사용자명을 입력하세요(64자 이하).")
        if role not in ROLES:
            raise AuthError("역할은 admin 또는 viewer 여야 합니다.")
        with self._lock:
            users = self._load()
            if any(u["username"].lower() == username.lower() for u in users):
                raise AuthError("이미 존재하는 사용자명입니다.")
            record = hash_password(password)
            if self._password_in_use(password):
                # 비밀번호만으로 로그인하므로 중복을 허용하면 누구로 로그인되는지 불확실해진다.
                raise AuthError("다른 계정이 이미 쓰는 비밀번호입니다. 다른 값을 사용하세요.")
            users.append({
                "username": username, "role": role, "enabled": True,
                "password": record, "createdAt": now_iso(), "updatedAt": now_iso(),
            })
            self._save()
            return self.public_list()

    def update(self, username: str, *, role=None, enabled=None):
        with self._lock:
            users = self._load()
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
                target["role"] = role
            if enabled is not None:
                target["enabled"] = bool(enabled)
            self._assert_admin_remains(users)
            target["updatedAt"] = now_iso()
            self._save()
            return self.public_list()

    def set_password(self, username: str, password: str):
        with self._lock:
            users = self._load()
            target = next((u for u in users if u["username"] == username), None)
            if not target:
                raise AuthError("사용자를 찾을 수 없습니다.")
            record = hash_password(password)
            if self._password_in_use(password, exclude=username):
                raise AuthError("다른 계정이 이미 쓰는 비밀번호입니다. 다른 값을 사용하세요.")
            target["password"] = record
            target["updatedAt"] = now_iso()
            self._save()
            # 비밀번호가 바뀌었으면 초기 비밀번호 파일은 더 이상 유효하지 않다.
            if username == BOOTSTRAP_USERNAME:
                self.drop_initial_password_file()
            return True

    def delete(self, username: str):
        with self._lock:
            users = self._load()
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
    """메모리 세션. 재시작하면 전부 만료된다(설정 화면 전용이라 그 편이 안전)."""

    def __init__(self, ttl_seconds: int, max_fails: int, lockout_seconds: int):
        self._ttl = ttl_seconds
        self._max_fails = max_fails
        self._lockout = lockout_seconds
        self._sessions = {}
        self._fails = 0
        self._locked_until = 0.0
        self._lock = threading.RLock()

    def lock_remaining(self) -> int:
        with self._lock:
            return max(0, int(self._locked_until - time.time()))

    def note_failure(self) -> None:
        with self._lock:
            self._fails += 1
            if self._fails >= self._max_fails:
                self._locked_until = time.time() + self._lockout
                self._fails = 0

    def note_success(self) -> None:
        with self._lock:
            self._fails = 0
            self._locked_until = 0.0

    def create(self, user) -> dict:
        token = secrets.token_urlsafe(32)
        expires = time.time() + self._ttl
        with self._lock:
            self._purge()
            self._sessions[token] = {"user": user, "expires": expires}
        return {"token": token, "user": user, "expiresAt": int(expires)}

    def resolve(self, token):
        if not token:
            return None
        with self._lock:
            entry = self._sessions.get(token)
            if not entry:
                return None
            if entry["expires"] < time.time():
                self._sessions.pop(token, None)
                return None
            return entry["user"]

    def destroy(self, token) -> None:
        with self._lock:
            self._sessions.pop(token, None)

    def destroy_user(self, username) -> None:
        """비밀번호 변경·계정 비활성화 시 그 계정의 기존 세션을 끊는다."""
        with self._lock:
            for token, entry in list(self._sessions.items()):
                if entry["user"].get("username") == username:
                    self._sessions.pop(token, None)

    def _purge(self) -> None:
        now = time.time()
        for token, entry in list(self._sessions.items()):
            if entry["expires"] < now:
                self._sessions.pop(token, None)


def build_auth():
    users = UserStore(config.users_file, config.initial_password_file)
    sessions = SessionStore(config.session_ttl_min * 60, config.login_max_fails,
                            config.login_lockout_sec)
    return users, sessions
