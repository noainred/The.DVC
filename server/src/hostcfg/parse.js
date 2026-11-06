// 호스트 구성·보안(v2.699 — A1 보안 하드닝 · A9 구성 드리프트 · A11 재부팅 필요·빌드 불일치 · A12 호스트 인증서 만료).
// 순수 파서·판정 — 수집(hostcfg/collect.js)·엣지 수신 정제(central)·화면 판정이 같은 모양을 쓰도록 이 모듈 하나가 소유한다.
//
// 모양(host.hcfg — 없으면 아직 읽지 않았다 = '미수집'. 판정하지 않는다):
//   { at, lockdown: 'disabled'|'normal'|'strict'|null, rebootRequired: bool|null,
//     services: { ssh:{running,policy}|null, shell:{running,policy}|null, ntpd:{running,policy}|null },
//     ntpServers: string[]|null, dnsServers: string[]|null, syslogHost: string|null(빈 문자열 = 설정 없음),
//     lockFailures: int|null, shellTimeout: int|null, mob: bool|null, acceptance: string|null,
//     certNotAfter: ms|null, certSubject: string|null,
//     mp: {luns,shared,paths,dead,deadLuns,singlePath,singleLuns,policies}|null(v2.700 A2), vsan: {enabled,diskIssues,members}|null(v2.700 A19),
//     net: { switches:[{name,kind:'vss'|'dvs',uplinks:[vmnicN…],pgs:int|null}], pgs:[{name,vlan,sw,promisc}], pgsTotal }|null(v2.701 A10) }
//   - 못 읽은 값은 null 이다(false·0·빈 목록이 아니다 — 그것은 값이다).
import { xmlUnescape } from '../vcenter/soapParse.js';
import { clusterIndex } from '../clustercfg/analyze.js'; // v2.744(감사 VC-02): 클러스터 묶음 키 한 벌(ref 우선)

