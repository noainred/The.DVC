/**
 * bmcPollText.js — iDRAC(BMC) 폴러 최근 실행의 '응답' KPI(v2.631 감사 WEB2631-07, 순수).
 *
 * 폴러가 긴급중단·등록 0대·목 모드로 **아무것도 폴링하지 않은 주기**의 lastRun 은 `{ ok:0, failed:0 }` 이다.
 * 예전에는 분모를 `Math.max(1, ok+failed)` 로 만들어 V4 'BMC 응답' 이 **초록 0%**, 관제 콘솔 폴러 카드가
 * **초록 0/0** 이 됐다 — 0% 는 '전부 무응답' 으로, 초록은 '정상' 으로 읽힌다. 시도한 대수가 0 이면 비율은
 * **null('—')** 이고 색은 중립이며, 이유(긴급중단·대상 없음)를 문구가 말한다.
 *
 * @param {object|null} lr  /admin/idrac 응답의 poller.lastRun
 * @returns {{ attempted: number|null, pct: number|null, tone: 'ok'|'warn'|'bad'|'neutral', reason: string|null }}
 */
import { numOrNull } from '../numOrNull.js';

export function bmcPollSummary(lr) {
  if (!lr || typeof lr !== 'object') return { attempted: null, ok: null, failed: null, pct: null, tone: 'neutral', reason: null };
  const ok = numOrNull(lr.ok) ?? 0;
  const failed = numOrNull(lr.failed) ?? 0;
  const attempted = ok + failed;
  if (attempted <= 0) {
    let reason = '최근 실행에서 폴링한 서버 없음';
    if (lr.skipped === '긴급중단') reason = '긴급중단 중 — 폴링하지 않았습니다';
    else if (lr.skipped) reason = `폴링하지 않음(${String(lr.skipped)})`;
    else if (lr.mock) reason = '목(mock) 모드 — 실제 BMC 를 폴링하지 않았습니다';
    else if (Array.isArray(lr.results) && lr.results.length === 0) reason = '폴링 대상 서버 없음';
    return { attempted: 0, ok, failed, pct: null, tone: 'neutral', reason };
  }
  const pct = (ok / attempted) * 100;
  return { attempted, ok, failed, pct, tone: failed === 0 ? 'ok' : ok === 0 ? 'bad' : 'warn', reason: null };
}

/** 톤 → 색(V4·관제 콘솔 KPI accent). neutral 은 회색이다(초록이 아니다). */
export const BMC_TONE_COLOR = { ok: '#16a34a', warn: '#d97706', bad: '#dc2626', neutral: '#6b7280' };
