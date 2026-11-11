/**
 * svcInventoryText.js — '서비스 인벤토리'(v2.887) 화면 문구·표시 판정(순수). **소속 판정은 서버(servicemap/resolve.js) 하나** —
 *   여기에는 판정을 복제하지 않고, 서버가 준 코드(src·reason)를 문장으로 바꾸고 트리·행렬 모양만 만든다.
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다). 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';
import { dayStamp } from '../../dayStamp.js';

export const SRC_LABEL = Object.freeze({ pin: '고정', folder: 'vCenter 폴더 규칙', scan: '스캔 엔트리', tag: 'vSphere 태그', rule: '이름 규칙', none: '미지정' });
export const SRC_SHORT = Object.freeze({ pin: '고정', folder: '폴더', scan: '스캔', tag: '태그', rule: '규칙' });
export const SRC_BADGE = Object.freeze({ pin: 'purple', folder: 'blue', scan: 'teal', tag: 'blue', rule: 'gray', none: 'amber' });
export const REASON_TEXT = Object.freeze({
  'no-corp': '법인 귀속 없음 — 통합 서버 인벤토리에서 법인을 먼저 정합니다',
  'no-corp-error': '법인 귀속 판정을 돌리지 못함(오류 — 입력 오류 목록 참고) — 이 서버의 법인을 지금은 모릅니다',
  'no-corp-conflict': '같은 서비스 태그가 두 법인에 걸려 귀속을 보류함 — 통합 서버 인벤토리에서 법인을 정합니다',
  'no-folder-rule': 'vCenter 폴더 규칙 없음',
  'placement-unknown': 'vSphere 위치를 따라가지 못함(vApp 안 VM 등) — 고정으로만 넣을 수 있습니다',
  'tags-unchecked': '태그를 읽지 못함(확인 안 됨) · 폴더 규칙 없음',
  'tag-unmapped': '태그 값에 맞는 서비스 없음',
  'no-scan-entry': '스캔 엔트리 없음(수동 등록)',
  'scan-entry-unknown': '보고된 스캔 엔트리를 중앙 등록부에서 찾지 못함(엣지가 따로 만든 엔트리 등)',
  'source-old': '보고한 엣지·수집 서버가 스캔 엔트리 id 를 보내지 않음(구버전 — 최신 버전으로 올리면 엔트리로 묶입니다)',
  'source-unreported': '엣지·수집 서버가 이 서버의 등록 정보를 보내지 않음(OME 장치 · 서버 목록을 보내지 않는 수집 서버 · 아직 못 받음) — 수동 등록인지 모릅니다',
  'scan-label-empty': '스캔 엔트리 라벨이 비어 있음',
  'scan-label-unmapped': '스캔 라벨에 맞는 서비스 없음',
});
export const GROUP_TITLE = Object.freeze({
  folder: (g) => (g.value === '/' ? 'vCenter 루트(폴더 없음)' : `vCenter 폴더 ${g.value}`),
  tag: (g) => `태그 값 ‘${g.value}’ — 서비스 없음`,
  entry: (g) => `스캔 엔트리 ${g.entry?.range || `#${String(g.value).slice(0, 8)}`} — 라벨 없음`,
  scan: (g) => `스캔 라벨 ‘${g.value}’ — 서비스 없음`,
  placement: () => 'vSphere 위치 모름(vApp 안 VM 등)',
  manual: (g) => (g.value === 'old-source' ? '스캔 엔트리 id 를 보내지 않는 구버전 엣지·수집 서버 — 최신 버전으로 올리면 엔트리로 묶입니다'
    : g.value === 'unknown-entry' ? '중앙 등록부에 없는 스캔 엔트리(엣지가 따로 만든 엔트리 등)'
      : g.value === 'not-reported' ? '등록 정보가 오지 않은 엣지·수집 서버 출처(OME 장치 · 서버 목록 없음 · 아직 못 받음) — 수동 등록인지 모릅니다'
        : '묶을 출처 없음(수동 등록 iDRAC)'),
  nocorp: (g) => (g.value === 'attr-error' ? '법인 귀속 없음 — 귀속 판정을 돌리지 못함(오류)'
    : g.value === 'tag-conflict' ? '법인 귀속 없음 — 같은 서비스 태그가 두 법인에 걸려 보류'
      : '법인 귀속 없음 — 어느 귀속 규칙에도 맞지 않음(통합 서버 인벤토리에서 법인을 정합니다)'),
});
export const TIER_TEXT = Object.freeze({ 1: '등급 1 — 장애·백업 실패를 가장 먼저 본다', 2: '등급 2', 3: '등급 3' });
export const FAULT_REASON = Object.freeze({ off: '부품 장애 기능이 꺼져 있어 장애 수를 모릅니다', 'no-db': '부품 장애 기록이 아직 없어 장애 수를 모릅니다', unreadable: '부품 장애 DB 를 읽지 못해 장애 수를 모릅니다' });

const n0 = (v) => numOrNull(v) ?? 0;
export const pctText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${Math.round(n)}%`; };
export const numText = (v) => { const n = numOrNull(v); return n == null ? '—' : Math.round(n).toLocaleString(); };
export const gbText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${Math.round(n).toLocaleString()} GB`; };

/** 부품 장애 칸 — 기능이 꺼졌거나 못 읽었으면 null('—'). 구성원 장애와 영향 호스트 장애를 나눠 준다. */
export function faultsView(f, available) {
  if (!available || !f) return null;
  return { member: n0(f.member), host: n0(f.host), unknown: n0(f.memberUnknown) + n0(f.hostUnknown), total: n0(f.member) + n0(f.host) };
}
/** 백업 칸 — Bareos 를 쓰지 않으면 null('해당 없음'). */
export function backupView(b, meta) {
  if (!meta?.used) return null;
  // 원장을 못 읽어도 Bareos 를 쓰지 않는 법인(na 만 있는 칸)은 '해당 없음' 그대로 — 구성원 표와 같은 말(5차 1차 반증 6)
  if (meta.unreadable) return n0(b?.na) && !n0(b?.ok) && !n0(b?.fail) && !n0(b?.none) && !n0(b?.unknown) ? { ok: 0, fail: 0, none: 0, unknown: 0, na: n0(b.na) } : { unknown: true };
  // na = 이 법인에 Bareos Director 매핑이 없는 VM(해당 없음 — 5차 검토 M1). 잡 없음(none)·모름(unknown)과 섞지 않는다.
  return { ok: n0(b?.ok), fail: n0(b?.fail), none: n0(b?.none), unknown: n0(b?.unknown), na: n0(b?.na) };
}
/** 소속 근거 요약 'pin 1 · 폴더 4 · 스캔 2'. */
export function srcSummary(src) {
  return ['pin', 'folder', 'scan', 'tag', 'rule'].filter((k) => n0(src?.[k]) > 0).map((k) => ({ k, label: SRC_SHORT[k], n: n0(src[k]) }));
}
/** 켜짐 칸 — 전원을 모르는 구성원은 분모에서 뺀다. */
export function powerText(p) {
  if (!p) return '—';
  const known = n0(p.on) + n0(p.off);
  return `${n0(p.on)}/${known}${n0(p.unknown) ? ` (+모름 ${n0(p.unknown)})` : ''}`;
}

