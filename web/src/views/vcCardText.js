/**
 * vcCardText.js — vCenter 카드 본문 판정(v2.583 감사 #39, 순수).
 *
 * 예전 카드는 `status !== 'connected'` 이면 전부 "이 vCenter에 연결할 수 없습니다" 였다. 그런데 상태는 넷이고 조치가
 * 다르다(v2.509 '수집 대기로 뭉개지 말 것 — pending 과 unreachable 을 합치지 말 것'):
 *  · pending     — 첫 수집 전·중(기다리면 채워진다). 위임 vCenter 는 엣지가 아직 인벤토리를 보내지 않은 것(note).
 *  · maintenance — 관리자가 점검 모드로 둔 것. **수집한 인벤토리가 있다** — 숨기지 않고 배너와 함께 보여 준다.
 *  · disabled    — 설정에서 수집을 꺼 둔 것.
 *  · 그 밖       — 연결 실패(오류·힌트를 함께).
 * 배지(StateBadge)가 '대기'·'점검중'·'비활성' 이라고 말하는데 본문이 '연결 불가' 라고 말하면 둘이 서로 모순된다.
 */
import { authStopInfo } from './tools/storageAuthText.js';
import { numOrNull } from '../numOrNull.js';

export function vcCardState(s = {}, now = Date.now()) {
  const st = String(s?.status || '');
  // v2.590(감사 F1): 인증 실패로 **주기 수집을 멈춘** vCenter 는 '연결할 수 없습니다' 가 아니라 '멈췄다' 를 말한다 —
  // 조치(비밀번호 수정)와 이유(계정 잠금 방지)가 다르다. 조용히 멈추면 사용자는 수집이 되는 줄 안다(authGuard 규칙 1).
  // 이월된 마지막 값(stale)이 있으면 지표는 보여 주되 '낡은 값' 임을 같은 문장이 말한다.
  if (s?.authStopped && st !== 'connected') {
    const info = authStopInfo(s.authStopped, { what: '이 vCenter', manual: '설정 › vCenter 의 연결 테스트', now });
    const hasMetricsNow = Number(s?.metrics?.hosts) > 0 || Number(s?.metrics?.vms) > 0;
    return {
      showMetrics: hasMetricsNow, tone: 'bad', bold: true, authStopped: true,
      text: `${info.text}${hasMetricsNow ? ' 아래 값은 정지 전 마지막으로 수집한 인벤토리입니다.' : ''}`,
      showError: true,
    };
  }
  const m = s?.metrics || {};
  const hasMetrics = Number(m.hosts) > 0 || Number(m.vms) > 0;
  if (st === 'connected') return { showMetrics: true, tone: 'ok', text: '' };
  if (st === 'maintenance') {
    return { showMetrics: hasMetrics, tone: 'warn', text: hasMetrics ? '점검 모드(관리자 지정) — 아래 값은 마지막으로 수집한 인벤토리입니다.' : '점검 모드(관리자 지정) — 수집한 인벤토리가 없습니다.' };
  }
  if (st === 'pending') {
    const note = String(s?.note || '').trim();
    return { showMetrics: false, tone: 'wait', text: note ? `수집 대기 — ${note}. 담당 엣지가 인벤토리를 보내면 채워집니다.` : '첫 수집 중입니다 — 잠시 기다리면 채워집니다.' };
  }
  if (st === 'disabled') return { showMetrics: false, tone: 'off', text: '수집이 꺼져 있습니다(설정 › vCenter 에서 켤 수 있습니다).' };
  return { showMetrics: false, tone: 'bad', text: '이 vCenter에 연결할 수 없습니다.', showError: true };
}

/**
 * v2.600(LO2600-01): 스토리지 막대 값. 서버가 사용량을 읽은 데이터스토어가 하나도 없으면 사용률을 null 로 준다 —
 * 예전 `m.storageUsagePct || 0` 은 그것을 **0% 막대**(= '비어 있다')로 그렸다. null 이면 막대는 '—' 이고 툴팁이 이유를 말한다.
 */
export function storageBarInfo(m = {}) {
  const pct = typeof m?.storageUsagePct === 'number' && Number.isFinite(m.storageUsagePct) ? m.storageUsagePct : null;
  const unknown = Number(m?.datastoresUsageUnknown) || 0;
  const detail = m?.storageUsedTB != null ? `${m.storageUsedTB}/${m.storageTotalTB} TB` : (m?.storageTotalTB != null ? `${m.storageTotalTB} TB` : '—');
  const title = unknown
    ? (pct == null
      ? `데이터스토어 ${unknown}개의 사용량을 읽지 못해 사용률을 모릅니다(0% 가 아닙니다)`
      : `사용량을 읽지 못한 데이터스토어 ${unknown}개는 사용률 계산에서 뺐습니다`)
    : undefined;
  return { pct, detail, title };
}

/**
 * v2.621(감사 WEB-03): 개요 스토리지 KPI 의 '뺀 것' 문구. 서버 롤업(store.js RECENT2599-03)은 사용량을 못 읽은
 * 데이터스토어를 **용량·사용량 양쪽**에서 빼고 그 개수를 `datastoresUsageUnknown` 으로 준다. 개수를 말하지 않으면
 * '600 / 900 TB · 38 DS' 의 900 TB 가 38개 전체의 합으로 읽힌다(뺀 것은 밝힌다 — v2.509). 개요 화면 넷
 * (classic·V4·V5·관제 콘솔)이 이 함수 하나를 쓴다 — 화면마다 문구를 만들면 한쪽만 말하게 된다.
 * @returns {string|null} 뺀 것이 없으면 null(붙이지 않는다)
 */
export function storageUsageUnknownNote(roll) {
  const n = numOrNull(roll?.datastoresUsageUnknown);
  return n != null && n > 0 ? `사용량 미상 DS ${n.toLocaleString('en-US')}개는 용량·사용량 합계에서 뺐습니다` : null;
}

/**
 * v2.621(감사 WEB-08): '물리 서버' KPI 값. iDRAC 등록 수가 없거나(범위 계정의 귀속 실패 → physical=null) 0 이면
 * **ESXi 호스트 수로 대체하지 않는다** — 예전 `physical.servers || global.hosts` 는 186(ESXi 호스트)을 '물리 서버 186'
 * 으로 보였고, 같은 원천을 V5 는 '—', classic 은 iDRAC 수로 보여 화면마다 같은 이름의 수치가 달랐다.
 * 값이 없으면 null(화면 '—')이고 `note` 가 이유를 말한다. ESXi 호스트 수는 호출부가 meta 에 따로 적는다.
 * @returns {{ value: number|null, note: string|null }}
 */
export function physicalServersKpi(physical) {
  const n = numOrNull(physical?.servers);
  if (n != null && n > 0) return { value: n, note: null };
  if (physical == null || n == null) return { value: null, note: '물리 서버 집계 없음' };
  return { value: null, note: 'iDRAC 등록 없음' };
}
