/**
 * focusmon/collector.js — 서버 1대의 수집기(v2.976). **SSH 세션 하나를 열어 두고** 고정 스크립트의 줄을 받는다.
 *
 * ── 규약(docs/rules/security-api.md v2.923 · v2.929 와 같은 축) ────────────────────────────────────────────
 *  · 접속은 공용 `withSsh`(호스트키 확인 S-01 · 구형 알고리즘 폴백) — 개인키는 이 노드의 `focusmon_key`(util/sshKeyStore.js). 비밀번호 경로 없음.
 *  · 명령은 상수(script.js) — 주기만 고른다.
 *  · **인증 거부는 자동으로 다시 시도하지 않는다**(util/authGuard.js — 2초마다 다시 로그인하면 계정이 잠긴다). 식별자 `fm|<대상 id>` ·
 *    자격 지문 = 계정@주소:포트 + 키 지문 — 셋 중 하나가 바뀌면(키를 바꿈 · 계정 수정) 스스로 재개한다. 사람이 ‘다시 연결’ 하면 정지를 지운다.
 *  · 호스트키 거부는 인증 실패가 아니다(비밀번호 · 키 서명 전에 끊긴다) — 60초마다 다시 본다(승인하면 붙는다 · 로그인 시도 0).
 *  · 리눅스가 아니면(HELLO 의 uname) 멈추고 그 사실을 말한다 — RHEL 7 이 아닌 리눅스는 수집하되 ‘검증 안 된 OS’ 라고 말한다.
 *  · 닿지 않으면 10초 → 30초 → 60초 간격으로 다시 붙는다(로그인 이전 단계 실패라 계정 잠금과 무관).
 *  · 세션이 끊기면(반복문 수명 6시간 · 대상 재부팅 · 회선) 같은 규칙으로 다시 연다.
 * ── 표본 ───────────────────────────────────────────────────────────────────────────────────────────────
 *  · 표본 시각 = 이 노드가 프레임을 받은 시각(대상 시계를 믿지 않는다) · 간격(dt)은 대상 uptime 차이.
 *  · 구성 구획(30초)은 마지막 값을 들고 다음 프레임에 쓴다. 프로세스 상위 30 은 PROC 구획 둘의 차이.
 */
import { withSsh, isSshAuthError, isSshHostKeyError } from '../proxy/sshExec.js';
import { createAuthGuard } from '../util/authGuard.js';
import { scriptFor, normInterval, normProcEvery } from './script.js';
import { loadWindow, nodeCounters } from './load.js';
import { createFrameParser, frameToRaw, LINE_MAX } from './parse.js';
import { computeSample, topProcs } from './rates.js';

export const focusAuthGuard = createAuthGuard({ file: 'focusmon-auth-stops.json' });
export const READY_TIMEOUT_MS = 15_000;
const BACKOFF_MS = Object.freeze([10_000, 30_000, 60_000]);
/** 이보다 짧게 끝난 세션은(표본이 있어도) 정상 종료로 보지 않는다 — 반복문의 정상 수명은 6시간이다. */
export const SHORT_SESSION_MS = 60_000;
/** 무출력 감시 시한 — 주기의 5배와 30초 중 큰 값. */
export const idleLimitMs = (iv) => Math.max(30_000, normInterval(iv) * 5_000);
const HOSTKEY_RETRY_MS = 60_000;

export const authIdOf = (t) => `fm|${t.id}`;
/** 자격 지문 — 계정 · 주소 · 포트 · 키 지문 중 하나라도 바뀌면 정지가 풀린다(authGuard 규칙 2). 비밀이 아니다. */
export const authDevOf = (t, keyFp) => ({ id: authIdOf(t), username: `${t.username}@${t.host}:${t.port}`, password: String(keyFp || '') });

const short = (e) => String(e?.message || e || '').replace(/\s+/g, ' ').slice(0, 240);

