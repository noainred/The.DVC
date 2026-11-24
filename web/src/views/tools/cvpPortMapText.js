/**
 * cvpPortMapText.js — CVP › 포트 구성도(v3.37) 화면용 순수 함수 · 문구.
 *  판정(분류 · 연결 근거 · 배치표)은 서버 cvp/portmap.js 하나다 — 이 파일은 **그 결과를 그리는 법**만 정한다(색 · 칸 묶기 · 문장).
 *  못 읽은 값은 0 · 정상 · 예비로 쓰지 않는다: 분류 'unknown' 은 '확인 불가', 근거의 lldpUnread 는 'LLDP 못 읽음'.
 */
import { speedLabel } from './cvpIntfText.js';
import { numOrNull } from '../../numOrNull.js';

const GREEN = { background: '#16432a', border: '1px solid #22c55e', color: '#eafff1' };
const AMBER = { background: '#4a3208', border: '1px solid #f59e0b', color: '#fff3d6' };
const DASH = { background: 'var(--panel-deep, #0f1626)', border: '1px dashed #5d6b85', color: '#a9b6cc' };
const BLUE = { background: '#172f5c', border: '1px solid #60a5fa', color: '#e6f0ff' };

/** 분류 칸. order 는 범례 · 막대 순서. bar = 막대 색. */
export const SUB_DEFS = Object.freeze({
  use: { label: '사용 중', paint: GREEN, bar: '#22c55e' },
  check: { label: '확인 필요', paint: AMBER, bar: '#f59e0b', hint: '설명은 있는데 링크 없음' },
  spareX: { label: '예비 · GBIC 꽂힘', paint: BLUE, bar: '#60a5fa', hint: '케이블만 꽂으면 씀' },
  spareE: { label: '예비 · 빈 케이지', paint: { background: 'var(--panel-deep, #0f1626)', border: '1px dashed #60a5fa', color: '#bfdbfe' }, bar: '#1e40af', hint: 'GBIC 이 있어야 씀' },
  spareC: { label: '예비 · 구리 포트', paint: BLUE, bar: '#3b82f6', hint: 'RJ45 — 케이블만' },
  spareU: { label: '예비 · GBIC 모름', paint: { background: '#13233f', border: '1px dashed #93c5fd', color: '#dbeafe' }, bar: '#334e7a', hint: '트랜시버 목록에 없음' },
  off: { label: '관리상 꺼짐', paint: { background: '#2a3446', border: '1px solid #64748b', color: '#cbd5e1', textDecoration: 'line-through' }, bar: '#64748b', hint: 'shutdown — 예비에 넣지 않음' },
  unknown: { label: '확인 불가', paint: { background: 'repeating-linear-gradient(135deg, #1a2236 0 4px, #243049 4px 8px)', border: '1px solid #3b4a68', color: '#cbd5e1' }, bar: '#3b4a68', hint: '상태나 설명을 못 읽음 — 예비로 세지 않음' },
});
export const SUB_ORDER = Object.freeze(['use', 'check', 'spareX', 'spareE', 'spareC', 'spareU', 'off', 'unknown']);
export const SPARE_KEYS = Object.freeze(['spareX', 'spareE', 'spareC', 'spareU']);

