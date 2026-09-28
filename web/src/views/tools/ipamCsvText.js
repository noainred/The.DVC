/**
 * ipamCsvText.js — IP관리 › CSV 가져오기·내보내기 화면의 문구(순수, v2.636).
 * 판정은 서버(`server/src/ipam/manageCsv.js`·`scanRangesCsv.js`)가 하고 화면은 그 결과를 말하기만 한다.
 */
export const MANAGE_ACTION = Object.freeze({
  create: ['새로 지정', 'green'],
  update: ['변경', 'blue'],
  clear: ['지움', 'amber'],
  same: ['변화 없음', 'gray'],
  error: ['오류 — 적용 안 함', 'red'],
});
export const RANGE_ACTION = Object.freeze({
  add: ['추가', 'green'],
  keep: ['유지(이미 있음)', 'gray'],
  dup: ['중복 줄', 'amber'],
  empty: ['대역 없음 줄', 'gray'],
  error: ['오류', 'red'],
});
export const FIELD_TEXT = Object.freeze({
  status: '상태', deviceType: '디바이스', owner: '담당자', label: '라벨', hostnameOverride: '호스트명', claimedVcenterId: '귀속 vCenter',
  reservedUntil: '예약 만료', note: '비고', memo: '메모', tags: '태그',
});
export function actionBadge(map, a) { return map[a] || [String(a || '—'), 'gray']; }
export function changesText(changes) {
  return (changes || []).map((k) => FIELD_TEXT[k] || k).join(', ') || '—';
}

/** 관리상태 검증 요약 한 줄. */
export function manageSummaryText(s, { total = null, chunks = 1 } = {}) {
  if (!s) return '';
  const parts = [`새로 지정 ${s.create} · 변경 ${s.update} · 지움 ${s.clear} · 변화 없음 ${s.same} · 오류 ${s.error}`];
  if (total != null) parts.unshift(`데이터 ${Number(total).toLocaleString()}행`);
  if (chunks > 1) parts.push(`서버 한도 때문에 ${chunks}번에 나눠 보냈습니다`);
  return parts.join(' · ');
}
/** 적용할 행 수(검증 결과 기준). */
export function applicableCount(s) { return s ? (s.create || 0) + (s.update || 0) + (s.clear || 0) : 0; }

/** 적용 결과 한 줄 — 서버가 적용 직전에 다시 판정하므로 검증 때와 다를 수 있다는 사실을 함께 말한다. */
export function manageApplyText(r) {
  if (!r) return '';
  const base = `적용 ${Number(r.applied || 0).toLocaleString()}행 · 관리상태 저장 ${r.override?.changed ?? 0} / 삭제 ${r.override?.removed ?? 0} · 메모 저장 ${r.annotation?.changed ?? 0} / 삭제 ${r.annotation?.removed ?? 0}`;
  const err = r.summary?.error ? ` · 오류로 적용하지 않은 행 ${r.summary.error}` : '';
  return `${base}${err} — 서버가 적용 직전에 다시 판정했습니다(검증 뒤 다른 곳에서 값이 바뀌었으면 결과가 다를 수 있습니다).`;
}

/** 스캔 대역 검증 요약. */
export function rangeSummaryText(s, mode) {
  if (!s) return '';
  return `${mode === 'add' ? '추가 모드' : '교체 모드'} · 추가 ${s.add} · 유지 ${s.keep} · 중복 줄 ${s.dup} · 빈 줄 ${s.empty} · 경고 ${s.warn} · 오류 ${s.error}`;
}
export function planText(p) {
  if (p.blocked) return p.blocked;
  const parts = [];
  if (p.isNew) parts.push('새 에이전트');
  parts.push(`${p.before.length}개 → ${p.after.length}개`);
  if (p.added.length) parts.push(`+${p.added.length}`);
  if (p.removed.length) parts.push(`−${p.removed.length}(${p.removed.slice(0, 3).join(', ')}${p.removed.length > 3 ? ' …' : ''})`);
  if (!p.added.length && !p.removed.length) parts.push('변화 없음');
  return parts.join(' · ');
}
export const MODE_NOTE = Object.freeze({
  replace: '교체 — 파일에 나온 에이전트의 대역을 파일 내용으로 바꿉니다. 파일에 없는 에이전트는 그대로 둡니다. 파일에 없는 대역은 그 에이전트에서 지워집니다.',
  add: '추가 — 기존 대역은 그대로 두고 파일의 대역을 덧붙입니다(지우지 않습니다).',
});

export const MANAGE_RULES = Object.freeze([
  '**ip 열은 필수**이고, 그 밖의 열은 **파일에 있는 것만** 바꿉니다 — 메모만 있는 파일은 상태를 건드리지 않습니다.',
  '열이 있고 칸이 **비어 있으면 그 값을 지웁니다**(내보낸 파일을 그대로 다시 가져오면 바뀌는 것이 없습니다).',
  '모르는 상태·디바이스 종류, 날짜 형식 오류, 길이 초과는 **고치지 않고 그 행을 오류로** 보고합니다.',
  '파일에 **없는 IP 는 건드리지 않습니다** — 삭제는 칸을 비워서 명시합니다.',
  '검증 결과에서 오류 행만 빼고 나머지를 적용합니다. 적용 직전에 서버가 **다시 판정**합니다.',
  '범위(vCenter)·수정 권한은 한 건씩 저장할 때와 같은 규칙입니다 — 범위 밖 IP 는 그 행만 오류가 됩니다.',
]);
