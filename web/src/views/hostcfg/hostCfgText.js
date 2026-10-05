// v2.699 — ESXi 호스트 구성·보안 문구·판정. 서버 hostcfg/parse.js 와 같은 입력으로 대조한다(번들 경계라 두 벌).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
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
  drift: 'info',
});
export const CERT_WARN_DAYS = 30;

export const HOST_CFG_TEXT = Object.freeze({
  'cert-expired': { title: '호스트 인증서가 만료됐습니다', fix: 'vCenter 에서 인증서를 갱신하세요(호스트 › 구성 › 인증서) · 만료되면 vCenter 연결·HA 가 실패할 수 있습니다' },
  'cert-expiring': { title: '호스트 인증서가 곧 만료됩니다', fix: '만료 전에 갱신하세요(호스트 › 구성 › 인증서 › 갱신)' },
  'reboot-required': { title: '재부팅이 필요합니다', fix: '패치·드라이버 변경이 재부팅 전까지 적용되지 않았습니다 · 유지보수 모드로 옮긴 뒤 재부팅하세요' },
  'ssh-running': { title: 'SSH 가 실행 중입니다', fix: '작업이 끝났으면 SSH 서비스를 중지하세요(CIS 권고)' },
  'shell-running': { title: 'ESXi Shell 이 실행 중입니다', fix: '작업이 끝났으면 ESXi Shell 을 중지하세요(CIS 권고)' },
  'ntp-none': { title: '시간 동기화(NTP)가 설정되지 않았거나 멈춰 있습니다', fix: 'NTP 서버를 지정하고 ntpd 를 켜세요 · 시간이 어긋나면 인증·로그 대조가 깨집니다' },
  'syslog-none': { title: '원격 syslog 가 설정되지 않았습니다', fix: 'Syslog.global.logHost 에 로그 서버를 지정하세요 · 로컬 로그는 재부팅 시 사라질 수 있습니다' },
  'acceptance-community': { title: '커뮤니티 VIB 를 허용합니다', fix: '허용 수준을 PartnerSupported 이상으로 올리세요(서명되지 않은 VIB 설치 가능)' },
  'lockout-off': { title: '로그인 실패 계정 잠금이 꺼져 있습니다', fix: 'Security.AccountLockFailures 를 0 이 아닌 값으로(CIS 권고 5 이하)' },
  'mob-enabled': { title: 'MOB(관리 개체 브라우저)가 켜져 있습니다', fix: 'Config.HostAgent.plugins.solo.enableMob 를 끄세요(CIS 권고)' },
  'mp-dead': { title: '죽은 스토리지 경로가 있습니다', fix: 'HBA·스위치 포트·케이블·어레이 포트를 확인하세요 · 남은 경로가 끊기면 데이터스토어에 접근하지 못합니다' },
  'mp-single': { title: '경로가 하나뿐인 공유 LUN 이 있습니다', fix: 'FC·iSCSI LUN 은 경로가 둘 이상이어야 합니다 · 조닝·마스킹·두 번째 HBA 를 확인하세요' },
  'vsan-disk-issue': { title: 'vSAN 디스크 문제가 보고됐습니다', fix: 'vSAN 디스크 관리에서 해당 디스크 상태를 확인하세요' },
  'net-single-uplink': { title: '업링크가 하나뿐인 가상 스위치가 있습니다', fix: '물리 NIC 하나가 끊기면 그 스위치의 VM·관리망이 끊깁니다 · 업링크를 둘 이상(다른 물리 스위치로) 연결하세요' },
  'net-uplink-down': { title: '링크가 내려간 업링크가 있습니다', fix: '그 물리 NIC 의 케이블·스위치 포트를 확인하세요 · 남은 업링크가 끊기면 통신이 끊깁니다' },
  'net-promisc': { title: '무차별 모드를 허용하는 포트그룹이 있습니다', fix: '모니터링·중첩 가상화 같은 목적이 아니면 거부로 바꾸세요(다른 VM 트래픽을 볼 수 있습니다)' },
  'net-no-uplink': { title: '업링크가 없는 가상 스위치가 있습니다', fix: '참고 · 의도한 내부 전용 스위치가 아니면 업링크를 연결하세요' },
  'ssh-autostart': { title: 'SSH 가 호스트와 함께 시작됩니다', fix: '시작 정책을 수동으로 바꾸세요' },
  'lockdown-off': { title: '잠금 모드(lockdown)가 꺼져 있습니다', fix: '참고 · 운영 정책에 따라 정상 모드 이상을 권고합니다' },
  'shell-timeout-off': { title: 'ESXi Shell 시간 제한이 없습니다', fix: 'UserVars.ESXiShellTimeOut 을 설정하세요(CIS 권고 900초 이하)' },
  drift: { title: '같은 클러스터의 다른 호스트와 구성이 다릅니다', fix: '클러스터 안에서는 빌드·NTP·DNS·syslog·허용 수준을 맞추세요' },
});
export const DRIFT_LABEL = Object.freeze({ build: 'ESXi 빌드', ntp: 'NTP 서버', dns: 'DNS 서버', syslog: 'syslog 대상', lockdown: '잠금 모드', acceptance: '허용 수준', sshPolicy: 'SSH 시작 정책', sharedLuns: '공유 LUN 수', portgroups: '표준 포트그룹(이름:VLAN)' });
export const SEV_LABEL = Object.freeze({ crit: '위험', warn: '주의', info: '참고' });
export const SEV_BADGE = Object.freeze({ crit: 'red', warn: 'amber', info: 'gray' });
const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
const DAY = 86_400_000;

