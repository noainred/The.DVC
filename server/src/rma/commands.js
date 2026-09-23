/**
 * 원격 명령 에이전트(RMA, v2.416) — 명령 카탈로그(순수 모듈, 중앙·엣지 공용).
 *
 * 설계 근거: HostMonitor 의 RMA(Remote Monitoring Agent)는 감시 대상 망에 별도 서비스로 상주하며
 * 중앙(HostMonitor)이 보낸 점검·외부 명령을 **그 망 안에서** 실행해 결과만 돌려준다. 이 포탈의
 * 중앙↔엣지는 아웃바운드 전용(엣지가 NAT 뒤)이므로 RMA 의 **passive 모드**(에이전트가 중앙에
 * 접속해 작업을 받아감)만 구현한다. ⚠ 참고 페이지(ks-soft.net RMA 문서)는 이 환경에서 외부
 * 접속이 차단돼 직접 읽지 못했다 — 위 요약은 RMA 의 일반적으로 알려진 동작 모델에 근거한다.
 *
 * 보안 모델(서버 CLAUDE.md '셸 명령 조립' 불변조건):
 *  - 중앙 UI 는 **프리셋 id + 파라미터**만 보낸다. 엣지는 카탈로그로 다시 검증해 argv 배열을
 *    조립하고 **셸 없이(spawn) 실행**한다 — 파라미터는 화이트리스트 정규식으로만 통과(선행 `-`
 *    차단 포함). 중앙이 검증해도 엣지가 재검증한다(중앙 침해 시 엣지가 마지막 방어선).
 *  - 자유 명령(`custom`, /bin/sh -c)은 **엣지 측 opt-in**(`RMA_ALLOW_CUSTOM=true`)일 때만 실행
 *    된다. 각 법인 담당자가 자기 엣지에서 명시적으로 켜야 한다 — 중앙 관리자가 원격으로 켤 수
 *    없다(RMA 의 '외부 명령 허용' 옵션이 에이전트 측 설정인 것과 같은 원칙).
 *  - 파일 내용을 읽는 프리셋(cat 등)은 두지 않는다 — portal.env(토큰·비밀)가 읽히는 경로가 된다.
 *  - 상태를 바꾸는 액션(v2.418, HostMonitor RMA 'Actions' 대응)은 **엣지 정책**에 묶인다: 서비스
 *    start/stop/restart 는 RMA_SERVICE_UNITS 목록의 유닛만, reboot 는 RMA_ALLOW_REBOOT=true 일 때만,
 *    허용/차단 목록(RMA_ENABLED_COMMANDS/RMA_DISABLED_COMMANDS)이 최종. sudoers 는 같은 목록에서 생성한다.
 */
import { strictIpv4Num, cidrMatch } from '../util/ipv4.js';

const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/;                 // IP(v4/v6)·호스트명, 선행 - 금지
const RE_UNIT = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$/;                   // systemd 유닛명
const RE_PATH = /^\/[A-Za-z0-9._/-]{0,200}$/;                           // 절대경로(공백·글롭 금지)
const RE_URL  = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;
const RE_TEXT = /^[A-Za-z0-9._:/@-]{1,120}$/;                            // 일반 토큰(프로세스명 등)

export const PARAM_TYPES = {
  host: { re: RE_HOST, hint: 'IP 또는 호스트명' },
  unit: { re: RE_UNIT, hint: 'systemd 유닛명(예: vmware-portal)' },
  path: { re: RE_PATH, hint: '절대경로(예: /etc/vmware-portal)' },
  url:  { re: RE_URL,  hint: 'http(s)://host[:port][/path]' },
  text: { re: RE_TEXT, hint: '영숫자·._:/@-' },
  message: { re: /^[^\x00-\x1f\x7f]{1,1000}$/, hint: '자유 문자열 한 줄(1000자, 제어문자·개행 불가) — argv 인수로만 전달' }, // eslint-disable-line no-control-regex
  int:  { re: /^\d{1,7}$/, hint: '정수' },
};

