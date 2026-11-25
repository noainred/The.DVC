/**
 * cvpNetText.js — CVP 네트워크 기능(v3.38 — docs/design/cvp-network-features) 화면용 순수 함수 · 문구.
 *  판정(링크 품질 · 회수 · 예측 · 토폴로지 · 위치 · 전후 비교 · GBIC 추세)은 서버 cvp/*.js 하나다 — 이 파일은 그 결과를 그리는 법(색 · 문장)만 정한다.
 *  못 읽은 값은 0 · 정상으로 쓰지 않는다: null 은 '—' 또는 '못 읽음'. 숫자 · 주기는 API 값을 쓴다(화면에 박지 않는다).
 */
import { speedLabel } from './cvpIntfText.js';
import { numOrNull } from '../../numOrNull.js';

const DAY = 86_400_000;
export const TONE = Object.freeze({ red: '#f87171', amber: '#fbbf24', blue: '#93c5fd', green: '#4ade80', dim: 'var(--text-dim)', violet: '#c4b5fd' });

/* ── 공통 ─────────────────────────────────────────────────────────────────────────────────────────────────── */
const pad = (n) => String(n).padStart(2, '0');
/** epoch ms → 'YYYY-MM-DD'(이 브라우저 시간대). 없으면 '—'. */
export function dateText(ms) {
  const n = numOrNull(ms);
  if (n == null) return '—';
  const d = new Date(n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 지금부터 며칠 뒤/전. */
export const daysFrom = (ms, now = Date.now()) => { const n = numOrNull(ms); return n == null ? null : Math.round((n - now) / DAY); };
export const speedText = (bps) => speedLabel(bps) || '속도 모름';
export const numText = (v, digits = 0) => { const n = numOrNull(v); return n == null ? '—' : n.toLocaleString('ko-KR', { maximumFractionDigits: digits }); };
export const dbmText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${n.toFixed(1)} dBm`; };
export const pctText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${n.toFixed(n < 10 ? 1 : 0)}%`; };
/** 장비 · 포트 고유 키. */
export const rowKey = (r) => `${r.agent ?? ''}|${r.cvpId}|${r.key}|${r.port ?? r.intf ?? ''}`;

/* ── ④ ⑩ 링크 품질 ───────────────────────────────────────────────────────────────────────────────────────── */
export const VERDICT_DEFS = Object.freeze({
  replace: { label: '교체 후보', color: TONE.red, hint: '오류가 늘고 수신 광량이 주의 임계 이하 — GBIC · 광 케이블 쪽 의심' },
  flap: { label: '플랩', color: TONE.amber, hint: '기간 안에 링크가 여러 번 내려감' },
  peer: { label: '상대 확인', color: TONE.violet, hint: '오류는 늘었는데 광량이 정상 · 구리 · 모름 — 상대 장비 · 케이블 반대쪽부터' },
  observe: { label: '관찰', color: TONE.blue, hint: '링크가 한두 번 내려감' },
});
export const VERDICT_ORDER = Object.freeze(['replace', 'flap', 'peer', 'observe']);
/** 근거 한 줄. */
export function linkqBasis(r, warnDbm) {
  const out = [];
  if (r.errs != null && r.errs > 0) out.push(`오류 ${numText(r.errs)}건(${r.errDays}/${r.days}일)`);
  if (r.downs > 0) out.push(`링크 내려감 ${r.downs}회`);
  if (r.rx != null) out.push(`Rx ${dbmText(r.rx)}${warnDbm != null && r.rx <= warnDbm ? ` ≤ 주의 ${warnDbm}` : ''}`);
  else if (r.copper) out.push('구리(광량 없음)');
  else if (r.errs != null && r.errs > 0) out.push(r.xcvrRead ? '광량 못 읽음' : '트랜시버 목록 못 읽음');
  return out.join(' · ');
}
export const LINKQ_NOTE = '오류는 **일 롤업의 카운터 차이 합**(카운터가 리셋된 구간은 뺍니다)이고 지금 **링크가 올라온 포트**만 순위에 넣습니다. 기간 안에 오류 카운터를 한 번도 읽지 못한 포트는 0 이 아니라 **판정 못 함**으로 따로 셉니다. 플랩은 수집 주기마다 링크가 올라옴 → 내려감으로 바뀐 횟수라 **주기보다 짧은 플랩은 놓칩니다**.';

/* ── ⑤ ⑨ 회수 · 예측 ─────────────────────────────────────────────────────────────────────────────────────── */
export function idleText(r) {
  if (r.never) return `기록 시작(${dateText(r.since)}) 뒤 사용 없음`;
  return r.idleDays == null ? '—' : `${r.idleDays}일 전`;
}
export const RECLAIM_NOTE = '마지막 사용일은 링크가 올라온 날의 일 기록에서 옵니다. 기록 시작 전은 알 수 없어 **일수로 세지 않고** ‘기록 시작 뒤 사용 없음’ 으로 따로 둡니다. 포탈은 포트를 바꾸지 않습니다 — 회수는 현장에서 판단하세요.';
/** 예측 상태 문장. */
export function forecastText(r, { minDays, now = Date.now() } = {}) {
  switch (r.state) {
    case 'none': return '기록 없음';
    case 'short': return `기록 부족(${r.days ?? 0}/${minDays ?? '—'}일)`;
    case 'flat': return '늘지 않음 — 예측 없음';
    case 'already': return '이미 넘음';
    case 'far': return '1년 넘게';
    case 'eta': { const d = daysFrom(r.eta, now); return `${dateText(r.eta)} 무렵${d != null ? `(약 ${d < 60 ? `${Math.max(0, d)}일` : `${Math.round(d / 30)}개월`})` : ''}`; }
    default: return '—';
  }
}
export const FORECAST_TONE = Object.freeze({ already: TONE.red, eta: TONE.amber, far: TONE.blue, flat: TONE.dim, short: TONE.dim, none: TONE.dim, alreadyFault: TONE.red });
export const perMonthText = (v, unit) => { const n = numOrNull(v); return n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(Math.abs(n) < 1 ? 2 : 1)}${unit}/월`; };
export const FORECAST_NOTE = '최근 기록의 **직선 추세**입니다. 기록이 모자라면 ‘기록 부족’, 늘지 않으면 ‘예측 없음’ 으로 두고 날짜를 지어내지 않습니다. 업링크는 **일 최대 사용률** 기준(95 백분위 아님)이고, LLDP 를 못 읽은 장비는 40G 이상 · 링크 있는 포트를 업링크로 봅니다(추정).';

/* ── ⑮ GBIC 추세 ───────────────────────────────────────────────────────────────────────────────────────── */
export function opticTrendText(r, { minDays, now = Date.now() } = {}) {
  if (r.state === 'alreadyFault') return '이미 장애 임계 이하';
  if (r.state === 'already') return '이미 주의 임계 이하';
  return forecastText({ ...r, eta: r.warnEta }, { minDays, now });
}
export const OPTIC_TREND_NOTE = '트랜시버마다 **링크가 올라온 날의 최저 수신 광량**을 쌓아 최근 직선 추세로 주의 임계 도달을 예상합니다. 하루 사이 크게 오르면(교체 · 청소) 그날부터 다시 봅니다. 링크 없는 날은 기록이 없습니다.';

/* ── ⑥ ⑦ 토폴로지 ──────────────────────────────────────────────────────────────────────────────────────── */
export const LAYER_DEFS = Object.freeze({
  spine: { label: '스파인(추정)', order: 0 }, other: { label: '기타 스위치', order: 1 }, leaf: { label: '리프(추정)', order: 2 }, isolated: { label: '연결 모름', order: 3 },
});
export const LINK_DEFS = Object.freeze({
  both: { label: '양쪽 확인', dash: '', color: '#60a5fa' },
  one: { label: '한쪽만(추정)', dash: '6 4', color: '#94a3b8' },
  desc: { label: '설명만(추정)', dash: '2 4', color: '#a78bfa' },
});
export const FIELD_LABEL = Object.freeze({ speed: '속도', mtu: 'MTU', duplex: 'Duplex', admin: '관리 상태', lag: '포트 채널 소속', descA: '설명이 가리키는 상대', descB: '설명이 가리키는 상대', port: '상대 포트' });
export function fieldValue(field, v) {
  if (v == null) return '못 읽음';
  if (field === 'speed') return speedText(v);
  if (field === 'admin') return v === 'up' ? '켜짐' : v === 'down' ? '꺼짐' : String(v);
  if (field === 'lag') return v === 'yes' ? '채널 소속' : '단독';
  return String(v);
}
/** 링크의 불일치 상태 — diff · na · ok · none(비교 대상 아님). */
export function linkCheckState(l) {
  if (!Array.isArray(l.items)) return 'none';
  if (l.items.some((x) => x.state === 'diff')) return 'diff';
  if (l.items.some((x) => x.state === 'na')) return 'na';
  return 'ok';
}
/** 층별로 노드를 묶고 좌표를 정한다(가로 = 층 안 순서, 세로 = 층). 노드가 많으면 줄을 바꾼다. */
export function layoutNodes(nodes, { width = 1100, perRow = 10, rowGap = 120, cellH = 40 } = {}) {
  const layers = Object.keys(LAYER_DEFS).sort((a, b) => LAYER_DEFS[a].order - LAYER_DEFS[b].order);
  const pos = new Map();
  let y = 30;
  const bands = [];
  for (const L of layers) {
    const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n.layer === L).sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
    if (!list.length) continue;
    const rows = Math.ceil(list.length / perRow);
    bands.push({ layer: L, y, h: rows * cellH + (rows - 1) * 18 });
    list.forEach((n, i) => {
      const row = Math.floor(i / perRow); const inRow = Math.min(perRow, list.length - row * perRow);
      const step = width / (inRow + 1);
      pos.set(n.id, { x: Math.round(step * ((i % perRow) + 1)), y: y + row * (cellH + 18) + cellH / 2 });
    });
    y += rows * cellH + (rows - 1) * 18 + rowGap - cellH;
  }
  return { pos, height: Math.max(120, y), bands };
}
export const TOPO_NOTE = '링크는 **LLDP 이웃**으로 그립니다. 양쪽이 서로 본 링크는 실선, 한쪽만 본 링크 · 포트 설명으로만 가리킨 링크는 점선(추정)입니다. 층(스파인 · 리프)은 이웃 구성으로 **자동 추정**한 것입니다. 스위치가 아닌 이웃(서버 등)은 장비 아래 개수로만 보입니다.';
export const MISMATCH_NOTE = '두 끝 포트를 모두 아는 링크만 비교합니다(속도 · MTU · Duplex · 관리 상태 · 포트 채널 소속 · 설명이 가리키는 상대). 한쪽 값을 못 읽었으면 다름이 아니라 **비교 못 함**입니다.';

/* ── ① 위치 찾기 ───────────────────────────────────────────────────────────────────────────────────────── */
export const LOCATE_EXAMPLES = Object.freeze(['00:50:56:aa:bb:cc', '10.20.30.40', 'esx-01', 'web-01']);
export function macText(m) {
  const h = String(m ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return h.length === 12 ? h.match(/../g).join(':') : (m || '—');
}
export function sourceText(src) {
  const s = Array.isArray(src) ? src : [];
  return s.map((x) => (x === 'fdb' ? 'MAC 테이블' : x === 'cvp' ? 'CVP 위치' : x)).join(' + ') || '—';
}
export function transitBasis(r, manyMacs) {
  if (r.basis === 'lldp') return '이웃이 CVP 스위치(LLDP)';
  if (r.basis === 'macs') return `이 포트가 배운 MAC ${numText(r.portMacs)}개 ≥ ${manyMacs} — 업링크로 추정`;
  return '—';
}
export const LOCATE_NOTE = 'MAC 은 스위치 **MAC 테이블**과 **CVP 위치(EndpointLocation)** 로, IP 와 이름은 **vCenter 인벤토리**의 VM · 호스트 MAC 으로 풉니다(스위치 ARP 표는 수집하지 않습니다). 답은 이웃이 스위치가 아닌 **가장자리 포트**이고, 스위치 사이 포트는 ‘지나는 곳’ 으로 따로 둡니다. 찾지 못함은 없다는 뜻이 아닙니다 — MAC 테이블을 읽은 장비 수를 함께 봅니다.';

/* ── ⑬ 작업 전후 비교 ──────────────────────────────────────────────────────────────────────────────────── */
export const CHANGE_KIND = Object.freeze({ device: '장비', port: '포트', bgp: 'BGP', xcvr: '트랜시버', lldp: 'LLDP 이웃' });
const PORT_FIELD = Object.freeze({ oper: '링크', admin: '관리 상태', speed: '속도', vlan: 'VLAN', lag: '포트 채널', desc: '설명', mtu: 'MTU', added: '새로 생김', removed: '사라짐' });
const NA_TEXT = Object.freeze({ ports: '포트', bgp: 'BGP', xcvr: '트랜시버', lldp: 'LLDP' });
export function changeLabel(c) {
  if (c.kind === 'device') return c.field === 'version' ? 'EOS 버전' : c.field;
  if (c.kind === 'port') return `${c.item} · ${PORT_FIELD[c.field] || c.field}`;
  if (c.kind === 'bgp') return `피어 ${c.item.split('|').slice(1).join('|')}(${c.item.split('|')[0]}) · ${c.field === 'state' ? '상태' : c.field === 'added' ? '새로 생김' : '사라짐'}`;
  if (c.kind === 'xcvr') return `${c.item} · ${c.field === 'pulled' ? '뽑힘' : c.field === 'inserted' ? '꽂힘' : '종류 바뀜'}`;
  if (c.kind === 'lldp') return `${c.item} · 이웃`;
  return `${c.kind} ${c.item}`;
}
export function changeValue(c, side) {
  const v = side === 'before' ? c.before : c.after;
  if (c.kind === 'port' && c.field === 'speed') return v == null ? '—' : speedText(v);
  if (c.kind === 'port' && (c.field === 'added' || c.field === 'removed')) return '';
  return v == null || v === '' ? '—' : String(v);
}
export const naText = (na) => (Array.isArray(na) && na.length ? `비교 못 함: ${na.map((x) => NA_TEXT[x] || x).join(' · ')}(한쪽 또는 양쪽이 못 읽음)` : '');
export const COMPARE_NOTE = '스냅샷은 그 시각 **중앙 DB 의 최신값 복사**입니다(장비에 다시 접속하지 않습니다). 버전 · 포트(링크 · 관리 상태 · 속도 · VLAN · 채널 · 설명 · MTU) · BGP 피어 상태 · 트랜시버 · LLDP 이웃을 비교하고, 한쪽이 못 읽은 묶음은 ‘비교 못 함’ 으로 따로 둡니다.';
export const bytesText = (n) => { const v = numOrNull(n); return v == null ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(v / 1e3))} KB`; };

