/**
 * cvp/portmap.js — CVP › 포트 구성도(v3.37 — 설계 docs/design/cvp-port-map/README.md). **순수 모듈**(DB · 네트워크 0).
 *
 *  ① 모델별 전면 배치표(faceplateFor) — 사진으로 확인한 모델만 표에 둔다(README §5.1). 없는 모델은 포트 번호 규칙(source:'rule')으로 그리고 화면이 그렇게 말한다.
 *  ② 포트 분류(classifyPort) — 사용 · 확인 필요 · 예비(GBIC 꽂힘 / 빈 케이지 / 구리 / GBIC 모름) · 관리상 꺼짐 · 확인 불가.
 *     **못 읽은 값은 예비로 세지 않는다**: 링크 없는 포트의 설명을 못 읽었으면(null) 예비인지 '확인 필요' 인지 모른다 → 확인 불가.
 *  ③ 연결 근거(evidenceOf) — 포트 설명(주석)과 LLDP 이웃(v2.924 수집 · l2_lldp)을 대조한다. 판정은 이 파일 하나(웹은 그리기만 한다).
 *
 * ⚠ 정직: LLDP 경로는 v2.924 의 추정 경로다(실장비 미확인). 7504N 라인카드 안의 번호 배치는 그림에서 읽히지 않아 번호 규칙(16개씩)으로 그린다(cardRule).
 */

import { numOrNull } from '../util/numOrNull.js';

/* ── ① 모델별 전면 배치표 ─────────────────────────────────────────────────────────────────────────────────────── */

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** 모델 이름 정규화 — 'DCS-7050SX3-48YC8-F' → '7050SX3-48YC8'(접두 DCS-/CCS- · 공기 흐름/전원 접미를 뗀다). */
export function normModel(model) {
  let s = String(model ?? '').trim().toUpperCase().slice(0, 64);
  s = s.replace(/^(DCS|CCS)-/, '');
  for (let i = 0; i < 3; i++) { const t = s.replace(/-(F|R|D|DC|AC|SSD|M|E|CL)$/, ''); if (t === s) break; s = t; }
  return s;
}

const SFP28 = 'SFP28'; const QSFP = 'QSFP'; const SFPP = 'SFP+'; const RJ45 = 'RJ45'; const SFP = 'SFP';
const LEDS4 = Object.freeze(['상태', '팬', 'PS1', 'PS2']);
const LEAF48 = Object.freeze({
  groups: [
    { label: '1–12 · SFP28', form: SFP28, cages: range(1, 12) },
    { label: '13–24', form: SFP28, cages: range(13, 24) },
    { label: '49–56 · QSFP100', form: QSFP, cages: range(49, 56) },
    { label: '25–36', form: SFP28, cages: range(25, 36) },
    { label: '37–48', form: SFP28, cages: range(37, 48) },
  ],
  mgmt: 'rear', leds: LEDS4,
});
/**
 * 사진(공개 NetBox devicetype-library 의 Arista 전면 · 후면 사진)으로 확인한 배치. 블록은 왼쪽 → 오른쪽 순서 그대로,
 *   블록 안은 2행 · 위에서 아래로 번호가 이어지는 열(홀수 위 ▲ 짝수 아래 ▼). mgmt = 관리 포트가 있는 면.
 */
export const FACEPLATES = Object.freeze({
  '7050SX3-48YC8': LEAF48,
  '7280SR3-48YC8': LEAF48,
  '7060CX2-32S': {
    groups: [{ label: '33–34 · SFP+', form: SFPP, cages: [33, 34] },
      ...range(0, 7).map((k) => ({ label: `${4 * k + 1}–${4 * k + 4}${k === 0 ? ' · QSFP100' : ''}`, form: QSFP, cages: range(4 * k + 1, 4 * k + 4) }))],
    mgmt: 'front', leds: LEDS4,
  },
  '7010TX-48': {
    groups: [
      { label: '1–12 · RJ45 1G', form: RJ45, cages: range(1, 12) },
      { label: '13–24', form: RJ45, cages: range(13, 24) },
      { label: '25–36', form: RJ45, cages: range(25, 36) },
      { label: '37–48', form: RJ45, cages: range(37, 48) },
      { label: '49–52 · SFP', form: SFP, cages: range(49, 52) },
    ],
    mgmt: 'front', leds: Object.freeze(['상태', '팬', 'PS']),
  },
  // 모듈형: 위에 수퍼바이저 2칸 · 아래 라인카드(슬롯 3~6 — 섀시 그림. 슬롯 번호 글자는 판독 불가 — 추정). 카드 안은 번호 규칙(cardRule).
  '7504N': { modular: true, supervisors: 2, mgmt: 'supervisor', leds: Object.freeze([]) },
});

