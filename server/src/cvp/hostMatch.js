/**
 * cvp/hostMatch.js — 가상화 호스트 ↔ CVP 스위치 포트 **업링크 매칭**(순수, v2.920 — 설계 docs/design/san-cvp-traffic/README.md §4.2).
 *
 * 근거 우선순위: LLDP 이웃(확정) → MAC 테이블 학습(높음) → **포트 설명 일치(보통 · 지금 가능)** → 없음(미매칭).
 *   포탈 CVP 수집은 LLDP·MAC 테이블을 아직 읽지 않으므로(docs/rules/cvp.md) A 단계는 설명 일치뿐이다 — 근거 없는 매칭은 만들지 않는다.
 *   설명에서 찾는 것: ① 호스트 짧은 이름(FQDN 앞 토큰, 3자 이상 — 토큰 경계로 'esx1' 이 'esx10' 에 맞지 않게) ② 물리 NIC MAC(콜론·하이픈·점 표기 모두)
 *   ③ 'vmnicN' 글자(NIC 까지 지목). ② 와 ③ 이 있으면 NIC 를 특정하고, ① 만 있으면 호스트 수준 매칭(NIC 미확정).
 * 방향은 스위치 포트 기준: In = 서버 송신 · Out = 서버 수신(화면 띠와 열 이름이 말한다).
 * 중복: MLAG 양쪽 포트에 같은 설명이면 둘 다 업링크다(정상). 같은 MAC 이 세 포트 이상에서 보이면 '충돌' 로 표시만 한다.
 */

const SEP = /[^a-z0-9]+/;
const normMac = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const macForms = (mac) => {
  const h = normMac(mac);
  if (h.length !== 12) return [];
  const pairs = h.match(/../g);
  return [pairs.join(':'), pairs.join('-'), `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8)}`, h];
};

/** 호스트에서 설명에 찾을 단서. */
export function hostMatchTerms(host = {}) {
  const full = String(host.name || '').trim().toLowerCase();
  const short = full.split('.')[0];
  const names = [];
  if (short.length >= 3) names.push(short);
  // v2.922(리눅스 성능 3a — 베어메탈 서버 NIC ↔ 포트): 별칭(서비스 태그 등)도 이름 단서로 — 같은 토큰 경계 규칙. 가상화 호스트 호출은 aliases 를 넘기지 않아 예전과 같다.
  for (const a of Array.isArray(host.aliases) ? host.aliases : []) { const x = String(a || '').trim().toLowerCase(); if (x.length >= 3 && !names.includes(x)) names.push(x); }
  const nics = (Array.isArray(host.nics) ? host.nics : []).map((n) => ({ device: String(n?.device || ''), mac: normMac(n?.mac) })).filter((n) => n.device);
  return { full, short, names, nics, macs: nics.filter((n) => n.mac.length === 12).map((n) => n.mac) };
}

/**
 * 이름 뒤·앞에 하이픈·밑줄로 **붙어 이어져도 같은 호스트로 보는** 토큰 — NIC·역할 접미사(‘esx01-vmnic1’ · ‘kr-esx-01-mgmt’). 이 목록 밖 토큰이 붙으면
 *   다른 호스트 이름의 일부로 본다(‘esx-01-b’ · ‘bm-kr1-db01-old’ · ‘db-1-0’ · ‘kr-esx-01’). 목록은 흔한 표기만(추정 — 현장 표기로 늘릴 수 있다).
 */
