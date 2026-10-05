// 클러스터 HA·DRS 점검(v2.701 — A6) · 순수 파서·판정.
// 모양(vcenter.clusterCfg[] 원소 — 배열에 없는 클러스터는 '미수집', 판정하지 않는다):
//   { ref, name, at, ha: { enabled, admission, hostMon, vmMon }|null, drs: { enabled, behavior }|null,
//     rules: [{ name, type, enabled, inCompliance, mandatory, vms: [ref…] }], rulesTotal, evc: string|''|null,
//     numHosts: int|null, numEffectiveHosts: int|null }
// 못 읽은 값은 null(false·0 이 아니다). EVC 는 '' 가 '꺼짐' 이고 null 은 '모름' 이다.
import { xmlUnescape } from '../vcenter/soapParse.js';

/** 전부 vSphere 5.0+ 경로. summary 는 ClusterComputeResourceSummary(EVC·유효 호스트 수) — 하위 경로는 선언 형식이 달라 통째로 읽는다. */
export const CLUSTER_CFG_PATHS = Object.freeze(['name', 'configurationEx', 'summary']);
export const RULES_MAX = 50;
export const RULE_VMS_MAX = 100;

const cap = (s, n = 128) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) : t; };
const tag = (xml, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml || ''); return m ? xmlUnescape(m[1]) : null; };
const boolOf = (v) => (v === 'true' ? true : v === 'false' ? false : null);
const intOf = (v) => (typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v) : null);

/** 첫 번째 <name>…</name> 블록(선형 — indexOf). 없으면 null. */
function block(xml, name) {
  if (typeof xml !== 'string') return null;
  const s = xml.indexOf(`<${name}`);
  if (s < 0) return null;
  const open = xml.indexOf('>', s);
  if (open < 0) return null;
  const e = xml.indexOf(`</${name}>`, open);
  if (e < 0) return null;
  return xml.slice(open + 1, e);
}

/** 반복 블록 전부(선형). 같은 이름의 블록이 중첩되지 않는 요소에만 쓴다. */
function blocks(xml, name, max = 10_000) {
  const out = [];
  if (typeof xml !== 'string') return out;
  let i = 0;
  while (out.length < max) {
    let s = xml.indexOf(`<${name}`, i);
    if (s < 0) break;
    const c = xml.charCodeAt(s + name.length + 1); // 다음 글자가 ' ' 또는 '>' 여야 같은 태그다(<ruleX> 오인 방지)
    if (c !== 32 && c !== 62) { i = s + 1; continue; }
    const open = xml.indexOf('>', s);
    const e = open < 0 ? -1 : xml.indexOf(`</${name}>`, open);
    if (e < 0) break;
    out.push({ attrs: xml.slice(s, open), body: xml.slice(open + 1, e) });
    i = e + name.length + 3;
  }
  return out;
}

const RULE_TYPE = {
  ClusterAffinityRuleSpec: 'affinity',
  ClusterAntiAffinityRuleSpec: 'anti-affinity',
  ClusterVmHostRuleInfo: 'vm-host',
  ClusterDependencyRuleInfo: 'dependency',
};

export function parseRules(cfgXml) {
  const all = blocks(cfgXml, 'rule');
  const rules = [];
  for (const b of all.slice(0, RULES_MAX)) {
    const t = /xsi:type="([^"]+)"/.exec(b.attrs)?.[1] || '';
    const vms = [];
    for (const m of b.body.matchAll(/<vm(?: [^>]*)?>([^<]{1,64})<\/vm>/g)) { if (vms.length >= RULE_VMS_MAX) break; vms.push(m[1].trim()); }
    rules.push({
      name: cap(tag(b.body, 'name') || '(이름 없음)'),
      type: RULE_TYPE[t] || 'other',
      enabled: boolOf(tag(b.body, 'enabled')),
      inCompliance: boolOf(tag(b.body, 'inCompliance')),
      mandatory: boolOf(tag(b.body, 'mandatory')),
      vms,
    });
  }
  return { rules, rulesTotal: all.length };
}

export function parseClusterCfgProps(ref, props = {}, at = Date.now()) {
  const p = props || {};
  const cfg = typeof p.configurationEx === 'string' ? p.configurationEx : null;
  const das = cfg == null ? null : block(cfg, 'dasConfig');
  const drs = cfg == null ? null : block(cfg, 'drsConfig');
  const sum = typeof p.summary === 'string' ? p.summary : null;
  const { rules, rulesTotal } = cfg == null ? { rules: [], rulesTotal: null } : parseRules(cfg);
  return {
    ref: cap(ref, 64),
    name: cap(p.name || ref),
    at,
    // dasConfig 의 첫 <enabled> 는 HA 자체다(그 아래 defaultVmSettings 의 enabled 는 뒤에 나온다).
    ha: das == null ? null : {
      enabled: boolOf(tag(das, 'enabled')),
      admission: boolOf(tag(das, 'admissionControlEnabled')),
      hostMon: (() => { const v = tag(das, 'hostMonitoring'); return v == null ? null : cap(v, 16); })(),
      vmMon: (() => { const v = tag(das, 'vmMonitoring'); return v == null ? null : cap(v, 32); })(),
    },
    drs: drs == null ? null : {
      enabled: boolOf(tag(drs, 'enabled')),
      behavior: (() => { const v = tag(drs, 'defaultVmBehavior'); return v == null ? null : cap(v, 32); })(),
    },
    rules,
    rulesTotal,
    // EVC: 키가 없으면 '꺼짐'(''), summary 자체를 못 읽었으면 null.
    evc: sum == null ? null : cap(tag(sum, 'currentEVCModeKey') || '', 64),
    numHosts: sum == null ? null : intOf(tag(sum, 'numHosts')),
    numEffectiveHosts: sum == null ? null : intOf(tag(sum, 'numEffectiveHosts')),
  };
}

