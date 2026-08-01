"""등록된 바로가기 URL 의 응답 상태·지연을 점검한다.

주의점 두 가지:
1. **SSRF** — 점검 대상은 사용자가 입력한 URL 이다. 보내기 전에 ssrf.resolve_and_check 로
   해석된 주소를 검사한다.
2. **리다이렉트 추적 금지** — 3xx 를 따라가면 SSRF 가드를 통과한 주소가 루프백으로
   되돌려질 수 있다. 리다이렉트는 따라가지 않고 '3xx 응답' 자체를 결과로 보고한다.
"""

from __future__ import annotations

import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .ssrf import ValidationError, normalize_url, resolve_and_check

USER_AGENT = "GlobalDCServiceHub-HealthCheck/1.0"

STATUS_HEALTHY = "healthy"      # 2xx/3xx
STATUS_WARNING = "warning"      # 4xx/5xx — 살아 있으나 정상 응답 아님
STATUS_UNREACHABLE = "unreachable"
STATUS_BLOCKED = "blocked"      # SSRF 가드 차단


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

    opener = urllib.request.build_opener(_NoRedirect,
                                         urllib.request.HTTPSHandler(context=_tls_context(tls_verify)))
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


def check_many(targets, *, timeout: float = 4.0, concurrency: int = 8,
               tls_verify: bool = True, allow_private: bool = True) -> list:
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
            pool.submit(check_url, url, timeout=timeout, tls_verify=tls_verify,
                        allow_private=allow_private)
            for _, url in normalized
        ]
        results = []
        for (shortcut_id, _), future in zip(normalized, futures):
            result = future.result()
            if shortcut_id:
                result["id"] = shortcut_id
            results.append(result)
    return results
