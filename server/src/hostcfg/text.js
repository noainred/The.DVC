/**
 * hostcfg/text.js — 호스트 구성·보안 점검의 **사람이 읽는 글자**(서버 판 — v2.802 호스트·클러스터 엑셀).
 *
 * 화면 글자는 web/src/views/hostcfg/hostCfgText.js 에 있다(HOST_CFG_TEXT · DRIFT_LABEL · REBOOT_KIND · hostCfgRows). 엑셀은 서버가 만들어서
 * 같은 글자가 서버에도 필요하다 — 번들 경계라 두 벌이고, server/test/hostExport2802.test.js 가 같은 입력으로 두 벌을 대조한다
 * (제목·라벨·값이 어긋나면 화면과 파일이 다른 말을 한다). 판정(어느 코드가 켜지는가)은 parse.js hostCfgFindings 하나다 — 여기서 판정하지 않는다.
 * 시각만 다르다: 화면은 브라우저 지역 시각, 엑셀은 포탈 시각(localStamp)이다.
 */
import { localStamp, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { scratchVolatile } from './parse.js';

const DAY = 86_400_000;

/** 코드 → 제목(웹 HOST_CFG_TEXT[code].title 과 같다). */
export const HOST_CFG_TITLE = Object.freeze({
  'cert-expired': '호스트 인증서가 만료됐습니다',
  'cert-expiring': '호스트 인증서가 곧 만료됩니다',
  'reboot-required': '재부팅이 필요합니다',
  'ssh-running': 'SSH 가 실행 중입니다',
  'shell-running': 'ESXi Shell 이 실행 중입니다',
  'ntp-none': '시간 동기화(NTP)가 설정되지 않았거나 멈춰 있습니다',
  'syslog-none': '원격 syslog 가 설정되지 않았습니다',
  'acceptance-community': '커뮤니티 VIB 를 허용합니다',
  'lockout-off': '로그인 실패 계정 잠금이 꺼져 있습니다',
  'mob-enabled': 'MOB(관리 개체 브라우저)가 켜져 있습니다',
  'mp-dead': '죽은 스토리지 경로가 있습니다',
  'mp-single': '경로가 하나뿐인 공유 LUN 이 있습니다',
  'vsan-disk-issue': 'vSAN 디스크 문제가 보고됐습니다',
  'net-single-uplink': '업링크가 하나뿐인 가상 스위치가 있습니다',
  'net-uplink-down': '링크가 내려간 업링크가 있습니다',
  'net-promisc': '무차별 모드를 허용하는 포트그룹이 있습니다',
  'net-no-uplink': '업링크가 없는 가상 스위치가 있습니다',
  'ssh-autostart': 'SSH 가 호스트와 함께 시작됩니다',
  'lockdown-off': '잠금 모드(lockdown)가 꺼져 있습니다',
  'shell-timeout-off': 'ESXi Shell 시간 제한이 없습니다',
  'logs-lost': '크래시 직전 로그가 어디에도 남지 않습니다',
  'logs-volatile': '로컬 로그가 재부팅 때 사라집니다',
  'scratch-volatile': '스크래치가 램디스크에 있습니다',
  'coredump-partition-none': '진단(코어 덤프) 파티션이 없습니다',
  'psod-no-reboot': 'PSOD 뒤 자동으로 재부팅하지 않습니다',
  drift: '같은 클러스터의 다른 호스트와 구성이 다릅니다',
});
/** 드리프트 항목 이름(웹 DRIFT_LABEL 과 같다). */
export const DRIFT_LABEL = Object.freeze({ build: 'ESXi 빌드', ntp: 'NTP 서버', dns: 'DNS 서버', syslog: 'syslog 대상', lockdown: '잠금 모드', acceptance: '허용 수준', sshPolicy: 'SSH 시작 정책', sharedLuns: '공유 LUN 수', portgroups: '표준 포트그룹(이름:VLAN)' });
export const SEV_LABEL = Object.freeze({ crit: '위험', warn: '주의', info: '참고' });
/** 재부팅 분류 이름(웹 REBOOT_KIND[k].label 과 같다 — 키는 reboots.js REBOOT_KINDS). */
export const REBOOT_LABEL = Object.freeze({ unexpected: '예기치 않은 재부팅 후보', unknown: '원인 미상', 'no-events': '판정 불가', planned: '계획된 재부팅' });

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

/**
 * 호스트 시트 '구성 · 보안 점검' 의 행 — 웹 hostCfgRows 와 같은 라벨·값(시각만 포탈 시각) + 그 행에 걸리는 판정 코드.
 * @returns {{ state:'ok'|'none', rows:Array<{label:string, value:string, codes:string[]}> }}
 */
export function hostCfgTableRows(host, { now = Date.now(), offsetMin = DAY_OFFSET_MIN } = {}) {
  const h = host?.hcfg;
  if (!h) return { state: 'none', rows: [] };
  const cert = Number.isFinite(h.certNotAfter) ? `${localStamp(h.certNotAfter, offsetMin).slice(0, 10)} (${Math.floor((h.certNotAfter - now) / DAY)}일)` : '—';
  const R = (label, value, codes = []) => ({ label, value, codes });
  return {
    state: 'ok',
    rows: [
      R('마지막 부팅', Number.isFinite(host.bootTime) ? `${localStamp(host.bootTime, offsetMin)} (${Math.max(0, Math.floor((now - host.bootTime) / DAY))}일 전)` : '—'),
      R('재부팅 필요', yn(h.rebootRequired), ['reboot-required']),
      R('인증서 만료', cert, ['cert-expired', 'cert-expiring']),
      R('잠금 모드', LOCK[h.lockdown] || '—', ['lockdown-off']),
      R('SSH', svcText(h.services?.ssh), ['ssh-running', 'ssh-autostart']),
      R('ESXi Shell', svcText(h.services?.shell), ['shell-running']),
      R('NTP', `${listText(h.ntpServers)}${h.services?.ntpd ? ` · ntpd ${h.services.ntpd.running === true ? '실행' : h.services.ntpd.running === false ? '중지' : '—'}` : ''}`, ['ntp-none']),
      R('DNS', listText(h.dnsServers)),
      R('syslog 대상', h.syslogHost == null ? '—' : h.syslogHost || '(없음)', ['syslog-none']),
      R('허용 수준', h.acceptance || '—', ['acceptance-community']),
      R('로그인 실패 잠금', h.lockFailures == null ? '—' : h.lockFailures === 0 ? '꺼짐' : `${h.lockFailures}회`, ['lockout-off']),
      R('Shell 시간 제한', h.shellTimeout == null ? '—' : h.shellTimeout === 0 ? '없음' : `${h.shellTimeout}초`, ['shell-timeout-off']),
      R('MOB', yn(h.mob, '켜짐', '꺼짐'), ['mob-enabled']),
      R('스크래치 위치', h.scratch == null ? '—' : h.scratch || '(없음)', ['scratch-volatile']),
      R('로컬 로그 위치', h.logDir == null ? '—' : h.logDir || '(기본값)', ['logs-lost', 'logs-volatile']),
      R('진단 파티션', yn(h.diagPartition, '있음', '없음(7.0+ 는 코어 덤프 파일일 수 있음)'), ['coredump-partition-none']),
      R('PSOD 뒤 자동 재부팅', h.bsodTimeout == null ? '—' : h.bsodTimeout === 0 ? '안 함(화면 유지)' : `${h.bsodTimeout}초 뒤`, ['psod-no-reboot']),
      R('스토리지 경로', h.mp ? `LUN ${h.mp.luns}(공유 ${h.mp.shared}) · 경로 ${h.mp.paths} · 죽은 경로 ${h.mp.dead}` : '—', ['mp-dead', 'mp-single']),
      R('vSAN', !h.vsan ? '—' : h.vsan.enabled === true ? `참여 · 멤버 ${h.vsan.members ?? '—'} · 디스크 문제 ${h.vsan.diskIssues ?? '—'}` : h.vsan.enabled === false ? '참여 안 함' : '—', ['vsan-disk-issue']),
      R('가상 스위치', netSwitchText(h.net), ['net-single-uplink', 'net-uplink-down', 'net-no-uplink']),
      R('포트그룹', netPgText(h.net), ['net-promisc']),
    ],
  };
}
/** 진단용 — 스크래치가 램디스크인가(parse.js 와 같은 판정). */
export const scratchIsVolatile = scratchVolatile;