export const EV_DEFS = Object.freeze({
  match: { label: '설명·LLDP 일치', short: '일치', paint: GREEN, color: '#4ade80' },
  lldp: { label: 'LLDP 만(설명 없음)', short: 'LLDP 만', paint: { background: '#0c3d47', border: '1px solid #22d3ee', color: '#e3fbff' }, color: '#22d3ee' },
  desc: { label: '설명만(LLDP 이웃 없음)', short: '설명만', paint: { background: '#35205c', border: '1px solid #c084fc', color: '#f1e6ff' }, color: '#c4b5fd' },
  mismatch: { label: '설명·LLDP 불일치', short: '불일치', paint: { background: '#5a1616', border: '1px solid #f87171', color: '#ffe9e9' }, color: '#fca5a5' },
  none: { label: '근거 없음(미확인 장비)', short: '근거 없음', paint: AMBER, color: '#fbbf24' },
  nolink: { label: '링크 없음', short: '—', paint: DASH, color: 'var(--text-dim)' },
});
export const EV_ORDER = Object.freeze(['match', 'lldp', 'desc', 'mismatch', 'none', 'nolink']);
/** 근거 이름 — LLDP 를 못 읽은 장비의 '설명만' 은 이웃이 없다는 뜻이 아니다. */
export function evLabel(p, short = false) {
  if (!p) return '—';
  if (p.ev === 'desc' && p.lldpUnread) return short ? '설명만(LLDP 못 읽음)' : '설명만(LLDP 를 읽지 못함)';
  if (p.ev === 'none' && p.lldpUnread) return short ? '근거 없음(LLDP 못 읽음)' : '근거 없음(LLDP 를 읽지 못함)';
  const d = EV_DEFS[p.ev] || EV_DEFS.nolink;
  return short ? d.short : d.label;
}

export const UTIL_DEFS = Object.freeze({
  u0: { label: '20% 미만', paint: { background: '#12283f', border: '1px solid #2f5d8c', color: '#d8e9fb' } },
  u20: { label: '20~50%', paint: { background: '#1d4ed8', border: '1px solid #93c5fd', color: '#ffffff' } },
  u50: { label: '50~80%', paint: { background: '#b45309', border: '1px solid #fbbf24', color: '#ffffff' } },
  u80: { label: '80% 이상', paint: { background: '#b91c1c', border: '1px solid #fca5a5', color: '#ffffff' } },
  na: { label: '측정 없음', paint: DASH },
});
export const UTIL_ORDER = Object.freeze(['u0', 'u20', 'u50', 'u80', 'na']);
const num = numOrNull;   // 못 읽은 값(null · '' · 숫자 아님)은 null — 공용 판정 하나(사본 금지 스윕 audit2617)
/** 사용률(수신 · 송신 중 큰 쪽) — 링크가 없거나 못 읽으면 null(0% 가 아니다). */
export function utilOf(p) {
  if (!p || p.oper !== 'up') return null;
  const a = num(p.inUtil); const b = num(p.outUtil);
  if (a == null && b == null) return null;
  return Math.max(a ?? -1, b ?? -1);
}
export function utilBand(p) {
  const u = utilOf(p);
  if (u == null) return 'na';
  return u >= 80 ? 'u80' : u >= 50 ? 'u50' : u >= 20 ? 'u20' : 'u0';
}

/** 색 기준별 칸 색. mode: 'use' | 'evidence' | 'util'. */
export function paintOf(p, mode = 'use') {
  if (!p) return { ...DASH, opacity: 0.5 };
  if (mode === 'evidence') return (EV_DEFS[p.ev] || EV_DEFS.nolink).paint;
  if (mode === 'util') return UTIL_DEFS[utilBand(p)].paint;
  return (SUB_DEFS[p.sub] || SUB_DEFS.unknown).paint;
}
/** '사용 · 예비' 색 기준에서 모서리 점 — 근거를 확인할 것(불일치 · 근거 없음 · LLDP 만). 없으면 null. */
export function flagOf(p) {
  if (!p || p.sub !== 'use') return null;
  if (p.ev === 'mismatch') return '#f87171';
  if (p.ev === 'none') return '#fbbf24';
  if (p.ev === 'lldp') return '#22d3ee';
  return null;
}

const SUB_RANK = Object.freeze({ use: 0, check: 1, unknown: 2, off: 3, spareX: 4, spareC: 5, spareE: 6, spareU: 7 });
const EV_RANK = Object.freeze({ mismatch: 0, none: 1, desc: 2, lldp: 3, match: 4, nolink: 5 });
/**
 * 한 칸(케이지)의 대표 포트 — 브레이크아웃(Ethernet49/1~/4)은 한 칸에 여럿이다. 쓰는 레인이 하나라도 있으면 사용,
 *   근거는 가장 나쁜 것, 사용률은 가장 높은 것. 포트가 없으면 null(수집 목록에 없는 칸).
 */
