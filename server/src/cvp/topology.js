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
import { deviceNameFromDesc, deviceNamesFromDesc, descPortsOf, descTokens, descMentions, stripIfSuffix, shortOf } from './portmap.js';

const devKey = (a, c, k) => `${a}\u0000${c}\u0000${k}`;
const lc = (s) => String(s ?? '').trim().toLowerCase();
export { shortOf };   // 짧은 이름은 portmap.js 하나(IP 이름은 통째로 — 2회차 A3-F2 · 3회차 A1-F5)

/** 인터페이스 이름 정규화 — 'Ethernet1/1' = 'Et1/1' = 'ethernet 1/1'. 포트 채널 'Port-Channel10' = 'Po10'. */
export function normPort(s) {
  const t = lc(s).slice(0, 64).replace(/\s+/g, '');
  return t.replace(/^ethernet/, 'et').replace(/^port-channel/, 'po').replace(/^management/, 'ma');
}

/** 이름 색인의 '스위치 이름인데 하나로 못 고름' 표지 — 스위치 아님(기타 이웃)으로 세지 않고, 링크도 긋지 않는다(2회차 A1-F1). */
export const AMBIG = '\u0001ambig';
/**
 * 스위치 이름 색인 — 전체 이름(소문자) · 짧은 이름(첫 점 앞, IP 이름은 통째로).
 * v3.42(버그 점검 1회차 A1-06 · 2회차 A1-F1 · F3): 고르는 순서 — ① 보고한 장비와 같은 담당 · CVP 의 전체 이름 → ② 같은 CVP 의 짧은 이름 →
 *   ③ 전역에서 하나뿐인 전체 이름 → ④ 전역에서 하나뿐인 짧은 이름. 단계 안에서 여럿이면 스트리밍 중인 장비(streaming !== false — RMA 뒤 남은 옛 장비를 거른다)가
 *   하나일 때 그것, 아니면 AMBIG(스위치 이름이지만 못 고름). 예전에는 같은 CVP 동명 2대를 null 로 돌려 '스위치 아님' 으로 세어 층이 뒤집혔고(F1),
 *   다른 CVP 에 전체 이름이 하나 맞으면 같은 CVP 의 짧은 이름 후보를 보지 않았다(F3).
 * @param {Array<{agent,cvpId,key,hostname,streaming?}>} devices
 */