/**
 * @param {object} target  { id, host, port, username }
 * @param {object} o
 * @param {number} o.interval
 * @param {object} o.keys      sshKeyStore 인스턴스
 * @param {Function} o.onSample (sample, {ts, hello}) → void
 * @param {Function} o.onProcs  ({n, top}, {ts}) → void
 * @param {Function} o.onStatus (status) → void
 * @param {Function} [o.connect] 테스트 주입(withSsh 대체)
 */
export function createCollector(target, { interval, procEvery, keys, onSample, onProcs, onStatus, onLoad, connect = withSsh, now = () => Date.now() } = {}) {
  const t = { ...target };
  let iv = normInterval(interval);
  let pe = normProcEvery(procEvery); // v2.983 프로세스 표본 주기(설정)
  let stopped = false; let ctl = null; let timer = null; let fails = 0; let busy = false;
  let status = { state: 'connecting', since: now(), lastSampleAt: null, error: '', hello: null, osVerified: null, interval: iv };
  let sessionSamples = 0;
  let prevRaw = null; let prevAt = 0; let topo = {}; let blk = null; let users = new Map(); let prevProc = null; let prevProcUp = null; let hello = null;
  let units = new Map(); let prevIo = null; let usersUp = null; let unitsUp = null; // v2.981 서비스(30초) · 앞 입출력(프로세스 주기) · 맵을 읽은 uptime(반증 F6)
  // v2.983 수집 부하 — ##SELF 창(보통 30초): 앞 SELF 이후 받은 바이트(묶음별) · 프레임 · 구성 · 프로세스 횟수. 새 세션이면 비운다(셸이 바뀐다).
  let ldPrev = null; let ld = null;
  const ldReset = () => { ld = { bytes: { base: 0, topo: 0, proc: 0, self: 0 }, frames: 0, topoRuns: 0, procRuns: 0 }; };
  ldReset();

  const setStatus = (patch) => {
    status = { ...status, ...patch, interval: iv };
    if (patch.state && patch.state !== 'ok') status.since = now();
    try { onStatus?.({ ...status }); } catch { /* */ }
  };

  const schedule = (ms) => { if (stopped) return; clearTimeout(timer); timer = setTimeout(run, ms); timer.unref?.(); };

  function onFrame(frame) {
    const raw = frameToRaw(frame);
    if (raw.bytes) for (const k of Object.keys(ld.bytes)) ld.bytes[k] += raw.bytes[k] || 0;
    ld.frames += 1; if (raw.netTopo) ld.topoRuns += 1; if (raw.proc) ld.procRuns += 1;
    if (raw.self?.self) {
      const snap = { up: raw.up, self: raw.self.self, sshd: raw.self.sshd, groups: raw.self.groups };
      const w = ldPrev ? loadWindow(ldPrev, snap, { tck: hello?.tck, page: hello?.page, ncpu: hello?.ncpu, ...ld }) : null;
      if (w) {
        const load = { ...w, at: now(), interval: iv, procEvery: pe, procs: raw.proc ? raw.proc.length : (prevProc ? prevProc.length : null) };
        status.load = load;
        try { onLoad?.(load); } catch { /* */ }
      }
      ldPrev = snap; ldReset();
    }
    if (raw.netTopo) topo = raw.netTopo;
    if (raw.blk) blk = raw.blk;
    if (raw.ps) { users = raw.ps; usersUp = raw.up; }
    if (raw.unit) { units = raw.unit; unitsUp = raw.up; }
    const ts = now();
    if (prevRaw && ts - prevAt < 120_000) {
      const s = computeSample(prevRaw, raw, { topo, blk });
      if (s.dt != null) {
        try { onSample?.(s, { ts, hello }); } catch { /* */ }
        status.lastSampleAt = ts;
        sessionSamples += 1;
        fails = 0; // 실패 횟수는 '표본을 받았을 때' 만 되돌린다 — 접속 성공만으로 되돌리면 곧바로 끝나는 세션이 1초마다 다시 로그인했다(반증 3번)
        if (status.state !== 'ok') setStatus({ state: 'ok', error: '' });
      }
    }
    if (raw.proc) {
      if (prevProc && raw.up != null && prevProcUp != null) {
        const tp = topProcs(prevProc, raw.proc, { dt: raw.up - prevProcUp, tck: hello?.tck, page: hello?.page, ncpu: hello?.ncpu, up: raw.up, users, units, io: raw.io, prevIo, dacct: hello?.dacct ?? null, usersUp, unitsUp });
        if (tp) { try { onProcs?.(tp, { ts }); } catch { /* */ } }
      }
      prevProc = raw.proc; prevProcUp = raw.up; prevIo = raw.io || null;
    }
    prevRaw = raw; prevAt = ts;
  }

  async function run() {
    if (stopped || busy) return;
    busy = true;
    try { await runOnce(); } finally { busy = false; }
  }

  async function runOnce() {
    if (stopped) return;
    const keyInfo = keys.keyInfo();
    const pem = keys.privateKeyForConnect();
    if (!pem) { setStatus({ state: 'no-key', error: keyInfo?.error || '이 노드에 SSH 키가 없습니다 — 대상 · 키 화면에서 키를 만드세요.' }); schedule(60_000); return; }
    const dev = authDevOf(t, keyInfo.fingerprint);
    const stop = focusAuthGuard.authStopFor(dev);
    if (stop) { setStatus({ state: 'auth', error: `키 로그인이 거부돼 멈춰 있습니다(${stop.reason}) — 공개키를 넣은 뒤 ‘다시 연결’ 을 누르세요.` }); return; }
    setStatus({ state: 'connecting', error: '' });
    ctl = new AbortController();
    const mine = ctl;
    let gotHelloOs = true;
    let idleAbort = false;
    sessionSamples = 0;
    ldPrev = null; ldReset(); // 새 셸 — 앞 창과 잇지 않는다
    const startedAt = now();
    const parser = createFrameParser({
      onHello: (h) => {
        hello = h;
        if (!h.isLinux) { gotHelloOs = false; setStatus({ state: 'unsupported-os', hello: h, error: '리눅스가 아닙니다 — 집중 모니터링은 지금 리눅스만 수집합니다.' }); mine.abort(); return; }
        setStatus({ hello: h, osVerified: h.rhelMajor ? h.rhelMajor.startsWith('7.') : false });
      },
      onFrame,
    });
    try {
      await connect({ host: t.host, port: t.port, username: t.username, privateKey: pem, readyTimeout: READY_TIMEOUT_MS, signal: mine.signal },
        async (api) => {
          focusAuthGuard.clearAuthStop(dev.id);
          // 무출력 감시 — 반복문은 주기마다 줄을 낸다. 출력 없이 열린 채널 · 중간에 멈춘 원격 명령이 세션을 무기한 붙잡지 않게 끊는다(반증 9번).
          let lastLineAt = now();
          const idleMs = idleLimitMs(iv);
          const wd = setInterval(() => { if (now() - lastLineAt > idleMs && !mine.signal.aborted) { idleAbort = true; mine.abort(); } }, Math.min(5_000, idleMs));
          wd.unref?.();
          try {
            // v2.983: 받은 바이트 · 해석 시간을 노드 카운터에(수집 부하의 '노드 몫' — 줄 받기 · 프레임 계산만, SSH 복호는 빠진다)
            const r = await api.execStream(scriptFor(iv, pe), { onLine: (l) => { lastLineAt = now(); const t0 = performance.now(); nodeCounters.rxBytes += String(l ?? '').length + 1; parser.push(l); nodeCounters.parseMs += performance.now() - t0; }, signal: mine.signal, maxLine: LINE_MAX + 64 });
            return { stream: r };
          } finally { clearInterval(wd); }
        }, { signal: mine.signal });
      if (stopped) return;
      if (mine.signal.aborted && !idleAbort) { if (!gotHelloOs) return; schedule(0); return; }
      // 세션이 끝났다 — 반복문이 스스로 끝난 것(6시간)이면 곧바로 다시 연다. 표본 없이 곧바로 끝났으면(계정 셸 nologin · tcsh ·
      // 키의 command= · ForceCommand · sftp 전용 · 출력 없음) 실패로 보고 물러난다 — 성공 로그인을 1초마다 되풀이하지 않는다(반증 3번).
      const ranMs = now() - startedAt;
      if (!idleAbort && sessionSamples > 0 && ranMs >= SHORT_SESSION_MS) {
        setStatus({ state: 'connecting', error: '세션이 끝나 다시 엽니다.' });
        schedule(1_000);
        return;
      }
      const wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)];
      fails += 1;
      setStatus({ state: 'error', error: idleAbort
        ? `원격 명령이 ${Math.round(idleLimitMs(iv) / 1000)}초 동안 아무것도 내지 않아 세션을 끊었습니다 — ${Math.round(wait / 1000)}초 뒤 다시 시도합니다.`
        : `로그인은 됐지만 세션이 곧바로 끝났습니다(표본 ${sessionSamples}개) — 계정 셸이 bash 인지, 키에 command= · ForceCommand 제한이 없는지 확인하세요. ${Math.round(wait / 1000)}초 뒤 다시 시도합니다.` });
      schedule(wait);
    } catch (e) {
      if (stopped) return;
      if (mine.signal.aborted && !gotHelloOs) return;
      if (mine.signal.aborted && !idleAbort) { schedule(0); return; } // 주기 변경 — 바로 새 명령으로
      if (isSshHostKeyError(e)) { setStatus({ state: 'hostkey', error: short(e) }); schedule(HOSTKEY_RETRY_MS); return; }
      if (isSshAuthError(e)) {
        focusAuthGuard.markAuthStopped(dev.id, dev, '키 로그인 거부');
        setStatus({ state: 'auth', error: '키 로그인이 거부됐습니다 — 이 노드의 공개키가 대상 계정의 authorized_keys 에 있는지 확인한 뒤 ‘다시 연결’ 을 누르세요. 자동으로 다시 시도하지 않습니다.' });
        return;
      }
      const wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)];
      fails += 1;
      setStatus({ state: idleAbort ? 'error' : 'unreachable', error: idleAbort ? `원격 명령이 출력 없이 멈춰 세션을 끊었습니다 — ${Math.round(wait / 1000)}초 뒤 다시 시도합니다.` : short(e) });
      schedule(wait);
    }
  }

  return {
    id: t.id,
    target: () => ({ ...t }),
    status: () => ({ ...status }),
    start() { stopped = false; schedule(0); },
    /** 주기 변경 — 지금 명령을 끊고 새 주기 상수로 다시 연다(앞 프레임은 유지 — 다음 표본의 dt 가 길어질 뿐). */
    setInterval(next) {
      const n = normInterval(next);
      if (n === iv) return false;
      iv = n; status.interval = n;
      if (busy && ctl && !ctl.signal.aborted) ctl.abort(); else schedule(0);
      return true;
    },
    /** v2.983 프로세스 표본 주기 변경 — 주기 변경과 같이 지금 명령을 끊고 새 상수로 다시 연다. */
    setProcEvery(next) {
      const n = normProcEvery(next);
      if (n === pe) return false;
      pe = n;
      if (busy && ctl && !ctl.signal.aborted) ctl.abort(); else schedule(0);
      return true;
    },
    procEvery: () => pe,
    /** 사람이 ‘다시 연결’ — 인증 정지를 지우고 지금 다시 시도한다. */
    retry() {
      focusAuthGuard.clearAuthStop(authIdOf(t));
      fails = 0;
      if (busy && ctl && !ctl.signal.aborted) ctl.abort(); else schedule(0);
    },
    stop() {
      stopped = true; clearTimeout(timer);
      if (ctl && !ctl.signal.aborted) ctl.abort();
      setStatus({ state: 'stopped' });
    },
  };
}