/**
 * 법인 하나의 폴더 트리(순수) — 명시 폴더 ∪ 서비스 경로 접두. 노드마다 그 아래 서비스 구성원 수의 합(정수라 더해도 된다).
 * @returns {{ path, name, depth, n, services:[...], children:[...] }} 루트
 */
export function folderTreeOf(corp, services) {
  const root = { path: '', name: '', depth: -1, n: 0, services: [], children: [] };
  const nodes = new Map([['', root]]);
  const ensure = (p) => {
    if (nodes.has(p)) return nodes.get(p);
    const i = p.lastIndexOf('\\');
    const parent = ensure(i < 0 ? '' : p.slice(0, i));
    const node = { path: p, name: i < 0 ? p : p.slice(i + 1), depth: parent.depth + 1, n: 0, services: [], children: [] };
    parent.children.push(node); nodes.set(p, node);
    return node;
  };
  for (const f of corp?.folders || []) if (f) ensure(f);
  for (const s of services || []) ensure(s.path || '').services.push(s);
  const sum = (node) => { node.n = node.services.reduce((a, s) => a + n0(s.stat?.n?.total), 0) + node.children.reduce((a, c) => a + sum(c), 0); return node.n; };
  const sort = (node) => { node.children.sort((a, b) => a.name.localeCompare(b.name, 'ko')); node.services.sort((a, b) => a.name.localeCompare(b.name, 'ko')); node.children.forEach(sort); };
  sort(root); sum(root);
  return root;
}

/** 커버리지 행렬 열 — 지역별로 묶은 법인(범위 안). corps: 화면 법인 행, regionOf: id → 지역 이름. */
export function matrixColumns(corps, regionOf = () => '') {
  const groups = new Map();
  for (const c of corps || []) {
    const r = regionOf(c.vcenterId) || '지역 미지정';
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([region, cs]) => ({ region, corps: cs.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })) }));
}

