"""URL 검증 + SSRF 가드.

바로가기 URL 은 사용자가 자유롭게 입력하고, '링크 점검' 기능은 그 URL 을 서버가
직접 찔러 본다. 즉 서버를 대신 요청 보내는 도구로 쓸 수 있으므로(SSRF) 대상 주소를
반드시 검사해야 한다.

정책은 본 저장소의 기존 규칙과 같다:
- RFC1918(10/172.16/192.168) 사내망은 **허용** — 애초에 사내 서비스 포탈이 대상이다.
- 루프백·링크로컬(169.254.169.254 클라우드 메타데이터 포함)·멀티캐스트·미지정 주소는 **차단**.
- 10진수/8진수/IPv4-mapped 같은 우회 표기는 '해석된 주소'를 검사해 자동으로 걸린다.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = ("http", "https")


class ValidationError(ValueError):
    """사용자에게 그대로 보여줄 수 있는 검증 실패."""


def normalize_url(raw: str) -> str:
    """스킴이 없으면 https:// 를 붙이고, 허용 스킴인지 확인한 URL 을 돌려준다.

    javascript:/data:/file: 등을 그대로 저장하면 대시보드의 '바로가기' 클릭이
    스크립트 실행 경로가 된다 — 저장 시점에 막는다.
    """
    if not isinstance(raw, str):
        raise ValidationError("URL 이 필요합니다.")
    url = raw.strip()
    if not url:
        raise ValidationError("URL 이 필요합니다.")
    if len(url) > 2048:
        raise ValidationError("URL 이 너무 깁니다(2048자 이하).")

    if "://" not in url:
        # 스킴 없는 'grafana.internal.dc/x' 는 https 로 보정한다.
        if url.split("/", 1)[0].lower().startswith(("javascript:", "data:", "vbscript:")):
            raise ValidationError("http/https URL 만 등록할 수 있습니다.")
        url = "https://" + url.lstrip("/")

    parts = urlsplit(url)
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise ValidationError("http/https URL 만 등록할 수 있습니다.")
    if not parts.hostname:
        raise ValidationError("URL 에 호스트가 없습니다.")
    return url


def _address_block_reason(ip: ipaddress._BaseAddress, allow_private: bool) -> str | None:
    if ip.is_unspecified:
        return "미지정 주소(0.0.0.0)는 점검할 수 없습니다."
    if ip.is_loopback:
        return "루프백 주소(127.0.0.0/8, ::1)는 점검할 수 없습니다."
    if ip.is_link_local:
        return "링크로컬 주소(169.254.0.0/16 — 클라우드 메타데이터 포함)는 점검할 수 없습니다."
    if ip.is_multicast:
        return "멀티캐스트 주소는 점검할 수 없습니다."
    if getattr(ip, "is_reserved", False):
        return "예약 대역 주소는 점검할 수 없습니다."
    if ip.is_private and not allow_private:
        return "사설 대역 점검이 비활성화되어 있습니다(HUB_HEALTH_ALLOW_PRIVATE)."
    return None


def resolve_and_check(url: str, *, allow_private: bool = True):
    """URL 호스트를 해석해 `(주소목록, 사유, 종류)` 를 돌려준다.

    사유가 None 이 아니면 요청을 보내면 안 된다. 해석된 주소 **전부**를 검사하므로
    'DNS 는 공인 IP, 실제로는 루프백' 같은 레코드도 걸린다.

    종류는 화면 표기를 가르는 값이다:
      - "blocked"    : 정책상 금지된 주소(루프백·링크로컬 등) — 보안 차단
      - "unresolved" : 이름 해석 실패 — 단순히 닿지 않는 것이므로 '응답 없음'으로 보인다
    """
    parts = urlsplit(url)
    host = parts.hostname
    if not host:
        return [], "URL 에 호스트가 없습니다.", "blocked"

    # 대괄호 IPv6 리터럴 포함 — hostname 은 이미 벗겨진 형태로 온다.
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None

    if literal is not None:
        # IPv4-mapped IPv6(::ffff:127.0.0.1) 는 내장 v4 주소로 다시 검사한다.
        mapped = getattr(literal, "ipv4_mapped", None)
        target = mapped or literal
        reason = _address_block_reason(target, allow_private)
        return [str(target)], reason, "blocked"

    try:
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80),
                                   proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        return [], f"호스트 이름을 확인할 수 없습니다({exc.strerror or exc}).", "unresolved"

    addresses: list[str] = []
    for info in infos:
        addr = info[4][0]
        if addr in addresses:
            continue
        addresses.append(addr)

    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        ip = getattr(ip, "ipv4_mapped", None) or ip
        reason = _address_block_reason(ip, allow_private)
        if reason:
            return addresses, reason, "blocked"

    if not addresses:
        return [], "호스트 이름을 확인할 수 없습니다.", "unresolved"
    return addresses, None, None
