// views/hostChecksText.js — ESXi 호스트 화면(#/hosts)의 '엑셀 수준 상세' 판본(v2.803, 승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1 ①):
//   열 묶음 9개(엑셀 '호스트 목록' 시트와 같은 순서) · 요약 8칸 · '지금 확인할 것' 칩 · 칩으로 거르기 · 점검 열 글자.
// 판정을 새로 하지 않는다:
//   · 확인 대상(점검 · 끊김 · CPU 90% 초과)은 hostTriage.js 그대로(시안 B 판정 — 카드 숫자 = 표 탭).
//   · 구성·보안은 hostcfg/hostCfgText.js hostCfgFindings(서버 hostcfg/parse.js 와 같은 규칙 — 테스트 대조).
//   · iDRAC 부품 · 최근 재부팅 · Veeam 은 서버 /hosts/checks(vcenter/hostChecks.js)가 호스트별 한 줄로 준 것을 글자로만 바꾼다.
// 못 읽은 값은 0 이 아니다 — null 은 '—', 묶음을 못 읽었으면 '수집 안 됨'. 값이 없으면 단위를 붙이지 않는다.
import { hostUsagePct } from './vcdOverview.js';
import { hostCfgFindings, HOST_CFG_TEXT, REBOOT_KIND } from './hostcfg/hostCfgText.js';
import { hostReasons, filterHosts, focusLabel, clusterKey } from './hostTriage.js';
import { numOrNull } from '../numOrNull.js';

const DAY = 86_400_000;

/** 열 묶음 — 엑셀 '호스트 목록' 시트와 같은 순서. color 는 열 머리의 점(묶음 구분). */
export const COL_GROUPS = Object.freeze([
  { key: 'base', label: '기본', color: '#3b82f6' },
  { key: 'hw', label: '하드웨어', color: '#a78bfa' },
  { key: 'esxi', label: 'ESXi', color: '#22d3ee' },
  { key: 'use', label: '사용률', color: '#f59e0b' },
  { key: 'vm', label: 'VM', color: '#22c55e' },
  { key: 'net', label: '네트워크', color: '#60a5fa' },
  { key: 'st', label: '스토리지', color: '#fb923c' },
  { key: 'chk', label: '점검', color: '#ef4444' },
  { key: 'bak', label: '백업', color: '#94a3b8' },
]);

/** 표의 열(30) — key 는 정렬 키, group 은 묶음, align 은 칸 정렬. '기본' 묶음은 끌 수 없다(호스트 이름이 빠지면 표가 뜻을 잃는다). */
export const COLUMNS = Object.freeze([
  { key: 'name', label: '호스트', group: 'base' }, { key: 'vcenterId', label: 'vCenter', group: 'base' }, { key: 'cluster', label: '클러스터', group: 'base' }, { key: 'connectionState', label: '상태', group: 'base' },
  { key: 'model', label: '모델', group: 'hw' }, { key: 'serviceTag', label: '서비스 태그', group: 'hw' }, { key: 'cpuModel', label: 'CPU 모델', group: 'hw' }, { key: 'cpuCores', label: '소켓/코어/스레드', group: 'hw', align: 'right' }, { key: 'memTotalMB', label: 'RAM', group: 'hw', align: 'right' },
  { key: 'version', label: '버전 · 빌드', group: 'esxi' }, { key: 'mgmtIp', label: '관리 IP', group: 'esxi' }, { key: 'uptime', label: '업타임', group: 'esxi', align: 'right' },
  { key: 'cpuUsagePct', label: 'CPU', group: 'use' }, { key: 'memUsagePct', label: '메모리', group: 'use' }, { key: 'powerWatts', label: '전력', group: 'use', align: 'right' }, { key: 'tempC', label: '온도', group: 'use', align: 'right' },
  { key: 'vmCount', label: 'VM', group: 'vm', align: 'right' }, { key: 'vcpu', label: 'vCPU', group: 'vm', align: 'right' }, { key: 'vcpuRatio', label: 'vCPU:코어', group: 'vm', align: 'right' }, { key: 'vmMemGB', label: 'VM 메모리', group: 'vm', align: 'right' },
  { key: 'nics', label: 'NIC', group: 'net', align: 'right' }, { key: 'nicDown', label: '링크 끊김', group: 'net', align: 'right' }, { key: 'uplinkDown', label: '업링크 끊김', group: 'net', align: 'right' },
  { key: 'hbas', label: 'HBA', group: 'st', align: 'right' }, { key: 'deadPaths', label: '죽은 경로', group: 'st', align: 'right' }, { key: 'luns', label: 'LUN', group: 'st', align: 'right' },
  { key: 'sec', label: '구성 · 보안', group: 'chk' }, { key: 'idrac', label: 'iDRAC', group: 'chk' }, { key: 'boot', label: '최근 재부팅', group: 'chk' },
  { key: 'veeam', label: 'Veeam 최근 백업', group: 'bak' },
]);
export const FIXED_GROUP = 'base';
export const PREF_KEY = 'ui.hosts.cols';

