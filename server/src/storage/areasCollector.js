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
// v2.730(검토 I-03): 요약 한 줄의 모양·멈춘 사유 문구·연속 실패 상한은 순수 모듈 하나가 소유한다(데모 합성과 공유).
import { TRANSPORT_FAIL_LIMIT, triedAreaEntry, notTriedAreaEntry, disabledAreaEntry, areaTotals } from './onefsAreaSummary.js';
// 옛 import 경로 호환(audit2598d) — `export … from` 은 이 스코프에 이름을 만들지 않는다(v2.575).
export { TRANSPORT_FAIL_LIMIT };

const yieldLoop = () => new Promise((r) => setImmediate(r));

/**
 * 한 장비의 전 영역 수집 → DB 저장 → 요약 반환.
 *
 * ⚠ v2.598 T2598-01: 예전엔 시한·signal 없이 66개 엔드포인트를 직렬로 불러, 장비가 응답하지 않으면 건별 시한(15초)
 * × 66 ≈ 16.5분 동안 스토리지 폴러의 재진입 가드(_busy)를 붙잡았다(그동안 다른 장비 수집이 전부 밀린다).
 * 이제 ① `signal`(폴러의 withDeadline)이 끊으면 거기서 멈추고 ② HTTP 응답 없는 실패가 연속
 * TRANSPORT_FAIL_LIMIT 회면 나머지를 시도하지 않는다(v2.591 회로 차단기와 같은 판단). 멈춘 이유와 시도하지 않은
 * 영역은 요약에 **밝힌다**(`stopped`·`notTried` — 조용한 생략 금지). 모은 결과는 멈춰도 저장한다(던지지 않는다).
 *
 * ⚠⚠ v2.730(검토 I-03 — 재현): 멈춘 **그 영역**의 남은 엔드포인트가 요약에 없어 `{area:'cluster', ok:1, failed:0}` 처럼
 * 초록 '정상' 이 됐다(첫 요청 전에 끊긴 영역도 `{ok:0, failed:0}` 로 초록). 이제 영역마다 예정·시도·미시도 엔드포인트 수와
 * `partial`·`stopReason` 을 싣고(onefsAreaSummary.js), 한 엔드포인트도 시도하지 못한 영역은 이후 영역과 같은 **미시도**다.
 * 시한이 끊은 요청은 그 엔드포인트의 실패(failed)가 아니라 미시도로 센다. `notTried` 는 예전처럼 **영역 개수**다.
 *
 * @param {object} device  등록 항목(비밀번호 포함)
 * @param {{ signal?: AbortSignal, get?: Function }} [opts]  `get` 은 테스트 주입용(기본 isilon.get — 엔드포인트 하나를 부른다)
 * @returns {Promise<{summary:object[], authDead:boolean, stopped:null|'auth'|'deadline'|'transport', notTried:number,
 *   notTriedEndpoints:number, partialAreas:number, expectedEndpoints:number, endpoints:number}>}
 */
export async function collectAreasOnce(device, { signal, get: getEndpoint = get } = {}) {
  const results = [];   // DB 저장용(엔드포인트 단위)
  const summary = [];   // push/화면용(영역 단위)
  let authDead = false;
  let stopped = null;   // null | 'auth' | 'deadline' | 'transport'
  let transportFails = 0;
  for (const area of enabledAreas()) {
    const expected = area.endpoints.length;
    if (stopped) { summary.push(notTriedAreaEntry(area.key, expected, stopped)); continue; }
    let okCnt = 0, failCnt = 0, firstErr = '';
    let stopHere = null;
    for (const ep of area.endpoints) {
      if (signal?.aborted) { stopHere = 'deadline'; break; }
      try {
        const data = await getEndpoint(device, ep, { signal });
        results.push({ area: area.key, endpoint: ep, ok: true, data });
        okCnt++;
        transportFails = 0;
      } catch (e) {
        // 시한이 끊은 요청은 그 엔드포인트의 실패가 아니다 — 미시도로 센다(장비가 실패한 것이 아니라 우리가 끊었다).
        if (signal?.aborted) { stopHere = 'deadline'; break; }
        const msg = String(e?.message ?? e);
        results.push({ area: area.key, endpoint: ep, ok: false, error: msg });
        failCnt++;
        if (!firstErr) firstErr = msg;
        if (/401|인증 실패/.test(msg)) { authDead = true; stopHere = 'auth'; break; } // 잠금 예방 — 즉시 중단
        // HTTP 상태를 받은 실패(404 등 — 버전별 경로 차이)는 장비가 살아 있다는 뜻이라 세지 않는다.
        if (/^HTTP \d+/.test(msg)) transportFails = 0;
        else if (++transportFails >= TRANSPORT_FAIL_LIMIT) { stopHere = 'transport'; break; }
      }
      await yieldLoop();
    }
    if (stopHere) stopped = stopHere;
    // 첫 요청 전에 멈췄으면 '부분' 이 아니라 미시도다(이후 영역과 같은 모양 — 초록 '0/0 정상' 이 되지 않게).
    if (stopHere && okCnt + failCnt === 0) { summary.push(notTriedAreaEntry(area.key, expected, stopHere)); continue; }
    summary.push(triedAreaEntry(area.key, { expected, ok: okCnt, failed: failCnt, firstErr, stopReason: stopHere }));
  }
  // 비활성 영역도 요약에 사유와 함께 노출(숨기지 않음 — 사용자 표의 40개가 어디 갔는지 보이게).
  for (const a of ONEFS_AREAS.filter((x) => x.enabled === false)) summary.push(disabledAreaEntry(a));
  // 중단 전 읽은 값도 저장한다(원문 보기) — 다만 그 영역의 '정상' 판정 근거로는 쓰지 않는다(웹 onefsAreaState.js).
  try { await saveAreaResults(device.id, results); } catch (e) { console.warn(`[storage-areas] DB 저장 실패(${device.id}): ${e.message}`); }
  const t = areaTotals(summary);
  return {
    summary, authDead, stopped,
    notTried: t.notTried, notTriedEndpoints: t.notTriedEndpoints, partialAreas: t.partialAreas,
    expectedEndpoints: t.expectedEndpoints, endpoints: results.length,
  };
}
