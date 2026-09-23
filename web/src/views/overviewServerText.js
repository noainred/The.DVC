/**
 * Overview '법인별 서버·게스트 수량' 의 보조 행·문구(v2.583, 순수 — vitest 로 고정).
 *
 * 사용자 신고(스크린샷): "서버 합계에 물리서버 수량 안나오는거 수정해줘". 화면은 `물리 전용 503` 인데
 * 법인별 표의 '물리 전용' 열이 **전 행 0** 이었고 503대는 표 어디에도 없었다(문구 한 줄로만 밝혔다).
 * 서버(`idrac/serverByCorp.js`)가 이제 관리자 지정·법인(DataCenter)으로 vCenter 행을 정하고,
 * **정할 수 없는 서버는 추측하지 않고** 두 묶음으로 내보낸다:
 *   · 법인은 알지만 그 법인의 vCenter 가 여러 개(또는 0개)라 행을 정하지 못한 것 — 법인별 개수
 *   · 법인조차 모르는 것
 * 이 모듈은 그 둘을 표 아래 고정 행으로 만든다 — 표의 물리 전용 합이 KPI 와 같아지게(숨기지 않는다).
 * 구버전 서버(필드 없음)면 `physicalOnlyUnassigned` 전체를 '법인 미귀속' 한 행으로 보인다.
 */

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—');
const sumOf = (m) => Object.values(m || {}).reduce((a, b) => a + (Number(b) || 0), 0);

/** 표 아래 고정 행. hosts/vms 는 null(이 행에는 가상화 호스트·게스트가 없다 — 0 이 아니라 '해당 없음'). */
export function unplacedRows(pbc) {
  if (!pbc || typeof pbc !== 'object') return [];
  const names = pbc.datacenterNames || {};
  const rows = Object.entries(pbc.unplacedByDatacenter || {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([id, n]) => ({
      id: `dc:${id}`, kind: 'dc', name: `${names[id] || id} · vCenter 미지정`,
      physOnly: Number(n), total: Number(n), hosts: null, vms: null, vmsOn: null, perHost: null,
      title: '법인(DataCenter)은 알지만 그 법인의 vCenter 가 여러 개(또는 없음)라 어느 vCenter 행에 넣을지 근거가 없습니다. 특수 기능 › 통합 서버 인벤토리의 베어메탈 행에서 법인(vCenter)을 지정하면 그 행으로 옮겨집니다.',
    }));
  const hasSplit = pbc.physicalOnlyNoDatacenter !== undefined;
  const none = hasSplit ? pbc.physicalOnlyNoDatacenter : pbc.physicalOnlyUnassigned;
  if (Number(none) > 0) {
    rows.push({
      id: '__none__', kind: 'none', name: '법인 미귀속',
      physOnly: Number(none), total: Number(none), hosts: null, vms: null, vmsOn: null, perHost: null,
      title: '등록부에 vCenter 도 법인(DataCenter)도 없는 물리 서버입니다. 설정 › DataCenter(법인)에서 수집 서버의 법인을 맞추거나, 특수 기능 › 통합 서버 인벤토리의 베어메탈 행에서 법인(vCenter)을 지정하세요.',
    });
  }
  return rows;
}

/** 표 머리 오른쪽 문구 — 무엇을 어디에 넣었는지 밝힌다. */
export function corpNoteText(pbc) {
  if (!pbc) return '';
  const parts = ['서버 합계 = 물리 전용 + 가상화 호스트(같은 장비를 두 번 세지 않습니다)'];
  const by = pbc.matchedBy || {};
  const helped = [];
  if (Number(by.datacenter) > 0) helped.push(`법인(DataCenter)의 vCenter 로 ${fmt(by.datacenter)}대`);
  if (Number(by.assigned) > 0) helped.push(`관리자 지정으로 ${fmt(by.assigned)}대`);
  if (helped.length) parts.push(`물리 서버 귀속: ${helped.join(' · ')}`);
  const unplaced = sumOf(pbc.unplacedByDatacenter);
  if (unplaced > 0) parts.push(`vCenter 를 정하지 못한 서버 ${fmt(unplaced)}대는 '법인 · vCenter 미지정' 행`);
  const hasSplit = pbc.physicalOnlyNoDatacenter !== undefined;
  const none = hasSplit ? pbc.physicalOnlyNoDatacenter : pbc.physicalOnlyUnassigned;
  if (Number(none) > 0) parts.push(`법인도 모르는 서버 ${fmt(none)}대는 '법인 미귀속' 행`);
  if (pbc.scoped) parts.push('허용된 법인만 표시');
  return parts.join(' · ');
}

/** '물리 전용 서버' KPI 의 부연. */
export function physNoteText(pbc) {
  if (!pbc) return '';
  const parts = [`iDRAC 등록 ${fmt(pbc.total)}대 중 가상화 호스트로 확인되지 않은 서버`];
  const unplaced = sumOf(pbc.unplacedByDatacenter);
  const hasSplit = pbc.physicalOnlyNoDatacenter !== undefined;
  const none = hasSplit ? pbc.physicalOnlyNoDatacenter : pbc.physicalOnlyUnassigned;
  if (unplaced > 0) parts.push(`vCenter 미지정 ${fmt(unplaced)}대`);
  if (Number(none) > 0) parts.push(`법인 미귀속 ${fmt(none)}대`);
  if (pbc.disabled) parts.push(`비활성 ${fmt(pbc.disabled)}대`);
  return parts.join(' · ');
}
