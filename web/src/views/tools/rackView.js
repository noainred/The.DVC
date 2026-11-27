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
    usedStale: racks.some((r) => r.totalsStale),   // 끌어 놓기를 먼저 반영한 랙이 있다 — 사용 U 합은 다시 불러올 때까지 옛 값(화면이 숫자 대신 밝힌다)
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
  // IPv4 리터럴(포트 포함) 또는 IPv6 리터럴(콜론 2개 이상 · 대괄호 · 포트 포함)만 — 16진 글자와 점으로 된 호스트 이름('ad01.dc1')은 이름이다(1회차 반증 C-4).
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(name)) return '';
  if (name.length <= 64 && /^\[?[0-9a-f:.]+\]?(:\d{1,5})?$/i.test(name) && name.split(':').length > 2) return '';
  if (u?.serviceTag && name.toLowerCase() === String(u.serviceTag).trim().toLowerCase()) return '';
  return name;
}

/**
 * 고치기 창에서 **달라진 칸만** 추린다(f0 = 창을 연 때의 값, f = 지금 값 — 앞뒤 공백 · 숫자/글자 차이는 같은 것으로 본다).
 * 건드리지 않은 칸은 보내지 않는다 — 창을 연 뒤 바뀐 값(내 직전 옮기기 · 다른 관리자의 변경)을 옛 값으로 덮지 않게.
 */
export function changedFields(f0, f, keys) {
  const norm = (v) => String(v ?? '').trim();
  const out = {};
  for (const k of keys || []) if (norm(f?.[k]) !== norm(f0?.[k])) out[k] = f[k];
  return out;
}

/**
 * 전산실 조회 실패를 화면 자료에 반영한다(순수 — 2회차 반증 B-3).
 * 실패한 전산실의 직전 화면이 남아 있으면 ‘낡음’ 표시(staleErr)를 **그 자료에** 붙인다 — 그 전산실을 다시 불러오는 데 성공해 자료가 통째로 바뀔 때만 사라진다.
 * 오류 상태 하나에 두면 다른 전산실을 눌렀다 곧바로 돌아올 때 표시만 지워져 낡은 화면이 잠금 없이 그려졌다.
 *  · 다른 전산실의 자료 · 이 시도(seq)보다 **나중에** 받은 자료는 건드리지 않는다(늦게 온 옛 실패가 새 자료를 잠그지 않게).
 *  · 없어진 전산실(404) · 권한 없음(403)이면 자료를 비운다(일시 실패 5xx · 네트워크는 직전 화면을 둔다).
 */
export function viewAfterLoadFail(view, roomId, seq, err) {
  if (!view || view.room?.id !== roomId || (view.loadSeq || 0) > seq) return view;
  if (err?.status === 404 || err?.status === 403) return null;
  return { ...view, staleErr: err || true };
}

/** 쓰기를 시작한 자리(at)에서 사용자가 옮기지 않았는가(순수) — 법인 · 데이터센터 · 전산실이 같고, 열린 창이 없거나 그 쓰기를 시작한 창 그대로. */
export function sameSpot(at, now) {
  if (!at || !now) return false;
  return now.corp === at.corp && now.site === at.site && now.room === at.room && (!now.modal || now.modal === at.modal);
}

/**
 * 쓰기의 대상 자리(target — 전산실 · 데이터센터 · 법인 중 그 쓰기가 정한 것)를 지금도 보고 있는가(순수). 정하지 않은 칸은 따지지 않는다.
 * 저장 중에도 창을 닫을 수 있어, 응답이 왔을 때 다른 법인 · 전산실 화면에 ‘추가했습니다’ 가 뜨지 않게 알림 앞에서 본다(2회차 반증 C5 · 3회차 점검 화면 2).
 */
export function spotVisible(target, now) {
  const t = target || {}; const n = now || {};
  return (!t.room || t.room === n.room) && (!t.site || t.site === n.site) && (!t.corp || t.corp === n.corp);
}

/**
 * 장비 · 랙 창의 저장을 막을 까닭(순수) — '' 저장해도 됨 · 'noView' 화면 자료가 없음 · 'roomChanged' 창을 연 전산실이 지금 자료의 전산실과 다름
 * (늦게 온 응답 · 목록 변화로 선택 전산실이 바뀐 뒤 그 창으로 다른 전산실의 rev · 랙에 쓰지 않게 — 3회차 점검 화면 1).
 */
export function lostViewReason(view, modal) {
  if (!view) return 'noView';
  if (modal?.roomId && modal.roomId !== view.room?.id) return 'roomChanged';
  return '';
}

/** 장비 · 랙 창에는 연 때의 전산실을 담는다(순수 — 이미 담겼으면 그대로 · 다른 창은 그대로). */
export function modalWithRoom(m, roomId) {
  return m && (m.kind === 'place' || m.kind === 'rack') && !m.roomId ? { ...m, roomId } : m;
}