/** 서버 hostCfgFindings 와 같은 규칙(드리프트 제외 — 그것은 클러스터 단위라 서버가 한다). */
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
  if (h.mp && h.mp.dead > 0) add('mp-dead', { dead: h.mp.dead, luns: h.mp.deadLuns });
  if (h.mp && h.mp.singlePath > 0) add('mp-single', { count: h.mp.singlePath, luns: h.mp.singleLuns });
  if (h.vsan?.enabled === true && h.vsan.diskIssues > 0) add('vsan-disk-issue', { count: h.vsan.diskIssues });
  if (h.net) {
    const sw = Array.isArray(h.net.switches) ? h.net.switches : [];
    const used = sw.filter((x) => x.kind === 'dvs' || x.pgs > 0);
    const single = used.filter((x) => x.uplinks.length === 1).map((x) => x.name);
    if (single.length) add('net-single-uplink', { switches: single.slice(0, 10) });
    const none = used.filter((x) => x.uplinks.length === 0).map((x) => x.name);
    if (none.length) add('net-no-uplink', { switches: none.slice(0, 10) });
    const nics = new Map((Array.isArray(host.nics) ? host.nics : []).filter((n) => n && n.device).map((n) => [n.device, n]));
    const down = [];
    for (const x of used) for (const u of x.uplinks) { const n = nics.get(u); if (n && n.link === false) down.push(`${x.name}/${u}`); }
    if (down.length) add('net-uplink-down', { count: down.length, list: down.slice(0, 10) });
    const pr = (Array.isArray(h.net.pgs) ? h.net.pgs : []).filter((p) => p.promisc === true).map((p) => p.name);
    if (pr.length) add('net-promisc', { count: pr.length, names: pr.slice(0, 10) });
  }
  return out;
}

export function findingDetail(f) {
  const x = f?.facts || {};
  switch (f?.code) {
    case 'cert-expired': return `${x.days}일 전 만료`;
    case 'cert-expiring': return `${x.days}일 남음`;
    case 'ntp-none': return x.servers === 0 ? 'NTP 서버 없음' : 'ntpd 중지';
    case 'mp-dead': return `죽은 경로 ${x.dead}개${x.luns?.length ? ` · ${x.luns.join(', ')}` : ''}`;
    case 'mp-single': return `${x.count}개 LUN${x.luns?.length ? ` · ${x.luns.join(', ')}` : ''}`;
    case 'vsan-disk-issue': return `${x.count}건`;
    case 'net-single-uplink': case 'net-no-uplink': return (x.switches || []).join(', ');
    case 'net-uplink-down': return (x.list || []).join(', ');
    case 'net-promisc': return (x.names || []).join(', ');
    case 'drift': return `${DRIFT_LABEL[x.field] || x.field}: ${x.value}${x.majority != null ? ` (다수 ${x.majority})` : ' (다수값 없음)'}`;
    default: return '';
  }
}

export function codeChips(byCode) {
  const list = Object.entries(byCode || {}).map(([code, v]) => ({ code, sev: v?.sev || 'info', hosts: Number.isFinite(v?.hosts) ? v.hosts : 0, title: HOST_CFG_TEXT[code]?.title || code }));
  return list.sort((a, b) => (b.hosts > 0) - (a.hosts > 0) || SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.hosts - a.hosts || a.title.localeCompare(b.title));
}

export function coverageText(c) {
  if (!c) return '';
  const parts = [`호스트 ${c.hosts.toLocaleString()}대`, `구성 읽음 ${c.cfg.toLocaleString()}`];
  if (c.notCollected) parts.push(`아직 안 읽음 ${c.notCollected.toLocaleString()}`);
  if (c.disconnected) parts.push(`연결 끊김 ${c.disconnected.toLocaleString()} 제외`);
  return parts.join(' · ');
}
export function coverageNote(c, scan) {
  if (!c) return null;
  if (scan && scan.enabled === false) return '호스트 구성 수집이 꺼져 있습니다(HOST_CFG_SCAN=false) — 이 화면은 판정하지 않습니다.';
  const live = c.hosts - c.disconnected;
  if (live > 0 && c.notCollected === live) return '아직 구성을 읽은 호스트가 없습니다 — 수집 서버가 오래된 호스트부터 나눠 읽습니다(재시작 직후면 몇 주기 뒤에 채워집니다).';
  if (c.notCollected > 0) return `구성을 아직 읽지 않은 호스트 ${c.notCollected.toLocaleString()}대는 판정에서 빠졌습니다(이상이 없다는 뜻이 아닙니다).`;
  return null;
}

