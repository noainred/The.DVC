/**
 * cvp/topology.js — ⑥ 자동 토폴로지 · ⑦ 양끝 불일치(순수, v3.38 — docs/design/cvp-network-features §3).
 *
 * 링크:
 *  · both(실선)  — A 포트의 LLDP 이웃이 CVP 스위치 B 이고, B 쪽 그 포트의 LLDP 이웃도 A(포트까지 맞음).
 *  · one(점선 '추정') — 한쪽만 본 링크(상대 LLDP 를 못 읽었거나 상대 포트에 그 이웃이 없음).
 *  · desc(점선 '추정') — LLDP 없이 **포트 설명**이 다른 스위치 이름을 가리키고 링크가 올라와 있음.
 * 층(자동 추정 — 화면이 '추정' 이라고 말한다): 스위치 아닌 이웃(서버 등)이 있으면 leaf. 서버 이웃이 없는 스위치는 스위치 이웃 수로 —
 *   이웃 3대 이상이면 spine(그런 장비가 하나도 없으면 2대 이상), 이웃이 전부 spine 인 장비는 leaf(서버 LLDP 를 못 본 리프), 그 밖은 other · 0대면 isolated.
 *   (v3.38 Chromium 판독: '이웃 2대 = spine' 만으로는 서버 LLDP 가 없는 리프가 전부 스파인 줄에 올라갔다.)
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
 * 스위치 이름 색인 — 전체 이름(소문자) 우선, 없으면 짧은 이름(첫 점 앞).
 * v3.42(버그 점검 1회차 A1-06): 같은 이름 후보가 여럿이면 **LLDP 를 보고한 장비와 같은 담당 · CVP** 의 후보를 고른다(그래도 여럿이면 맞추지 않는다).
 *   예전에는 전체 이름이 겹치면 먼저 본 장비(다른 법인)로 꽂고, 짧은 이름이 겹치면 아예 버렸다.
 * @param {Array<{agent,cvpId,key,hostname}>} devices
 */
export function switchIndex(devices = []) {
  const full = new Map(); const short = new Map();
  const add = (m, k, id) => { if (!m.has(k)) m.set(k, []); const a = m.get(k); if (!a.includes(id)) a.push(id); };
  for (const d of Array.isArray(devices) ? devices : []) {
    const id = devKey(d.agent, d.cvpId, d.key);
    const f = lc(d.hostname);
    if (f) add(full, f, id);
    const s = shortOf(d.hostname);
    if (s.length >= 3) add(short, s, id);
  }
  const pickOne = (cands, from) => {
    if (!cands || !cands.length) return null;
    if (cands.length === 1) return cands[0];
    if (!from) return null;
    const pre = from.slice(0, from.lastIndexOf('\u0000') + 1);   // agent␀cvp␀
    const same = cands.filter((c) => c.startsWith(pre));
    return same.length === 1 ? same[0] : null;
  };
  return {
    /** 이웃 이름 → 스위치 id 또는 null. from = 보고한 장비 id(같은 CVP 후보를 고르는 데 쓴다). */
    find(name, from = null) {
      const f = lc(name);
      if (!f) return null;
      if (full.has(f)) return pickOne(full.get(f), from);
      const s = shortOf(name);
      return s.length >= 3 ? pickOne(short.get(s), from) : null;
    },
  };
}

/** v3.42(A1-05): 관리 포트(Management)의 LLDP 이웃은 데이터 망 연결이 아니다 — 층 추정 · 업링크 · 링크에서 뺀다. */
const isMgmtPort = (np) => /^ma/.test(np);

/**
 * v3.42(버그 점검 1회차 A1-13): LLDP 이웃이 가상화 호스트(ESXi 이름)인 포트 — 위치 찾기가 'MAC 많음 = 지나는 곳' 규칙을 이 포트에는 쓰지 않는다
 *   (VM 이 빽빽한 호스트 포트가 가장자리 답에서 빠졌다). CVP 밖 하위 스위치는 이름이 호스트 목록에 없으니 MAC 수 규칙이 그대로 잡는다.
 * @param {Array} lldpRows @param {Set<string>} hostNames 짧은 이름(소문자)
 * @returns {Map<string, Set<string>>} 장비 id → 정규화 포트 집합
 */