/** 전부 vSphere 5.0+ 경로(없는 경로는 요청 전체를 InvalidProperty 로 만든다). lockdownMode(6.0+)는 따로 요청한다. */
export const HOST_CFG_PATHS = Object.freeze([
  'config.service', 'config.dateTimeInfo', 'config.network.dnsConfig', 'summary.rebootRequired',
  'configManager.certificateManager', 'configManager.advancedOption', 'configManager.imageConfigManager',
  'configManager.diagnosticSystem',   // v2.706(C4): 진단(코어 덤프) 파티션 — HostDiagnosticSystem.activePartition 을 따로 읽는다
]);
export const HOST_LOCKDOWN_PATH = 'config.lockdownMode';
/** v2.700(A19): vSAN(5.5+) — 호스트가 vSAN 에 참여하는지 · 디스크 문제 · 클러스터 멤버 수. 헬스 서비스(vsanHealth) API 는 아니다. */
export const HOST_VSAN_PATHS = Object.freeze(['config.vsanHostConfig.enabled', 'runtime.vsanRuntimeInfo']);
/** v2.700(A2): 멀티패스 — LUN·경로 상태·경로 정책. 응답이 커서 10대씩 따로 읽는다. */
export const HOST_MP_PATH = 'config.storageDevice.multipathInfo';
/** v2.701(A10): 표준 스위치·포트그룹·분산 스위치 프록시 — 업링크 이중화·업링크 링크 상태·무차별 모드·포트그룹 드리프트. */
export const HOST_NET_PATHS = Object.freeze(['config.network.vswitch', 'config.network.portgroup', 'config.network.proxySwitch']);
/** 고급 설정 — 호스트당 이름마다 QueryOptions 1회. 이름이 없는 버전은 InvalidName → 그 값만 null. */
export const ADV_OPTIONS = Object.freeze([
  'Syslog.global.logHost', 'Security.AccountLockFailures', 'UserVars.ESXiShellTimeOut', 'Config.HostAgent.plugins.solo.enableMob',
  // v2.706(C4) 크래시 대비 — 스크래치 위치(램디스크면 재부팅 때 로그가 사라진다) · 로컬 로그 위치 · PSOD 뒤 자동 재부팅 대기(0 = 화면에 머문다)
  'ScratchConfig.CurrentScratchLocation', 'Syslog.global.logDir', 'Misc.BlueScreenTimeout',
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
    scratch: null, logDir: null, bsodTimeout: null, diagPartition: null,   // v2.706(C4)
    mp: Object.hasOwn(p, HOST_MP_PATH) ? parseMultipath(p[HOST_MP_PATH]) : null,
    net: HOST_NET_PATHS.some((k) => Object.hasOwn(p, k)) ? parseNetwork(p[HOST_NET_PATHS[0]], p[HOST_NET_PATHS[1]], p[HOST_NET_PATHS[2]]) : null,
    vsan: (Object.hasOwn(p, HOST_VSAN_PATHS[0]) || Object.hasOwn(p, HOST_VSAN_PATHS[1])) ? parseVsan(p[HOST_VSAN_PATHS[0]], p[HOST_VSAN_PATHS[1]]) : null,
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

const SHARED_TRANSPORT = /HostFibreChannelTargetTransport|HostInternetScsiTargetTransport|HostFibreChannelOverEthernetTargetTransport/;
const MP_LUNS_MAX = 4096;
export const MP_TARGETS_MAX = 128;   // v2.920: 어댑터 × 타깃 WWN 상한(엣지 push·중앙 정제가 같은 값)
/** vSphere 는 WWN 을 10진 long 으로 준다 → 콜론 16진(소문자). soapClient.parseHbas 와 같은 변환. 숫자가 아니면 null. */
export function wwnFromDec(dec) {
  const s = String(dec ?? '').trim();
  if (!/^\d{1,20}$/.test(s)) return null;
  try { return BigInt(s).toString(16).padStart(16, '0').replace(/(..)(?=.)/g, '$1:'); } catch { return null; }
}
/**
 * 멀티패스 요약 — 경로 블록(<path>)만 훑는다(LU 블록 안에 <lun> 태그가 중첩돼 LU 로 자르면 틀린다).
 * shared = 경로 전송이 FC·iSCSI·FCoE 인 LUN(로컬 디스크·CD-ROM 의 단일 경로는 정상이라 세지 않는다).
 * 반환: { luns, shared, paths, dead, deadLuns:[], singlePath, singleLuns:[], policies:{psp:count}, targets:[] } | null(못 읽음)
 * v2.920 targets — 경로별 **FC 타깃 포트 WWN**(transport HostFibreChannelTargetTransport 의 portWorldWideName)을 어댑터(vmhbaN)별로 센다:
 *   [{ adapter, wwn, live, dead, luns }] (상한 MP_TARGETS_MAX, 어댑터·WWN 순). 같은 SOAP 경로(config.storageDevice.multipathInfo)라 새 vCenter 호출이 없다.
 *   호스트 귀속 엔진(sanswitch/attribution.js)이 '지금 살아 있는 경로의 타깃' 으로 조닝 후보를 좁힌다 — 없으면 좁히지 않는다(빈 배열 = FC 경로 없음).
 */
export function parseMultipath(xml) {
  if (typeof xml !== 'string') return null;
  const byLun = new Map();
  const byTarget = new Map();   // `${adapter}|${wwn}` → { adapter, wwn, live, dead, luns:Set }
  let paths = 0; let dead = 0;
  let i = 0;
  for (;;) {
    const s0 = xml.indexOf('<path>', i);
    if (s0 < 0) break;
    const e = xml.indexOf('</path>', s0);
    if (e < 0) break;
    const blk = xml.slice(s0, e);
    i = e + 7;
    const lun = tag(blk, 'lun');
    if (!lun) continue;
    paths += 1;
    const st = (tag(blk, 'pathState') || tag(blk, 'state') || '').toLowerCase();
    let L = byLun.get(lun);
    if (!L) { if (byLun.size >= MP_LUNS_MAX) continue; L = { live: 0, dead: 0, shared: false }; byLun.set(lun, L); }
    const isDead = st === 'dead'; const isLive = st === 'active' || st === 'standby';
    if (isDead) { L.dead += 1; dead += 1; } else if (isLive) L.live += 1;
    if (SHARED_TRANSPORT.test(blk)) L.shared = true;
    if (/HostFibreChannelTargetTransport/.test(blk)) {
      const wwn = wwnFromDec(tag(blk, 'portWorldWideName'));
      const adapter = String(tag(blk, 'adapter') || '').replace(/^key-vim\.host\.[A-Za-z]+-/, '').slice(0, 32);
      if (wwn && adapter) {
        const k = `${adapter}|${wwn}`;
        let T = byTarget.get(k);
        if (!T && byTarget.size < MP_TARGETS_MAX) { T = { adapter, wwn, live: 0, dead: 0, luns: new Set() }; byTarget.set(k, T); }
        if (T) { if (isDead) T.dead += 1; else if (isLive) T.live += 1; T.luns.add(lun); }
      }
    }
  }
  const policies = {};
  const re = /<policy>([A-Za-z0-9_.-]{1,64})<\/policy>/g;
  let m;
  while ((m = re.exec(xml))) policies[m[1]] = (policies[m[1]] || 0) + 1;
  const short = (k) => String(k).replace(/^key-vim\.host\.[A-Za-z]+-/, '').slice(0, 80);
  const deadLuns = []; const singleLuns = [];
  let shared = 0; let singlePath = 0;
  for (const [k, L] of byLun) {
    if (L.dead > 0 && deadLuns.length < 10) deadLuns.push(short(k));
    if (L.shared) {
      shared += 1;
      if (L.live < 2) { singlePath += 1; if (singleLuns.length < 10) singleLuns.push(short(k)); }
    }
  }
  const targets = [...byTarget.values()].map((t) => ({ adapter: t.adapter, wwn: t.wwn, live: t.live, dead: t.dead, luns: t.luns.size }))
    .sort((a, b) => a.adapter.localeCompare(b.adapter) || a.wwn.localeCompare(b.wwn));
  return { luns: byLun.size, shared, paths, dead, deadLuns, singlePath, singleLuns, policies, targets };
}

/** vSAN 런타임 — enabled(bool|null) · diskIssues(개수) · members(클러스터 멤버 수). 응답이 없으면 null(모름). */
export function parseVsan(enabledRaw, runtimeXml) {
  const enabled = boolOf(enabledRaw);
  if (enabled == null && typeof runtimeXml !== 'string') return null;
  const count = (t) => (typeof runtimeXml === 'string' ? (runtimeXml.match(new RegExp(`<${t}>`, 'g')) || []).length : null);
  const members = count('membershipList');
  // v2.727(감사 C-05): vSAN 이 켜진 호스트인데 membershipList 원소가 0개면 '멤버 0' 이 아니라 **아직 못 읽은 것**(가입 직후·축약
  //   응답)일 수 있다 — 0 으로 두면 dscfg/analyze.js 가 '분할(vsan-partition)' 로 판정한다(crit). null 로 두고 판정을 보류한다.
  //   vSAN 이 꺼진 호스트의 0 은 값이다(멤버가 아니다).
  return { enabled, diskIssues: count('diskIssues'), members: enabled === true && members === 0 ? null : members };
}

// ── v2.701(A10) 네트워크 ───────────────────────────────────────────────────
export const NET_SW_MAX = 32;
export const NET_PG_MAX = 128;
/** 같은 이름의 블록 전부(선형 — indexOf). 다음 글자가 ' '·'>' 일 때만 같은 태그다(HostVirtualSwitchSpec 오인 방지). */
function elems(xml, name, max) {
  const out = [];
  if (typeof xml !== 'string') return out;
  let i = 0;
  while (out.length < max) {
    const s0 = xml.indexOf(`<${name}`, i);
    if (s0 < 0) break;
    const c = xml.charCodeAt(s0 + name.length + 1);
    if (c !== 32 && c !== 62) { i = s0 + 1; continue; }
    const open = xml.indexOf('>', s0);
    const e = open < 0 ? -1 : xml.indexOf(`</${name}>`, open);
    if (e < 0) break;
    out.push(xml.slice(open + 1, e));
    i = e + name.length + 3;
  }
  return out;
}
function inner(xml, name) {
  const s0 = xml.indexOf(`<${name}`);
  if (s0 < 0) return null;
  const open = xml.indexOf('>', s0);
  const e = open < 0 ? -1 : xml.indexOf(`</${name}>`, open);
  return e < 0 ? null : xml.slice(open + 1, e);
}
const pnicName = (k) => String(k).replace(/^key-vim\.host\.PhysicalNic-/, '').slice(0, 32);
const countAll = (xml, t) => (xml.match(new RegExp(`<${t}>`, 'g')) || []).length;

/**
 * 표준 스위치(HostVirtualSwitch)·분산 스위치 프록시(HostProxySwitch)·포트그룹(HostPortGroup).
 * 세 응답이 모두 없으면 null(모름). 업링크 = 스위치 바로 아래 <pnic> 키(브리지 사양의 nicDevice 가 아니다).
 * 포트그룹의 무차별 모드는 **유효 정책(computedPolicy)** 기준이다(스위치 기본값을 물려받은 값까지).
 */
/** v2.901: 팀 구성 정책 값(HostNicTeamingPolicy.policy — vSphere 문서의 문자열). 모르는 값은 null. */
export const TEAMING_POLICIES = Object.freeze(['loadbalance_srcid', 'loadbalance_srcmac', 'loadbalance_ip', 'failover_explicit', 'loadbalance_loadbased']);
/**
 * v2.901: 팀 구성(HostNicTeamingPolicy) — 이미 받는 표준 스위치 spec.policy.nicTeaming · 포트그룹 computedPolicy.nicTeaming 을 읽는다(새 호출 없음).
 * { policy, active:[], standby:[], failback } — failback 은 rollingOrder 의 반대(rollingOrder=true 면 복구 뒤 되돌리지 않는다). 못 읽으면 null.
 * 분산 스위치(vDS)의 팀 구성 · LACP 는 vDS 포트그룹 설정이라 호스트 프록시 스위치에 없다(null — 화면이 그렇게 말한다).
 */
// ⚠ spec.policy 안에 같은 이름(nicTeaming.policy)이 중첩돼 inner('policy') 는 안쪽 닫는 태그에서 끊긴다 — nicTeaming 을 바로 찾는다(한 번만 나온다).
function teamingOf(containerXml) {
  const nt = containerXml ? inner(containerXml, 'nicTeaming') : null;
  if (!nt) return null;
  const pol = tag(nt, 'policy');
  const order = inner(nt, 'nicOrder') || '';
  const rolling = boolOf(tag(nt, 'rollingOrder'));
  return {
    policy: pol && TEAMING_POLICIES.includes(pol) ? pol : null,
    active: tagsAll(order, 'activeNic', 16).map(pnicName),
    standby: tagsAll(order, 'standbyNic', 16).map(pnicName),
    failback: rolling == null ? null : !rolling,
  };
}

export function parseNetwork(vswitchXml, pgXml, proxyXml) {
  if (typeof vswitchXml !== 'string' && typeof pgXml !== 'string' && typeof proxyXml !== 'string') return null;
  const switches = [];
  for (const b of elems(vswitchXml, 'HostVirtualSwitch', NET_SW_MAX)) {
    const spec = inner(b, 'spec') || '';
    switches.push({ name: cap(tag(b, 'name'), 64) || '(이름 없음)', kind: 'vss', uplinks: tagsAll(b, 'pnic', 16).map(pnicName), pgs: countAll(b, 'portgroup'),
      teaming: teamingOf(spec) });
  }
  for (const b of elems(proxyXml, 'HostProxySwitch', NET_SW_MAX - switches.length)) {
    switches.push({ name: cap(tag(b, 'dvsName'), 64) || '(이름 없음)', kind: 'dvs', uplinks: tagsAll(b, 'pnic', 16).map(pnicName), pgs: null, teaming: null });
  }
  const all = elems(pgXml, 'HostPortGroup', 10_000);
  const pgs = [];
  for (const b of all.slice(0, NET_PG_MAX)) {
    const spec = inner(b, 'spec') || '';
    const comp = inner(b, 'computedPolicy') || '';
    const vlan = intOf(tag(spec, 'vlanId'));
    pgs.push({ name: cap(tag(spec, 'name'), 64) || '(이름 없음)', vlan, sw: cap(tag(spec, 'vswitchName'), 64), promisc: boolOf(tag(comp, 'allowPromiscuous')),
      teaming: teamingOf(comp)?.policy ?? null });   // v2.901: 유효 정책(스위치 기본값을 물려받은 값까지)의 부하 분산 방식
  }
  return { switches, pgs, pgsTotal: typeof pgXml === 'string' ? all.length : null };
}

export function applyAdvanced(h, name, raw) {
  if (raw == null) return;
  if (name === 'Syslog.global.logHost') h.syslogHost = cap(raw, 256) ?? '';
  else if (name === 'Security.AccountLockFailures') h.lockFailures = intOf(raw);
  else if (name === 'UserVars.ESXiShellTimeOut') h.shellTimeout = intOf(raw);
  else if (name === 'Config.HostAgent.plugins.solo.enableMob') h.mob = boolOf(String(raw).trim().toLowerCase());
  else if (name === 'ScratchConfig.CurrentScratchLocation') h.scratch = cap(raw, 256) ?? '';
  else if (name === 'Syslog.global.logDir') h.logDir = cap(raw, 256) ?? '';
  else if (name === 'Misc.BlueScreenTimeout') h.bsodTimeout = intOf(raw);
}

/**
 * v2.706(C4): 스크래치가 휘발성(램디스크)인가 — 영구 저장소가 없으면 ESXi 는 스크래치를 /tmp/scratch(램디스크)에 둔다.
 * 빈 값도 '영구 위치 없음' 이다. 못 읽은 값(null)은 판정하지 않는다.
 */
export const scratchVolatile = (scratch) => typeof scratch === 'string' && (scratch.trim() === '' || /^\/tmp(\/|$)/.test(scratch.trim()));
/** 로컬 로그 위치가 재부팅 때 사라지는가 — /tmp 이거나, 스크래치를 따라가는데(/scratch/…) 스크래치가 휘발성이면. 빈 값은 모른다(null). */
export function logDirVolatile(logDir, scratch) {
  if (typeof logDir !== 'string' || !logDir.trim()) return null;
  const d = logDir.trim();
  if (/^\/tmp(\/|$)/.test(d)) return true;
  if (/(^|\s|\])\/?scratch(\/|$)/.test(d)) return scratch == null ? null : scratchVolatile(scratch);
  return false;
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
  'mp-dead': 'warn',
  'mp-single': 'warn',
  'vsan-disk-issue': 'warn',
  'net-single-uplink': 'warn',
  'net-uplink-down': 'warn',
  'net-promisc': 'warn',
  'net-no-uplink': 'info',
  'ssh-autostart': 'info',
  'lockdown-off': 'info',
  'shell-timeout-off': 'info',
  // v2.706(C4) 크래시 대비
  'logs-lost': 'crit',              // 로컬 로그가 휘발성이고 원격 syslog 도 없다 — 크래시 직전 로그가 어디에도 남지 않는다
  'logs-volatile': 'warn',          // 로컬 로그가 휘발성(원격 syslog 는 있다)
  'scratch-volatile': 'warn',
  'coredump-partition-none': 'info', // 진단 파티션 없음 — 7.0+ 의 코어 덤프 '파일' 은 이 API 로 확인하지 못한다
  'psod-no-reboot': 'info',         // PSOD 뒤 자동 재부팅 안 함(Misc.BlueScreenTimeout 0)
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
  // v2.706(C4) 크래시 대비 — 값을 읽었을 때만.
  if (scratchVolatile(h.scratch)) add('scratch-volatile', { scratch: h.scratch });
  const lv = logDirVolatile(h.logDir, h.scratch);
  if (lv === true) add(h.syslogHost === '' ? 'logs-lost' : 'logs-volatile', { logDir: h.logDir, remote: h.syslogHost || null });
  if (h.diagPartition === false) add('coredump-partition-none');
  if (h.bsodTimeout === 0) add('psod-no-reboot');
  if (h.mp && h.mp.dead > 0) add('mp-dead', { dead: h.mp.dead, luns: h.mp.deadLuns });
  if (h.mp && h.mp.singlePath > 0) add('mp-single', { count: h.mp.singlePath, luns: h.mp.singleLuns });
  if (h.vsan?.enabled === true && h.vsan.diskIssues > 0) add('vsan-disk-issue', { count: h.vsan.diskIssues });
  if (h.net) {
    const sw = Array.isArray(h.net.switches) ? h.net.switches : [];
    // 포트그룹이 없는 표준 스위치는 쓰지 않는 스위치다 — 업링크 판정에서 뺀다. 분산 스위치는 늘 쓰는 것으로 본다(포트그룹 수를 모른다).
    const used = sw.filter((x) => x.kind === 'dvs' || x.pgs > 0);
    const single = used.filter((x) => x.uplinks.length === 1).map((x) => x.name);
    if (single.length) add('net-single-uplink', { switches: single.slice(0, 10) });
    const none = used.filter((x) => x.uplinks.length === 0).map((x) => x.name);
    if (none.length) add('net-no-uplink', { switches: none.slice(0, 10) });
    // 링크 상태는 인벤토리의 물리 NIC(host.nics[].link)로 본다 — 그 NIC 를 모르면 판정하지 않는다.
    const nics = new Map((Array.isArray(host.nics) ? host.nics : []).filter((n) => n && n.device).map((n) => [n.device, n]));
    const down = [];
    for (const x of used) for (const u of x.uplinks) { const n = nics.get(u); if (n && n.link === false) down.push(`${x.name}/${u}`); }
    if (down.length) add('net-uplink-down', { count: down.length, list: down.slice(0, 10) });
    const pr = (Array.isArray(h.net.pgs) ? h.net.pgs : []).filter((p) => p.promisc === true).map((p) => p.name);
    if (pr.length) add('net-promisc', { count: pr.length, names: pr.slice(0, 10) });
  }
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
  // v2.700(A2): 같은 클러스터는 같은 공유 LUN 을 봐야 한다(개수가 다르면 존·마스킹·경로 문제 후보).
  sharedLuns: (host) => (host.hcfg?.mp ? String(host.hcfg.mp.shared) : null),
  // v2.701(A10): 같은 클러스터는 같은 표준 포트그룹(이름:VLAN)을 가져야 vMotion·HA 가 그 VM 을 옮길 수 있다.
  //   포트그룹 목록이 잘렸으면(상한 초과) 비교하지 않는다 — 잘린 목록끼리의 차이는 거짓 드리프트다.
  portgroups: (host) => {
    const n = host.hcfg?.net;
    if (!n || !Array.isArray(n.pgs) || n.pgsTotal == null || n.pgsTotal > n.pgs.length) return null;
    const v = n.pgs.map((p) => `${p.name}:${p.vlan ?? '?'}`).sort().join(', ');
    return v ? (v.length > 1000 ? `${v.slice(0, 1000)}…` : v) : '(없음)';
  },
});