export function cageRep(ports) {
  const list = (Array.isArray(ports) ? ports : []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const bySub = [...list].sort((a, b) => (SUB_RANK[a.sub] ?? 9) - (SUB_RANK[b.sub] ?? 9))[0];
  const byEv = [...list].sort((a, b) => (EV_RANK[a.ev] ?? 9) - (EV_RANK[b.ev] ?? 9))[0];
  const util = list.reduce((m, p) => { const u = utilOf(p); return u != null && (m == null || u > m.u) ? { u, p } : m; }, null);
  return { ...bySub, ev: byEv.ev, lldpUnread: byEv.lldpUnread, inUtil: util ? util.p.inUtil : bySub.inUtil, outUtil: util ? util.p.outUtil : bySub.outUtil, lanes: list.length };
}

/** 배치표 → 그릴 칸 목록. fixed: groups[].cells[] · modular: slots[].groups[].cells[]. cell = { cage, label, ports, rep, name }. */
export function layoutCells(faceplate, ports) {
  const list = Array.isArray(ports) ? ports : [];
  const fp = faceplate || {};
  const key = (slot, cage) => `${slot ?? ''}:${cage}`;
  const by = new Map();
  for (const p of list) {
    if (!p || p.mgmt || p.cage == null) continue;
    const k = key(fp.modular ? p.slot : null, p.cage);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p);
  }
  const cellsOf = (slot, cages) => cages.map((cage) => {
    const ps = by.get(key(slot, cage)) || [];
    const rep = cageRep(ps);
    return { cage, label: String(cage), ports: ps, rep, name: ps.length === 1 ? ps[0].name : ps.length ? `${ps[0].name.replace(/\/\d+$/, '')}(${ps.length}개)` : null };
  });
  if (fp.modular) {
    return { slots: (fp.slots || []).map((s) => ({ slot: s.slot, label: s.label, groups: (s.groups || []).map((g) => ({ label: g.label, form: g.form, cells: cellsOf(s.slot, g.cages || []) })) })) };
  }
  return { groups: (fp.groups || []).map((g) => ({ label: g.label, form: g.form, cells: cellsOf(null, g.cages || []) })) };
}
export const mgmtPorts = (ports) => (Array.isArray(ports) ? ports : []).filter((p) => p && p.mgmt);

/** 개수 → 한 줄 요약. counts 가 없으면 null. */
export function headline(c) {
  if (!c) return null;
  const pct = (n) => (c.total ? `${Math.round((n / c.total) * 100)}%` : '—');
  return `${c.total}포트 중 ${c.use} 사용(${pct(c.use)}) · 예비 ${c.spare}(${pct(c.spare)})${c.unknown ? ` · 확인 불가 ${c.unknown}` : ''}`;
}
/** 막대 조각 [{key, n, color, label}] — 0 은 뺀다. */
export function barSegs(c) {
  if (!c) return [];
  return SUB_ORDER.map((k) => ({ key: k, n: Number(c[k]) || 0, color: SUB_DEFS[k].bar, label: SUB_DEFS[k].label })).filter((s) => s.n > 0);
}
/** 속도 줄 문구. */
export function speedRowText(c) {
  if (!c) return '';
  const sp = SPARE_KEYS.filter((k) => c[k]).map((k) => `${SUB_DEFS[k].label.replace('예비 · ', '')} ${c[k]}`);
  return [`사용 ${c.use}`, `예비 ${c.spare}${sp.length ? `(${sp.join(' · ')})` : ''}`, c.check ? `확인 필요 ${c.check}` : null, c.off ? `꺼짐 ${c.off}` : null, c.unknown ? `확인 불가 ${c.unknown}` : null].filter(Boolean).join(' · ');
}
export const speedName = (s) => (s == null ? '속도 모름' : s.replace(/G$/, ' Gbps').replace(/M$/, ' Mbps'));

