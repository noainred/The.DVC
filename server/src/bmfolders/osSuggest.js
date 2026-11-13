/**
 * bmfolders/osSuggest.js — 물리서버 **OS 접속 주소 제안**(v2.992 · 설계 docs/design/bm-folders §13 ② · ③). 순수.
 *
 * 사용자 요청(2026-11-13): "idrac hostname 을 management network 에서 동일한 hostname 을 찾아서 그 서버의 OS 접속 가능한 IP 를 자동으로 찾아서 제안".
 * 결정(기본값 컨펌): 사람이 확인하고 등록 · 이름 기준 = 대소문자 무시 + 도메인 뒤를 떼고 짧은 이름 · 이름 찾는 방법 = 역방향 + 정방향 DNS ·
 *   자리 = IP 관리 › IP 스캔의 탭 · **주소만**(계정 · 비밀번호 없음 · 등록 전 접속 시도 없음) · 같은 법인의 스캔 대역 안에서만.
 *
 * '같은 법인' 판정: 스캔 결과 행의 에이전트(인증된 엣지 이름 — 중앙 직접 스캔은 LOCAL)가 ① 그 서버의 법인(vCenter)을 수집하는 에이전트이거나
 *   (`corpsOf` — ipam/scanDatacenter.js agentVcenterIds, IP 스캔 데이터센터 귀속과 같은 판정) ② 그 서버를 수집하는 엣지(remoteAgent · 중앙 수집이면 '')일 때만.
 *   둘 다 아니면 이름이 같아도 후보가 아니다(다른 법인의 같은 이름 — 사설 IP · 이름 재사용). 엣지는 자기 법인 서버의 이름만 받는다(fwdNamesFor).
 *
 * 상태(행 하나 = 물리서버 하나):
 *   registered — OS 등록이 있고 후보가 없거나 후보 중 하나가 그 주소 · differs — 등록 주소와 다른 IP 만 이름이 같다(자동으로 바꾸지 않는다) ·
 *   ambiguous — 같은 이름 · 주소의 OS 등록이 여럿(어느 것인지 모름 — pickOsEntry os-ambiguous) ·
 *   suggest — 등록 없음 + 이름 같고 SSH(22) 열린 IP 하나 · pick — 그런 IP 가 둘 이상(사람이 고른다) ·
 *   closed — 이름은 같지만 SSH 포트가 닫혀 있음(제안하지 않는다) · none — 같은 이름의 IP 없음 · noname — iDRAC 이 이름을 읽지 못했다(이름이 주소 · 빈 값).
 */
const t = (v) => String(v ?? '').trim();
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 이름 견주기 열쇠 — 소문자 · 끝 점 제거 · 도메인 뒤를 뗀 짧은 이름. IPv4 꼴이면 ''(이름이 아니다). */
export function shortName(v) {
  const s = t(v).toLowerCase().replace(/\.$/, '');
  if (!s || IPV4.test(s)) return '';
  const i = s.indexOf('.');
  return (i > 0 ? s.slice(0, i) : s).slice(0, 63);
}
/** 에이전트 열쇠 — 중앙 직접 스캔(LOCAL)과 중앙 수집('')을 같은 '' 로. */
export const LOCAL_AGENT = '__local__';
export function agentKey(v) { const s = t(v).toLowerCase(); return s === LOCAL_AGENT ? '' : s; }

/** 관리 주소에서 호스트만(스킴 · 경로 · 포트 제거) — iDRAC 자기 주소를 후보에서 빼려고. */
function hostOnly(v) {
  let s = t(v).toLowerCase();
  const i = s.indexOf('://'); if (i >= 0) s = s.slice(i + 3);
  const j = s.search(/[/?#]/); if (j >= 0) s = s.slice(0, j);
  const k = s.lastIndexOf(':'); if (k > 0 && IPV4.test(s.slice(0, k))) s = s.slice(0, k);
  return s;
}

/** 물리서버로 셀 구성원(이름을 견줄 수 있는 것) — 폴더 구성원(membersOf) 중 베어메탈. */
const bmOf = (members) => (Array.isArray(members) ? members : []).filter((m) => m && m.kind === 'bm');

/**
 * 정방향 DNS 로 물을 이름(배정 · 중앙 스캔에 싣는다) — 그 에이전트가 수집하는 물리서버의 이름만(법인 로컬 · 다른 법인 이름을 주지 않는다).
 * @param {object[]} members  membersOf(g).members
 * @param {string}   agent    엣지 이름 · 중앙 직접 스캔이면 ''
 */
export function fwdNamesFor(members, agent, corps = null) {
  const a = agentKey(agent);
  const out = []; const seen = new Set();
  for (const m of bmOf(members)) {
    if (m.nameIsAddr) continue;
    if (agentKey(m.remoteAgent) !== a && !(corps && t(m.corp) && corps.has(t(m.corp)))) continue;
    const n = t(m.name);
    const k = shortName(n);
    if (!k || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase()); out.push(n);
  }
  return out;
}

/**
 * 스캔 결과 색인 — 짧은 이름 → [{ip, vias, ...}]. 이름 출처는 방식별로 가른다(v2.991 호스트명 확인 — 저장 `names: { dns|mdns|netbios: {v} }`):
 *   'dns'(역방향 DNS) · 'mdns' · 'netbios' · 'fwd'(정방향 DNS — 물리서버 이름으로 물어 이 IP). 방식별 이름이 없는 옛 행은 hostname 을 'dns' 로 본다.
 *   want 에 있는 이름만 담는다(전량 26만 행을 다 담지 않게).
 */
export const NAME_SRC = Object.freeze(['dns', 'mdns', 'netbios']);
export function indexScanByName(rows, want) {
  const by = new Map();
  const add = (k, r, via) => {
    if (!k || !want.has(k)) return;
    let l = by.get(k); if (!l) { l = []; by.set(k, l); }
    const ex = l.find((x) => x.ip === r.ip);
    if (ex) { if (!ex.vias.includes(via)) ex.vias.push(via); return; }
    l.push({ ip: r.ip, vias: [via], agent: agentKey(r.agent), ssh: Array.isArray(r.openPorts) && r.openPorts.includes(22), scanName: t(r.hostname), fwdName: t(r.fwdName), lastSeen: Number(r.lastSeen) || null });
  };
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !IPV4.test(t(r.ip))) continue;
    const nm = r.names && typeof r.names === 'object' ? r.names : null;
    let any = false;
    for (const m of NAME_SRC) { const v = nm?.[m] && typeof nm[m] === 'object' ? nm[m].v : nm?.[m]; if (typeof v === 'string' && v) { add(shortName(v), r, m); any = true; } }
    if (!any) add(shortName(r.hostname), r, 'dns');
    add(shortName(r.fwdName), r, 'fwd');
  }
  return by;
}

