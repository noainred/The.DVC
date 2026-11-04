/**
 * svcInventoryText.js — '서비스 인벤토리'(v2.885) 화면 문구·표시 판정(순수). **소속 판정은 서버(servicemap/resolve.js) 하나** —
 *   여기에는 판정을 복제하지 않고, 서버가 준 코드(src·reason)를 문장으로 바꾸고 트리·행렬 모양만 만든다.
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다). 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';

export const SRC_LABEL = Object.freeze({ pin: '고정', folder: 'vCenter 폴더 규칙', scan: '스캔 엔트리', tag: 'vSphere 태그', rule: '이름 규칙', none: '미지정' });
export const SRC_SHORT = Object.freeze({ pin: '고정', folder: '폴더', scan: '스캔', tag: '태그', rule: '규칙' });
export const SRC_BADGE = Object.freeze({ pin: 'purple', folder: 'blue', scan: 'teal', tag: 'blue', rule: 'gray', none: 'amber' });
export const REASON_TEXT = Object.freeze({
  'no-corp': '법인 귀속 없음 — 통합 서버 인벤토리에서 법인을 먼저 정합니다',
  'no-folder-rule': 'vCenter 폴더 규칙 없음',
  'placement-unknown': 'vSphere 위치를 따라가지 못함(vApp 안 VM 등) — 고정으로만 넣을 수 있습니다',
  'tags-unchecked': '태그를 읽지 못함(확인 안 됨) · 폴더 규칙 없음',
  'tag-unmapped': '태그 값에 맞는 서비스 없음',
  'no-scan-entry': '스캔 엔트리 없음(수동 등록·엣지 구버전)',
  'scan-label-empty': '스캔 엔트리 라벨이 비어 있음',
  'scan-label-unmapped': '스캔 라벨에 맞는 서비스 없음',
});
export const GROUP_TITLE = Object.freeze({
  folder: (g) => (g.value === '/' ? 'vCenter 루트(폴더 없음)' : `vCenter 폴더 ${g.value}`),
  tag: (g) => `태그 값 ‘${g.value}’ — 서비스 없음`,
  entry: (g) => `스캔 엔트리 ${g.entry?.range || `#${String(g.value).slice(0, 8)}`} — 라벨 없음`,
  scan: (g) => `스캔 라벨 ‘${g.value}’ — 서비스 없음`,
  placement: () => 'vSphere 위치 모름(vApp 안 VM 등)',
  manual: () => '묶을 출처 없음(수동 등록 iDRAC · 엣지 구버전)',
  nocorp: () => '법인 귀속 없음',
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
  if (meta.unreadable) return { unknown: true };
  return { ok: n0(b?.ok), fail: n0(b?.fail), none: n0(b?.none), unknown: n0(b?.unknown) };
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

/** CSV 파일 이름. */
export const csvNameOf = (d = new Date()) => `svc-inventory-${d.toISOString().slice(0, 10)}.csv`;
