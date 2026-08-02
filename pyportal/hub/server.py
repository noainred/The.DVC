"""HTTP 서버 — 정적 페이지 + REST API.

프레임워크를 쓰지 않는 이유는 단순함이 아니라 **배포 제약** 때문이다. 이 포탈은
인터넷이 막힌 Rocky Linux 9 서버에 복사만으로 올라가야 하고, pip 설치가 불가능하다.
그래서 http.server(표준 라이브러리)로 필요한 만큼만 구현한다.

접근 통제 3층
1. `HUB_TOKEN`(선택) — 설정 시 모든 `/api` 요청에 토큰이 필요하다(포탈 전체 비공개화).
2. **설정 세션** — `/api/settings/*` 와 **모든 상태변경**(바로가기 생성·수정·삭제 포함)은
   설정 비밀번호로 로그인해야 한다. 조회는 열려 있다.
3. **역할** — 사용자·백업·데이터센터·설정 변경은 `admin` 만. `viewer` 는 바로가기까지.
"""

from __future__ import annotations

import hmac
import json
import mimetypes
import posixpath
import re
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .auth import AuthError
from .config import APP_NAME, STATIC_DIR, VERSION, config
from .defaults import CATEGORIES
from .history import RANGE_LABELS, RANGES
from .settings import BACKUP_INTERVAL_CHOICES, HEALTH_INTERVAL_CHOICES
from .ssrf import ValidationError

# 정적 자산은 이 확장자만 서빙한다(데이터 파일이 실수로 노출되지 않게).
STATIC_SUFFIXES = {".html", ".css", ".js", ".svg", ".png", ".ico", ".webmanifest"}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    # 페이지 자산이 전부 자기 자신에서 오므로 self 로 잠글 수 있다(외부 CDN 사용 안 함).
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self'; "
        "script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'"
    ),
}

ID_PATTERN = r"([A-Za-z0-9_-]{1,64})"
NAME_PATTERN = r"([A-Za-z0-9._-]{1,80})"


def _route(pattern: str):
    return re.compile("^" + pattern + "$")


