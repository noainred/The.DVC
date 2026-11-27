/**
 * util/runtimeCheck.js — Node 런타임 계약과 기동 시 호환성 자가 점검(검토 I-06).
 *
 * 왜 필요한가:
 *   서버의 장비·엣지 통신은 거의 전부 **전역 fetch** 에 **패키지 undici(6.x)의 Agent** 를 `dispatcher` 로 넘긴다
 *   (resilientFetch 의 wanAgent·vCenter·Redfish·Horizon·CVP·스토리지 REST·svcmon … — 개수는 E-report 참고).
 *   전역 fetch 는 Node 가 내장한 undici 이고 그 버전은 Node major 를 따른다. Node 22 의 내장 undici 는 6.x 라
 *   패키지 Agent 와 디스패치 계약이 같지만, 검토 환경 Node 26 에서는 같은 호출이
 *   `UND_ERR_INVALID_ARG: invalid onError method` 로 실패했다(같은 Agent + 패키지 `undici.fetch` 는 200).
 *   ⚠ 이것은 Node 22 에서 Horizon·iDRAC 에 결함이 있다는 증거가 아니다 — **런타임 계약 밖**에서 생기는 실패다.
 *   그 실패가 화면에서는 '장비 연결 실패' 로 보이므로, 런타임 불일치를 **원인으로 따로** 말해야 한다.
 *
 * 계약(한 곳 — 아래 RUNTIME_CONTRACT):
 *   · supportedMajors [22] — 전역 fetch 와 undici 6 Agent 가 같은 계약을 쓰는 major.
 *   · minVersion 22.5.0 — 내장 `node:sqlite` 가 처음 들어간 버전(기술적 하한). **검증한 버전이 아니다**.
 *   · releaseVersion 22.23.5 — CI(ci.yml)·릴리스(release.yml NODE_VERSION)·오프라인 번들(build-package.sh 기본값)이 쓰는 값.
 *     번들 압축본의 기대 해시는 packaging/node-runtime.sha256(저장소 고정값 — SHASUMS256.txt 와 다른 채널)에 둔다.
 *   · securityFloor 22.23.5 — 보안 잔여 11-27 G4: 이 계약이 아는 22.x 보안 릴리스(22.23.4 · 22.23.5)를 모두 담은 가장 낮은 패치.
 *     그보다 낮은 런타임은 계약 안(supported)이어도 '보안 하한 미만(belowSecurityFloor)' 으로 따로 알린다 — 포탈 자동 업그레이드는
 *     앱만 바꾸고 런타임은 설치 패키지 재설치(install.sh)로만 바뀌므로, 알리지 않으면 패치 없는 런타임이 조용히 '정상' 으로 보인다.
 *     불변조건 minVersion ≤ securityFloor ≤ releaseVersion(시험이 고정). 새 22.x 보안 릴리스가 나오면 둘을 함께 올린다.
 *   package.json 3개의 engines(`>=22.5.0 <23`)·`.nvmrc`·`.node-version` 이 이 값과 같아야 하고
 *   `test/rvE_runtimeCheck.test.js` 가 그 일치를 고정한다(어느 한쪽만 바꾸면 테스트가 실패한다).
 *
 * 판정(judgeVersion) — 결과의 belowSecurityFloor: true(보안 하한 미만 — 사전 배포판은 같은 숫자여도 미만) · false(하한 이상 —
 *   '안전하다' 는 뜻이 아니라 '이 계약이 아는 하한 이상' 일 뿐이라 화면·로그는 아무 말도 하지 않는다) · null(판정 안 함 — 계약 밖·판독 불가는 이미 warn).
 *   ⚠ overallState 는 이 값으로 바꾸지 않는다 — 새 state 값을 만들면 구버전 웹 배너가 '모르는 값 → 배너 없음' 으로 조용히 넘긴다(별도 필드가 하위 호환).
 *
 * 판정(judgeVersion):
 *   · release            — releaseVersion 과 정확히 같다.
 *   · supported          — 지원 major 이고 minVersion 이상(패치가 releaseVersion 과 다르면 releaseRelation 'older'|'newer').
 *                          예: 이 저장소의 개발 컨테이너 Node 22.23.4 → supported · older. 동작 계약 안이므로 '불일치' 경고는 하지 않는다
 *                          (실제 호환은 자가 점검이 따로 확인한다). 다만 securityFloor 미만이면 belowSecurityFloor=true 로 보안 경고를 낸다.
 *   · below-minimum      — major 는 맞지만 minVersion 미만(node:sqlite 없음 → NDJSON 폴백).
 *   · unsupported-major  — 지원 major 가 아니다(20·24·26 …).
 *   · unparsed           — 버전 문자열을 읽지 못했다(판정 불가 — 지원이라 말하지 않는다).
 *
 * 자가 점검(selfCheckFetchDispatcher):
 *   127.0.0.1 임시 HTTP 서버에 **전역 fetch + 새 undici Agent** 로 1회 요청한다. 실패하면 같은 Agent 로 패키지
 *   `undici.fetch` 를 한 번 더 시도해 — 그쪽이 성공하면 '전역 fetch 와 패키지 undici 의 계약 불일치(mismatch)' 로 확정하고,
 *   둘 다 실패하면 '판정 불가(error)' 다(루프백 자체가 막힌 것 — 런타임 탓이라 단정하지 않는다).
 *   기동을 막지 않는다: 비동기 · 요청 시한 + 전체 시한 · 임시 서버는 unref 하고 끝나면 닫는다.
 *   ⚠ 기존 Agent(wanAgent 등)를 재사용하지 않는다 — 그쪽 연결 풀·시한을 건드리지 않게 이 점검 전용 Agent 를 만들고 닫는다.
 *     이 Agent 에도 `withSsrfLookup` 을 붙인다(ssrfAgents2537 전수 스윕 규약). 대상이 IP 리터럴 127.0.0.1 이라 lookup 은
 *     불리지 않는다 — 누가 대상을 'localhost' 같은 이름으로 바꾸면 차단되어 '판정 불가' 로 드러난다(조용히 통과하지 않는다).
 *
 * 비지원 major 에서 기동을 **막지 않는다**(경고 + 상태 노출) — 근거는 E-report 'I-06 판단'.
 */