export function switchIndex(devices = []) {
  const full = new Map(); const short = new Map(); const live = new Map(); const fullOf = new Map();
  const add = (m, k, id) => { if (!m.has(k)) m.set(k, []); const a = m.get(k); if (!a.includes(id)) a.push(id); };
  for (const d of Array.isArray(devices) ? devices : []) {
    const id = devKey(d.agent, d.cvpId, d.key);
    live.set(id, d.streaming !== false);
    const f = lc(d.hostname);
    fullOf.set(id, f);
    if (f) add(full, f, id);
    const s = shortOf(d.hostname);
    if (s.length >= 3) add(short, s, id);
  }
  const choose = (cands) => {
    if (cands.length === 1) return cands[0];
    const on = cands.filter((c) => live.get(c));
    return on.length === 1 ? on[0] : AMBIG;
  };
  return {
    /** 이웃 이름 → 스위치 id · AMBIG(스위치 이름이지만 못 고름) · null(스위치 아님). from = 보고한 장비 id. */
    find(name, from = null) {
      const f = lc(name);
      if (!f) return null;
      const s = shortOf(name);
      const fc = full.get(f) || [];
      // 3회차 A1-F4: 도메인까지 쓴 이름(spine1.us.corp)은 **도메인이 다른 FQDN 장비**(spine1.kr.corp)의 짧은 이름으로 맞추지 않는다 —
      //   짧은 이름 후보는 장비 쪽 이름에 도메인이 없을 때만(CVP 는 'spine1', LLDP 는 FQDN 인 흔한 경우).
      //   4회차 A1-F1: '도메인이 없을 때만' 으로는 호스트 이름 자체에 점이 든 장비(CVP 'leaf1.dc1' ↔ LLDP 'leaf1.dc1.corp.com')가 스위치 아님이 됐다 —
      //   한쪽이 다른 쪽의 **라벨 단위 접두**면 같은 이름으로 본다('spine1.kr.corp' ↔ 'spine1.us.corp' 는 접두가 아니다).
      const labelPrefix = (a, b) => a === b || b.startsWith(`${a}.`);
      const sc = (s.length >= 3 ? (short.get(s) || []) : []).filter((c) => { const cf = fullOf.get(c) || ''; return labelPrefix(cf, f) || labelPrefix(f, cf); });
      if (!fc.length && !sc.length) return null;
      // 2회차 반증 R5: 도메인까지 쓴 이름(spine1.us.corp)은 정확한 전체 이름이 같은 CVP 의 짧은 이름(spine1.kr.corp)보다 강하다.
      //   짧은 이름(spine1)으로 온 경우만 같은 CVP 의 짧은 이름 후보를 다른 CVP 의 전체 이름보다 먼저 본다(A1-F3).
      const qualified = f !== s;
      if (from) {
        const pre = from.slice(0, from.lastIndexOf('\u0000') + 1);   // agent␀cvp␀
        const sf = fc.filter((c) => c.startsWith(pre));
        if (sf.length) return choose(sf);
        if (qualified && fc.length) return choose(fc);
        const ss = sc.filter((c) => c.startsWith(pre));
        if (ss.length) return choose(ss);
      }
      if (fc.length) return choose(fc);
      return choose(sc);
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
function hostPortRow(out, r, hostNames) {
  const np = normPort(r.port);
  if (isMgmtPort(np) || !hostNames.has(shortOf(r.sysName))) return;
  const self = devKey(r.agent, r.cvpId, r.key);
  if (!out.has(self)) out.set(self, new Set());
  out.get(self).add(np);
}
export function hostPortsOf(lldpRows, hostNames = new Set()) {
  const out = new Map();
  if (!hostNames || !hostNames.size) return out;
  for (const r of Array.isArray(lldpRows) ? lldpRows : []) hostPortRow(out, r, hostNames);
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
function uplinkRow(out, r, idx) {
  const self = devKey(r.agent, r.cvpId, r.key);
  if (isMgmtPort(normPort(r.port)) || (r.portId && isMgmtPort(normPort(r.portId)))) return;   // 2회차 A1-F2: 상대 끝이 관리 포트(OOB 스위치 데이터 포트 ↔ 장비 Management1)여도 업링크 아님
  const peer = idx.find(r.sysName, self);
  if (!peer || peer === self) return;   // AMBIG 는 스위치 이름이라 업링크로 둔다
  if (!out.has(self)) out.set(self, new Set());
  out.get(self).add(normPort(r.port));
}
export function uplinkPortsOf(lldpRows, idx) {
  const out = new Map();
  for (const r of Array.isArray(lldpRows) ? lldpRows : []) uplinkRow(out, r, idx);
  return out;
}
/**
 * 요청 경로용 — 전 LLDP 행을 한 번 훑어 업링크 · 호스트 포트를 함께 만들고 행마다 시간 기준 양보(yielder = createYielder(…)).
 *   v3.42(3회차 반증 R1 · R12): 위치 찾기 · 예측이 이 구간을 한 덩어리(60~100ms)로 돌았다. keep(r) 로 범위 밖 행을 거른다. 결과는 동기판과 같다.
 */
export async function lldpPortSetsAsync(lldpRows, idx, { hostNames = null, keep = null, yielder = null } = {}) {
  const uplinks = new Map(); const hostPorts = new Map();
  const hn = hostNames && hostNames.size ? hostNames : null;
  for (const r of Array.isArray(lldpRows) ? lldpRows : []) {
    if (yielder) await yielder();
    if (keep && !keep(r)) continue;
    uplinkRow(uplinks, r, idx);
    if (hn) hostPortRow(hostPorts, r, hn);
  }
  return { uplinks, hostPorts };
}

// v3.42(A1-11): 'unknown' · 'auto' 류는 못 읽은 값이다('full' 과 '다름' 이 아니다).
const duplexOf = (v) => { const s = lc(v); return !s ? null : s.includes('full') ? 'full' : s.includes('half') ? 'half' : null; };
const numOr = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) || n <= 0 ? null : n; };

/** 두 끝 포트 행을 비교 — [{ field, a, b, state:'diff'|'na' }] (같으면 넣지 않는다). */
export function compareEnds(pa, pb, { aName = '', bName = '', isSwitch = null } = {}) {
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
  for (const [side, p, peerName, selfName] of [['a', pa, bName, aName], ['b', pb, aName, bName]]) {
    if (p.desc == null || !peerName) continue;
    // v3.42(3회차 A1-F7): 설명 어디에든 상대 이름이 있으면 같음(포트 구성도 연결 근거와 같은 판정 — portmap.descMentions). 예전에는 첫 낱말만 봐
    //   자기 이름으로 시작하는 설명('leaf1:Et49 <-> spine1:Et1')이 거짓 '다름' 이었다.
    if (descMentions(p.desc, peerName)) continue;
    // 상대 이름이 없으면: 설명이 가리키는 **다른 알려진 스위치**(자기 자신 제외)가 있을 때만 다름. 'MLAG-PEER-1' · 'ISL-1' 같은 관례 낱말 · CVP 밖 이름은 비교하지 않는다(2회차 A1-F11 · R10).
    let named;
    // 낱말 그대로 + 인터페이스 접미를 뗀 꼴('spine2-et1' → 'spine2' — 3회차 반증 R7) 둘 다 본다
    if (typeof isSwitch === 'function') named = descTokens(p.desc).flatMap((t) => { const u = stripIfSuffix(t); return u === t ? [t] : [t, u]; }).find((t) => !descMentions(t, selfName) && isSwitch(t));
    else { named = deviceNameFromDesc(p.desc); if (named && selfName && descMentions(named, selfName)) named = ''; }   // isSwitch 없이 부르면(단위 테스트) 뽑은 첫 이름으로
    if (!named) continue;
    out.push({ field: side === 'a' ? 'descA' : 'descB', a: side === 'a' ? named : peerName, b: side === 'a' ? peerName : named, state: 'diff' });
  }
  return out;
}

/**
 * @param {{ devices:Array<{agent,cvpId,key,hostname,model,corpName?}>, lldp:Array, lldpMeta:Map<string,{at,failing}>, ports:Array<{agent,cvpId,key,port,oper,admin,speedBps,mtu,duplex,lag,desc}>, hostNames?:Set<string> }} a
 *   hostNames: 가상화 호스트 짧은 이름(소문자) — 스위치 아닌 이웃의 종류(ESXi)를 가른다.
 */
/**
 * v3.53(D-8 — 사용자 선택 2026-11-26 'MLAG 상태로 피어 · 층 확정'): 장비가 알린 MLAG 상태(info.mlagStatus — v3.41 부품 주기)로 피어를 확정한다.
 *   쌍 = 둘 다 state 'active' · 도메인이 같거나(둘 다 있을 때) · **LLDP 로 직접 연결된 포트가 그 장비의 피어 링크 채널(peerLink) 멤버**(한쪽 끝이면 된다).
 *   도메인 ID 는 쌍마다 같은 값을 다시 쓰는 일이 흔해(예: 모든 리프 쌍이 'mlag') 도메인만으로는 쌍을 정하지 않는다. 한 장비에 후보가 둘 이상이면 정하지 않는다.
 * @returns {Map<string,string>} id → 피어 id(양쪽 다 싣는다)
 */
function mlagPairs(links, mlagOf, portRow) {
  const active = (id) => /^active$/i.test(String(mlagOf(id)?.state || ''));
  const plOf = (id) => { const v = mlagOf(id)?.peerLink; return v ? normPort(v) : null; };
  const onPeerLink = (id, port) => { const pl = plOf(id); if (!pl || !port) return false; const lag = portRow.get(`${id}\u0000${port}`)?.lag; return !!lag && normPort(lag) === pl; };
  const cands = new Map();
  for (const l of links.values()) {
    if (l.kind === 'desc' || !active(l.a) || !active(l.b)) continue;
    const da = mlagOf(l.a)?.domain; const db = mlagOf(l.b)?.domain;
    if (da && db && String(da) !== String(db)) continue;
    if (!onPeerLink(l.a, l.aPort) && !onPeerLink(l.b, l.bPort)) continue;
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) { if (!cands.has(x)) cands.set(x, new Set()); cands.get(x).add(y); }
  }
  const out = new Map();
  for (const [x, set] of cands) {
    if (set.size !== 1) continue;
    const y = [...set][0];
    if (cands.get(y)?.size === 1 && cands.get(y).has(x)) out.set(x, y);
  }
  return out;
}
/**
 * v3.53(D-8): MLAG 쌍이 **연결 모양만으로는 못 가르는 구성**(스파인 4 + 리프 MLAG 쌍 · 4대 대칭 · 서버 LLDP 를 못 본 리프)의 층을 정한다.
 *   확인된 MLAG 쌍 P 와 그 쌍의 (피어 아닌) 스위치 이웃 N — N 에 MLAG 쌍이 하나도 없고 P · N 모두 서버 이웃이 없을 때만:
 *   P 가 N 을 향한 포트가 **전부 채널 멤버가 아니면**(채널 소속을 읽었고 '' — 라우팅 업링크) P 는 아래(리프) · N 은 위(스파인),
 *   **전부 채널 멤버(피어 링크 아님)** 면 P 가 N 에게 MLAG 채널을 내주는 위층(스파인 · 코어) · N 은 아래(리프). 소속을 모르는 포트가 있거나 섞이면 정하지 않는다.
 *   한 장비에 서로 다른 판정이 겹치면 그 장비는 정하지 않는다(예전 모양 추정). 양쪽 다 MLAG 쌍인 구성은 이 규칙으로도 가를 수 없다(남은 한계).
 * @returns {Map<string,'leaf'|'spine'>}
 */
function mlagLayerOf({ confirmed, links, swNb, hostsOf, portRow }) {
  const out = new Map(); const conflict = new Set();
  const put = (id, layer) => { if (conflict.has(id)) return; if (out.has(id) && out.get(id) !== layer) { out.delete(id); conflict.add(id); return; } out.set(id, layer); };
  const seen = new Set();
  for (const [x, y] of confirmed) {
    const pk = x < y ? `${x}\u0002${y}` : `${y}\u0002${x}`;
    if (seen.has(pk)) continue; seen.add(pk);
    if (hostsOf(x) || hostsOf(y)) continue;
    const N = new Set([...(swNb.get(x) || []), ...(swNb.get(y) || [])].filter((z) => z !== x && z !== y));
    if (!N.size || [...N].some((n) => confirmed.has(n) || hostsOf(n))) continue;
    let plain = 0; let chan = 0; let unknown = 0;
    for (const l of links.values()) {
      if (l.kind === 'desc') continue;
      for (const [me, myPort, other] of [[l.a, l.aPort, l.b], [l.b, l.bPort, l.a]]) {
        if ((me !== x && me !== y) || !N.has(other)) continue;
        const lag = myPort ? portRow.get(`${me}\u0000${myPort}`)?.lag : undefined;
        if (lag == null) unknown++; else if (lag === '') plain++; else chan++;
      }
    }
    if (unknown || (plain && chan) || (!plain && !chan)) continue;
    const pLayer = plain ? 'leaf' : 'spine'; const nLayer = plain ? 'spine' : 'leaf';
    put(x, pLayer); put(y, pLayer);
    for (const n of N) put(n, nLayer);
  }
  return out;
}

/**
 * v3.47(결정 D-6 — 사용자 선택): 두 스위치가 **서로를** 포트 설명으로 가리키면 한 줄로 합친다 — 단 **양쪽에 그런 포트가 하나씩만** 있을 때만.
 *   둘 이상이면(케이블 여러 가닥) 어느 포트끼리 이어졌는지 코드가 알 수 없어 짝을 지어내게 되므로 지금처럼 따로 둔다.
 *   합친 줄도 추정(kind 'desc' · descPair)이다 — 양끝 비교는 하지 않는다(LLDP 가 끝을 확인한 링크만 비교한다).
 *   5회차 A1-2: 설명에 **상대 포트가 적혀 있는데** 짝 포트와 다르면 합치지 않는다(케이블 두 가닥에 설명이 한쪽씩만 있으면 두 설명 모두와 어긋난 짝이 나왔다).
 *   자기 포트 이름은 상대 포트로 보지 않는다('leaf1:Et49 <-> spine1:Et1').
 */
function mergeDescPairs(links, portRow = new Map()) {
  // 수정 검토 V2: 대조는 물리 포트 이름만(포트 채널 · VLAN · 서버 NIC 은 '상대 포트' 가 아니다) · 'Eth1' 은 'Et1' 과 같다
  const nz = (x) => normPort(x).replace(/^eth(?=\d)/, 'et');
  const PHYS = /^(?:et|gi|te|fa|hu)\d/;
  const otherPorts = (id, ownPort) => descPortsOf(portRow.get(`${id}\u0000${ownPort}`)?.desc).map(nz).filter((x) => PHYS.test(x) && x !== nz(ownPort));
  const agrees = (id, ownPort, peerPort) => { const m = otherPorts(id, ownPort); return !m.length || m.includes(nz(peerPort)); };
  const byPair = new Map();   // 'x\u0002y'(x < y) → { xy:[키], yx:[키] }
  for (const [k, l] of links) {
    if (l.kind !== 'desc') continue;
    const [x, y] = l.a < l.b ? [l.a, l.b] : [l.b, l.a];
    const pk = `${x}\u0002${y}`;
    if (!byPair.has(pk)) byPair.set(pk, { xy: [], yx: [] });
    byPair.get(pk)[l.a === x ? 'xy' : 'yx'].push(k);
  }
  for (const { xy, yx } of byPair.values()) {
    if (xy.length !== 1 || yx.length !== 1) continue;
    const l1 = links.get(xy[0]); const l2 = links.get(yx[0]);
    if (!agrees(l1.a, l1.aPort, l2.aPort) || !agrees(l2.a, l2.aPort, l1.aPort)) continue;
    links.delete(yx[0]);
    links.set(xy[0], { ...l1, bPort: l2.aPort, descPair: true });
  }
}

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
        if (bId === aId || bId === AMBIG) continue;   // 2회차 A1-F1: 못 고른 스위치 이름은 링크도 '기타' 도 아니다
        const bPort = r.portId ? normPort(r.portId) : null;
        if (bPort && isMgmtPort(bPort)) continue;   // 2회차 A1-F2: 상대 끝이 관리 포트면 관리망 링크
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
    // 4회차 A1-N2 → 수정 검토 F1 · F2: 설명의 **첫 장비 이름꼴 낱말**이 상대다(예전 그대로). 그 낱말이 자기 자신일 때만('leaf1:Et49 <-> spine1:Et1') 다음 낱말로 넘어간다.
    //   낱말 전부에서 스위치를 찾았더니(4회차 첫 수정) 서버 포트 설명에 **언급만 된** 스위치('esx01 vmnic2 (moved from leaf2 Et10)')로 거짓 선을 긋고,
    //   그 선이 층 추정까지 뒤집었다(리프 셋이 모두 스파인) · 포트마다 낱말 전부를 찾아 한 덩어리 시간도 두 배였다.
    let bId = null;
    for (const name of deviceNamesFromDesc(p.desc)) {
      const id = idx.find(name, aId);
      if (id === aId) continue;             // 자기 이름 — 다음 장비 이름꼴 낱말을 본다
      if (id && id !== AMBIG) bId = id;
      break;                                // 스위치가 아닌 장비(서버 · 방화벽) · 못 고른 이름이면 이 포트의 상대는 그것이다 — 거기서 멈춘다
    }
    if (!bId) continue;
    if (usedEnds.has(`${aId}\u0000${np}`)) continue;
    usedEnds.add(`${aId}\u0000${np}`);
    links.set(`${aId}\u0000${np}\u0001desc\u0000${bId}`, { a: aId, aPort: np, b: bId, bPort: null, kind: 'desc', bLldpRead: !!(lldpMeta.get(bId)?.at != null) });
  }
  mergeDescPairs(links, portRow);
  // 층 추정(v3.42 버그 점검 1회차 A1-04 · 2회차 A1-F4 · F5): 스파인 후보는 **전체** 스위치 이웃 수로 고르고, 리프 판정에서만 MLAG 피어를 뺀다 —
  //   '피어를 뺀 내 이웃이 전부 스파인 후보이고 그들의 전체 이웃 수가 내 (피어 뺀) 이웃 수보다 많으면 리프'. 1회차는 피어를 차수에서도 빼서
  //   스파인 MLAG 쌍 + 리프 2대가 전부 스파인이 됐다(2회차 F4). 피어 판정은 '직접 연결 + 나머지 이웃 대부분 공유'(업링크 하나가 내려가도 쌍 — F5).
  const swNb = new Map();
  for (const l of links.values()) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) { if (!swNb.has(x)) swNb.set(x, new Set()); swNb.get(x).add(y); }
  }
  // 피어 후보 점수(공유 이웃 수) — 서로의 **유일한 최고** 후보일 때만 쌍으로 본다(2회차 반증 R3: 동점이면 먼저 본 쌍을 골라
  //   삼각형 — 코어 1 + 접속 MLAG 쌍 — 의 층이 장비 키 순서로 정해졌다). 동점이면 쌍을 정하지 않는다(결정적).
  const cand = new Map();
  for (const [x, set] of swNb) {
    for (const y of set) {
      if (x >= y) continue;
      // 2회차 A4-F4: 공유 수는 작은 쪽 이웃 수를 넘지 못한다 — 크기만 보고 먼저 거른다(스파인 ↔ 리프 쌍마다 배열을 만들어 링크 수의 제곱이 됐다).
      const nx = set.size - 1; const ny = (swNb.get(y)?.size || 1) - 1;
      if (nx < 1 || ny < 1 || 2 * Math.min(nx, ny) < Math.max(nx, ny)) continue;
      const oy = swNb.get(y);
      let common = 0;
      for (const z of set) if (z !== y && oy.has(z)) common++;
      if (common < 1 || common * 2 < Math.max(nx, ny)) continue;
      // 3회차 A1-F1: 점수 = 공유 비율(공유 ÷ 큰 쪽 이웃 수) 먼저 · 같으면 공유 수 — 공유 수만 보면 스파인 MLAG 쌍이 있을 때 리프 ↔ 스파인(2/4)이
      //   진짜 피어(2/2)와 동점이 되어 리프 쌍이 사라졌다(리프가 전부 스파인).
      const score = (common / Math.max(nx, ny)) * 1e6 + common;
      for (const [u, v] of [[x, y], [y, x]]) { if (!cand.has(u)) cand.set(u, []); cand.get(u).push([v, score]); }
    }
  }
  const bestOf = (u) => {
    const c = cand.get(u); if (!c) return null;
    const top = Math.max(...c.map((e) => e[1]));
    const tops = c.filter((e) => e[1] === top);
    return tops.length === 1 ? tops[0][0] : null;
  };
  // v3.53(D-8 — MLAG 상태로 확정): 장비가 알린 MLAG 상태로 피어를 먼저 정한다(mlagPairs — 둘 다 active · 도메인 같음 · 피어 링크 채널 멤버 포트로 직접 연결).
  //   MLAG 를 'disabled' 로 알린 장비는 모양 추정 피어에서도 뺀다(쓰지 않는다고 장비가 말했다). 나머지만 예전 모양 추정.
  const mlagOf = (id) => { const ms = byId.get(id)?.info?.mlagStatus; return ms && typeof ms === 'object' ? ms : null; };
  const mlagOff = (id) => /^(disabled|notconfigured|off)$/i.test(String(mlagOf(id)?.state || ''));
  const confirmed = mlagPairs(links, mlagOf, portRow);
  const peerOf = new Map(confirmed);
  for (const u of cand.keys()) {
    if (confirmed.has(u) || mlagOff(u)) continue;
    const v = bestOf(u);
    // 모양 추정 쌍은 양쪽에서 한 번씩 적힌다(u → v, 나중에 v → u) — 확정 쌍 장비와는 짝짓지 않는다
    if (v != null && bestOf(v) === u && !confirmed.has(v) && !mlagOff(v)) peerOf.set(u, v);
  }
  const degFull = (id) => swNb.get(id)?.size || 0;
  const nbsOf = (id) => [...(swNb.get(id) || [])].filter((z) => z !== peerOf.get(id));
  const hostsOf = (id) => { const o = others.get(id); return o ? o.esxi + o.other : 0; };
  const ids = devices.map((d) => devKey(d.agent, d.cvpId, d.key));
  const minSpineDeg = ids.some((id) => !hostsOf(id) && degFull(id) >= 3) ? 3 : 2;
  const spines = new Set(ids.filter((id) => !hostsOf(id) && degFull(id) >= minSpineDeg));
  const layerOf = (id) => {
    if (hostsOf(id) > 0) return 'leaf';
    if (degFull(id) === 0) return 'isolated';
    const nbs = nbsOf(id);
    // 이웃이 전부 spine 후보이고 자기보다 이웃이 많은 장비들뿐이면 leaf(서버 LLDP 를 못 본 리프) — spine 끼리 맞물린 경우를 leaf 로 내리지 않게 차수를 비교한다.
    if (nbs.length && nbs.every((n) => spines.has(n) && degFull(n) > nbs.length)) return 'leaf';
    return spines.has(id) ? 'spine' : 'other';
  };
  const mlagLayer = mlagLayerOf({ confirmed, links, swNb, hostsOf, portRow });
  const nodes = devices.map((d) => {
    const id = devKey(d.agent, d.cvpId, d.key);
    const oth = others.get(id) || { esxi: 0, other: 0 };
    const m = lldpMeta.get(id);
    const layer = mlagLayer.get(id) || layerOf(id);
    return { id, agent: d.agent, cvpId: d.cvpId, key: d.key, hostname: d.hostname || d.key, model: d.model || '', corpName: d.corpName || '',
      // v3.42(2회차 F6): 화면의 '스위치 이웃' 은 MLAG 피어를 포함한 실제 수(층 추정만 피어를 뺀 차수를 쓴다) · 피어는 따로 싣는다.
      layer, ...(mlagLayer.has(id) ? { layerBy: 'mlag' } : {}), switchNeighbors: swNb.get(id)?.size || 0, mlagPeer: peerOf.has(id), ...(confirmed.has(id) ? { mlagBy: 'status' } : {}), esxi: oth.esxi, otherNeighbors: oth.other, lldpRead: !!(m && m.at != null), lldpAt: m?.at ?? null, lldpFailing: !!m?.failing };
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
      items = compareEnds(pa, pb, { aName: da?.hostname || '', bName: db?.hostname || '', isSwitch: (n) => idx.find(n) != null });
      counts.compared++;
      if (items.some((x) => x.state === 'diff')) counts.diff++;
      else if (items.some((x) => x.state === 'na')) counts.na++;
    }
    out.push({ a: l.a, b: l.b, aName: da?.hostname || '', bName: db?.hostname || '', aPort: pa?.port || l.aPort, bPort: pb?.port || l.bPort || null,
      kind: l.kind, ...(l.descPair ? { descPair: true } : {}), bLldpRead: l.bLldpRead, oper: pa ? pa.oper : null, speedBps: pa ? (pa.speedBps ?? null) : null, items });
  }
  out.sort((x, y) => (x.aName + x.aPort).localeCompare(y.aName + y.aPort));
  return { nodes, links: out, counts, lldpReadDevices: nodes.filter((n) => n.lldpRead).length };
}
