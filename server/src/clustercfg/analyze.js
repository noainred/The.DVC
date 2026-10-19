/**
 * clustercfg/analyze.js — 특수 기능 '클러스터 HA·DRS 점검'(도구 키 `cluster-check`, v2.701) 판정(순수).
 * 입력은 스냅샷 vCenter 배열(vc.clusterCfg = clustercfg 캐시)과 호스트 배열. vCenter 왕복 0.
 *
 * 정직 규칙
 *  · 클러스터 목록은 '호스트가 속한 클러스터 ∪ 구성을 읽은 클러스터' 다. 구성을 아직 읽지 않은 클러스터는
 *    판정하지 않고 '미수집' 으로 센다 — 빈 결과를 '이상 없음' 이라 말하지 않는다.
 *  · 수집 대기·연결 실패 vCenter 의 클러스터도 같다(구성 배열이 없으면 미수집).
 */
import { CLUSTER_CFG_CODES, clusterCfgFindings } from './parse.js';

const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
export const ROWS_MAX = 2000;
const keyOf = (vcId, name) => `${vcId}\u0000${String(name).toLowerCase()}`;

/*
 * v2.742(감사 VC-05): 클러스터 식별은 (vCenter, 클러스터 moref) 다. vSphere 의 클러스터 이름은 **데이터센터 안에서만** 유일해서
 *   (vCenter, 이름) 으로 묶으면 다른 데이터센터의 같은 이름 클러스터가 한 행이 됐다 — 뒤 구성이 앞 구성을 덮어 HA 꺼짐 클러스터가
 *   숨고, 두 묶음 호스트를 합쳐 없는 'EVC 꺼짐·CPU 모델 혼재' 가 떴다(재현).
 *   · 호스트가 clusterRef 를 싣는 vCenter(2.742 이후 수집)는 ref 로 묶는다. 구성(clusterCfg)은 v2.701 부터 ref 를 싣는다.
 *   · ⚠ 구버전 엣지 스냅샷처럼 clusterRef 가 없는 호스트가 하나라도 있는 vCenter 는 **예전 이름 키**로 떨어진다 — 한 vCenter 안에서
 *     두 키를 섞으면 같은 클러스터가 '호스트만 있는 행' 과 '구성만 있는 행' 둘로 갈린다. 이름 키에서 구성끼리 이름이 겹치면 합치지
 *     않는다 — 구성마다 행을 따로 두고 호스트는 어느 쪽인지 알 수 없어 붙이지 않는다(nameCollision · hostsAmbiguous 로 밝힌다).
 */
const refOf = (x) => (typeof x?.clusterRef === 'string' && x.clusterRef ? x.clusterRef : null);
const refKeyOf = (vcId, ref) => `${vcId}\u0000r:${ref}`;
const inCluster = (h) => !!h && typeof h.cluster === 'string' && h.cluster !== '' && h.cluster !== 'standalone';

/** vCenter 마다 ref 로 묶을 수 있는가 — 클러스터에 속한 호스트가 **전부** clusterRef 를 실었을 때만 true. 클러스터 호스트가 없는 vCenter 는 항목이 없다. */
export function clusterRefMode(hosts) {
  const mode = new Map();
  for (const h of Array.isArray(hosts) ? hosts : []) {
    if (!inCluster(h)) continue;
    mode.set(h.vcenterId, (mode.get(h.vcenterId) ?? true) && !!refOf(h));
  }
  return mode;
}

/**
 * 호스트 → 클러스터 묶음 키(같은 vCenter·같은 클러스터면 같은 값). 독립·소속 미상 호스트는 null. mode 는 clusterRefMode 의 결과.
 * v2.744(감사 VC-02): VM 도 이 함수로 묶는다(VM 은 호스트의 cluster·clusterRef 를 싣는다). ref 모드 vCenter 에서 ref 가 없는 원소
 *   (엣지 수신 정제가 형식 밖 ref 를 null 로 바꾼 VM 등)는 'r:null' 키가 아니라 이름 키로 떨어진다 — 호스트는 ref 모드면 전부
 *   ref 를 실었으므로(clusterRefMode 의 조건) 호스트 결과는 예전과 같다.
 */
