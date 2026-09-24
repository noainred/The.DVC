/**
 * SAN 포트 사용량 DB 보관 현황 문구(순수, v2.602 — 감사 DB2602-02).
 * 서버 perfDbStats 는 행 수·스위치 수·24시간 적재 수를 60초 캐시한다(설정 화면이 20초마다 부르므로). 캐시라는 사실을
 * 숨기면 '방금 적재했는데 행 수가 안 변했다' 를 저장 실패로 읽는다 — 집계 시각을 밝힌다.
 * countsAt 이 없으면(구버전 서버) null — 지어내지 않는다.
 */
export function countsAtNote(db, now) {
  const at = db && typeof db.countsAt === 'number' && Number.isFinite(db.countsAt) ? db.countsAt : null;
  if (at == null || !Number.isFinite(now)) return null;
  const sec = Math.max(0, Math.round((now - at) / 1000));
  return `행 수·스위치 수·24시간 적재는 ${sec < 5 ? '방금' : `${sec}초 전`} 집계(최대 1분 캐시 — 적재·정리 시 다시 셉니다)`;
}
