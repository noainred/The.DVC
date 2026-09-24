/**
 * sanswitch/testRuns.js — 연결 테스트 **실행 등록부**(v2.421).
 *
 * 왜 비동기인가: 예전 `POST /tools/sanswitch/test` 는 결과가 날 때까지(최대 60초) 응답을 잡고 있어 화면이
 * "멈춘" 것처럼 보였고, 실패해도 사유 한 줄뿐이었다. 이제 등록 즉시 runId 를 돌려주고, 화면이 1초마다
 * `GET /tools/sanswitch/test/:id` 로 **진행 로그를 실시간으로** 본다(어느 단계에서 기다리는지 보임).
 *
 * 엣지 위임 장비(agent 지정)는 중앙이 직접 접속하지 않는다 — 중앙 포탈은 그 IP 에 닿지 않는 것이 보통이라
 * 예전에는 60초 뒤 타임아웃만 봤다(= "멈춤"의 유력한 원인). 요청을 큐에 두면 엣지가 다음 설정 pull 때
 * `testNow` 로 가져가 현지에서 실행하고 `/api/central/sanswitch-test-result` 로 결과(추적 로그 포함)를 올린다.
 *
 * 보안: 비밀번호는 run 객체 안(인메모리)에만 있고 GET 응답·결과에는 절대 넣지 않는다(sanitize). 결과 회신은
 * 요청을 받은 그 agent 만 할 수 있다(개별 토큰 바인딩 대조). TTL 30분, 동시 실행 상한 10.
 */
import crypto from 'node:crypto';
import { testDeviceConnection } from './poller.js';
import { classifyFailure } from './testDiag.js';
import { strOf } from '../util/coercionTrap.js'; // v2.604 CEN2604-05
import { numOrNull } from '../util/numOrNull.js';

const TTL_MS = 30 * 60_000;
const MAX_ACTIVE = 10;
const EDGE_PICKUP_MS = Math.max(60_000, Number(process.env.SANSW_TEST_PICKUP_MS) || 10 * 60_000); // 엣지가 가져갈 때까지 기다리는 상한
const EDGE_RESULT_MS = Math.max(60_000, Number(process.env.SANSW_TEST_RESULT_MS) || 5 * 60_000);  // 가져간 뒤 결과 회신 상한
const _runs = new Map();

function prune() {
  const cut = Date.now() - TTL_MS;
  for (const [id, r] of _runs) if (r.startedAt < cut) _runs.delete(id);
}
const push = (r, msg, level = 'info') => { if (r.trace.length < 600) r.trace.push({ t: Date.now() - r.startedAt, msg: String(msg).slice(0, 2000), level }); };

/** 테스트 등록. device 는 정규화된 입력(+password). 반환 { id, target }. */
export function startTestRun(device, { verbose = false, user = '', timeoutMs = 60_000 } = {}) {
  prune();
  const active = [...(_runs.values())].filter((r) => r.status !== 'done').length;
  if (active >= MAX_ACTIVE) throw new Error(`진행 중인 연결 테스트가 ${MAX_ACTIVE}개를 넘습니다. 잠시 후 다시 시도하세요.`);
  const id = crypto.randomBytes(8).toString('hex');
  const target = String(device.agent || '').trim();
  const run = { id, startedAt: Date.now(), status: 'running', target, user, verbose, device, trace: [], result: null, dispatchedAt: 0, timeoutMs };
  _runs.set(id, run);
  if (!target) {
    push(run, '실행 위치: 중앙 포탈 서버(수집 주체가 "중앙이 직접 수집")');
    testDeviceConnection(device, { timeoutMs, verbose, ranOn: '중앙', trace: (m, lv) => push(run, m, lv) })
      .then((res) => { run.result = res; run.status = 'done'; run.finishedAt = Date.now(); })
      .catch((e) => { run.result = { ok: false, reason: e.message, phase: 'unknown', hint: classifyFailure(e.message).hint }; run.status = 'done'; run.finishedAt = Date.now(); });
  } else {
    run.status = 'queued';
    push(run, `실행 위치: 엣지 "${target}"(수집 주체). 중앙은 이 스위치에 직접 접속하지 않습니다 — 엣지가 다음 설정 pull(기본 5분 주기, SANSW_CONFIG_PULL_MS) 때 요청을 가져가 현지에서 실행합니다. 최대 ${Math.round(EDGE_PICKUP_MS / 60000)}분 대기.`);
    const t = setTimeout(() => {
      const r = _runs.get(id);
      if (!r || r.status === 'done') return;
      const reason = r.status === 'queued'
        ? `엣지 "${target}" 가 ${Math.round(EDGE_PICKUP_MS / 60000)}분 안에 테스트 요청을 가져가지 않았습니다(pull 없음)`
        : `엣지 "${target}" 응답 없음 — 요청은 가져갔지만 ${Math.round(EDGE_RESULT_MS / 60000)}분 안에 결과가 오지 않았습니다`;
      push(r, reason, 'error');
      r.result = { ok: false, reason, phase: 'edge', hint: classifyFailure(reason, 'edge').hint, ranOn: target };
      r.status = 'done'; r.finishedAt = Date.now();
    }, EDGE_PICKUP_MS + EDGE_RESULT_MS);
    t.unref?.();
    run.timer = t;
  }
  return { id, target };
}

