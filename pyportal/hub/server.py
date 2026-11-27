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
import io
import json
import mimetypes
import posixpath
import re
import socket
import sqlite3
import time
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .auth import AuthError
from .catstore import COLORS as CATEGORY_COLORS, DEFAULT_CATEGORY_ID, slugify as cat_slugify
from . import csvio
from .config import APP_NAME, STATIC_DIR, VERSION, config
from .history import RANGE_LABELS, RANGES
from .inbound import SLOW_PHASES, TRUSTED_PHASES, ConnPhase, InboundDeadline, PhaseReader, PhaseWriter
from .jsonfile import load_error_text
from .settings import BACKUP_INTERVAL_CHOICES, HEALTH_INTERVAL_CHOICES
from .ssrf import ValidationError

# 정적 자산은 이 확장자만 서빙한다(데이터 파일이 실수로 노출되지 않게).
STATIC_SUFFIXES = {".html", ".css", ".js", ".svg", ".png", ".ico", ".webmanifest",
                   ".woff2",  # 번들 폰트(v2.224) — static/fonts/
                   ".txt"}    # 폰트 라이선스 고지(LICENSE-Pretendard.txt)

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
# 전체 점검 31회차 F1(재현): 사용자 라우트는 ID_PATTERN 을 쓰면 안 된다 — 계정 생성은 1~64자 아무 글자나 받는데(`.`·`@`·한글)
#   관리 라우트가 [A-Za-z0-9_-] 만 받아 그런 계정은 로그인은 되지만 중지·삭제·비밀번호 변경이 전부 404 였다(퇴사자 계정을 폐기할 수 없음).
#   퍼센트 인코딩된 한 경로 조각을 받아 핸들러가 디코드한다(_user_arg — 64자 넘으면 404).
USER_PATTERN = r"([^/]{1,800})"


def _route(pattern: str):
    return re.compile("^" + pattern + "$")


