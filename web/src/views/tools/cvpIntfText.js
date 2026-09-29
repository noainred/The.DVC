/**
 * cvpIntfText.js — CVP › 인터페이스 세부 정보(v2.649) 순수 판정·문구.
 * 사용자 요청: CVP 'Devices › <장비> › Interfaces › Ethernet' 화면(도넛 3개 + 인터페이스 표)과 같은 화면.
 *  · 상태·속도·트랜시버 종류 도넛은 **읽은 값만** 센다. 못 읽은 값은 '확인 불가'·'속도 모름'·'종류 모름' 칸으로 따로 센다(정상에 섞지 않는다).
 *  · 트랜시버 종류는 부품(xcvr) 수집에서 온다 — 부품을 읽지 못한 장비는 '—'(없다는 뜻이 아니다).
 *  · ⚠ Duplex·Forwarding Model·MAC·MTU·트랜시버 종류 필드 이름은 실장비 미확인 추정이다(docs/CVP.md §16) — 값이 없으면 '—'.
 */

export const STATUS_DEFS = Object.freeze([
  { key: 'connected', label: '연결됨', color: '#22a447' },
  { key: 'down', label: '다운', color: '#e5322d' },
  { key: 'notconnect', label: '미연결', color: '#e8b10e' },
  { key: 'unknown', label: '확인 불가', color: '#8a94a6' },
]);
const PALETTE = ['#1f7f86', '#8a3ad6', '#233f8f', '#d9892b', '#2e9bd6', '#c2417a', '#5b8a2f', '#6f5bd3', '#b0662c', '#3a7d6b'];
const GRAY = '#8a94a6';

/** 포트 → 상태 칸(연결됨·다운·미연결·확인 불가). */
export function statusKeyOf(p) {
  const o = p && p.oper;
  if (o === 'up') return 'connected';
  if (o === 'down') return 'down';
  if (o === 'nolink') return 'notconnect';
  return 'unknown';
}
export const statusLabel = (k) => (STATUS_DEFS.find((d) => d.key === k) || STATUS_DEFS[3]).label;

/** bps → '1 Gbps'·'25 Gbps'·'100 Mbps' · 못 읽으면 null. */
export function speedLabel(bps) {
  if (bps == null || bps === '') return null;
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return null;
  const fmt = (v, u) => `${Number.isInteger(v) ? v : Math.round(v * 10) / 10} ${u}`;
  if (n >= 1e9) return fmt(n / 1e9, 'Gbps');
  if (n >= 1e6) return fmt(n / 1e6, 'Mbps');
  if (n >= 1e3) return fmt(n / 1e3, 'Kbps');
  return fmt(n, 'bps');
}

const INTF_SEG = /^(ethernet|et|management)[\d/]+$/i;
/** 부품 이름(`all › Ethernet49 › …`)에서 인터페이스 이름. */
export function intfOfPartName(name) {
  const seg = String(name || '').split(' › ').map((x) => x.trim()).find((x) => INTF_SEG.test(x));
  return seg || null;
}

/**
 * 부품 목록 → Map(인터페이스 → { type, present }) 또는 null(트랜시버 목록을 못 읽음).
 *  · 빈 슬롯(absent)은 type '미장착'(CVP 의 Not Present) · 장착됐는데 종류를 모르면 type null('종류 모름').
 */
export function xcvrMapOf(parts) {
  if (!Array.isArray(parts)) return null;
  const xs = parts.filter((p) => p && p.kind === 'xcvr');
  if (!xs.length) return null;
  const m = new Map();
  for (const p of xs) {
    const intf = intfOfPartName(p.name);
    if (!intf || m.has(intf)) continue;
    const absent = p.state === 'absent';
    m.set(intf, { present: !absent, type: absent ? '미장착' : (typeof p.media === 'string' && p.media ? p.media : null) });
  }
  return m;
}

const dash = (v) => (v == null || v === '' ? '—' : String(v));
const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const NAT = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** 인터페이스 이름 자연 순서(Ethernet2 가 Ethernet10 앞 — CVP 화면과 같은 순서). */
export const byIntfName = (a, b) => NAT.compare(String(a?.name || ''), String(b?.name || ''));

/** 화면 행(순수). ports 가 배열이 아니면 null(포트를 못 읽음). 이름 자연 순서. */
export function intfRows(ports, parts) {
  if (!Array.isArray(ports)) return null;
  const xm = xcvrMapOf(parts);
  return ports.filter((p) => p && typeof p === 'object').slice().sort(byIntfName).map((p) => {
    const st = statusKeyOf(p);
    const x = xm ? xm.get(p.name) : undefined;
    const xcvr = xm == null ? null : x ? (x.type || '종류 모름') : '트랜시버 정보 없음';
    return {
      name: String(p.name || ''),
      desc: p.desc == null ? null : String(p.desc),
      status: st,
      statusText: statusLabel(st),
      operRaw: p.operRaw || null,
      duplex: p.duplex ? (p.duplex === 'full' ? 'Full Duplex' : p.duplex === 'half' ? 'Half Duplex' : cap1(p.duplex)) : null,
      fwdModel: p.fwdModel ? cap1(p.fwdModel) : null,
      mac: p.mac || null,
      mtu: p.mtu ?? null,
      speed: speedLabel(p.speedBps),
      speedBps: p.speedBps ?? null,
      admin: p.admin || 'unknown',
      xcvr,
    };
  });
}