/** 모듈형 모델(이름 규칙) — 7300 · 7500 · 7800 계열. 배치표에 없는 모델에만 쓴다. */
export const isModularModel = (model) => /^7(3\d\d|5\d\d|8\d\d)(?![0-9])/.test(normModel(model));

/** 포트 이름 → { slot, cage, lane, mgmt }. 'Ethernet12' · 'Ethernet49/1' · 'Ethernet3/17' · 'Ethernet3/1/2' · 'Management1'. 못 읽으면 null. */
export function portAddr(name, modular = false) {
  const s = String(name ?? '').slice(0, 64);
  if (/^management\d/i.test(s)) return { mgmt: true, slot: null, cage: Number(s.replace(/^\D+/, '').split('/')[0]) || 1, lane: null };
  const m = /^(?:ethernet|et)(\d{1,3})(?:\/(\d{1,3}))?(?:\/(\d{1,2}))?$/i.exec(s);
  if (!m) return null;
  const a = Number(m[1]); const b = m[2] == null ? null : Number(m[2]); const c = m[3] == null ? null : Number(m[3]);
  if (modular) return b == null ? null : { mgmt: false, slot: a, cage: b, lane: c };
  return { mgmt: false, slot: null, cage: a, lane: b };
}

const formOfSpeed = (bps) => { const n = Number(bps); return !Number.isFinite(n) || n <= 0 ? null : n >= 40e9 ? QSFP : n >= 10e9 ? SFP28 : SFP; };
/** 번호 규칙 — 칸 번호 순서로 12개씩(폼이 바뀌면 새 블록). cages: [{cage, form}]. */
function ruleGroups(cages, chunk = 12) {
  const sorted = [...cages].sort((a, b) => a.cage - b.cage);
  const out = []; let cur = null;
  for (const c of sorted) {
    if (!cur || cur.cages.length >= chunk || (c.form && cur.form && c.form !== cur.form)) { cur = { form: c.form || null, cages: [] }; out.push(cur); }
    if (!cur.form && c.form) cur.form = c.form;
    cur.cages.push(c.cage);
  }
  return out.map((g) => ({ label: `${g.cages[0]}–${g.cages[g.cages.length - 1]}${g.form ? ` · ${g.form}` : ''}`, form: g.form, cages: g.cages }));
}

/**
 * 장비의 전면 배치. ports: [{ name, speedBps }].
 * @returns {{ model, source:'model'|'rule', modular:boolean, mgmt:'rear'|'front'|'supervisor'|null, leds:string[], groups?:Array, slots?:Array, cardRule?:boolean, extra?:string[] }}
 *   extra = 배치표에 없는데 수집된 포트(브레이크아웃이 아닌 이름 · 배치표 밖 번호) — 화면이 '배치표 밖 포트' 로 따로 그린다.
 */
