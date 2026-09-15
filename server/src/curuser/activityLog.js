/**
 * curuser/activityLog.js — '현재 사용자' 수집 작업 로그(v2.520).
 *
 * 공용 팩토리(`util/activityLog.js`) 하나를 쓴다 — 스토리지·SAN 스위치·SAN 사용량과 같은 규약이라
 * 웹의 공용 패널(`views/tools/CollectActivity.jsx`)이 그대로 그린다. 응답 형태 `{poller, events}` 를
 * 바꾸지 말 것(한쪽이 조용히 빈다).
 *
 * 수치 필드: `vms`(조회한 대상 수) · `users`(그 주기 고유 사용자 수). 실패 주기는 **null** 이다 —
 * 0 으로 채우면 '사용자 0명' 이라는 거짓이 된다(v2.516 실측으로 확인된 유형).
 */
import { createActivityLog } from '../util/activityLog.js';

const log = createActivityLog({
  fileName: 'curuser-activity.json',
  max: Number(process.env.CURUSER_ACTIVITY_MAX) || 500,
  numFields: ['vms', 'users'],
});

export const recordCurUserActivity = log.recordActivity;
export const listCurUserActivity = log.listActivity;
export const _resetActivityForTest = log._resetForTest;
