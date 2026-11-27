"""인바운드 수신 단계 시한(보안 잔여 11-27 L12).

핸들러 `timeout`(소켓 시한)은 recv **1회** 단위라, 요청 줄·헤더·본문을 시한보다 조금 짧은 간격으로
1바이트씩 흘리는 연결(slowloris)은 끊기지 않고 연결 자리를 무한정 쥐었다. 아웃바운드는 v2.768
`pinned.RequestDeadline` 이 요청 전체 시한을 걸지만 인바운드에는 대칭이 없었다.

여기서는 워치독 스레드 대신 `rfile` 의 원시 층에 끼우는 리더로 막는다 — recv 마다 소켓 시한을
'유휴 시한' 과 '단계 남은 시간' 중 작은 값으로 걸고, 남은 시간이 없으면 recv 전에 예외를 던진다.
요청마다 타이머 스레드·dup FD·shutdown/close 경합이 없고, 시한 초과가 **EOF 가 아니라 예외**라
'shutdown 뒤 EOF 를 헤더 끝으로 읽어 잘린 요청을 처리' 하는 v2.769 함정이 구조적으로 생기지 않는다.

본문 시한은 **실제로 받은 바이트**만큼 늘린다(Apache mod_reqtimeout `MinRate` 와 같은 방식) — 선언한
Content-Length 로 늘리면 '1MiB 를 선언하고 19초마다 1바이트' 로 74~300초를 공짜로 쥘 수 있다.
"""

from __future__ import annotations

import io
import socket
import time


class InboundDeadline(Exception):
    """수신 단계 시한 초과.

    ⚠ `TimeoutError`/`socket.timeout`/`OSError` 의 하위로 만들지 말 것 — stdlib
    `BaseHTTPRequestHandler.handle_one_request` 가 그것을 삼켜 'Request timed out' 로그로 접고(우리 log_error 는
    'timed out' 을 지운다) 카운트·응답 분기를 못 하며, BufferedReader·peek 의 OSError 처리 경로(=조용한 유휴 종료)로 섞인다.
    """

    def __init__(self, phase: str):
        super().__init__(phase)
        self.phase = phase   # 'header' | 'body' | 'linger'


def phase_allowance(received: int, *, base: float, min_rate: float = 0, cap: float = None) -> float:
    """단계 시작부터 허용하는 시간(초) = base + 받은 바이트 / 최저 속도, 상한 cap.

    min_rate 가 0 이면 base 고정(헤더 단계). 받은 바이트만 센다 — 선언한 길이로 늘리지 않는다.
    """
    allowance = max(0.0, float(base))
    if min_rate and min_rate > 0:
        allowance += max(0, int(received)) / float(min_rate)
    if cap is not None:
        allowance = min(float(cap), allowance)
    return allowance


class PhaseReader(io.RawIOBase):
    """`rfile` 의 원시 층. 단계(phase)가 없으면 유휴(keep-alive 대기) — 소켓 시한(idle)만 적용한다.

    단계가 있으면 recv 마다 `settimeout(min(idle, 남은 시간))` → recv → `finally: settimeout(idle)`.
    불변: readinto 가 돌아오면 소켓 시한은 항상 idle 이다(응답 쓰기가 짧은 단계 잔여 시한으로 끊기지 않게).
    소켓을 닫지 않는다(소켓 수명은 서버의 shutdown_request 가 쥔다).
    """

    def __init__(self, sock, idle_timeout, clock=time.monotonic):
        super().__init__()
        self._sock = sock
        self._idle = idle_timeout
        self._clock = clock
        self.phase = None
        self.received = 0
        self.eof_in_phase = False
        self._start = 0.0
        self._base = 0.0
        self._rate = 0
        self._cap = None

    def readable(self):
        return True

    def begin(self, phase: str, seconds: float, *, min_rate: float = 0, cap: float = None) -> None:
        self.phase = phase
        self.received = 0
        self.eof_in_phase = False
        self._start = self._clock()
        self._base = max(0.0, float(seconds))
        self._rate = min_rate
        self._cap = cap

    def end(self) -> None:
        self.phase = None

    def remaining(self) -> float:
        if self.phase is None:
            return float("inf")
        return self._start + phase_allowance(self.received, base=self._base, min_rate=self._rate,
                                             cap=self._cap) - self._clock()

    def readinto(self, buf):
        if self.phase is None:
            return self._sock.recv_into(buf)   # 유휴 — socket.timeout 그대로(조용한 종료 경로)
        remaining = self.remaining()
        if remaining <= 0:
            raise InboundDeadline(self.phase)
        self._sock.settimeout(min(self._idle, remaining) if self._idle else remaining)
        try:
            n = self._sock.recv_into(buf)
        except socket.timeout:
            raise InboundDeadline(self.phase) from None
        finally:
            self._sock.settimeout(self._idle)
        if n == 0:
            self.eof_in_phase = True   # 빈 줄 대신 EOF 로 끝난 헤더 · 짧게 끝난 본문 판정에 쓴다
        else:
            self.received += n
        return n
