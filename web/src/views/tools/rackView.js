/**
 * 랙 실장도 화면의 순수 계산(설계 docs/design/rack-elevation · 도구 키 rack).
 * 겹침 · 범위 판정의 **진실은 서버**(server/src/rack/layout.js)다 — 여기 placementIssue 는 끌어 놓는 동안 초록/빨강 미리 보기용이고,
 * 놓으면 서버가 다시 검사한다. 두 판정은 rackView.test.js 가 같은 입력으로 대조한다(판정 복제 규약).
 */

export const U_PX = 16;          // 1U 높이(화면 px)
export const KIND_LABEL = Object.freeze({ server: '서버', storage: '스토리지', network: '네트워크', san: 'SAN 스위치', other: '기타' });
export const FACE_LABEL = Object.freeze({ full: '전체 깊이', front: '앞 반깊이', rear: '뒤(후면 전용)' });

// 색은 styles.css 토큰과 같은 값(시안 그대로). [배경, 테두리, 글자]
const KIND_COLOR = {
  server: ['rgba(59,130,246,.24)', '#3b82f6', '#dbeafe'],
  storage: ['rgba(52,224,180,.18)', '#2dd4bf', '#ccfbf1'],
  network: ['rgba(34,211,238,.16)', '#22d3ee', '#cffafe'],
  san: ['rgba(168,85,247,.26)', '#a855f7', '#ead5ff'],
  other: ['#1a2236', '#3a4866', '#aebbd0'],
};
export const HATCH = 'repeating-linear-gradient(45deg,#1a2236 0 5px,#2b3852 5px 10px)';
const STATUS_COLOR = {
  ok: ['rgba(34,197,94,.14)', '#22c55e', '#bbf7d0', '정상'],
  warn: ['rgba(245,158,11,.32)', '#f59e0b', '#fde68a', '경고'],
  crit: ['rgba(239,68,68,.5)', '#ef4444', '#ffffff', '장애'],
  unknown: [HATCH, '#8b9bb4', '#e6edf6', '못 읽음'],
  nolink: [HATCH, '#5d6b85', '#aebbd0', '연결 안 됨'],
  na: ['#141b2d', '#2b3852', '#8b9bb4', '감시 안 함'],
};

/** 장비의 상태 키 — 서버만 iDRAC 상태가 있다. 연결 못 한 서버 · 상태를 못 읽은 서버는 정상으로 세지 않는다. */
export function statusKeyOf(p) {
  if (p?.kind !== 'server') return 'na';
  if (p.linkState !== 'linked' || !p.link) return 'nolink';
  const h = p.link.health;
  return h === 'ok' || h === 'warn' || h === 'crit' ? h : 'unknown';
}

/** 겹쳐 보기 모드별 색 + 오른쪽 값 글자. */
export function colorOf(p, mode) {
  if (mode === 'status') {
    const k = statusKeyOf(p);
    const c = STATUS_COLOR[k];
    return { bg: c[0], bd: c[1], fg: c[2], val: c[3] };
  }
  const c = KIND_COLOR[p?.kind] || KIND_COLOR.other;
  return { bg: c[0], bd: c[1], fg: c[2], val: `${p?.uSize || '?'}U` };
}

export function legendOf(mode) {
  if (mode === 'status') return Object.entries(STATUS_COLOR).map(([k, c]) => ({ k, bg: c[0], bd: c[1], label: c[3] }));
  return Object.entries(KIND_COLOR).map(([k, c]) => ({ k, bg: c[0], bd: c[1], label: KIND_LABEL[k] }));
}

export const fmtU = (p) => `U${p.uStart}${p.uSize > 1 ? `–${p.uStart + p.uSize - 1}` : ''}`;

/** 면 보기에 그릴 장비 — 전면: full · front, 후면: full(뒷면) · rear. */
export function placesForFace(places, face) {
  return (places || []).filter((p) => (face === 'rear' ? p.face !== 'front' : p.face !== 'rear'));
}

/** 같은 U 에서 부딪히는 면인가(서버 layout.js facesClash 와 같은 판정). */
export function facesClash(a, b) {
  if (a === 'full' || b === 'full') return true;
  return a === b;
}