class HubHandler(BaseHTTPRequestHandler):
    server_version = f"GlobalDCServiceHub/{VERSION}"
    protocol_version = "HTTP/1.1"

    # ---------- 응답 헬퍼 ----------

    def _send(self, status, body: bytes, content_type: str, extra_headers: dict = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload, status=HTTPStatus.OK, extra_headers: dict = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra_headers)

    def _error(self, status, message: str, **extra) -> None:
        payload = {"success": False, "error": message}
        payload.update(extra)
        self._json(payload, status=status)

    def _drain_body(self):
        """요청 본문을 **항상 여기서 한 번에 읽어 둔다**.

        keep-alive 연결에서 본문을 읽지 않고 응답하면, 남은 바이트가 다음 요청의
        request line 앞에 붙어 `501 Unsupported method ('{}PUT')` 같은 오류가 난다.
        본문을 쓰지 않는 핸들러(리셋·백업 생성 등)가 있으므로 라우팅 전에 비운다.
        """
        raw = self.headers.get("Content-Length", "0")
        try:
            length = int(raw)
        except ValueError:
            self._body_raw = b""
            self._body_error = "Content-Length 가 올바르지 않습니다."
            return
        if length <= 0:
            self._body_raw = b""
            self._body_error = None
            return
        if length > config.max_body_bytes:
            # 상한을 넘으면 연결을 재사용하지 않는다(부분만 읽고 이어 쓰면 desync).
            self.close_connection = True
            self._body_raw = b""
            self._body_error = "요청 본문이 너무 큽니다."
            return
        self._body_raw = self.rfile.read(length)
        self._body_error = None

    def _read_json(self):
        if getattr(self, "_body_error", None):
            raise ValidationError(self._body_error)
        raw = getattr(self, "_body_raw", b"")
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValidationError("JSON 형식이 올바르지 않습니다.")

    def _body_dict(self):
        payload = self._read_json()
        if not isinstance(payload, dict):
            raise ValidationError("요청 본문이 올바르지 않습니다.")
        return payload

    def _query(self):
        return parse_qs(urlsplit(self.path).query)

    # ---------- 컨텍스트 ----------

    @property
    def ctx(self):
        return self.server.ctx  # type: ignore[attr-defined]

    # ---------- 인증 ----------

    def _cookie(self, name):
        header = self.headers.get("Cookie", "")
        if not header:
            return ""
        jar = SimpleCookie()
        try:
            jar.load(header)
        except Exception:  # noqa: BLE001 — 깨진 쿠키는 미인증으로 취급
            return ""
        morsel = jar.get(name)
        return morsel.value if morsel else ""

    def _hub_token_ok(self) -> bool:
        """HUB_TOKEN 이 설정된 경우에만 검사한다(미설정이면 사내망 공개 운영)."""
        if not config.token:
            return True
        supplied = self.headers.get("X-Hub-Token", "") or self._cookie("hub_token")
        return bool(supplied) and hmac.compare_digest(supplied, config.token)

    def _session_user(self):
        token = self.headers.get("X-Settings-Token", "") or self._cookie("hub_settings")
        return self.ctx.sessions.resolve(token)

    def _require_session(self):
        user = self._session_user()
        if not user:
            self._error(HTTPStatus.UNAUTHORIZED, "설정 비밀번호로 로그인해야 합니다.",
                        code="settings_login_required")
            return None
        return user

    def _require_admin(self):
        user = self._require_session()
        if not user:
            return None
        if user.get("role") != "admin":
            self._error(HTTPStatus.FORBIDDEN, "admin 계정만 변경할 수 있습니다.")
            return None
        return user

    # ---------- 디스패치 ----------

    def do_GET(self):  # noqa: N802
        self._dispatch("GET")

    do_HEAD = do_GET

    def do_POST(self):  # noqa: N802
        self._dispatch("POST")

    def do_PUT(self):  # noqa: N802
        self._dispatch("PUT")

    def do_DELETE(self):  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method):
        self._drain_body()
        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            if method in ("GET", "HEAD"):
                return self._serve_static(path)
            return self._error(HTTPStatus.NOT_FOUND, "없는 경로입니다.")

        if not self._hub_token_ok():
            # 설정 로그인 실패(401)와 구분되는 코드를 붙인다 — 화면이 엉뚱한
            # '접근 토큰' 모달을 띄우지 않게 하기 위한 것.
            return self._error(HTTPStatus.UNAUTHORIZED, "접근 토큰이 필요합니다.",
                               code="hub_token_required")

        for route_method, pattern, handler in ROUTES:
            if route_method != method:
                continue
            match = pattern.match(path)
            if not match:
                continue
            try:
                return handler(self, *match.groups())
            except (ValidationError, AuthError) as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            except FileNotFoundError:
                return self._error(HTTPStatus.NOT_FOUND, "대상을 찾을 수 없습니다.")
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
        return self._error(HTTPStatus.NOT_FOUND, "없는 API 입니다.")

    # ================= 공개 조회 =================

    def api_meta(self):
        user = self._session_user()
        return self._json({
            "success": True,
            "app": APP_NAME,
            "version": VERSION,
            "categories": CATEGORIES,
            "regions": ["APAC", "EMEA", "AMER", "LATAM"],
            "datacenterCount": len(self.ctx.datacenters.all()),
            "shortcutCount": len(self.ctx.shortcuts.all()),
            "healthTlsVerify": config.health_tls_verify,
            "historyRanges": [{"key": key, "label": RANGE_LABELS[key], "seconds": RANGES[key]}
                              for key in RANGES],
            "session": user,
            "initialPasswordFile": (str(config.initial_password_file)
                                    if self.ctx.users.initial_password_present() else None),
        })

    def api_shortcuts(self):
        return self._json({"success": True, "shortcuts": self.ctx.shortcuts.all()})

    def api_datacenters(self):
        return self._json({
            "success": True,
            "datacenters": self.ctx.datacenters.all(),
            "summary": self.ctx.datacenters.summary(),
        })

    def api_health_latest(self):
        # 삭제된 바로가기의 이력은 차트에는 남기되 '최근 상태' 표에는 띄우지 않는다.
        alive = {item["id"] for item in self.ctx.shortcuts.all()}
        results = [row for row in self.ctx.history.latest().values() if row["id"] in alive]
        return self._json({"success": True, "results": results})

    def api_health_history(self):
        query = self._query()
        range_key = (query.get("range") or ["24h"])[0]
        shortcut_id = (query.get("id") or [None])[0]
        if shortcut_id and not re.match("^" + ID_PATTERN + "$", shortcut_id):
            shortcut_id = None
        return self._json({"success": True,
                           **self.ctx.history.series(range_key, shortcut_id),
                           "stats": self.ctx.history.stats()})

    def api_health_check(self):
        payload = self._read_json()
        targets = self._health_targets(payload)
        if not targets:
            return self._json({"success": True, "results": [], "skipped": False})
        results = self.ctx.run_health_check(targets)
        if results is None:
            # 이전 점검이 아직 진행 중 — 새로 돌리지 않고 최신 결과를 돌려준다.
            return self._json({"success": True, "results": list(self.ctx.history.latest().values()),
                               "skipped": True})
        return self._json({"success": True, "results": results, "skipped": False,
                           "checkedAt": self.date_time_string()})

    def _health_targets(self, payload) -> list:
        if isinstance(payload, dict):
            ids = payload.get("ids")
            if isinstance(ids, list) and ids:
                wanted = {str(value) for value in ids}
                return [{"id": item["id"], "url": item["url"]}
                        for item in self.ctx.shortcuts.all() if item["id"] in wanted]
            urls = payload.get("urls")
            if isinstance(urls, list) and urls:
                return [{"id": None, "url": str(value)} for value in urls[:200]]
        return [{"id": item["id"], "url": item["url"]} for item in self.ctx.shortcuts.all()]

    # ================= 설정 세션 =================

    def api_session_get(self):
        user = self._session_user()
        if not user:
            return self._error(HTTPStatus.UNAUTHORIZED, "로그인되어 있지 않습니다.")
        return self._json({"success": True, "user": user})

    def api_session_login(self):
        remaining = self.ctx.sessions.lock_remaining()
        if remaining > 0:
            return self._error(HTTPStatus.TOO_MANY_REQUESTS,
                               f"로그인 시도가 많아 잠겼습니다. {remaining}초 후 다시 시도하세요.")
        payload = self._body_dict()
        password = payload.get("password")
        user = self.ctx.users.authenticate(password if isinstance(password, str) else "")
        if not user:
            self.ctx.sessions.note_failure()
            print("[auth] 설정 로그인 실패", flush=True)
            return self._error(HTTPStatus.UNAUTHORIZED, "비밀번호가 올바르지 않습니다.")
        self.ctx.sessions.note_success()
        session = self.ctx.sessions.create(user)
        print(f"[auth] 설정 로그인: {user['username']}", flush=True)
        return self._json({"success": True, **session})

    def api_session_logout(self):
        token = self.headers.get("X-Settings-Token", "") or self._cookie("hub_settings")
        self.ctx.sessions.destroy(token)
        return self._json({"success": True})

    # ================= 설정 =================

    def api_settings_state(self):
        if not self._require_session():
            return None
        return self._json({
            "success": True,
            "settings": self.ctx.settings.all(),
            "choices": {
                "backupIntervalMinutes": list(BACKUP_INTERVAL_CHOICES),
                "healthIntervalMinutes": list(HEALTH_INTERVAL_CHOICES),
            },
            "users": self.ctx.users.public_list(),
            "backup": self.ctx.backups.status(),
            "history": self.ctx.history.stats(),
            "initialPasswordFile": (str(config.initial_password_file)
                                    if self.ctx.users.initial_password_present() else None),
            "dataDir": str(self.ctx.data_dir),
        })

    def api_settings_section(self, section):
        if not self._require_admin():
            return None
        updated = self.ctx.settings.update_section(section, self._body_dict())
        return self._json({"success": True, "settings": self.ctx.settings.all(),
                           "section": section, "value": updated})

    # ---- 사용자 ----

    def api_users_list(self):
        if not self._require_session():
            return None
        return self._json({"success": True, "users": self.ctx.users.public_list()})

    def api_users_create(self):
        if not self._require_admin():
            return None
        payload = self._body_dict()
        users = self.ctx.users.add(payload.get("username"), payload.get("role", "viewer"),
                                   payload.get("password", ""))
        return self._json({"success": True, "users": users}, status=HTTPStatus.CREATED)

    def api_users_update(self, username):
        if not self._require_admin():
            return None
        payload = self._body_dict()
        users = self.ctx.users.update(username, role=payload.get("role"),
                                      enabled=payload.get("enabled"))
        if payload.get("enabled") is False:
            self.ctx.sessions.destroy_user(username)
        return self._json({"success": True, "users": users})

    def api_users_password(self, username):
        actor = self._require_session()
        if not actor:
            return None
        # 남의 비밀번호를 바꾸려면 admin 이어야 한다(자기 것은 누구나).
        if actor["username"] != username and actor.get("role") != "admin":
            return self._error(HTTPStatus.FORBIDDEN, "본인 비밀번호만 변경할 수 있습니다.")
        payload = self._body_dict()
        self.ctx.users.set_password(username, payload.get("password", ""))
        # 비밀번호가 바뀐 계정의 기존 세션은 끊는다.
        self.ctx.sessions.destroy_user(username)
        return self._json({"success": True, "users": self.ctx.users.public_list()})

    def api_users_delete(self, username):
        actor = self._require_admin()
        if not actor:
            return None
        if actor["username"] == username:
            return self._error(HTTPStatus.BAD_REQUEST, "로그인 중인 계정은 삭제할 수 없습니다.")
        users = self.ctx.users.delete(username)
        self.ctx.sessions.destroy_user(username)
        return self._json({"success": True, "users": users})

    # ---- 데이터센터 ----

    def api_dc_create(self):
        if not self._require_admin():
            return None
        created = self.ctx.datacenters.add(self._body_dict())
        return self._json({"success": True, "datacenter": created,
                           "datacenters": self.ctx.datacenters.all()}, status=HTTPStatus.CREATED)

    def api_dc_update(self, dc_id):
        if not self._require_admin():
            return None
        updated = self.ctx.datacenters.update(dc_id, self._body_dict())
        if not updated:
            return self._error(HTTPStatus.NOT_FOUND, "데이터센터를 찾을 수 없습니다.")
        return self._json({"success": True, "datacenter": updated,
                           "datacenters": self.ctx.datacenters.all()})

    def api_dc_delete(self, dc_id):
        if not self._require_admin():
            return None
        if not self.ctx.datacenters.delete(dc_id):
            return self._error(HTTPStatus.NOT_FOUND, "데이터센터를 찾을 수 없습니다.")
        return self._json({"success": True, "datacenters": self.ctx.datacenters.all()})

    def api_dc_reset(self):
        if not self._require_admin():
            return None
        return self._json({"success": True, "datacenters": self.ctx.datacenters.reset()})

    # ---- 백업 ----

    def api_backup_list(self):
        if not self._require_session():
            return None
        return self._json({"success": True, "backups": self.ctx.backups.list(),
                           "status": self.ctx.backups.status()})

    def api_backup_create(self):
        if not self._require_admin():
            return None
        result = self.ctx.backups.create(reason="manual")
        print(f"[backup] 수동 백업 생성: {result['name']}", flush=True)
        return self._json({"success": True, "backup": result,
                           "backups": self.ctx.backups.list(),
                           "status": self.ctx.backups.status()}, status=HTTPStatus.CREATED)

    def api_backup_download(self, name):
        user = self._require_admin()
        if not user:
            return None
        snapshot = self.ctx.backups.read(name)
        if snapshot is None:
            return self._error(HTTPStatus.NOT_FOUND, "백업을 찾을 수 없습니다.")
        # 백업에는 계정 비밀번호 해시가 들어 있다 — 누가 꺼냈는지 로그로 남긴다.
        print(f"[backup] 다운로드: {name} (by {user['username']})", flush=True)
        body = json.dumps(snapshot, ensure_ascii=False, indent=2).encode("utf-8")
        return self._send(HTTPStatus.OK, body, "application/json; charset=utf-8", {
            "Content-Disposition": f'attachment; filename="{Path(str(name)).name}"',
        })

    def api_backup_delete(self, name):
        if not self._require_admin():
            return None
        if not self.ctx.backups.delete(name):
            return self._error(HTTPStatus.NOT_FOUND, "백업을 찾을 수 없습니다.")
        return self._json({"success": True, "backups": self.ctx.backups.list(),
                           "status": self.ctx.backups.status()})

    def api_backup_restore(self, name):
        user = self._require_admin()
        if not user:
            return None
        result = self.ctx.backups.restore(name)
        print(f"[backup] 복원: {name} (by {user['username']})", flush=True)
        # 복원된 파일을 다시 읽도록 메모리 캐시를 비운다.
        self.ctx.reload_stores()
        return self._json({"success": True, **result,
                           "shortcuts": self.ctx.shortcuts.all(),
                           "datacenters": self.ctx.datacenters.all(),
                           "users": self.ctx.users.public_list(),
                           "settings": self.ctx.settings.all()})

    # ================= 바로가기 변경(설정 세션 필요) =================

    def api_shortcut_create(self):
        if not self._require_session():
            return None
        created = self.ctx.shortcuts.add(self._body_dict())
        return self._json({"success": True, "shortcut": created,
                           "shortcuts": self.ctx.shortcuts.all()}, status=HTTPStatus.CREATED)

    def api_shortcut_update(self, shortcut_id):
        if not self._require_session():
            return None
        updated = self.ctx.shortcuts.update(shortcut_id, self._body_dict())
        if not updated:
            return self._error(HTTPStatus.NOT_FOUND, "바로가기를 찾을 수 없습니다.")
        return self._json({"success": True, "shortcut": updated,
                           "shortcuts": self.ctx.shortcuts.all()})

    def api_shortcut_delete(self, shortcut_id):
        if not self._require_session():
            return None
        if not self.ctx.shortcuts.delete(shortcut_id):
            return self._error(HTTPStatus.NOT_FOUND, "바로가기를 찾을 수 없습니다.")
        return self._json({"success": True, "shortcuts": self.ctx.shortcuts.all()})

    def api_shortcut_reset(self):
        if not self._require_session():
            return None
        return self._json({"success": True, "shortcuts": self.ctx.shortcuts.reset()})

    def api_shortcut_import(self):
        if not self._require_session():
            return None
        payload = self._read_json()
        entries = payload.get("shortcuts") if isinstance(payload, dict) else payload
        return self._json({"success": True, "shortcuts": self.ctx.shortcuts.replace_all(entries)})

    def api_export(self):
        if not self._require_session():
            return None
        body = json.dumps(self.ctx.shortcuts.all(), ensure_ascii=False, indent=2).encode("utf-8")
        return self._send(HTTPStatus.OK, body, "application/json; charset=utf-8", {
            "Content-Disposition": 'attachment; filename="dc-service-shortcuts.json"',
        })

    # ---------- 정적 파일 ----------

    def _serve_static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            return self._send_file(STATIC_DIR / "index.html")

        # '..' 이나 절대경로로 STATIC_DIR 밖을 읽지 못하게 정규화 후 재확인한다.
        relative = posixpath.normpath(path).lstrip("/")
        candidate = (STATIC_DIR / relative).resolve()
        try:
            candidate.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self._error(HTTPStatus.NOT_FOUND, "없는 경로입니다.")
        if candidate.suffix.lower() not in STATIC_SUFFIXES or not candidate.is_file():
            # SPA 해시 라우팅(#/settings 등)은 서버에 오지 않지만, 오탈자 경로는
            # 404 대신 첫 화면으로 보내 사용자가 막히지 않게 한다.
            return self._send_file(STATIC_DIR / "index.html")
        return self._send_file(candidate)

    def _send_file(self, file_path: Path) -> None:
        try:
            body = file_path.read_bytes()
        except OSError:
            return self._error(HTTPStatus.NOT_FOUND, "파일을 찾을 수 없습니다.")
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in (
                "application/javascript", "application/json"):
            content_type += "; charset=utf-8"
        return self._send(HTTPStatus.OK, body, content_type, {"Cache-Control": "no-cache"})

    # ---------- 로깅 ----------

    def log_message(self, fmt: str, *args) -> None:  # noqa: D102
        print(f"[hub] {self.address_string()} {fmt % args}", flush=True)


