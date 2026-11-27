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

응답 쓰기도 같은 꼴이다(반증 1회차 M1): `sendall` 1회에 소켓 시한 20초라 응답을 읽지 않는 상대(느린 읽기)가 쓰기마다
20초씩 자리를 쥐었다. `PhaseWriter` 가 쓰기 단계 시한(base + **보낸** 바이트/최저 속도, 상한)을 조각마다 건다.
`ConnPhase` 는 지금 어느 단계인지(언제부터인지)와 연결 단위 느린 단계 누계(반증 2회차 R2-1 — 단계를 갈아타도 이어 쌓는다)를
서버의 입장 표에 알린다 — 가득 찼을 때 '클라이언트를 기다리며 오래 쥔 자리' 를 골라 되찾는 근거다(server.HubServer._reclaim_one_locked).
"""

from __future__ import annotations

import io
import socket
import struct
import time

try:   # 리눅스: 송신 큐에 남은(상대가 아직 받았다고 확인하지 않은) 바이트 — SIOCOUTQ == TIOCOUTQ
    import fcntl
    import termios
    _TIOCOUTQ = getattr(termios, "TIOCOUTQ", None)
except ImportError:   # pragma: no cover — 윈도
    fcntl = None
    _TIOCOUTQ = None


def unacked_bytes(sock):
    """송신 큐에 남은 바이트(리눅스 TCP: write_seq − snd_una). 못 읽으면 None — 호출부는 '보낸 바이트' 로 물러선다."""
    if fcntl is None or _TIOCOUTQ is None:
        return None
    try:
        return max(0, struct.unpack("i", fcntl.ioctl(sock.fileno(), _TIOCOUTQ, b"\0\0\0\0"))[0])
    except (OSError, ValueError, struct.error):
        return None


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


# 클라이언트를 기다리는 단계(되찾기 점수에 쌓는다) · 로그인 세션이면 쌓지 않는 단계
SLOW_PHASES = ("header", "body", "write")
TRUSTED_PHASES = ("body", "write")


def decayed(value: float, at: float, now: float, half_life: float) -> float:
    """value 를 at 부터 now 까지 반감기 half_life 로 줄인 값(half_life <= 0 이면 줄이지 않는다)."""
    if value <= 0:
        return 0.0
    if half_life and half_life > 0 and now > at:
        return value * 2.0 ** (-(now - at) / float(half_life))
    return value


class ConnPhase:
    """연결 하나의 지금 단계 + 느린 단계 누계 — 핸들러(리더·라이터)가 쓰고 서버의 입장 표가 읽는다.

    phase: None(처리 중 · 유휴) | 'header' | 'body' | 'write' | 'linger' · started: 그 단계 시작(monotonic) ·
    shed: 서버가 자리를 되찾으려고 이 연결을 끊었다(핸들러는 응답·집계 없이 조용히 닫는다) ·
    trusted / user: 지금 요청이 로그인 세션을 가졌다 · 그 계정(본문·쓰기 단계는 계정당 몇 개까지 되찾기 대상에서 뺀다 —
    가져오기·복원·백업 내려받기).

    보안 잔여 11-27 L12 · 반증 2회차 R2-1: '지금 단계의 시작' 만 보면 단계마다 되찾기 간격 직전에 다음 단계로 갈아타는 연결
    (유휴 → 헤더 드립 → 본문 드립 → 응답 → 유휴 …)이 한 번도 후보가 되지 않고 자리를 무기한 쥐었다(새 사용자 0/5).
    그래서 **연결 단위로** 클라이언트를 기다린 시간(헤더 · 본문 · 쓰기 — 로그인 세션의 본문 · 쓰기는 빼고)을 반감기로 줄이며
    쌓는다(`slow_score`). 정상 브라우저는 요청 하나에 ms 단위라 거의 0 이고, 갈아타기 공격은 거의 쉼 없이 쌓인다.
    값 대입만 한다(GIL 아래 원자적) — 누계는 (값, 시각) 튜플 하나로 바꿔 끼우고, leave 는 phase 를 먼저 지운 뒤 누계를
    더해 읽는 쪽이 '단계 진행분 + 이미 더한 누계' 를 이중으로 세지 않게(잠깐 덜 세는 쪽 — 잘못 끊지 않는 쪽).
    """

    __slots__ = ("phase", "started", "shed", "trusted", "user", "half_life", "_acc")

    def __init__(self, half_life: float = 20.0):
        self.phase = None
        self.started = 0.0
        self.shed = False
        self.trusted = False
        self.user = None
        self.half_life = half_life
        self._acc = (0.0, 0.0)

    def enter(self, phase, started):
        self.started = started
        self.phase = phase

    def counts(self, phase) -> bool:
        """이 단계가 느린 단계 누계에 들어가는지(지금 요청의 로그인 여부 기준)."""
        return phase in SLOW_PHASES and not (self.trusted and phase in TRUSTED_PHASES)

    def leave(self, phase, now=None):
        if self.phase != phase:
            return
        started = self.started
        self.phase = None
        if self.counts(phase):
            t = time.monotonic() if now is None else now
            self.add_slow(t - started, t)

    def add_slow(self, seconds, now) -> None:
        value, at = self._acc
        self._acc = (decayed(value, at, now, self.half_life) + max(0.0, float(seconds)), now)

    def slow_score(self, now, current: bool = True) -> float:
        """반감기로 줄인 느린 단계 누계(초) + (current 면) 지금 단계가 쌓이는 단계일 때 그 진행분."""
        value, at = self._acc
        score = decayed(value, at, now, self.half_life)
        phase = self.phase
        started = self.started
        if current and phase is not None and self.counts(phase):
            score += max(0.0, now - started)
        return score


def write_chunk_size(base: float, min_rate: float) -> int:
    """쓰기 조각 — 최저 속도로 받는 상대가 조각 하나를 base 의 1/4 안에 받게(허용 시간은 조각이 끝나야 는다)."""
    if not min_rate or min_rate <= 0:
        return 65536
    return max(512, min(65536, int(float(min_rate) * max(0.0, float(base)) / 4)))


class PhaseReader(io.RawIOBase):
    """`rfile` 의 원시 층. 단계(phase)가 없으면 유휴(keep-alive 대기) — 소켓 시한(idle)만 적용한다.

    단계가 있으면 recv 마다 `settimeout(min(idle, 남은 시간))` → recv → `finally: settimeout(idle)`.
    불변: readinto 가 돌아오면 소켓 시한은 항상 idle 이다(응답 쓰기가 짧은 단계 잔여 시한으로 끊기지 않게).
    소켓을 닫지 않는다(소켓 수명은 서버의 shutdown_request 가 쥔다).
    """

    def __init__(self, sock, idle_timeout, clock=time.monotonic, tracker=None):
        super().__init__()
        self._sock = sock
        self._idle = idle_timeout
        self._clock = clock
        self._tracker = tracker
        self.phase = None
        self.received = 0
        self.eof_in_phase = False
        self._start = 0.0
        self._base = 0.0
        self._rate = 0
        self._cap = None

    def readable(self):
        return True

    def begin(self, phase: str, seconds: float, *, min_rate: float = 0, cap: float = None, started=None) -> None:
        """started: 단계 시작 시각(기본 지금) — 새 연결의 첫 헤더는 입장 시각부터 센다(서버가 ConnPhase 에 적어 둔 값)."""
        self.phase = phase
        self.received = 0
        self.eof_in_phase = False
        self._start = self._clock() if started is None else float(started)
        self._base = max(0.0, float(seconds))
        self._rate = min_rate
        self._cap = cap
        if self._tracker is not None:
            self._tracker.enter(phase, self._start)

    def end(self) -> None:
        if self._tracker is not None and self.phase is not None:
            self._tracker.leave(self.phase, self._clock())
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


class PhaseWriter(io.BufferedIOBase):
    """`wfile` 대신 — 응답 쓰기 단계 시한(보안 잔여 11-27 L12 · 반증 1회차 M1).

    단계가 없을 때 첫 write 가 오면 `auto`(base, min_rate, cap)로 'write' 단계를 연다(요청 처리 시간은 세지 않는다 —
    첫 바이트를 쓸 때부터). 조각마다 `settimeout(min(idle, 남은 시간))` → sendall(3.5+ 는 호출 전체 시한) →
    `finally: settimeout(idle)`. 남은 시간 = 시작 + base + **상대가 받은** 바이트/최저 속도(상한 cap) − 지금.
    시한 초과는 `InboundDeadline('write')`, 서버가 자리를 되찾으려고 끊은 연결(tracker.shed)의 쓰기 오류는
    `InboundDeadline('shed')` — 둘 다 핸들러가 조용히 닫는다(BrokenPipe traceback 이 로그에 쌓이지 않게).
    허용 시간은 단계 동안 **상대가 받았다고 확인한** 바이트로만 는다(단계 시작 송신 큐 + 보낸 바이트 − 지금 송신 큐 —
    keep-alive 앞 응답이 아직 빠지는 중이면 그것도 상대의 수신 진척이라 센다). 커널 송신 버퍼는 자동
    조정으로 수 MB 까지 커져 '버퍼에 넣은 바이트' 로 세면 읽지 않는 상대가 버퍼/최저 속도만큼(실측 루프백: base 0.5초에 20초)
    공짜로 쥐었다. 송신 큐를 못 읽는 플랫폼은 보낸 바이트로 센다(상한 · 서버의 자리 되찾기가 여전히 묶는다).
    소켓을 닫지 않는다(소켓 수명은 서버의 shutdown_request 가 쥔다).
    """

    def __init__(self, sock, idle_timeout, clock=time.monotonic, tracker=None, auto=None):
        super().__init__()
        self._sock = sock
        self._idle = idle_timeout
        self._clock = clock
        self._tracker = tracker
        self.auto = auto
        self.phase = None
        self.sent = 0
        self._start = 0.0
        self._base = 0.0
        self._rate = 0
        self._cap = None
        self._chunk = 65536
        self._queued0 = None

    def writable(self):
        return True

    def fileno(self):
        return self._sock.fileno()

    def begin(self, phase: str, seconds: float, *, min_rate: float = 0, cap: float = None) -> None:
        self.phase = phase
        self.sent = 0
        self._start = self._clock()
        self._base = max(0.0, float(seconds))
        self._rate = min_rate
        self._cap = cap
        self._chunk = write_chunk_size(self._base, min_rate)
        self._queued0 = unacked_bytes(self._sock) if min_rate else None
        if self._tracker is not None:
            self._tracker.enter(phase, self._start)

    def end(self) -> None:
        if self._tracker is not None and self.phase is not None:
            self._tracker.leave(self.phase, self._clock())
        self.phase = None

    def delivered(self) -> int:
        """이 단계 동안 상대가 받았다고 확인한 바이트(송신 큐를 못 읽으면 보낸 바이트)."""
        if not self._rate or self._queued0 is None:
            return self.sent
        queued = unacked_bytes(self._sock)
        if queued is None:
            return self.sent
        return max(0, self._queued0 + self.sent - queued)

    def remaining(self) -> float:
        if self.phase is None:
            return float("inf")
        return self._start + phase_allowance(self.delivered(), base=self._base, min_rate=self._rate,
                                             cap=self._cap) - self._clock()

    def _shed(self) -> bool:
        return bool(self._tracker is not None and self._tracker.shed)

    def write(self, data):
        view = memoryview(data).cast("B")
        total = len(view)
        if self.phase is None and self.auto is not None and total:
            base, rate, cap = self.auto
            self.begin("write", base, min_rate=rate, cap=cap)
        if self.phase is None:
            self._sock.sendall(view)   # 단계 없음(auto 미설정) — 예전 동작
            return total
        offset = 0
        while offset < total:
            if self._shed():
                raise InboundDeadline("shed")
            remaining = self.remaining()
            if remaining <= 0:
                raise InboundDeadline(self.phase)
            piece = view[offset:offset + self._chunk]
            self._sock.settimeout(min(self._idle, remaining) if self._idle else remaining)
            try:
                self._sock.sendall(piece)
            except socket.timeout:
                raise InboundDeadline(self.phase) from None
            except OSError:
                if self._shed():
                    raise InboundDeadline("shed") from None
                raise
            finally:
                self._sock.settimeout(self._idle)
            offset += len(piece)
            self.sent += len(piece)
        return total

    def flush(self):
        return None