/**
 * 매트릭스 칸 모드(5차 M9) — 구성원 수 · 부품 장애 · CPU(가중) · vCPU 할당. 값은 서버가 준 칸 통계에서 읽기만 한다(판정·집계 복제 아님).
 * 반환 { v: 정렬·색 기준 수(null = 모름), text }.
 */
export const MATRIX_MODES = Object.freeze([['n', '구성원 수'], ['faults', '부품 장애'], ['cpu', 'CPU(가중)'], ['vcpu', 'vCPU 할당']]);
export function matrixCellValue(c, mode, faultsOn) {
  if (!c) return null;
  if (mode === 'faults') {
    if (!faultsOn || c.stale) return { v: null, text: '—' };
    // 못 읽은 장애(faultsUnknown)는 0 이 아니다 — '?' 로 밝힌다(3차 반증 5: 예전에는 0 장애 + 모름 2 가 '0')
    const f = n0(c.faults); const u = n0(c.faultsUnknown);
    return { v: f, unknown: u, text: u ? (f ? `${f}+?` : '?') : String(f) };
  }
  if (mode === 'cpu') { const p = c.stale ? null : numOrNull(c.usage?.cpu); return { v: p, text: p == null ? '—' : `${Math.round(p)}%` }; }
  if (mode === 'vcpu') { const x = numOrNull(c.alloc?.vcpu); return { v: x, text: x == null ? '—' : Math.round(x).toLocaleString() }; }
  return { v: n0(c.n), text: String(n0(c.n)) };
}
/**
 * 지역을 접었을 때 한 칸(5차 M9) — 구성원·장애·vCPU 는 합, CPU 는 Σ사용÷Σ용량(서버가 준 cpuUsed·cpuTotal — 법인 평균을 다시 평균하지 않는다).
 * 못 읽는 법인(stale)은 CPU·장애 합에서 빼고 stale 개수로 밝힌다. 칸이 하나도 없으면 null.
 */
export function regionCell(list, mode, faultsOn) {
  const cs = (list || []).filter(Boolean);
  if (!cs.length) return null;
  const stale = cs.filter((c) => c.stale).length;
  if (mode === 'cpu') {
    let used = 0; let total = 0;
    for (const c of cs) { if (c.stale) continue; const u = numOrNull(c.usage?.cpuUsed); const t = numOrNull(c.usage?.cpuTotal); if (u != null && t != null && t > 0) { used += u; total += t; } }
    const p = total > 0 ? (used / total) * 100 : null;
    return { v: p, text: p == null ? '—' : `${Math.round(p)}%`, stale, corps: cs.length };
  }
  if (mode === 'faults') {
    const live = cs.filter((c) => !c.stale);
    if (!faultsOn || !live.length) return { v: null, text: '—', stale, corps: cs.length };   // 전부 못 읽는 지역은 '0' 이 아니다(3차 반증 5)
    const f = live.reduce((a, c) => a + n0(c.faults), 0); const u = live.reduce((a, c) => a + n0(c.faultsUnknown), 0);
    return { v: f, unknown: u, text: u ? (f ? `${f}+?` : '?') : String(f), stale, corps: cs.length };
  }
  if (mode === 'vcpu') { const x = cs.reduce((a, c) => a + n0(c.alloc?.vcpu), 0); return { v: x, text: Math.round(x).toLocaleString(), stale, corps: cs.length }; }
  const n = cs.reduce((a, c) => a + n0(c.n), 0);
  return { v: n, text: String(n), stale, corps: cs.length };
}

/**
 * 서비스별 현황 표 검색·필터(5차 M8 — 28법인이면 수백 행). q 는 서비스명·폴더·담당자·법인 이름에서 찾는다(대소문자 무시).
 * tier1 = 등급 1만 · noOwner = 담당자 미지정만.
 */
export function filterServices(list, { q = '', tier1 = false, noOwner = false, corpName = (x) => x } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (list || []).filter((s) => {
    if (tier1 && s.tier !== 1) return false;
    if (noOwner && String(s.owner || '').trim()) return false;
    if (!needle) return true;
    return [s.name, s.path, s.owner, corpName(s.corp)].some((x) => String(x || '').toLowerCase().includes(needle));
  });
}

/**
 * 범위 계정 판본의 베어메탈 키는 서버가 'masked-' 토큰으로 준다(5차 R7). 화면에는 토큰 문자열 대신 '(가림)' 으로 보인다 —
 * 토큰은 쓰기 연산에 그대로 돌려보내는 값이라 사람이 읽을 뜻이 없다(다음 단계 실화면 검증에서 찾음).
 */
export const isMaskedKey = (k) => typeof k === 'string' && k.startsWith('masked-');
export const keyText = (k) => (isMaskedKey(k) ? '(가림)' : String(k ?? ''));
export const MASKED_KEY_TITLE = '범위가 지정된 계정에는 베어메탈 식별 키(서비스태그)를 가린 표지로 보입니다 — 고정·정리는 그대로 됩니다';