/** 칸 색은 칸 이름에 묶는다(개수 순위가 바뀌어도 같은 종류가 같은 색). */
function colorFor(label, used) {
  if (used.has(label)) return used.get(label);
  const c = PALETTE[used.size % PALETTE.length];
  used.set(label, c);
  return c;
}

/** 상태 도넛 — 순서 고정(연결됨·다운·미연결·확인 불가), 0 인 칸은 뺀다. */
export function statusBuckets(rows) {
  const n = new Map();
  for (const r of rows || []) n.set(r.status, (n.get(r.status) || 0) + 1);
  return STATUS_DEFS.filter((d) => n.get(d.key)).map((d) => ({ key: d.key, label: d.label, count: n.get(d.key), color: d.color }));
}

function countBuckets(rows, labelOf, unknownLabel) {
  const n = new Map();
  for (const r of rows || []) { const l = labelOf(r) || unknownLabel; n.set(l, (n.get(l) || 0) + 1); }
  const list = [...n.entries()].map(([label, count]) => ({ key: label, label, count }));
  list.sort((a, b) => (a.label === unknownLabel) - (b.label === unknownLabel) || b.count - a.count || a.label.localeCompare(b.label));
  const used = new Map();
  return list.map((b) => ({ ...b, color: b.label === unknownLabel ? GRAY : colorFor(b.label, used) }));
}
export const SPEED_UNKNOWN = '속도 모름';
export const XCVR_UNKNOWN = '종류 모름';
export const speedBuckets = (rows) => countBuckets(rows, (r) => r.speed, SPEED_UNKNOWN);
/** 트랜시버 도넛 — 트랜시버 목록을 못 읽은 장비면 null(도넛 대신 안내). */
export function xcvrBuckets(rows) {
  if (!rows || !rows.length || rows.every((r) => r.xcvr == null)) return null;
  return countBuckets(rows, (r) => (r.xcvr === '종류 모름' || r.xcvr === '트랜시버 정보 없음' ? null : r.xcvr), XCVR_UNKNOWN);
}

/** 도넛 조각(SVG stroke-dasharray) — 합이 0 이면 빈 배열. */
export function donutArcs(buckets, circumference) {
  const total = (buckets || []).reduce((a, b) => a + b.count, 0);
  if (!total) return [];
  let off = 0;
  return buckets.map((b) => {
    const len = (b.count / total) * circumference;
    const arc = { ...b, len, off };
    off += len;
    return arc;
  });
}

export const FILTER_COLS = Object.freeze(['name', 'desc', 'statusText', 'duplex', 'fwdModel', 'mac', 'mtu', 'speed', 'xcvr']);
/** 열별 필터(대소문자 무시 · 부분 일치 · 전 조건 AND). 빈 필터는 무시. */
export function filterRows(rows, filters) {
  const f = Object.entries(filters || {}).map(([k, v]) => [k, String(v || '').trim().toLowerCase()]).filter(([, v]) => v);
  if (!f.length) return rows || [];
  return (rows || []).filter((r) => f.every(([k, v]) => dash(k === 'mtu' ? r.mtu : r[k]).toLowerCase().includes(v)));
}

export const INTF_NOTE = '상태·속도는 매 수집 주기에, **설명·트랜시버 종류는 부품 주기(기본 30분)** 에 읽습니다. 못 읽은 값은 — 이고, 도넛에서는 확인 불가·속도 모름·종류 모름 칸으로 따로 셉니다. Duplex·Forwarding Model·MAC·MTU·트랜시버 종류의 텔레메트리 필드 이름은 실장비로 확인하지 못한 추정입니다.';

/** 설명 칸 — null 은 '아직 못 읽음', '' 은 '설명 없음'. */
export function descCell(desc) {
  if (desc == null) return { text: '—', title: '설명을 아직 읽지 못했습니다(부품 주기마다 읽습니다)' };
  if (desc === '') return { text: '—', title: '설명이 설정되지 않은 포트입니다' };
  return { text: desc, title: desc };
}

/** 장비 선택 목록 — 호스트명 순(숫자 인식). */
export function deviceOptions(devices) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return (Array.isArray(devices) ? devices : []).filter((d) => d && d.key && d.cvpId != null)
    .map((d) => ({ id: `${d.cvpId}|${d.key}`, cvpId: String(d.cvpId), key: String(d.key), label: d.hostname || d.key, model: d.model || '', corp: d.corpName || '' }))
    .sort((a, b) => coll.compare(a.label, b.label));
}
