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
 *  - 재부팅/전원 프리셋은 두지 않는다. 포탈 서비스 재시작만 sudo 규칙(install.sh 가 sudoers 로
 *    정확히 그 한 줄만 허용)으로 제공한다.
 */

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
  int:  { re: /^\d{1,6}$/, hint: '정수' },
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
  { id: 'who',         group: '보안', label: '접속 세션 (who)',                   argv: () => ['who'] },
  { id: 'last-reboot', group: '보안', label: '최근 재부팅 (last -x reboot)',      argv: () => ['last', '-x', 'reboot', '-n', '5'] },
  { id: 'custom',      group: '자유 명령', label: '자유 명령 (엣지에서 RMA_ALLOW_CUSTOM=true 일 때만)',
    params: [{ name: 'command', label: '명령', type: 'shell', required: true }],
    shell: true, danger: true, timeoutMs: 60_000 },
];

const byId = new Map(PRESETS.map((p) => [p.id, p]));
export const getPreset = (id) => byId.get(String(id || '')) || null;

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
  if (preset.shell && !opts.allowCustom) {
    return { ok: false, issue: '자유 명령은 이 엣지에서 허용되지 않았습니다 — 엣지 portal.env 에 RMA_ALLOW_CUSTOM=true 를 설정해야 합니다.' };
  }
  const reqTimeout = Number(opts.timeoutMs);
  const base = preset.timeoutMs || LIMITS.timeoutMs.def;
  const timeoutMs = Number.isFinite(reqTimeout) && reqTimeout > 0
    ? Math.min(LIMITS.timeoutMs.max, Math.max(LIMITS.timeoutMs.min, reqTimeout)) : base;
  const out = { ok: true, preset: preset.id, args, timeoutMs, maxLines: preset.maxLines || 0, sudo: !!preset.sudo, danger: !!preset.danger };
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

/** 감사로그·이력 표시용 한 줄 요약(비밀 없음 — 파라미터는 전부 화이트리스트 통과값). */
export function describeCommand(cmd, args = {}) {
  const p = getPreset(cmd);
  if (!p) return String(cmd || '');
  const parts = (p.params || []).map((x) => (args?.[x.name] != null && args[x.name] !== '' ? `${x.name}=${String(args[x.name]).slice(0, 80)}` : '')).filter(Boolean);
  return parts.length ? `${p.id}(${parts.join(', ')})` : p.id;
}
