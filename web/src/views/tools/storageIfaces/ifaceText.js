/**
 * storageIfaces/ifaceText.js — Unity SAN · NAS 인터페이스 화면의 문구 · 표시 규칙(v3.35.0 — 설계 docs/design/unity-iface).
 * 판정(다운 · 저하 · 포화 · 유휴)은 서버 `storage/ifaces.js judgePort` 가 하고 응답의 state · flags 로 온다 — 여기는 그 값을 글로 바꾸고 모은다.
 * 기준 숫자(포화 근접 % · 유휴 %)는 응답의 busyPct · idlePct 를 쓴다(화면에 박지 않는다).
 */
import { numOrNull } from '../../../numOrNull.js';

/** 칸 색 — SAN 포트 사용량(sanPortUsageText LEVELS)과 같은 값 · 같은 경계. */
export const LEVELS = Object.freeze([
  { min: 0, color: '#1e3a5f', label: '20% 미만' },
  { min: 20, color: '#155e75', label: '20~40%' },
  { min: 40, color: '#0e7490', label: '40~60%' },
  { min: 60, color: '#22d3ee', label: '60~80%' },
  { min: 80, color: '#ea580c', label: '80% 이상' },
]);
export const GAP_BG = 'repeating-linear-gradient(45deg, rgba(148,163,184,.3) 0 3px, transparent 3px 6px)';
export function levelColor(pct) {
  const p = numOrNull(pct);
  if (p == null) return null;
  let c = LEVELS[0].color;
  for (const l of LEVELS) if (p >= l.min) c = l.color;
  return c;
}
export const RANGES = Object.freeze([['24h', '24시간'], ['7d', '7일'], ['30d', '30일']]);
export const KINDS = Object.freeze([['all', '전체'], ['fc', 'FC'], ['iscsi', 'iSCSI'], ['nas', 'NAS']]);
export const UNITS = Object.freeze([['mbs', 'MB/s'], ['gbps', 'Gbps']]);

/** 상태 → 배지(글 · 색 이름). 못 읽은 처리량은 상태가 아니라 따로 표시한다. */
export const STATE_BADGE = Object.freeze({
  down: { text: '링크 다운', cls: 'red' },
  unused: { text: '미연결', cls: 'gray' },
  slow: { text: '속도 저하', cls: 'amber' },
  busy: { text: '포화 근접', cls: 'amber' },
  idle: { text: '유휴', cls: 'gray' },
  ok: { text: '정상', cls: 'green' },
  unknown: { text: '상태 못 읽음', cls: 'gray' },
});
export const stateBadge = (s) => STATE_BADGE[s] || STATE_BADGE.unknown;