/**
 * 프리셋 정의. argv 는 검증된 args 로만 조립한다(문자열 결합 금지).
 *  - params: [{ name, label, type, required, min, max, def }]
 *  - timeoutMs: 기본 제한(요청이 넘길 수 있는 상한은 LIMITS.timeoutMs)
 *  - maxLines: 결과 줄 수 상한(엣지가 잘라 보냄 — ps/top 같이 긴 출력)
 *  - sudo: sudo -n 으로 실행(install.sh 의 sudoers 규칙과 1:1 — 목록을 넓히면 규칙도 함께)
 *  - danger: 상태를 바꾸는 명령(UI 2중 확인 + 감사로그 강조)
 */
export const PRESETS = [
  { id: 'uptime',      group: '시스템', label: '가동 시간·부하 (uptime)',        argv: () => ['uptime'] },
  { id: 'hostname',    group: '시스템', label: '호스트명 (hostnamectl)',         argv: () => ['hostnamectl'] },
  { id: 'os-release',  group: '시스템', label: 'OS 버전 (/etc/os-release)',      argv: () => ['cat', '/etc/os-release'] },
  { id: 'date',        group: '시스템', label: '현재 시각·타임존 (timedatectl)', argv: () => ['timedatectl'] },
  { id: 'chrony',      group: '시스템', label: '시간 동기 상태 (chronyc tracking)', argv: () => ['chronyc', 'tracking'] },
  { id: 'lscpu',       group: '시스템', label: 'CPU 정보 (lscpu)',               argv: () => ['lscpu'] },
  { id: 'free',        group: '시스템', label: '메모리 (free -m)',               argv: () => ['free', '-m'] },
  { id: 'df',          group: '디스크', label: '디스크 사용량 (df -hP)',          argv: () => ['df', '-hP'] },
  { id: 'nfs-mounts',  group: '디스크', label: 'NFS 마운트 (findmnt)',            argv: () => ['findmnt', '-t', 'nfs,nfs4', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'] },
  { id: 'ls',          group: '디스크', label: '디렉터리 목록 (ls -la)',
    params: [{ name: 'path', label: '경로', type: 'path', required: true, def: '/etc/vmware-portal' }],
    argv: (a) => ['ls', '-la', a.path] },
  // 폴더 사용량 Top-N(v2.454) — 하위 폴더별 바이트 합계. 파일 **내용은 읽지 않고** 디렉터리
  // 엔트리 크기만 센다(ls 와 같은 위험도). 주기 자동 실행이라 `filePolicy` 로 엣지의
  // RMA_FILE_ROOTS 안으로 제한한다 — 명령 프리셋 중 유일하게 경로 정책을 받는 항목이다.
  //  -x: 다른 파일시스템으로 넘어가지 않음(마운트 밑의 마운트까지 세면 몇 시간이 걸린다)
  //  -b: 바이트(--apparent-size 아님 — 실제 점유 블록이 아니라 파일 크기 합)
  //  --max-depth=1: 바로 아래 한 단계만(사용자별 폴더). 깊이를 늘리면 출력이 폭증한다.
  { id: 'du-top', group: '디스크', label: '하위 폴더 사용량 (du --max-depth=1)',
    params: [{ name: 'path', label: '폴더', type: 'path', required: true }],
    argv: (a) => ['du', '-x', '-b', '--max-depth=1', a.path],
    filePolicy: true, timeoutMs: 900_000, maxLines: 20_000 },
  { id: 'top',         group: '프로세스', label: 'CPU 상위 프로세스 (top -bn1)', argv: () => ['top', '-bn1', '-w', '200'], maxLines: 40 },
  { id: 'ps-cpu',      group: '프로세스', label: 'CPU 순 프로세스 (ps)',          argv: () => ['ps', 'aux', '--sort=-%cpu'], maxLines: 30 },
  { id: 'ps-mem',      group: '프로세스', label: '메모리 순 프로세스 (ps)',       argv: () => ['ps', 'aux', '--sort=-%mem'], maxLines: 30 },
  { id: 'pgrep',       group: '프로세스', label: '프로세스 찾기 (pgrep -a)',
    params: [{ name: 'name', label: '프로세스명', type: 'text', required: true }],
    argv: (a) => ['pgrep', '-a', '-f', a.name], maxLines: 50 },
  { id: 'ip-addr',     group: '네트워크', label: 'IP 주소 (ip -br addr)',        argv: () => ['ip', '-br', 'addr'] },
  { id: 'ip-route',    group: '네트워크', label: '라우팅 테이블 (ip route)',      argv: () => ['ip', 'route'] },
  { id: 'ss-listen',   group: '네트워크', label: '리슨 포트 (ss -tlnp)',          argv: () => ['ss', '-tlnp'] },
  { id: 'ss-summary',  group: '네트워크', label: '소켓 요약 (ss -s)',             argv: () => ['ss', '-s'] },
  { id: 'ping',        group: '네트워크', label: 'ping',
    params: [{ name: 'host', label: '대상', type: 'host', required: true },
             { name: 'count', label: '횟수', type: 'int', min: 1, max: 20, def: 4 }],
    argv: (a) => ['ping', '-n', '-c', String(a.count), '-W', '2', a.host], timeoutMs: 60_000 },
  { id: 'traceroute', group: '네트워크', label: 'traceroute',
    params: [{ name: 'host', label: '대상', type: 'host', required: true },
             { name: 'hops', label: '최대 홉', type: 'int', min: 1, max: 40, def: 20 }],
    argv: (a) => ['traceroute', '-n', '-w', '2', '-m', String(a.hops), a.host], timeoutMs: 90_000 },
  { id: 'dns',         group: '네트워크', label: 'DNS 조회 (getent hosts)',
    params: [{ name: 'host', label: '이름', type: 'host', required: true }],
    argv: (a) => ['getent', 'hosts', a.host] },
  { id: 'tcp-port',    group: '네트워크', label: 'TCP 포트 접속 확인',
    params: [{ name: 'host', label: '대상', type: 'host', required: true },
             { name: 'port', label: '포트', type: 'int', min: 1, max: 65535, required: true }],
    native: 'tcp-port', timeoutMs: 15_000 },
  { id: 'http-head',   group: '네트워크', label: 'HTTP 응답 확인 (curl -sSI)',
    params: [{ name: 'url', label: 'URL', type: 'url', required: true }],
    argv: (a) => ['curl', '-sSI', '-m', '10', '--max-redirs', '0', a.url], timeoutMs: 20_000 },
  { id: 'sysctl-status', group: '서비스', label: '서비스 상태 (systemctl status)',
    params: [{ name: 'unit', label: '유닛', type: 'unit', required: true, def: 'vmware-portal' }],
    argv: (a) => ['systemctl', 'status', '--no-pager', '-n', '20', a.unit] },
  { id: 'sysctl-failed', group: '서비스', label: '실패한 유닛 (systemctl --failed)', argv: () => ['systemctl', '--failed', '--no-pager'] },
  { id: 'journal',     group: '서비스', label: '서비스 로그 (journalctl -u)',
    params: [{ name: 'unit', label: '유닛', type: 'unit', required: true, def: 'vmware-portal' },
             { name: 'lines', label: '줄 수', type: 'int', min: 10, max: 500, def: 100 }],
    argv: (a) => ['journalctl', '-u', a.unit, '-n', String(a.lines), '--no-pager'] },
  { id: 'portal-restart', group: '서비스', label: '포탈 서비스 재시작 (sudo systemctl restart vmware-portal)',
    argv: () => ['systemctl', 'restart', 'vmware-portal.service'], sudo: true, danger: true, timeoutMs: 60_000 },
  // ── HostMonitor RMA 'Actions' 대응(v2.418) — 서비스 제어는 엣지 RMA_SERVICE_UNITS 허용 목록 + sudoers 규칙에 묶인다 ──
  { id: 'service-start', group: '서비스', label: '서비스 시작 (sudo systemctl start)', params: [{ name: 'unit', label: '유닛', type: 'unit', required: true }],
    argv: (a) => ['systemctl', 'start', `${a.unit}.service`], sudo: true, danger: true, unitPolicy: true, timeoutMs: 60_000 },
  { id: 'service-stop', group: '서비스', label: '서비스 중지 (sudo systemctl stop)', params: [{ name: 'unit', label: '유닛', type: 'unit', required: true }],
    argv: (a) => ['systemctl', 'stop', `${a.unit}.service`], sudo: true, danger: true, unitPolicy: true, timeoutMs: 60_000 },
  { id: 'service-restart', group: '서비스', label: '서비스 재시작 (sudo systemctl restart)', params: [{ name: 'unit', label: '유닛', type: 'unit', required: true }],
    argv: (a) => ['systemctl', 'restart', `${a.unit}.service`], sudo: true, danger: true, unitPolicy: true, timeoutMs: 60_000 },
  { id: 'kill-pid', group: '프로세스', label: '프로세스 종료 (kill, RMA 계정 소유 프로세스만)', params: [{ name: 'pid', label: 'PID', type: 'int', min: 2, max: 4194304, required: true },
    { name: 'force', label: '강제(1=SIGKILL)', type: 'int', min: 0, max: 1, def: 0 }],
    argv: (a) => ['kill', a.force === 1 ? '-KILL' : '-TERM', String(a.pid)], danger: true },
  { id: 'reboot', group: '시스템', label: '재부팅 (sudo systemctl reboot — 엣지 RMA_ALLOW_REBOOT=true 필요)', argv: () => ['systemctl', 'reboot'], sudo: true, danger: true, rebootPolicy: true, timeoutMs: 15_000 },
  { id: 'rma-restart', group: '에이전트', label: 'RMA 에이전트 재시작 (systemd 가 재기동)', native: 'rma-restart', danger: true },
  { id: 'log-event', group: '기타', label: '로그 이벤트 기록 (logger → journal)', params: [{ name: 'message', label: '메시지', type: 'message', required: true },
    { name: 'priority', label: '우선순위(info/warning/err)', type: 'text', def: 'info' }],
    argv: (a) => ['logger', '-t', 'vmware-portal-rma', '-p', `user.${/^(info|warning|err|notice|crit)$/.test(a.priority) ? a.priority : 'info'}`, a.message] },
  { id: 'http-request', group: '기타', label: 'HTTP 요청 (curl GET/POST)', params: [{ name: 'url', label: 'URL', type: 'url', required: true },
    { name: 'method', label: '메서드(GET/POST)', type: 'text', def: 'GET' }, { name: 'body', label: '본문(POST, 선택)', type: 'message' }],
    argv: (a) => ['curl', '-sS', '-m', '15', '--max-redirs', '2', '-X', /^POST$/i.test(a.method) ? 'POST' : 'GET', ...(a.body ? ['-H', 'Content-Type: application/json', '--data', a.body] : []), '-o', '/dev/null', '-w', '%{http_code} %{time_total}s', a.url], timeoutMs: 30_000 },
  { id: 'tcp-send', group: '기타', label: 'TCP 전송 (연결 후 문자열 전송, 응답 앞부분 회신)', params: [{ name: 'host', label: '대상', type: 'host', required: true },
    { name: 'port', label: '포트', type: 'int', min: 1, max: 65535, required: true }, { name: 'data', label: '전송 문자열', type: 'message' }], native: 'tcp-send', timeoutMs: 15_000 },
  { id: 'udp-send', group: '기타', label: 'UDP 전송', params: [{ name: 'host', label: '대상', type: 'host', required: true },
    { name: 'port', label: '포트', type: 'int', min: 1, max: 65535, required: true }, { name: 'data', label: '전송 문자열', type: 'message', required: true }], native: 'udp-send', timeoutMs: 10_000 },
  { id: 'syslog', group: '기타', label: 'Syslog 전송 (UDP 514, RFC3164)', params: [{ name: 'host', label: 'Syslog 서버', type: 'host', required: true },
    { name: 'port', label: '포트', type: 'int', min: 1, max: 65535, def: 514 }, { name: 'message', label: '메시지', type: 'message', required: true },
    { name: 'severity', label: '심각도(0~7)', type: 'int', min: 0, max: 7, def: 6 }], native: 'syslog', timeoutMs: 10_000 },
  { id: 'who',         group: '보안', label: '접속 세션 (who)',                   argv: () => ['who'] },
  { id: 'last-reboot', group: '보안', label: '최근 재부팅 (last -x reboot)',      argv: () => ['last', '-x', 'reboot', '-n', '5'] },
  // ── SSH 원격 실행(v2.419) — 엣지 망 안의 다른 서버에 SSH 로 접속해 명령 실행. 계정은 통합 계정 관리(credentialId)
  //    또는 1회 입력(spec.secret — 잡 인출 즉시 중앙에서 삭제). 엣지 RMA_ALLOW_SSH=true + RMA_SSH_TARGETS 허용 목록.
  { id: 'ssh-exec',    group: 'SSH', label: 'SSH 원격 명령 실행 (통합 계정 또는 1회 입력)',
    params: [{ name: 'host', label: '대상 호스트', type: 'host', required: true },
             { name: 'port', label: 'SSH 포트', type: 'int', min: 1, max: 65535, def: 22 },
             { name: 'credentialId', label: '저장된 계정 id(비우면 1회 입력 계정)', type: 'text' },
             { name: 'username', label: '계정(1회 입력 시)', type: 'text' },
             { name: 'command', label: '실행 명령(원격 셸)', type: 'shell', required: true }],
    native: 'ssh-exec', sshPolicy: true, danger: true, timeoutMs: 60_000 },
  { id: 'custom',      group: '자유 명령', label: '자유 명령 (엣지에서 RMA_ALLOW_CUSTOM=true 일 때만)',
    params: [{ name: 'command', label: '명령', type: 'shell', required: true }],
    shell: true, danger: true, timeoutMs: 60_000 },
];

const byId = new Map(PRESETS.map((p) => [p.id, p]));
export const getPreset = (id) => byId.get(String(id || '')) || null;

/**
 * 경로가 엣지의 허용 루트 안인가 — **경계를 포함한** 프리픽스 비교(순수).
 * `/var/log` 가 허용일 때 `/var/logs` 는 통과하면 안 되므로 루트와 정확히 같거나 `루트 + '/'` 로
 * 시작할 때만 허용한다. `..` 은 정규화 전에 거부한다(경로 문자열로 상위 탈출 차단).
 * realpath 기반 최종 검사는 엣지가 실행 직전에 한 번 더 한다(심볼릭 링크 탈출).
 */
export function fileRootIssue(p, roots) {
  const target = String(p || '');
  if (!target.startsWith('/')) return '절대경로만 사용할 수 있습니다.';
  if (target.split('/').includes('..')) return "경로에 '..' 를 쓸 수 없습니다.";
  const norm = target.length > 1 ? target.replace(/\/+$/, '') : target;
  const list = (roots || []).map((r) => String(r || '')).filter((r) => r.startsWith('/'));
  if (!list.length) return '이 엣지에 파일 접근 허용 경로가 없습니다(RMA_FILE_ROOTS).';
  const ok = list.some((r) => {
    const rr = r.length > 1 ? r.replace(/\/+$/, '') : r;
    return norm === rr || norm.startsWith(rr === '/' ? '/' : rr + '/');
  });
  return ok ? null : `경로 '${norm}' 은 이 엣지의 허용 목록(RMA_FILE_ROOTS: ${list.join(', ')}) 밖입니다.`;
}

export const LIMITS = {
  timeoutMs: { min: 1_000, max: 300_000, def: 30_000 },
  shellMaxLen: 2_000,
};

/** 프리셋 목록(UI 용 — 함수 제외). */
export function catalog() {
  return PRESETS.map(({ argv, ...p }) => ({ ...p, params: (p.params || []).map((x) => ({ ...x, hint: PARAM_TYPES[x.type]?.hint || '' })) }));
}

/**
 * 파라미터 검증 + argv 조립(순수). 실패 시 { ok:false, issue }.
 * 성공: { ok:true, preset, args, argv?, shell?, native?, timeoutMs, maxLines, sudo, danger }
 * args 는 검증·정규화된 값만 담는다(선언되지 않은 키는 버린다 — 임의 필드 전달 차단).
 */
export function buildCommand(cmd, rawArgs = {}, opts = {}) {
  const preset = getPreset(cmd);
  if (!preset) return { ok: false, issue: `알 수 없는 명령: ${String(cmd || '').slice(0, 40)}` };
  const args = {};
  for (const p of preset.params || []) {
    let v = rawArgs?.[p.name];
    if (v == null || v === '') v = p.def;
    if (v == null || v === '') {
      if (p.required) return { ok: false, issue: `'${p.label}' 값이 필요합니다.` };
      continue;
    }
    v = String(v).trim();
    if (p.type === 'shell') {
      if (v.length > LIMITS.shellMaxLen) return { ok: false, issue: `명령이 너무 깁니다(최대 ${LIMITS.shellMaxLen}자).` };
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) return { ok: false, issue: '명령에 제어문자가 포함되어 있습니다.' }; // eslint-disable-line no-control-regex
      args[p.name] = v;
      continue;
    }
    const t = PARAM_TYPES[p.type];
    if (!t) return { ok: false, issue: `내부 오류: 파라미터 타입 ${p.type}` };
    if (!t.re.test(v)) return { ok: false, issue: `'${p.label}' 형식 오류 — ${t.hint}` };
    if (p.type === 'int') {
      const n = Number(v);
      if (p.min != null && n < p.min) return { ok: false, issue: `'${p.label}'은 ${p.min} 이상이어야 합니다.` };
      if (p.max != null && n > p.max) return { ok: false, issue: `'${p.label}'은 ${p.max} 이하여야 합니다.` };
      args[p.name] = n;
    } else args[p.name] = v;
  }
  // shell 타입 파라미터가 있어도 native(원격 SSH)면 로컬 자유 명령이 아니다 — allowCustom 과 무관.
  if (preset.shell && !opts.allowCustom) {
    return { ok: false, issue: '자유 명령은 이 엣지에서 허용되지 않았습니다 — 엣지 portal.env 에 RMA_ALLOW_CUSTOM=true 를 설정해야 합니다.' };
  }
  const reqTimeout = Number(opts.timeoutMs);
  const base = preset.timeoutMs || LIMITS.timeoutMs.def;
  const timeoutMs = Number.isFinite(reqTimeout) && reqTimeout > 0
    ? Math.min(LIMITS.timeoutMs.max, Math.max(LIMITS.timeoutMs.min, reqTimeout)) : base;
  // 엣지 정책(v2.418): 허용 목록·서비스 유닛 목록·재부팅 opt-in. 중앙은 opts.policy 없이(형식만) 검증한다.
  const pol = opts.policy;
  if (pol) {
    if (!commandAllowed(preset.id, pol)) return { ok: false, issue: `이 엣지에서 허용되지 않은 명령입니다: ${preset.id} (RMA_ENABLED_COMMANDS/RMA_DISABLED_COMMANDS)` };
    if (preset.unitPolicy && !(pol.serviceUnits || []).some((u) => u === args.unit)) return { ok: false, issue: `서비스 '${args.unit}' 은 이 엣지의 허용 목록(RMA_SERVICE_UNITS)에 없습니다.` };
    if (preset.rebootPolicy && !pol.allowReboot) return { ok: false, issue: '재부팅은 이 엣지에서 허용되지 않았습니다(RMA_ALLOW_REBOOT=true 필요).' };
    // 파일 경로 정책(v2.454) — 여기서는 **정규화 후 경계(/) 프리픽스**만 본다. 심볼릭 링크 탈출은
    // 문자열로 막을 수 없으므로 엣지가 실행 직전 realpath 로 다시 검사한다(agent.js) — 두 겹이다.
    // 접두 문자열만으로 끝내면 `/var/log` 허용이 `/var/logs` 를 통과시킨다(v2.418 과 같은 함정).
    if (preset.filePolicy) {
      const issue = fileRootIssue(args.path, pol.fileRoots);
      if (issue) return { ok: false, issue };
    }
    if (preset.sshPolicy) {
      if (!pol.allowSsh) return { ok: false, issue: 'SSH 원격 실행은 이 엣지에서 허용되지 않았습니다(RMA_ALLOW_SSH=true 필요).' };
      if (!targetAllowed(args.host, pol.sshTargets)) return { ok: false, issue: `대상 '${args.host}' 은 이 엣지의 SSH 허용 목록(RMA_SSH_TARGETS)에 없습니다.` };
    }
  }
  const out = { ok: true, preset: preset.id, args, timeoutMs, maxLines: preset.maxLines || 0, sudo: !!preset.sudo, danger: !!preset.danger };
  if (preset.filePolicy) out.filePolicy = true;  // 엣지가 realpath 로 2차 검사하도록 표시(agent.js)
  if (preset.native) out.native = preset.native;
  else if (preset.shell) out.shell = args.command;
  else {
    const argv = preset.argv(args);
    // 방어: 조립된 argv 에 파라미터가 옵션(-)으로 해석될 값이 섞이지 않았는지 재확인.
    for (const [k, v] of Object.entries(args)) if (String(v).startsWith('-')) return { ok: false, issue: `'${k}' 값은 -로 시작할 수 없습니다.` };
    out.argv = preset.sudo ? ['sudo', '-n', ...argv] : argv;
  }
  return out;
}

/**
 * 엣지 허용 정책(순수, v2.418) — HostMonitor RMA 의 '에이전트별 허용 테스트/액션 목록'에 해당.
 * policy = { enabled: ['*'|id…], disabled: [id…], serviceUnits: [unit…], allowReboot }
 * enabled 가 비어 있거나 '*' 이면 전부 허용(disabled 제외). custom 은 allowCustom 이 별도로 다룬다.
 */
export function commandAllowed(id, policy = {}) {
  const en = policy.enabled || [];
  const dis = new Set(policy.disabled || []);
  if (dis.has(id)) return false;
  if (!en.length || en.includes('*')) return true;
  return en.includes(id);
}

/**
 * SSH 대상 허용 판정(순수, v2.419) — IPv4/CIDR/정확 호스트명/`*.suffix`/`*`. 빈 목록 = **전부 허용**
 * (RMA_ALLOW_SSH 자체가 opt-in 이므로; 좁히려면 목록을 지정).
 */
export function targetAllowed(host, list = []) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  // v2.589: 숫자·점 모양인데 정규형이 아니면(선행 0 = 8진 해석 위험) 목록과 무관하게 거부 — util/ipv4 단일 소스.
  const n = strictIpv4Num(h);
  if (n === false) return false;
  if (!list || !list.length) return true;
  for (const raw of list) {
    const e = String(raw).trim().toLowerCase();
    if (e === '*') return true;
    if (e.startsWith('*.')) { if (h.endsWith(e.slice(1))) return true; continue; }
    if (e.includes('/')) { if (n != null && cidrMatch(n, e) === true) return true; continue; }
    if (e === h) return true;
  }
  return false;
}

/** 쉼표/공백 구분 목록 파싱(순수). */
export const parseList = (s) => String(s || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

/** 감사로그·이력 표시용 한 줄 요약(비밀 없음 — 파라미터는 전부 화이트리스트 통과값). */
export function describeCommand(cmd, args = {}) {
  const p = getPreset(cmd);
  if (!p) return String(cmd || '');
  const parts = (p.params || []).map((x) => (args?.[x.name] != null && args[x.name] !== '' ? `${x.name}=${String(args[x.name]).slice(0, 80)}` : '')).filter(Boolean);
  return parts.length ? `${p.id}(${parts.join(', ')})` : p.id;
}