/** 판정 문장(선택한 포트). */
export function verdictText(p) {
  if (!p) return '';
  if (p.sub === 'use') {
    if (p.ev === 'match') return '포트 설명과 LLDP 이웃이 같은 장비를 가리킵니다.';
    if (p.ev === 'mismatch') return `설명이 가리키는 장비와 LLDP 이웃(${p.device || '—'})이 다릅니다 — 지금 붙은 상대는 LLDP 쪽이고, 설명이 낡았을 수 있습니다.`;
    if (p.ev === 'lldp') return '설명이 비어 있어 LLDP 이웃을 연결 장비로 표시합니다. 설명을 채워 두면 링크가 끊겨도 어디에 쓰던 포트인지 남습니다.';
    if (p.ev === 'desc') return p.lldpUnread ? '이 장비의 LLDP 이웃을 읽지 못해 설명에 적힌 이름을 표시합니다. 실제 연결은 확인하지 못했습니다.' : 'LLDP 이웃이 없어(상대가 LLDP 를 보내지 않음) 설명에 적힌 이름을 표시합니다. 실제 연결은 확인하지 못했습니다.';
    return p.lldpUnread ? '설명이 없고 LLDP 이웃도 읽지 못했습니다 — 무엇이 꽂혀 있는지 이 정보로는 알 수 없습니다.' : '링크는 올라와 있는데 설명도 LLDP 이웃도 없습니다 — 무엇이 꽂혀 있는지 이 정보로는 알 수 없습니다.';
  }
  const T = {
    check: '설명은 있는데 링크가 없습니다 — 연결이 끊겼거나, 연결 예정으로 잡아 둔 포트입니다.',
    spareX: '링크 · 설명이 없고 GBIC 이 꽂혀 있습니다 — 케이블만 꽂으면 쓸 수 있는 예비입니다.',
    spareE: '링크 · 설명 · GBIC 이 모두 없습니다 — GBIC 을 꽂아야 쓸 수 있는 예비입니다.',
    spareC: '링크 · 설명이 없는 구리(RJ45) 포트입니다 — 케이블만 꽂으면 씁니다.',
    spareU: '링크 · 설명이 없는 예비입니다. 트랜시버 목록에 이 포트가 없어(또는 목록을 못 읽어) GBIC 이 꽂혔는지는 모릅니다.',
    off: '관리상 꺼진(shutdown) 포트입니다 — 예비에 넣지 않고 따로 셉니다.',
    unknown: '링크 상태나 설명을 읽지 못해 사용 · 예비를 판정하지 않았습니다(예비로 세지 않습니다).',
  };
  return T[p.sub] || T.unknown;
}

/** 마지막 링크 기록 문구. at: 그날 시작 ms · since: 기록 시작 날 ms. */
export function lastLinkText(p, since, now = Date.now()) {
  if (!p) return '—';
  if (p.oper === 'up') return '지금 연결됨';
  if (p.lastLinkAt == null) return since == null ? '기록 없음' : `기록 시작(${dayText(since)}) 뒤 없음`;
  const days = Math.max(0, Math.floor((now - p.lastLinkAt) / 86_400_000));
  return days === 0 ? '오늘' : `${days}일 전(${dayText(p.lastLinkAt)})`;
}
function dayText(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—';
}