export const JOIN_OK_RE = /^(vmnic\d{1,3}|vmk\d{1,3}|nic\d{1,3}|eth\d{1,3}|en[a-z]{0,2}\d[a-z0-9]{0,8}|bond\d{1,3}|team\d{1,3}|p\d{1,2}p?\d{0,2}|port\d{1,3}|mgmt|mgt|oob|idrac|ilo|bmc|ipmi|uplink\d{0,2}|lag\d{0,3}|po\d{1,4}|mlag|vmotion|vsan|iscsi|nfs|data|backup)$/;
/** 설명을 소문자 토큰열로(각 토큰 뒤 구분자 원문 포함 — 붙은 이어짐 판정용). 길이를 먼저 자르고 선형으로. */
function tokensOf(desc) {
  const d = String(desc || '').toLowerCase().slice(0, 1024);
  const out = [];
  let i = 0;
  while (i < d.length) {
    while (i < d.length && !/[a-z0-9]/.test(d[i])) i++;
    const st = i;
    while (i < d.length && /[a-z0-9]/.test(d[i])) i++;
    if (i > st) out.push({ t: d.slice(st, i), start: st, end: i });
  }
  for (let k = 0; k < out.length; k++) out[k].sepAfter = k + 1 < out.length ? d.slice(out[k].end, out[k + 1].start) : '';
  return out;
}
const JOINED = (sep) => sep === '-' || sep === '_';
/** 이름 **앞**에 붙어도 되는 연결어 — ‘to-esx01’ · ‘TO_ESX01-p1’(v2.920 테스트가 고정한 표기). ‘kr-esx-01’ 의 ‘kr’ 같은 이름 조각은 아니다. */
export const JOIN_PREFIX_OK_RE = /^(to|from|link|conn|uplink|srv|svr|server|host)$/;
/**
 * 설명 안에 이름이 있는가. 이름·설명 둘 다 구분자로 나눈 **연속 토큰열**로 찾는다('db01' ⊄ 'db010' · 'esx-01' = 'esx 01' = 'ESX_01').
 * v2.922(3a · 반증 D7 보강):
 *  · 구분자 있는 이름('bm-kr1-db01')이 예전에는 토큰 하나와 비교돼 **영원히 매칭되지 않았다**(v2.920 결함) — 토큰열 비교로 고쳤다.
 *  · strict(기본 — 호스트 이름): 토큰열 **바로 앞·뒤에 하이픈·밑줄로 붙은 토큰**이 있으면 다른 호스트 이름의 일부로 보고 매칭하지 않는다
 *    (‘esx-01-b’ · ‘kr-esx-01’ · ‘db-1-0’ · ‘bm-kr1-db01-old’). 단 붙은 토큰이 NIC·역할 접미사(JOIN_OK_RE)면 같은 호스트다(‘esx01-vmnic1’ · ‘kr-esx-01-mgmt’).
 *    앞에는 연결어(JOIN_PREFIX_OK_RE — ‘to-esx01’)만 붙을 수 있다. 앞 연장(‘kr-esx-01’ 이 ‘esx-01’ 을 품는 것)은 후보로도 남기지 않는다 — 하이픈으로 이은 식별자는 한 호스트 이름이라 보고(이 현장 이름 규칙 추정),
 *    거짓 후보를 사람이 지우는 비용보다 거짓 매칭이 업링크 트래픽을 잘못 귀속하는 비용이 크다고 판단했다.
 *  · 여러 토큰 이름은 영숫자 합이 3자 이상일 때만(‘a-b’ ↔ ‘link a b c’ 같은 흔한 토큰 쌍 방지). 한 토큰 이름의 길이 하한은 호출부(hostMatchTerms 3자)가 정한다.
 *  · strict:false — NIC 장치 이름(eno1 · vmnic0) 찾기용: 붙은 이어짐을 따지지 않는다(‘db01-eno1’ 의 eno1).
 */
export function descHasName(desc, name, { strict = true } = {}) {
  if (!name) return false;
  const parts = String(name).toLowerCase().split(SEP).filter(Boolean);
  if (!parts.length) return false;
  if (parts.length > 1 && parts.join('').length < 3) return false;
  const toks = tokensOf(desc);
  for (let i = 0; i + parts.length <= toks.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) if (toks[i + j].t !== parts[j]) { ok = false; break; }
    if (!ok) continue;
    if (!strict) return true;
    const prev = i > 0 ? toks[i - 1] : null;
    const last = toks[i + parts.length - 1];
    const next = i + parts.length < toks.length ? toks[i + parts.length] : null;
    if (prev && JOINED(prev.sepAfter) && !JOIN_OK_RE.test(prev.t) && !JOIN_PREFIX_OK_RE.test(prev.t)) continue;
    if (next && JOINED(last.sepAfter) && !JOIN_OK_RE.test(next.t)) continue;
    return true;
  }
  return false;
}

