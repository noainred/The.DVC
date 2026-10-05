// 호스트 구성·보안(v2.699 — A1 보안 하드닝 · A9 구성 드리프트 · A11 재부팅 필요·빌드 불일치 · A12 호스트 인증서 만료).
// 순수 파서·판정 — 수집(hostcfg/collect.js)·엣지 수신 정제(central)·화면 판정이 같은 모양을 쓰도록 이 모듈 하나가 소유한다.
//
// 모양(host.hcfg — 없으면 아직 읽지 않았다 = '미수집'. 판정하지 않는다):
//   { at, lockdown: 'disabled'|'normal'|'strict'|null, rebootRequired: bool|null,
//     services: { ssh:{running,policy}|null, shell:{running,policy}|null, ntpd:{running,policy}|null },
//     ntpServers: string[]|null, dnsServers: string[]|null, syslogHost: string|null(빈 문자열 = 설정 없음),
//     lockFailures: int|null, shellTimeout: int|null, mob: bool|null, acceptance: string|null,
//     certNotAfter: ms|null, certSubject: string|null }
//   - 못 읽은 값은 null 이다(false·0·빈 목록이 아니다 — 그것은 값이다).
import { xmlUnescape } from '../vcenter/soapParse.js';

/** 전부 vSphere 5.0+ 경로(없는 경로는 요청 전체를 InvalidProperty 로 만든다). lockdownMode(6.0+)는 따로 요청한다. */
export const HOST_CFG_PATHS = Object.freeze([
  'config.service', 'config.dateTimeInfo', 'config.network.dnsConfig', 'summary.rebootRequired',
  'configManager.certificateManager', 'configManager.advancedOption', 'configManager.imageConfigManager',
]);
export const HOST_LOCKDOWN_PATH = 'config.lockdownMode';
/** 고급 설정 — 호스트당 이름마다 QueryOptions 1회. 이름이 없는 버전은 InvalidName → 그 값만 null. */
export const ADV_OPTIONS = Object.freeze([
  'Syslog.global.logHost', 'Security.AccountLockFailures', 'UserVars.ESXiShellTimeOut', 'Config.HostAgent.plugins.solo.enableMob',
]);

const cap = (s, n = 256) => {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? (t.length > n ? t.slice(0, n) : t) : null;
};
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml || '');
  return m ? xmlUnescape(m[1]) : null;
};
const tagsAll = (xml, name, max = 16) => {
  const out = [];
  const re = new RegExp(`<${name}>([^<]*)</${name}>`, 'g');
  let m;
  while ((m = re.exec(xml || '')) && out.length < max) { const v = cap(xmlUnescape(m[1]), 128); if (v) out.push(v); }
  return out;
};
const boolOf = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
function intOf(v) {
  if (v == null || v === '' || typeof v === 'object') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).trim();
  return /^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
}

/** config.service — 서비스 블록에서 SSH(TSM-SSH)·ESXi Shell(TSM)·ntpd 만. */
export function parseServices(xml) {
  if (typeof xml !== 'string' || !xml.includes('<key>')) return null;
  const out = { ssh: null, shell: null, ntpd: null };
  const KEY = { 'TSM-SSH': 'ssh', TSM: 'shell', ntpd: 'ntpd' };
  let i = 0;
  for (;;) {
    const s = xml.indexOf('<service>', i);
    if (s < 0) break;
    const e = xml.indexOf('</service>', s);
    if (e < 0) break;
    const blk = xml.slice(s, e);
    const k = KEY[tag(blk, 'key')];
    if (k) out[k] = { running: boolOf(tag(blk, 'running')), policy: cap(tag(blk, 'policy'), 16) };
    i = e + 10;
  }
  return out;
}

const LOCKDOWN = { lockdownDisabled: 'disabled', lockdownNormal: 'normal', lockdownStrict: 'strict' };