import http from 'node:http';
import { capStr } from './capStr.js';
import { withSsrfLookup } from './ssrfLookup.js';

export const RUNTIME_CONTRACT = Object.freeze({
  supportedMajors: Object.freeze([22]),
  minVersion: '22.5.0',
  releaseVersion: '22.23.5',
  securityFloor: '22.23.5', // 보안 잔여 11-27 G4 — 위 머리 주석
});

/** package.json engines 에 쓰는 범위(계약에서 만든다 — 손으로 두 벌 쓰지 않는다). */
export function enginesRange(contract = RUNTIME_CONTRACT) {
  const majors = [...contract.supportedMajors].sort((a, b) => a - b);
  const top = majors[majors.length - 1];
  return `>=${contract.minVersion} <${top + 1}`;
}

const VERSION_RE = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+]([0-9A-Za-z.-]{1,64}))?$/;

/** 'v22.23.5' · '22.23.5' · 'v23.0.0-nightly…' → { major, minor, patch, pre } | null. 입력 길이 상한 80자. */
export function parseNodeVersion(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 80) return null;
  const m = VERSION_RE.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null };
}

function cmp(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

/**
 * 보안 잔여 11-27 G4: 보안 하한 미만인가. p 는 지원 major · minVersion 이상으로 판정된 버전.
 * 하한이 없거나(계약에 없음) major 가 다르면 null(판정하지 않는다 — 지어내지 않는다). 같은 숫자의 사전 배포판은 미만이다(semver).
 */
function belowFloor(p, contract) {
  const floor = parseNodeVersion(contract.securityFloor);
  if (!floor || floor.major !== p.major) return null;
  const c = cmp(p, floor);
  return c < 0 || (c === 0 && Boolean(p.pre));
}

/**
 * 버전 문자열 판정. 결과는 화면·서비스 점검·기동 로그가 같이 쓴다.
 * @returns {{node:string, major:number|null, supported:boolean|null, code:string, level:'ok'|'warn'|'unknown',
 *            releaseRelation:'same'|'older'|'newer'|null, prerelease:boolean, belowSecurityFloor:boolean|null}}
 */
export function judgeVersion(v, contract = RUNTIME_CONTRACT) {
  const node = typeof v === 'string' ? capStr(v.trim(), 80) : '';
  const p = parseNodeVersion(v);
  if (!p) return { node, major: null, supported: null, code: 'unparsed', level: 'unknown', releaseRelation: null, prerelease: false, belowSecurityFloor: null };
  const prerelease = Boolean(p.pre);
  const base = { node, major: p.major, prerelease, belowSecurityFloor: null };
  if (!contract.supportedMajors.includes(p.major)) {
    return { ...base, supported: false, code: 'unsupported-major', level: 'warn', releaseRelation: null };
  }
  const min = parseNodeVersion(contract.minVersion);
  if (min && cmp(p, min) < 0) return { ...base, supported: false, code: 'below-minimum', level: 'warn', releaseRelation: 'older' };
  const rel = parseNodeVersion(contract.releaseVersion);
  const c = rel ? cmp(p, rel) : null;
  const releaseRelation = c == null ? null : c === 0 ? 'same' : c < 0 ? 'older' : 'newer';
  return { ...base, supported: true, code: c === 0 && !prerelease ? 'release' : 'supported', level: 'ok', releaseRelation, belowSecurityFloor: belowFloor(p, contract) };
}

function errCode(e) {
  if (!e) return null;
  return capStr(e?.cause?.code || e?.code || e?.cause?.name || e?.name || 'Error', 64) || 'Error';
}
function errMsg(e) {
  if (!e) return null;
  const inner = e?.cause?.message;
  const m = inner && inner !== e?.message ? `${e?.message || ''} ← ${inner}` : (e?.message || String(e));
  return capStr(m, 200);
}

function listenLoopback(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { srv.unref(); resolve(srv); });
  });
}