const yn = (v, t = '예', f = '아니오') => (v === true ? t : v === false ? f : '—');
const svcText = (s) => (!s ? '—' : `${s.running === true ? '실행 중' : s.running === false ? '중지' : '—'}${s.policy ? ` · 시작 ${s.policy === 'on' ? '자동' : s.policy === 'off' ? '수동' : s.policy}` : ''}`);
const LOCK = { disabled: '꺼짐', normal: '정상(normal)', strict: '엄격(strict)' };
const listText = (a) => (Array.isArray(a) ? (a.length ? a.join(', ') : '(없음)') : '—');

function netSwitchText(n) {
  if (!n || !Array.isArray(n.switches)) return '—';
  if (!n.switches.length) return '(없음)';
  return n.switches.map((x) => `${x.name}(${x.kind === 'dvs' ? '분산' : '표준'} · 업링크 ${x.uplinks.length ? x.uplinks.join('+') : '없음'})`).join(', ');
}
function netPgText(n) {
  if (!n || !Array.isArray(n.pgs)) return '—';
  if (!n.pgs.length) return '(없음)';
  const shown = n.pgs.slice(0, 8).map((p) => `${p.name}${p.vlan == null ? '' : ` VLAN ${p.vlan}`}${p.promisc === true ? ' 무차별' : ''}`).join(', ');
  const total = Number.isFinite(n.pgsTotal) ? n.pgsTotal : n.pgs.length;
  return total > 8 ? `${shown} 외 ${total - 8}개` : shown;
}

/** 호스트 상세의 행 — 미수집이면 none + 이유. 값이 없으면 '—'(꺼짐·0 으로 채우지 않는다). */
export function hostCfgRows(host, now = Date.now()) {
  const h = host?.hcfg;
  if (!h) return { state: 'none', rows: [], note: '이 호스트의 구성 속성을 아직 읽지 않았습니다 — 수집 서버가 오래된 호스트부터 나눠 읽습니다.' };
  const cert = Number.isFinite(h.certNotAfter) ? `${new Date(h.certNotAfter).toLocaleDateString('ko-KR')} (${Math.floor((h.certNotAfter - now) / DAY)}일)` : '—';
  const rows = [
    { label: '재부팅 필요', value: yn(h.rebootRequired) },
    { label: '인증서 만료', value: cert, title: h.certSubject || '' },
    { label: '잠금 모드', value: LOCK[h.lockdown] || '—' },
    { label: 'SSH', value: svcText(h.services?.ssh) },
    { label: 'ESXi Shell', value: svcText(h.services?.shell) },
    { label: 'NTP', value: `${listText(h.ntpServers)}${h.services?.ntpd ? ` · ntpd ${h.services.ntpd.running === true ? '실행' : h.services.ntpd.running === false ? '중지' : '—'}` : ''}` },
    { label: 'DNS', value: listText(h.dnsServers) },
    { label: 'syslog 대상', value: h.syslogHost == null ? '—' : h.syslogHost || '(없음)' },
    { label: '허용 수준', value: h.acceptance || '—' },
    { label: '로그인 실패 잠금', value: h.lockFailures == null ? '—' : h.lockFailures === 0 ? '꺼짐' : `${h.lockFailures}회` },
    { label: 'Shell 시간 제한', value: h.shellTimeout == null ? '—' : h.shellTimeout === 0 ? '없음' : `${h.shellTimeout}초` },
    { label: 'MOB', value: yn(h.mob, '켜짐', '꺼짐') },
    { label: '스토리지 경로', value: h.mp ? `LUN ${h.mp.luns}(공유 ${h.mp.shared}) · 경로 ${h.mp.paths} · 죽은 경로 ${h.mp.dead}` : '—' },
    { label: 'vSAN', value: !h.vsan ? '—' : h.vsan.enabled === true ? `참여 · 멤버 ${h.vsan.members ?? '—'} · 디스크 문제 ${h.vsan.diskIssues ?? '—'}` : h.vsan.enabled === false ? '참여 안 함' : '—' },
    { label: '가상 스위치', value: netSwitchText(h.net) },
    { label: '포트그룹', value: netPgText(h.net) },
  ];
  const age = Number.isFinite(h.at) ? Math.max(0, Math.round((now - h.at) / 60_000)) : null;
  const note = `${age == null ? '' : age < 60 ? `${age}분 전에 읽은 값` : `${Math.round(age / 60)}시간 전에 읽은 값`} · 수집 서버가 주기적으로 다시 읽습니다${host.connectionState === 'DISCONNECTED' ? ' · 연결이 끊겨 판정하지 않습니다' : ''}.`;
  return { state: 'ok', rows, note };
}