/** 한 호스트의 속성 묶음 → hcfg 의 앞부분(고급 설정·인증서·허용 수준은 collect 가 덧붙인다). */
export function parseHostCfgProps(props = {}, at = Date.now()) {
  const p = props || {};
  const dt = typeof p['config.dateTimeInfo'] === 'string' ? p['config.dateTimeInfo'] : null;
  const ntpBlk = dt ? (/<ntpConfig>([\s\S]*?)<\/ntpConfig>/.exec(dt)?.[1] ?? '') : null;
  const dns = typeof p['config.network.dnsConfig'] === 'string' ? p['config.network.dnsConfig'] : null;
  const ld = p[HOST_LOCKDOWN_PATH];
  return {
    at,
    lockdown: typeof ld === 'string' ? (LOCKDOWN[ld.trim()] || null) : null,
    rebootRequired: boolOf(p['summary.rebootRequired']),
    services: parseServices(p['config.service']),
    ntpServers: ntpBlk == null ? null : tagsAll(ntpBlk, 'server'),
    dnsServers: dns == null ? null : tagsAll(dns, 'address'),
    syslogHost: null, lockFailures: null, shellTimeout: null, mob: null, acceptance: null,
    certNotAfter: null, certSubject: null,
  };
}

/** QueryOptions 응답 → 값(문자열·숫자·불리언). 값 노드가 없으면 '' (설정 비어 있음). */
export function parseOptionValue(xml, name) {
  if (typeof xml !== 'string') return null;
  const s = xml.indexOf(`<key>${name}</key>`);
  if (s < 0) return null;
  const rest = xml.slice(s, s + 4096);
  const m = /<value[^>]*>([^<]*)<\/value>/.exec(rest);
  if (!m) return /<value[^>]*\/>/.test(rest) ? '' : null;
  return xmlUnescape(m[1]);
}

/** HostCertificateManager.certificateInfo → { notAfter(ms), subject }. */
export function parseCertInfo(xml) {
  if (typeof xml !== 'string') return null;
  const na = Date.parse(tag(xml, 'notAfter') || '');
  return { notAfter: Number.isFinite(na) ? na : null, subject: cap(tag(xml, 'subject'), 200) };
}

export function applyAdvanced(h, name, raw) {
  if (raw == null) return;
  if (name === 'Syslog.global.logHost') h.syslogHost = cap(raw, 256) ?? '';
  else if (name === 'Security.AccountLockFailures') h.lockFailures = intOf(raw);
  else if (name === 'UserVars.ESXiShellTimeOut') h.shellTimeout = intOf(raw);
  else if (name === 'Config.HostAgent.plugins.solo.enableMob') h.mob = boolOf(String(raw).trim().toLowerCase());
}

// ── 판정 ────────────────────────────────────────────────────────────────────
export const HOST_CFG_CODES = Object.freeze({
  'cert-expired': 'crit',
  'cert-expiring': 'warn',
  'reboot-required': 'warn',
  'ssh-running': 'warn',
  'shell-running': 'warn',
  'ntp-none': 'warn',
  'syslog-none': 'warn',
  'acceptance-community': 'warn',
  'lockout-off': 'warn',
  'mob-enabled': 'warn',
  'ssh-autostart': 'info',
  'lockdown-off': 'info',
  'shell-timeout-off': 'info',
  drift: 'info',
});
export const CERT_WARN_DAYS = 30;
const DAY = 86_400_000;

/** 호스트 하나의 판정(드리프트는 analyze 가 클러스터 단위로 따로). 연결되지 않은 호스트는 판정하지 않는다. */
export function hostCfgFindings(host, now = Date.now()) {
  const h = host?.hcfg;
  const out = [];
  if (!h || host.connectionState === 'DISCONNECTED') return out;
  const add = (code, facts = {}) => out.push({ code, sev: HOST_CFG_CODES[code], facts });
  if (Number.isFinite(h.certNotAfter)) {
    const days = Math.floor((h.certNotAfter - now) / DAY);
    if (days < 0) add('cert-expired', { days: -days });
    else if (days <= CERT_WARN_DAYS) add('cert-expiring', { days });
  }
  if (h.rebootRequired === true) add('reboot-required');
  const sv = h.services;
  if (sv?.ssh?.running === true) add('ssh-running');
  if (sv?.shell?.running === true) add('shell-running');
  if (sv?.ssh?.policy === 'on') add('ssh-autostart');
  if (Array.isArray(h.ntpServers) && (h.ntpServers.length === 0 || sv?.ntpd?.running === false)) add('ntp-none', { servers: h.ntpServers.length, running: sv?.ntpd?.running ?? null });
  if (h.syslogHost === '') add('syslog-none');
  if (h.acceptance === 'community') add('acceptance-community');
  if (h.lockFailures === 0) add('lockout-off');
  if (h.mob === true) add('mob-enabled');
  if (h.lockdown === 'disabled') add('lockdown-off');
  if (h.shellTimeout === 0) add('shell-timeout-off');
  return out;
}