/**
 * 전역 fetch + undici Agent dispatcher 자가 점검(1회). 예외를 던지지 않는다.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000] 요청당 시한(200ms~30초로 자른다). 전체 시한은 이것의 3배.
 * @param {Function} [opts.fetchImpl] 전역 fetch 대체(테스트 주입 — 기본 globalThis.fetch).
 * @param {Function} [opts.loadUndici] undici 모듈 로더(테스트 주입 — 기본 import('undici')).
 * @returns {Promise<{state:'ok'|'mismatch'|'error'|'timeout', code:string|null, detail:string|null, ms:number,
 *                    at:number, globalFetch:'ok'|'failed'|'missing', undiciFetch:'ok'|'failed'|'not-tried'}>}
 */
export async function selfCheckFetchDispatcher({ timeoutMs = 5000, fetchImpl, loadUndici } = {}) {
  const t0 = Date.now();
  const tmo = Math.min(30_000, Math.max(200, Number(timeoutMs) || 5000));
  const done = (o) => ({ code: null, detail: null, globalFetch: 'failed', undiciFetch: 'not-tried', ...o, ms: Date.now() - t0, at: Date.now() });
  let srv = null;
  let agent = null;
  let hardTimer = null;
  let finished = false; // 전체 시한이 먼저 끝났으면 늦게 열린 서버·Agent 를 바로 닫는다(남겨 두지 않는다)
  const work = (async () => {
    let undici;
    try { undici = await (loadUndici ? loadUndici() : import('undici')); } catch (e) {
      return done({ state: 'error', code: errCode(e), detail: `undici 모듈을 불러오지 못했습니다 — ${errMsg(e)}` });
    }
    const AgentCtor = undici?.Agent;
    if (typeof AgentCtor !== 'function') return done({ state: 'error', code: 'no-agent', detail: 'undici.Agent 가 없습니다' });
    srv = await listenLoopback((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
      res.end('ok');
    });
    if (finished) { srv.close(); return done({ state: 'timeout', code: 'self-check-timeout' }); }
    const url = `http://127.0.0.1:${srv.address().port}/runtime-self-check`;
    agent = new AgentCtor({ connect: withSsrfLookup({ timeout: tmo }), headersTimeout: tmo, bodyTimeout: tmo });
    const gf = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    if (typeof gf !== 'function') {
      return done({ state: 'mismatch', code: 'no-global-fetch', detail: '전역 fetch 가 없습니다', globalFetch: 'missing' });
    }
    let gErr = null;
    try {
      const r = await gf(url, { dispatcher: agent, signal: AbortSignal.timeout(tmo) });
      const body = await r.text();
      if (r.status === 200 && body === 'ok') return done({ state: 'ok', globalFetch: 'ok' });
      gErr = Object.assign(new Error(`예상하지 못한 응답 HTTP ${r.status}`), { code: `http-${r.status}` });
    } catch (e) { gErr = e; }
    // 전역 fetch 가 실패했다 — 같은 Agent 로 패키지 fetch 를 한 번 더(원인 구분). 이쪽이 되면 '계약 불일치' 로 확정한다.
    if (typeof undici.fetch !== 'function') {
      return done({ state: 'error', code: errCode(gErr), detail: `전역 fetch 실패(${errMsg(gErr)}) · 비교할 undici.fetch 없음` });
    }
    try {
      const r2 = await undici.fetch(url, { dispatcher: agent, signal: AbortSignal.timeout(tmo) });
      const b2 = await r2.text();
      if (r2.status === 200 && b2 === 'ok') {
        return done({ state: 'mismatch', code: errCode(gErr), detail: errMsg(gErr), undiciFetch: 'ok' });
      }
      return done({ state: 'error', code: errCode(gErr), detail: `전역 fetch 실패(${errMsg(gErr)}) · undici.fetch 도 HTTP ${r2.status}`, undiciFetch: 'failed' });
    } catch (e2) {
      return done({ state: 'error', code: errCode(gErr), detail: `전역 fetch 실패(${errMsg(gErr)}) · undici.fetch 도 실패(${errMsg(e2)}) — 루프백 통신 자체가 막혔을 수 있습니다`, undiciFetch: 'failed' });
    }
  })();
  const hard = new Promise((resolve) => {
    // ⚠ unref 하지 않는다 — 다른 활성 핸들이 없으면 unref 타이머는 울리지 않고 이 await 가 영원히 남는다(전체 시한이 무효).
    //   시한은 최대 90초로 묶여 있고 끝나면 finally 가 지운다.
    hardTimer = setTimeout(() => resolve(done({ state: 'timeout', code: 'self-check-timeout', detail: `자가 점검이 ${tmo * 3}ms 안에 끝나지 않았습니다` })), tmo * 3);
  });
  try {
    return await Promise.race([work.catch((e) => done({ state: 'error', code: errCode(e), detail: errMsg(e) })), hard]);
  } finally {
    finished = true;
    clearTimeout(hardTimer);
    try { await agent?.destroy?.(); } catch { /* 이미 닫힘 */ }
    try { srv?.closeAllConnections?.(); srv?.close(); } catch { /* 이미 닫힘 */ }
  }
}