export function clusterGroupKeyOf(h, mode) {
  if (!inCluster(h)) return null;
  return mode?.get(h.vcenterId) === true && refOf(h) ? refKeyOf(h.vcenterId, refOf(h)) : keyOf(h.vcenterId, h.cluster);
}

/**
 * v2.744(감사 VC-02): 판정 경로(vSAN 분할·호스트 드리프트·용량·비용 배분·이전 준비도·토폴로지)가 함께 쓰는 클러스터 색인.
 *   v2.742 VC-05 는 클러스터 점검·N+1 만 ref 로 묶고 나머지를 '이력 연속성 판단 필요' 로 남겼는데, 그중 이 경로들은 **저장하지 않는
 *   실시간 판정**이다 — (vCenter, 이름) 으로 묶으면 다른 데이터센터의 같은 이름 클러스터가 한 묶음이 되어 vSAN 분할 crit·드리프트
 *   경고·합계가 거짓이 됐다(재현: DC 둘의 4대 'Prod' → '보고 멤버 4 < vSAN 호스트 8'). 묶음 키는 clusterGroupKeyOf 하나다.
 *   ⚠ 시계열 키(metrics/sampler.js temp_cluster·gpu_cluster)는 이 색인을 쓰지 않는다 — 키를 바꾸면 그 클러스터의 이력이 끊긴다.
 * @param hosts 그 판정이 보는 호스트 전부(모드는 vCenter 마다 '클러스터 호스트가 전부 ref 를 실었는가' 로 정한다)
 * @returns {{ mode: Map, keyOf: (x)=>string|null, meta: (key)=>{clusterRef, vcDatacenter, sameName} }}
 *   meta.sameName = 같은 vCenter 안 같은 이름(대소문자 무시) 묶음 수 — 2 이상이면 이름만으로 구분할 수 없다(clusterLabelOf 가 데이터센터를 붙인다).
 */
export function clusterIndex(hosts) {
  const hl = Array.isArray(hosts) ? hosts : [];
  const mode = clusterRefMode(hl);
  const info = new Map();   // 묶음 키 → { vcenterId, name, ref, vcDatacenter }
  for (const h of hl) {
    const k = clusterGroupKeyOf(h, mode);
    if (!k) continue;
    let g = info.get(k);
    if (!g) { g = { vcenterId: h.vcenterId, name: h.cluster, ref: mode.get(h.vcenterId) === true ? refOf(h) : null, vcDatacenter: null }; info.set(k, g); }
    if (!g.vcDatacenter && typeof h.vcDatacenter === 'string' && h.vcDatacenter) g.vcDatacenter = h.vcDatacenter;
  }
  const nameN = new Map();
  for (const g of info.values()) { const nk = keyOf(g.vcenterId, g.name); nameN.set(nk, (nameN.get(nk) || 0) + 1); }
  const keyFn = (x) => clusterGroupKeyOf(x, mode);
  return {
    mode,
    keyOf: keyFn,
    meta(k) {
      const g = k ? info.get(k) : null;
      if (!g) return { clusterRef: null, vcDatacenter: null, sameName: 1 };
      return { clusterRef: g.ref, vcDatacenter: g.vcDatacenter, sameName: nameN.get(keyOf(g.vcenterId, g.name)) || 1 };
    },
  };
}

/**
 * v2.744(감사 VC-02): 서버가 글자를 만드는 곳(토폴로지 노드·비용 배분 그룹 이름·CSV)의 클러스터 이름 —
 *   웹 views/clustercfg/clusterCfgText.js clusterNameLabel 과 **같은 규칙**이다(같은 이름이 둘 이상일 때만 데이터센터, 모르면 ref 를 붙인다).
 *   번들 경계라 두 벌이고 server/test/audit2744f.test.js 가 같은 입력으로 두 결과를 대조한다.
 */
export function clusterLabelOf(r) {
  const name = r?.name ?? r?.cluster ?? '';
  if (!r || !(r.sameName > 1)) return String(name);
  if (r.vcDatacenter) return `${name} · ${r.vcDatacenter}`;
  const ref = typeof r.ref === 'string' && r.ref ? r.ref : typeof r.clusterRef === 'string' && r.clusterRef ? r.clusterRef : null;
  if (ref) return `${name} (${ref})`;
  return `${name} (같은 이름 ${r.sameName}개 — 구분 불가)`;
}

