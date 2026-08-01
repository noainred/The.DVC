"""HTTP 서버 — 정적 페이지 + REST API.

프레임워크를 쓰지 않는 이유는 단순함이 아니라 **배포 제약** 때문이다. 이 포탈은
인터넷이 막힌 Rocky Linux 9 서버에 복사만으로 올라가야 하고, pip 설치가 불가능하다.
그래서 http.server(표준 라이브러리)로 필요한 만큼만 구현한다.
"""

from __future__ import annotations

import hmac
import json
import mimetypes
import posixpath
import re
import threading
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from . import health as health_mod
from .config import APP_NAME, STATIC_DIR, VERSION, config
from .datacenters import DATACENTERS, REGIONS, summary as dc_summary
from .defaults import CATEGORIES
from .ssrf import ValidationError
from .store import ShortcutStore

SHORTCUT_ID_RE = re.compile(r"^/api/shortcuts/([A-Za-z0-9_-]{1,64})$")

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

    def _error(self, status, message: str) -> None:
        self._json({"success": False, "error": message}, status=status)

    def _read_json(self):
        length_raw = self.headers.get("Content-Length", "0")
        try:
            length = int(length_raw)
        except ValueError:
            raise ValidationError("Content-Length 가 올바르지 않습니다.")
        if length < 0 or length > config.max_body_bytes:
            raise ValidationError("요청 본문이 너무 큽니다.")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValidationError("JSON 형식이 올바르지 않습니다.")

    # ---------- 인증(선택) ----------

    def _authorized(self) -> bool:
        """HUB_TOKEN 이 설정된 경우에만 검사한다(미설정이면 사내망 공개 운영)."""
        if not config.token:
            return True
        supplied = self.headers.get("X-Hub-Token", "")
        if not supplied:
            cookie_header = self.headers.get("Cookie", "")
            if cookie_header:
                jar = SimpleCookie()
                try:
                    jar.load(cookie_header)
                except Exception:  # noqa: BLE001 - 깨진 쿠키는 미인증으로 취급
                    jar = SimpleCookie()
                morsel = jar.get("hub_token")
                supplied = morsel.value if morsel else ""
        return bool(supplied) and hmac.compare_digest(supplied, config.token)

    # ---------- 라우팅 ----------

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            if not self._authorized():
                return self._error(HTTPStatus.UNAUTHORIZED, "접근 토큰이 필요합니다.")
            return self._api_get(path)
        return self._serve_static(path)

    do_HEAD = do_GET

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            return self._error(HTTPStatus.NOT_FOUND, "없는 경로입니다.")
        if not self._authorized():
            return self._error(HTTPStatus.UNAUTHORIZED, "접근 토큰이 필요합니다.")
        try:
            return self._api_post(path)
        except ValidationError as exc:
            return self._error(HTTPStatus.BAD_REQUEST, str(exc))

    def do_PUT(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if not self._authorized():
            return self._error(HTTPStatus.UNAUTHORIZED, "접근 토큰이 필요합니다.")
        match = SHORTCUT_ID_RE.match(path)
        if not match:
            return self._error(HTTPStatus.NOT_FOUND, "없는 경로입니다.")
        try:
            payload = self._read_json()
            updated = self.store.update(match.group(1), payload if isinstance(payload, dict) else {})
        except ValidationError as exc:
            return self._error(HTTPStatus.BAD_REQUEST, str(exc))
        if not updated:
            return self._error(HTTPStatus.NOT_FOUND, "바로가기를 찾을 수 없습니다.")
        return self._json({"success": True, "shortcut": updated, "shortcuts": self.store.all()})

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if not self._authorized():
            return self._error(HTTPStatus.UNAUTHORIZED, "접근 토큰이 필요합니다.")
        match = SHORTCUT_ID_RE.match(path)
        if not match:
            return self._error(HTTPStatus.NOT_FOUND, "없는 경로입니다.")
        if not self.store.delete(match.group(1)):
            return self._error(HTTPStatus.NOT_FOUND, "바로가기를 찾을 수 없습니다.")
        return self._json({"success": True, "shortcuts": self.store.all()})

    # ---------- API 구현 ----------

    def _api_get(self, path: str) -> None:
        if path == "/api/meta":
            return self._json({
                "success": True,
                "app": APP_NAME,
                "version": VERSION,
                "categories": CATEGORIES,
                "regions": list(REGIONS),
                "datacenterCount": len(DATACENTERS),
                "shortcutCount": len(self.store.all()),
                "healthTlsVerify": config.health_tls_verify,
            })
        if path == "/api/shortcuts":
            return self._json({"success": True, "shortcuts": self.store.all()})
        if path == "/api/datacenters":
            return self._json({
                "success": True,
                "datacenters": DATACENTERS,
                "summary": dc_summary(),
            })
        if path == "/api/export":
            body = json.dumps(self.store.all(), ensure_ascii=False, indent=2).encode("utf-8")
            return self._send(HTTPStatus.OK, body, "application/json; charset=utf-8", {
                "Content-Disposition": 'attachment; filename="dc-service-shortcuts.json"',
            })
        return self._error(HTTPStatus.NOT_FOUND, "없는 API 입니다.")

    def _api_post(self, path: str) -> None:
        if path == "/api/shortcuts":
            payload = self._read_json()
            if not isinstance(payload, dict):
                raise ValidationError("요청 본문이 올바르지 않습니다.")
            created = self.store.add(payload)
            return self._json({"success": True, "shortcut": created,
                               "shortcuts": self.store.all()}, status=HTTPStatus.CREATED)

        if path == "/api/shortcuts/reset":
            return self._json({"success": True, "shortcuts": self.store.reset()})

        if path == "/api/import":
            payload = self._read_json()
            entries = payload.get("shortcuts") if isinstance(payload, dict) else payload
            return self._json({"success": True, "shortcuts": self.store.replace_all(entries)})

        if path == "/api/health/check":
            payload = self._read_json()
            targets = self._health_targets(payload)
            if not targets:
                return self._json({"success": True, "results": []})
            results = health_mod.check_many(
                targets,
                timeout=config.health_timeout,
                concurrency=config.health_concurrency,
                tls_verify=config.health_tls_verify,
                allow_private=config.health_allow_private,
            )
            return self._json({"success": True, "results": results,
                               "checkedAt": self.date_time_string()})

        return self._error(HTTPStatus.NOT_FOUND, "없는 API 입니다.")

    def _health_targets(self, payload) -> list:
        """점검 대상 결정: ids 지정 → 그 항목만, 아니면 저장된 전체."""
        if isinstance(payload, dict):
            ids = payload.get("ids")
            if isinstance(ids, list) and ids:
                wanted = {str(value) for value in ids}
                return [{"id": item["id"], "url": item["url"]}
                        for item in self.store.all() if item["id"] in wanted]
            urls = payload.get("urls")
            if isinstance(urls, list) and urls:
                return [{"id": None, "url": str(value)} for value in urls[:200]]
        return [{"id": item["id"], "url": item["url"]} for item in self.store.all()]

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

    @property
    def store(self) -> ShortcutStore:
        return self.server.store  # type: ignore[attr-defined]


class HubServer(ThreadingHTTPServer):
    """요청마다 스레드 — 링크 점검이 몇 초 걸려도 화면 조회가 멈추지 않는다."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, store: ShortcutStore):
        super().__init__(address, handler)
        self.store = store
        self._lock = threading.Lock()


def create_server(host: str = None, port: int = None, store: ShortcutStore = None) -> HubServer:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    resolved_store = store or ShortcutStore(config.shortcuts_file)
    return HubServer((host or config.host, port if port is not None else config.port),
                     HubHandler, resolved_store)