// ── 프로세스 상태 ─────────────────────────────────────────────────────────────
const _state = {
  version: judgeVersion(process.version),
  selfCheck: { state: 'not-run', at: null },
};
let _inflight = null;

/**
 * 종합 상태: mismatch > unsupported > error > checking > unchecked > ok.
 *   · mismatch    — 자가 점검이 전역 fetch + undici Agent 의 계약 불일치를 확인했다(장비 통신 실패가 장비 탓이 아닐 수 있다).
 *   · unsupported — 버전이 계약 밖(major·하한·판독 불가). 자가 점검 결과와 무관하게 알린다.
 *   · error       — 자가 점검을 판정하지 못했다(timeout 포함). 지원 버전이라도 '정상' 이라 말하지 않는다.
 *   · checking    — 자가 점검 중 · unchecked — 아직 돌리지 않았다(기동 진입점이 startRuntimeCheck 를 부르지 않았다).
 */
export function overallState(version, selfCheck) {
  const sc = selfCheck?.state;
  if (sc === 'mismatch') return 'mismatch';
  if (!version || version.supported !== true) return 'unsupported';
  if (sc === 'error' || sc === 'timeout') return 'error';
  if (sc === 'running') return 'checking';
  if (sc !== 'ok') return 'unchecked';
  return 'ok';
}

/** 내부 상태 사본(관리자 전체 보기와 같은 모양). */
export function runtimeStatus() {
  const v = _state.version;
  const sc = _state.selfCheck;
  return {
    state: overallState(v, sc),
    node: v.node,
    major: v.major,
    supported: v.supported,
    code: v.code,
    releaseRelation: v.releaseRelation,
    belowSecurityFloor: v.belowSecurityFloor ?? null, // 보안 잔여 11-27 G4 — 관리자 판본에만(runtimeForHealth(false) 는 state 하나)
    contract: {
      supportedMajors: [...RUNTIME_CONTRACT.supportedMajors],
      minVersion: RUNTIME_CONTRACT.minVersion,
      releaseVersion: RUNTIME_CONTRACT.releaseVersion,
      securityFloor: RUNTIME_CONTRACT.securityFloor,
      engines: enginesRange(),
    },
    selfCheck: { ...sc },
  };
}