/** 미리 보기용 겹침 · 범위 판정(서버 placementIssue 와 같은 판정 — 대조 테스트). */
export function placementIssue(rack, places, cand, ignoreId = '') {
  const h = Number(rack?.heightU);
  if (!['full', 'front', 'rear'].includes(cand?.face)) return { code: 'input' };
  if (!Number.isInteger(cand.uStart) || !Number.isInteger(cand.uSize) || cand.uSize < 1) return { code: 'input' };
  if (cand.uStart < 1 || cand.uStart + cand.uSize - 1 > h) return { code: 'range' };
  for (const p of places || []) {
    if (!p || p.id === ignoreId) continue;
    if (cand.uStart <= p.uStart + p.uSize - 1 && p.uStart <= cand.uStart + cand.uSize - 1 && facesClash(cand.face, p.face)) return { code: 'overlap', withId: p.id };
  }
  return null;
}

/**
 * 끌어 놓는 위치 → 시작 U. y = 랙 슬롯 영역 위쪽에서 잰 거리(px). 커서가 가리키는 U 를 장비의 **맨 위** U 로 보고 아래로 size 만큼.
 * 결과는 1 ~ (H - size + 1) 로 자른다(랙 밖으로 넘치는 자리를 만들지 않는다 — 들어가지 않으면 null).
 */
export function dropStartU(y, heightU, size, uPx = U_PX) {
  const H = Number(heightU); const n = Math.max(1, Number(size) || 1);
  if (!(H >= 1) || n > H) return null;
  const topU = H - Math.floor(Math.max(0, y) / uPx);
  const start = topU - n + 1;
  return Math.min(Math.max(1, start), H - n + 1);
}

/** 화면 위 상자 위치(랙 슬롯 영역 안 — bottom 기준 px). */
export const boxOf = (p, uPx = U_PX) => ({ bottom: (p.uStart - 1) * uPx, height: p.uSize * uPx - 1 });

/** W → '1.2 kW' / '560 W' / '—'. 읽은 대수가 전체보다 적으면 ' (n대 중 m대)' 를 붙인다(부분 합을 전체처럼 보이지 않게). */
export function wattText(w, read = null, total = null) {
  if (w == null) return '—';
  const v = w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;
  return read != null && total != null && read < total ? `${v} (${total}대 중 ${read}대)` : v;
}

/** 전산실 요약 타일 값. */
export function roomSummary(view) {
  const racks = view?.racks || [];
  const places = view?.places || [];
  const totalU = racks.reduce((a, r) => a + (r.heightU || 0), 0);
  const usedU = racks.reduce((a, r) => a + (r.totals?.usedU || 0), 0);
  const servers = places.filter((p) => p.kind === 'server');
  const by = (k) => servers.filter((p) => statusKeyOf(p) === k).length;
  const heights = new Map();
  for (const r of racks) heights.set(r.heightU, (heights.get(r.heightU) || 0) + 1);
  return {
    racks: racks.length,
    heightsText: [...heights].sort((a, b) => b[0] - a[0]).map(([h, n]) => `${h}U ${n}`).join(' · '),
    totalU, usedU, freeU: Math.max(0, totalU - usedU), usePct: totalU ? Math.round((usedU / totalU) * 100) : null,
    devices: places.length,
    manual: places.filter((p) => p.kind !== 'server').length,
    servers: servers.length,
    crit: by('crit'), warn: by('warn'), unknown: by('unknown'), nolink: by('nolink'),
    unplaced: view?.unplacedTotal ?? 0,
  };
}

/** 검색어가 장비와 맞는가(이름 · 모델 · 시리얼 · 호스트 이름 — 대소문자 무시 부분 일치). 빈 검색어는 null(강조 없음). */
export function matchPlace(p, q) {
  const s = String(q || '').trim().toLowerCase().slice(0, 64);
  if (!s) return null;
  const hay = [p.label, p.model, p.serial, ...(p.extraSerials || []), p.link?.hostname, p.link?.name, p.note].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(s);
}

/** 미배치 서버 목록 한 번에 그리는 수(‘더 보기’ 로 늘린다). */
export const UNPLACED_PAGE = 100;
/** 미배치 서버가 검색어와 맞는가(이름 · 호스트 이름 · 모델 · 서비스 태그 — 대소문자 무시 부분 일치). 빈 검색어는 전부 보인다(true). */
export function matchUnplaced(u, q) {
  const s = String(q || '').trim().toLowerCase().slice(0, 64);
  if (!s) return true;
  return [u?.name, u?.hostname, u?.model, u?.serviceTag].filter(Boolean).join(' ').toLowerCase().includes(s);
}

