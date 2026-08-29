"""등록된 바로가기의 서비스 가동 여부·지연을 점검한다.

점검 방식은 두 가지이며 **기본은 포트 점검**이다(v2.216).

- `port`(기본) — 대상 host:port 로 **TCP 연결이 되는지**만 본다. 사내 서비스는 로그인
  리다이렉트·401·403 을 정상적으로 돌려주는 경우가 많아 HTTP 상태로 판정하면 살아 있는
  서비스가 계속 '확인 필요'로 뜬다. "서비스가 떠 있는가"의 답은 **포트가 응답하는가**다.
- `http` — 예전 방식(HTTP 요청 후 상태코드로 판정). 콘텐츠까지 확인하고 싶을 때 쓴다.

두 방식 모두 지켜야 할 것:
1. **SSRF** — 점검 대상은 사용자가 입력한 URL 이다. 접속 전에 ssrf.resolve_and_check 로
   해석된 주소를 검사한다.
2. **리다이렉트 추적 금지**(http 모드) — 3xx 를 따라가면 SSRF 가드를 통과한 주소가
   루프백으로 되돌려질 수 있다. 따라가지 않고 '3xx 응답' 자체를 결과로 보고한다.
3. 포트 모드는 **연결만 하고 즉시 끊는다** — 바이트를 보내지 않으므로 대상 애플리케이션의
   로그를 오염시키지 않고, TLS 핸드셰이크도 하지 않아 자체서명 인증서와 무관하다.
"""

from __future__ import annotations

import socket
import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

from .ssrf import ValidationError, normalize_url, resolve_and_check
from .pinned import connect_pinned, build_pinned_opener  # v2.322: 검증 IP 핀(리바인딩 TOCTOU 차단)

USER_AGENT = "GlobalDCServiceHub-HealthCheck/1.0"

STATUS_HEALTHY = "healthy"      # 포트 응답 / HTTP 2xx·3xx
STATUS_WARNING = "warning"      # HTTP 4xx·5xx — 살아 있으나 정상 응답 아님(http 모드 전용)
STATUS_UNREACHABLE = "unreachable"
STATUS_BLOCKED = "blocked"      # SSRF 가드 차단

METHOD_PORT = "port"
METHOD_HTTP = "http"
DEFAULT_SCHEME_PORTS = {"http": 80, "https": 443}


def target_port(url: str) -> int:
    """URL 에서 점검할 TCP 포트. 명시 포트가 우선, 없으면 스킴 기본값."""
    parts = urlsplit(url)
    try:
        if parts.port:
            return parts.port
    except ValueError:
        pass                                    # 포트 자리가 숫자가 아니면 스킴 기본값
    return DEFAULT_SCHEME_PORTS.get(parts.scheme, 443)