/** 설명 안의 MAC(어느 표기든) — 정규화 12자. */
export function macsInDesc(desc) {
  const d = String(desc || '').toLowerCase();
  const out = new Set();
  for (const m of d.match(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}\b|\b[0-9a-f]{12}\b/g) || []) out.add(normMac(m));
  return out;
}

const NIC_RE = /\bvmnic\d{1,3}\b/g;

/**
 * @param {Array<object>} ports CVP 포트 행 [{ cvpId, agent, key, hostname, port, desc, oper, speedBps, inBps, outBps, inUtil, outUtil, inErr, outErr, rateTs }]
 * @param {object} host 인벤토리 호스트 { name, nics:[{device,mac}] }
 * @returns {{ uplinks:[], byNic:Map<string,object[]>, conflicts:[], terms:object }}
 */
export function matchUplinks(ports = [], host = {}) {
  const terms = hostMatchTerms(host);
  const uplinks = [];
  for (const p of Array.isArray(ports) ? ports : []) {
    const desc = String(p?.desc || '');
    if (!desc) continue;
    const dMacs = macsInDesc(desc);
    const nicByMac = terms.nics.find((n) => n.mac && dMacs.has(n.mac)) || null;
    const nicNames = (desc.toLowerCase().match(NIC_RE) || []);
    // v2.922(3a): 리눅스 NIC 이름(eno1·ens1f0·bond0 …)은 vmnic 글자 규칙에 걸리지 않는다 — 장치 이름이 설명 토큰과 같으면 NIC 지목(이름 단서와 함께일 때만 — 아래 조건).
    const nicByName = terms.nics.find((n) => nicNames.includes(n.device.toLowerCase()) || descHasName(desc, n.device.toLowerCase(), { strict: false })) || null;
    const nameHit = terms.names.some((n) => descHasName(desc, n));
    if (!nicByMac && !(nicByName && nameHit) && !nameHit) continue;   // vmnic 글자만으로는 호스트를 특정할 수 없다(어느 호스트나 vmnic0 이 있다)
    const nic = nicByMac?.device || nicByName?.device || null;
    const basis = nicByMac ? 'desc-mac' : nicByName ? 'desc-nic' : 'desc-name';
    uplinks.push({ ...p, desc, nic, basis, matched: nicByMac ? nicByMac.mac : nicByName ? nicByName.device : terms.short });
  }
  const byNic = new Map();
  for (const u of uplinks) if (u.nic) { if (!byNic.has(u.nic)) byNic.set(u.nic, []); byNic.get(u.nic).push(u); }
  const conflicts = [...byNic.entries()].filter(([, l]) => l.length > 2).map(([nic, l]) => ({ nic, ports: l.length }));
  return { uplinks, byNic, conflicts, terms: { short: terms.short, macs: terms.macs.length, nics: terms.nics.length } };
}

/* ── v2.924(SAN·CVP 설계 B-②) — LLDP 이웃 · MAC 테이블로 올린 매칭 ────────────────────────────────────────────────────
 * 근거 순위(작을수록 강함): lldp(확정 — 이웃 시스템 이름이 이 호스트) → mac(높음 — 물리 NIC MAC 이 그 포트에 학습) → mac-vm(높음 — 그 포트에서 배운 MAC 의
 *   절반 이상이 이 호스트 VM vNIC) → desc-mac · desc-nic · desc-name(보통 — 포트 설명). 한 포트가 여러 근거로 잡히면 가장 강한 것 하나를 쓰고 나머지는 also 로 남긴다.
 * ⚠ ESXi 는 표준 vSwitch 에서 LLDP 를 보내지 않는다(분산 스위치에서 켜야 한다 — CDP 만 기본) · vmk0 MAC 은 대개 첫 vmnic MAC 이지만 아닐 수 있다 —
 *   그래서 근거가 없으면 '미매칭' 이고 설명 일치(보통)로 떨어진다(지어내지 않는다).
 */