/** 이 엣지 몫 대기 요청을 꺼낸다(설정 pull 응답에 실림). 비밀번호 포함 — 엣지가 로그인해야 한다. */
export function takeTestRequestsForAgent(agentName) {
  prune();
  const me = String(agentName || '').toLowerCase();
  const out = [];
  for (const r of _runs.values()) {
    if (r.status !== 'queued' || r.target.toLowerCase() !== me) continue;
    r.status = 'dispatched'; r.dispatchedAt = Date.now();
    push(r, `엣지 "${r.target}" 가 요청을 가져갔습니다(+${Math.round((r.dispatchedAt - r.startedAt) / 1000)}초). 현지 실행 결과를 기다립니다(최대 ${Math.round(EDGE_RESULT_MS / 60000)}분).`);
    out.push({ id: r.id, device: r.device, verbose: r.verbose, timeoutMs: r.timeoutMs });
    if (out.length >= 5) break;
  }
  return out;
}

/** 엣지 결과 회신. agent 가 그 요청의 대상 엣지와 같아야 한다(남의 테스트 결과 위조 차단). */
export function completeTestRun(id, agentName, result) {
  const r = _runs.get(String(id));
  if (!r) return { ok: false, reason: '알 수 없는(또는 만료된) 테스트 id' };
  if (r.target.toLowerCase() !== String(agentName || '').toLowerCase()) return { ok: false, reason: '이 테스트의 대상 엣지가 아닙니다' };
  if (r.status === 'done') return { ok: true, already: true };
  const res = sanitizeResult(result, r.target);
  for (const l of res.trace || []) push(r, `[엣지] ${l.msg}`, l.level);
  r.result = { ...res, trace: undefined };
  r.status = 'done'; r.finishedAt = Date.now();
  if (r.timer) clearTimeout(r.timer);
  return { ok: true };
}

/** 결과 정화 — 엣지가 올린 값 중 화면이 쓰는 필드만, 크기 제한. */
function sanitizeResult(res = {}, ranOn = '') {
  const r = res && typeof res === 'object' ? res : {};
  const trace = Array.isArray(r.trace) ? r.trace.slice(0, 600).map((l) => ({ t: Number(l?.t) || 0, msg: String(l?.msg || '').slice(0, 2000), level: ['info', 'warn', 'error', 'debug'].includes(l?.level) ? l.level : 'info' })) : [];
  return {
    ok: r.ok === true, ms: Number(r.ms) || 0, reason: r.reason ? String(r.reason).slice(0, 2000) : undefined,
    phase: String(r.phase || '').slice(0, 40), hint: r.hint ? String(r.hint).slice(0, 2000) : undefined,
    snap: sanitizeTestSnap(r.snap), // v2.604 CEN2604-05: 원문 그대로 담지 않는다(아래)
    cliRaw: Array.isArray(r.cliRaw) ? r.cliRaw.slice(0, 40).map((x) => ({ key: String(x?.key || ''), cmd: String(x?.cmd || '').slice(0, 300), ok: !!x?.ok, sample: String(x?.sample || '').slice(0, 4000) })) : [],
    ranOn, verbose: !!r.verbose, trace,
  };
}

/**
 * 테스트 요약 스냅샷 정제(v2.604 감사 CEN2604-05). 모양은 `poller.js summary()` 가 정한다 — 그 필드만, 그 타입만.
 * 예전에는 객체면 원문 그대로 담아 `{name:{evil:1}}` 하나로 모달이 React #31, ports 가 없으면 TypeError 로 죽었다.
 * 글자는 strOf(객체면 ''), 수치는 numOrNull(못 읽으면 null — 0 으로 두지 않는다), sections 는 글자 값 맵(상한 64).
 * ports 는 **항상 객체**로 둔다(화면이 `snap.ports.online` 을 가드 없이 읽는다).
 */
const SECTION_VALUE_MAX = 2000;
export function sanitizeTestSnap(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return undefined;
  const p = snap.ports && typeof snap.ports === 'object' && !Array.isArray(snap.ports) ? snap.ports : {};
  const sections = {};
  if (snap.sections && typeof snap.sections === 'object' && !Array.isArray(snap.sections)) {
    for (const k of Object.keys(snap.sections).slice(0, 64)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      // v2.605(감사 RECENT2605-07): 값은 'ok'|'skip' 만이 아니라 **실패 사유 문자열**이다(fosSsh v2.522 — 'rbash: sensorshow:
      //   command not found' 등). 40자로 말없이 잘라 엣지 실행 결과만 사유가 중간에서 끊겼다. 2,000자(reason·hint 와 같은 상한)
      //   로 두고, 그래도 넘으면 잘랐다는 표식을 붙인다.
      const full = strOf(snap.sections[k], SECTION_VALUE_MAX + 1);
      const v = full.length > SECTION_VALUE_MAX ? `${full.slice(0, SECTION_VALUE_MAX)}…(잘림)` : full;
      if (v) sections[k.slice(0, 64)] = v;
    }
  }
  return {
    name: strOf(snap.name, 256), model: strOf(snap.model, 128), fabricOs: strOf(snap.fabricOs, 64), serial: strOf(snap.serial, 128),
    domainId: numOrNull(snap.domainId), switchState: strOf(snap.switchState, 64),
    ports: { total: numOrNull(p.total), licensed: numOrNull(p.licensed), online: numOrNull(p.online), free: numOrNull(p.free), usedPct: numOrNull(p.usedPct) },
    sections,
  };
}

/** 화면용 조회 — 비밀번호·장비 원본은 넣지 않는다. */
export function getTestRun(id) {
  prune();
  const r = _runs.get(String(id));
  if (!r) return null;
  const now = Date.now();
  return {
    id: r.id, status: r.status, target: r.target || '', verbose: r.verbose, startedAt: r.startedAt,
    elapsedMs: (r.finishedAt || now) - r.startedAt, trace: r.trace, result: r.result,
    host: r.device.host, port: r.device.collectMethod === 'rest' ? (Number(r.device.httpsPort) || 443) : (Number(r.device.sshPort) || 22),
  };
}

export function _resetForTest() { for (const r of _runs.values()) if (r.timer) clearTimeout(r.timer); _runs.clear(); }
