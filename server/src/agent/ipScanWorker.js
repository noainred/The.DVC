/**
 * 분산 에이전트의 IP 스캔 워커. CENTRAL_URL이 설정되면 동작:
 *  1) 중앙에서 자기 이름(AGENT_NAME)의 IP 스캔 할당을 읽어오고
 *  2) 그 대역을 로컬에서 TCP 커넥트 스캔한 뒤
 *  3) 결과를 중앙으로 보고 → 중앙이 IP 대장에 병합한다.
 * 실패는 격리되고 이벤트 루프를 막지 않는다.
 */

import { config, clampIntervalMs } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { runScan } from '../ipam/scanRunner.js';
import { readCentralReply, dropSummaryOf, warnDrop } from './centralReply.js';
import { agentNameHeader } from '../util/agentNameHeader.js'; // v2.620(RECENT2620-02)

let timer = null;
let last = null;
let running = false; // 재진입 가드 — 대역 스캔이 인터벌을 넘기면 중첩 실행돼 이중 스캔/보고

/*
 * v2.731(점검 A4-03): 스캔 주기는 **중앙 배정 응답의 에이전트별 intervalMs** 다(IP관리 › 스캔 대역·설정의 '주기'). 예전에는 기동 시
 *   env(AGENT_SCAN_INTERVAL_MS — iDRAC 위임 스캐너와 공유)로 setInterval 을 굳혀 배정의 intervalMs 를 읽지 않았다 — 화면은 '주기 N분마다'
 *   라고 말하는데 엣지는 env 주기로 돌았고, 중앙의 해제(down) 판정(scanPoller — 중앙 저장 intervalMs × 3, 최소 3시간)과 주기가 어긋나
 *   IP 가 down/up 으로 흔들렸다(재현). CLAUDE.md v2.409 '중앙 배포값을 모듈 로드 시 굳히지 말 것' 의 엣지 판.
 *   · 값이 없을 때만(배정 전 · 미배정 · 구버전 중앙 · 숫자 아님) env 기본값. 범위는 중앙 저장 범위와 같은 1분~7일로 자른다.
 *   · 엣지에는 '주기 변경 알림' 이 없으므로 배정은 **주기와 IPSCAN_ASSIGN_RECHECK_MS 중 짧은 간격**으로 다시 읽고, 스캔은 마지막 스캔
 *     뒤 주기가 지났을 때만 한다(그래야 6시간 → 1시간 변경이 6시간 뒤가 아니라 다음 확인에서 먹는다. 배정 조회는 GET 한 번이다).
 *   · 배정 조회가 실패하면 주기를 바꾸지 않는다(직전 값 유지).
 */
export const IPSCAN_ASSIGN_RECHECK_MS = 15 * 60_000;
const INTERVAL_MIN_MS = 60_000;
const INTERVAL_MAX_MS = 7 * 86_400_000;
let _centralIntervalMs = null; // 마지막 배정 응답의 intervalMs(클램프) — null = env 기본값
let _lastScanAt = null;        // 마지막으로 스캔을 시도해 끝낸 시각(성패 무관 — 주기 기준)
let _lastCheckAt = null;       // 마지막 배정 조회 시각(스캔하지 않은 확인 포함)
let _lastScanRecord = null;    // 마지막 스캔 시도의 기록(성공·스캔/보고 실패) — 주기 전 확인이 성공하면 '배정 조회 실패' 기록 대신 이것으로 돌아간다

/** 배정 응답의 intervalMs → 쓸 값(ms) 또는 null(없음·숫자 아님 → env 기본값). 0 이하도 '없음' 이다(0 = 끔 계약이 없다). */
function centralIntervalOf(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(INTERVAL_MAX_MS, clampIntervalMs(n, config.agent.scanIntervalMs, INTERVAL_MIN_MS));
}
/** 지금 쓰는 스캔 주기(ms) — 중앙 배정값, 없으면 env(AGENT_SCAN_INTERVAL_MS). */
export function ipScanIntervalMs() {
  return _centralIntervalMs ?? config.agent.scanIntervalMs;
}
/** 다음 타이머 간격(ms) — 다음 스캔 예정 시각과 배정 재확인 간격 중 이른 쪽(최소 1초). */
export function ipScanNextDelayMs(now = Date.now()) {
  const iv = ipScanIntervalMs();
  const recheck = Math.min(iv, IPSCAN_ASSIGN_RECHECK_MS);
  if (_lastScanAt == null) return recheck;
  return Math.max(1_000, Math.min(recheck, _lastScanAt + iv - now));
}