/**
 * 클러스터마다 필드별 값 분포 → 다수값과 다른 호스트에 drift 판정. 동률이면 '다수' 를 정하지 않고 전부 표시(어느 쪽이 옳은지 모른다).
 * @returns {Map<hostId, Array<{field,value,majority}>>, clusters:[{vcenterId,cluster,clusterRef,vcDatacenter,sameName,hosts,fields:{field:{values:[{value,count}]}}}]}
 */
export function clusterDrift(hosts) {
  const byCl = new Map();
  // v2.744(감사 VC-02): 같은 클러스터 = (vCenter, 클러스터 moref) — 이름으로 묶으면 다른 데이터센터의 같은 이름 클러스터 값이 섞여
  //   다수값과 다른 호스트를 거짓으로 경고했다(재현: Seoul 2대·Busan 3대 'Prod' → Seoul 2대 NTP 드리프트). 키는 clustercfg 한 벌.
  const hl = (hosts || []).filter((h) => h && typeof h === 'object');
  const idx = clusterIndex(hl);
  for (const h of hl) {
    if (h.connectionState === 'DISCONNECTED' || !h.cluster || h.cluster === 'standalone') continue;
    const k = idx.keyOf(h);
    if (!k) continue;
    if (!byCl.has(k)) byCl.set(k, []);
    byCl.get(k).push(h);
  }
  const perHost = new Map();
  const clusters = [];
  for (const [k, list] of byCl) {
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
    if (Object.keys(fields).length) clusters.push({ vcenterId: list[0].vcenterId, cluster: list[0].cluster, ...idx.meta(k), hosts: list.length, fields });
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
    scratch: typeof v.scratch === 'string' ? (v.scratch.trim() ? cap(v.scratch, 256) : '') : null,
    logDir: typeof v.logDir === 'string' ? (v.logDir.trim() ? cap(v.logDir, 256) : '') : null,
    bsodTimeout: numOr(v.bsodTimeout),
    diagPartition: typeof v.diagPartition === 'boolean' ? v.diagPartition : null,
    mp: sanitizeMp(v.mp),
    vsan: v.vsan && typeof v.vsan === 'object' && !Array.isArray(v.vsan)
      ? { enabled: typeof v.vsan.enabled === 'boolean' ? v.vsan.enabled : null, diskIssues: numOr(v.vsan.diskIssues), members: numOr(v.vsan.members) } : null,
    net: sanitizeNet(v.net),
  };
}
const nicName = (x) => (typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,32}$/.test(x) ? x : null);
/** v2.901: 엣지가 보낸 팀 구성 — 아는 정책 값 · NIC 이름 목록(16개) · 불리언만. 객체가 아니면 null(모름). */
function sanitizeTeaming(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const nics = (v) => (Array.isArray(v) ? v.map(nicName).filter(Boolean).slice(0, 16) : []);
  return { policy: typeof t.policy === 'string' && TEAMING_POLICIES.includes(t.policy) ? t.policy : null, active: nics(t.active), standby: nics(t.standby), failback: typeof t.failback === 'boolean' ? t.failback : null };
}
function sanitizeNet(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  const sw = Array.isArray(n.switches) ? n.switches.slice(0, NET_SW_MAX).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => ({
    name: cap(typeof x.name === 'string' ? x.name : '', 64) || '(이름 없음)',
    kind: x.kind === 'dvs' ? 'dvs' : 'vss',
    uplinks: Array.isArray(x.uplinks) ? x.uplinks.map(nicName).filter(Boolean).slice(0, 16) : [],
    pgs: numOr(x.pgs) != null && numOr(x.pgs) >= 0 ? numOr(x.pgs) : null,
    teaming: sanitizeTeaming(x.teaming),   // v2.901
  })) : [];
  const pgs = Array.isArray(n.pgs) ? n.pgs.slice(0, NET_PG_MAX).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => ({
    name: cap(typeof x.name === 'string' ? x.name : '', 64) || '(이름 없음)',
    vlan: numOr(x.vlan), sw: typeof x.sw === 'string' ? cap(x.sw, 64) : null,
    promisc: typeof x.promisc === 'boolean' ? x.promisc : null,
    teaming: typeof x.teaming === 'string' && TEAMING_POLICIES.includes(x.teaming) ? x.teaming : null,   // v2.901
  })) : [];
  const total = numOr(n.pgsTotal);
  return { switches: sw, pgs, pgsTotal: total != null && total >= 0 ? total : null };
}
function sanitizeMp(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const pol = {};
  if (m.policies && typeof m.policies === 'object' && !Array.isArray(m.policies)) {
    for (const [k, n] of Object.entries(m.policies).slice(0, 16)) if (/^[A-Za-z0-9_.-]{1,64}$/.test(k) && Number.isFinite(n)) pol[k] = Math.trunc(n);
  }
  const n = (x) => (Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0);
  // v2.920: 경로별 타깃(어댑터 이름·WWN 표준형·수치만 — 아는 필드만, 상한). 배열이 아니면 키를 싣지 않는다(구버전 엣지 = '아직 안 읽음').
  const WWN_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){7}$/;
  const targets = Array.isArray(m.targets) ? m.targets.slice(0, MP_TARGETS_MAX)
    .filter((t) => t && typeof t === 'object' && !Array.isArray(t) && nicName(t.adapter) && typeof t.wwn === 'string' && WWN_RE.test(t.wwn.toLowerCase()))
    .map((t) => ({ adapter: t.adapter, wwn: t.wwn.toLowerCase(), live: n(t.live), dead: n(t.dead), luns: n(t.luns) })) : null;
  return {
    luns: n(m.luns), shared: n(m.shared), paths: n(m.paths), dead: n(m.dead), singlePath: n(m.singlePath),
    deadLuns: strList(m.deadLuns)?.slice(0, 10) || [], singleLuns: strList(m.singleLuns)?.slice(0, 10) || [], policies: pol,
    ...(targets ? { targets } : {}),
  };
}