/** 트랜시버 칸 문구. */
export function xcvrText(p) {
  if (!p) return '—';
  if (p.copper) return '구리(RJ45)';
  if (p.xcvr === undefined) return '목록 못 읽음';
  if (p.xcvr === null) return '목록에 없음';
  if (!p.xcvr.present) return '빈 케이지';
  return p.xcvr.type || '꽂힘(종류 모름)';
}
export const utilText = (p) => {
  if (!p || p.oper !== 'up') return '—';
  const a = num(p.inUtil); const b = num(p.outUtil);
  if (a == null && b == null) return '측정 없음';
  const f = (v) => (v == null ? '—' : `${Math.round(v)}%`);
  return `${f(a)} / ${f(b)}`;
};
export const descText = (d) => (d == null ? '(못 읽음)' : d === '' ? '(설명 없음)' : d);
export const lldpText = (p) => {
  if (!p) return '—';
  if (p.lldp) return [p.lldp.sysName, p.lldp.portId].filter(Boolean).join(' · ') || '—';
  if (p.lldpUnread) return '(못 읽음)';
  return p.oper === 'up' ? '이웃 없음' : '—(링크 없음)';
};
export const speedText = (p) => speedLabel(p && p.speedBps) || '속도 모름';

/** 표 필터 칩. */
export const FILTERS = Object.freeze([
  ['all', '전체', () => true],
  ['use', '사용 중', (p) => p.sub === 'use'],
  ['spare', '예비', (p) => SPARE_KEYS.includes(p.sub)],
  ['check', '확인 필요', (p) => p.sub === 'check'],
  ['off', '꺼짐', (p) => p.sub === 'off'],
  ['unknown', '확인 불가', (p) => p.sub === 'unknown'],
  ['ev', '근거 확인할 것', (p) => flagOf(p) != null],
]);
export function filterPorts(ports, key) {
  const f = (FILTERS.find((x) => x[0] === key) || FILTERS[0])[2];
  return (Array.isArray(ports) ? ports : []).filter((p) => p && (key === 'all' || !p.mgmt) && f(p));
}
export const filterCount = (ports, key) => filterPorts(ports, key).filter((p) => !p.mgmt).length;

/* ── 전 스위치 여유 ───────────────────────────────────────────────────────────────────────────────────── */
/** 예비가 적은 순(못 읽은 장비는 맨 뒤). */
export function fleetRows(devices, { corp = '', lowOnly = false, lowMax = null } = {}) {
  const list = (Array.isArray(devices) ? devices : []).filter((d) => d && (!corp || (d.corpName || '') === corp));
  const low = (d) => lowMax != null && d.counts && d.counts.spare <= lowMax;
  return list.filter((d) => !lowOnly || low(d))
    .map((d) => ({ ...d, low: low(d) }))
    .sort((a, b) => (a.counts == null) - (b.counts == null) || (a.counts ? a.counts.spare : 0) - (b.counts ? b.counts.spare : 0) || String(a.hostname).localeCompare(String(b.hostname)));
}
/** 여러 장비 합(못 읽은 장비는 빼고 따로 센다). */
export function fleetTotals(devices) {
  const t = { devices: 0, read: 0, unread: 0, total: 0, use: 0, spare: 0, check: 0, off: 0, unknown: 0, spareX: 0, spareE: 0, spareC: 0, spareU: 0 };
  for (const d of Array.isArray(devices) ? devices : []) {
    t.devices++;
    if (!d || !d.counts) { t.unread++; continue; }
    t.read++;
    for (const k of ['total', 'use', 'spare', 'check', 'off', 'unknown', 'spareX', 'spareE', 'spareC', 'spareU']) t[k] += Number(d.counts[k]) || 0;
  }
  return t;
}
export const corpChips = (devices) => {
  const m = new Map();
  for (const d of Array.isArray(devices) ? devices : []) { const k = (d && d.corpName) || ''; m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => ({ name, label: name || '법인 미지정', n }));
};
export const PORTMAP_NOTE = '구성도는 **모델별 실물 배치표**(사진으로 확인한 모델)로 그리고, 배치표가 없는 모델은 포트 번호 규칙(12개씩 · 홀수 위 · 짝수 아래)으로 그립니다. 연결 장비는 **포트 설명(주석)과 LLDP 이웃**으로 판단합니다 — LLDP 는 부품 주기에 읽는 값이고 경로는 실장비로 확인하지 못한 추정입니다. 못 읽은 값은 예비로 세지 않고 ‘확인 불가’ 로 따로 셉니다.';