/** 저장된 '끈 묶음' — 모르는 키는 버린다(지어내지 않는다). 읽기 실패는 아무것도 끄지 않은 것. */
export function parseColPrefs(raw) {
  const off = {};
  try {
    const v = JSON.parse(raw || 'null');
    const list = Array.isArray(v?.off) ? v.off : [];
    for (const k of list) if (COL_GROUPS.some((g) => g.key === k) && k !== FIXED_GROUP) off[k] = true;
  } catch { /* 저장값이 없거나 깨짐 — 전부 켠다 */ }
  return off;
}
export const stringifyColPrefs = (off) => JSON.stringify({ v: 1, off: COL_GROUPS.map((g) => g.key).filter((k) => off[k] && k !== FIXED_GROUP) });
export function readColPrefs() { try { return parseColPrefs(window.localStorage.getItem(PREF_KEY)); } catch { return {}; } }
export function writeColPrefs(off) { try { window.localStorage.setItem(PREF_KEY, stringifyColPrefs(off)); } catch { /* 저장 실패는 기능을 막지 않는다 */ } }
/** 보이는 열 — 끈 묶음의 열을 뺀다. access.hw 가 아니면 iDRAC 열은 없다(관리자 판본). */
export function visibleColumns(off, { hw = true } = {}) {
  return COLUMNS.filter((c) => !off[c.group] && (c.key !== 'idrac' || hw));
}

/** 구성·보안 한 줄 — hcfg 를 아직 못 읽었거나 끊긴 호스트는 null(판정하지 않는다). */
export function secCountsOf(host, now = Date.now()) {
  if (!host?.hcfg || host.connectionState === 'DISCONNECTED') return null;
  const findings = hostCfgFindings(host, now);
  const c = { crit: 0, warn: 0, info: 0, findings };
  for (const f of findings) if (f.sev in c) c[f.sev] += 1;
  return c;
}
export function secText(c) {
  if (!c) return '';
  const parts = [];
  if (c.crit) parts.push(`위험 ${c.crit}`);
  if (c.warn) parts.push(`주의 ${c.warn}`);
  if (c.info) parts.push(`참고 ${c.info}`);
  return parts.length ? parts.join(' · ') : '이상 없음';
}
export const secTone = (c) => (!c ? 'gray' : c.crit ? 'red' : c.warn ? 'amber' : c.info ? 'gray' : 'green');

/** 쓰는 스위치의 업링크 중 링크가 내려간 수 — 구성 점검의 net-uplink-down 판정 그대로. 구성을 못 읽었으면 null. */
export function uplinkDownOf(host, sec = null) {
  if (!host?.hcfg?.net || host.connectionState === 'DISCONNECTED') return null;
  const findings = sec?.findings || hostCfgFindings(host);
  const f = findings.find((x) => x.code === 'net-uplink-down');
  return f ? Number(f.facts?.count) || 0 : 0;
}
/** 링크가 내려간 물리 NIC 수(쓰지 않는 포트도 센다 — 사실). 인벤토리에 NIC 가 없으면 null. */
export const nicLinkDownOf = (host) => (Array.isArray(host?.nics) && host.nics.length ? host.nics.filter((n) => n.link === false).length : null);
export const deadPathsOf = (host) => (host?.hcfg?.mp && Number.isFinite(host.hcfg.mp.dead) ? host.hcfg.mp.dead : null);
export const lunsOf = (host) => (host?.hcfg?.mp && Number.isFinite(host.hcfg.mp.luns) ? host.hcfg.mp.luns : null);
export function uptimeDays(host, now = Date.now()) {
  if (!Number.isFinite(host?.bootTime) || host.connectionState === 'DISCONNECTED') return null;
  return Math.max(0, Math.floor((now - host.bootTime) / DAY));
}
export const coresText = (h) => {
  const s = numOrNull(h?.cpuSockets); const c = numOrNull(h?.cpuCores); const t = numOrNull(h?.cpuThreads);
  if (c == null && s == null && t == null) return '—';
  return `${s ?? '—'} / ${c ?? '—'} / ${t ?? '—'}`;
};
export const gbText = (mb) => (Number.isFinite(mb) && mb > 0 ? `${Math.round(mb / 1024).toLocaleString('en-US')} GB` : '—');
export const kwText = (w) => (Number.isFinite(w) && w > 0 ? `${w.toLocaleString('en-US')} W` : '—');
export const ratioText = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? `${(Math.round((a / b) * 10) / 10).toFixed(1)} : 1` : '—');