def check_port(url: str, *, timeout: float = 4.0, allow_private: bool = True) -> dict:
    """TCP 연결만으로 가동 여부를 본다. 연결되면 healthy, 거부/타임아웃이면 unreachable."""
    started = time.monotonic()

    def elapsed_ms() -> int:
        return int((time.monotonic() - started) * 1000)

    try:
        target = normalize_url(url)
    except ValidationError as exc:
        return {"url": url, "status": STATUS_BLOCKED, "statusCode": 0,
                "latencyMs": 0, "message": str(exc), "method": METHOD_PORT}

    addresses, reason, kind = resolve_and_check(target, allow_private=allow_private)
    if reason:
        status = STATUS_BLOCKED if kind == "blocked" else STATUS_UNREACHABLE
        return {"url": target, "status": status, "statusCode": 0, "latencyMs": elapsed_ms(),
                "message": reason, "addresses": addresses, "method": METHOD_PORT}

    port = target_port(target)
    try:
        # v2.322 보안 감사: 호스트명 재해석(create_connection((host,port)))은 리바인딩 TOCTOU 를
        # 연다 — resolve_and_check 가 검증한 addresses 로만 직접 연결한다(host 재해석 제거).
        connect_pinned(addresses, port, timeout).close()  # 연결 확인 즉시 종료 — 바이트 미전송
        return {"url": target, "status": STATUS_HEALTHY, "statusCode": 0,
                "latencyMs": elapsed_ms(), "message": f"포트 {port} 응답",
                "addresses": addresses, "port": port, "method": METHOD_PORT}
    except (TimeoutError, socket.timeout):
        return {"url": target, "status": STATUS_UNREACHABLE, "statusCode": 0,
                "latencyMs": elapsed_ms(), "message": f"포트 {port} 응답 없음(시간 초과)",
                "addresses": addresses, "port": port, "method": METHOD_PORT}
    except OSError as exc:
        return {"url": target, "status": STATUS_UNREACHABLE, "statusCode": 0,
                "latencyMs": elapsed_ms(),
                "message": f"포트 {port} 연결 실패({exc.strerror or exc})",
                "addresses": addresses, "port": port, "method": METHOD_PORT}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """리다이렉트를 따라가지 않고 3xx 응답을 그대로 돌려준다."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def _tls_context(verify: bool):
    """자체서명 허용이 필요할 때만 '이 호출에만' 적용되는 컨텍스트를 만든다.

    전역 TLS 설정을 건드리지 않는다 — 프로세스 전체의 검증을 끄면 이 도구가 아닌
    다른 요청까지 오염된다.
    """
    if verify:
        return ssl.create_default_context()
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _classify(code: int) -> str:
    if 200 <= code < 400:
        return STATUS_HEALTHY
    return STATUS_WARNING


def check_url(url: str, *, timeout: float = 4.0, tls_verify: bool = True,
              allow_private: bool = True) -> dict:
    started = time.monotonic()

    def elapsed_ms() -> int:
        return int((time.monotonic() - started) * 1000)

    try:
        target = normalize_url(url)
    except ValidationError as exc:
        return {"url": url, "status": STATUS_BLOCKED, "statusCode": 0,
                "latencyMs": 0, "message": str(exc)}

    addresses, reason, kind = resolve_and_check(target, allow_private=allow_private)
    if reason:
        # 이름 해석 실패는 보안 차단이 아니라 '닿지 않는 링크'다 — 구분해서 보고한다.
        status = STATUS_BLOCKED if kind == "blocked" else STATUS_UNREACHABLE
        return {"url": target, "status": status, "statusCode": 0,
                "latencyMs": elapsed_ms(), "message": reason,
                "addresses": addresses}

    # v2.322 보안 감사: urllib 은 target URL 의 host 를 재해석한다(리바인딩 TOCTOU). 검증된
    # addresses[0] 로 핀한 opener 를 쓰되 Host/TLS SNI 는 원 호스트명 유지(_NoRedirect 정책 보존).
    opener = build_pinned_opener(addresses[0], tls_context=_tls_context(tls_verify), extra_handlers=(_NoRedirect,))
    request = urllib.request.Request(target, method="GET", headers={
        "User-Agent": USER_AGENT,
        # 본문 전체를 받을 이유가 없다 — 서버가 지원하면 첫 바이트만.
        "Range": "bytes=0-0",
        "Accept": "*/*",
    })

    try:
        with opener.open(request, timeout=timeout) as response:
            code = response.getcode()
            response.read(1024)
            return {"url": target, "status": _classify(code), "statusCode": code,
                    "latencyMs": elapsed_ms(), "message": f"HTTP {code}",
                    "addresses": addresses}
    except urllib.error.HTTPError as exc:
        # 3xx 는 리다이렉트 미추적으로 여기 떨어질 수 있다 — 살아 있다는 뜻이다.
        return {"url": target, "status": _classify(exc.code), "statusCode": exc.code,
                "latencyMs": elapsed_ms(),
                "message": f"HTTP {exc.code} {exc.reason}".strip(), "addresses": addresses}
    except urllib.error.URLError as exc:
        return {"url": target, "status": STATUS_UNREACHABLE, "statusCode": 0,
                "latencyMs": elapsed_ms(), "message": str(exc.reason),
                "addresses": addresses}
    except (TimeoutError, OSError) as exc:
        return {"url": target, "status": STATUS_UNREACHABLE, "statusCode": 0,
                "latencyMs": elapsed_ms(), "message": str(exc), "addresses": addresses}


def check_one(url: str, *, method: str = METHOD_PORT, timeout: float = 4.0,
              tls_verify: bool = True, allow_private: bool = True) -> dict:
    """설정된 방식으로 1건 점검. 알 수 없는 값은 포트 점검으로 본다(안전한 기본값)."""
    if method == METHOD_HTTP:
        result = check_url(url, timeout=timeout, tls_verify=tls_verify,
                           allow_private=allow_private)
        result.setdefault("method", METHOD_HTTP)
        return result
    return check_port(url, timeout=timeout, allow_private=allow_private)


def check_many(targets, *, timeout: float = 4.0, concurrency: int = 8,
               tls_verify: bool = True, allow_private: bool = True,
               method: str = METHOD_PORT) -> list:
    """[{id?, url}] 또는 [url] 목록을 동시 점검한다.

    동시 개수를 제한하는 이유는 28개 사이트 × 수십 링크를 한꺼번에 열면 순간
    소켓/CPU 사용이 튀기 때문이다(수집기 동시성 제한과 같은 이유).
    """
    normalized = []
    for entry in targets:
        if isinstance(entry, dict):
            normalized.append((entry.get("id"), entry.get("url", "")))
        else:
            normalized.append((None, entry))

    if not normalized:
        return []

    workers = max(1, min(concurrency, len(normalized)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(check_one, url, method=method, timeout=timeout,
                        tls_verify=tls_verify, allow_private=allow_private)
            for _, url in normalized
        ]
        results = []
        for (shortcut_id, url), future in zip(normalized, futures):
            # 항목 격리(확정 버그 수정) — 예전에는 future.result() 를 무보호로 불러서, 대상 **1건**의
            # 예상 외 예외가 이 루프를 뚫고 나가 그 주기의 **모든** 점검 결과·이력·전이 알림이
            # 통째로 유실됐다(자동 점검은 traceback 만 남기고 조용히 멈춰 대시보드는 낡은 결과를
            # 계속 표시 = 모니터링 정지). 실제 트리거는 잘못된 포트 URL 의 ValueError 였고 그건
            # ssrf 쪽에서 막았지만, '1건이 전체를 죽이는' 구조 자체를 없애야 재발하지 않는다.
            # 개별 실패는 unreachable 로 강등해 그 항목만 표시가 나빠지게 한다(실패 격리 원칙).
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001 - 어떤 예외든 그 항목만 격리한다
                result = {"url": url, "status": STATUS_UNREACHABLE, "statusCode": 0,
                          "latencyMs": 0, "message": f"점검 중 오류: {type(exc).__name__}: {exc}"}
            if shortcut_id:
                result["id"] = shortcut_id
            results.append(result)
    return results
