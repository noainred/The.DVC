/**
 * cvp/hostMatch.js — 가상화 호스트 ↔ CVP 스위치 포트 **업링크 매칭**(순수, v2.915 — 설계 docs/design/san-cvp-traffic/README.md §4.2).
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
  const nics = (Array.isArray(host.nics) ? host.nics : []).map((n) => ({ device: String(n?.device || ''), mac: normMac(n?.mac) })).filter((n) => n.device);
  return { full, short, names, nics, macs: nics.filter((n) => n.mac.length === 12).map((n) => n.mac) };
}

/** 설명 안에 토큰 경계로 이름이 있는가('esx01' ⊄ 'esx010'). */
export function descHasName(desc, name) {
  if (!name) return false;
  const toks = String(desc || '').toLowerCase().split(SEP).filter(Boolean);
  return toks.includes(name);
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
    const nicByName = terms.nics.find((n) => nicNames.includes(n.device.toLowerCase())) || null;
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

/** 매칭 근거 라벨(서버·웹 공용 문구 — 웹 hostNetText 가 같은 표를 쓴다). */
export const BASIS_LABEL = Object.freeze({
  lldp: { label: '확정', note: 'LLDP 이웃', tone: 'ok' },
  mac: { label: '높음', note: 'MAC 테이블 학습', tone: 'ok' },
  'desc-mac': { label: '보통', note: '포트 설명에 NIC MAC', tone: 'warn' },
  'desc-nic': { label: '보통', note: '포트 설명에 호스트 이름 + vmnic', tone: 'warn' },
  'desc-name': { label: '보통', note: '포트 설명에 호스트 이름', tone: 'warn' },
});
