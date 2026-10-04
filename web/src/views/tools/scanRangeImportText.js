/**
 * scanRangeImportText.js — IP관리 › 스캔 대역·설정(에이전트별)의 '/24 가져오기'·중복 대역·이전 안내 문구(순수, v2.691).
 *
 * v2.691 에 '대역·스캔'(vCenter 별)이 이 화면으로 합쳐졌다. 판정 코어는 v2.690 의 vcRangeImportText.js(classifySubnets·
 * applyImport·reflectDups·classifyLine)를 그대로 쓴다 — 거기의 '다른 vCenter' 자리에 **다른 에이전트(소유자)** 를 넣는다.
 * 소유자 목록은 서버 GET /admin/ipam/scan/owners(에이전트별 스캔 대역 + 아직 옮기지 못한 vCenter 별 대역)다.
 */

/** 서버 소유자 목록 → classifySubnets 가 받는 saved 모양. 지금 고른 에이전트는 뺀다(그 저장분은 텍스트 박스가 대신한다). */
export function ownersToSaved(owners, agent) {
  const me = String(agent ?? '').toLowerCase();
  const out = [];
  for (const o of Array.isArray(owners) ? owners : []) {
    if (!o || !Array.isArray(o.ranges) || !o.ranges.length) continue;
    if (o.kind !== 'vcenter' && String(o.owner ?? '').toLowerCase() === me) continue;
    out.push({ vcenterId: `owner:${o.owner}`, vcenterName: o.label || o.owner, ranges: o.ranges });
  }
  return out;
}

/** 서비스 카드 제목 — 번호 + 이름(없으면 '이름 없음'. 지어내지 않는다). */
export function serviceTitle(s) {
  if (!s) return '';
  const name = String(s.service ?? '').trim();
  return `${s.no}. ${name || '이름 없음'}`;
}
export const serviceUnnamed = (s) => !String(s?.service ?? '').trim();

/** 기본으로 고를 서비스 — 켜진 것 중 첫째, 없으면 첫째. 서비스가 없으면 null. */
export function defaultServiceNo(services) {
  const list = Array.isArray(services) ? services : [];
  if (!list.length) return null;
  return (list.find((s) => s.enabled !== false) || list[0]).no;
}

/** 서비스 카드 한 줄 설명. */
export function serviceMeta(s) {
  if (!s) return '';
  const parts = [`대역 ${(s.ranges || []).length}줄 → /24 ${(s.subnets || []).length}개`];
  if (s.enabled === false) parts.push('꺼진 스캔 대역');
  if ((s.invalid || []).length) parts.push(`읽을 수 없는 줄 ${s.invalid.length}`);
  if (s.omitted) parts.push(`상한을 넘어 ${s.omitted}개 생략`);
  return parts.join(' · ');
}

/** iDRAC 가져오기 머리 문구(서비스 목록 기준). 빈 이유를 단정하지 않는다. */
export function idracHeadText(r) {
  if (!r) return '';
  if (!r.datacenterId) return '이 에이전트의 DataCenter 를 정하지 못했습니다 — 아래에서 DataCenter 를 고르세요(임의로 고르지 않습니다).';
  const name = r.datacenterName || r.datacenterId;
  if (r.datacenterMissing) return `DataCenter ‘${name}’ 이 등록 목록에 없습니다(삭제됨) — 다른 DataCenter 를 고르세요.`;
  const n = (r.services || []).length;
  if (!n) return `DataCenter ${name} 에 등록된 iDRAC 스캔 대역이 없습니다.`;
  const src = r.datacenterSource === 'chosen' ? '(직접 고름)' : r.datacenterSource === 'manual' ? '(이 에이전트에 지정한 DataCenter)' : r.datacenterSource === 'none' ? '' : '(이 에이전트가 속한 DataCenter)';
  return `DataCenter ${name}${src} · iDRAC 스캔 대역 서비스 ${n}개${n > 1 ? ' — 하나를 골라 불러옵니다' : ''}`;
}