export function hostPortsOf(lldpRows, hostNames = new Set()) {
  const out = new Map();
  if (!hostNames || !hostNames.size) return out;
  for (const r of Array.isArray(lldpRows) ? lldpRows : []) {
    const np = normPort(r.port);
    if (isMgmtPort(np) || !hostNames.has(shortOf(r.sysName))) continue;
    const self = devKey(r.agent, r.cvpId, r.key);
    if (!out.has(self)) out.set(self, new Set());
    out.get(self).add(np);
  }
  return out;
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
    const self = devKey(r.agent, r.cvpId, r.key);
    if (isMgmtPort(normPort(r.port))) continue;
    const peer = idx.find(r.sysName, self);
    if (!peer || peer === self) continue;
    if (!out.has(self)) out.set(self, new Set());
    out.get(self).add(normPort(r.port));
  }
  return out;
}

// v3.42(A1-11): 'unknown' · 'auto' 류는 못 읽은 값이다('full' 과 '다름' 이 아니다).
const duplexOf = (v) => { const s = lc(v); return !s ? null : s.includes('full') ? 'full' : s.includes('half') ? 'half' : null; };
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
  // v3.42(A1-12): 상대 포트(portId)를 모르는 행은 나중에 — 그 포트가 이미 다른 링크의 끝이면 같은 케이블이라 두 줄로 그리지 않는다.
  const deferred = [];
  const lldpEnds = new Set();
  const addLink = (aId, aPort, r, bId, bPort) => {
    // 맞은편 확인: B 의 그 포트(또는 B 전체)에 A 를 가리키는 이웃이 있나
    const bMap = nb.get(bId);
    const back = bMap && bPort ? (bMap.get(bPort) || []).find((x) => idx.find(x.sysName, bId) === aId && (!x.portId || normPort(x.portId) === aPort)) : null;
    const kind = back ? 'both' : 'one';
    const ends = [[aId, aPort], [bId, bPort || '?']].sort((x, y) => (x[0] + x[1] < y[0] + y[1] ? -1 : 1));
    const lk = ends.map((e) => `${e[0]}\u0000${e[1]}`).join('\u0001');
    const prev = links.get(lk);
    if (prev && prev.kind === 'both') return;
    links.set(lk, { a: aId, aPort, b: bId, bPort, kind, bLldpRead: !!(lldpMeta.get(bId)?.at != null) });
    lldpEnds.add(`${aId}\u0000${aPort}`); if (bPort) lldpEnds.add(`${bId}\u0000${bPort}`);
  };
  for (const [aId, pm] of nb) {
    for (const [aPort, list] of pm) {
      if (isMgmtPort(aPort)) continue;   // v3.42(A1-05)
      for (const r of list) {
        const bId = idx.find(r.sysName, aId);
        if (!bId) { if (String(r.sysName || '').trim()) addOther(aId, r.sysName); continue; }
        if (bId === aId) continue;
        const bPort = r.portId ? normPort(r.portId) : null;
        if (!bPort) { deferred.push([aId, aPort, r, bId]); continue; }
        addLink(aId, aPort, r, bId, bPort);
      }
    }
  }
  for (const [aId, aPort, r, bId] of deferred) {
    if (lldpEnds.has(`${aId}\u0000${aPort}`)) continue;
    // 상대 쪽에서 이 장비 · 이 포트를 가리키는 링크가 이미 있으면 같은 케이블
    if ([...(nb.get(bId)?.values() || [])].some((lst) => lst.some((x) => idx.find(x.sysName, bId) === aId && x.portId && normPort(x.portId) === aPort))) continue;
    addLink(aId, aPort, r, bId, null);
  }
  // 설명만으로 가리킨 링크(LLDP 이웃이 없는 · 링크가 올라온 포트) — 이미 링크 끝인 포트는 건너뛴다(끝 집합으로 — 링크 수만큼 훑지 않게).
  const usedEnds = new Set();
  for (const l of links.values()) { usedEnds.add(`${l.a}\u0000${l.aPort}`); if (l.bPort) usedEnds.add(`${l.b}\u0000${l.bPort}`); }
  for (const p of Array.isArray(ports) ? ports : []) {
    if (p.oper !== 'up' || p.desc == null) continue;
    const aId = devKey(p.agent, p.cvpId, p.key);
    const np = normPort(p.port);
    if (isMgmtPort(np) || nb.get(aId)?.has(np)) continue;
    const named = deviceNameFromDesc(p.desc);
    const bId = named ? idx.find(named, aId) : null;
    if (!bId || bId === aId) continue;
    if (usedEnds.has(`${aId}\u0000${np}`)) continue;
    usedEnds.add(`${aId}\u0000${np}`);
    // 양쪽 설명이 서로를 가리켜도 합치지 않는다(반증 판정 D-6 — 두 장비 사이 케이블이 여럿이면 어느 포트끼리인지 코드가 알 수 없어 짝을 지어내게 된다).
    links.set(`${aId}\u0000${np}\u0001desc\u0000${bId}`, { a: aId, aPort: np, b: bId, bPort: null, kind: 'desc', bLldpRead: !!(lldpMeta.get(bId)?.at != null) });
  }
  // 층 추정(v3.42 버그 점검 1회차 A1-04): MLAG 피어 링크(서로 직접 잇고 나머지 스위치 이웃이 같은 두 장비)는 차수에서 뺀다 — 넣으면 서버 LLDP 를 못 본
  //   리프 쌍의 차수(스파인 2 + 피어 1)가 스파인 기준 3 에 닿아 리프가 전부 '스파인' 이 됐다.
  const swNb = new Map();
  for (const l of links.values()) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) { if (!swNb.has(x)) swNb.set(x, new Set()); swNb.get(x).add(y); }
  }
  const peerOf = new Map();
  for (const [x, set] of swNb) {
    for (const y of set) {
      if (x >= y) continue;
      // 공유 이웃이 둘 이상일 때만(이웃 하나를 공유하는 삼각형 — 스파인 · 리프 · 리프 — 을 피어로 오인하지 않게)
      const ox = [...set].filter((z) => z !== y).sort();
      const oy = [...(swNb.get(y) || [])].filter((z) => z !== x).sort();
      if (ox.length >= 2 && ox.join('\u0001') === oy.join('\u0001')) { peerOf.set(x, y); peerOf.set(y, x); }
    }
  }
  const nbsOf = (id) => [...(swNb.get(id) || [])].filter((z) => z !== peerOf.get(id));
  const degOf = (id) => nbsOf(id).length;
  const hostsOf = (id) => { const o = others.get(id); return o ? o.esxi + o.other : 0; };
  const ids = devices.map((d) => devKey(d.agent, d.cvpId, d.key));
  const minSpineDeg = ids.some((id) => !hostsOf(id) && degOf(id) >= 3) ? 3 : 2;
  const spines = new Set(ids.filter((id) => !hostsOf(id) && degOf(id) >= minSpineDeg));
  const layerOf = (id) => {
    if (hostsOf(id) > 0) return 'leaf';
    const deg = degOf(id);
    if (deg === 0) return 'isolated';
    const nbs = nbsOf(id);
    // 이웃이 전부 spine 후보이고 자기보다 이웃이 많은 장비들뿐이면 leaf(서버 LLDP 를 못 본 리프) — spine 끼리 맞물린 경우를 leaf 로 내리지 않게 차수를 비교한다.
    if (nbs.length && nbs.every((n) => spines.has(n) && degOf(n) > deg)) return 'leaf';
    return spines.has(id) ? 'spine' : 'other';
  };
  const nodes = devices.map((d) => {
    const id = devKey(d.agent, d.cvpId, d.key);
    const deg = degOf(id);
    const oth = others.get(id) || { esxi: 0, other: 0 };
    const m = lldpMeta.get(id);
    const layer = layerOf(id);
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