def _reject_lone_surrogates(value) -> None:
    """전체 점검 117회차 F3(재현): JSON 은 짝 없는 서로게이트("\\ud800" — 잘린 이모지 등)를 그대로 str 로 읽지만 UTF-8 로는 쓸 수 없다.
    저장소는 메모리 목록을 먼저 바꾼 뒤 파일에 쓰므로, viewer 가 그런 이름의 바로가기를 하나 만들면 저장은 400 으로 실패하고 **메모리에만 남아**
    공개 GET /api/shortcuts · 내보내기가 전부 400(대시보드 빈 화면), 그 뒤의 모든 바로가기 저장도 400 이었다(재기동 전까지 — 임시 파일도 남음).
    들어오는 경계에서 막는다 — 요청 본문과 서버 파일 가져오기(JSON)가 이 함수를 지난다."""
    try:
        json.dumps(value, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        raise ValidationError("저장할 수 없는 문자가 들어 있습니다(짝이 맞지 않는 서로게이트 — 잘린 이모지 등). 그 글자를 지우고 다시 시도하세요.") from None
    except (ValueError, RecursionError):
        pass   # NaN · 순환 등은 이 검사의 대상이 아니다(각 저장소의 정규화가 다룬다)


class HubHandler(BaseHTTPRequestHandler):
    server_version = f"GlobalDCServiceHub/{VERSION}"
    protocol_version = "HTTP/1.1"
    # keep-alive 유휴 시한(recv 1회 단위 소켓 시한). 이것만으로는 1바이트씩 흘리는 연결이 끊기지 않는다 —
    # 요청 줄·헤더·본문의 전체 시한은 아래 단계 시한(보안 잔여 11-27 L12 — hub/inbound.py)이 맡는다.
    timeout = 20

    # ---------- 수신 단계 시한(보안 잔여 11-27 L12) ----------

    def setup(self):
        super().setup()
        stock = self.rfile
        seat = getattr(self.server, "conn_phase", None)
        self._conn = (seat(self.request) if seat is not None else None) or ConnPhase()
        self._rx = PhaseReader(self.connection, self.timeout, tracker=self._conn)
        self.rfile = io.BufferedReader(self._rx, io.DEFAULT_BUFFER_SIZE)
        stock.close()   # makefile 참조를 명시적으로 돌려준다(CPython 은 참조 수로도 닫지만 그것에 기대지 않는다)
        # 반증 1회차 M1: 응답 쓰기도 단계 시한 — base(헤더 시한) + 보낸 바이트/최저 속도, 상한(본문과 같은 값).
        self._tx = PhaseWriter(self.connection, self.timeout, tracker=self._conn,
                               auto=(self._srv_value("header_timeout", config.header_timeout),
                                     self._srv_value("body_min_rate", config.body_min_rate),
                                     self._srv_value("body_timeout_max", config.body_timeout_max)))
        self.wfile = self._tx
        self._first_request = True

    def _note_drop(self, kind) -> None:
        """연결 보호 집계 — 서버가 자리를 되찾으려고 끊은 연결(shed)은 서버가 이미 셌다."""
        if self._conn.shed:
            return
        note = getattr(self.server, "note_inbound_drop", None)
        if note:
            note(kind)

    def _srv_value(self, name, fallback):
        value = getattr(self.server, name, None)
        return fallback if value is None else value

    def handle_one_request(self):
        """요청 하나 — 유휴 대기와 헤더 단계를 나눈다.

        - 새 연결의 첫 요청: 입장(스레드 시작) 시각부터 헤더 시한 — 아무것도 안 보내는 연결이 유휴 20초 + 헤더 시한을 쥐지 못하게.
        - keep-alive 다음 요청: 유휴 대기(소켓 시한 20초 · 무로그)는 세지 않고, 첫 바이트부터 헤더 시한.
        - 유휴 상태에서는 서버의 입장 표에 '유휴' 로 올라, 자리가 가득 찼을 때 오래 쉰 연결부터 되찾을 수 있다(서버 conn_idle/conn_busy).
          요청을 마친 연결이 스스로 자리를 넘기지는 않는다(반증 1회차 M1 — 넘기면 공격 중 정상 keep-alive 만 끊겼다).
        - 시한 초과는 응답 없이 닫는다(요청 줄도 못 받았을 수 있다 — send_error 가 이전 요청 속성을 쓰게 된다).
        """
        rx = self._rx
        srv = self.server
        first = self._first_request
        self._first_request = False
        rx.end()
        self._tx.end()
        self._conn.trusted = False
        self._conn.user = None
        header_timeout = self._srv_value("header_timeout", config.header_timeout)
        try:
            if first:
                # 입장 시각부터(반증 2회차 R2-1 — 서버가 자리를 잡으면서 ConnPhase 를 헤더 단계로 열어 둔다. 스레드 시작 지연만큼
                #   헤더 시한이 늘거나, 그사이 '처리 중' 으로 보여 되찾기 예측에서 빠지지 않게).
                conn = self._conn
                rx.begin("header", header_timeout, started=conn.started if conn.phase == "header" else None)
                got = self.rfile.peek(1)
            else:
                conn_idle = getattr(srv, "conn_idle", None)
                if conn_idle is not None and not conn_idle(self.request):
                    self.close_connection = True   # 이미 자리를 되찾긴 연결
                    return
                got = self.rfile.peek(1)            # 유휴 대기 — 버퍼에 남은 파이프라인 바이트가 있으면 바로 돌아온다
                conn_busy = getattr(srv, "conn_busy", None)
                if got and conn_busy is not None and not conn_busy(self.request):
                    self.close_connection = True   # 대기 중 내보내졌다(자리 가득)
                    return
                if got:
                    rx.begin("header", header_timeout)
        except InboundDeadline:
            self.close_connection = True           # 새 연결이 아무것도 보내지 않았다
            self._note_drop("silent")
            rx.end()
            return
        except OSError:
            self.close_connection = True           # 유휴 시한(socket.timeout 은 OSError 하위)·리셋 — 정상 종료, 로그 없음
            rx.end()
            return
        if not got:
            self.close_connection = True
            rx.end()
            return
        try:
            super().handle_one_request()
        except InboundDeadline as exc:
            self.close_connection = True
            self._note_drop(exc.phase)
        except ConnectionError:
            # 상대가 요청 도중 끊었다(리셋 · 깨진 파이프) — 서버 오류가 아니다. 예전에는 stdlib 가 연결마다 traceback 을 찍어
            #   미인증 연결이 RST 만으로 로그를 채울 수 있었다(되찾기 · 시한으로 끊긴 공격 연결이 다시 붙을 때 흔하다).
            self.close_connection = True
        finally:
            rx.end()
            self._tx.end()

    def parse_request(self):
        ok = super().parse_request()
        if ok and self._rx.eof_in_phase:
            # 빈 줄 대신 EOF 로 끝난 헤더 — 요청을 다 받지 못했다(상대가 닫았거나 서버가 자리를 되찾았다). 처리하지도 응답하지도 않는다.
            self.close_connection = True
            self._note_drop("eof")
            return False
        if ok:
            # 헤더를 다 받았다 — 헤더 단계를 닫는다. 열어 두면 본문 없는 요청의 처리 시간이 '헤더 단계' 로 보여 서버가 처리 중인
            # 연결을 자리 되찾기 대상으로 고른다(본문 단계는 _drain_body 가 따로 연다).
            self._rx.end()
        return ok

    def _reply_and_linger(self, status, message, **extra) -> None:
        """라우팅하지 않고 오류로 답한 뒤 연결을 닫는다.

        상대가 아직 본문을 보내는 중에 읽지 않은 데이터를 남긴 채 닫으면 커널이 RST 를 보내고, RST 를 받으면 아직 읽지 않은 응답을
        버리는 클라이언트 스택이 있다(Apache lingering close 와 같은 이유 — 리눅스 루프백 실측에서는 응답이 남았다) —
        SHUT_WR 뒤 짧게(1초 · 64KiB) 읽어 버린다. 쓰기는 2초 시한(응답을 받아 가지 않는 상대에게 20초 묶이지 않게).
        """
        self.close_connection = True
        payload = {"success": False, "error": message}
        payload.update(extra)
        tx = self._tx
        tx.end()
        tx.begin("write", 2.0)
        try:
            self._json(payload, status=status, extra_headers={"Connection": "close"})
        except (InboundDeadline, OSError):
            pass
        finally:
            tx.end()
        try:
            self.connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        rx = self._rx
        rx.begin("linger", 1.0)
        try:
            drained = 0
            while drained < 65536:
                chunk = self.rfile.read1(65536)
                if not chunk:
                    break
                drained += len(chunk)
        except (InboundDeadline, OSError, ValueError):
            pass
        finally:
            rx.end()

    # ---------- 응답 헬퍼 ----------

    def _send(self, status, body: bytes, content_type: str, extra_headers: dict = None) -> None:
        self._response_started = True   # v2.768(R3-C3-3): _dispatch 최종 except 가 이중 응답을 쓰지 않게
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
        # chunked 전송(Transfer-Encoding)은 Content-Length 가 없어 여기서 길이를 못 구한다.
        # 그대로 두면 인코딩된 본문이 소켓에 남아 다음 요청 파싱과 섞인다(keep-alive desync,
        # 501 오류). 청크 디코딩을 직접 구현하는 대신 연결을 재사용하지 않는다(브라우저 프론트는
        # 항상 Content-Length 를 보내므로 영향 없음 — 서드파티/자동화 클라이언트만 해당).
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._body_raw = b""
            self._body_error = "chunked 전송은 지원하지 않습니다(Content-Length 필요)."
            return
        # 보안 잔여 11-27 L12: Content-Length 는 엄격히(RFC 9112 §6.3) — int() 는 '1_0'·'+5'·' -1' 을 받아들이고, 잘못된 값에도 연결을
        #   재사용해 남은 바이트가 다음 요청으로 파싱됐다. 서로 다른 중복 · 숫자 밖 · 12자리 초과는 라우팅 전 400 + 연결 종료.
        #   반증 1회차 N1: 앞뒤 공백은 OWS(SP · HTAB)만 — str.strip() 은 '\xa0'·'\x0b'·'\x1c' 까지 지워 '2\xa0' 를 2 로 받았다.
        values = [str(v).strip(" \t") for v in (self.headers.get_all("Content-Length") or [])]
        if not values:
            values = ["0"]
        if len(set(values)) != 1 or not re.fullmatch(r"[0-9]{1,12}", values[0]):
            self.close_connection = True
            self._body_raw = b""
            self._body_error = "Content-Length 가 올바르지 않습니다."
            self._body_reject = (HTTPStatus.BAD_REQUEST, self._body_error, {})
            return
        length = int(values[0])
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
        preauth = min(self._srv_value("preauth_max_body", config.preauth_max_body), config.max_body_bytes)
        if length > preauth and not self._conn.trusted:
            # 반증 1회차 S2: 로그인 세션이 없는 요청의 큰 본문은 **읽기 전에** 거절한다. 본문을 받는 미인증 라우트는 로그인 ·
            #   공개 재점검뿐이라(수 KB) 큰 본문은 쓸 데가 없고, 읽어 주면 최저 속도를 겨우 넘겨 보내는 연결이 자리를 74초씩 쥔다
            #   (없는 경로로도). 본문을 남긴 채 닫으므로 keep-alive desync 는 없다(연결 종료 + 린저).
            self.close_connection = True
            self._body_raw = b""
            path = urlsplit(self.path).path
            if not path.startswith("/api/"):
                self._body_reject = (HTTPStatus.NOT_FOUND, "없는 경로입니다.", {})
            elif not self._hub_token_ok():
                self._body_reject = (HTTPStatus.UNAUTHORIZED, "접근 토큰이 필요합니다.", {"code": "hub_token_required"})
            else:
                self._body_reject = (HTTPStatus.UNAUTHORIZED,
                                     "로그인하지 않은 요청의 본문은 {} KB 까지입니다. 설정 비밀번호로 로그인해야 합니다."
                                     .format(max(1, int(preauth) // 1024)),
                                     {"code": "settings_login_required"})
            self._body_error = self._body_reject[1]
            return
        # 본문 단계 시한: 헤더 시한 + 받은 바이트/최저 속도(상한) — 선언한 길이로 늘리지 않는다(1바이트 드립이 상한까지 쥐지 못하게).
        rx = self._rx
        base = self._srv_value("header_timeout", config.header_timeout)
        rate = self._srv_value("body_min_rate", config.body_min_rate)
        cap = self._srv_value("body_timeout_max", config.body_timeout_max)
        rx.begin("body", base, min_rate=rate, cap=cap)
        try:
            raw = self.rfile.read(length)
        except InboundDeadline:
            self.close_connection = True
            self._body_raw = b""
            self._body_error = "요청 본문을 제시간에 다 받지 못했습니다."
            self._note_drop("body")
            self._body_reject = (HTTPStatus.REQUEST_TIMEOUT,
                                 "요청 본문을 제시간에 다 받지 못했습니다(초당 최소 {} KB · 최대 {}초). "
                                 "네트워크 상태를 확인한 뒤 다시 시도하세요.".format(int(rate) // 1024, int(cap)),
                                 {"code": "request_timeout"})
            return
        finally:
            rx.end()
        if len(raw) < length:
            # 끝까지 오지 않은 본문(상대가 중간에 닫음) — 앞부분이 유효한 JSON·CSV 라도 처리하지 않는다.
            self.close_connection = True
            self._body_raw = b""
            if self._conn.shed:
                self._body_drop = True   # 서버가 자리를 되찾으려고 끊었다 — 응답하지 않는다
                return
            self._body_error = "요청 본문이 끝까지 오지 않았습니다(연결이 중간에 끊김)."
            self._body_reject = (HTTPStatus.BAD_REQUEST, self._body_error, {})
            return
        self._body_raw = raw
        self._body_error = None

    def _read_json(self):
        if getattr(self, "_body_error", None):
            raise ValidationError(self._body_error)
        raw = getattr(self, "_body_raw", b"")
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValidationError("JSON 형식이 올바르지 않습니다.")
        except RecursionError:
            # 전체 점검 117회차 F4(재현): 깊게 중첩된 본문('[' 20만 개)은 RecursionError(ValueError 아님)라 미인증 요청 한 번마다
            #   500 + traceback 이 콘솔에 쌓였다(POST /api/health/check 는 로그인 없이 본문을 읽는다) — 형식 오류 400 으로.
            raise ValidationError("JSON 형식이 올바르지 않습니다(중첩이 너무 깊습니다).") from None
        if b"\\u" in raw:
            _reject_lone_surrogates(payload)
        return payload

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
        """HUB_TOKEN 이 설정된 경우에만 검사한다(미설정이면 사내망 공개 운영).

        v2.500(감사 L1): `hmac.compare_digest` 는 str 인자가 비-ASCII 면 TypeError 를 던진다
        (파이썬 사양). 헤더는 latin-1 로 디코딩되므로 `X-Hub-Token: évil` 한 줄이면 발생했고,
        이 호출이 _dispatch 의 try 밖이라 잡히지 않아 **응답 없이 연결이 끊겼다**(실측).
        바이트로 비교해 그 경로를 없앤다 — 불일치는 그냥 False 다.
        """
        if not config.token:
            return True
        supplied = self._credential("X-Hub-Token", "hub_token")
        if not supplied:
            return False
        try:
            return hmac.compare_digest(str(supplied).encode("utf-8", "surrogateescape"),
                                       str(config.token).encode("utf-8", "surrogateescape"))
        except (TypeError, ValueError, UnicodeError):
            return False

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
        self._response_started = False   # keep-alive 로 같은 핸들러가 여러 요청을 처리한다 — 요청마다 초기화
        self._body_reject = None
        self._body_drop = False
        self._tx.end()   # 'Expect: 100-continue' 의 100 응답이 연 쓰기 단계를 닫는다(본문 수신 · 처리 시간을 쓰기 시한에 세지 않게)
        # 반증 1회차 S2 · M1: 로그인 세션을 가진 요청인지 — 큰 본문 허용 · 자리 되찾기 제외에 쓴다(판정 실패는 미인증으로).
        #   반증 2회차 S: 계정도 적는다 — 되찾기 제외는 계정당 몇 개까지(HubServer.trusted_slow_per_user)라 viewer 계정 하나로 64칸을 못 쥔다.
        try:
            user = self._session_user() if self._hub_token_ok() else None
            self._conn.trusted = bool(user)
            self._conn.user = str(user.get("username", "")) if user else None
        except Exception:  # noqa: BLE001 — 신뢰 판정일 뿐이다(라우트가 같은 판정을 다시 하고 오류는 그쪽에서 답한다)
            self._conn.trusted = False
            self._conn.user = None
        self._drain_body()
        if self._body_drop:
            return None
        if self._body_reject:
            # 보안 잔여 11-27 L12: 본문 시한 초과(408)·끝까지 오지 않은 본문·잘못된 Content-Length(400)는 라우팅하지 않는다.
            status, message, extra = self._body_reject
            return self._reply_and_linger(status, message, **extra)
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
            except InboundDeadline:
                raise   # 보안 잔여 11-27 L12: 쓰기 시한 · 자리 되찾기 — 500 을 덧쓰지 않고 핸들러가 조용히 닫는다
            except Exception as exc:  # noqa: BLE001
                # v2.768(점검 R3-C3-3·C3-6): 위 목록 밖 예외(http.client.HTTPException·csv.Error 등)는 예전에
                # 응답 없이 연결을 끊었다(화면은 원인 대신 네트워크 오류). 원문은 응답에 싣지 않고(내부 경로·
                # 대상 응답 조각이 섞일 수 있다) 서버 콘솔에만 남긴 뒤(예전 socketserver 기본 처리와 같은 traceback)
                # 500 JSON 으로 답한다.
                # 이미 응답을 쓰기 시작했거나 클라이언트가 끊은 경우에는 덧쓰지 않고 연결만 닫는다.
                self.close_connection = True
                self.log_message("ERROR unhandled %s in %s %s", type(exc).__name__, method, path)
                traceback.print_exc()
                if getattr(self, "_response_started", False) or isinstance(exc, ConnectionError):
                    return None
                return self._error(HTTPStatus.INTERNAL_SERVER_ERROR,
                                   "서버 내부 오류로 요청을 처리하지 못했습니다.", code="internal_error")
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
            # 47회차 #6: 분류 · 바로가기 파일을 못 읽었으면 화면이 '0개 · 없음' 대신 못 읽음을 밝힌다(상태만 — 경로는 싣지 않는다)
            "loadErrors": {k: v for k, v in (("categories", self.ctx.categories.load_error()),
                                             ("shortcuts", self.ctx.shortcuts.load_error())) if v} or None,
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
            # 35회차 R4: 경로(데이터 폴더 절대경로)는 admin 에게만 — 그 밖의 로그인 사용자는 있음 여부만(true).
            "initialPasswordFile": ((str(config.initial_password_file) if user.get("role") == "admin" else True)
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
            # 46회차 H2: 목록을 못 읽었으면 '0곳' 이 아니라 못 읽음(손상 · 읽기 오류 — 내장 샘플을 대신 보이지 않는다)
            "loadError": self.ctx.datacenters.load_error(),
        })

    def _latest_alive(self):
        # 삭제된 바로가기의 이력은 차트에는 남기되 '최근 상태' 표에는 띄우지 않는다.
        alive = {item["id"] for item in self.ctx.shortcuts.all()}
        return [row for row in self.ctx.history.latest().values() if row["id"] in alive]

    def api_health_latest(self):
        return self._json({"success": True, "results": self._latest_alive()})

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
            # 56회차 F6(재현): /api/health/latest 와 같은 규칙으로 삭제된 바로가기의 옛 이력은 뺀다 — 예전에는 이 응답만 그 행을 실어
            #   '최근 상태' 표에 '(삭제됨)' 줄이 떠올랐다(다음 30초 갱신까지).
            return self._json({"success": True, "results": self._latest_alive(), "skipped": True})
        return self._json({"success": True, "results": results, "skipped": False,
                           "checkedAt": self.date_time_string()})

    def _health_targets(self, payload) -> list:
        # v2.767(점검 R2-B5-3): 중지된 바로가기(v2.227)는 자동 점검뿐 아니라 [지금 점검](전체)·ids 경로에서도 뺀다 —
        # 예전에는 전부 넘겨 중지한 링크에 접속하고 이력·웹훅 전환 알림까지 냈다(툴팁 '사용으로 바꾸면 다시 포함' 과 모순).
        active = [item for item in self.ctx.shortcuts.all() if item.get("enabled", True)]
        if isinstance(payload, dict):
            ids = payload.get("ids")
            if isinstance(ids, list) and ids:
                wanted = {str(value) for value in ids}
                return [{"id": item["id"], "url": item["url"]}
                        for item in active if item["id"] in wanted]
            urls = payload.get("urls")
            if isinstance(urls, list) and urls:
                return [{"id": None, "url": str(value)} for value in urls[:200]]
        return [{"id": item["id"], "url": item["url"]} for item in active]

    # ================= 설정 세션 =================

    def api_session_get(self):
        user = self._session_user()
        if not user:
            return self._error(HTTPStatus.UNAUTHORIZED, "로그인되어 있지 않습니다.")
        return self._json({"success": True, "user": user})

    def _begin_auth_attempt(self, client) -> bool:
        """전체 점검 131회차: 잠금 검사 + 진행 중인 시도 예약(SessionStore.begin_attempt — 잠금 검사와 실패 기록 사이의 동시 요청이 임계를 넘겨 평가되지 않게).
        거절이면 429 를 쓰고 False. True 면 호출부가 인증 결과를 기록한 뒤 end_attempt 로 돌려준다(finally)."""
        wait = self.ctx.sessions.begin_attempt(client)
        if wait == 0:
            return True
        if wait > 0:
            self._error(HTTPStatus.TOO_MANY_REQUESTS,
                        f"로그인 시도가 많아 잠겼습니다. {wait}초 후 다시 시도하세요.")
        else:
            self._error(HTTPStatus.TOO_MANY_REQUESTS,
                        "같은 출발지에서 확인 중인 로그인 시도가 많습니다. 잠시 후 다시 시도하세요.")
        return False

    def api_session_login(self):
        client = self.client_address[0] if self.client_address else "-"
        if not self._begin_auth_attempt(client):
            return None
        try:
            payload = self._body_dict()
            username = payload.get("username")
            password = payload.get("password")
            user = self.ctx.users.authenticate(username if isinstance(username, str) else "",
                                               password if isinstance(password, str) else "")
            if not user:
                self.ctx.sessions.note_failure(client, username if isinstance(username, str) else "")   # 117회차 F2: 어느 계정을 틀렸는지
            else:
                self.ctx.sessions.note_success(client, user["username"])   # 117회차 F2: 이 계정의 실패만 지운다
        finally:
            self.ctx.sessions.end_attempt(client)   # 131회차: 결과를 기록한 뒤 · 응답을 쓰기 전에 돌려준다(본문 오류 · 예외에서도)
        if not user:
            print(f"[auth] 설정 로그인 실패 (from {client})", flush=True)
            self._audit("login", actor="-", result="fail")
            # 사용자명이 틀렸는지 비밀번호가 틀렸는지 구분해서 알리지 않는다(계정 열거 차단).
            return self._error(HTTPStatus.UNAUTHORIZED, "사용자명 또는 비밀번호가 올바르지 않습니다.")
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
        user = self._require_session()
        if not user:
            return None
        # v2.500(감사 L3): notify.webhookUrl 은 **URL 자체가 자격증명**(Slack/Teams)이다. 전송은
        # admin 전용인데 값 읽기가 일반 세션에 열려 권한 경계가 어긋났다. 비-admin 에게는 저장
        # 여부만 알린다(있다/없다) — 값을 가린 사실을 숨기지 않으려 hasWebhookUrl 로 표시한다.
        settings = self.ctx.settings.all()
        is_admin = user.get("role") == "admin"
        # 31회차 F4(재현): 백업 개수 · 최신 파일명 · 저장 디렉터리 절대경로와 데이터 폴더 경로는 admin 에게만 — v2.500 L2 가 백업 목록 라우트를
        #   admin 전용으로 막은 것과 같은 값이 이 응답으로 viewer 에게 나갔다(가림은 그 값이 실리는 응답 경로 전부에).
        backup = self.ctx.backups.status() if is_admin else {"settings": (self.ctx.backups.status() or {}).get("settings"), "redacted": True}
        if not is_admin:
            notify = dict(settings.get("notify") or {})
            notify["hasWebhookUrl"] = bool(notify.get("webhookUrl"))
            notify["webhookUrl"] = ""
            notify["redacted"] = True
            settings = {**settings, "notify": notify}
        # 117회차 F7: 이력 DB 를 못 읽어도(잠김 · 손상 · 디스크) 설정 화면은 열린다 — 예전에는 이 한 칸으로 응답 전체가 500 이라
        #   백업 · 복원 · 계정 관리에 들어갈 수 없었다. 못 읽으면 null(화면은 이 값을 쓰지 않는다).
        try:
            history_stats = self.ctx.history.stats()
        except sqlite3.Error:
            history_stats = None
        return self._json({
            "success": True,
            "settings": settings,
            "choices": {
                "backupIntervalMinutes": list(BACKUP_INTERVAL_CHOICES),
                "healthIntervalMinutes": list(HEALTH_INTERVAL_CHOICES),
            },
            "users": self.ctx.users.public_list(),
            "backup": backup,
            "history": history_stats,
            # 35회차 R4: 초기 비밀번호 파일 경로도 데이터 폴더 절대경로다 — 비-admin 에게는 있음 여부만.
            "initialPasswordFile": ((str(config.initial_password_file) if is_admin else True)
                                    if self.ctx.users.initial_password_present() else None),
            "dataDir": str(self.ctx.data_dir) if is_admin else None,
            # 결정(56~75 남긴 것): 로그아웃 폐기 목록을 못 믿어 기동 때 전원 세션을 끊었으면 그 사유(파일 이름 · 상태 · 시각 — 경로 없음)
            "sessionRevokedError": self.ctx.sessions.revoked_load_error(),
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
        # 반증(결정 G1b ② — 사용자 결정 '권장안대로'): admin 계정을 새로 만들 때도 요청자 본인의 현재 비밀번호를 확인한다
        #   (세션 토큰만 가로채서는 관리자를 늘릴 수 없게 — 같은 실패 카운터 · 잠금). viewer 생성은 그대로.
        if payload.get("role") == "admin" and not self._verify_current_password(
                actor, payload, what="admin 계정을 만들려면", action="user.create", target=payload.get("username")):
            return None
        users = self.ctx.users.add(payload.get("username"), payload.get("role", "viewer"),
                                   payload.get("password", ""))
        self._audit("user.create", actor=actor["username"],
                    detail={"target": str(payload.get("username", ""))[:64],
                            "role": str(payload.get("role", "viewer"))[:16]})
        return self._json({"success": True, "users": users}, status=HTTPStatus.CREATED)

    @staticmethod
    def _user_arg(raw):
        """사용자 라우트의 경로 조각 → 사용자명(퍼센트 디코드). 64자 넘으면 None(없는 계정 — 31회차 F1)."""
        name = unquote(str(raw or ""), errors="strict") if raw else ""
        return name if 0 < len(name) <= 64 else None

    def api_users_update(self, username):
        actor = self._require_admin()
        if not actor:
            return None
        username = self._user_arg(username)
        if username is None:
            return self._error(HTTPStatus.NOT_FOUND, "사용자를 찾을 수 없습니다.")
        payload = self._body_dict()
        # 반증(결정 G1b ②): 다른 계정을 admin 으로 올릴 때도 요청자 본인의 현재 비밀번호(중지 · viewer 로 낮추기 · 삭제는 그대로).
        current = self.ctx.users.get(username)
        if payload.get("role") == "admin" and current is not None and current.get("role") != "admin" \
                and not self._verify_current_password(actor, payload, what="admin 권한을 주려면", action="user.update", target=username):
            return None
        # 결정(반증 G1b 남긴 것): 중지된 admin 을 다시 켜는 것(enabled false → true · 역할은 admin 그대로)도 admin 을 늘리는 동작 —
        #   같은 확인(요청자 본인 · 같은 카운터 · 잠금). viewer 다시 켜기 · 중지 · 'viewer 로 낮추며 켜기'(결과가 admin 이 아님)는 그대로.
        if current is not None and current.get("role") == "admin" and not current.get("enabled", True) \
                and payload.get("enabled") is True and payload.get("role") in (None, "admin") \
                and not self._verify_current_password(actor, payload, what="중지된 admin 계정을 다시 켜려면", action="user.update", target=username):
            return None
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
        username = self._user_arg(username)
        if username is None:
            return self._error(HTTPStatus.NOT_FOUND, "사용자를 찾을 수 없습니다.")
        # 남의 비밀번호를 바꾸려면 admin 이어야 한다(자기 것은 누구나).
        if actor["username"] != username and actor.get("role") != "admin":
            return self._error(HTTPStatus.FORBIDDEN, "본인 비밀번호만 변경할 수 있습니다.")
        payload = self._body_dict()
        if actor["username"] == username and not self._verify_current_password(actor, payload):
            return None
        # 반증(결정 G1b ②): 다른 admin 의 비밀번호 재설정도 요청자 본인의 현재 비밀번호(viewer 재설정은 그대로).
        target = self.ctx.users.get(username) if actor["username"] != username else None
        if target is not None and target.get("role") == "admin" and not self._verify_current_password(
                actor, payload, what="다른 admin 계정의 비밀번호를 재설정하려면", target=username):
            return None
        self.ctx.users.set_password(username, payload.get("password", ""))
        # 비밀번호가 바뀐 계정의 기존 세션은 끊는다.
        self.ctx.sessions.destroy_user(username)
        self._audit("user.password", actor=actor["username"], detail={"target": username})
        return self._json({"success": True, "users": self.ctx.users.public_list()})

    def _verify_current_password(self, actor, payload, *, what="본인 비밀번호를 바꾸려면", action="user.password", target=None) -> bool:
        """결정(56~75 남긴 것 · 31회차 E3): 본인 비밀번호 변경은 현재 비밀번호를 확인한다 — 예전에는 세션 토큰(브라우저 저장소 · 8시간)만
        가로채도 비밀번호를 바꿔 계정을 영구히 가져갈 수 있었다. 확인 · 실패 카운터 · 잠금은 로그인과 같은 함수
        (authenticate · 출발지별 lock_remaining · note_failure · note_success)를 쓴다.
        반증(결정 G1b ②): admin 을 늘리는 관리 동작(admin 생성 · 다른 admin 재설정 · admin 으로 올리기 · 중지된 admin 다시 켜기)도 **요청자 본인**의 현재 비밀번호를 이 함수로 본다.
        실패면 응답을 쓰고 False."""
        client = self.client_address[0] if self.client_address else "-"
        if not self._begin_auth_attempt(client):   # 131회차: 잠금 검사 + 진행 중인 시도 예약(로그인과 같은 규칙)
            return False
        verdict = None   # None = 현재 비밀번호 없음(인증하지 않았다) · True · False
        try:
            current = payload.get("currentPassword")
            if isinstance(current, str) and current:
                verdict = bool(self.ctx.users.authenticate(actor["username"], current))
                if verdict:
                    self.ctx.sessions.note_success(client, actor["username"])
                else:
                    self.ctx.sessions.note_failure(client, actor["username"])
        finally:
            self.ctx.sessions.end_attempt(client)
        if verdict is None:
            self._error(HTTPStatus.BAD_REQUEST, f"{what} 요청한 본인의 현재 비밀번호를 입력하세요.",
                        code="current_password_required")
            return False
        if not verdict:
            print(f"[auth] {action} 거절 — 요청자 현재 비밀번호 불일치 (from {client})", flush=True)
            self._audit(action, actor=actor["username"], result="fail",
                        detail={"target": str(target if target is not None else actor["username"])[:64], "reason": "current_mismatch"})
            self._error(HTTPStatus.FORBIDDEN, "현재 비밀번호가 올바르지 않습니다(요청한 본인의 비밀번호).", code="current_password_invalid")
            return False
        return True

    def api_users_delete(self, username):
        actor = self._require_admin()
        if not actor:
            return None
        username = self._user_arg(username)
        if username is None:
            return self._error(HTTPStatus.NOT_FOUND, "사용자를 찾을 수 없습니다.")
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
        actor = self._require_admin()
        if not actor:
            return None
        created = self.ctx.datacenters.add(self._body_dict())
        # 56회차 F5: README 가 약속한 '설정 변경' 감사 — 데이터센터 생성 · 수정 · 삭제 · 이동이 빠져 있었다(초기화만 남았다)
        self._audit("datacenter.create", actor=actor["username"], detail={"id": created["id"]})
        return self._json({"success": True, "datacenter": created,
                           "datacenters": self.ctx.datacenters.all()}, status=HTTPStatus.CREATED)

    def api_dc_update(self, dc_id):
        actor = self._require_admin()
        if not actor:
            return None
        updated = self.ctx.datacenters.update(dc_id, self._body_dict())
        if not updated:
            return self._error(HTTPStatus.NOT_FOUND, "데이터센터를 찾을 수 없습니다.")
        self._audit("datacenter.update", actor=actor["username"], detail={"id": dc_id})
        return self._json({"success": True, "datacenter": updated,
                           "datacenters": self.ctx.datacenters.all()})

    def api_dc_delete(self, dc_id):
        actor = self._require_admin()
        if not actor:
            return None
        if not self.ctx.datacenters.delete(dc_id):
            return self._error(HTTPStatus.NOT_FOUND, "데이터센터를 찾을 수 없습니다.")
        # v2.760(점검 B-07): 그 데이터센터에 묶인 바로가기는 '전체'로 옮긴다(카테고리 삭제와 같은 규칙).
        moved = self.ctx.shortcuts.reassign_missing_datacenters(self.ctx.datacenters.ids())
        self._audit("datacenter.delete", actor=actor["username"], detail={"id": dc_id, "movedShortcuts": moved})
        return self._json({"success": True, "datacenters": self.ctx.datacenters.all(),
                           "shortcuts": self.ctx.shortcuts.all(), "movedShortcuts": moved})

    def api_dc_reset(self):
        actor = self._require_admin()
        if not actor:
            return None
        datacenters = self.ctx.datacenters.reset()
        self._audit("datacenter.reset", actor=actor["username"])   # 47회차 #1: 거절(손상 · 읽기 오류)이면 남기지 않는다 — 성공한 뒤에
        moved = self.ctx.shortcuts.reassign_missing_datacenters({dc["id"] for dc in datacenters})
        return self._json({"success": True, "datacenters": datacenters,
                           "shortcuts": self.ctx.shortcuts.all(), "movedShortcuts": moved})

    def api_dc_move(self, dc_id):
        actor = self._require_admin()
        if not actor:
            return None
        items = self.ctx.datacenters.move(dc_id, self._move_delta())
        if items is None:
            # 이미 맨 위/맨 아래 — 오류가 아니라 '변경 없음' 이다.
            return self._json({"success": True, "moved": False,
                               "datacenters": self.ctx.datacenters.all()})
        # '표시 개수 N' 이 앞에서 N곳을 자르므로 순서 변경은 공개 화면에 보이는 센터를 바꾼다 — 설정 변경으로 남긴다.
        self._audit("datacenter.move", actor=actor["username"], detail={"id": dc_id})
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
        actor = self._require_admin()
        if not actor:
            return None
        updated = self.ctx.categories.update(cat_id, self._body_dict())
        if not updated:
            return self._error(HTTPStatus.NOT_FOUND, "카테고리를 찾을 수 없습니다.")
        self._audit("category.update", actor=actor["username"], detail={"id": cat_id})   # 56회차 F5
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
        actor = self._require_admin()
        if not actor:
            return None
        items = self.ctx.categories.move(cat_id, self._move_delta())
        if items is None:
            return self._json({"success": True, "moved": False,
                               "categories": self.ctx.categories.all()})
        self._audit("category.move", actor=actor["username"], detail={"id": cat_id})   # 56회차 F5
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
        # v2.500(감사 L2): pyportal/CLAUDE.md 는 "목록·다운로드·복원은 admin 세션만" 이라고
        # 규정하는데 목록만 일반 세션에 열려 있었다(백업 파일명·개수·저장 디렉터리 절대경로 노출).
        # 형제 라우트(생성·다운로드·복원·삭제)와 같은 경계로 맞춘다.
        if not self._require_admin():
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
        user = self._require_session()
        if not user:
            return None
        before = self.ctx.shortcuts.get(shortcut_id)
        if not self.ctx.shortcuts.delete(shortcut_id):
            return self._error(HTTPStatus.NOT_FOUND, "바로가기를 찾을 수 없습니다.")
        # 56회차 F5: 지우는 동작은 남긴다(viewer 도 할 수 있다) — 같은 꼴의 '교체' 가져오기(shortcuts.import)는 이미 남기는데 삭제 · 초기화만 빠져 있었다
        self._audit("shortcut.delete", actor=user["username"],
                    detail={"id": shortcut_id, "name": (before or {}).get("name", "")})
        return self._json({"success": True, "shortcuts": self.ctx.shortcuts.all()})

    def api_shortcut_reset(self):
        user = self._require_session()
        if not user:
            return None
        before = len(self.ctx.shortcuts.all())
        shortcuts = self.ctx.shortcuts.reset()
        self._audit("shortcuts.reset", actor=user["username"], detail={"removed": before, "added": len(shortcuts)})   # 56회차 F5
        return self._json({"success": True, "shortcuts": shortcuts})

    def _resolve_import_category(self, user, value):
        """가져오기 일괄 카테고리(v2.219) — id/라벨로 찾고, 없으면 admin 에 한해 즉석 생성.

        반환: (category_id | None, 오류응답 | None). value 가 비면 (None, None) — 파일 값 유지.
        """
        text = str(value or "").strip()
        if not text:
            return None, None
        lowered = text.lower()
        for cat in self.ctx.categories.all():
            if cat["id"].lower() == lowered or cat["label"].lower() == lowered:
                return cat["id"], None
        if user.get("role") != "admin":
            return None, self._error(HTTPStatus.BAD_REQUEST,
                                     f"카테고리가 없습니다: {text} (생성은 admin 만 가능)")
        cat_err = self.ctx.categories.load_error()
        if cat_err:
            # 47회차 #1: 분류 파일을 못 읽는 동안의 거절을 '슬러그 충돌' 로 오인해 접미를 붙여 수십 번 다시 만들지 않는다
            return None, self._error(HTTPStatus.BAD_REQUEST, load_error_text("categories.json", cat_err))
        try:
            created = self.ctx.categories.add({"label": text})
        except ValidationError:
            # 슬러그 충돌(예: 'SBP'가 이미 있는데 'SBP서버' → 둘 다 'sbp') — 접미로 유니크화.
            base_slug = cat_slugify(text) or "cat"
            created = None
            for n in range(2, 100):
                try:
                    created = self.ctx.categories.add({"label": text, "id": f"{base_slug}-{n}"[:32]})
                    break
                except ValidationError:
                    continue
            if not created:
                return None, self._error(HTTPStatus.BAD_REQUEST, f"카테고리를 만들 수 없습니다: {text}")
        self._audit("category.create", actor=user["username"],
                    detail={"id": created["id"], "via": "import"})
        return created["id"], None

    def _diagnose_import_rows(self, entries):
        """가져오기 행별 실패 사유(v2.221) — [{row, name, reason}] (최대 50건).
        잘못된 행이 사유 없이 조용히 폐기되면 사용자는 몇 개가 왜 빠졌는지 알 수 없다."""
        errors = []
        if not isinstance(entries, list):
            return errors
        for idx, entry in enumerate(entries):
            reason = self.ctx.shortcuts.diagnose(entry)
            if not reason:
                continue
            label = ""
            if isinstance(entry, dict):
                label = str(entry.get("name") or entry.get("url") or "")[:80]
            errors.append({"row": idx + 1, "name": label, "reason": reason})
            if len(errors) >= 50:
                break
        return errors

    def _finish_import(self, user, entries, mode_value, fmt, extra_detail=None):
        """가져오기 공통 마무리(v2.223 공용화) — 행별 진단(v2.221) → 저장 → 감사 → 응답.
        JSON 업로드/CSV 업로드/서버 파일 가져오기 세 경로가 같은 규칙을 공유한다."""
        errors = self._diagnose_import_rows(entries)
        if isinstance(entries, list) and entries and len(errors) >= len(entries):
            detail = " · ".join(f"#{e['row']} {e['reason']}" for e in errors[:5])
            return self._error(HTTPStatus.BAD_REQUEST,
                               f"가져올 수 있는 유효한 항목이 없습니다 — {detail}"
                               + (" …" if len(errors) > 5 else ""))
        append = str(mode_value).lower() == "append"
        if append:
            shortcuts, added, skipped = self.ctx.shortcuts.append_many(entries)
        else:
            shortcuts = self.ctx.shortcuts.replace_all(entries)
            added, skipped = len(shortcuts), 0
        detail = {"format": fmt, "mode": "append" if append else "replace",
                  "added": added, "skipped": skipped, "invalid": len(errors)}
        if extra_detail:
            detail.update(extra_detail)
        self._audit("shortcuts.import", actor=user["username"], detail=detail)
        return self._json({"success": True, "shortcuts": shortcuts, "added": added,
                           "skipped": skipped, "rows": len(entries) if isinstance(entries, list) else 0,
                           "errors": errors})

    def api_shortcut_import(self):
        """JSON 가져오기. mode=replace 면 통째로 교체, append 면 뒤에 덧붙인다(같은 URL 건너뜀).
        category 를 주면 전 항목을 그 분류로 일괄 지정(없으면 admin 에 한해 즉석 생성).
        하위호환: 옛 클라이언트/스크립트가 mode 없이(또는 배열 그대로) 보내면 기존 동작(교체)."""
        user = self._require_session()
        if not user:
            return None
        payload = self._read_json()
        entries = payload.get("shortcuts") if isinstance(payload, dict) else payload
        mode = str(payload.get("mode", "replace")).lower() if isinstance(payload, dict) else "replace"
        cat_id, err = self._resolve_import_category(
            user, payload.get("category") if isinstance(payload, dict) else "")
        if err:
            return err
        if cat_id and isinstance(entries, list):
            entries = [dict(e, category=cat_id) if isinstance(e, dict) else e for e in entries]
        return self._finish_import(user, entries, mode, "json")

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
        cat_id, err = self._resolve_import_category(user, payload.get("category"))
        if err:
            return err
        if cat_id:
            entries = [dict(e, category=cat_id) for e in entries]
        return self._finish_import(user, entries, payload.get("mode", "append"), "csv")

    # ---------- 서버 파일 직접 가져오기 (v2.223) ----------
    # 브라우저 업로드 없이 운영자가 서버에 올려 둔 파일을 바로 반영한다(폐쇄망/자동화 배포용).
    # 대상 디렉터리는 data_dir/import 하나로 고정 — 이름 화이트리스트 + resolve 재확인으로
    # 경로 탈출(../, 절대경로, 심볼릭 링크로 밖을 가리키기)을 차단한다. 파일시스템 접근이라 admin 전용.

    IMPORT_NAME_RE = re.compile(r"^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 ._-]{0,120}\.(json|csv)$")
    IMPORT_MAX_BYTES = 2 * 1024 * 1024

    def _import_dir(self) -> Path:
        # 전역 config 가 아니라 컨텍스트의 data_dir 기준 — 테스트/다중 인스턴스에서 경로가 갈린다.
        path = Path(self.ctx.data_dir) / "import"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def api_import_server_list(self):
        actor = self._require_admin()
        if not actor:
            return None
        files = []
        for p in sorted(self._import_dir().iterdir()):
            if not p.is_file() or not self.IMPORT_NAME_RE.match(p.name):
                continue
            st = p.stat()
            files.append({"name": p.name, "sizeBytes": st.st_size,
                          "modifiedAt": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))})
        return self._json({"success": True, "dir": str(self._import_dir()), "files": files})

    def api_import_server_run(self):
        actor = self._require_admin()
        if not actor:
            return None
        payload = self._body_dict()
        name = str(payload.get("name", "")).strip()
        if not self.IMPORT_NAME_RE.match(name):
            return self._error(HTTPStatus.BAD_REQUEST,
                               "파일 이름이 올바르지 않습니다 — import 폴더의 .json/.csv 만 지정할 수 있습니다.")
        base = self._import_dir().resolve()
        path = (base / name).resolve()
        if path.parent != base or not path.is_file():
            return self._error(HTTPStatus.NOT_FOUND, f"파일이 없습니다: {name}")
        if path.stat().st_size > self.IMPORT_MAX_BYTES:
            return self._error(HTTPStatus.BAD_REQUEST, "파일이 너무 큽니다(최대 2MB).")
        try:
            text = path.read_text(encoding="utf-8-sig")  # 엑셀 BOM 허용
        except OSError as exc:
            # 56회차 개선: 권한 오류(root 가 올린 0600 파일 등)는 예전에 _dispatch 의 '서버 내부 오류'(500)로 떨어져 원인을 알 수 없었다
            return self._error(HTTPStatus.BAD_REQUEST,
                               f"파일을 읽지 못했습니다: {name} ({exc.strerror or type(exc).__name__}) — 파일 소유자 · 권한을 확인하세요.")
        if name.lower().endswith(".csv"):
            entries = csvio.parse_csv(text)
        else:
            try:
                parsed = json.loads(text)
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, f"JSON 해석 실패: {exc}")
            except RecursionError:
                return self._error(HTTPStatus.BAD_REQUEST, "JSON 해석 실패: 중첩이 너무 깊습니다.")
            _reject_lone_surrogates(parsed)   # 117회차 F3: 요청 본문과 같은 경계
            entries = parsed.get("shortcuts") if isinstance(parsed, dict) else parsed
        if not isinstance(entries, list) or not entries:
            return self._error(HTTPStatus.BAD_REQUEST,
                               "가져올 항목이 없습니다(JSON 배열/shortcuts 키 또는 name·url 열 확인).")
        cat_id, err = self._resolve_import_category(actor, payload.get("category"))
        if err:
            return err
        if cat_id:
            entries = [dict(e, category=cat_id) if isinstance(e, dict) else e for e in entries]
        return self._finish_import(actor, entries, payload.get("mode", "append"),
                                   "csv" if name.lower().endswith(".csv") else "json",
                                   extra_detail={"source": f"server:{name}"})

    # ---------- 정적 파일 ----------

    def _serve_static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            return self._send_file(STATIC_DIR / "index.html")

        # '..' 이나 절대경로로 STATIC_DIR 밖을 읽지 못하게 정규화 후 재확인한다.
        relative = posixpath.normpath(path).lstrip("/")
        try:
            candidate = (STATIC_DIR / relative).resolve()
            candidate.relative_to(STATIC_DIR.resolve())
            servable = candidate.suffix.lower() in STATIC_SUFFIXES and candidate.is_file()
        except (ValueError, OSError):
            # 56회차 F8(재현): NUL 이 든 경로(ValueError)·너무 긴 파일 이름(ENAMETOOLONG)은 이 함수가 _dispatch 의 try 밖이라
            #   응답 없이 연결이 끊기고 요청 줄 전체가 든 traceback 이 로그에 쌓였다(미인증 요청 한 줄 — v2.768 R3-C3-3 과 같은 꼴).
            return self._error(HTTPStatus.NOT_FOUND, "없는 경로입니다.")
        if not servable:
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
        # 번들 폰트(v2.224)는 ~2MB 라 no-cache 로 두면 페이지마다 재전송된다 — 내용이 바뀌면
        # 파일명을 바꾸는 전제로 장기 캐시. 나머지 정적 파일은 업그레이드 즉시 반영이 우선.
        cache = "public, max-age=31536000, immutable" if file_path.suffix == ".woff2" else "no-cache"
        return self._send(HTTPStatus.OK, body, content_type, {"Cache-Control": cache})

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
    ("POST", _route(r"/api/settings/users/" + USER_PATTERN + r"/password"),
     HubHandler.api_users_password),
    ("PUT", _route(r"/api/settings/users/" + USER_PATTERN), HubHandler.api_users_update),
    ("DELETE", _route(r"/api/settings/users/" + USER_PATTERN), HubHandler.api_users_delete),

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
    ("GET", _route(r"/api/settings/import-files"), HubHandler.api_import_server_list),
    ("POST", _route(r"/api/settings/import-files/run"), HubHandler.api_import_server_run),
    ("GET", _route(r"/api/export"), HubHandler.api_export),
    ("GET", _route(r"/api/export/csv"), HubHandler.api_export_csv),
]


class _Seat:
    """입장 표의 자리 하나. state: 'busy'(요청 중) | 'idle'(keep-alive 대기) | 'evicted'(되찾음 — 반환 대기)."""

    __slots__ = ("sock", "client", "state", "since", "reclaimed_at", "conn")

    def __init__(self, sock, client, half_life=20.0):
        self.sock = sock
        self.client = client
        self.state = "busy"
        self.since = time.monotonic()
        self.reclaimed_at = 0.0
        self.conn = ConnPhase(half_life)
        self.conn.enter("header", self.since)   # 새 연결은 입장부터 클라이언트의 요청 줄을 기다린다(첫 헤더 단계)


class HubServer(ThreadingHTTPServer):
    """요청마다 스레드 — 링크 점검이 몇 초 걸려도 화면 조회가 멈추지 않는다.

    스레드 수에 상한을 둔다(6차 감사). 연결 하나당 스레드 하나를 무제한으로 만들면
    미인증 연결만으로 메모리·FD 를 고갈시킬 수 있다.

    보안 잔여 11-27 L12 — 연결 자리(입장 표):
    - 자리는 **스레드를 만들기 전에** accept 루프(process_request)에서 잡는다. 예전에는 스레드 안에서 세마포어를 5초 기다려,
      거절될 연결에도 스레드가 먼저 생겼다.
    - 출발지 상한 초과는 즉시 끊는다. 전체가 가득 차면 accept 루프에서 유한 대기한다(스레드 없음). accept 를 멈추면 커널
      listen 대기열이 도착 순서로 줄을 세워, 시한마다 다시 붙는 연결과 정상 사용자가 '빈자리 복권' 을 다투지 않는다
      (즉시 거절이면 정상 성공률이 0~4% 였다 — 반증 실측).
    - 기다리는 동안 **느린 연결**의 자리를 하나씩 되찾는다(_reclaim_one_locked). 점수 = 연결 단위로 클라이언트를 기다린 시간
      (헤더 · 본문 · 응답 쓰기 — 로그인 세션의 본문 · 쓰기는 빼고)의 반감기 누계 + 지금 단계 진행분(hub/inbound.py ConnPhase).
      점수가 reclaim_after(기본 헤더 시한의 절반) 이상인 자리 중 큰 것이 먼저(쉬는 중이어도). 그런 자리가 대기 마감 직전까지
      생기지 않을 때만 대체 후보 — 점수가 기준의 1/4 이상인 연결, 그다음 reclaim_after 넘게 쉰 유휴 keep-alive. 공격 중(최근
      느린 연결을 끊었다)이면 대체 후보는 대기자가 reclaim_after 를 기다린 뒤에만.
      서버가 처리 중인 요청 · 린저 · 로그인 세션의 본문 · 쓰기(계정당 trusted_slow_per_user 개)는 되찾지 않는다.
      반증 1회차 M1: 1회차는 '요청을 마친 연결이 기다리는 연결에 자리를 넘김' 이었는데, 공격 연결은 늘 처리 중(busy)이라
      넘기는 쪽은 정상 keep-alive 뿐이었다. 반증 2회차 R2-1: '지금 단계의 시작' 만 보면 단계마다 기준 직전에 다음 단계로
      갈아타는 연결이 끝내 후보가 되지 않았고(새 사용자 0/5), 마감 직전 쉬던 정상 keep-alive 가 대신 끊겼다(수정 전보다 나쁨).
      쓰기 단계 시한(PhaseWriter)과 함께 모든 미인증 보유가 유한해져 '대기 상한 안에 자리가 난다' 는 전제가 선다.
    - 반환은 shutdown_request 하나 — 소켓을 닫기 **전에** 잠금 안에서 표에서 뺀다(되찾기의 shutdown 이 닫힌 뒤 재사용된
      FD 를 건드리지 않게). pop 기반이라 멱등.
    """

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64
    _drop_log_interval = 60.0
    _DROP_LABELS = (("header", "헤더 시한 초과"), ("body", "본문 시한 초과"), ("write", "응답 쓰기 시한 초과"),
                    ("full", "자리 대기 만료"), ("per_client", "출발지 상한 거절"), ("evicted", "유휴 연결 정리"),
                    ("shed", "느린 연결 정리"))
    # 되찾을 수 있는 단계(클라이언트를 기다리는 단계) · 로그인 세션이면 빼는 단계
    _RECLAIM_PHASES = SLOW_PHASES      # hub/inbound.py 의 누계 판정과 같은 목록(한 곳)
    _TRUSTED_PHASES = TRUSTED_PHASES
    # 로그인 세션의 본문 · 쓰기를 되찾기에서 빼는 개수(계정당). 정상 사용자는 가져오기 · 복원 · 백업 내려받기를 한두 개 넘게 동시에 하지 않는다.
    trusted_slow_per_user = 2
    slow_half_life = None   # None = 4 × reclaim_after

    def __init__(self, address, handler, ctx, max_connections: int = 64, max_per_client=None,
                 header_timeout=None, body_min_rate=None, body_timeout_max=None, admit_wait=None,
                 reclaim_after=None, preauth_max_body=None):
        super().__init__(address, handler)
        self.ctx = ctx
        self._max_conn = max(1, int(max_connections))
        # 전체 점검 124회차(117회차 결정 D1 — 재현: 헤더를 흘리는 연결 64개가 소켓 시한을 지나서도 전체 상한을 쥐었다): 출발지(IP)당 동시 연결 상한.
        #   한 출발지가 쥘 수 있는 자리를 전체보다 작게 두어 나머지 자리로 다른 사용자가 붙는다. 여러 출발지에서 나눠 여는 공격은 막지 못한다(앞단 프록시의 일).
        per = config.max_conn_per_client if max_per_client is None else max_per_client
        self._per_client_max = max(0, int(per))   # 0 = 끔
        self._per_client = {}
        self.header_timeout = config.header_timeout if header_timeout is None else float(header_timeout)
        self.body_min_rate = config.body_min_rate if body_min_rate is None else body_min_rate
        self.body_timeout_max = config.body_timeout_max if body_timeout_max is None else float(body_timeout_max)
        self.preauth_max_body = config.preauth_max_body if preauth_max_body is None else int(preauth_max_body)
        # 가득 찼을 때 accept 루프가 기다리는 상한.
        self.admit_wait = self.header_timeout if admit_wait is None else float(admit_wait)
        # 가득 찼을 때 되찾는 기준 — 느린 단계 점수(연결 단위 누계 + 진행분) · 유휴 시간. 대기 상한의 절반이라 막 쥔 자리만
        #   있어도 대기 중에 하나는 되찾을 수 있다. 요청이 빠르고 이보다 자주 쓰는 keep-alive 는 공격 중에도 자리를 지킨다.
        self.reclaim_after = self.header_timeout / 2 if reclaim_after is None else float(reclaim_after)
        self._cond = threading.Condition(threading.Lock())
        self._admitted = {}      # request 소켓 → _Seat
        self._attack_seen_at = None   # 마지막으로 느린 연결을 끊은 시각(monotonic) — _under_attack
        self._closing = False
        self._drop_lock = threading.Lock()
        self.inbound_drops = {k: 0 for k in ("silent", "header", "body", "write", "eof", "full", "per_client",
                                             "evicted", "shed")}
        self._drop_pending = {}
        self._drop_last_log = None
        self._drop_timer = None

    # ---------- 입장 표 ----------

    def active_connections(self) -> int:
        with self._cond:
            return len(self._admitted)

    def _admit(self, request, client):
        """(None(입장) | 'per_client' | 'full', 되찾은 종류 목록). 잠금 하나에서 전체·출발지를 함께 판정·기록한다."""
        reclaimed = []
        with self._cond:
            if self._per_client_max and self._per_client.get(client, 0) >= self._per_client_max:
                return "per_client", reclaimed
            if len(self._admitted) >= self._max_conn:
                deadline = time.monotonic() + self.admit_wait
                # 단계 시작 · 처리 끝은 표를 깨우지 않는다 — 되찾을 후보가 생길 때를 놓치지 않게 짧게 다시 본다.
                poll = self._poll_interval()
                while not self._closing and len(self._admitted) >= self._max_conn:
                    now = time.monotonic()
                    next_at = None
                    if not self._reclaim_pending_locked(now):
                        kind, next_at = self._reclaim_one_locked(now, deadline)
                        if kind:
                            reclaimed.append(kind)
                            next_at = None
                    left = deadline - now
                    if left <= 0:
                        break
                    wait = min(left, poll)
                    if next_at is not None:
                        wait = min(wait, max(0.005, next_at - now))
                    self._cond.wait(wait)
                if self._closing or len(self._admitted) >= self._max_conn:
                    return "full", reclaimed
            self._admitted[request] = _Seat(request, client, self._slow_half_life())
            if self._per_client_max:
                self._per_client[client] = self._per_client.get(client, 0) + 1
            return None, reclaimed

    def _under_attack(self, now) -> bool:
        """최근(느린 단계 반감기 안)에 느린 연결을 끊었다 — 되찾기 · 단계 시한 초과."""
        seen = self._attack_seen_at
        return seen is not None and now - seen < self._slow_half_life()

    def _poll_interval(self) -> float:
        return min(0.25, max(0.01, self.reclaim_after / 4))

    def _slow_half_life(self) -> float:
        """느린 단계 누계의 반감기 — 기본 되찾기 기준의 4배(운영 20초). 짧으면 갈아타기 공격이 순환마다 쌓을 수 있는 느린 시간이
        늘고(반감기 2배일 때 순환당 약 1.8초 · 4배일 때 약 0.9초 — 유휴 4.9초 순환 계산), 길면 한 번 느렸던 정상 연결이 오래 앞줄에 선다."""
        half = self.slow_half_life
        return 4.0 * self.reclaim_after if half is None else float(half)

    def _reclaim_pending_locked(self, now) -> bool:
        """되찾으려고 끊은 연결의 자리가 아직 안 돌아왔다(되찾기 기준 · 상한 1초 안) — 대기자 하나에 하나만 끊는다.
        반증 2회차 nit: 창을 절대값 1초로 두면 축소 비율 시험(되찾기 0.5초)에서 비율이 어긋났다 — 되찾기 기준에 맞춘다(운영은 그대로 1초)."""
        grace = min(1.0, self.reclaim_after)
        return any(seat.state == "evicted" and now - seat.reclaimed_at < grace for seat in self._admitted.values())

    def _reclaim_one_locked(self, now, deadline=None):
        """가득 찼을 때 자리 하나를 되찾는다(잠금 안 — 표에 있는 동안은 소켓이 닫히지 않았다).

        **느린 연결이 먼저**: 점수 = 연결의 느린 단계 누계(반감기로 줄임 — ConnPhase.slow_score) + 지금 쌓이는 단계의 진행분.
        ① 점수가 reclaim_after 이상인 자리 중 점수가 가장 큰 것(유휴 · 헤더 · 본문 · 쓰기 어느 상태든 — 갈아타기 공격은 유휴로
        쉬는 동안에도 앞줄이다) ② 그런 자리가 지금도, 대기 마감 직전(deadline − 2 × 폴링 간격)까지도 생기지 않을 때만 대체 후보 —
        점수가 기준의 1/4 이상인 연결(큰 순), 그다음 reclaim_after 넘게 쉰 유휴 keep-alive(오래 쉰 순). 공격 중(_under_attack)이면
        대체 후보는 대기자가 reclaim_after 를 기다린 뒤에만.
        대상이 아닌 자리: 서버가 처리 중(단계 없음) · 린저 · 로그인 세션의 본문 · 쓰기(계정당 trusted_slow_per_user 개까지 —
        오래 진행한 것부터 보호하고, 넘는 것은 진행분으로 후보가 된다).
        반증 1회차 M1: 유휴를 먼저 고르면 공격 중 몇 초 쉰 정상 사용자가 요청마다 자리를 잃었다(공격 연결은 늘 단계 중).
        반증 2회차 R2-1: '지금 단계 시작' 만 보면 단계를 reclaim_after 직전에 갈아타는 연결이 후보가 되지 않았고, 대기 마감 전까지
        '곧 후보가 될 느린 단계' 를 기다리느라 유휴 정리까지 막혔다(대기자 0/5 · 기존 keep-alive 가 수정 전보다 먼저 끊김).
        돌려주는 값: (되찾은 종류 | None, 다시 볼 시각 | None).
        """
        threshold = self.reclaim_after
        # 로그인 세션의 본문 · 쓰기 — 계정당 보호 개수까지만(오래 진행한 것부터)
        trusted = {}
        for seat in self._admitted.values():
            ph = seat.conn
            if seat.state == "busy" and ph.trusted and ph.phase in self._TRUSTED_PHASES:
                trusted.setdefault(ph.user, []).append(seat)
        overflow = set()
        keep = max(0, int(self.trusted_slow_per_user))
        for seats in trusted.values():
            seats.sort(key=lambda st: st.conn.started)
            overflow.update(id(st) for st in seats[keep:])
        floor = threshold / 4   # 대기 마감 직전 대체 후보로 볼 '조금 느린' 기준
        slow = fallback = None
        slow_score = fallback_key = idle_next = busy_next = None
        for seat in self._admitted.values():
            ph = seat.conn
            if seat.state == "idle":
                score = ph.slow_score(now, current=False)
                growing = False
            elif seat.state == "busy":
                phase = ph.phase
                if phase not in self._RECLAIM_PHASES:
                    continue   # 서버가 처리 중 · 린저
                if ph.trusted and phase in self._TRUSTED_PHASES:
                    if id(seat) not in overflow:
                        continue   # 로그인 세션의 업로드/내려받기(계정당 보호 개수 안)
                    score = ph.slow_score(now) + max(0.0, now - ph.started)
                else:
                    score = ph.slow_score(now)
                growing = True
            else:
                continue
            if score >= threshold:
                if slow is None or score > slow_score:
                    slow, slow_score = seat, score
                continue
            idle_age = now - seat.since if seat.state == "idle" else 0.0
            if growing:
                ready = now + (threshold - score)   # 이 단계에 그대로 머물면 후보가 되는 때
                busy_next = ready if busy_next is None else min(busy_next, ready)
            if score >= floor or idle_age >= threshold:
                # 대체 후보: 조금이라도 느린 연결(점수 큰 순)이 먼저, 그다음 오래 쉰 유휴(정상적으로 요청을 마치고 쉬는 쪽)
                key = (score if score >= floor else 0.0, idle_age)
                if fallback is None or key > fallback_key:
                    fallback, fallback_key = seat, key
            elif seat.state == "idle":
                ready = seat.since + threshold
                idle_next = ready if idle_next is None else min(idle_next, ready)
        target = slow
        if target is None and fallback is not None:
            # 곧 느린 후보가 생기면 쉬고 있는 정상 연결 대신 그것을 기다린다 — 단 대기 마감 직전까지만. 그때도 후보가 없으면
            #   조금이라도 느린 연결을 먼저 고른다(반증 2회차 R2-1: 갈아타는 연결의 '곧 후보' 가 끝내 오지 않으면 마감 직전에 쉬던
            #   정상 keep-alive 가 대신 끊겼다 — 수정 전보다 나빴다).
            shield_until = None if deadline is None else deadline - 2 * self._poll_interval()
            if busy_next is None or (shield_until is not None and busy_next > shield_until):
                target = fallback
            # 공격 중(최근 느린 연결을 끊었다)이면 대체 후보는 대기자가 reclaim_after 를 기다린 뒤에만 — 대기 줄에서 요청을 미리 흘려 둔
            #   공격 연결은 입장 직후 요청이 빨라 '쉬는 정상 연결' 과 구별되지 않는다. reclaim_after 안에 그 연결이 다시 느린 단계에
            #   들어가거나(→ 위 예측이 막는다) 오래 쉰 쪽이 된다. 공격이 없으면(가득 찬 정상 keep-alive) 기다리지 않는다.
            grace_until = None if deadline is None else deadline - self.admit_wait + threshold
            if target is not None and grace_until is not None and now < grace_until and self._under_attack(now):
                target = None
                idle_next = grace_until if idle_next is None else min(idle_next, grace_until)
        if target is None:
            nexts = [t for t in (busy_next, idle_next) if t is not None]
            return None, (min(nexts) if nexts else None)
        kind = "evicted" if (target.state == "idle" and target is not slow and fallback_key[0] == 0.0) else "shed"
        if kind == "shed":
            self._attack_seen_at = now
        target.state = "evicted"
        target.reclaimed_at = now
        target.conn.shed = True
        try:
            target.sock.shutdown(socket.SHUT_RDWR)   # 유휴 peek · 단계 recv/send 를 깨운다 — 핸들러가 조용히 닫고 shutdown_request 에서 반환
        except OSError:
            pass
        return kind, None

    def conn_phase(self, request):
        """핸들러가 단계를 알릴 ConnPhase(입장 표의 자리와 공유). 표에 없으면 None."""
        with self._cond:
            seat = self._admitted.get(request)
            return seat.conn if seat is not None else None

    def conn_idle(self, request) -> bool:
        """핸들러가 keep-alive 유휴 대기에 들어간다. False = 이미 자리를 되찾겼다(닫을 것).

        반증 1회차 M1: 기다리는 연결이 있어도 스스로 넘기지 않는다 — 유휴 시각을 적고 대기자를 깨워, reclaim_after 가
        지나도 다음 요청이 없을 때만 되찾게 한다.
        """
        with self._cond:
            seat = self._admitted.get(request)
            if seat is None:
                return True
            if seat.state == "evicted":
                return False
            seat.state = "idle"
            seat.since = time.monotonic()
            self._cond.notify_all()
            return True

    def conn_busy(self, request) -> bool:
        """유휴 대기에서 첫 바이트가 왔다. False = 그사이 내보내졌다(닫을 것)."""
        with self._cond:
            seat = self._admitted.get(request)
            if seat is None:
                return True
            if seat.state == "evicted":
                return False
            seat.state = "busy"
            return True

    def _release(self, request) -> None:
        """자리 반환 — 멱등(표에 있을 때만 전체·출발지를 줄인다)."""
        with self._cond:
            seat = self._admitted.pop(request, None)
            if seat is None:
                return
            client = seat.client
            if self._per_client_max and client in self._per_client:
                count = self._per_client[client] - 1
                if count > 0:
                    self._per_client[client] = count
                else:
                    self._per_client.pop(client, None)   # 0 이면 지운다 — 출발지 수만큼 자라지 않게
            self._cond.notify_all()

    def process_request(self, request, client_address):
        client = client_address[0] if client_address else "-"
        reason, reclaimed = self._admit(request, client)
        for kind in reclaimed:
            self.note_inbound_drop(kind)
        if reason:
            # 스레드를 만들지 않고 응답 없이 끊는다(요청을 읽지 않고 쓰면 RST 로 응답이 버려지기 쉽고, accept 스레드에서 쓰게 된다).
            self.note_inbound_drop(reason)
            self.shutdown_request(request)
            return
        # 스레드 시작이 실패하면 stdlib _handle_request_noblock 이 shutdown_request 를 부른다 → 거기서 반환된다.
        super().process_request(request, client_address)

    def shutdown_request(self, request):
        self._release(request)   # 닫기 전에 표에서 뺀다 — 모든 닫기 경로(스레드 finally · 거절 · start 실패)가 여기를 지난다
        super().shutdown_request(request)

    def serve_forever(self, poll_interval=0.5):
        with self._cond:
            self._closing = False   # 반증 1회차 N2: 종료 요청은 그 루프에만 — 같은 객체로 다시 돌리면 자리 대기가 살아 있게
        super().serve_forever(poll_interval)

    def shutdown(self):
        with self._cond:
            self._closing = True       # accept 루프의 자리 대기를 깨워 serve_forever 종료가 대기 상한만큼 늦지 않게
            self._cond.notify_all()
        with self._drop_lock:
            if self._drop_timer is not None:
                self._drop_timer.cancel()
                self._drop_timer = None
        super().shutdown()

    # ---------- 연결 보호 집계 · 로그 ----------

    def note_inbound_drop(self, kind: str) -> None:
        """누적 카운트 + '연결 보호' 로그(간격당 1줄 · ERROR 접두 없음 — 공격 신호지만 운영 로그를 채우지 않게).

        첫 건은 바로 찍고, 간격 안의 건은 모아 두었다가 간격이 지나면 타이머가 '지난 N초' 로 한 줄 더 찍는다(버스트 꼬리가 다음
        사건까지 숨지 않게). silent(아무것도 안 보낸 새 연결 — 브라우저 사전 연결도 이렇다)·eof 는 세기만 한다.
        """
        if kind in ("header", "body", "write"):
            self._attack_seen_at = time.monotonic()   # 단계 시한 초과도 공격 신호(값 대입 하나 — 잠금 밖)
        with self._drop_lock:
            self.inbound_drops[kind] = self.inbound_drops.get(kind, 0) + 1
            if kind not in dict(self._DROP_LABELS):
                return
            self._drop_pending[kind] = self._drop_pending.get(kind, 0) + 1
            now = time.monotonic()
            if self._drop_last_log is None or now - self._drop_last_log >= self._drop_log_interval:
                line = self._drop_line_locked(now)
            else:
                line = None
                if self._drop_timer is None and not self._closing:
                    delay = max(0.0, self._drop_last_log + self._drop_log_interval - now)
                    self._drop_timer = threading.Timer(delay, self._flush_drop_log)
                    self._drop_timer.daemon = True
                    self._drop_timer.start()
        if line:
            print(line, flush=True)

    def _drop_line_locked(self, now):
        if not self._drop_pending:
            return None
        span = None if self._drop_last_log is None else now - self._drop_last_log
        parts = ["{} {}건".format(label, self._drop_pending[key])
                 for key, label in self._DROP_LABELS if self._drop_pending.get(key)]
        self._drop_pending = {}
        self._drop_last_log = now
        head = "지난 {:.0f}초 동안 ".format(span) if span is not None else ""
        return "[hub] 연결 보호: {}{} 을(를) 끊었습니다.".format(head, " · ".join(parts))

    def _flush_drop_log(self):
        with self._drop_lock:
            self._drop_timer = None
            line = self._drop_line_locked(time.monotonic())
        if line:
            print(line, flush=True)


def create_server(host: str = None, port: int = None, ctx=None) -> HubServer:
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("font/woff2", ".woff2")
    if ctx is None:
        from .app import AppContext
        ctx = AppContext()
    return HubServer((host or config.host, port if port is not None else config.port),
                     HubHandler, ctx)
