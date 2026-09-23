/**
 * storage/areasCollector.js — OneFS API 전 영역 수집기(v2.308, 사용자 요구 40개 영역 표).
 *
 * 카탈로그(onefsCatalog.js)의 각 영역을 REST 로 조회해 **원문을 수집 노드의 SQLite 에 저장**
 * (storage/db.js api_latest — 사용자 요구 'DB 저장')하고, 영역별 요약(성공/실패·크기)을
 * 반환한다. 요약은 정규화 스냅샷 extra.areas 로 중앙에 push 된다(원문은 로컬 DB — WAN 대역폭
 * 고려. 카탈로그 헤더의 정직 표기 참조).
 *
 * 실행 조건·부하 통제:
 *  - 장비의 REST 자격증명이 필요하다(SSH 모드 장비도 같은 계정으로 REST 시도 — Isilon 은
 *    동일 계정이 CLI/API 양쪽에 쓰이는 것이 일반적이나, API 차단 환경이면 영역별 오류로 드러남).
 *  - 인증 실패(401)면 나머지 영역을 시도하지 않는다(장비 계정 잠금 예방 — isilon.js 와 동일).
 *  - 영역 사이 setImmediate 양보(이벤트 루프 비블로킹 — CLAUDE.md), 직렬 실행(장비 부하 평탄화).
 */

import { enabledAreas, ONEFS_AREAS } from './onefsCatalog.js';
import { get } from './collectors/isilon.js';
import { saveAreaResults } from './db.js';

const yieldLoop = () => new Promise((r) => setImmediate(r));

/** 연속 전송 실패(HTTP 응답 자체가 없음) 이 횟수면 나머지 영역을 시도하지 않는다(v2.598 T2598-01). */
export const TRANSPORT_FAIL_LIMIT = 3;

/** 멈춘 뒤 시도하지 않은 영역에 붙이는 사유(화면이 그대로 보여준다). */
const STOP_TEXT = {
  auth: '인증 실패로 나머지 영역을 시도하지 않았습니다(계정 잠금 예방)',
  deadline: '영역 수집 시한 초과로 이번 주기에는 시도하지 않았습니다',
  transport: `장비 응답 없음(연속 ${TRANSPORT_FAIL_LIMIT}회)으로 이번 주기에는 시도하지 않았습니다`,
};

/**
 * 한 장비의 전 영역 수집 → DB 저장 → 요약 반환 [{area, label, ok, endpoints, failed, error?}]
 *
 * ⚠ v2.598 T2598-01: 예전엔 시한·signal 없이 66개 엔드포인트를 직렬로 불러, 장비가 응답하지 않으면 건별 시한(15초)
 * × 66 ≈ 16.5분 동안 스토리지 폴러의 재진입 가드(_busy)를 붙잡았다(그동안 다른 장비 수집이 전부 밀린다).
 * 이제 ① `signal`(폴러의 withDeadline)이 끊으면 거기서 멈추고 ② HTTP 응답 없는 실패가 연속
 * TRANSPORT_FAIL_LIMIT 회면 나머지를 시도하지 않는다(v2.591 회로 차단기와 같은 판단). 멈춘 이유와 시도하지 않은
 * 영역은 요약에 **밝힌다**(`stopped`·`notTried` — 조용한 생략 금지). 모은 결과는 멈춰도 저장한다(던지지 않는다).
 */
export async function collectAreasOnce(device, { signal } = {}) {
  const results = [];   // DB 저장용(엔드포인트 단위)
  const summary = [];   // push/화면용(영역 단위)
  let authDead = false;
  let stopped = null;   // null | 'auth' | 'deadline' | 'transport'
  let transportFails = 0;
  const areas = enabledAreas();
  let notTried = 0;
  for (const area of areas) {
    if (stopped) { notTried++; summary.push({ area: area.key, ok: 0, failed: 0, skipped: true, notTried: true, error: STOP_TEXT[stopped] }); continue; }
    let okCnt = 0, failCnt = 0, firstErr = '';
    for (const ep of area.endpoints) {
      if (signal?.aborted) { stopped = 'deadline'; break; }
      try {
        const data = await get(device, ep, { signal });
        results.push({ area: area.key, endpoint: ep, ok: true, data });
        okCnt++;
        transportFails = 0;
      } catch (e) {
        if (signal?.aborted) { stopped = 'deadline'; break; }   // 시한이 끊은 요청은 그 엔드포인트의 실패가 아니다
        results.push({ area: area.key, endpoint: ep, ok: false, error: e.message });
        failCnt++;
        if (!firstErr) firstErr = e.message;
        if (/401|인증 실패/.test(e.message)) { authDead = true; stopped = 'auth'; break; } // 잠금 예방 — 즉시 중단
        // HTTP 상태를 받은 실패(404 등 — 버전별 경로 차이)는 장비가 살아 있다는 뜻이라 세지 않는다.
        if (/^HTTP \d+/.test(e.message)) transportFails = 0;
        else if (++transportFails >= TRANSPORT_FAIL_LIMIT) { stopped = 'transport'; break; }
      }
      await yieldLoop();
    }
    summary.push({ area: area.key, ok: okCnt, failed: failCnt, ...(firstErr ? { error: firstErr.slice(0, 120) } : {}) });
  }
  // 비활성 영역도 요약에 사유와 함께 노출(숨기지 않음 — 사용자 표의 40개가 어디 갔는지 보이게).
  for (const a of ONEFS_AREAS.filter((x) => x.enabled === false)) {
    summary.push({ area: a.key, ok: 0, failed: 0, skipped: true, error: a.reason });
  }
  try { await saveAreaResults(device.id, results); } catch (e) { console.warn(`[storage-areas] DB 저장 실패(${device.id}): ${e.message}`); }
  return { summary, authDead, stopped, notTried, endpoints: results.length };
}
