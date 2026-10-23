"""검증된 IP 로 핀한 TCP/HTTP 연결 — SSRF DNS 리바인딩 TOCTOU 차단(v2.322 보안 감사).

문제: ssrf.resolve_and_check() 가 getaddrinfo 로 host 를 해석해 주소를 검사한 뒤, 실제 접속은
검증한 IP 가 아니라 **호스트명으로 다시 해석**했다(create_connection((host,port))·urllib.open).
공격자가 TTL=0 권한 DNS 로 검사 시점엔 공인 IP, 접속 시점엔 127.0.0.1/169.254.169.254 를 주면
가드가 유일하게 막던 대역(루프백·링크로컬 메타데이터)에 서버가 대신 접속한다.

해법: 검사와 접속의 IP 를 **핀**한다 — resolve_and_check 가 돌려준 검증 주소로 직접 연결하되,
TLS SNI·인증서 검증 이름과 Host 헤더는 **원 호스트명**을 유지한다(정상 TLS·가상호스트 보존).
"""

from __future__ import annotations

import http.client
import socket
import threading
import urllib.request


def connect_pinned(addresses, port, timeout):
    """검증된 주소들 중 되는 것으로 TCP 연결(host 재해석 없음). 성공 소켓 반환, 실패면 마지막 예외 raise."""
    last = None
    for addr in addresses:
        fam = socket.AF_INET6 if ':' in addr else socket.AF_INET
        s = socket.socket(fam, socket.SOCK_STREAM)
        try:
            s.settimeout(timeout)
            s.connect((addr, port))
            return s
        except OSError as exc:              # TimeoutError 포함(OSError 하위)
            last = exc
            try:
                s.close()
            except OSError:
                pass
    raise last if last else OSError('no addresses to connect')


class RequestDeadline:
    """요청 **전체** 시한 — v2.768(점검 R3-C3-1).

    urllib/http.client 의 timeout 은 소켓 연산(연결·recv 1회) 단위라, 상태줄·헤더·본문을 시한보다 짧은
    간격으로 1바이트씩 흘리는 대상은 요청을 무한정 붙잡는다(재현: 시한 2초 → 12초, 상태줄 상한까지 흘리면
    수일. TLS 위에서도 readline 마다 시한이 따로 걸린다). 점검은 GuardedJob 하나를 자동·수동이 공유하므로 그동안 전 링크 점검이 멈춘다.
    시한이 지나면 워치독이 연결을 shutdown 해 읽던 스레드를 깨운다(EOF/오류로 빠져나옴).

    핀 연결(검사 IP 직접 접속·SNI 유지) 구조는 그대로 두고, 연결 직후의 소켓을 `track` 으로 등록받는다.
    TLS 는 wrap_socket 이 원 소켓 객체를 detach 하므로 **dup 한 디스크립터**를 잡는다 — shutdown(2) 은
    디스크립터가 아니라 소켓에 작용하므로 dup 으로도 원 연결(핸드셰이크 중 포함)이 끊긴다.
    """

    def __init__(self, seconds):
        self._lock = threading.Lock()
        self._socks = []
        self.fired = False
        self._timer = threading.Timer(max(0.05, float(seconds)), self._fire)
        self._timer.daemon = True

    def __enter__(self):
        self._timer.start()
        return self

    def __exit__(self, *exc):
        self._timer.cancel()
        with self._lock:
            socks, self._socks = self._socks, []
        for dup in socks:
            try:
                dup.close()
            except OSError:
                pass
        return False

    @staticmethod
    def _kill(dup):
        try:
            dup.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def track(self, sock):
        try:
            dup = sock.dup()
        except OSError:
            return
        with self._lock:
            self._socks.append(dup)
            fired = self.fired
        if fired:                      # 연결 도중 시한이 이미 지났다 — 바로 끊는다
            self._kill(dup)

    def _fire(self):
        with self._lock:
            self.fired = True
            socks = list(self._socks)
        for dup in socks:
            self._kill(dup)


def _pinned_connection_factory(pinned_ip, https, on_socket=None):
    """urllib do_open 이 부를 연결 팩토리 — pinned_ip 로 dial 하고 Host/SNI 는 원 host 유지."""
    base = http.client.HTTPSConnection if https else http.client.HTTPConnection

    class _Pinned(base):
        def connect(self):
            # create_connection((host,...)) 대신 검증 IP 로 직접 연결(재해석 제거).
            sock = socket.create_connection((pinned_ip, self.port), self.timeout, self.source_address)
            if on_socket is not None:
                on_socket(sock)        # v2.768(R3-C3-1): 전체 시한 워치독 등록(TLS 핸드셰이크 전)
            if https:
                # SNI·인증서 검증 이름은 원 호스트명(self.host)으로 — 리바인딩만 막고 TLS 는 정상.
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
            else:
                self.sock = sock

    return _Pinned


def build_pinned_opener(pinned_ip, *, tls_context, extra_handlers=(), deadline=None):
    """검증 IP 로 핀한 urllib opener. https 는 tls_context(검증 on/off 는 호출부 결정)를 쓴다.

    extra_handlers: 리다이렉트 미추적 핸들러 등 추가 핸들러(호출부 정책 유지).
    deadline: RequestDeadline — 주면 연결 소켓을 등록해 요청 전체 시한을 건다(v2.768 R3-C3-1).
    """
    on_socket = deadline.track if deadline is not None else None

    class _PinnedHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(_pinned_connection_factory(pinned_ip, https=False, on_socket=on_socket), req)

    class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(_pinned_connection_factory(pinned_ip, https=True, on_socket=on_socket),
                                req, context=tls_context)

    return urllib.request.build_opener(*extra_handlers, _PinnedHTTPHandler(), _PinnedHTTPSHandler(context=tls_context))
