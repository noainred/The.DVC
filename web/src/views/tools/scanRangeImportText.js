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

// ---- v2.692: IPMS 설정 적용(무시 대역 제외 · 공인/사설 분류) ----------------------------------------
/** 공인/사설 분류 표시 — 서버 annotateSubnets·buildScanRangeRows 의 cls 값과 1:1(테스트가 대조한다). */
export const CLS_LABEL = { private: '사설', public: '공인', mixed: '공인·사설 섞임' };
export const CLS_BADGE = { private: 'blue', public: 'amber', mixed: 'amber' };
export const CLS_FILTERS = [{ key: '', label: '전체' }, { key: 'private', label: '사설' }, { key: 'public', label: '공인' }, { key: 'mixed', label: '섞임' }];

/** 분류별 개수(필터 칩) — 분류를 모르는 행(null)은 '전체' 에만 센다. */
export function clsCounts(rows) {
  const n = { '': 0, private: 0, public: 0, mixed: 0 };
  for (const r of Array.isArray(rows) ? rows : []) { n[''] += 1; if (r && n[r.cls] !== undefined && r.cls) n[r.cls] += 1; }
  return n;
}
export function filterByCls(rows, cls) {
  const list = Array.isArray(rows) ? rows : [];
  return cls ? list.filter((r) => r?.cls === cls) : list;
}

/**
 * 기본 선택 — 이미 입력됨·형식 오류는 빼고, **공인으로 분류된 /24 도 체크를 풀어 둔다**(자동으로 빼지는 않는다 — 고르면 넣는다).
 * 섞임은 사설 주소도 들어 있어 기본 선택이다.
 */
export function defaultChosen(rows) {
  return new Set((Array.isArray(rows) ? rows : []).filter((r) => r.kind !== 'covered' && r.kind !== 'invalid' && r.cls !== 'public').map((r) => r.cidr));
}

/** 무시 대역 출처 키 → 화면 이름. sources 는 서버의 ignoreSources([{key,label}]). */
export function ignoreSourceName(key, sources) {
  const hit = (Array.isArray(sources) ? sources : []).find((s) => s.key === key);
  if (hit) return hit.label;
  if (key === 'global') return '전체(모든 vCenter)';
  return String(key || '').replace(/^vc:/, 'vCenter ');
}

/** '무시 대역 제외' 한 줄 — 뺀 것이 없으면 null(빈 문장을 띄우지 않는다). */
export function ignoredText(ignored, sources) {
  const n = Number(ignored?.count) || 0;
  if (!n) return null;
  const by = Object.entries(ignored.bySource || {}).map(([k, c]) => `${ignoreSourceName(k, sources)} ${c}`).join(' · ');
  return `IPMS 무시 대역에 전부 들어가는 /24 ${n}개를 후보에서 뺐습니다${by ? `(${by})` : ''} — 그 IP 는 대장에서 숨겨지므로 스캔해도 보이지 않습니다.`;
}

/** 무시 대역에 일부만 걸친 행의 표지. */
export function partialIgnoreText(row, sources) {
  if (row?.ignore !== 'partial') return null;
  const by = (row.ignoreBy || []).map((k) => ignoreSourceName(k, sources)).join(', ');
  return `무시 대역에 일부 걸침${by ? `(${by})` : ''} — 걸친 IP 는 스캔해도 대장에 보이지 않습니다`;
}

// ---- v2.692: ② 에이전트별 대역·보고 현황(두 표를 합친 것) -----------------------------------------
/** 보고가 이보다 오래되면 '보고 늦음'(예전 보고 현황 표와 같은 90분). */
export const REPORT_STALE_MS = 90 * 60_000;
export const REPORT_STATE_TEXT = { ok: '정상', late: '보고 늦음', off: '꺼짐', waiting: '대기', none: '보고 없음' };
export const REPORT_STATE_TITLE = {
  ok: '마지막 보고가 90분 안입니다.',
  late: '마지막 보고가 90분을 넘었습니다 — 그 에이전트(엣지)의 상태·로그를 확인하세요.',
  off: '주기 스캔이 꺼져 있어 보고가 없는 것이 정상입니다.',
  waiting: '아직 보고가 없습니다 — 엣지가 설정을 읽어 가 첫 스캔을 마치면 채워집니다(대역이 없으면 스캔하지 않습니다).',
  none: '보고 기록이 없습니다.',
};

