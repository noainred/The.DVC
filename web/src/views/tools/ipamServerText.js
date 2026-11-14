// ipamServerText.js — IP 관리 '서버 보기' · '호스트명 대조' · '스캔 대역 추가' 의 표시 문구(순수 · v3.6.0 재설계 묶음 다).
// 판정은 서버가 한다(ipam/serverView.js — nameCheck · verdict · odd). 여기는 그 값을 글자 · 색으로 바꾸고, 담기 목록을 묶기만 한다.

/** 서버 보기 — 주소의 역할. */
export const ROLE_LABEL = Object.freeze({ idrac: 'iDRAC', vmk: 'ESXi', os: 'OS', vm: 'VM' });
/** 서버 종류. */
export const KIND_LABEL = Object.freeze({ esxi: 'ESXi 호스트', bm: '물리 서버(OS 직접 설치)', vm: 'VM' });

/** 주소 한 줄의 '이름 확인'(서버 nameCheck) → 글자 · 색. */
export const NAME_CHECK = Object.freeze({
  same: { label: '일치', tone: 'green', title: '설정한 이름과 역DNS 이름의 첫 마디가 같습니다' },
  diff: { label: '불일치', tone: 'amber', title: '설정한 이름과 역DNS 이름이 다릅니다' },
  nodns: { label: '역DNS 없음', tone: 'gray', title: '스캔은 했지만 DNS 가 이 주소의 이름을 돌려주지 않았습니다' },
  unscanned: { label: '확인 안 됨', tone: 'gray', title: '스캔 결과가 없습니다(스캔 대역 밖이거나 범위 계정에는 스캔 이름이 보이지 않습니다)' },
  noname: { label: '—', tone: 'gray', title: '견줄 이름이 없습니다' },
});
export function nameCheckOf(x) { return NAME_CHECK[x?.nameCheck] || NAME_CHECK.noname; }

/** 역DNS 정방향 확인(v3.2.0 dnsFwd) 한 줄 — 어긋난 것만 말한다. */
export function dnsFwdText(x) {
  if (x?.dnsFwd === 'other') return `정방향 조회가 다른 IP(${(x.dnsFwdAddrs || []).slice(0, 2).join(', ') || '—'})`;
  if (x?.dnsFwd === 'none') return '정방향 조회 결과 없음';
  return '';
}

/** 호스트명 대조 — 출처 칸 이름(표 머리 순서). */
export const NAME_SOURCES = Object.freeze([['idrac', 'iDRAC'], ['vcenter', 'vCenter'], ['os', 'OS'], ['dns', 'DNS']]);
export const VERDICT = Object.freeze({
  same: { label: '모두 같음', tone: 'green' },
  diff: { label: '서로 다름', tone: 'amber' },
  'cmp-none': { label: '비교할 수 없음', tone: 'gray' },
});
/** 판정 배지 글자 — 못 읽은 곳이 있으면 '읽은 n곳은 같음'. */
export function verdictText(r) {
  if (r?.verdict === 'same' && r.partial) return `읽은 ${r.readN}곳은 같음`;
  return VERDICT[r?.verdict]?.label || '—';
}
/** 이름 칸 하나의 글자 — 값이 없으면 상태(해당 없음 · 못 읽음 · 가림)를 말한다. 주소로 등록된 이름은 값 + '(주소)'. */
export function cellText(c) {
  if (!c) return '—';
  if (c.state === 'ok') return c.v || '—';
  if (c.state === 'addr') return `${c.v || ''} (주소)`;
  if (c.state === 'na') return '해당 없음';
  if (c.state === 'hidden') return '가림';
  return '못 읽음';
}
/** 요약 칸 '어디가 가장 많이 어긋나나' — 표시 수가 가장 큰 출처(없으면 null). */
export function topOdd(summary) {
  const by = summary?.oddBy || {};
  let best = null;
  for (const [k, l] of NAME_SOURCES) if ((by[k] || 0) > 0 && (!best || by[k] > best.n)) best = { k, label: l, n: by[k] };
  return best;
}

/* ── 스캔 대역 추가(시안 ⑪) ─────────────────────────────────────────── */

/** 후보 줄 상태(vcRangeImportText.classifySubnets 의 kind) → 글자. 담을 수 있는 것은 new · partial · other. */
export const ADD_STATE = Object.freeze({
  new: { label: '사용 중인 IP 대역', tone: 'green' },
  covered: { label: '이미 스캔 중', tone: 'gray' },
  partial: { label: '일부만 스캔 중', tone: 'amber' },
  other: { label: '다른 에이전트와 겹침', tone: 'amber' },
  invalid: { label: '형식 오류', tone: 'red' },
});
export const canPick = (r) => !!r && r.kind !== 'covered' && r.kind !== 'invalid';
/** 공인 묶음 — 공인 · 공인/사설 섞임. 분류를 모르면(설정을 못 읽음) 사설 묶음에 두지 않고 따로 센다. */
export const groupOf = (r) => (r?.cls === 'public' || r?.cls === 'mixed' ? 'public' : r?.cls === 'private' ? 'private' : 'unknown');

/** 출처 조각 — VM n · ESXi n · iDRAC n(0 은 싣지 않는다). */
export function srcParts(r) {
  const out = [];
  if (r?.vmIps) out.push(`VM ${r.vmIps}`);
  if (r?.esxiIps) out.push(`ESXi ${r.esxiIps}`);
  if (r?.idracIps) out.push(`iDRAC ${r.idracIps}`);
  if (!out.length && r?.ips) out.push(`주소 ${r.ips}`);
  return out;
}

/** 찾기(대역 · 용도 · vCenter 이름) 후 묶음별 목록. */
export function groupCandidates(rows, q = '') {
  const t = String(q || '').trim().toLowerCase();
  const hit = (r) => !t || String(r.cidr).includes(t) || String(r.purpose || '').toLowerCase().includes(t) || (r.vcenters || []).some((v) => String(v).toLowerCase().includes(t));
  const g = { private: [], public: [], unknown: [] };
  for (const r of rows || []) if (hit(r)) g[groupOf(r)].push(r);
  return g;
}

/** 담은 대역 요약 — 묶음별 개수 · 주소 수(/24 하나 = 254). 담을 수 없는 줄은 세지 않는다. */
export function basketOf(rows, picked) {
  const sel = (rows || []).filter((r) => picked?.has?.(r.cidr) && canPick(r));
  const pri = sel.filter((r) => groupOf(r) !== 'public');
  const pub = sel.filter((r) => groupOf(r) === 'public');
  return { all: sel, pri, pub, addrs: sel.length * 254, overlap: sel.filter((r) => r.kind !== 'new').length };
}

/** '모두 담기' — 그 묶음의 보이는 줄 중 새 대역(new)만. 겹치는 줄은 하나씩 눌러 담는다(실수로 다른 에이전트 대역을 통째로 담지 않게). */
export function pickAllNew(picked, list) {
  const x = new Set(picked || []);
  for (const r of list || []) if (r.kind === 'new') x.add(r.cidr);
  return x;
}
