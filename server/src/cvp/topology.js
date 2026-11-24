/**
 * cvp/topology.js — ⑥ 자동 토폴로지 · ⑦ 양끝 불일치(순수, v3.38 — docs/design/cvp-network-features §3).
 *
 * 링크:
 *  · both(실선)  — A 포트의 LLDP 이웃이 CVP 스위치 B 이고, B 쪽 그 포트의 LLDP 이웃도 A(포트까지 맞음).
 *  · one(점선 '추정') — 한쪽만 본 링크(상대 LLDP 를 못 읽었거나 상대 포트에 그 이웃이 없음).
 *  · desc(점선 '추정') — LLDP 없이 **포트 설명**이 다른 스위치 이름을 가리키고 링크가 올라와 있음.
 * 층(자동 추정 — 화면이 '추정' 이라고 말한다): 스위치 아닌 이웃(서버 등)이 있으면 leaf · 없고 스위치 이웃 2대 이상이면 spine · 스위치 이웃 1대면 other · 0대면 isolated.
 * 양끝 불일치는 **두 끝 포트를 다 아는 링크**(both · one 중 상대 포트를 LLDP portId 로 아는 것)만 — 속도 · MTU · Duplex · 관리 상태 · 포트 채널 소속 · 설명이 가리키는 상대.
 *   한쪽 값을 못 읽었으면 '비교 못 함'(na)이다 — 다름으로 세지 않는다.
 */
import { deviceNameFromDesc } from './portmap.js';

const devKey = (a, c, k) => `${a}\u0000${c}\u0000${k}`;
const lc = (s) => String(s ?? '').trim().toLowerCase();
const shortOf = (s) => lc(s).split('.')[0];

/** 인터페이스 이름 정규화 — 'Ethernet1/1' = 'Et1/1' = 'ethernet 1/1'. 포트 채널 'Port-Channel10' = 'Po10'. */
export function normPort(s) {
  const t = lc(s).slice(0, 64).replace(/\s+/g, '');
  return t.replace(/^ethernet/, 'et').replace(/^port-channel/, 'po').replace(/^management/, 'ma');
}

/**
 * 스위치 이름 색인 — 전체 이름(소문자) 우선, 짧은 이름(첫 점 앞)은 **하나뿐일 때만**(같은 짧은 이름이 둘이면 맞추지 않는다 — 다른 법인 동명 장비).
 * @param {Array<{agent,cvpId,key,hostname}>} devices
 */
export function switchIndex(devices = []) {
  const full = new Map(); const short = new Map();
  for (const d of Array.isArray(devices) ? devices : []) {
    const id = devKey(d.agent, d.cvpId, d.key);
    const f = lc(d.hostname);
    if (f) { if (!full.has(f)) full.set(f, id); }
    const s = shortOf(d.hostname);
    if (s.length >= 3) short.set(s, short.has(s) && short.get(s) !== id ? null : id);
  }
  return {
    /** 이웃 이름 → 스위치 id 또는 null. */
    find(name) {
      const f = lc(name);
      if (!f) return null;
      if (full.has(f)) return full.get(f);
      const s = shortOf(name);
      return s.length >= 3 ? (short.get(s) ?? null) : null;
    },
  };
}

/** LLDP 행들 → Map(장비 id → Map(정규화 포트 → 이웃[])) */
function lldpByDev(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = devKey(r.agent, r.cvpId, r.key);
    if (!m.has(id)) m.set(id, new Map());
    const pm = m.get(id);
    const np = normPort(r.port);
    if (!pm.has(np)) pm.set(np, []);
    pm.get(np).push(r);
  }
  return m;
}

/**
 * 장비별 업링크 포트(이웃이 CVP 스위치인 포트) — 위치 찾기 · 포트 계획이 같은 판정을 쓴다.
 * @returns {Map<string, Set<string>>} 장비 id → 정규화 포트 집합
 */
export function uplinkPortsOf(lldpRows, idx) {
  const out = new Map();
  for (const r of Array.isArray(lldpRows) ? lldpRows : []) {
    const peer = idx.find(r.sysName);
    const self = devKey(r.agent, r.cvpId, r.key);
    if (!peer || peer === self) continue;
    if (!out.has(self)) out.set(self, new Set());
    out.get(self).add(normPort(r.port));
  }
  return out;
}