/**
 * 충돌(409 revConflict) 뒤 안내의 갈래(순수) — 'fresh' 최신을 불러왔다(다시 저장하면 반영) · 'gone' 전산실이 없어졌거나 권한이 없다(404 · 403 — 닫고 새로 고침) ·
 * 'stale' 일시 실패(잠시 뒤 다시).
 */
export function conflictHint(fresh, lastErr) {
  if (fresh) return 'fresh';
  return lastErr?.status === 404 || lastErr?.status === 403 ? 'gone' : 'stale';
}

/**
 * 이름 창(추가 · 이름 바꾸기 · 지우기)이 쓸 대상(순수) — **창을 연 때 담은 대상**이 먼저이고, 없을 때만 지금 자리.
 * 지금 고른 항목으로 쓰면, 늦게 온 추가 응답이 선택을 바꾼 뒤 새 항목이 지워지거나 이름이 바뀐다(3회차 점검 화면 1 · 재현).
 *  · 'site'(데이터센터 추가) → { corpId } · 'room'(전산실 추가) → { siteId } · 'site-edit' · 'room-edit' → { id }(창에 담긴 것만 — 없으면 '' 로 두어 쓰지 않게)
 */
export function nameTarget(modal, at) {
  const m = modal || {}; const a = at || {};
  if (m.kind === 'site') return { corpId: m.corpId || a.corp || '' };
  if (m.kind === 'room') return { siteId: m.siteId || a.site || '' };
  if (m.kind === 'site-edit' || m.kind === 'room-edit') return { id: m.id || '' };
  return {};
}

/**
 * 끌어 놓기 성공을 화면에 먼저 반영한다(순수) — 그 장비의 랙 · 시작 U 를 바꾸고, 랙을 건너 옮겼으면 두 랙의 머리 합계를 ‘낡음’(totalsStale)으로 표시한다
 * (합계는 서버가 계산한 값이라 다시 불러올 때까지 옛 값이다 — 2회차 반증 C6). 같은 랙 안이면 그 랙에 반깊이 장비가 있을 때만 표시한다. 다른 전산실의 자료 · 없는 장비는 그대로.
 */