function headers() {
  return { 'Content-Type': 'application/json', ...agentNameHeader(config.agent.name), ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

/**
 * 배정을 읽고 스캔·보고한다. 직접 호출(테스트·수동)은 언제나 스캔한다. 타이머는 `{dueOnly:true}` — 마지막 스캔 뒤 주기가 지나지
 * 않았으면 배정만 다시 읽고(주기 반영) 스캔하지 않는다. `now` 는 시각 판정용(테스트 주입).
 */
export async function runIpScanAgentOnce(...args) {
  // 인자는 rest 로 받는다 — edgeSweep2574 IMP-06 이 진입 함수를 '인자 없음 또는 ...rest' 모양으로 열거한다.
  const { dueOnly = false, now = null } = (args[0] && typeof args[0] === 'object') ? args[0] : {};
  if (!config.agent.centralUrl) return null;
  if (running) return last; // 이전 주기 진행 중이면 이번 틱 건너뜀
  running = true;
  let phase = 'assignment'; // 실패 지점 — assignment(배정 조회) · scan · report(결과 보고)
  try {
    const url = `${config.agent.centralUrl}/api/central/ip-scan-assignment?agent=${encodeURIComponent(config.agent.name)}`;
    const aRes = await resilientFetch(url, { headers: headers(), timeoutMs: 20_000, retries: 2 });
    if (!aRes.ok) {
      // v2.632(감사 EDGE2632-03): 중앙 스캔 설정 파일 손상은 503 settingsUnreadable — '배정 없음' 이 아니라 사유를 남긴다.
      let why = '';
      if (aRes.status === 503) { try { const b = await aRes.json(); if (b?.reason === 'settingsUnreadable') why = ` — 중앙 스캔 설정 파일을 읽지 못했습니다(${String(b.detail || '').slice(0, 160)})`; } catch { /* 본문 없음 */ } }
      throw new Error(`assignment ${aRes.status}${why}`);
    }
    const a = await aRes.json();
    _lastCheckAt = Date.now();
    if (!a?.assigned) { _centralIntervalMs = null; last = { at: Date.now(), assigned: false }; return last; }
    _centralIntervalMs = centralIntervalOf(a.intervalMs);
    const t = Number.isFinite(now) ? now : Date.now();
    if (dueOnly && _lastScanAt != null && t - _lastScanAt < ipScanIntervalMs()) {
      // 아직 주기 전 — 배정(주기)만 반영. 직전 '배정 조회' 실패는 이번 조회가 성공했으므로 남겨 두지 않고 마지막 스캔 시도의
      // 기록으로 돌아간다(그 시각이 '마지막 실행' 이다). 스캔·결과 보고 실패 기록은 다음 스캔까지 그대로 둔다(숨기지 않는다).
      if (last?.error && last.phase === 'assignment' && _lastScanRecord) last = _lastScanRecord;
      return last;
    }
    // 엣지도 스캔을 별도 프로세스에서(v2.363) — 원격지 포탈/에이전트 부하 격리.
    // v2.731(A4-03): 스캔을 시도한 시각을 주기 기준으로 둔다 — 스캔 실패·결과 보고 실패(403 등)도 다음 스캔은 주기 뒤다
    //   (기준을 '성공' 으로만 두면 배정 재확인 간격마다 대역 전체를 다시 스캔해 실패 상황의 부하가 몇 배가 된다).
    let scanOut;
    phase = 'scan';
    try {
      scanOut = await runScan({
        ranges: a.ranges, ports: a.ports, concurrency: a.concurrency, timeoutMs: a.timeoutMs, reverseDns: a.reverseDns,
        ping: a.ping, // 중앙 배정 설정(v2.359) — 구버전 중앙이면 undefined → 기본 OFF(v2.360)
      });
    } finally { _lastScanAt = Date.now(); }
    const { alive, scanned } = scanOut;
    phase = 'report';
    const rRes = await resilientFetch(`${config.agent.centralUrl}/api/central/ip-scan-result`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ agent: config.agent.name, alive, scanned }), timeoutMs: 30_000, retries: 2,
    });
    // 결과 POST 응답을 검사한다 — 검사하지 않으면 403/거부(토큰 만료·에이전트명 불일치)도
    // '성공 보고'로 기록돼, 실제로는 중앙에 병합되지 않은 스캔을 정상으로 오인한다.
    if (!rRes.ok) throw new Error(`result ${rRes.status}`);
    // v2.607(감사 EDGE2607-02): 200 이어도 중앙은 전체 상한(capped)·형식 오류(dropped)·절단(omitted)으로 일부를 받지 않을 수 있다 —
    //   예전에는 r.ok 만 보고 '성공 alive N' 으로 적어, 중앙 IP 대장에 없는데 엣지 로그 화면은 성공이었다(v2.606 EDGE2606-03 의 형제 누락).
    const drop = ipScanDropOf(await readCentralReply(rRes));
    last = { at: Date.now(), assigned: true, scanned, alive: alive.length, ...(drop ? { centralDropped: drop } : {}) };
    _lastScanRecord = last;
    warnDrop('ipscan-agent', drop);
    return last;
  } catch (e) {
    // v2.583 감사 #34: 무음 실패 금지(v2.549·v2.561 규약) — 상태에 남기고(엣지 로그 표에 등재) 콘솔에도 적는다.
    const msg = String(e?.message || e);
    streak = (last?.error ? streak : 0) + 1;
    last = { at: Date.now(), error: msg, kind: /\b403\b/.test(msg) ? 'auth' : /\b413\b/.test(msg) ? 'too-large' : 'error', streak, phase };
    if (phase !== 'assignment') _lastScanRecord = last;
    console.warn(`[ipscan-agent] 실패(연속 ${streak}회): ${msg}`);
    return last;
  }
  finally { running = false; }
}