/**
 * 제안 행 만들기(순수).
 * @param {object} p
 * @param {object[]} p.members   membersOf(g).members
 * @param {Iterable} p.scanRows  스캔 결과 행(getScanResults 의 값들)
 * @param {object}   p.osIndex   bmusage/targets.js indexOsHosts(OS 등록 전부 — 주소만 등록 포함)
 * @param {function} p.pickOsEntry bmusage/targets.js pickOsEntry
 */
export function buildOsSuggest({ members = [], scanRows = [], osIndex = null, pickOsEntry = null, corpsOf = null } = {}) {
  const corpMemo = new Map();
  const corpsFor = (ag) => { if (typeof corpsOf !== 'function') return null; if (!corpMemo.has(ag)) { let v = null; try { v = corpsOf(ag); } catch { v = null; } corpMemo.set(ag, v instanceof Set ? v : null); } return corpMemo.get(ag); };
  const sameCorp = (c, m) => c.agent === agentKey(m.remoteAgent) || !!(t(m.corp) && corpsFor(c.agent)?.has(t(m.corp)));
  const bms = bmOf(members);
  const want = new Set(bms.map((m) => (m.nameIsAddr ? '' : shortName(m.name))).filter(Boolean));
  const idx = indexScanByName(scanRows, want);
  const rows = []; const counts = { registered: 0, differs: 0, ambiguous: 0, suggest: 0, pick: 0, closed: 0, none: 0, noname: 0 };
  for (const m of bms) {
    const k = m.nameIsAddr ? '' : shortName(m.name);
    const mg = hostOnly(m.mgmtHost);
    // 같은 법인 · iDRAC 자기 주소가 아닌 IP 만
    const cands = k ? (idx.get(k) || []).filter((c) => sameCorp(c, m) && c.ip !== mg).sort((x, y) => (y.ssh - x.ssh) || x.ip.localeCompare(y.ip, 'en', { numeric: true })) : [];
    const pick = osIndex && typeof pickOsEntry === 'function' ? pickOsEntry(osIndex, { regHost: m.mgmtHost, name: m.name, vc: m.corp }) : { entry: null, reason: '' };
    const reg = pick?.entry || null;
    let state;
    if (pick?.reason === 'os-ambiguous') state = 'ambiguous';
    else if (reg) state = !cands.length || cands.some((c) => c.ip === hostOnly(reg.host)) ? 'registered' : 'differs';
    else if (!k) state = 'noname';
    else if (!cands.length) state = 'none';
    else {
      const ssh = new Set(cands.filter((c) => c.ssh).map((c) => c.ip));
      state = !ssh.size ? 'closed' : ssh.size === 1 ? 'suggest' : 'pick';
    }
    counts[state] += 1;
    rows.push({
      key: m.key, corp: t(m.corp), name: t(m.name), serviceTag: t(m.serviceTag), mgmtHost: t(m.mgmtHost), agent: t(m.remoteAgent),
      state, cands: cands.slice(0, 8),
      ...(reg ? { reg: { host: t(reg.host), addrOnly: reg.addrOnly === true, id: t(reg.id) } } : {}),
    });
  }
  return { rows, counts, total: bms.length };
}

/** 등록 요청 검사(순수) — 지금 다시 계산한 제안에서 **suggest · pick** 상태이고 고른 IP 가 SSH 열린 후보일 때만. */
export function applyPlan(rowsByKey, items, { max = 200 } = {}) {
  const ok = []; const refused = [];
  const seen = new Set();
  for (const it of (Array.isArray(items) ? items : []).slice(0, max)) {
    const key = typeof it?.key === 'string' ? it.key : ''; const ip = typeof it?.ip === 'string' ? it.ip.trim() : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const r = rowsByKey.get(key);
    if (!r) { refused.push({ key, why: 'gone' }); continue; }
    if (r.state !== 'suggest' && r.state !== 'pick') { refused.push({ key, why: r.state }); continue; }
    const c = r.cands.find((x) => x.ip === ip && x.ssh);
    if (!c) { refused.push({ key, why: 'not-candidate' }); continue; }
    ok.push({ row: r, ip });
  }
  return { ok, refused };
}
