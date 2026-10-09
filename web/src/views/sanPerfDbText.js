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

/**
 * v2.728(SAN 1차): 행 수는 이제 '세지 않고' 인덱스 끝(rowid)으로 어림한다 — 전체 COUNT 가 운영 DB 에서 포탈을 수십 초 멈췄다.
 * 어림값이면 '약' 을 붙인다(정리로 생긴 틈을 세므로 실제보다 클 수 있다).
 */
export function rowsText(n, approx) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${approx ? '약 ' : ''}${Number(n).toLocaleString()}행`;
}

/**
 * v2.728(SAN 2차): 집계 표(15분·1시간) 상태 한 줄. state 는 서버 runRollupBackfill 의 상태 —
 * idle(기동 뒤 시작 대기) · running · paused · done · error · off(SANSW_PERF_ROLLUP_BACKFILL=0) · unavailable.
 * 모르는 상태·필드 없음이면 null(지어내지 않는다).
 */
export function rollupStatusText(r) {
  if (!r || typeof r !== 'object') return null;
  const ret = r.retention && typeof r.retention === 'object' ? r.retention : {};
  const keep = [
    Number.isFinite(Number(ret.m15Days)) ? `15분 표 ${Number(ret.m15Days)}일` : null,
    Number.isFinite(Number(ret.h1Days)) ? `1시간 표 ${Number(ret.h1Days).toLocaleString()}일` : null,
  ].filter(Boolean).join(' · ');
  const keepText = keep ? ` · 보관 ${keep}` : '';
  const pct = Number.isFinite(Number(r.pct)) ? Number(r.pct) : null;
  switch (r.state) {
    case 'done': return { tone: 'ok', text: `집계 표 준비 완료${keepText}` };
    case 'running': return { tone: 'busy', text: `이전 표본을 집계 표로 옮기는 중${pct != null ? ` ${pct}%` : ''}(조각 ${Number(r.slices) || 0}개) — 끝나기 전에는 오래된 구간을 원본에서 읽어 조금 느릴 수 있습니다${keepText}` };
    case 'paused': return { tone: 'busy', text: `이전 표본 집계를 잠시 멈췄습니다${pct != null ? `(${pct}%)` : ''} — 다음 기동 또는 다음 차례에 이어서 합니다${keepText}` };
    case 'idle': return { tone: 'busy', text: `이전 표본 집계 대기 — 기동 몇 분 뒤 시작합니다${pct != null ? `(지금 ${pct}%)` : ''}${keepText}` };
    case 'error': return { tone: 'bad', text: `이전 표본 집계 실패: ${String(r.error || '사유 미상')} — 다음 기동 때 이어서 합니다. 조회는 원본으로 계속 됩니다${keepText}` };
    case 'off': return { tone: 'muted', text: `이전 표본 집계가 꺼져 있습니다(SANSW_PERF_ROLLUP_BACKFILL=0) — 집계 표는 새 표본부터 쌓이고, 그 전 구간은 원본에서 읽습니다${keepText}` };
    case 'unavailable': return { tone: 'muted', text: '집계 표를 쓸 수 없습니다(DB 사용 불가)' };
    default: return null;
  }
}