/** 중복 칸 사유(에이전트 기준 문구). */
export function agentDupReasonText(c) {
  if (!c) return '';
  if (c.kind === 'covered') return '이 에이전트 대역에 이미 있습니다';
  if (c.kind === 'partial') return '이 에이전트의 다른 줄과 일부 겹칩니다';
  if (c.kind === 'other') return `다른 스캔 대역(${(c.with || []).join(', ')})과 겹칩니다`;
  if (c.kind === 'invalid') return '대역 형식이 아닙니다';
  return '';
}
export const AGENT_KIND_LABEL = { new: '새 대역', covered: '이미 입력됨', partial: '일부 겹침', other: '다른 에이전트와 겹침', invalid: '형식 오류' };

/** 이전 결과 사유 문구 — 서버 MIGRATION_REASONS 와 1:1(테스트가 대조한다). */
export const MIGRATION_REASON_TEXT = {
  moved: '옮김',
  empty: '대역이 비어 있어 지웠습니다',
  deleted: '등록 목록에 없는 vCenter 입니다',
  'vc-disabled': 'vCenter 가 비활성이라 옮기지 않았습니다',
  'range-off': '꺼져 있던 대역이라 옮기지 않았습니다(켜면 스캔이 시작됩니다)',
  'no-agent': '담당 엣지를 정할 수 없어 그대로 두었습니다',
};

export function agentName(a) { return a === '__local__' ? '이 포탈에서 직접' : String(a ?? ''); }

/**
 * 이전 결과 한 행 — { vcenter, mode, target, ranges, result, tone }.
 * result 는 화면 문구, tone 은 'ok'|'warn'|'dim'.
 */
export function migrationRow(it) {
  const mode = it.collectMode === 'site' ? '엣지 위임' : it.collectMode === 'direct' ? '중앙 직접' : '—';
  const n = (it.ranges || []).length;
  const rangesText = n ? `${it.ranges[0]}${n > 1 ? ` 외 ${n - 1}줄` : ''}` : '—';
  if (it.result === 'moved') {
    const parts = [`옮김 · ${n}줄`];
    if (it.merged) parts.push(`이미 있던 ${it.merged}줄은 합침`);
    if (it.enabledAgent) parts.push('그 에이전트 주기 스캔을 켰습니다');
    if ((it.invalid || []).length || it.invalidDropped) parts.push(`형식 오류 ${(it.invalid || []).length || it.invalidDropped}줄은 옮기지 않음`);
    if (it.manual) parts.push('직접 옮김');
    return { vcenter: it.vcenterName || it.vcenterId, mode, target: agentName(it.target), ranges: rangesText, result: parts.join(' · '), tone: 'ok' };
  }
  if (it.result === 'removed') return { vcenter: it.vcenterName || it.vcenterId, mode, target: '—', ranges: rangesText, result: it.manual ? '지웠습니다' : (MIGRATION_REASON_TEXT[it.reason] || '지웠습니다'), tone: 'dim' };
  if (it.result === 'failed') return { vcenter: it.vcenterName || it.vcenterId, mode, target: '옮기지 못함', ranges: rangesText, result: `오류: ${it.error || '알 수 없음'}`, tone: 'warn' };
  return { vcenter: it.vcenterName || it.vcenterId, mode, target: '옮기지 않음', ranges: rangesText, result: MIGRATION_REASON_TEXT[it.reason] || it.reason || '옮기지 않았습니다', tone: 'warn' };
}

/** 이전 안내를 보여 줄지 — 이전 기록이 있고(항목 1개 이상) 아직 '다시 보지 않기' 를 안 눌렀거나, 남은 대역이 있으면. */
export function migrationVisible(m) {
  if (!m) return false;
  if ((m.remaining || []).length) return true;
  const st = m.state;
  return !!(st && (st.items || []).length && !st.dismissedAt);
}