# 라우트 표 — (메서드, 패턴, 핸들러). 위에서부터 첫 일치를 쓴다.
ROUTES = [
    ("GET", _route(r"/api/meta"), HubHandler.api_meta),
    ("GET", _route(r"/api/shortcuts"), HubHandler.api_shortcuts),
    ("GET", _route(r"/api/datacenters"), HubHandler.api_datacenters),
    ("GET", _route(r"/api/health/latest"), HubHandler.api_health_latest),
    ("GET", _route(r"/api/health/history"), HubHandler.api_health_history),
    ("POST", _route(r"/api/health/check"), HubHandler.api_health_check),

    ("GET", _route(r"/api/settings/session"), HubHandler.api_session_get),
    ("POST", _route(r"/api/settings/session"), HubHandler.api_session_login),
    ("DELETE", _route(r"/api/settings/session"), HubHandler.api_session_logout),

    ("GET", _route(r"/api/settings"), HubHandler.api_settings_state),
    ("PUT", _route(r"/api/settings/(backup|health)"), HubHandler.api_settings_section),

    ("GET", _route(r"/api/settings/users"), HubHandler.api_users_list),
    ("POST", _route(r"/api/settings/users"), HubHandler.api_users_create),
    ("POST", _route(r"/api/settings/users/" + ID_PATTERN + r"/password"),
     HubHandler.api_users_password),
    ("PUT", _route(r"/api/settings/users/" + ID_PATTERN), HubHandler.api_users_update),
    ("DELETE", _route(r"/api/settings/users/" + ID_PATTERN), HubHandler.api_users_delete),

    ("POST", _route(r"/api/settings/datacenters/reset"), HubHandler.api_dc_reset),
    ("POST", _route(r"/api/settings/datacenters"), HubHandler.api_dc_create),
    ("PUT", _route(r"/api/settings/datacenters/" + ID_PATTERN), HubHandler.api_dc_update),
    ("DELETE", _route(r"/api/settings/datacenters/" + ID_PATTERN), HubHandler.api_dc_delete),

    ("GET", _route(r"/api/settings/backups"), HubHandler.api_backup_list),
    ("POST", _route(r"/api/settings/backups"), HubHandler.api_backup_create),
    ("POST", _route(r"/api/settings/backups/" + NAME_PATTERN + r"/restore"),
     HubHandler.api_backup_restore),
    ("GET", _route(r"/api/settings/backups/" + NAME_PATTERN), HubHandler.api_backup_download),
    ("DELETE", _route(r"/api/settings/backups/" + NAME_PATTERN), HubHandler.api_backup_delete),

    ("POST", _route(r"/api/shortcuts/reset"), HubHandler.api_shortcut_reset),
    ("POST", _route(r"/api/shortcuts"), HubHandler.api_shortcut_create),
    ("PUT", _route(r"/api/shortcuts/" + ID_PATTERN), HubHandler.api_shortcut_update),
    ("DELETE", _route(r"/api/shortcuts/" + ID_PATTERN), HubHandler.api_shortcut_delete),
    ("POST", _route(r"/api/import"), HubHandler.api_shortcut_import),
    ("GET", _route(r"/api/export"), HubHandler.api_export),
]


class HubServer(ThreadingHTTPServer):
    """요청마다 스레드 — 링크 점검이 몇 초 걸려도 화면 조회가 멈추지 않는다."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, ctx):
        super().__init__(address, handler)
        self.ctx = ctx


def create_server(host: str = None, port: int = None, ctx=None) -> HubServer:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    if ctx is None:
        from .app import AppContext
        ctx = AppContext()
    return HubServer((host or config.host, port if port is not None else config.port),
                     HubHandler, ctx)