/** iDRAC 열 글자·톤 — 서버 hw 한 줄. 묶음이 없으면(권한) 열 자체가 없다. */
export const HW_TEXT = Object.freeze({
  ok: ['정상', 'green'], warn: ['경고', 'amber'], fault: ['장애', 'red'], unknown: ['상태 모름', 'gray'],
  none: ['등록 안 됨', 'gray'], pending: ['읽는 중', 'gray'], error: ['등록부 못 읽음', 'gray'],
});
export function hwCell(c) {
  if (!c || !c.hw) return { text: '—', tone: 'gray', title: '점검 집계를 아직 읽지 않았습니다' };
  const [t, tone] = HW_TEXT[c.hw.state] || ['—', 'gray'];
  const text = (c.hw.state === 'warn' || c.hw.state === 'fault') && Number.isFinite(c.hw.bad) && c.hw.bad > 0 ? `${t} ${c.hw.bad}` : t;
  return { text, tone, title: c.hw.health ? `iDRAC 시스템 상태 ${c.hw.health}` : '' };
}
/** 최근 재부팅 열 — 판정 행이 없으면 '30일 내 없음'(부팅 시각을 읽었을 때) · 끊김·못 읽음은 '—'. checks 가 없으면 '—'. */
export function bootCell(c, host, bootDays = 30) {
  if (!c) return { text: '—', tone: 'gray', title: '' };
  if (!('boot' in c)) return { text: '권한 없음', tone: 'gray', title: '‘ESXi 호스트 구성 점검’ 도구 권한이 있어야 봅니다' };
  if (c.boot) {
    const k = REBOOT_KIND[c.boot.kind] || { label: c.boot.kind, tone: 'gray', note: '' };
    const d = Number.isFinite(c.boot.bootTime) ? new Date(c.boot.bootTime) : null;
    const when = d ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
    return { text: when ? `${k.label} · ${when}` : k.label, tone: k.tone, title: k.note };
  }
  if (host?.connectionState === 'DISCONNECTED' || !Number.isFinite(host?.bootTime)) return { text: '—', tone: 'gray', title: '부팅 시각을 읽지 못했거나 연결이 끊겼습니다' };
  return { text: `${bootDays}일 내 없음`, tone: 'gray', title: '' };
}
/** Veeam 열 — null 은 수집 안 됨(0 이 아니다). */
export function veeamCell(c) {
  if (!c) return { text: '—', tone: 'gray', title: '' };
  const v = c.veeam;
  if (!v) return { text: '수집 안 됨', tone: 'gray', title: 'Veeam 서버가 연결되지 않았거나 이 vCenter 의 판정을 읽지 못했습니다' };
  if (v.total === 0) return { text: 'VM 없음', tone: 'gray', title: '' };
  const text = `예 ${v.y} · 아니오 ${v.n}${v.unknown ? ` · 모름 ${v.unknown}` : ''}`;
  return { text, tone: v.n > 0 ? 'amber' : v.y > 0 ? 'green' : 'gray', title: '어제부터 지금까지 Veeam 백업이 끝난 VM 수(템플릿 제외)' };
}

