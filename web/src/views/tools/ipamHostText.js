// ipamHostText.js — IP 대장 '호스트명' 칸 · IP 상세 창 · 스캔 설정의 문구(순수 · v2.991, 시안 docs/design/ip-scan-hostname).
// 판정(표시 이름 · 우선순위 · 이름 다름 · 지난 스캔 무응답)은 서버 `ipam/hostNames.js` 가 하고 행 · 상세에 실어 보낸다 —
// 여기는 라벨 · 요약 · 방식별 줄 문구만 만든다(웹 vitest 가 고정). 값이 없으면 '—'(0 으로 세지 않는다).
import { numOrNull } from '../../numOrNull.js';

/** 출처 라벨 · 배지 색(서버 netNameSrc 값과 1:1). */
export const NAME_SRC = Object.freeze({
  manual: { label: '수동', tone: 'teal', title: '관리상태 편집에서 직접 넣은 이름' },
  dns: { label: '역DNS', tone: 'blue', title: 'DNS 서버의 PTR 레코드' },
  mdns: { label: 'mDNS', tone: 'green', title: '같은 네트워크 구간의 장비가 UDP 5353 으로 답한 이름' },
  netbios: { label: 'NetBIOS', tone: 'purple', title: 'Windows · Samba 가 UDP 137 로 답한 컴퓨터 이름' },
});
/** 표시 우선순위 순(서버 NAME_METHODS 와 같은 순서). */
export const NAME_METHODS = Object.freeze(['dns', 'mdns', 'netbios']);
const METHOD_DESC = Object.freeze({ dns: 'PTR 조회', mdns: 'UDP 5353', netbios: 'UDP 137' });

/** 스캔으로만 확인한 IP 행(ownerType 'scanned')의 호스트명 요약 — 목록 위 한 줄 · '호스트명 없음' 칩. */
export function scanNameSummary(rows) {
  const s = { total: 0, named: 0, none: 0, bySrc: { manual: 0, dns: 0, mdns: 0, netbios: 0 } };
  for (const r of rows || []) {
    if (r?.ownerType !== 'scanned') continue;
    s.total += 1;
    if (r.netName) { s.named += 1; if (s.bySrc[r.netNameSrc] != null) s.bySrc[r.netNameSrc] += 1; } else s.none += 1;
  }
  return s;
}
/** 요약의 배지 조각 — 0 인 출처는 뺀다. 순서: 역DNS · mDNS · NetBIOS · 수동 · 없음. */
export function scanNameSummaryParts(sum) {
  if (!sum) return [];
  const out = [];
  for (const k of [...NAME_METHODS, 'manual']) {
    const n = sum.bySrc?.[k] || 0;
    if (n > 0) out.push({ key: k, label: `${NAME_SRC[k].label} ${n.toLocaleString()}`, tone: NAME_SRC[k].tone });
  }
  if (sum.none > 0) out.push({ key: 'none', label: `없음 ${sum.none.toLocaleString()}`, tone: 'gray' });
  return out;
}

/** '이름 다름' 배지의 설명(서버 nameAlt — 표시 이름 밖의 다른 이름들). */
export function mismatchTitle(alt) {
  const list = (Array.isArray(alt) ? alt : []).filter((a) => a && a.v).map((a) => `${NAME_SRC[a.src]?.label || a.src}: ${a.v}`);
  return list.length
    ? `방식마다 다른 이름을 답했습니다 — ${list.join(' · ')}. 어느 쪽이 맞는지는 포탈이 판정하지 않습니다. IP 를 누르면 방식별 결과가 보입니다.`
    : '방식마다 다른 이름을 답했습니다. IP 를 누르면 방식별 결과가 보입니다.';
}

/**
 * IP 상세 창의 방식별 줄 — scan = 서버 `scanDetailOf`(/tools/ipam/history 의 scan). 상태:
 *   found(답함) · stale(지난 스캔에서 답하지 않음 — 이름은 아직 둔다) · none(물었는데 답 없음) · skipped(묻지 않음) · unknown(옛 기록 — 모름).
 */