export function faceplateFor(model, ports = []) {
  const key = normModel(model);
  const fp = FACEPLATES[key];
  const list = Array.isArray(ports) ? ports.slice(0, 4096) : [];
  const modular = fp ? !!fp.modular : isModularModel(model);
  const base = { model: key || null, source: fp ? 'model' : 'rule', modular, mgmt: fp ? fp.mgmt : null, leds: fp ? [...fp.leds] : [] };
  const cageForm = new Map();
  const slotCages = new Map();
  const extra = [];
  for (const p of list) {
    const a = portAddr(p && p.name, modular);
    if (!a) { if (p && p.name) extra.push(String(p.name).slice(0, 64)); continue; }
    if (a.mgmt) continue;
    const form = formOfSpeed(p.speedBps);
    if (modular) {
      if (!slotCages.has(a.slot)) slotCages.set(a.slot, new Map());
      const m = slotCages.get(a.slot); if (!m.has(a.cage) || (!m.get(a.cage) && form)) m.set(a.cage, form);
    } else if (!cageForm.has(a.cage) || (!cageForm.get(a.cage) && form)) cageForm.set(a.cage, form);
  }
  if (modular) {
    const slots = [...slotCages.keys()].sort((a, b) => a - b).slice(0, 32).map((slot) => ({
      slot, label: `슬롯 ${slot}`,
      groups: ruleGroups([...slotCages.get(slot)].map(([cage, form]) => ({ cage, form })), 16),
    }));
    return { ...base, slots, cardRule: true, supervisors: fp ? fp.supervisors : null, extra: extra.slice(0, 64) };
  }
  if (fp) {
    const known = new Set(fp.groups.flatMap((g) => g.cages));
    for (const c of cageForm.keys()) if (!known.has(c)) extra.push(`Ethernet${c}`);
    return { ...base, groups: fp.groups.map((g) => ({ label: g.label, form: g.form, cages: [...g.cages] })), extra: extra.slice(0, 64) };
  }
  return { ...base, groups: ruleGroups([...cageForm].map(([cage, form]) => ({ cage, form }))), extra: extra.slice(0, 64) };
}
/** 그 칸이 구리(RJ45) 포트인가 — 배치표로만 안다(번호 규칙 장비는 모른다 → false). */
export function isCopperCage(fp, cage) {
  if (!fp || fp.source !== 'model' || !Array.isArray(fp.groups)) return false;
  return fp.groups.some((g) => g.form === RJ45 && g.cages.includes(cage));
}

/* ── ② 트랜시버 · 포트 분류 ───────────────────────────────────────────────────────────────────────────────────── */

const INTF_SEG = /^(ethernet|et|management)[\d/]+$/i;
/** 부품 이름(`xcvr › Ethernet49 › …`)에서 인터페이스 이름 — 웹 cvpIntfText.intfOfPartName 과 같은 규칙(테스트가 대조). */
export function intfOfPartName(name) {
  const seg = String(name || '').slice(0, 256).split(' › ').map((x) => x.trim()).find((x) => INTF_SEG.test(x));
  return seg || null;
}
/** 부품 목록 → Map(인터페이스 → { present, type }) 또는 null(트랜시버 목록을 못 읽음) — 웹 xcvrMapOf 와 같은 결과(테스트가 대조). */
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
/** 포트의 트랜시버 — 브레이크아웃 포트(Ethernet49/1)는 칸 이름(Ethernet49)으로도 찾는다. */
function xcvrOf(xm, name) {
  if (!xm) return undefined;
  if (xm.has(name)) return xm.get(name);
  const base = String(name).replace(/\/\d+$/, '');
  return base !== name && xm.has(base) ? xm.get(base) : null;
}

export const SUB_KEYS = Object.freeze(['use', 'check', 'spareX', 'spareE', 'spareC', 'spareU', 'off', 'unknown']);
export const SPARE_KEYS = Object.freeze(['spareX', 'spareE', 'spareC', 'spareU']);
const isSpare = (s) => SPARE_KEYS.includes(s);

/**
 * 포트 분류.
 *  · admin 'down'(관리상 꺼짐)                             → off
 *  · oper 'up'                                            → use
 *  · oper 를 모름                                          → unknown(확인 불가)
 *  · 링크 없음 + 설명 못 읽음(null)                          → unknown — 예비로 세지 않는다
 *  · 링크 없음 + 설명 있음                                   → check(끊겼거나 연결 예정)
 *  · 링크 없음 + 설명 없음('') + 관리상 켜짐/모름               → 예비: 구리(배치표) · GBIC 꽂힘 · 빈 케이지 · GBIC 모름(트랜시버 목록 못 읽음 · 목록에 없음)
 * @param {{oper?:string, admin?:string, desc?:string|null}} p
 * @param {{xcvr?:{present:boolean}|null|undefined, copper?:boolean}} ctx  xcvr: undefined = 트랜시버 목록 못 읽음 · null = 목록에 그 포트 없음
 */
