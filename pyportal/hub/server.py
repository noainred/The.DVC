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
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .auth import AuthError
from .catstore import COLORS as CATEGORY_COLORS, DEFAULT_CATEGORY_ID
from . import csvio
from .config import APP_NAME, STATIC_DIR, VERSION, config
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
    # 데이터를 보내지 않고 연결만 붙잡는 클라이언트(slowloris)가 스레드를 점유하지
    # 못하게 한다. keep-alive 유휴 연결도 이 시간이 지나면 닫힌다.
    timeout = 20

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

    def _is_read_method(self) -> bool:
        return self.command in ("GET", "HEAD")

    def _credential(self, header: str, cookie: str) -> str:
        """자격증명 조회 — **쿠키는 조회(GET/HEAD)에서만** 인정한다(6차 감사 수정).

        쿠키가 상태변경까지 인증하면 CSRF 가 성립한다. 브라우저는 `text/plain` 본문의
        교차출처 POST 를 프리플라이트 없이 보내고, 그 본문은 그대로 JSON 으로 파싱된다.
        상태변경에는 **커스텀 헤더**를 요구해 교차출처에서 붙일 수 없게 만든다.
        """
        value = self.headers.get(header, "")
        if not value and self._is_read_method():
            value = self._cookie(cookie)
        return value

    def _cross_site(self) -> bool:
        """교차출처 상태변경 차단(2차 방어). Origin 또는 Sec-Fetch-Site 로 판정한다."""
        site = (self.headers.get("Sec-Fetch-Site", "") or "").lower()
        if site and site not in ("same-origin", "same-site", "none"):
            return True
        origin = self.headers.get("Origin", "")
        if not origin:
            return False
        host = self.headers.get("Host", "")
        try:
            origin_host = urlsplit(origin).netloc
        except ValueError:
            return True
        return bool(host) and origin_host != host

    def _hub_token_ok(self) -> bool:
        """HUB_TOKEN 이 설정된 경우에만 검사한다(미설정이면 사내망 공개 운영)."""
        if not config.token:
            return True
        supplied = self._credential("X-Hub-Token", "hub_token")
        return bool(supplied) and hmac.compare_digest(supplied, config.token)

    def _session_user(self):
        return self.ctx.sessions.resolve(self._credential("X-Settings-Token", "hub_settings"))

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
            self._audit("denied", actor=user.get("username", "-"), result="forbidden",
                        detail={"path": urlsplit(self.path).path})
            self._error(HTTPStatus.FORBIDDEN, "admin 계정만 변경할 수 있습니다.")
            return None
        return user

    # ---------- 감사 로그 ----------

    def _audit(self, action, *, actor=None, result="ok", detail=None):
        """보안상 되짚어야 하는 사건만 남긴다(조회는 남기지 않는다 — 잡음).

        기록 실패가 요청을 막지 않도록 AuditLog 쪽이 best-effort 로 처리한다.
        """
        if actor is None:
            user = self._session_user()
            actor = user.get("username", "-") if user else "-"
        client = self.client_address[0] if self.client_address else "-"
        self.ctx.audit.write(action, actor=actor, client=client, result=result, detail=detail)

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

        if not self._is_read_method() and self._cross_site():
            return self._error(HTTPStatus.FORBIDDEN, "교차 출처 요청은 허용되지 않습니다.")

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
            "categories": self.ctx.categories.all(),
            "regions": ["APAC", "EMEA", "AMER", "LATAM"],
            "datacenterCount": len(self.ctx.datacenters.visible(
                self.ctx.settings.section("display").get("datacenterLimit", 0))),
            "datacenterRegistered": len(self.ctx.datacenters.all()),
            "shortcutCount": len(self.ctx.shortcuts.all()),
            "healthTlsVerify": config.health_tls_verify,
            # 메인 모니터링 포탈로 돌아가는 링크(설정된 경우에만). 등록된 바로가기 URL 이
            # 이미 공개 조회로 나가므로 이 주소만 따로 감출 이유는 없다.
            "portalUrl": config.portal_url,
            "historyRanges": [{"key": key, "label": RANGE_LABELS[key], "seconds": RANGES[key]}
                              for key in RANGES],
            "session": user,
            # 경로는 **로그인한 사용자에게만** 준다(6차 감사 수정). 미인증 응답에 절대경로를
            # 실으면 서버 구조가 드러나고, "초기 비밀번호가 아직 살아 있다"는 사실까지 알려
            # 공격자에게 표적을 지정해 주는 셈이 된다.
            "initialPasswordFile": (str(config.initial_password_file)
                                    if user and self.ctx.users.initial_password_present() else None),
            "setupPending": bool(self.ctx.users.initial_password_present()) if user else None,
        })

    def api_shortcuts(self):
        return self._json({"success": True, "shortcuts": self.ctx.shortcuts.all()})

    def api_datacenters(self):
        """공개 조회 — 설정의 '표시 개수'를 적용한 목록만 내려준다."""
        limit = self.ctx.settings.section("display").get("datacenterLimit", 0)
        visible = self.ctx.datacenters.visible(limit)
        return self._json({
            "success": True,
            "datacenters": visible,
            "summary": self.ctx.datacenters.summary(visible),
            "displayLimit": limit,
            "totalRegistered": len(self.ctx.datacenters.all()),
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

        # 임의 URL 점검은 '서버가 대신 요청을 보내 주는' 기능이라, 미인증으로 열어 두면
        # 사내망 포트 스캐너로 쓸 수 있다(응답코드·지연·오류메시지로 생사 판별).
        # 등록된 바로가기 재점검만 공개하고, urls 지정은 로그인 필수로 둔다(6차 감사 수정).
        wants_custom = isinstance(payload, dict) and isinstance(payload.get("urls"), list) \
            and bool(payload.get("urls"))
        if wants_custom and not self._require_session():
            return None
        if not wants_custom and not self._session_user():
            wait = self.ctx.public_check_cooldown()
            if wait > 0:
                return self._error(HTTPStatus.TOO_MANY_REQUESTS,
                                   f"점검 요청이 너무 잦습니다. {wait}초 후 다시 시도하세요.")

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
        client = self.client_address[0] if self.client_address else "-"
        remaining = self.ctx.sessions.lock_remaining(client)
        if remaining > 0:
            return self._error(HTTPStatus.TOO_MANY_REQUESTS,
                               f"로그인 시도가 많아 잠겼습니다. {remaining}초 후 다시 시도하세요.")
        payload = self._body_dict()
        username = payload.get("username")
        password = payload.get("password")
        user = self.ctx.users.authenticate(username if isinstance(username, str) else "",
                                           password if isinstance(password, str) else "")
        if not user:
            self.ctx.sessions.note_failure(client)
            print(f"[auth] 설정 로그인 실패 (from {client})", flush=True)
            self._audit("login", actor="-", result="fail")
            # 사용자명이 틀렸는지 비밀번호가 틀렸는지 구분해서 알리지 않는다(계정 열거 차단).
            return self._error(HTTPStatus.UNAUTHORIZED, "사용자명 또는 비밀번호가 올바르지 않습니다.")
        self.ctx.sessions.note_success(client)
        session = self.ctx.sessions.create(user)
        print(f"[auth] 설정 로그인: {user['username']}", flush=True)
        self._audit("login", actor=user["username"], detail={"role": user.get("role")})
        return self._json({"success": True, **session})

    def api_session_logout(self):
        token = self.headers.get("X-Settings-Token", "") or self._cookie("hub_settings")
        user = self.ctx.sessions.resolve(token)
        self.ctx.sessions.destroy(token)
        if user:
            self._audit("logout", actor=user.get("username", "-"))
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
        actor = self._require_admin()
        if not actor:
            return None
        updated = self.ctx.settings.update_section(section, self._body_dict())
        self._audit("settings.update", actor=actor["username"], detail={"section": section})
        return self._json({"success": True, "settings": self.ctx.settings.all(),
                           "section": section, "value": updated})

    def api_audit_list(self):
        """감사 로그 조회 — 계정·클라이언트가 드러나므로 admin 만."""
        if not self._require_admin():
            return None
        query = self._query()
        try:
            limit = int((query.get("limit") or ["200"])[0])
        except ValueError:
            limit = 200
        return self._json({"success": True, "entries": self.ctx.audit.tail(limit),
                           "file": str(self.ctx.data_dir / "audit.log")})

    def api_notify_test(self):
        """[테스트 전송] — 저장된(또는 입력한) 웹훅으로 예시 알림을 한 번 보낸다."""
        actor = self._require_admin()
        if not actor:
            return None
        payload = self._body_dict()
        url = payload.get("webhookUrl")
        if not isinstance(url, str) or not url.strip():
            url = self.ctx.settings.section("notify").get("webhookUrl", "")
        if not url:
            return self._error(HTTPStatus.BAD_REQUEST, "웹훅 URL 을 먼저 저장하거나 입력하세요.")
        result = self.ctx.notifier.test(url)
        self._audit("notify.test", actor=actor["username"],
                    result="ok" if result.get("ok") else "fail")
        if not result.get("ok"):
            return self._error(HTTPStatus.BAD_GATEWAY,
                               "웹훅 전송에 실패했습니다(URL·네트워크·차단 여부를 확인하세요).")
        return self._json({"success": True, **result})

    # ---- 사용자 ----

    def api_users_list(self):
        if not self._require_session():
            return None
        return self._json({"success": True, "users": self.ctx.users.public_list()})

    def api_users_create(self):
        actor = self._require_admin()
        if not actor:
            return None
        payload = self._body_dict()
        users = self.ctx.users.add(payload.get("username"), payload.get("role", "viewer"),
                                   payload.get("password", ""))
        self._audit("user.create", actor=actor["username"],
                    detail={"target": str(payload.get("username", ""))[:64],
                            "role": str(payload.get("role", "viewer"))[:16]})
        return self._json({"success": True, "users": users}, status=HTTPStatus.CREATED)

    def api_users_update(self, username):
        actor = self._require_admin()
        if not actor:
            return None
        payload = self._body_dict()
        users = self.ctx.users.update(username, role=payload.get("role"),
                                      enabled=payload.get("enabled"))
        if payload.get("enabled") is False:
            self.ctx.sessions.destroy_user(username)
        self._audit("user.update", actor=actor["username"],
                    detail={"target": username, "role": payload.get("role"),
                            "enabled": payload.get("enabled")})
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
        self._audit("user.password", actor=actor["username"], detail={"target": username})
        return self._json({"success": True, "users": self.ctx.users.public_list()})

    def api_users_delete(self, username):
        actor = self._require_admin()
        if not actor:
            return None
        if actor["username"] == username:
            return self._error(HTTPStatus.BAD_REQUEST, "로그인 중인 계정은 삭제할 수 없습니다.")
        users = self.ctx.users.delete(username)
        self.ctx.sessions.destroy_user(username)
        self._audit("user.delete", actor=actor["username"], detail={"target": username})
        return self._json({"success": True, "users": users})

    # ---- 데이터센터 ----

    def api_dc_list(self):
        """설정 편집용 — 표시 개수와 무관하게 **등록된 전부**를 준다."""
        if not self._require_session():
            return None
        return self._json({"success": True, "datacenters": self.ctx.datacenters.all(),
                           "displayLimit": self.ctx.settings.section("display")
                           .get("datacenterLimit", 0)})

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
        actor = self._require_admin()
        if not actor:
            return None
        self._audit("datacenter.reset", actor=actor["username"])
        return self._json({"success": True, "datacenters": self.ctx.datacenters.reset()})

    def api_dc_move(self, dc_id):
        if not self._require_admin():
            return None
        items = self.ctx.datacenters.move(dc_id, self._move_delta())
        if items is None:
            # 이미 맨 위/맨 아래 — 오류가 아니라 '변경 없음' 이다.
            return self._json({"success": True, "moved": False,
                               "datacenters": self.ctx.datacenters.all()})
        return self._json({"success": True, "moved": True, "datacenters": items})

    def _move_delta(self) -> int:
        direction = str(self._body_dict().get("direction", "up")).lower()
        if direction not in ("up", "down"):
            raise ValidationError("direction 은 up 또는 down 이어야 합니다.")
        return 1 if direction == "down" else -1

    # ---- 카테고리 ----

    def api_cat_list(self):
        if not self._require_session():
            return None
        return self._json({"success": True, "categories": self.ctx.categories.all(),
                           "colors": list(CATEGORY_COLORS),
                           "defaultId": DEFAULT_CATEGORY_ID})

    def api_cat_create(self):
        actor = self._require_admin()
        if not actor:
            return None
        created = self.ctx.categories.add(self._body_dict())
        self._audit("category.create", actor=actor["username"], detail={"id": created["id"]})
        return self._json({"success": True, "category": created,
                           "categories": self.ctx.categories.all()}, status=HTTPStatus.CREATED)

    def api_cat_update(self, cat_id):
        if not self._require_admin():
            return None
        updated = self.ctx.categories.update(cat_id, self._body_dict())
        if not updated:
            return self._error(HTTPStatus.NOT_FOUND, "카테고리를 찾을 수 없습니다.")
        return self._json({"success": True, "category": updated,
                           "categories": self.ctx.categories.all()})

    def api_cat_delete(self, cat_id):
        actor = self._require_admin()
        if not actor:
            return None
        if not self.ctx.categories.delete(cat_id):
            return self._error(HTTPStatus.NOT_FOUND, "카테고리를 찾을 수 없습니다.")
        # 그 카테고리를 쓰던 바로가기는 사라지면 안 된다 — 기본 카테고리로 옮긴다.
        moved = self.ctx.shortcuts.reassign_category(cat_id, DEFAULT_CATEGORY_ID)
        self._audit("category.delete", actor=actor["username"],
                    detail={"id": cat_id, "movedShortcuts": moved})
        return self._json({"success": True, "categories": self.ctx.categories.all(),
                           "shortcuts": self.ctx.shortcuts.all(), "movedShortcuts": moved})

    def api_cat_move(self, cat_id):
        if not self._require_admin():
            return None
        items = self.ctx.categories.move(cat_id, self._move_delta())
        if items is None:
            return self._json({"success": True, "moved": False,
                               "categories": self.ctx.categories.all()})
        return self._json({"success": True, "moved": True, "categories": items})

    def api_cat_reset(self):
        actor = self._require_admin()
        if not actor:
            return None
        categories = self.ctx.categories.reset()
        # 복원된 목록에 없는 카테고리를 참조하던 바로가기를 정리한다.
        self.ctx.shortcuts.reassign_missing({cat["id"] for cat in categories},
                                            DEFAULT_CATEGORY_ID)
        self._audit("category.reset", actor=actor["username"])
        return self._json({"success": True, "categories": categories,
                           "shortcuts": self.ctx.shortcuts.all()})

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
        self._audit("backup.create", detail={"name": result["name"]})
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
        self._audit("backup.download", actor=user["username"], detail={"name": str(name)[:80]})
        body = json.dumps(snapshot, ensure_ascii=False, indent=2).encode("utf-8")
        return self._send(HTTPStatus.OK, body, "application/json; charset=utf-8", {
            "Content-Disposition": f'attachment; filename="{Path(str(name)).name}"',
        })

    def api_backup_delete(self, name):
        actor = self._require_admin()
        if not actor:
            return None
        if not self.ctx.backups.delete(name):
            return self._error(HTTPStatus.NOT_FOUND, "백업을 찾을 수 없습니다.")
        self._audit("backup.delete", actor=actor["username"], detail={"name": str(name)[:80]})
        return self._json({"success": True, "backups": self.ctx.backups.list(),
                           "status": self.ctx.backups.status()})

    def api_backup_restore(self, name):
        user = self._require_admin()
        if not user:
            return None
        result = self.ctx.backups.restore(name)
        print(f"[backup] 복원: {name} (by {user['username']})", flush=True)
        self._audit("backup.restore", actor=user["username"], detail={"name": str(name)[:80]})
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

    def api_shortcut_move(self, shortcut_id):
        if not self._require_session():
            return None
        items = self.ctx.shortcuts.move(shortcut_id, self._move_delta())
        if items is None:
            return self._json({"success": True, "moved": False,
                               "shortcuts": self.ctx.shortcuts.all()})
        return self._json({"success": True, "moved": True, "shortcuts": items})

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
        """JSON 가져오기. mode=replace 면 통째로 교체, append 면 뒤에 덧붙인다(같은 URL 건너뜀).
        하위호환: 옛 클라이언트/스크립트가 mode 없이(또는 배열 그대로) 보내면 기존 동작(교체)."""
        user = self._require_session()
        if not user:
            return None
        payload = self._read_json()
        entries = payload.get("shortcuts") if isinstance(payload, dict) else payload
        mode = str(payload.get("mode", "replace")).lower() if isinstance(payload, dict) else "replace"
        if mode == "append":
            shortcuts, added, skipped = self.ctx.shortcuts.append_many(entries)
        else:
            shortcuts = self.ctx.shortcuts.replace_all(entries)
            added, skipped = len(shortcuts), 0
        self._audit("shortcuts.import", actor=user["username"],
                    detail={"format": "json", "mode": mode if mode == "append" else "replace",
                            "added": added, "skipped": skipped})
        return self._json({"success": True, "shortcuts": shortcuts,
                           "added": added, "skipped": skipped})

    def api_export(self):
        if not self._require_session():
            return None
        body = json.dumps(self.ctx.shortcuts.all(), ensure_ascii=False, indent=2).encode("utf-8")
        return self._send(HTTPStatus.OK, body, "application/json; charset=utf-8", {
            "Content-Disposition": 'attachment; filename="dc-service-shortcuts.json"',
        })

    def api_export_csv(self):
        """엑셀에서 바로 열 수 있는 CSV. 백업 용도로도 쓴다."""
        if not self._require_session():
            return None
        body = csvio.export_csv(self.ctx.shortcuts.all()).encode("utf-8")
        return self._send(HTTPStatus.OK, body, "text/csv; charset=utf-8", {
            "Content-Disposition": 'attachment; filename="dc-service-shortcuts.csv"',
        })

    def api_import_csv(self):
        """CSV 가져오기. mode=append(기본)면 뒤에 덧붙이고, replace 면 통째로 교체한다."""
        user = self._require_session()
        if not user:
            return None
        payload = self._body_dict()
        entries = csvio.parse_csv(payload.get("csv"))
        if not entries:
            return self._error(HTTPStatus.BAD_REQUEST,
                               "가져올 수 있는 행이 없습니다(name·url 열을 확인하세요).")
        replace = str(payload.get("mode", "append")).lower() == "replace"
        if replace:
            shortcuts = self.ctx.shortcuts.replace_all(entries)
            added, skipped = len(shortcuts), 0
        else:
            shortcuts, added, skipped = self.ctx.shortcuts.append_many(entries)
        self._audit("shortcuts.import", actor=user["username"],
                    detail={"mode": "replace" if replace else "append",
                            "rows": len(entries), "added": added, "skipped": skipped})
        return self._json({"success": True, "shortcuts": shortcuts,
                           "added": added, "skipped": skipped, "rows": len(entries)})

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

    def log_error(self, fmt: str, *args) -> None:  # noqa: D102
        message = fmt % args
        # keep-alive 유휴 연결이 타임아웃으로 닫히는 것은 정상 동작이다 —
        # 오류로 찍으면 운영 로그가 무의미한 줄로 가득 찬다.
        if "timed out" in message:
            return
        self.log_message("ERROR %s", message)

    def log_message(self, fmt: str, *args) -> None:  # noqa: D102
        # 요청 라인은 클라이언트가 마음대로 넣는 값이다 — 제어문자/ANSI 이스케이프가
        # 그대로 찍히면 로그를 위조·오염시킬 수 있어 출력 전에 escape 한다.
        line = (fmt % args).encode("unicode_escape").decode("ascii", "replace")
        print(f"[hub] {self.address_string()} {line}", flush=True)


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
    ("GET", _route(r"/api/settings/audit"), HubHandler.api_audit_list),
    ("POST", _route(r"/api/settings/notify/test"), HubHandler.api_notify_test),
    ("PUT", _route(r"/api/settings/(backup|health|display|notify)"),
     HubHandler.api_settings_section),

    ("GET", _route(r"/api/settings/users"), HubHandler.api_users_list),
    ("POST", _route(r"/api/settings/users"), HubHandler.api_users_create),
    ("POST", _route(r"/api/settings/users/" + ID_PATTERN + r"/password"),
     HubHandler.api_users_password),
    ("PUT", _route(r"/api/settings/users/" + ID_PATTERN), HubHandler.api_users_update),
    ("DELETE", _route(r"/api/settings/users/" + ID_PATTERN), HubHandler.api_users_delete),

    ("GET", _route(r"/api/settings/datacenters"), HubHandler.api_dc_list),
    ("POST", _route(r"/api/settings/datacenters/reset"), HubHandler.api_dc_reset),
    ("POST", _route(r"/api/settings/datacenters/" + ID_PATTERN + r"/move"),
     HubHandler.api_dc_move),
    ("POST", _route(r"/api/settings/datacenters"), HubHandler.api_dc_create),
    ("PUT", _route(r"/api/settings/datacenters/" + ID_PATTERN), HubHandler.api_dc_update),
    ("DELETE", _route(r"/api/settings/datacenters/" + ID_PATTERN), HubHandler.api_dc_delete),

    ("GET", _route(r"/api/settings/categories"), HubHandler.api_cat_list),
    ("POST", _route(r"/api/settings/categories/reset"), HubHandler.api_cat_reset),
    ("POST", _route(r"/api/settings/categories/" + ID_PATTERN + r"/move"), HubHandler.api_cat_move),
    ("POST", _route(r"/api/settings/categories"), HubHandler.api_cat_create),
    ("PUT", _route(r"/api/settings/categories/" + ID_PATTERN), HubHandler.api_cat_update),
    ("DELETE", _route(r"/api/settings/categories/" + ID_PATTERN), HubHandler.api_cat_delete),

    ("GET", _route(r"/api/settings/backups"), HubHandler.api_backup_list),
    ("POST", _route(r"/api/settings/backups"), HubHandler.api_backup_create),
    ("POST", _route(r"/api/settings/backups/" + NAME_PATTERN + r"/restore"),
     HubHandler.api_backup_restore),
    ("GET", _route(r"/api/settings/backups/" + NAME_PATTERN), HubHandler.api_backup_download),
    ("DELETE", _route(r"/api/settings/backups/" + NAME_PATTERN), HubHandler.api_backup_delete),

    ("POST", _route(r"/api/shortcuts/reset"), HubHandler.api_shortcut_reset),
    ("POST", _route(r"/api/shortcuts/" + ID_PATTERN + r"/move"), HubHandler.api_shortcut_move),
    ("POST", _route(r"/api/shortcuts"), HubHandler.api_shortcut_create),
    ("PUT", _route(r"/api/shortcuts/" + ID_PATTERN), HubHandler.api_shortcut_update),
    ("DELETE", _route(r"/api/shortcuts/" + ID_PATTERN), HubHandler.api_shortcut_delete),
    ("POST", _route(r"/api/import"), HubHandler.api_shortcut_import),
    ("POST", _route(r"/api/import/csv"), HubHandler.api_import_csv),
    ("GET", _route(r"/api/export"), HubHandler.api_export),
    ("GET", _route(r"/api/export/csv"), HubHandler.api_export_csv),
]


class HubServer(ThreadingHTTPServer):
    """요청마다 스레드 — 링크 점검이 몇 초 걸려도 화면 조회가 멈추지 않는다.

    스레드 수에 상한을 둔다(6차 감사). 연결 하나당 스레드 하나를 무제한으로 만들면
    미인증 연결만으로 메모리·FD 를 고갈시킬 수 있다.
    """

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, address, handler, ctx, max_connections: int = 64):
        super().__init__(address, handler)
        self.ctx = ctx
        self._slots = threading.BoundedSemaphore(max_connections)

    def process_request_thread(self, request, client_address):
        if not self._slots.acquire(timeout=5):
            # 상한을 넘으면 새 연결을 기다리게 하지 않고 즉시 끊는다(큐가 무한정 늘지 않게).
            self.shutdown_request(request)
            return
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def create_server(host: str = None, port: int = None, ctx=None) -> HubServer:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    if ctx is None:
        from .app import AppContext
        ctx = AppContext()
    return HubServer((host or config.host, port if port is not None else config.port),
                     HubHandler, ctx)
