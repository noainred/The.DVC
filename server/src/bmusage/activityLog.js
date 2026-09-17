/**
 * bmusage/activityLog.js — 베어메탈 사용률 수집 작업 로그(v2.550).
 *
 * 공용 팩토리 하나를 쓴다(`util/activityLog.js` — v2.516 규약). 파일은 **다른 수집과 나눈다** —
 * 주기가 다르면 잦은 쪽이 상한을 먹어 다른 쪽 이력이 조용히 사라진다.
 *
 * ⚠ **실패 주기의 수치는 싣지 않는다** — 0 을 실으면 화면에 `CPU 0%` 가 찍혀 '부하 없음' 이라는
 *   거짓이 된다(v2.516 `snap.ok ? … : {}` 규약).
 */
import { createActivityLog } from '../util/activityLog.js';

const log = createActivityLog({
  fileName: 'bmusage-activity.json',
  max: Number(process.env.BMUSAGE_ACTIVITY_MAX) || 500,
  // 수집 1건(서버 1대)마다 남기는 수치. 실패 주기에는 **싣지 않는다**(null).
  numFields: ['cpuPct', 'memPct', 'diskBusyPct', 'netPct', 'hbaPct'],
});

export const recordBmUsage = log.recordActivity;
export const bmUsageEvents = log.listActivity;
export const bmUsageLogInfo = () => ({ max: log.MAX, file: log.FILE });
export const _resetActivityForTest = log._resetForTest;