// ── 판정 ────────────────────────────────────────────────────────────────────
export const CLUSTER_CFG_CODES = Object.freeze({
  'ha-off': 'warn',
  'ha-ac-off': 'warn',
  'ha-hostmon-off': 'warn',
  'hosts-ineffective': 'warn',
  'rule-violation': 'warn',
  'drs-off': 'info',
  'drs-manual': 'info',
  'rule-disabled': 'info',
  'evc-off-mixed': 'info',
  'single-host': 'info',
});

/**
 * 클러스터 하나의 판정. hostsInCluster 는 그 클러스터의 스냅샷 호스트(CPU 모델 대조용 — 연결된 호스트만 본다).
 * 호스트가 하나뿐인 클러스터에는 HA·DRS 판정을 하지 않는다(켤 수는 있어도 뜻이 없다 — single-host 하나로 말한다).
 */
export function clusterCfgFindings(cl, hostsInCluster = []) {
  const out = [];
  if (!cl) return out;
  const add = (code, facts = {}) => out.push({ code, sev: CLUSTER_CFG_CODES[code], facts });
  const live = (hostsInCluster || []).filter((h) => h && h.connectionState !== 'DISCONNECTED');
  const n = Number.isFinite(cl.numHosts) ? cl.numHosts : (hostsInCluster || []).length;
  if (n === 1) { add('single-host'); return out; }
  if (n === 0) return out;
  if (cl.ha) {
    if (cl.ha.enabled === false) add('ha-off');
    else if (cl.ha.enabled === true) {
      if (cl.ha.admission === false) add('ha-ac-off');
      if (cl.ha.hostMon === 'disabled') add('ha-hostmon-off');
    }
  }
  if (Number.isFinite(cl.numHosts) && Number.isFinite(cl.numEffectiveHosts) && cl.numEffectiveHosts < cl.numHosts) {
    add('hosts-ineffective', { effective: cl.numEffectiveHosts, total: cl.numHosts });
  }
  if (cl.drs) {
    if (cl.drs.enabled === false) add('drs-off');
    else if (cl.drs.enabled === true && cl.drs.behavior === 'manual') add('drs-manual');
  }
  const rules = Array.isArray(cl.rules) ? cl.rules : [];
  const viol = rules.filter((r) => r.enabled === true && r.inCompliance === false).map((r) => r.name);
  if (viol.length) add('rule-violation', { count: viol.length, names: viol.slice(0, 10) });
  const off = rules.filter((r) => r.enabled === false).map((r) => r.name);
  if (off.length) add('rule-disabled', { count: off.length, names: off.slice(0, 10) });
  if (cl.evc === '') {
    const models = [...new Set(live.map((h) => (typeof h.cpuModel === 'string' ? h.cpuModel.trim() : '')).filter(Boolean))];
    if (models.length > 1) add('evc-off-mixed', { models: models.slice(0, 6) });
  }
  return out;
}

// ── 엣지 수신 정제(아는 필드만) ─────────────────────────────────────────────
const numOr = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
const bOr = (v) => (typeof v === 'boolean' ? v : null);
const sOr = (v, n) => (typeof v === 'string' ? cap(v, n) : null);
export const CLUSTER_CFG_MAX = 500;

function sanitizeOne(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const ref = sOr(v.ref, 64);
  if (!ref) return null;
  const ha = v.ha && typeof v.ha === 'object' && !Array.isArray(v.ha)
    ? { enabled: bOr(v.ha.enabled), admission: bOr(v.ha.admission), hostMon: sOr(v.ha.hostMon, 16), vmMon: sOr(v.ha.vmMon, 32) } : null;
  const drs = v.drs && typeof v.drs === 'object' && !Array.isArray(v.drs)
    ? { enabled: bOr(v.drs.enabled), behavior: sOr(v.drs.behavior, 32) } : null;
  const rules = Array.isArray(v.rules) ? v.rules.slice(0, RULES_MAX).filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r) => ({
    name: sOr(r.name, 128) || '(이름 없음)',
    type: ['affinity', 'anti-affinity', 'vm-host', 'dependency', 'other'].includes(r.type) ? r.type : 'other',
    enabled: bOr(r.enabled), inCompliance: bOr(r.inCompliance), mandatory: bOr(r.mandatory),
    vms: Array.isArray(r.vms) ? r.vms.filter((x) => typeof x === 'string').map((x) => cap(x, 64)).slice(0, RULE_VMS_MAX) : [],
  })) : [];
  return {
    ref, name: sOr(v.name, 128) || ref, at: numOr(v.at), ha, drs, rules,
    rulesTotal: numOr(v.rulesTotal), evc: typeof v.evc === 'string' ? cap(v.evc, 64) : null,
    numHosts: numOr(v.numHosts), numEffectiveHosts: numOr(v.numEffectiveHosts),
  };
}

/** vcenter.clusterCfg 배열 정제 — 객체가 아닌 원소는 버리고 버린 개수를 돌려준다. */
export function sanitizeClusterCfgList(list) {
  if (!Array.isArray(list)) return { value: null, dropped: list == null ? 0 : 1 };
  const value = [];
  let dropped = 0;
  for (const x of list.slice(0, CLUSTER_CFG_MAX)) { const s = sanitizeOne(x); if (s) value.push(s); else dropped += 1; }
  dropped += Math.max(0, list.length - CLUSTER_CFG_MAX);
  return { value, dropped };
}