/**
 * /api/health 에 싣는 모양. 관리자(전체 범위)만 버전·계약·자가 점검 상세를 받는다 — 나머지 계정은 배너 판정에 필요한
 * `state` 하나만(서버 소프트웨어 버전 노출을 줄인다). 경로·비밀은 어느 쪽에도 없다.
 */
export function runtimeForHealth(full) {
  const s = runtimeStatus();
  if (!full) return { state: s.state };
  return s;
}

/** 자가 점검을 1회 돌리고 상태를 갱신한다(진행 중이면 합류). */
export function runRuntimeSelfCheck(opts = {}) {
  if (_inflight) return _inflight;
  _state.selfCheck = { state: 'running', at: Date.now() };
  _inflight = selfCheckFetchDispatcher(opts)
    .then((r) => { _state.selfCheck = r; return runtimeStatus(); })
    .finally(() => { _inflight = null; });
  return _inflight;
}

/** 기동 로그 한 줄(판정 문구). */
export function runtimeLogLine(s = runtimeStatus()) {
  const c = s.contract;
  // ⚠ 버전 숫자 뒤에 조사(과/와)를 붙이지 않는다 — 읽는 소리를 알 수 없다(괄호 뒤에 붙인다).
  const ver = s.code === 'release' ? `릴리스 검증 버전(${c.releaseVersion})과 같음`
    : s.code === 'supported' ? `지원 major ${s.major} · 릴리스 검증 버전(${c.releaseVersion})${s.releaseRelation === 'older' ? '보다 낮은 버전' : s.releaseRelation === 'newer' ? '보다 높은 버전' : '과 다른 빌드'} — 계약 안`
      : s.code === 'below-minimum' ? `최소 ${c.minVersion} 미만(node:sqlite 없음 → NDJSON 폴백)`
        : s.code === 'unsupported-major' ? `지원하지 않는 major(지원 ${c.supportedMajors.join('·')}.x, 계약 ${c.engines})`
          : '버전 판독 불가';
  // 보안 잔여 11-27 G4: 보안 하한 미만 — 고친 항목을 나열하지 않는다(어느 패치에서 무엇이 빠졌는지는 버전마다 다르다 · 정직).
  const floor = s.belowSecurityFloor === true
    ? ` · ⚠ 보안 하한(${c.securityFloor}) 미만 — 그 뒤 나온 Node 보안 수정이 빠져 있습니다. 포탈 자동 업그레이드는 Node 런타임을 바꾸지 않으니 최신 설치 패키지로 다시 설치하세요`
    : '';
  const sc = s.selfCheck || {};
  const chk = sc.state === 'ok' ? `전역 fetch + undici Agent 자가 점검 통과(${sc.ms}ms)`
    : sc.state === 'mismatch' ? `⚠ 전역 fetch + undici Agent 자가 점검 실패(${sc.code}) — 패키지 undici.fetch 는 통과: 런타임 불일치. 장비·엣지 통신 실패는 장비 장애가 아닐 수 있습니다`
      : sc.state === 'timeout' || sc.state === 'error' ? `자가 점검 판정 불가(${sc.code || sc.state})`
        : sc.state === 'running' ? '자가 점검 중' : '자가 점검 안 함';
  return `[runtime] Node ${s.node || '?'} — ${ver}${floor} · ${chk}`;
}

/**
 * 기동 진입점이 부른다(index.js — 리드 요청). 기다리지 않아도 된다: 끝나면 로그 한 줄을 남긴다.
 * 비지원·불일치·보안 하한 미만(보안 잔여 11-27 G4)은 console.warn, 나머지는 console.log. 같은 프로세스에서 두 번 불러도 한 번만 돈다(진행 중 합류).
 *
 * '판정 불가(error·timeout)' 는 기동 직후 부하(폴러 수십 개가 동시에 뜬다)로도 생길 수 있어, 그 경우만 `retryDelaysMs`
 * 간격으로 다시 본다(기본 1분·5분 — 두 번). 불일치(mismatch)는 결정적이므로 다시 보지 않는다. 런타임은 프로세스 수명 동안
 * 바뀌지 않으므로 주기 점검은 하지 않는다. 재시도 타이머는 unref 하지 않는다 — 돌려주는 프라미스가 그 타이머에 걸려 있어,
 * unref 하면 다른 활성 핸들이 없을 때 영원히 끝나지 않는다(서버는 종료를 process.exit 로 하므로 붙잡을 일도 없다).
 */