export function viewAfterMove(view, roomId, placeId, rackId, uStart) {
  if (!view || view.room?.id !== roomId) return view;
  const cur = (view.places || []).find((p) => p.id === placeId);
  if (!cur) return view;
  // 같은 랙 안에서 옮겨도, 그 랙에 반깊이(앞 · 뒤) 장비가 있으면 사용 U 가 바뀔 수 있다(앞 · 뒤가 같은 U 면 한 번만 센다 — 4회차 점검 정확성 3).
  const halfIn = (view.places || []).some((p) => p.rackId === rackId && (p.face || 'full') !== 'full');
  const touched = cur.rackId !== rackId ? new Set([cur.rackId, rackId]) : (halfIn ? new Set([rackId]) : null);
  return {
    ...view,
    places: view.places.map((p) => (p.id === placeId ? { ...p, rackId, uStart } : p)),
    racks: touched ? (view.racks || []).map((k) => (touched.has(k.id) ? { ...k, totalsStale: true } : k)) : view.racks,
  };
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
// 바뀐 칸이 하나도 없이 온 '수정' 항목 = 이 계정에 보이지 않는 칸(메모 — 관리자 전용)만 바뀐 변경이다(서버가 그 칸 이름을 빼고 보낸다).
export const fieldsText = (fields) => ((fields || []).length ? fields.map((f) => FIELD_LABEL[f] || f).join(' · ') : '이 계정에 보이지 않는 칸');

/**
 * 판 기록 창 '되돌리면 바뀌는 것' 자리에 미리 보기가 없을 때의 글(순수) — 조회 계정에는 서버가 싣지 않고(관리자에게만), 관리자에게 없으면 지금 원장과 비교하지 못한 것이다.
 * 예전엔 둘 다 '—' 만 보여 '바뀌는 것 없음' 으로 읽혔다(6회차 화면 D5 · 정확성 D5).
 */
export function restoreMissingText(isAdmin) {
  return isAdmin ? '지금 원장과 비교하지 못했습니다(원장을 읽지 못했거나 이 판을 되살릴 수 없습니다).' : '되돌리기 미리 보기는 관리자에게만 보입니다.';
}

/**
 * 미배치 서버 패널에 무엇을 그릴까(순수) — 목록(등록부 서버 이름 · 태그)은 관리자 응답에만 실린다(서버 `unplacedListed`).
 * 'count' 면 대수만 그린다 — 목록 · 검색 결과 · '앞 N대만 받았습니다' 안내를 그리지 않는다(받지 않은 것을 '받다 말았다' 로 읽히게 하지 않는다).
 * @returns {'list'|'count'}
 */
export function unplacedMode(view) {
  return view && view.unplacedListed === false ? 'count' : 'list';
}

/**
 * 연결된 서버의 이름 줄(순수) — 등록부 이름 · OS 호스트 이름은 관리자 응답에만 실린다. 두 칸이 모두 없으면(키 없음) null = 줄을 그리지 않는다.
 * 키는 있는데 값이 비었으면 '—'(관리자에게 '이름이 없다' 를 보인다).
 */
export function linkNameText(l) {
  if (!l || (l.name === undefined && l.hostname === undefined)) return null;
  return l.hostname || l.name || '—';
}

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

// ───────────────────────── 가림 집계(전체 범위 관리자 — 서버 `GET /tools/rack/mask-census`) ─────────────────────────

export const CENSUS_FIELD_LABEL = Object.freeze({ label: '표시 이름', model: '모델', rackName: '랙 이름', rackRow: '랙의 줄', rackRole: '랙 용도', roomName: '전산실 이름', siteName: '데이터센터 이름' });
export const CENSUS_HIT_LABEL = Object.freeze({ addr: '주소', tag: '태그 · 시리얼', firstLabel: '등록 주소의 첫 마디', altIp: '구분자를 바꾼 IP' });
const CENSUS_KEYS = ['total', 'addr', 'tag', 'firstLabel', 'altIp'];
/** 수가 아니면 null(못 읽은 값을 0 으로 접지 않는다). */
const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
/**
 * 집계 응답 → 표의 행(칸마다) · 합계 · 타일 값(순수). 응답에 없는 칸 · 수가 아닌 값은 null 로 둔다(화면은 '—').
 * `hidden` = 지금 조회 계정에 가려져 보이는 글(주소 + 태그) · `wider` = 검사의 폭을 넓히면 더 걸릴 글(첫 마디 + 구분자를 바꾼 IP — 한 글이 둘 다면 두 번 센다).
 */
export function censusRows(c) {
  const pick = (o) => Object.fromEntries(CENSUS_KEYS.map((k) => [k, cnt(o?.[k])]));
  const rows = Object.keys(CENSUS_FIELD_LABEL).map((f) => ({ field: f, label: CENSUS_FIELD_LABEL[f], ...pick(c?.fields?.[f]) }));
  const sum = pick(c?.sum);
  const add2 = (a, b) => (a == null || b == null ? null : a + b);
  return { rows, sum, hidden: add2(sum.addr, sum.tag), wider: add2(sum.firstLabel, sum.altIp), notes: cnt(c?.notes) };
}
/** 걸린 종류 글 — 모르는 종류는 그대로. */
export const censusHitsText = (hits) => (hits || []).map((h) => CENSUS_HIT_LABEL[h] || h).join(' · ');

// ───────────────────────── 가림 재료 기록 관리(전체 범위 관리자 — 서버 `GET /tools/rack/mask-seen` · 연산 `mask.forget`) ─────────────────────────

export const SEEN_KIND_LABEL = Object.freeze({ h: '관리 주소', t: '서비스 태그' });
/** 기록 행 하나의 키(고르기 · 목록 키) — 종류와 값을 합친다(같은 글자가 주소와 태그 양쪽에 있을 수 있다). */
export const seenKeyOf = (x) => `${x?.kind || ''}\u0000${x?.key || ''}`;
/** 고른 행 → 지울 값 목록(서버 연산 본문). 목록에 없는 키는 버린다(늦게 온 응답으로 목록이 바뀐 뒤 고른 것이 남지 않게). */
export function forgetItemsOf(stale, selected) {
  const sel = selected instanceof Set ? selected : new Set(selected || []);
  return (stale || []).filter((x) => sel.has(seenKeyOf(x))).map((x) => ({ kind: x.kind, key: x.key }));
}
/**
 * 기록 크기 안내(순수) — 상한에 가까우면 경고. 값을 못 읽었으면 null(‘—’).
 * @returns {{ text: string, warn: boolean } | null}
 */
export function seenCapText(m) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const h = n(m?.hosts); const t = n(m?.tags); const max = n(m?.max);
  if (h == null || t == null) return null;
  const warn = max != null && max > 0 && Math.max(h, t) >= max * 0.9;
  const extra = [n(m?.pending) ? `파일에 쓰는 중 ${n(m.pending).toLocaleString()}` : '', n(m?.overflow) ? `메모리에만 ${n(m.overflow).toLocaleString()}` : ''].filter(Boolean).join(' · ');
  return { text: `본 적 있는 주소 ${h.toLocaleString()} · 태그 ${t.toLocaleString()}${max != null ? `(종류마다 상한 ${max.toLocaleString()})` : ''}${extra ? ` · ${extra}` : ''}`, warn };
}