/**
 * 미배치 서버를 놓을 때 입력 창에 채울 표시 이름 — 등록부 이름이 **주소 꼴**(IP 로 등록한 서버는 이름이 곧 관리 주소)이거나 서비스 태그 그대로면 비운다.
 * 표시 이름은 조회 계정 모두에게 보이는 이름이라 관리 주소 · 태그를 기본값으로 넣지 않는다(1회차 점검 S1 — 서버도 비관리자 판본에서 다시 가린다).
 */
export function defaultLabelOf(u) {
  const name = String(u?.name || '').trim();
  if (!name) return '';
  if (/^\[?[0-9a-f:.]+\]?(:\d+)?$/i.test(name) && /[.:]/.test(name) && /\d/.test(name)) return '';   // IPv4 · IPv6 리터럴(포트 포함)
  if (u?.serviceTag && name.toLowerCase() === String(u.serviceTag).trim().toLowerCase()) return '';
  return name;
}

/** 이력 action → 글자. */
export const ACTION_LABEL = Object.freeze({
  'site.add': '데이터센터 추가', 'site.rename': '데이터센터 이름 변경', 'site.remove': '데이터센터 삭제',
  'room.add': '전산실 추가', 'room.rename': '전산실 이름 변경', 'room.remove': '전산실 삭제',
  'rack.add': '랙 추가', 'rack.update': '랙 수정', 'rack.remove': '랙 삭제',
  'place.add': '장비 놓기', 'place.move': '장비 옮기기', 'place.update': '장비 정보 수정', 'place.remove': '장비 빼기',
  'version.restore': '판 되돌리기', 'version.baseline': '기준 판(판 기록 시작)',
});

const DIFF_PARTS = [
  ['site', '데이터센터'], ['room', '전산실'], ['rack', '랙'], ['place', '장비'],
];
/** 판 차이 개수 → 한 줄 글(0 인 항목은 뺀다). 바뀐 것이 없으면 '바뀐 것 없음'. */
export function diffCountText(c) {
  if (!c) return '—';
  const out = [];
  for (const [k, label] of DIFF_PARTS) {
    const bits = [];
    if (c[`${k}Add`]) bits.push(`추가 ${c[`${k}Add`]}`);
    if (c[`${k}Remove`]) bits.push(`삭제 ${c[`${k}Remove`]}`);
    if (k === 'place' && c.placeMove) bits.push(`이동 ${c.placeMove}`);
    if (c[`${k}Change`]) bits.push(`수정 ${c[`${k}Change`]}`);
    if (bits.length) out.push(`${label} ${bits.join(' · ')}`);
  }
  return out.length ? out.join(' / ') : '바뀐 것 없음';
}
export const DIFF_OP_LABEL = Object.freeze({ add: '추가', remove: '삭제', move: '이동', change: '수정' });
export const DIFF_TYPE_LABEL = Object.freeze({ site: '데이터센터', room: '전산실', rack: '랙', place: '장비' });
const FIELD_LABEL = { kind: '종류', label: '이름', model: '모델', serial: '시리얼', extraSerials: '추가 시리얼', note: '메모', ratedW: '정격 전력', opW: '운전 전력', weightKg: '무게', name: '이름', row: '줄', typeId: '랙 종류', heightU: '높이', role: '용도', pduA: 'PDU A', pduB: 'PDU B', roomId: '전산실', siteId: '데이터센터' };
export const fieldsText = (fields) => (fields || []).map((f) => FIELD_LABEL[f] || f).join(' · ');

const PART_LABEL = { psu: '전원공급장치', disk: '디스크', mem: '메모리', fan: '팬' };
/** iDRAC 부품 롤업 → 칩. 못 읽은 부품은 '못 읽음' 으로 따로(정상으로 접지 않는다). */
export function partChips(parts) {
  if (!parts) return [];
  const out = [];
  for (const [k, label] of Object.entries(PART_LABEL)) {
    const r = parts[k];
    if (!r) continue;
    const n = (r.ok || 0) + (r.warn || 0) + (r.fault || 0) + (r.unknown || 0);
    const tail = r.fault ? ` · 장애 ${r.fault}` : r.warn ? ` · 주의 ${r.warn}` : r.unknown ? ` · 못 읽음 ${r.unknown}` : '';
    const state = r.fault ? 'crit' : r.warn ? 'warn' : r.unknown ? 'unknown' : 'ok';
    out.push({ k, state, text: `${label} ${r.ok || 0}/${n}${tail}` });
  }
  return out;
}
export const chipColor = (state) => STATUS_COLOR[state] || STATUS_COLOR.unknown;