/** 서버 오류 → 사람이 읽을 문장. */
export function opErrorText(e) {
  const m = String(e?.message || e || '').trim();
  return m || '요청을 처리하지 못했습니다.';
}

/** 미지정 묶음에서 누를 수 있는 연결 동작(순수 — 버튼 문구와 서버 연산 이름). */
export function groupActions(g) {
  if (g.kind === 'folder') return { link: '이 폴더를 연결', create: true, createName: g.value === '/' ? '루트' : String(g.value).slice(String(g.value).lastIndexOf('/') + 1), op: 'rule.add', createKind: 'folder' };
  if (g.kind === 'tag') return { link: '이 태그 값을 연결', create: true, createName: g.value, op: 'alias.add', aliasKind: 'tag', createKind: 'tag' };
  if (g.kind === 'scan') return { link: `라벨 ‘${g.value}’ 을(를) 연결`, create: true, createName: g.value, op: 'alias.add', aliasKind: 'scan', createKind: 'scan' };
  if (g.kind === 'entry') return { link: '이 엔트리에 서비스 라벨 붙이기', create: false, op: 'scan.label' };
  if (g.kind === 'placement' || g.kind === 'manual') return { pinOnly: true };
  return { none: true };
}

/** '검토 필요' 수와 부제(5차 R17 — 수에 들어가는 것을 부제에 전부 적는다). */
export function reviewSummary(q = {}) {
  const parts = [['드리프트', q.drift], ['법인 불일치', q.mismatch], ['유령', q.ghosts], ['태그 모호', q.tagAmbiguous], ['규칙 겹침', q.ruleOverlap], ['없는 서비스 고정', q.dangling]].filter(([, n]) => n0(n) > 0);
  const n = parts.reduce((a, [, x]) => a + n0(x), 0);
  const meta = `${parts.length ? parts.map(([l, x]) => `${l} ${n0(x)}`).join(' · ') : '드리프트·불일치·유령·모호 없음'}${n0(q.ghostsHeld) ? ` (판정 보류 ${n0(q.ghostsHeld)} — 수에 넣지 않음)` : ''}`;
  return { n, meta };
}

/**
 * 쓰기 결과 문구(순수 — 6차 7). 서버가 200 을 줘도 **바뀐 것이 0 건**일 수 있다(범위 계정의 가린 키가 재시작으로 바뀌었거나 다른 법인·사라진 구성원).
 * 그때 '고정했습니다' 를 띄우지 않는다. @returns {{ok:boolean, warn?:boolean, text:string}}
 */
export function writeResultNote(okText, result) {
  const r = result && typeof result === 'object' ? result : {};
  const skip = n0(r.skipped);
  const why = '다른 법인이거나 사라진 구성원, 또는 화면이 오래돼 키가 맞지 않습니다 — 새로 고쳐 다시 고르십시오';
  if (typeof r.changed === 'number') {
    if (r.changed === 0) return { ok: false, warn: true, text: `바뀐 것이 없습니다${skip ? ` — ${skip}건을 건너뛰었습니다(${why})` : ''}.` };
    if (skip) return { ok: true, warn: true, text: `${okText} 단, ${skip}건은 건너뛰었습니다(${why}).` };
  }
  if (typeof r.moved === 'number') {
    const c = n0(r.conflicts); const o = n0(r.otherCorp);
    const why = [c ? `서비스가 다른 ${c}건(충돌 행에서 고르십시오)` : '', o ? `새 키가 다른 법인에 고정된 ${o}건(법인 불일치 — 검토 탭)` : ''].filter(Boolean).join(' · ');
    if (!r.moved && !n0(r.dropped)) return { ok: false, warn: true, text: why ? `옮긴 것이 없습니다 — ${why}은 옮기지 않았습니다.` : '옮길 옛 키 고정이 없습니다.' };
    if (why) return { ok: true, warn: true, text: `${okText} 단, ${why}은 옮기지 않았습니다.` };
  }
  if (typeof r.removed === 'number' && r.removed === 0) return { ok: false, warn: true, text: `지운 것이 없습니다${skip ? ` — 미리 본 뒤 유령이 아니게 된 ${skip}건을 건너뛰었습니다` : ''}.` };
  return { ok: true, text: okText || '저장했습니다.' };
}

/** CSV 파일 이름. */
export const csvNameOf = (d = new Date()) => `svc-inventory-${dayStamp(d)}.csv`;   // 사용자 로컬 날짜(UTC 날짜 금지 — v2.582 BUG-3)
