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
            password = generate_password()
            users.append({
                "username": BOOTSTRAP_USERNAME,
                "role": "admin",
                "enabled": True,
                "password": hash_password(password),
                "tokenVersion": 1,
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
                    return None
                if verify_password(user["password"], password):
                    return {"username": user["username"], "role": user["role"],
                            "tokenVersion": user["tokenVersion"]}
                return None
        return None

    def token_version(self, username: str):
        """서명 토큰 검증용 현재 카운터. 계정이 없거나 중지면 None(=무효)."""
        with self._lock:
            for user in self._load():
                if user["username"] == username:
                    return user["tokenVersion"] if user["enabled"] else None
        return None

    def bump_token_version(self, username: str) -> None:
        """그 계정으로 발급된 모든 토큰을 즉시 무효화한다."""
        with self._lock:
            users = self._load()
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
        if role not in ROLES:
            raise AuthError("역할은 admin 또는 viewer 여야 합니다.")
        with self._lock:
            users = self._load()
            if any(u["username"].lower() == username.lower() for u in users):
                raise AuthError("이미 존재하는 사용자명입니다.")
            record = hash_password(password)
            users.append({
                "username": username, "role": role, "enabled": True,
                "password": record, "tokenVersion": 1,
                "createdAt": now_iso(), "updatedAt": now_iso(),
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
    """**무상태 서명 세션**(v2.215) + 출발지별 실패 잠금.

    이전에는 세션을 메모리 dict 에 들고 있어서 **서버를 재시작하면 전원 로그아웃**됐다.
    설정 변경·업그레이드로 재기동이 잦은 운영에서는 그 자체가 불편이다. 이제 토큰은
    `payload.signature` 형태로 **서명해서 발급**하고 서버는 검증만 한다.

    무효화는 어떻게 하나(무상태의 약점 보완):
    - **계정 단위**: `users.json` 의 `tokenVersion` 을 올리면 그 계정 토큰이 전부 죽는다
      (비밀번호 변경·계정 중지·삭제 시 자동). 서명 안에 발급 시점 버전이 들어 있다.
    - **개별 로그아웃**: 만료 전까지만 유지되는 메모리 폐기 목록에 담는다(재시작하면
      사라지지만, 그때는 어차피 서명 검증이 아니라 tokenVersion 으로 통제된다).

    서명 키는 데이터 폴더에 0600 으로 보관한다 — 키가 새면 임의 계정 토큰을 위조할 수 있다.
    """

    GLOBAL_FACTOR = 10          # 전역 임계값 = max_fails × 이 배수

    def __init__(self, ttl_seconds: int, max_fails: int, lockout_seconds: int,
                 secret_path=None, users=None):
        self._ttl = ttl_seconds
        self._max_fails = max_fails
        self._lockout = lockout_seconds
        self._users = users
        self._secret = self._load_secret(secret_path)
        self._revoked = {}       # token -> 만료시각(개별 로그아웃)
        self._user_revoked = {}  # username -> 이 시각 이전 발급 토큰 거부(계정 단위 폐기)
        # 마지막 발급시각 — time.time() 이 같은 마이크로초에 같은 값을 돌려주면 '폐기 직후
        # 재로그인' 토큰의 i 가 컷오프와 같아져(i <= cutoff) 튕긴다. 발급시각을 단조 증가로
        # 보정해 폐기(cutoff=마지막 발급시각 이상) / 재발급(i > cutoff)을 결정적으로 만든다.
        self._last_issued = 0.0
        self._fails = {}         # client -> [실패수, 잠금해제시각]
        self._global_fails = 0
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

    # ---------- 잠금 ----------

    def lock_remaining(self, client: str = "-") -> int:
        with self._lock:
            self._purge_fails()
            entry = self._fails.get(client)
            remaining = max(0, int(entry[1] - time.time())) if entry else 0
            return max(remaining, max(0, int(self._global_until - time.time())))

    def note_failure(self, client: str = "-") -> None:
        with self._lock:
            entry = self._fails.setdefault(client, [0, 0.0])
            entry[0] += 1
            if entry[0] >= self._max_fails:
                entry[1] = time.time() + self._lockout
                entry[0] = 0
            self._global_fails += 1
            if self._global_fails >= self._max_fails * self.GLOBAL_FACTOR:
                self._global_until = time.time() + self._lockout
                self._global_fails = 0

    def note_success(self, client: str = "-") -> None:
        with self._lock:
            self._fails.pop(client, None)
            self._global_fails = 0

    def _purge_fails(self) -> None:
        now = time.time()
        for client, entry in list(self._fails.items()):
            if entry[0] == 0 and entry[1] < now:
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
        if not hmac.compare_digest(self._sign(encoded.encode("ascii")), signature):
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
            if token in self._revoked:
                return None
            cutoff = self._user_revoked.get(username)
            if cutoff is not None and float(body.get("i", 0)) <= cutoff:
                return None

        if self._users is not None:
            current = self._users.token_version(username)
            # 계정이 사라졌거나 중지됐거나, 비밀번호가 바뀐 뒤 발급된 토큰이 아니면 거부.
            if current is None or int(body.get("v", 0)) != int(current):
                return None
        return {"username": username, "role": str(body.get("r", "viewer"))}

    def _next_issued(self) -> float:
        """단조 증가 발급시각 — 같은 마이크로초 충돌로 폐기/재발급 경계가 무너지지 않게."""
        with self._lock:
            issued = max(time.time(), self._last_issued + 1e-6)
            self._last_issued = issued
            return issued

    def destroy(self, token) -> None:
        if not token:
            return
        with self._lock:
            self._revoked[token] = time.time() + self._ttl
            self._purge_revoked()

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