export const BASIS_RANK = Object.freeze({ lldp: 0, mac: 1, 'mac-vm': 2, 'desc-mac': 3, 'desc-nic': 4, 'desc-name': 5 });
export const VM_MAC_SHARE_MIN = 0.5;   // 그 포트에서 배운 MAC 중 이 호스트 VM 비율 하한(트렁크·다른 호스트 포트를 거른다)
const pkey = (u) => `${u.agent ?? ''}\u0000${u.cvpId}\u0000${u.key}\u0000${u.port}`;
const mac12 = (m) => { const h = normMac(m); return h.length === 12 ? h : null; };

/**
 * L2 근거로 업링크 포트를 찾는다(순수).
 * @param {{ host:object, lldpRows:object[], fdbRows:object[], vmMacs?:Iterable<string>, portTotals?:Map, portLldp?:object[] }} a  portLldp: db.lldpByPorts(후보 포트) — 교차 확인(반증 H-1)
 *   lldpRows: db.lldpByNames 행 · fdbRows: db.fdbByMacs 행 · vmMacs: 이 호스트 VM vNIC MAC(정규화 12자) · portTotals: db.fdbPortTotals(장비 → 포트 → 학습 MAC 수)
 * @returns {{ uplinks:object[], conflicts:object[] }}  uplinks[]: { agent, cvpId, key, hostname, port, nic, basis, evidence }
 */
