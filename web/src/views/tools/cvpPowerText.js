/**
 * views/tools/cvpPowerText.js — CVP 네트워크 장비 소비전력 화면의 문구(순수 · v2.647).
 * 합계는 **값을 읽은 장비만** 더한 것이다 — 못 읽은 장비를 0W 로 세지 않는다. 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';
import { countText } from './cvpText.js';

export const POWER_NOTE = '소비전력은 장착된 PSU 의 **입력 전력 합**입니다(입력을 모르면 출력 전력으로 대신하고 표에 밝힙니다). 합계는 **값을 읽은 장비만** 더했고, '
  + '못 읽은 장비는 0W 로 세지 않고 사유별로 따로 셉니다. 마지막 부품 수집(약 30분 주기)의 순간값입니다. '
  + '부품 목록이 오래됐거나 장비 수집이 멈춘 장비의 값은 지금 값이 아니므로 합계에서 빼고 **오래된 값**으로 따로 셉니다. PSU 전력 필드 이름은 실장비로 확인하지 못한 추정입니다.';

/**
 * v2.732(감사 B2-03): 서버가 합계·판정에서 뺀 '지금 값이 아닌 장비' 의 사유(server routes/api/cvp.js CVP_STALE_REASONS 와 1:1 — 테스트 대조).
 *   소비전력·GBIC 광신호 화면이 같이 쓴다.
 */
export const CVP_STALE_REASON_TEXT = {
  'parts-stale': '부품 목록 오래됨',
  stale: '수집 오래됨',
  never: '수집 기록 없음',
  'not-streaming': '스트리밍 아님',
  'telemetry-failed': '텔레메트리 실패',
};
/** 사유별 개수 → '부품 목록 오래됨 2 · 수집 오래됨 1'(0 은 뺀다 · 모르는 키는 원문 · 없으면 ''). */
export function staleByText(by) {
  if (!by || typeof by !== 'object') return '';
  return Object.entries(by)
    .map(([k, v]) => [k, numOrNull(v)])
    .filter(([, n]) => n != null && n > 0)
    .map(([k, n]) => `${CVP_STALE_REASON_TEXT[k] || k} ${countText(n)}`)
    .join(' · ');
}

export function wattText(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  if (n >= 10_000) return `${(n / 1000).toFixed(1)} kW`;
  return `${Math.round(n).toLocaleString('ko-KR')} W`;
}

export function powerKpis(totals) {
  const t = totals && typeof totals === 'object' ? totals : {};
  const u = t.unread && typeof t.unread === 'object' ? t.unread : {};
  const read = numOrNull(t.read) ?? 0;
  const unreadN = (numOrNull(u.partsNotRead) ?? 0) + (numOrNull(u.noPsu) ?? 0) + (numOrNull(u.noPowerField) ?? 0);
  // v2.732(감사 B2-03): 오래된 값은 합계에 들어 있지 않다 — 합계 칸이 그 사실을 함께 말한다. 서버가 필드를 주지 않으면(구버전) null → '—'.
  const stale = numOrNull(t.stale);
  const staleWhy = staleByText(t.staleBy);
  return [
    { key: 'total', label: '소비전력 합계', value: read ? wattText(t.watts) : '—', meta: `값을 읽은 장비 ${countText(read)}대 기준${numOrNull(t.partial) > 0 ? ` · 일부 PSU 만 읽은 장비 ${countText(t.partial)}대` : ''}${stale > 0 ? ` · 오래된 값 ${countText(stale)}대 제외` : ''}` },
    { key: 'avg', label: '장비당 평균', value: read ? wattText(t.watts / read) : '—', meta: '값을 읽은 장비 기준' },
    { key: 'read', label: '읽은 장비', value: `${countText(read)} / ${countText(t.devices)}`, meta: numOrNull(t.capDevices) > 0 ? `PSU 용량 합 ${wattText(t.capW)}(${countText(t.capDevices)}대)` : 'PSU 용량 정보 없음' },
    { key: 'unread', label: '못 읽은 장비', value: countText(unreadN), accent: unreadN > 0 ? 'var(--amber)' : undefined,
      meta: `부품 미수집 ${countText(u.partsNotRead)} · PSU 목록 없음 ${countText(u.noPsu)} · 전력 값 없음 ${countText(u.noPowerField)}` },
    { key: 'stale', label: '오래된 값(합계 제외)', value: countText(stale), accent: stale > 0 ? 'var(--amber)' : undefined,
      meta: stale > 0 ? `${staleWhy || '사유 미상'} — 지금 값이 아닙니다` : stale == null ? '이 서버 버전은 오래된 값을 따로 세지 않습니다' : '부품 값이 오래된 장비 없음' },
  ];
}

/** v2.732(감사 B2-03): 장비 행 표지 — 오래된 행(서버 stale:true)만 사유와 직전 값을 말한다(소비전력 칸은 서버가 비운다). 지금 값이면 ''. */
export function powerRowNote(d) {
  if (!d || d.stale !== true) return '';
  const why = CVP_STALE_REASON_TEXT[d.staleReason] || '지금 값 아님';
  const last = numOrNull(d.lastWatts);
  return `오래된 값(${why})${last != null ? ` · 직전 ${wattText(last)}` : ''} — 합계 제외`;
}

export function basisText(b) {
  return b === 'input' ? '입력' : b === 'output' ? '출력(입력 모름)' : b === 'mixed' ? '입력·출력 섞임' : '—';
}

/** 모든 장비가 전력 값이 없을 때 — 원인을 단정하지 않는다. */
export function powerEmptyNote(totals) {
  const t = totals && typeof totals === 'object' ? totals : {};
  if ((numOrNull(t.read) ?? 0) > 0 || !(numOrNull(t.devices) > 0)) return '';
  const u = t.unread || {};
  if ((numOrNull(u.noPowerField) ?? 0) > 0) {
    return `PSU 는 읽었지만 **전력 값이 있는 PSU 가 없습니다**(${countText(u.noPowerField)}대). 이 CVP 의 PSU 노드 필드 이름이 추정과 다를 수 있습니다 — CVP 설정 탭의 장비 상세 › 읽은 경로에서 PSU 원문 표본을 보내 주세요.`;
  }
  // v2.732(감사 B2-03): 값은 있었지만 오래돼 합계에서 뺐다 — '아직 읽지 않았다(기다리면 된다)' 와 조치가 다르다.
  const stale = numOrNull(t.stale) ?? 0;
  if (stale > 0) {
    const why = staleByText(t.staleBy);
    return `**지금 값이 있는 장비가 없습니다** — 부품 값이 오래된 장비 ${countText(stale)}대는 합계에서 뺐습니다${why ? `(${why})` : ''}. 기다려도 채워지지 않을 수 있습니다 — CVP 설정 탭의 수집 상태를 확인하세요.`;
  }
  return '아직 PSU 를 읽은 장비가 없습니다 — 부품은 약 30분 주기로 수집합니다.';
}