/** 요약 8칸(엑셀 ‘요약’ 시트 급) — 서버 summary + 표의 호스트에서 셀 수 있는 것만. 못 읽은 값은 '—'. */
export function hostKpis(summary, rows, now = Date.now()) {
  const s = summary || {};
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
  const list = rows || [];
  const clusters = new Set(list.filter((h) => h.cluster && h.cluster !== 'standalone').map(clusterKey)).size;
  const standalone = list.filter((h) => !h.cluster || h.cluster === 'standalone').length;
  const vcs = new Set(list.map((h) => h.vcenterId)).size;
  let sockets = 0; let socketsUnknown = 0; let memUsed = 0; let memUsedUnknown = 0; let temps = []; let powerHosts = 0;
  for (const h of list) {
    const so = numOrNull(h.cpuSockets); if (so == null) socketsUnknown += 1; else sockets += so;
    const mu = h.connectionState === 'DISCONNECTED' ? null : numOrNull(h.memUsageMB); if (mu == null) memUsedUnknown += 1; else memUsed += mu;
    const t = numOrNull(h.tempC); if (t != null) temps.push(t);
    if (Number.isFinite(h.powerWatts) && h.powerWatts > 0) powerHosts += 1;
  }
  const memTotalGB = numOrNull(s.memTotalGB);
  const memUsedGB = memUsedUnknown === list.length && list.length ? null : Math.round(memUsed / 1024);
  const memPct = memTotalGB > 0 && memUsedGB != null ? Math.round((memUsedGB / memTotalGB) * 100) : null;
  const vcore = numOrNull(s.vcoreAllocated); const cores = numOrNull(s.physicalCores);
  const ver = Array.isArray(s.esxiVersions) ? s.esxiVersions : [];
  return [
    { key: 'hosts', label: '호스트(ESXi)', value: fmt(s.total), sub: `연결 ${fmt(s.connected)} · 점검 ${fmt(s.maintenance)} · 끊김 ${fmt(s.disconnected)}`, bar: s.total > 0 ? s.connected / s.total : 0, tone: 'text' },
    { key: 'clusters', label: '클러스터', value: fmt(clusters), sub: `독립 호스트 ${fmt(standalone)} · vCenter ${fmt(vcs)}`, bar: 1, tone: 'text' },
    { key: 'cores', label: '물리 코어', value: fmt(cores), sub: `소켓 ${socketsUnknown === list.length && list.length ? '—' : fmt(sockets)}${socketsUnknown ? `(못 읽음 ${socketsUnknown})` : ''} · 논리 ${fmt(s.logicalCores)}`, bar: 1, tone: 'text' },
    { key: 'vcore', label: '할당 vCore', value: fmt(vcore), sub: `vCore:물리 ${ratioText(vcore, cores)}`, bar: cores > 0 && vcore != null ? Math.min(1, vcore / (cores * 4)) : 0, tone: 'accent' },
    { key: 'mem', label: '전체 메모리', value: memTotalGB != null ? `${(memTotalGB / 1024).toFixed(1)}` : '—', unit: memTotalGB != null ? 'TB' : '', sub: memUsedGB != null ? `사용 ${(memUsedGB / 1024).toFixed(1)} TB${memPct != null ? `(${memPct}%)` : ''}${memUsedUnknown ? ` · 못 읽음 ${memUsedUnknown}` : ''} · 할당 ${s.memOvercommit ? `${s.memOvercommit} : 1` : '—'}` : '사용량 못 읽음', bar: memPct != null ? memPct / 100 : 0, tone: 'cyan' },
    { key: 'vms', label: 'VM', value: fmt(list.reduce((a, h) => a + (numOrNull(h.vmCount) ?? 0), 0)), sub: `호스트당 평균 ${list.length ? (list.reduce((a, h) => a + (numOrNull(h.vmCount) ?? 0), 0) / list.length).toFixed(1) : '—'}`, bar: 1, tone: 'green' },
    { key: 'power', label: '전력', value: Number.isFinite(s.powerKw) && s.powerKw > 0 ? s.powerKw.toLocaleString('en-US') : '—', unit: Number.isFinite(s.powerKw) && s.powerKw > 0 ? 'kW' : '', sub: `읽은 호스트 ${fmt(powerHosts)} / ${fmt(list.length)}${temps.length ? ` · 온도 최고 ${Math.max(...temps)}℃` : ''}`, bar: list.length ? powerHosts / list.length : 0, tone: 'amber' },
    { key: 'ver', label: 'ESXi 버전', value: ver.length ? String(ver.length) : '—', unit: ver.length ? '종' : '', sub: ver.length ? ver.slice(0, 3).map((v) => `${v.version} · ${v.count}`).join(' / ') : '정보 없음', bar: ver.length && s.total ? ver[0].count / s.total : 0, tone: 'text', versions: ver },
  ];
}