export function matchL2({ host = {}, lldpRows = [], fdbRows = [], vmMacs = [], portTotals = new Map(), portLldp = [] } = {}) {
  const terms = hostMatchTerms(host);
  const byPort = new Map();
  const put = (row, basis, nic, evidence) => {
    const k = pkey(row);
    const cur = byPort.get(k);
    const at = Number(row.ts) || null;
    const cand = { agent: row.agent ?? '', cvpId: row.cvpId, key: row.key, hostname: row.hostname || '', port: row.port, nic: nic || null, basis, evidence, l2At: at };
    if (!cur) { byPort.set(k, { ...cand, also: [] }); return; }
    if (BASIS_RANK[basis] < BASIS_RANK[cur.basis]) byPort.set(k, { ...cand, nic: cand.nic || cur.nic, also: [...cur.also, { basis: cur.basis, evidence: cur.evidence }] });
    else { cur.also.push({ basis, evidence }); if (!cur.nic && nic) cur.nic = nic; }
  };
  // v2.924(반증 M-1): 이름 일치 — 양쪽 다 도메인이 있으면 **전체 이름**이 같아야 한다(다른 법인의 같은 짧은 이름 'esx01' 이 '확정' 으로 붙었다 — 재현).
  //   한쪽이라도 도메인이 없으면 첫 점 앞(3자 이상)으로 비교한다.
  const hasDom = (x) => String(x || '').includes('.');
  const sameHost = (lc, sh) => {
    if (!lc) return false;
    if (hasDom(lc) && hasDom(terms.full)) return lc === terms.full;
    return terms.short.length >= 3 && sh === terms.short;
  };
  // ① LLDP — 이웃 시스템 이름이 이 호스트(위 규칙)이거나 이웃 섀시 MAC 이 이 호스트 NIC MAC(반증 L-9 — IP 로 등록된 호스트).
  //   NIC: 이웃 portId 가 인벤토리 NIC 이름·MAC 이면 그 NIC, 인벤토리에 NIC 목록이 없어도 portId 가 'vmnicN' 이면 그 이름(ESXi 가 스스로 알린 포트 이름이다).
  for (const r of Array.isArray(lldpRows) ? lldpRows : []) {
    const lc = String(r.sysLc || r.sysName || '').toLowerCase(); const sh = String(r.sysShort || lc.split('.')[0]);
    const cmac = mac12(r.chassisId);
    const byName = sameHost(lc, sh);
    const byChassis = !!cmac && terms.macs.includes(cmac);
    if (!byName && !byChassis) continue;
    const pid = String(r.portId || '').toLowerCase(); const pmac = mac12(r.portId);
    const nic = terms.nics.find((n) => n.device.toLowerCase() === pid || (n.mac && n.mac === pmac)) || null;
    const nicName = nic?.device || (/^vmnic\d{1,3}$/.test(pid) ? pid : null);
    put(r, 'lldp', nicName, `LLDP 이웃 ${r.sysName || lc}${r.portId ? ` · ${r.portId}` : ''}${!byName && byChassis ? ' · 섀시 MAC 일치' : ''}`);
  }
  /*
   * v2.924(반증 H-1): MAC 근거의 거짓 양성 — 기본 non-LAG 티밍에서 vmk0(=vmnic0 MAC)을 MLAG peer 가 peer-link 에서 배우고, 법인이 작으면 peer-link·spine
   *   포트의 학습 수가 포트당 상한(512) 아래라 파서가 거르지 않았다 → 스위치 사이 포트가 '높음' 업링크로 잡혀 호스트 송수신 합에 그 트래픽이 들어갔다(재현).
   *   그래서 MAC 근거(NIC·VM 모두)는 ① 물리 포트가 아닌 인터페이스(Vxlan·Vlan·Loopback·Management·Tunnel)는 보지 않고 ② 그 포트의 LLDP 이웃이 **다른 장비**면 버리며
   *   ③ 그 포트에서 배운 MAC 의 절반 이상이 이 호스트의 것(NIC MAC + VM MAC)일 때만 쓴다(포트 전체 학습 수를 모르면 판정하지 않는다).
   */
  const NON_PHYS = /^(vxlan|vlan|loopback|lo\d|management|ma\d|tunnel|tu\d|recirc)/i;
  const otherNeighbor = new Set();
  for (const r of Array.isArray(portLldp) ? portLldp : []) {
    const lc = String(r.sysLc || r.sysName || '').toLowerCase(); const sh = String(r.sysShort || lc.split('.')[0]);
    if (lc && !sameHost(lc, sh) && !(mac12(r.chassisId) && terms.macs.includes(mac12(r.chassisId)))) otherNeighbor.add(pkey(r));
  }
  const nicByMac = new Map(terms.nics.filter((n) => n.mac).map((n) => [n.mac, n.device]));
  const vmSet = new Set([...(vmMacs || [])].map(mac12).filter(Boolean));
  const mine = new Map();   // pkey → { row, nicMacs:Set, vmMacs:Set }
  const macPorts = new Map();
  for (const r of Array.isArray(fdbRows) ? fdbRows : []) {
    const mac = mac12(r.mac); if (!mac) continue;
    if (!nicByMac.has(mac) && !vmSet.has(mac)) continue;
    if (NON_PHYS.test(String(r.port || ''))) continue;
    const k = pkey(r);
    if (!mine.has(k)) mine.set(k, { row: r, nic: new Set(), vm: new Set() });
    const e = mine.get(k);
    if (nicByMac.has(mac)) { e.nic.add(mac); if (!macPorts.has(mac)) macPorts.set(mac, new Set()); macPorts.get(mac).add(k); }
    else e.vm.add(mac);
    if (Number(r.ts) > Number(e.row.ts || 0)) e.row = { ...e.row, ts: r.ts };
  }
  for (const [k, e] of mine) {
    if (otherNeighbor.has(k)) continue;
    const r = e.row;
    const tot = portTotals instanceof Map ? portTotals.get(`${r.agent ?? ''}\u0000${r.cvpId}\u0000${r.key}`)?.get(r.port) : null;
    if (tot == null || tot <= 0) continue;   // 포트 전체 학습 수를 모르면 판정하지 않는다(트렁크일 수 있다)
    const own = e.nic.size + e.vm.size;
    if (own / tot < VM_MAC_SHARE_MIN) continue;
    if (e.nic.size) {
      const devs = [...e.nic].map((m) => nicByMac.get(m));
      put(r, 'mac', devs.length === 1 ? devs[0] : null, `MAC 테이블 — ${devs.join('·')} MAC${e.vm.size ? ` + VM MAC ${e.vm.size}개` : ''} / 그 포트 학습 ${tot}개`);
    } else if (e.vm.size >= 2 || tot === 1) {
      put(r, 'mac-vm', null, `MAC 테이블 — 이 호스트 VM MAC ${e.vm.size}개 / 그 포트 학습 ${tot}개`);
    }
  }
  // 같은 NIC MAC 이 (비율 판정 전) 포트 3곳 이상에서 보이면 충돌(MLAG 양쪽 2곳은 정상) — 표시만 한다.
  const conflicts = [...macPorts].filter(([, ps]) => ps.size > 2).map(([mac, ps]) => ({ nic: nicByMac.get(mac), ports: ps.size }));
  return { uplinks: [...byPort.values()], conflicts };
}