export function startRuntimeCheck({ log = console, retryDelaysMs = [60_000, 300_000], ...opts } = {}) {
  const say = (s) => {
    const line = runtimeLogLine(s);
    const quiet = (s.state === 'ok' || s.state === 'unchecked' || s.state === 'checking') && s.belowSecurityFloor !== true;
    try { (quiet ? log.log : log.warn).call(log, line); } catch { /* 로그 실패 무시 */ }
  };
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs.filter((n) => Number.isFinite(n) && n >= 0).slice(0, 5) : [];
  const attempt = (i) => runRuntimeSelfCheck(opts).then((s) => {
    say(s);
    if (s.state === 'error' && i < delays.length) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(attempt(i + 1)), delays[i]);
      });
    }
    return s;
  }, (e) => {
    try { log.warn.call(log, `[runtime] 자가 점검 실행 실패 — ${errMsg(e)}`); } catch { /* 무시 */ }
    return runtimeStatus();
  });
  return attempt(0);
}

/**
 * 서비스 점검 행(health/services.js — 리드 요청). wrap(key, label, fn) 의 fn 반환 모양 { status, detail, at }.
 * status: ok | warn. 상세 문구의 버전·코드는 관리자에게만(같은 화면을 operator 도 본다).
 */
export function runtimeServiceRow({ isAdmin = false } = {}) {
  const s = runtimeStatus();
  const at = s.selfCheck?.at || Date.now();
  const tail = isAdmin ? ` — ${runtimeLogLine(s).replace(/^\[runtime\] /, '')}` : '';
  // 보안 잔여 11-27 G4: 보안 하한 미만은 ok·checking 이어도 warn. 비관리자 문구에는 버전 숫자(서버 · 하한)를 싣지 않는다.
  //   정기 점검 보고의 '포탈 내부 서비스'(periodic/readers/services.js — 비관리자 판본)도 이 행을 세어 '주의' 가 된다(의도 — 재설치 전까지).
  const below = s.belowSecurityFloor === true;
  const floorMsg = isAdmin
    ? '보안 패치가 빠진 Node 런타임 — 엣지는 중앙의 엣지 배포를 다시 실행하고, 소스 설치면 Node 를 보안 하한 이상으로 올리세요'
    : '보안 패치가 빠진 Node 런타임 — 관리자에게 알리세요';
  switch (s.state) {
    case 'ok': return below ? { status: 'warn', detail: `${floorMsg}${tail}`, at } : { status: 'ok', detail: `지원 런타임 · 통신 자가 점검 통과${tail}`, at };
    case 'checking': return { status: below ? 'warn' : 'ok', detail: `${below ? `${floorMsg} · ` : ''}통신 자가 점검 중${tail}`, at };
    case 'unchecked': return { status: 'warn', detail: `통신 자가 점검을 돌리지 않았습니다(기동 진입점 확인)${below ? ` · ${floorMsg}` : ''}${tail}`, at };
    case 'mismatch': return { status: 'warn', detail: `런타임 불일치 — 전역 fetch 와 undici Agent 가 맞지 않아 장비·엣지 HTTPS 통신이 실패합니다. 수집 실패를 장비 장애로 판단하지 마세요. 설치 패키지에 든 Node(계약 ${s.contract.engines})로 실행하세요${tail}`, at };
    case 'unsupported': return { status: 'warn', detail: `지원 범위 밖 Node(계약 ${s.contract.engines}) — 검증하지 않은 런타임입니다${tail}`, at };
    default: return { status: 'warn', detail: `통신 자가 점검을 판정하지 못했습니다${tail}`, at };
  }
}

/** 테스트 전용: 상태를 초기화한다(버전 판정은 주입한 문자열로). */
export function _resetRuntimeCheckForTest(nodeVersion = process.version) {
  _state.version = judgeVersion(nodeVersion);
  _state.selfCheck = { state: 'not-run', at: null };
  _inflight = null;
}