export function classifyPort(p, { xcvr, copper = false } = {}) {
  if (!p) return 'unknown';
  if (p.admin === 'down') return 'off';
  if (p.oper === 'up') return 'use';
  if (p.oper !== 'down' && p.oper !== 'nolink') return 'unknown';
  if (p.desc == null) return 'unknown';
  if (String(p.desc).trim()) return 'check';
  if (copper) return 'spareC';
  if (xcvr === undefined || xcvr === null) return 'spareU';
  return xcvr.present ? 'spareX' : 'spareE';
}

/* ── ③ 연결 근거 ──────────────────────────────────────────────────────────────────────────────────────────────── */

// v3.42(버그 점검 1회차 A1-10): 끝까지 앵커 — 접두 뒤가 숫자(· / . :)뿐일 때만 인터페이스. 예전 '^(접두)\d*' 는 TESTDB01 · HUB01 · POD1LEAF01 같은
//   호스트 이름을 인터페이스로 보고 뒤 낱말(vlan100 등)을 장비로 골랐다. 'port-channel10' 은 하이픈 때문에 장비 이름으로 새던 것도 막는다.
//   v3.42(2회차 A1-F7): 리눅스 NIC 예측 이름(ens1f0 · eno1np0 · enp59s0f0np0 · ens2f1d1)도 인터페이스로 — 끝 앵커가 그 꼴을 놓쳐 장비 이름으로 봤다.
const IFNAME = /^(?:(?:et|eth|ethernet|gi|te|fa|hu|po|port-channel|vmnic|bond|nic|vlan)[\d/.:]+|(?:ens|eno|enp)\d+(?:s\d+)?(?:f\d+)?(?:np\d+|d\d+)?|p\d+p\d+)$/i;
/** 설명을 낱말로(소문자) — 길이를 먼저 자르고 문자 하나짜리 구분자로 나눈다(선형). */
export function descTokens(desc) {
  // v3.42(A1-10): '/' 로도 나누고(spine1/Et1), '_' 가 든 낱말은 조각도 더한다(svr-01_eth0 → svr-01).
  const out = [];
  for (const t of String(desc ?? '').slice(0, 200).toLowerCase().split(/[\s,;|()[\]<>"'=:/]+/)) {
    if (t.length < 3 || t.length > 64) continue;
    out.push(t);
    if (t.includes('_')) for (const u of t.split('_')) if (u.length >= 3) out.push(u);
  }
  return out.slice(0, 24);
}
/** 설명에서 장비 이름처럼 보이는 첫 낱말 — 하이픈 · 점 · 숫자를 품고, 인터페이스 이름(Et47 · vmnic0)은 아닌 것. 없으면 ''. */
export function deviceNameFromDesc(desc) {
  const raw = String(desc ?? '').slice(0, 200).split(/[\s,;|()[\]<>"'=:]+/);
  for (const t of raw) {
    if (t.length < 3 || t.length > 64) continue;
    if (!/^[a-z][a-z0-9_.-]*$/i.test(t)) continue;
    if (!/[-_.\d]/.test(t)) continue;
    if (IFNAME.test(t)) continue;
    return stripIfSuffix(t);
  }
  return '';
}
const shortOf = (s) => String(s ?? '').toLowerCase().split('.')[0];
/** v3.42(A1-10): 'esx01-vmnic0' · 'svr-01_eth1' 처럼 장비 이름 뒤에 인터페이스를 붙인 낱말 → 'esx01' · 'svr-01'(뒤 조각이 인터페이스 이름일 때만). */
function stripIfSuffix(t) {
  const m = /^(.{3,64}?)[-_]([a-z][a-z0-9/.:]{0,30})$/i.exec(t);
  return m && IFNAME.test(m[2]) ? m[1] : t;
}

export const EV_KEYS = Object.freeze(['match', 'mismatch', 'lldp', 'desc', 'none', 'nolink']);
/**
 * 연결 근거 — 링크가 올라온 포트만 판정한다(링크 없는 포트는 'nolink' — 이웃이 없는 것이 정상).
 * @param {{oper?:string, desc?:string|null}} p
 * @param {Array<{sysName:string}>} neighbors  그 포트의 LLDP 이웃(없으면 [])
 * @param {boolean} lldpRead  그 장비의 LLDP 목록을 읽은 적이 있나(false 면 이웃 없음을 단정하지 않는다)
 * @returns {{ ev:string, device:string, lldpUnread:boolean }}
 */
export function evidenceOf(p, neighbors = [], lldpRead = false) {
  const descDev = deviceNameFromDesc(p && p.desc);
  const names = (Array.isArray(neighbors) ? neighbors : []).filter((n) => n && String(n.sysName || '').trim()).slice(0, 16).map((n) => String(n.sysName).trim().slice(0, 128));
  const lldpDev = names[0] || '';
  if (!p || p.oper !== 'up') return { ev: 'nolink', device: lldpDev || descDev, lldpUnread: !lldpRead };
  const hasDesc = !!String(p.desc ?? '').trim();
  if (lldpDev) {
    if (!hasDesc) return { ev: 'lldp', device: lldpDev, lldpUnread: false };
    const toks = descTokens(p.desc);
    // v3.42(A1-09): 이웃이 여럿이면(허브 · 가상 스위치 뒤) 하나라도 설명과 맞으면 일치 — 그 이웃을 보여 준다.
    const hitName = names.find((nm) => { const lc = nm.toLowerCase(); const sh = shortOf(nm); return sh.length >= 3 && toks.some((t) => { const u = stripIfSuffix(t); return t === lc || t === sh || shortOf(t) === sh || u === lc || shortOf(u) === sh; }); });
    return { ev: hitName ? 'match' : 'mismatch', device: hitName || lldpDev, lldpUnread: false };
  }
  if (hasDesc) return { ev: 'desc', device: descDev, lldpUnread: !lldpRead };
  return { ev: 'none', device: '', lldpUnread: !lldpRead };
}

/* ── 장비 하나 묶기 ───────────────────────────────────────────────────────────────────────────────────────────── */

const emptyCounts = () => Object.fromEntries([['total', 0], ...SUB_KEYS.map((k) => [k, 0])]);
/** 분류 결과 → 개수(관리 포트 제외). spare = 네 종류 합. */
export function countSubs(rows) {
  const c = emptyCounts();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.mgmt) continue;
    c.total++;
    if (Object.hasOwn(c, r.sub)) c[r.sub]++;
  }
  c.spare = SPARE_KEYS.reduce((s, k) => s + c[k], 0);
  return c;
}
const speedKey = (bps) => { const n = Number(bps); if (!Number.isFinite(n) || n <= 0) return null; return n >= 1e9 ? `${Math.round(n / 1e8) / 10}G` : `${Math.round(n / 1e6)}M`; };
/** 속도별 개수 — 속도를 모르는 포트는 null 칸(‘속도 모름’). */
export function countBySpeed(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.mgmt) continue;
    const k = speedKey(r.speedBps);
    if (!m.has(k)) m.set(k, { speed: k, bps: Number(r.speedBps) > 0 ? Number(r.speedBps) : null, rows: [] });
    m.get(k).rows.push(r);
  }
  return [...m.values()].sort((a, b) => (a.bps == null) - (b.bps == null) || (a.bps || 0) - (b.bps || 0)).map((g) => ({ speed: g.speed, counts: countSubs(g.rows) }));
}