/** '지금 확인할 것' 칩 — 엑셀 ‘요약’ 시트의 확인 목록과 같은 항목. kind 는 거르기 키. */
export const CHECK_CHIPS = Object.freeze([
  { kind: 'uplink', label: '쓰는 스위치의 업링크 끊김', tone: 'red', code: 'net-uplink-down' },
  { kind: 'cert-expired', label: HOST_CFG_TEXT['cert-expired']?.title || '인증서 만료', tone: 'red', code: 'cert-expired' },
  { kind: 'mp-dead', label: HOST_CFG_TEXT['mp-dead']?.title || '멀티패스 죽은 경로', tone: 'red', code: 'mp-dead' },
  { kind: 'unexpected', label: REBOOT_KIND.unexpected.label, tone: 'red' },
  { kind: 'hw', label: 'iDRAC 부품 경고 · 장애', tone: 'amber', hw: true },
  { kind: 'cert-expiring', label: HOST_CFG_TEXT['cert-expiring']?.title || '인증서 만료 임박', tone: 'amber', code: 'cert-expiring' },
  { kind: 'reboot-required', label: HOST_CFG_TEXT['reboot-required']?.title || '재부팅 필요', tone: 'amber', code: 'reboot-required' },
  { kind: 'ssh-running', label: HOST_CFG_TEXT['ssh-running']?.title || 'SSH 실행 중', tone: 'amber', code: 'ssh-running' },
  { kind: 'logs-lost', label: HOST_CFG_TEXT['logs-lost']?.title || '로그 유실', tone: 'red', code: 'logs-lost' },
  { kind: 'veeam-n', label: 'Veeam 최근 백업 없는 VM', tone: 'amber' },
]);
const CHIP_KINDS = new Set(CHECK_CHIPS.map((c) => c.kind));

/** 호스트가 칩 조건에 맞는가. secOf(host) 는 호출부가 캐시한 secCountsOf 결과. checks 는 /hosts/checks 의 byId. */
export function matchesChip(host, kind, { sec = null, checks = null } = {}) {
  const chip = CHECK_CHIPS.find((c) => c.kind === kind);
  if (!chip) return false;
  if (chip.code) return !!sec && sec.findings.some((f) => f.code === chip.code);
  const c = checks?.[host?.id];
  if (kind === 'hw') return !!c?.hw && (c.hw.state === 'warn' || c.hw.state === 'fault');
  if (kind === 'unexpected') return c?.boot?.kind === 'unexpected';
  if (kind === 'veeam-n') return !!c?.veeam && c.veeam.n > 0;
  return false;
}
/** 칩마다 호스트 수. 그 묶음을 읽지 못했으면(권한·미수집) n 은 null — 0 이 아니다. */
export function chipCounts(rows, { secOf, checks, access } = {}) {
  return CHECK_CHIPS.map((chip) => {
    if (chip.hw && !access?.hw) return { ...chip, n: null, why: '관리자 판본' };
    if (chip.kind === 'unexpected' && checks && !access?.hygiene) return { ...chip, n: null, why: '구성 점검 도구 권한' };
    if ((chip.kind === 'hw' || chip.kind === 'unexpected' || chip.kind === 'veeam-n') && !checks) return { ...chip, n: null, why: '점검 집계를 아직 읽지 않음' };
    if (chip.kind === 'veeam-n' && (rows || []).length && (rows || []).every((h) => !checks[h.id]?.veeam)) return { ...chip, n: null, why: 'Veeam 판정을 읽지 못함(수집 안 됨)' };
    let n = 0;
    for (const h of rows || []) if (matchesChip(h, chip.kind, { sec: secOf ? secOf(h) : null, checks })) n += 1;
    return { ...chip, n, why: '' };
  });
}
/** 표에 보일 호스트 — 시안 B 판정(filterHosts) 위에 칩 조건을 겹친다. */
export function filterHostsExt(rows, { tab = 'all', focus = null } = {}, { secOf, checks } = {}) {
  if (focus && CHIP_KINDS.has(focus.kind)) {
    const base = filterHosts(rows, { tab, focus: null });
    return base.filter((h) => matchesChip(h, focus.kind, { sec: secOf ? secOf(h) : null, checks }));
  }
  return filterHosts(rows, { tab, focus });
}
export function focusLabelExt(focus) {
  if (focus && CHIP_KINDS.has(focus.kind)) return CHECK_CHIPS.find((c) => c.kind === focus.kind)?.label || focus.kind;
  return focusLabel(focus);
}
/** 확인 사유(시안 B) + 칩 사유를 합친 짧은 배지 목록(상세 머리말). */
export function reasonBadges(host, { sec = null, checks = null } = {}) {
  const out = hostReasons(host).map((r) => ({ kind: r.kind, label: r.label, tone: r.kind === 'maint' ? 'amber' : 'red' }));
  for (const chip of CHECK_CHIPS) if (matchesChip(host, chip.kind, { sec, checks })) out.push({ kind: chip.kind, label: chip.label, tone: chip.tone });
  return out;
}
export const usageOf = (h, k) => hostUsagePct(h, k);
