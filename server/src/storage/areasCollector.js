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

/** 한 장비의 전 영역 수집 → DB 저장 → 요약 반환 [{area, label, ok, endpoints, failed, error?}] */
export async function collectAreasOnce(device) {
  const results = [];   // DB 저장용(엔드포인트 단위)
  const summary = [];   // push/화면용(영역 단위)
  let authDead = false;
  for (const area of enabledAreas()) {
    if (authDead) break;
    let okCnt = 0, failCnt = 0, firstErr = '';
    for (const ep of area.endpoints) {
      try {
        const data = await get(device, ep);
        results.push({ area: area.key, endpoint: ep, ok: true, data });
        okCnt++;
      } catch (e) {
        results.push({ area: area.key, endpoint: ep, ok: false, error: e.message });
        failCnt++;
        if (!firstErr) firstErr = e.message;
        if (/401|인증 실패/.test(e.message)) { authDead = true; break; } // 잠금 예방 — 즉시 중단
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
  return { summary, authDead, endpoints: results.length };
}