/**
 * 장비 하나의 포트 구성도.
 * @param {{ model:string, ports:Array|null, parts:Array|null, lldp:Array<{port:string,sysName:string,portId?:string,portDesc?:string}>, lldpRead:boolean,
 *           lastLink?:Map<string,number>, switchNames?:Set<string> }} input
 */
export function buildPortMap({ model = '', ports = null, parts = null, lldp = [], lldpRead = false, lastLink = null, switchNames = null } = {}) {
  if (!Array.isArray(ports)) return { portsRead: false, faceplate: null, ports: null, counts: null, bySpeed: [] };
  const list = ports.slice(0, 4096);
  const fp = faceplateFor(model, list);
  const xm = xcvrMapOf(parts);
  const nbBy = new Map();
  for (const n of Array.isArray(lldp) ? lldp.slice(0, 2048) : []) {
    if (!n || !n.port) continue;
    if (!nbBy.has(n.port)) nbBy.set(n.port, []);
    nbBy.get(n.port).push(n);
  }
  const sw = switchNames instanceof Set ? switchNames : new Set();
  const rows = list.map((p) => {
    const a = portAddr(p.name, fp.modular);
    const mgmt = !!(a && a.mgmt);
    const x = xm == null ? undefined : xcvrOf(xm, p.name);
    const copper = !!(a && !a.mgmt && !fp.modular && isCopperCage(fp, a.cage));
    const sub = classifyPort(p, { xcvr: x, copper });
    const nbs = nbBy.get(p.name) || [];
    const e = evidenceOf(p, nbs, lldpRead);
    const nb = nbs[0] || null;
    const devShort = shortOf(e.device);
    return {
      name: String(p.name).slice(0, 64), mgmt, slot: a ? a.slot : null, cage: a ? a.cage : null, lane: a ? a.lane : null,
      sub, ev: e.ev, device: e.device || '', deviceKind: devShort && sw.has(devShort) ? 'switch' : '',
      desc: p.desc == null ? null : String(p.desc).slice(0, 200),
      lldp: nb ? { sysName: String(nb.sysName || '').slice(0, 128), portId: String(nb.portId || '').slice(0, 64), portDesc: String(nb.portDesc || '').slice(0, 128) } : null,
      lldpUnread: e.lldpUnread,
      oper: p.oper || 'unknown', admin: p.admin || 'unknown', speedBps: Number(p.speedBps) > 0 ? Number(p.speedBps) : null,
      xcvr: x === undefined ? undefined : x === null ? null : { present: x.present, type: x.type },
      copper, vlan: p.vlan || '', lag: p.lag || '',
      inUtil: p.inUtil ?? null, outUtil: p.outUtil ?? null,
      lastLinkAt: lastLink instanceof Map && lastLink.has(p.name) ? lastLink.get(p.name) : null,
    };
  });
  // 자연 순서(Ethernet2 가 Ethernet10 앞 · 관리 포트는 끝) — DB 는 글자 순으로 준다.
  const nk = (r) => [r.mgmt ? 1 : 0, r.slot ?? -1, r.cage ?? 1e9, r.lane ?? 0];
  rows.sort((x, y) => { const a = nk(x); const b = nk(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
  return { portsRead: true, faceplate: fp, ports: rows, counts: countSubs(rows), bySpeed: countBySpeed(rows), xcvrRead: xm != null, lldpRead: !!lldpRead };
}

/** 전 스위치 여유 표의 한 줄 — LLDP 없이 분류만(근거는 장비 화면에서). 100G 이상 예비는 따로 센다. */
export function summaryRow({ model = '', ports = null, parts = null } = {}) {
  if (!Array.isArray(ports)) return { portsRead: false, counts: null, spareHigh: null };
  const m = buildPortMap({ model, ports, parts });
  // v3.42(A2-F4): 속도를 못 읽은 예비가 있으면 '40G 이상 예비' 를 단정하지 않는다(0 이 아니라 null — 화면 '—') · 그 수를 따로.
  const spares = m.ports.filter((r) => !r.mgmt && isSpare(r.sub));
  const speedUnknown = spares.filter((r) => numOrNull(r.speedBps) == null || Number(r.speedBps) <= 0).length;
  const spareHigh = speedUnknown ? null : spares.filter((r) => Number(r.speedBps) >= 40e9).length;
  return { portsRead: true, counts: m.counts, spareHigh, spareSpeedUnknown: speedUnknown, source: m.faceplate.source };
}
