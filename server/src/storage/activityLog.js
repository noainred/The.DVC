/**
 * storage/activityLog.js — 스토리지 수집 '작업 로그'(v2.315, 사용자 요구 '진행중/완료 창').
 *
 * v2.516: 링버퍼·영속·절단 구현은 `util/activityLog.js` **공용 팩토리**로 옮겼다 — SAN 스위치도
 * 같은 기능을 요구받았고(사용자: "스토리지 모니터링 처럼 … 진행상태와 로그"), 파일을 복사하면
 * 로그 포맷·상한·손상 처리가 두 갈래로 갈라진다. 이 파일은 **스토리지 전용 값만 정하는 얇은 층**
 * 이고 기존 export 시그니처를 그대로 유지한다(호출부·테스트 무변경).
 *
 * 왜 이 로그가 필요한가: store.js 는 장비별 **최신 스냅샷 1건만** 보관하므로 '과거에 언제 수집했고
 * 성공/실패였나' 는 남지 않는다. 각 수집 실행(중앙 직접 = poller.collectOne, 엣지 push 수신 =
 * central/storageEdge.saveEdgeStorage)을 시간순으로 남겨 화면 '완료(로그)' 구획의 원천이 된다.
 * '진행중' 은 poller 의 in-flight 집합이 담당한다(여긴 완료분).
 */
import { createActivityLog } from '../util/activityLog.js';

const log = createActivityLog({
  fileName: 'storage-activity.json',
  max: Number(process.env.STORAGE_ACTIVITY_MAX) || 500,
  // 스토리지 전용 수치 — 화면의 '노드'·'용량' 열이 이 값을 쓴다.
  numFields: ['nodes', 'usedBytes', 'totalBytes'],
});

export const recordActivity = log.recordActivity;
export const listActivity = log.listActivity;
export const _resetForTest = log._resetForTest;