const duplexOf = (v) => { const s = lc(v); return !s ? null : s.includes('full') ? 'full' : s.includes('half') ? 'half' : s; };
const numOr = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) || n <= 0 ? null : n; };

/** 두 끝 포트 행을 비교 — [{ field, a, b, state:'diff'|'na' }] (같으면 넣지 않는다). */
export function compareEnds(pa, pb, { aName = '', bName = '' } = {}) {
  const out = [];
  const cmp = (field, a, b) => {
    if (a == null || b == null) { out.push({ field, a: a ?? null, b: b ?? null, state: 'na' }); return; }
    if (a !== b) out.push({ field, a, b, state: 'diff' });
  };
  if (!pa || !pb) return [{ field: 'port', a: pa ? pa.port : null, b: pb ? pb.port : null, state: 'na' }];
  cmp('speed', numOr(pa.speedBps), numOr(pb.speedBps));
  cmp('mtu', numOr(pa.mtu), numOr(pb.mtu));
  cmp('duplex', duplexOf(pa.duplex), duplexOf(pb.duplex));
  const adm = (v) => (v === 'up' || v === 'down' ? v : null);
  cmp('admin', adm(pa.admin), adm(pb.admin));
  // 포트 채널 소속: 한쪽만 채널에 들어 있으면 다름. 값(lag)을 못 읽은 것과 '소속 없음('')' 을 가른다.
  const inLag = (p) => (p.lag == null ? null : String(p.lag).trim() ? 'yes' : 'no');
  cmp('lag', inLag(pa), inLag(pb));
  // 설명이 가리키는 상대: 설명에서 뽑은 장비 이름이 있고, 그것이 실제 상대(B) 이름과 다르면 다름. 이름을 못 뽑으면 비교하지 않는다(na 도 아님).
  for (const [side, p, peerName] of [['a', pa, bName], ['b', pb, aName]]) {
    if (p.desc == null) continue;
    const named = deviceNameFromDesc(p.desc);
    if (!named || !peerName) continue;
    const ok = lc(named) === lc(peerName) || shortOf(named) === shortOf(peerName);
    if (!ok) out.push({ field: side === 'a' ? 'descA' : 'descB', a: side === 'a' ? named : peerName, b: side === 'a' ? peerName : named, state: 'diff' });
  }
  return out;
}

/**
 * @param {{ devices:Array<{agent,cvpId,key,hostname,model,corpName?}>, lldp:Array, lldpMeta:Map<string,{at,failing}>, ports:Array<{agent,cvpId,key,port,oper,admin,speedBps,mtu,duplex,lag,desc}>, hostNames?:Set<string> }} a
 *   hostNames: 가상화 호스트 짧은 이름(소문자) — 스위치 아닌 이웃의 종류(ESXi)를 가른다.
 */