/**
 * 연결 시험 1회 — HELLO 만 받고 끊는다(반복문 상수의 앞부분을 쓰지 않고 별도 상수 — 아래). 인증 거부는 같은 가드에 남긴다.
 * @returns {Promise<{ok:boolean, kind:string, hello?:object, error?:string, ms:number}>}
 */
export const TEST_COMMAND = [
  'LC_ALL=C; export LC_ALL',
  "echo '##HELLO 1'",
  'echo "uname $(uname -srm 2>/dev/null)"',
  'echo "rel $(head -n 1 /etc/redhat-release 2>/dev/null)"',
  'echo "tck $(getconf CLK_TCK 2>/dev/null)"',
  'echo "page $(getconf PAGESIZE 2>/dev/null)"',
  'echo "ncpu $(grep -c ^processor /proc/cpuinfo 2>/dev/null)"',
  'echo "hidepid $(grep -c hidepid /proc/mounts 2>/dev/null)"',
  'echo "host $(hostname 2>/dev/null)"',
  "echo '##END'",
].join('\n');

export async function testTarget(target, { keys, connect = withSsh, timeoutMs = 25_000 } = {}) {
  const t0 = Date.now();
  const info = keys.keyInfo();
  const pem = keys.privateKeyForConnect();
  if (!pem) return { ok: false, kind: 'no-key', error: info?.error || '이 노드에 SSH 키가 없습니다.', ms: 0 };
  const dev = authDevOf(target, info.fingerprint);
  // 정지된 계정이면 시험도 하지 않는다(누를 때마다 로그인 1회 = 잠금 경로 — v2.929 반증 F11 과 같은 판단). ‘다시 연결’ 이 정지를 지운다.
  const stopRec = focusAuthGuard.peekAuthStop(dev);
  if (stopRec) return { ok: false, kind: 'auth-stopped', error: `키 로그인 거부로 멈춰 있습니다(${stopRec.reason}) — 공개키를 넣은 뒤 ‘다시 연결’ 을 누르세요.`, ms: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs); timer.unref?.();
  let hello = null;
  const parser = createFrameParser({ onHello: (h) => { hello = h; } });
  try {
    await connect({ host: target.host, port: target.port, username: target.username, privateKey: pem, readyTimeout: READY_TIMEOUT_MS, signal: ctl.signal },
      async (api) => { const r = await api.exec(TEST_COMMAND, 20_000); String(r.stdout || '').split('\n').forEach((l) => parser.push(l)); return {}; }, { signal: ctl.signal });
    focusAuthGuard.clearAuthStop(dev.id);
    if (!hello) return { ok: false, kind: 'bad-output', error: '서버 정보를 읽지 못했습니다(셸이 sh 계열인지 확인하세요).', ms: Date.now() - t0 };
    if (!hello.isLinux) return { ok: false, kind: 'unsupported-os', hello, error: '리눅스가 아닙니다.', ms: Date.now() - t0 };
    return { ok: true, kind: hello.rhelMajor?.startsWith('7.') ? 'ok' : 'os-unverified', hello, ms: Date.now() - t0 };
  } catch (e) {
    if (isSshHostKeyError(e)) return { ok: false, kind: 'hostkey', error: short(e), ms: Date.now() - t0 };
    if (isSshAuthError(e)) { focusAuthGuard.markAuthStopped(dev.id, dev, '키 로그인 거부(연결 시험)'); return { ok: false, kind: 'auth', error: '키 로그인이 거부됐습니다 — 공개키를 확인하세요.', ms: Date.now() - t0 }; }
    if (ctl.signal.aborted) return { ok: false, kind: 'timeout', error: `${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`, ms: Date.now() - t0 };
    return { ok: false, kind: 'unreachable', error: short(e), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}