/* ── 탭 묶음(v3.38 — 시안 §2 '네 묶음') ─────────────────────────────────────────────────────────────────── */
export const TAB_GROUPS = Object.freeze([
  { name: '현황', tabs: [['overview', 'Overview'], ['devices', '장비'], ['models', '모델'], ['traffic', '트래픽'], ['power', '전력'], ['events', '이벤트']] },
  { name: '포트 · 링크', tabs: [['intf', '인터페이스 세부 정보'], ['portmap', '포트 구성도'], ['ports', '포트 사용량'], ['optics', '광신호'], ['linkq', '링크 품질'], ['redundancy', '이중화']] },
  { name: '연결', tabs: [['topology', '토폴로지'], ['locate', '위치 찾기']] },
  { name: '변경 · 준수', tabs: [['compare', '작업 전후 비교'], ['compliance', '버전 준수']] },
  { name: '', tabs: [['settings', 'CVP 설정']] },
]);
export const TAB_KEYS = Object.freeze(TAB_GROUPS.flatMap((g) => g.tabs.map((t) => t[0])));

/** 작은 추이선 좌표(SVG path d) — 값 null 은 선을 끊는다. */
export function sparkPath(points, { w = 120, h = 28, min = null, max = null } = {}) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p));
  const vals = pts.map((p) => numOrNull(p[1])).filter((v) => v != null);
  if (!vals.length || pts.length < 2) return '';
  const lo = min ?? Math.min(...vals); const hi = max ?? Math.max(...vals);
  const span = hi - lo || 1;
  const x0 = pts[0][0]; const x1 = pts[pts.length - 1][0]; const xs = x1 - x0 || 1;
  let d = ''; let pen = false;
  for (const [t, v0] of pts) {
    const v = numOrNull(v0);
    if (v == null) { pen = false; continue; }
    const x = ((t - x0) / xs) * w; const y = h - ((v - lo) / span) * h;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

/* ── v3.40 장비 상세 › 포트 — 칸이 전부 빈 이유(사용자 실장비 캡처: 속도 · VLAN · LAG · 수신 · 송신 · 오류가 전부 '—') ─────────────── */
const blank = (v) => v == null || v === '';
const listText = (a) => (Array.isArray(a) && a.length ? a.slice(0, 24).join(', ') : '');
/**
 * 포트 표에서 **모든 행이 비어 있는 칸**마다 이유 한 줄. 근거는 그 CVP 의 수집 상태(usedPaths · missing · seenFields — CVP 단위다).
 *   단정하지 않는다: '응답에서 찾지 못함'(필드 이름 후보가 안 맞음 — 추정) · '경로를 읽지 못함'(사유 원문) · '아직 읽지 않음'(새 항목).
 * @returns {Array<{ col:string, text:string }>}
 */
export function emptyColumnNotes(ports, { usedPaths = {}, missing = {}, seenFields = {} } = {}) {
  const list = (Array.isArray(ports) ? ports : []).filter((p) => p && typeof p === 'object' && !/^management/i.test(String(p.name || '')));
  if (!list.length) return [];
  const up = list.filter((p) => p.oper === 'up');
  const out = [];
  const seen = (k) => listText(seenFields[k]);
  if (list.every((p) => blank(p.speedBps))) {
    out.push({ col: '속도', text: `인터페이스 응답에서 속도 필드를 찾지 못했습니다(필드 이름 후보가 이 장비와 맞지 않는 것으로 추정)${seen('interfaces') ? ` — 응답에 있던 필드: ${seen('interfaces')}` : ''}. 사용률(%)도 속도를 알아야 계산합니다.` });
  }
  if (up.length && up.every((p) => blank(p.inBps) && blank(p.outBps))) {
    const t = missing.counters ? `카운터 경로를 읽지 못했습니다 — ${String(missing.counters).slice(0, 200)}`
      : usedPaths.counters ? `카운터는 읽었지만(${usedPaths.counters}) 이 장비 포트와 이름이 맞지 않거나, 처리량을 낼 직전 표본이 아직 없습니다${seen('counters') ? ` — 응답에 있던 필드: ${seen('counters')}` : ''}`
        : '카운터를 읽은 기록이 없습니다';
    out.push({ col: '수신 · 송신 · 오류', text: `${t}.` });
  }
  const cfg = (kind, col) => {
    if (missing[kind]) return `${col} 경로를 읽지 못했습니다 — ${String(missing[kind]).slice(0, 200)}.`;
    if (usedPaths[kind]) return `${col} 경로는 읽었지만(${usedPaths[kind]}) 이 장비 포트에 값이 없습니다${seen(kind) ? ` — 응답에 있던 필드: ${seen(kind)}` : ''}.`;
    return `${col}은(는) v3.40 부터 부품 주기(기본 30분)에 따로 읽습니다 — 업그레이드 뒤 첫 부품 주기가 지나면 채워집니다(경로는 실장비 미확인 추정).`;
  };
  if (list.every((p) => blank(p.vlan))) out.push({ col: 'VLAN', text: cfg('switchport', 'VLAN') });
  if (list.every((p) => blank(p.lag))) out.push({ col: 'LAG', text: `${cfg('lagMember', '포트 채널 소속')} 채널에 들지 않은 포트만 있는 장비도 이 칸이 비어 있습니다.` });
  return out;
}

/* ── v3.40 ③ 버전 준수 · ⑧ 이중화 ──────────────────────────────────────────────────────────────────────── */
export const CONFIG_DEFS = Object.freeze({ ok: ['준수', TONE.green], warn: ['불일치', TONE.amber], bad: ['오류', TONE.red], unknown: ['값 없음', 'var(--text-dim)'], unread: ['못 읽음', 'var(--text-dim)'] });
export const BUG_DEFS = Object.freeze({ high: ['높음', TONE.red], low: ['낮음', TONE.amber], none: ['공지 없음', TONE.green], unread: ['못 읽음', 'var(--text-dim)'] });
export const LIFE_DEFS = Object.freeze({ passed: ['지원 종료 지남', TONE.red], soon: ['곧 종료', TONE.amber], ok: ['지원 중', TONE.green], none: ['공지 없음', 'var(--text-dim)'], unread: ['못 읽음', 'var(--text-dim)'] });
export function bugText(b) {
  if (!b || b.state === 'unread') return '—';
  if (b.state === 'none') return '노출 없음';
  const parts = [];
  if (b.bugCount != null) parts.push(`버그 ${b.bugCount}`);
  if (b.cveCount != null) parts.push(`CVE ${b.cveCount}`);
  return `${parts.join(' · ') || '노출 있음'}${b.acknowledged ? ' (확인함)' : ''}`;
}
export function lifeText(l, now = Date.now()) {
  if (!l || l.state === 'unread') return '—';
  if (l.state === 'none') return '날짜 없음';
  const d = daysFrom(l.first, now);
  const which = l.first === l.swEnd ? '소프트웨어' : '하드웨어';
  return `${which} ${dateText(l.first)}${d == null ? '' : d < 0 ? `(${-d}일 지남)` : `(${d}일 남음)`}`;
}
export const COMPLIANCE_NOTE = '이 화면은 **CVP 가 준 값을 그대로** 보입니다 — 설정 준수(인벤토리 준수 코드) · 버그 · CVE 노출 · 수명주기(지원 종료). 포탈이 판정하거나 날짜를 지어내지 않습니다. CVP 가 그 항목을 읽었는데 장비 값이 없으면 ‘공지 없음’, 읽지 못했으면 ‘못 읽음’ 입니다.';
export const CHANNEL_DEFS = Object.freeze({ degraded: ['이중화 상실', TONE.red], down: ['전부 내려감', TONE.red], unknown: ['확인 불가', TONE.amber], ok: ['정상', TONE.green], off: ['관리상 꺼짐', 'var(--text-dim)'] });
export const MLAG_DEFS = Object.freeze({ peerDown: ['피어 링크 내려감', TONE.red], notConnected: ['협상 안 됨', TONE.red], inactive: ['비활성', TONE.amber], unknown: ['확인 불가', TONE.amber],
  ok: ['정상', TONE.green], off: ['MLAG 안 씀', 'var(--text-dim)'], unread: ['못 읽음', 'var(--text-dim)'] });
export const REDUNDANCY_NOTE = '포트 채널은 **관리상 켜진 멤버 중 링크가 올라온 수**로 봅니다 — 일부만 올라오면 이중화 상실입니다. 채널 소속 · MLAG 상태는 v3.40 부터 부품 주기에 따로 읽는 값이고 경로는 **실장비 미확인 추정**입니다. 소속을 못 읽은 장비는 ‘채널 없음’ 이 아니라 ‘소속 못 읽음’ 으로 따로 셉니다. 장애로 열지 않습니다(화면에만).';
export const channelText = (c) => `${c.up}/${c.expected}${c.total !== c.expected ? ` (꺼짐 ${c.total - c.expected})` : ''}`;