export function buildTopology({ devices = [], lldp = [], lldpMeta = new Map(), ports = [], hostNames = new Set() } = {}) {
  const idx = switchIndex(devices);
  const byId = new Map(devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d]));
  const nb = lldpByDev(lldp);
  const portRow = new Map();
  for (const p of Array.isArray(ports) ? ports : []) portRow.set(`${devKey(p.agent, p.cvpId, p.key)}\u0000${normPort(p.port)}`, p);
  const links = new Map();
  const others = new Map();   // 장비 id → { esxi, other } (스위치 아닌 이웃 수 — 이름 기준 중복 제거)
  const otherNames = new Map();
  const addOther = (id, name) => {
    if (!otherNames.has(id)) otherNames.set(id, new Set());
    const s = otherNames.get(id); const n = shortOf(name);
    if (!n || s.has(n)) return;
    s.add(n);
    if (!others.has(id)) others.set(id, { esxi: 0, other: 0 });
    others.get(id)[hostNames.has(n) ? 'esxi' : 'other']++;
  };
  for (const [aId, pm] of nb) {
    for (const [aPort, list] of pm) {
      for (const r of list) {
        const bId = idx.find(r.sysName);
        if (!bId) { if (String(r.sysName || '').trim()) addOther(aId, r.sysName); continue; }
        if (bId === aId) continue;
        const bPort = r.portId ? normPort(r.portId) : null;
        // 맞은편 확인: B 의 그 포트(또는 B 전체)에 A 를 가리키는 이웃이 있나
        const bMap = nb.get(bId);
        const back = bMap && bPort ? (bMap.get(bPort) || []).find((x) => idx.find(x.sysName) === aId && (!x.portId || normPort(x.portId) === aPort)) : null;
        const kind = back ? 'both' : 'one';
        const ends = [[aId, aPort], [bId, bPort || '?']].sort((x, y) => (x[0] + x[1] < y[0] + y[1] ? -1 : 1));
        const lk = ends.map((e) => `${e[0]}\u0000${e[1]}`).join('\u0001');
        const prev = links.get(lk);
        if (prev && prev.kind === 'both') continue;
        links.set(lk, { a: aId, aPort, b: bId, bPort, kind, bLldpRead: !!(lldpMeta.get(bId)?.at != null) });
      }
    }
  }
  // 설명만으로 가리킨 링크(LLDP 이웃이 없는 · 링크가 올라온 포트) — 이미 링크 끝인 포트는 건너뛴다(끝 집합으로 — 링크 수만큼 훑지 않게).
  const usedEnds = new Set();
  for (const l of links.values()) { usedEnds.add(`${l.a}\u0000${l.aPort}`); if (l.bPort) usedEnds.add(`${l.b}\u0000${l.bPort}`); }
  for (const p of Array.isArray(ports) ? ports : []) {
    if (p.oper !== 'up' || p.desc == null) continue;
    const aId = devKey(p.agent, p.cvpId, p.key);
    const np = normPort(p.port);
    if (nb.get(aId)?.has(np)) continue;
    const named = deviceNameFromDesc(p.desc);
    const bId = named ? idx.find(named) : null;
    if (!bId || bId === aId) continue;
    const lk = `${aId}\u0000${np}\u0001desc\u0000${bId}`;
    if (usedEnds.has(`${aId}\u0000${np}`)) continue;
    usedEnds.add(`${aId}\u0000${np}`);
    links.set(lk, { a: aId, aPort: np, b: bId, bPort: null, kind: 'desc', bLldpRead: !!(lldpMeta.get(bId)?.at != null) });
  }
  // 층 추정
  const swNb = new Map();
  for (const l of links.values()) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) { if (!swNb.has(x)) swNb.set(x, new Set()); swNb.get(x).add(y); }
  }
  const nodes = devices.map((d) => {
    const id = devKey(d.agent, d.cvpId, d.key);
    const deg = swNb.get(id)?.size || 0;
    const oth = others.get(id) || { esxi: 0, other: 0 };
    const m = lldpMeta.get(id);
    const layer = oth.esxi + oth.other > 0 ? 'leaf' : deg >= 2 ? 'spine' : deg === 1 ? 'other' : 'isolated';
    return { id, agent: d.agent, cvpId: d.cvpId, key: d.key, hostname: d.hostname || d.key, model: d.model || '', corpName: d.corpName || '',
      layer, switchNeighbors: deg, esxi: oth.esxi, otherNeighbors: oth.other, lldpRead: !!(m && m.at != null), lldpAt: m?.at ?? null, lldpFailing: !!m?.failing };
  });
  // 링크 출력 + 불일치
  const out = [];
  const counts = { both: 0, one: 0, desc: 0, diff: 0, na: 0, compared: 0 };
  for (const l of links.values()) {
    counts[l.kind]++;
    const da = byId.get(l.a); const db = byId.get(l.b);
    const pa = portRow.get(`${l.a}\u0000${l.aPort}`) || null;
    const pb = l.bPort ? portRow.get(`${l.b}\u0000${l.bPort}`) || null : null;
    let items = null;
    if (l.kind !== 'desc' && l.bPort) {
      items = compareEnds(pa, pb, { aName: da?.hostname || '', bName: db?.hostname || '' });
      counts.compared++;
      if (items.some((x) => x.state === 'diff')) counts.diff++;
      else if (items.some((x) => x.state === 'na')) counts.na++;
    }
    out.push({ a: l.a, b: l.b, aName: da?.hostname || '', bName: db?.hostname || '', aPort: pa?.port || l.aPort, bPort: pb?.port || l.bPort || null,
      kind: l.kind, bLldpRead: l.bLldpRead, oper: pa ? pa.oper : null, speedBps: pa ? (pa.speedBps ?? null) : null, items });
  }
  out.sort((x, y) => (x.aName + x.aPort).localeCompare(y.aName + y.aPort));
  return { nodes, links: out, counts, lldpReadDevices: nodes.filter((n) => n.lldpRead).length };
}