/**
 * 에이전트 한 곳의 보고 상태. 꺼짐·대기를 '늦음' 으로 세지 않는다(기다리면 되거나 의도된 상태다).
 * @param {{enabled:boolean, at:number|null, ranges:number}} a
 */
export function reportState({ enabled, at, ranges }, now = Date.now()) {
  if (enabled === false) return 'off';
  if (at == null || !Number.isFinite(at) || at <= 0) return ranges > 0 ? 'waiting' : 'none';
  return now - at > REPORT_STALE_MS ? 'late' : 'ok';
}

/**
 * ① 표 응답(rows·agents) + 보고 기록 → 에이전트별 한 행. 이 포탈(__local__)의 보고는 폴러 lastRun 으로 본다(엣지 보고 기록에 없다).
 * @returns {Array<{name, enabled, datacenterName, lines, invalid, ips, at, scanned, alive, state}>}
 */
export function agentReportRows({ agents = [], rows = [], reports = {}, localLast = null, now = Date.now() } = {}) {
  const by = new Map();
  const get = (name) => { const k = String(name).toLowerCase(); if (!by.has(k)) by.set(k, { name, enabled: true, datacenterName: '', lines: 0, invalid: 0, ips: 0, at: null, scanned: null, alive: null }); return by.get(k); };
  for (const a of agents) if (a?.name) get(a.name).enabled = a.enabled !== false;
  for (const r of rows) {
    if (!r?.agent) continue;
    const x = get(r.agent);
    x.lines += 1; if (!r.valid) x.invalid += 1; else x.ips += Number(r.size) || 0;
    if (r.datacenterName && !x.datacenterName) x.datacenterName = r.datacenterName;
  }
  for (const [name, rep] of Object.entries(reports || {})) {
    if (!rep) continue;
    const x = get(name);
    x.at = Number.isFinite(rep.at) ? rep.at : null; x.scanned = rep.scanned ?? null; x.alive = rep.alive ?? null;
  }
  if (localLast && Number.isFinite(localLast.at)) { const x = get('__local__'); if (!x.at || localLast.at > x.at) { x.at = localLast.at; x.scanned = localLast.scanned ?? null; x.alive = localLast.alive ?? null; } }
  return [...by.values()].map((x) => ({ ...x, state: reportState({ enabled: x.enabled, at: x.at, ranges: x.lines }, now) }))
    .sort((a, b) => (a.name === '__local__' ? -1 : b.name === '__local__' ? 1 : String(a.name).localeCompare(String(b.name))));
}

/** KPI — 겹치지 않는 칸(정상·늦음·꺼짐·대기/없음) + 응답 IP 합(모르는 값은 더하지 않는다). */
export function reportKpis(list) {
  const k = { total: 0, ok: 0, late: 0, off: 0, waiting: 0, alive: 0, aliveKnown: 0 };
  for (const x of list || []) {
    k.total += 1;
    if (x.state === 'ok') k.ok += 1; else if (x.state === 'late') k.late += 1; else if (x.state === 'off') k.off += 1; else k.waiting += 1;
    if (x.alive != null && Number.isFinite(Number(x.alive))) { k.alive += Number(x.alive); k.aliveKnown += 1; }
  }
  return k;
}

/** ① 표 한 행의 '검사' 칸 — { tone, text }. 형식 오류 > 무시 대역 전부 > 다른 에이전트 겹침 > 무시 일부 > 정상. */
export function rangeRowCheck(r, sources) {
  if (!r) return { tone: 'gray', text: '—' };
  if (!r.valid) return { tone: 'red', text: `형식 오류 — ${r.reason || ''}`.trim() };
  if (r.ignore === 'full') return { tone: 'amber', text: `IPMS 무시 대역에 전부 들어갑니다(${(r.ignoreBy || []).map((k) => ignoreSourceName(k, sources)).join(', ')}) — 스캔해도 대장에 보이지 않습니다` };
  if ((r.overlaps || []).length) return { tone: 'red', text: `다른 에이전트와 겹침(${r.overlaps.map(agentName).join(', ')}) — 결과가 섞입니다` };
  if (r.ignore === 'partial') return { tone: 'amber', text: `IPMS 무시 대역에 일부 걸침(${(r.ignoreBy || []).map((k) => ignoreSourceName(k, sources)).join(', ')})` };
  return { tone: 'green', text: '정상' };
}
