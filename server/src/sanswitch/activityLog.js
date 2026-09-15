/**
 * sanswitch/activityLog.js — SAN 스위치 수집 '작업 로그'(v2.516).
 *
 * 사용자 요구(2026-09-15): "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그 보여주는 기능 추가"
 * + "실패일때 클릭하면 구체적인 로그 보여주는 기능".
 *
 * 스토리지와 **같은 공용 팩토리**(`util/activityLog.js`)를 쓴다 — 복사하면 두 로그의 포맷·상한·
 * 손상 처리가 갈라진다(CLAUDE.md 복제 금지). 여기서 정하는 것은 파일명과 **스위치 전용 수치**뿐이다.
 *
 * ⚠ 수치 필드는 0 과 '미수집' 을 구분해야 한다 — 수집 실패 시 포트 수는 null 이고, 팩토리가
 *   유한수가 아닌 값을 null 로 굳힌다. 0 으로 채우면 '포트 0개' 라는 사실과 다른 화면이 된다.
 */
import { createActivityLog } from '../util/activityLog.js';

const log = createActivityLog({
  fileName: 'sanswitch-activity.json',
  max: Number(process.env.SANSWITCH_ACTIVITY_MAX) || 500,
  // 스위치 전용 수치 — 화면의 '포트'·'사용률' 열이 쓴다(용량이 아니라 포트가 이 장비의 용량이다).
  numFields: ['portsOnline', 'portsLicensed', 'portsFree', 'usedPct'],
});

export const recordActivity = log.recordActivity;
export const listActivity = log.listActivity;
export const _resetForTest = log._resetForTest;