let streak = 0;

/** 테스트 전용 — 모듈 상태(주기·마지막 스캔·기록)를 처음으로 되돌린다. */
export function _resetIpScanAgentForTest() {
  _centralIntervalMs = null; _lastScanAt = null; _lastCheckAt = null; _lastScanRecord = null; last = null; streak = 0;
}

/** ip-scan-result 응답 → 거절 요약(순수). capped(전체 상한)·omitted(절단)는 '상한 초과로 제외', dropped(형식 오류)는 '거부'. */
export function ipScanDropOf(j) {
  if (!j || typeof j !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return dropSummaryOf({ rejected: n(j.dropped), omitted: n(j.capped) + n(j.omitted) });
}
/** 엣지 로그 화면용 상태(edgelog/spec.js) — 실패 사유·연속 횟수를 담는다. */
export function ipScanAgentStatus() {
  // v2.731(A4-03): intervalMs 는 **실제로 쓰는 주기**(중앙 배정값 우선) — 서비스 점검(pollerCheck)이 이 값으로 지연을 판정한다.
  return {
    enabled: !!config.agent.centralUrl, running, intervalMs: ipScanIntervalMs(),
    intervalSource: _centralIntervalMs != null ? 'central' : 'env', envIntervalMs: config.agent.scanIntervalMs,
    lastCheckAt: _lastCheckAt, lastScanAt: _lastScanAt, last,
  };
}

export function startIpScanAgent() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 스캔 비활성
  if (timer) return;
  // v2.731(A4-03): setInterval 은 생성 시 간격에 묶인다 — 매 회 다음 간격을 다시 읽는 타이머로 중앙 주기 변경을 따른다.
  timer = startAdaptiveTimer(() => ipScanNextDelayMs(), () => runIpScanAgentOnce({ dueOnly: true }).catch(() => {}), { firstDelayMs: 40_000, name: 'ipscan-agent' });
  console.log(`[ipscan-agent] started (central=${config.agent.centralUrl}, name=${config.agent.name})`);
}