export function methodRows(scan) {
  if (!scan || typeof scan !== 'object') return [];
  const tried = Array.isArray(scan.tried) ? scan.tried : null;
  return NAME_METHODS.map((k) => {
    const e = scan.names && typeof scan.names === 'object' ? scan.names[k] : null;
    const v = e && typeof e.v === 'string' ? e.v : '';
    const miss = numOrNull(e?.miss) ?? 0;
    const asked = tried ? tried.includes(k) : null;
    const state = v ? (miss > 0 ? 'stale' : 'found') : asked === true ? 'none' : asked === false ? 'skipped' : 'unknown';
    return { key: k, label: NAME_SRC[k].label, tone: NAME_SRC[k].tone, desc: METHOD_DESC[k], state, value: v, at: numOrNull(e?.at), miss };
  });
}
/** 방식별 줄의 상태 문구(답한 줄은 ''). */
export function methodStateText(m, missMax = null) {
  if (!m) return '';
  if (m.state === 'stale') {
    const max = numOrNull(missMax);
    return `지난 스캔 ${m.miss}회 연속 답하지 않았습니다${max != null ? ` — ${max}회가 되면 이 이름을 지웁니다` : ''}`;
  }
  if (m.state === 'none') return '응답 없음';
  if (m.state === 'skipped') return m.key === 'mdns' ? '묻지 않음(꺼짐 또는 다른 네트워크 구간)' : '묻지 않음(꺼짐)';
  if (m.state === 'unknown') return '—';
  return '';
}

/**
 * 에이전트 표 '이름 확인' 칸 — x 는 agentReportRows 의 줄(마지막 완료 보고의 nameStats · alive).
 * @returns {{ text:string, title:string, noReport:boolean }}
 */
export function nameStatsCell(x) {
  const ns = x?.nameStats;
  if (!ns || typeof ns !== 'object') {
    // 완료 보고는 있는데 요약이 없다 = 이전 버전 엣지(역DNS 만 한다 — 이름은 hostname 칸으로 온다).
    return x && x.at != null && x.alive != null
      ? { text: '', title: '이 에이전트는 호스트명 확인 방식을 보고하지 않습니다 — 이전 버전이라 역DNS 결과만 보냅니다(업그레이드 뒤 mDNS · NetBIOS 가 동작합니다).', noReport: true }
      : { text: '—', title: '', noReport: false };
  }
  const named = numOrNull(ns.named);
  const alive = numOrNull(ns.alive) ?? numOrNull(x.alive);
  const parts = NAME_METHODS.filter((k) => (numOrNull(ns.tried?.[k]) ?? 0) > 0)
    .map((k) => `${NAME_SRC[k].label} ${numOrNull(ns.found?.[k]) ?? '—'}/${numOrNull(ns.tried?.[k])}`);
  return {
    text: named == null ? '—' : `${named.toLocaleString()} / ${alive == null ? '—' : alive.toLocaleString()}`,
    title: parts.length ? `방식별 찾은 수 / 물어본 수 — ${parts.join(' · ')}` : '이번 스캔에서 호스트명을 묻지 않았습니다(방식이 모두 꺼져 있음)',
    noReport: false,
  };
}
/** 스캔 한 번의 이름 확인 요약 문구(상태 카드 · 실행 이력) — 요약이 없으면 ''. */
export function nameStatsText(ns) {
  if (!ns || typeof ns !== 'object') return '';
  const named = numOrNull(ns.named);
  if (named == null) return '';
  const parts = NAME_METHODS.filter((k) => (numOrNull(ns.tried?.[k]) ?? 0) > 0).map((k) => `${NAME_SRC[k].label} ${numOrNull(ns.found?.[k]) ?? '—'}`);
  return `호스트명 ${named.toLocaleString()}개 확인${parts.length ? ` · ${parts.join(' · ')}` : ' · 방식 모두 꺼짐'}`;
}
