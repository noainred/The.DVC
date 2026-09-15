/**
 * sanswitch/perfActivityLog.js — 포트 사용량(portperfshow) 수집 작업 로그(v2.517).
 *
 * 공용 팩토리(`util/activityLog.js`, v2.516)를 그대로 쓴다 — 링버퍼·상한·절단·손상 처리는
 * 한 곳이 갖고 여기서 정하는 것은 **파일명과 수치 필드뿐**이다(CLAUDE.md 공용 팩토리 규약).
 *
 * 왜 기본 수집 로그(`activityLog.js`)와 **파일을 나누는가**: 두 폴러는 주기가 다르다(기본 수집은
 * 구성 조회, 사용량은 SSH 세션을 수 초 붙잡는 캡처). 한 링버퍼에 섞으면 잦은 쪽이 상한을 먹어
 * 다른 쪽 이력이 조용히 사라진다 — 화면도 탭이 달라 섞어 보여줄 곳이 없다.
 *
 * ⚠ **REST 수집 장비의 '건너뜀' 은 기록하지 않는다.** 그 장비는 매 주기 시도조차 하지 않으므로
 *   (perfPoller.collectOne) 기록하면 '아무 일도 없었음' 이 주기마다 상한을 소진한다. 그 사실은
 *   이벤트가 아니라 **상태**이므로 `perfDiag`('rest-method')가 화면에서 말한다.
 */
import { createActivityLog } from '../util/activityLog.js';

const log = createActivityLog({
  fileName: 'sanswitch-perf-activity.json',
  max: Number(process.env.SANSW_PERF_ACTIVITY_MAX) || 500,
  // 수집 못 한 것과 '진짜 0' 을 구분해야 하므로 유한수가 아니면 null 로 굳힌다(팩토리가 처리).
  numFields: ['ports', 'totalBps'],
});

export const { recordActivity, listActivity, _resetForTest, MAX, FILE } = log;

/**
 * 장비별 **최근 1건**(newest-first 목록에서 처음 만난 것). `perfDiag` 가 '이 장비가 마지막에
 * 성공했나 실패했나' 를 판정하는 근거다 — 폴러의 `_last.errors` 는 장비명 문자열 5건뿐이라
 * id 로 찾을 수 없었다.
 */
export function latestEventByDevice(limit = 300) {
  const out = new Map();
  for (const e of listActivity(limit)) if (!out.has(e.deviceId)) out.set(e.deviceId, e);
  return out;
}