/** 드리프트 비교 대상(클러스터 안에서 같아야 하는 값). 값을 모르는 호스트는 비교에서 뺀다. */
export const DRIFT_FIELDS = Object.freeze({
  build: (host) => host.build || null,
  ntp: (host) => (Array.isArray(host.hcfg?.ntpServers) ? [...host.hcfg.ntpServers].map((x) => x.toLowerCase()).sort().join(', ') || '(없음)' : null),
  dns: (host) => (Array.isArray(host.hcfg?.dnsServers) ? [...host.hcfg.dnsServers].sort().join(', ') || '(없음)' : null),
  syslog: (host) => (host.hcfg?.syslogHost == null ? null : host.hcfg.syslogHost.toLowerCase() || '(없음)'),
  lockdown: (host) => host.hcfg?.lockdown ?? null,
  acceptance: (host) => host.hcfg?.acceptance ?? null,
  sshPolicy: (host) => host.hcfg?.services?.ssh?.policy ?? null,
});

/**
 * 클러스터마다 필드별 값 분포 → 다수값과 다른 호스트에 drift 판정. 동률이면 '다수' 를 정하지 않고 전부 표시(어느 쪽이 옳은지 모른다).
 * @returns {Map<hostId, Array<{field,value,majority}>>, clusters:[{vcenterId,cluster,hosts,fields:{field:{values:[{value,count}]}}}]}
 */
export function clusterDrift(hosts) {
  const byCl = new Map();
  for (const h of hosts || []) {
    if (!h || h.connectionState === 'DISCONNECTED' || !h.cluster || h.cluster === 'standalone') continue;
    const k = `${h.vcenterId}\u0000${h.cluster}`;
    if (!byCl.has(k)) byCl.set(k, []);
    byCl.get(k).push(h);
  }
  const perHost = new Map();
  const clusters = [];
  for (const list of byCl.values()) {
    if (list.length < 2) continue;
    const fields = {};
    for (const [f, get] of Object.entries(DRIFT_FIELDS)) {
      const cnt = new Map();
      for (const h of list) { const v = get(h); if (v != null) cnt.set(v, (cnt.get(v) || 0) + 1); }
      if (cnt.size < 2) continue;
      const values = [...cnt].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
      const majority = values[0].count > values[1].count ? values[0].value : null;
      fields[f] = { values, majority };
      for (const h of list) {
        const v = get(h);
        if (v == null || v === majority) continue;
        if (!perHost.has(h.id)) perHost.set(h.id, []);
        perHost.get(h.id).push({ field: f, value: v, majority });
      }
    }
    if (Object.keys(fields).length) clusters.push({ vcenterId: list[0].vcenterId, cluster: list[0].cluster, hosts: list.length, fields });
  }
  return { perHost, clusters };
}

// ── 엣지 수신 정제(아는 필드만) ─────────────────────────────────────────────
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => cap(x, 128)).filter(Boolean).slice(0, 16) : null);
const svc = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { running: typeof v.running === 'boolean' ? v.running : null, policy: typeof v.policy === 'string' ? cap(v.policy, 16) : null } : null);
const numOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
export function sanitizeHostCfg(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v.services && typeof v.services === 'object' && !Array.isArray(v.services) ? v.services : null;
  const ld = typeof v.lockdown === 'string' && ['disabled', 'normal', 'strict'].includes(v.lockdown) ? v.lockdown : null;
  return {
    at: numOr(v.at),
    lockdown: ld,
    rebootRequired: typeof v.rebootRequired === 'boolean' ? v.rebootRequired : null,
    services: s ? { ssh: svc(s.ssh), shell: svc(s.shell), ntpd: svc(s.ntpd) } : null,
    ntpServers: strList(v.ntpServers),
    dnsServers: strList(v.dnsServers),
    syslogHost: typeof v.syslogHost === 'string' ? (v.syslogHost.trim() ? cap(v.syslogHost, 256) : '') : null,
    lockFailures: numOr(v.lockFailures),
    shellTimeout: numOr(v.shellTimeout),
    mob: typeof v.mob === 'boolean' ? v.mob : null,
    acceptance: typeof v.acceptance === 'string' ? cap(v.acceptance, 32) : null,
    certNotAfter: numOr(v.certNotAfter),
    certSubject: typeof v.certSubject === 'string' ? cap(v.certSubject, 200) : null,
  };
}