/** 설명 매칭(matchUplinks)과 L2 매칭(matchL2)을 포트 단위로 합친다 — 가장 강한 근거 하나 · 나머지는 also. 포트 행 값(처리량 등)은 설명 쪽 행을 쓰고 없으면 rowsByKey 에서 붙인다. */
export function mergeUplinks(descUplinks = [], l2Uplinks = [], rowsByKey = new Map()) {
  const out = new Map();
  for (const u of Array.isArray(descUplinks) ? descUplinks : []) out.set(pkey(u), { ...u, also: [] });
  for (const u of Array.isArray(l2Uplinks) ? l2Uplinks : []) {
    const k = pkey(u); const cur = out.get(k);
    if (!cur) { const row = rowsByKey.get(k) || null; out.set(k, { ...(row || {}), ...u, desc: row?.desc ?? '', also: u.also || [] }); continue; }
    if (BASIS_RANK[u.basis] < BASIS_RANK[cur.basis]) out.set(k, { ...cur, basis: u.basis, nic: u.nic || cur.nic, evidence: u.evidence, l2At: u.l2At ?? null, also: [...(u.also || []), { basis: cur.basis, evidence: cur.evidence || null }, ...cur.also] });
    else { cur.also.push({ basis: u.basis, evidence: u.evidence }, ...(u.also || [])); if (!cur.nic && u.nic) cur.nic = u.nic; }
  }
  return [...out.values()].sort((a, b) => BASIS_RANK[a.basis] - BASIS_RANK[b.basis] || String(a.nic || '~').localeCompare(String(b.nic || '~')) || String(a.port).localeCompare(String(b.port)));
}

/** 매칭 근거 라벨(서버·웹 공용 문구 — 웹 hostNetText 가 같은 표를 쓴다). */
export const BASIS_LABEL = Object.freeze({
  lldp: { label: '확정', note: 'LLDP 이웃', tone: 'ok' },
  mac: { label: '높음', note: 'MAC 테이블 학습', tone: 'ok' },
  'mac-vm': { label: '높음', note: 'MAC 테이블 — 이 호스트 VM MAC', tone: 'ok' },
  'desc-mac': { label: '보통', note: '포트 설명에 NIC MAC', tone: 'warn' },
  'desc-nic': { label: '보통', note: '포트 설명에 호스트 이름 + NIC 이름(vmnic·eno 등)', tone: 'warn' },
  'desc-name': { label: '보통', note: '포트 설명에 호스트 이름', tone: 'warn' },
});
