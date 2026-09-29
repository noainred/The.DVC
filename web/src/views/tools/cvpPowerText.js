/**
 * views/tools/cvpPowerText.js — CVP 네트워크 장비 소비전력 화면의 문구(순수 · v2.647).
 * 합계는 **값을 읽은 장비만** 더한 것이다 — 못 읽은 장비를 0W 로 세지 않는다. 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';
import { countText } from './cvpText.js';

export const POWER_NOTE = '소비전력은 장착된 PSU 의 **입력 전력 합**입니다(입력을 모르면 출력 전력으로 대신하고 표에 밝힙니다). 합계는 **값을 읽은 장비만** 더했고, '
  + '못 읽은 장비는 0W 로 세지 않고 사유별로 따로 셉니다. 마지막 부품 수집(약 30분 주기)의 순간값입니다. PSU 전력 필드 이름은 실장비로 확인하지 못한 추정입니다.';

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
  return [
    { key: 'total', label: '소비전력 합계', value: read ? wattText(t.watts) : '—', meta: `값을 읽은 장비 ${countText(read)}대 기준${numOrNull(t.partial) > 0 ? ` · 일부 PSU 만 읽은 장비 ${countText(t.partial)}대` : ''}` },
    { key: 'avg', label: '장비당 평균', value: read ? wattText(t.watts / read) : '—', meta: '값을 읽은 장비 기준' },
    { key: 'read', label: '읽은 장비', value: `${countText(read)} / ${countText(t.devices)}`, meta: numOrNull(t.capDevices) > 0 ? `PSU 용량 합 ${wattText(t.capW)}(${countText(t.capDevices)}대)` : 'PSU 용량 정보 없음' },
    { key: 'unread', label: '못 읽은 장비', value: countText(unreadN), accent: unreadN > 0 ? 'var(--amber)' : undefined,
      meta: `부품 미수집 ${countText(u.partsNotRead)} · PSU 목록 없음 ${countText(u.noPsu)} · 전력 값 없음 ${countText(u.noPowerField)}` },
  ];
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
  return '아직 PSU 를 읽은 장비가 없습니다 — 부품은 약 30분 주기로 수집합니다.';
}