/** 처리량(bps) → 글. 값이 없으면 '—'(단위를 붙이지 않는다). */
export function rateText(bps, unit = 'mbs') {
  const n = numOrNull(bps);
  if (n == null) return '—';
  if (unit === 'gbps') { const g = n / 1e9; return `${g >= 10 ? g.toFixed(1) : g.toFixed(2)} Gbps`; }
  const mb = n / 8 / 1e6;
  return `${mb >= 100 ? Math.round(mb).toLocaleString() : mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)} MB/s`;
}
export const pctText = (p) => { const n = numOrNull(p); return n == null ? '—' : `${n >= 10 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)}%`; };
/** 칸 길이 글 — 1시간 미만은 분(15분 칸을 '1시간' 이라 하지 않는다). */
export const bucketText = (ms) => { const n = numOrNull(ms); if (n == null || !(n > 0)) return ''; return n < 3_600_000 ? `${Math.round(n / 60_000)}분` : n % 86_400_000 === 0 ? `${n / 86_400_000}일` : `${Math.round(n / 3_600_000)}시간`; };
export const speedText = (g) => { const n = numOrNull(g); return n == null || !(n > 0) ? '—' : `${n >= 1 ? Math.round(n * 10) / 10 : n} Gb`; };
const pad = (n) => String(n).padStart(2, '0');
/** 포탈 시각(한국 — UTC+9) 'MM-DD HH:mm'. */
export function timeText(ms) {
  const t = numOrNull(ms);
  if (t == null) return '—';
  const d = new Date(t + 9 * 3_600_000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function hourText(ms) {
  const t = numOrNull(ms);
  if (t == null) return '';
  const d = new Date(t + 9 * 3_600_000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}시`;
}

/** 포트의 종류 표시 — FC · iSCSI · NAS · 겸용 · 이더넷(인터페이스가 없는 이더넷 포트). */
export function portKindOf(p, ifsByPort) {
  if (p.kind === 'fc') return 'fc';
  const list = ifsByPort.get(p.id) || [];
  const kinds = new Set(list.map((x) => x.kind));
  if (kinds.has('iscsi') && kinds.has('nas')) return 'both';
  if (kinds.has('iscsi')) return 'iscsi';
  if (kinds.has('nas')) return 'nas';
  return 'eth';
}
export const KIND_LABEL = Object.freeze({ fc: 'FC', iscsi: 'iSCSI', nas: 'NAS', both: 'iSCSI · NAS', eth: '이더넷' });

/** 응답 장비 목록 → 표 행(장비 정보를 붙인 포트 행). 인터페이스는 포트별로 묶어 붙인다. */
export function flattenRows(devices = [], dcName = (id) => id || '') {
  const rows = [];
  for (const d of devices || []) {
    const v = d.view;
    if (!v) continue;
    const ifsByPort = new Map();
    for (const x of v.interfaces || []) { if (!ifsByPort.has(x.port)) ifsByPort.set(x.port, []); ifsByPort.get(x.port).push(x); }
    for (const p of v.ports || []) {
      rows.push({ ...p, deviceId: d.id, deviceName: d.name || d.id, corp: dcName(d.datacenterId), collectMethod: d.collectMethod,
        portKind: portKindOf(p, ifsByPort), ifs: ifsByPort.get(p.id) || [] });
    }
  }
  return rows;
}
/** 종류 필터 — iSCSI · NAS 는 겸용 포트도 포함한다. */
export function kindMatch(r, k) {
  if (!k || k === 'all') return true;
  if (k === 'fc') return r.portKind === 'fc';
  if (k === 'iscsi') return r.portKind === 'iscsi' || r.portKind === 'both';
  if (k === 'nas') return r.portKind === 'nas' || r.portKind === 'both';
  return true;
}
export function textMatch(r, q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return true;
  const hay = [r.deviceName, r.corp, r.id, r.name, r.wwn, ...(r.ifs || []).flatMap((x) => [x.ip, x.nasServer, x.id])].filter(Boolean).join(' ').toLowerCase();
  return t.split(/\s+/).every((w) => hay.includes(w));
}
/** 문제 행(다운 · 저하 · 포화 근접) — '문제만 보기'. */
export const isProblem = (r) => r.state === 'down' || r.state === 'slow' || r.state === 'busy' || (r.flags || []).includes('slow') || (r.flags || []).includes('busy');

/**
 * KPI 6개(순수). 사용량 못 읽음은 **장비 · 포트 수를 따로** 센다(정상에도 이상에도 넣지 않는다). SP 편중은 장비 수.
 */
export function kpisOf(devices = [], rows = []) {
  const up = rows.filter((r) => r.linkUp === true).length;
  const down = rows.filter((r) => r.state === 'down').length;
  const unused = rows.filter((r) => r.state === 'unused').length;
  const unknown = rows.filter((r) => r.linkUp == null).length;
  const slow = rows.filter((r) => (r.flags || []).includes('slow')).length;
  const busy = rows.filter((r) => (r.flags || []).includes('busy')).length;
  const idle = rows.filter((r) => r.state === 'idle').length;
  const unreadRows = rows.filter((r) => r.linkUp === true && r.unread);
  const unreadDevices = new Set(unreadRows.map((r) => r.deviceId)).size;
  const skew = (devices || []).filter((d) => d.view?.sp?.fc?.skew || d.view?.sp?.eth?.skew).length;
  return { ports: rows.length, up, down, unused, unknown, slow, busy, idle, unreadDevices, unreadPorts: unreadRows.length, skew,
    fc: rows.filter((r) => r.kind === 'fc').length, eth: rows.filter((r) => r.kind === 'eth').length };
}

/** 처리량을 못 읽은 이유(장비 단위 — 서버 throughputWhy · 판정은 storage/ifaceSummary.js throughputWhyOf 하나). 단정하지 않고 근거(throughputDetail)를 함께 보인다. */
export const WHY_TEXT = Object.freeze({
  ssh: 'SSH(uemcli) 로 수집하는 장비라 사용량을 읽지 않습니다 — 속도 · 상태만 보입니다. 사용량은 REST 로 등록한 장비만 5분 표본으로 읽습니다.',
  'sample-off': '이 장비는 성능 표본 수집이 꺼져 있습니다(장비 등록 › 디렉터 · 노드 · SP 성능 표본).',
  'db-unavailable': '이 포탈의 저장소(DB)를 열지 못해 사용량을 읽지 못했습니다.',
  'no-samples': '이 포탈에 이 장비의 5분 표본이 하나도 없습니다 — 첫 표본 전이거나, 엣지 수집 장비면 엣지에서 표본이 실패해 올라오지 않았을 수 있습니다(엣지 로그 확인).',
  'sample-failed': '5분 표본 수집이 실패하고 있습니다 — 아래 오류가 마지막 시도의 사유입니다(인증 · 접속 · 장비가 성능 이력을 주지 않음 등).',
  'no-port-units': '표본은 오는데 **포트 단위 값이 없습니다**(SP 값만) — 장비가 포트 처리량 지표 경로를 주지 않았습니다. 아래 ‘경로별 항목 수’ 가 근거입니다(0 · error 인 경로). Unity 의 성능 이력 수집(메트릭 서비스)이 꺼져 있어도 이렇게 보입니다.',
  'no-match': '포트 단위 값은 오는데 **포트 구성의 이름과 짝지어지지 않습니다** — 아래 두 이름 목록이 근거입니다. 이 목록을 보내 주시면 짝짓는 규칙을 맞추겠습니다.',
  'no-recent': '포트 짝은 맞는데 최근 · 이 기간 안의 값이 없습니다 — 표본이 멈췄거나 오래됐습니다(엣지 · 폴러 상태 확인).',
  'collect-failed': '마지막 수집이 실패해 포트 구성을 볼 수 없습니다 — 장비별 탭의 오류 사유를 확인하세요(지난 값을 지어내지 않습니다).',
  'no-config': '포트 구성을 아직 읽지 못했습니다(다음 수집을 기다리거나 아래 수집 출처의 사유를 확인하세요).',
});
export const PROBE_STATE = Object.freeze({ ok: '읽음', failed: '실패', skipped: '건너뜀', unparsed: '형식 못 읽음' });

/** 표시 순서용 피크 정렬 값 — 못 읽은 값은 항상 뒤(STable 규칙과 같다 — '—'). */
export const sortVal = (v) => (numOrNull(v) == null ? '' : String(numOrNull(v)));

/** 화면 주석(읽는 법). 숫자는 응답 값으로 채운다. */
export function notesOf({ busyPct, idlePct } = {}) {
  return [
    '사용률 = **읽기 · 쓰기(받음 · 보냄) 중 큰 쪽 ÷ 그 포트의 링크 속도**입니다. 링크 용량은 속도(Gb/s) ÷ 8 로 봅니다(SAN 포트 사용량과 같은 환산).',
    '피크는 **5분 표본들 중 최댓값**입니다 — 표본 사이의 순간 최대는 보이지 않습니다. 평균은 방향별 평균 중 큰 쪽입니다.',
    '**NAS · iSCSI 인터페이스는 포트 단위 값**입니다 — 한 포트에 인터페이스가 여럿이면 나눠 보여 줄 수 없습니다.',
    `속도 저하 = 요청이 ‘자동’ 인데 지금 연결 속도가 최대보다 낮음(사람이 정한 고정 속도는 저하가 아닙니다). 포화 근접 = 기간 피크 ${pctText(busyPct)} 이상 · 유휴 = 링크 업인데 기간 피크 ${pctText(idlePct)} 미만.`,
    '링크 다운은 **직전에 링크 업이던 포트가 내려간 것**만 셉니다. 처음 본 때부터 내려가 있던 포트는 미연결입니다.',
    'FC 포트를 **스위치 쪽에서 본 값**(송수신 합)은 SAN 스토리지 성능에 있습니다. 여기는 Unity 가 스스로 보고한 값이라 숫자가 다를 수 있습니다.',
    '값이 없는 칸(빗금)은 0 이 아닙니다 — 표본이 없었거나 장비가 그 구간을 보관하지 않습니다.',
  ];
}

/** 사유별로 장비를 묶는다(화면 맨 위 요약 — 사유가 있는 장비만). 순서는 WHY_TEXT 순. */
export function groupByWhy(devices = []) {
  const order = Object.keys(WHY_TEXT);
  const m = new Map();
  for (const d of devices || []) {
    const w = d?.view?.throughputWhy;
    if (!w) continue;
    if (!m.has(w)) m.set(w, []);
    m.get(w).push(d);
  }
  return [...m.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
}
/** WWN 표시 — Unity FC 는 노드 WWN + 포트 WWN(16바이트)으로 와서 뒤 몇 글자는 포트끼리 같다. 포트 WWN(뒤 8바이트)을 통째로 보인다. */
export function portWwn(w) {
  const v = String(w || '').trim();
  if (!v) return '';
  const parts = v.split(':');
  return parts.length >= 16 ? parts.slice(-8).join(':') : v;
}