/**
 * v2.743(감사 LEFT-07): 클러스터 개수 — 클러스터에 속한 호스트의 묶음 키(clusterGroupKeyOf) 수.
 *   예전 /summary·공개 API 는 `${vcenterId}/${cluster}` 이름으로 세서 다른 데이터센터의 같은 이름 클러스터를 하나로 합치고,
 *   수집기가 독립 호스트에 채우는 'standalone' 을 클러스터 하나로 셌다. 독립·소속 미상 호스트는 세지 않는다.
 *   ⚠ 내부 /summary 와 공개 API /inventory/summary 가 이 함수 하나를 쓴다(대조 계약 — 한쪽만 바꾸면 publicApi2562 가 갈라진다).
 *   호스트가 하나도 없는 빈 클러스터는 예전처럼 세지 않는다(호스트에서 센다).
 */
export function clusterCountOf(hosts) {
  const hl = Array.isArray(hosts) ? hosts : [];
  const mode = clusterRefMode(hl);
  const keys = new Set();
  for (const h of hl) { const k = clusterGroupKeyOf(h, mode); if (k) keys.add(k); }
  return keys.size;
}

export function analyzeClusters(vcenters, hosts, opt = {}) {
  const vcs = Array.isArray(vcenters) ? vcenters : [];
  const hl = Array.isArray(hosts) ? hosts : [];
  const vcName = new Map(vcs.map((v) => [v.id, v.name || v.id]));
  const mode = clusterRefMode(hl);
  const hostsBy = new Map();
  for (const h of hl) {
    const k = clusterGroupKeyOf(h, mode);
    if (!k) continue;
    if (!hostsBy.has(k)) hostsBy.set(k, { vcenterId: h.vcenterId, name: h.cluster, ref: mode.get(h.vcenterId) === true ? refOf(h) : null, vcDatacenter: null, hosts: [] });
    const g = hostsBy.get(k);
    if (!g.vcDatacenter && typeof h.vcDatacenter === 'string' && h.vcDatacenter) g.vcDatacenter = h.vcDatacenter;
    g.hosts.push(h);
  }
  const cfgBy = new Map();
  const ambiguousHosts = new Map();   // 이름 키 vCenter 에서 이름이 겹친 구성 키 → 그 이름의 호스트 수(어느 구성 소속인지 모름)
  let hostsAmbiguous = 0;
  for (const v of vcs) {
    const list = (Array.isArray(v.clusterCfg) ? v.clusterCfg : []).filter((c) => c && typeof c === 'object');
    if (mode.get(v.id) !== false) {
      // ref 묶음(또는 클러스터 호스트가 없는 vCenter) — 구성은 ref 로(ref 가 없는 옛 구성만 이름으로).
      for (const c of list) cfgBy.set(c.ref ? refKeyOf(v.id, c.ref) : keyOf(v.id, c.name), { vcenterId: v.id, cfg: c });
      continue;
    }
    const byName = new Map();
    for (const c of list) { const nk = keyOf(v.id, c.name); if (!byName.has(nk)) byName.set(nk, []); byName.get(nk).push(c); }
    for (const [nk, cs] of byName) {
      if (cs.length === 1) { cfgBy.set(nk, { vcenterId: v.id, cfg: cs[0] }); continue; }
      const hb = hostsBy.get(nk);
      const n = hb ? hb.hosts.length : 0;
      if (hb) { hostsBy.delete(nk); hostsAmbiguous += n; }
      cs.forEach((c, i) => {
        const k = c.ref ? refKeyOf(v.id, c.ref) : `${nk}\u0000#${i}`;
        cfgBy.set(k, { vcenterId: v.id, cfg: c, nameCollision: cs.length });
        ambiguousHosts.set(k, n);
      });
    }
  }
  const keys = new Set([...hostsBy.keys(), ...cfgBy.keys()]);
  const coverage = { clusters: keys.size, cfg: 0, notCollected: 0, hostsAmbiguous };
  const byCode = Object.fromEntries(Object.entries(CLUSTER_CFG_CODES).map(([c, sev]) => [c, { sev, clusters: 0 }]));
  const totals = { haOn: 0, haOff: 0, drsOn: 0, drsOff: 0, rules: 0, rulesViolated: 0 };
  const rows = [];
  const byVc = new Map();
  // 같은 vCenter 안 같은 이름 클러스터 수 — 화면이 이름만으로 구분할 수 없을 때 데이터센터(또는 ref)를 함께 보이게 싣는다.
  const nameCount = new Map();
  for (const k of keys) {
    const hb = hostsBy.get(k); const cb = cfgBy.get(k);
    const nk = keyOf(hb?.vcenterId ?? cb.vcenterId, cb?.cfg?.name ?? hb.name);
    nameCount.set(nk, (nameCount.get(nk) || 0) + 1);
  }
  for (const k of keys) {
    const hb = hostsBy.get(k);
    const cb = cfgBy.get(k);
    const vcenterId = hb?.vcenterId ?? cb.vcenterId;
    const name = cb?.cfg?.name ?? hb.name;
    const hostList = hb?.hosts || [];
    const cfg = cb?.cfg || null;
    const ambiguous = ambiguousHosts.has(k);   // 이름 키 vCenter 의 이름 겹침 — 호스트를 어느 구성에도 붙이지 않았다
    let findings = [];
    if (cfg) {
      coverage.cfg += 1;
      findings = clusterCfgFindings(cfg, hostList);
      if (cfg.ha?.enabled === true) totals.haOn += 1; else if (cfg.ha?.enabled === false) totals.haOff += 1;
      if (cfg.drs?.enabled === true) totals.drsOn += 1; else if (cfg.drs?.enabled === false) totals.drsOff += 1;
      totals.rules += Array.isArray(cfg.rules) ? cfg.rules.length : 0;
      totals.rulesViolated += (cfg.rules || []).filter((r) => r.enabled === true && r.inCompliance === false).length;
    } else coverage.notCollected += 1;
    const seen = new Set(findings.map((f) => f.code));
    for (const c of seen) byCode[c].clusters += 1;
    const vs = byVc.get(vcenterId) || { vcenterId, name: vcName.get(vcenterId) || vcenterId, clusters: 0, withFindings: 0 };
    vs.clusters += 1; if (findings.length) vs.withFindings += 1; byVc.set(vcenterId, vs);
    findings.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    const sev = findings[0]?.sev || null;
    if (opt.code && !seen.has(opt.code)) continue;
    if (opt.sev && sev !== opt.sev) continue;
    if (opt.q) {
      const q = String(opt.q).toLowerCase();
      if (![name, vcName.get(vcenterId), hb?.vcDatacenter].some((x) => String(x || '').toLowerCase().includes(q))) continue;
    }
    rows.push({
      vcenterId, vcenterName: vcName.get(vcenterId) || vcenterId, name,
      // v2.742(VC-05): 클러스터 moref(모르면 null) · vSphere 데이터센터 이름(모르면 null) · 같은 vCenter 의 같은 이름 행 수(2 이상이면 이름만으로 구분할 수 없다).
      ref: cfg?.ref ?? hb?.ref ?? null, vcDatacenter: hb?.vcDatacenter ?? null,
      sameName: nameCount.get(keyOf(vcenterId, name)) || 1,
      ...(ambiguous ? { nameCollision: cb.nameCollision, hostsAmbiguous: ambiguousHosts.get(k) } : {}),
      // 이름 겹침으로 호스트를 붙이지 못한 행은 호스트 수를 모른다(null — 0 대로 보이지 않게).
      hosts: ambiguous ? null : hostList.length, hostsDisconnected: ambiguous ? null : hostList.filter((h) => h.connectionState === 'DISCONNECTED').length,
      collected: !!cfg, at: cfg?.at ?? null,
      ha: cfg?.ha ?? null, drs: cfg?.drs ?? null, evc: cfg ? cfg.evc : null,
      numHosts: cfg?.numHosts ?? null, numEffectiveHosts: cfg?.numEffectiveHosts ?? null,
      rulesTotal: cfg?.rulesTotal ?? null,
      rules: (cfg?.rules || []).map((r) => ({ name: r.name, type: r.type, enabled: r.enabled, inCompliance: r.inCompliance, mandatory: r.mandatory, vmCount: r.vms.length })),
      sev, findings,
    });
  }
  rows.sort((a, b) => (a.sev == null) - (b.sev == null) || (SEV_ORDER[a.sev] ?? 9) - (SEV_ORDER[b.sev] ?? 9)
    || b.findings.length - a.findings.length || String(a.vcenterName).localeCompare(String(b.vcenterName)) || String(a.name).localeCompare(String(b.name)));
  const matched = rows.length;
  const vcList = [...byVc.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { coverage, byCode, totals, vcenters: vcList, matched, rows: rows.slice(0, ROWS_MAX), omitted: Math.max(0, matched - ROWS_MAX) };
}

/**
 * 상세 창용 — 클러스터 하나 + (VM 이면) 그 VM 이 들어 있는 규칙. vmId 는 `${vcenterId}:${ref}` 이고
 * vCenter id 에 콜론이 있을 수 있어 split 하지 않고 접두를 뗀다.
 * v2.742(감사 VC-05): 이름만으로 찾으면 다른 데이터센터의 같은 이름 클러스터 구성을 줄 수 있다 — ref(클러스터 moref)를 먼저 쓴다.
 *   ref 는 opt.clusterRef → opt.hostId 의 호스트 clusterRef → vmId 의 VM clusterRef(opt.vms) 순서로 얻는다.
 *   ref 를 모르는데 이름이 같은 구성이 둘 이상이면 고르지 않는다(reason 'ambiguous' + candidates) — 엉뚱한 클러스터를 보여 주지 않는다.
 */
export function clusterOf(vcenters, hosts, vcenterId, clusterName, vmId = null, opt = {}) {
  if (!vcenterId || !clusterName || clusterName === 'standalone') return { cluster: null, vmRules: null, reason: 'standalone' };
  const vc = (vcenters || []).find((v) => v.id === vcenterId);
  const want = String(clusterName).toLowerCase();
  const hl = (Array.isArray(hosts) ? hosts : []).filter((h) => h && h.vcenterId === vcenterId);
  let ref = typeof opt?.clusterRef === 'string' && opt.clusterRef ? opt.clusterRef : null;
  if (!ref && typeof opt?.hostId === 'string' && opt.hostId) ref = refOf(hl.find((h) => h.id === opt.hostId));
  if (!ref && typeof vmId === 'string' && Array.isArray(opt?.vms)) ref = refOf(opt.vms.find((v) => v && v.id === vmId && v.vcenterId === vcenterId));
  const named = (Array.isArray(vc?.clusterCfg) ? vc.clusterCfg : []).filter((cl) => cl && typeof cl === 'object' && String(cl.name).toLowerCase() === want);
  let cfg = null;
  let hostList;
  if (ref) {
    cfg = named.find((cl) => cl.ref === ref) || null;
    // ref 를 싣지 않은 옛 구성(구버전 엣지)이 그 이름에 하나뿐이면 그것이다 — 둘 이상이면 고르지 않는다.
    if (!cfg && named.length === 1 && !named[0].ref) cfg = named[0];
    hostList = hl.filter((h) => refOf(h) === ref);
  } else {
    if (named.length > 1) {
      return { cluster: null, vmRules: null, reason: 'ambiguous', candidates: named.length, hosts: null };
    }
    cfg = named[0] || null;
    hostList = hl.filter((h) => String(h.cluster).toLowerCase() === want);
  }
  if (!cfg) return { cluster: null, vmRules: null, reason: 'not-collected', hosts: hostList.length };
  let vmRules = null;
  if (typeof vmId === 'string' && vmId.startsWith(`${vcenterId}:`)) {
    const vmRef = vmId.slice(vcenterId.length + 1);
    vmRules = (cfg.rules || []).filter((r) => r.vms.includes(vmRef)).map((r) => ({ name: r.name, type: r.type, enabled: r.enabled, inCompliance: r.inCompliance, mandatory: r.mandatory }));
  }
  return {
    cluster: { name: cfg.name, ref: cfg.ref ?? null, at: cfg.at, ha: cfg.ha, drs: cfg.drs, evc: cfg.evc, numHosts: cfg.numHosts, numEffectiveHosts: cfg.numEffectiveHosts, rulesTotal: cfg.rulesTotal, hosts: hostList.length },
    findings: clusterCfgFindings(cfg, hostList),
    vmRules,
  };
}
