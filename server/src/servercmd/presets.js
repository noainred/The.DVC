/**
 * servercmd/presets.js — 기능 ‘서버 명령 실행’ 의 **프리셋 목록 · 값 검사 · 명령 만들기 · 출력 다듬기**(순수 · 의존 없음 · v3.30 · 설계 docs/design/server-cmd ② · D2 · D3 · D11).
 *
 * 규칙(설계 ① ‘값이 명령에 들어가는 길 여섯 겹’ · ② ‘넣지 않는 것’):
 *  · 명령은 **이 파일에 고정**(화면 · API 는 프리셋 id 와 값만 보낸다 — 명령 글자를 받는 칸이 없다 · 더하려면 릴리스).
 *  · 값은 두 종류(이름 · 경로)만 · 허용 글자만(공백 · 따옴표 · `$ ; |` · 줄바꿈 · 선행 `-` 불가 · 경로의 `..` 조각 불가) · 그래도 작은따옴표로 감싸고 `--` 뒤에 둔다.
 *  · **읽기 전용 · sudo 없음** · 상태를 바꾸는 명령 · 다른 주소로 가는 탐침 · 값으로 받은 경로의 파일 내용 · 프로세스 인자 · 환경 변수는 넣지 않는다(시험이 목록 전체를 쓸어 본다).
 *  · Linux 는 문장마다 `timeout N`(포탈 시한 뒤 서버에 프로세스가 남지 않게) · `LC_ALL=C`. 시한의 합 + 여유 + 로그인 < 서버 한 대 시한(시험).
 *  · Windows 는 PowerShell 스크립트를 `-EncodedCommand`(UTF-16LE base64)로 — OpenSSH 기본 셸(cmd · PowerShell) · WinRM 어디서든 같은 한 줄 · cmd 한도 8191자(시험).
 *    **실제 Windows 서버 출력으로 확인하지 못했다**(화면 ‘시험’ 표시 — D9).
 */

export const FEATURE = 'server-cmd';
/** Linux exec 시한 = 문장 수 × 문장 시한 + 여유(초). */
export const LINUX_SLACK_S = 5;
/** Windows exec 시한 = 스크립트 시한 + 여유(PowerShell 시작 시간 — 초). */
export const WIN_SLACK_S = 10;
/** 명령 하나의 출력 상한(바이트 — 넘으면 끊고 ‘잘림’). */
export const MAX_BYTES = 64 * 1024;
/** 화면에 보이는 줄 상한 · 한 줄 글자 상한(다듬기). */
export const MAX_LINES = 2000;
export const MAX_LINE_CHARS = 2000;
/** cmd.exe 한 줄 한도(OpenSSH 기본 셸이 cmd 일 때). */
export const CMD_LINE_MAX = 8191;

/** 묶음(화면 순서). */
export const GROUPS = Object.freeze(['시스템', '디스크', '프로세스', '네트워크', '서비스 · 로그', '접속']);

/** 값 종류 — 이 둘뿐(D11). 길이를 먼저 보고 앵커가 있는 유한 반복 정규식 하나(외부 입력 — 루트 CLAUDE.md ‘정규식’). */
export const PARAM_KINDS = Object.freeze({
  name: Object.freeze({ max: 80, re: /^[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$/, hint: '영숫자로 시작 · 영숫자와 @ . _ - · 80자까지' }),
  path: Object.freeze({ max: 200, re: /^\/[A-Za-z0-9._/-]{0,199}$/, hint: '/ 로 시작 · 영숫자와 . _ - / · 200자까지 · .. · . · 빈 조각 없음' }),
});

/** 작은따옴표로 감싼다 — 값 검사가 이미 따옴표를 막았지만 한 겹 더(들어 있으면 던진다 · 명령을 만들지 않는다). */
function q(v) {
  const s = String(v);
  if (/['\\\n\r\0]/.test(s)) throw new Error('quote-in-value');
  return `'${s}'`;
}
/** PowerShell 작은따옴표 글자열(작은따옴표는 두 번 — 값 검사가 이미 막았다). */
function psq(v) {
  const s = String(v);
  if (/[\n\r\0`]/.test(s)) throw new Error('bad-ps-value');
  return `'${s.replace(/'/g, "''")}'`;
}

const W = (body, timeoutS = 10, table = true) => Object.freeze({ ps: body, timeoutS, table });
const L = (steps, timeoutS = 10) => Object.freeze({ steps, timeoutS });
const CIM_T = 8;   // CIM 조회 시한(초) — 스크립트 시한(10초) 안

/**
 * 프리셋(22개 — Linux 22 · Windows 16). linux.steps / windows.ps 는 **검사를 마친 값**을 받는 함수.
 * 문장은 첫 프로그램 앞에 timeout 이 붙는다(파이프 뒤는 거르는 프로그램 — sort · head 만 · 시험).
 */
const LIST = [
  // ── 시스템
  { id: 'uptime', group: '시스템', label: '가동 시간 · 부하', linux: L(() => ['uptime']),
    windows: W(() => `Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec ${CIM_T} | Select-Object CSName, LastBootUpTime, LocalDateTime`) },
  { id: 'time-sync', group: '시스템', label: '시각 · 시간 동기', linux: L(() => ['timedatectl', 'chronyc tracking'], 5),
    windows: W(() => 'w32tm /query /status', 10, false), note: 'Windows 는 권한이 필요할 수 있음' },
  { id: 'memory', group: '시스템', label: '메모리 사용', linux: L(() => ['free -m']),
    windows: W(() => `Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec ${CIM_T} | Select-Object TotalVisibleMemorySize, FreePhysicalMemory, TotalVirtualMemorySize, FreeVirtualMemory`) },
  // ── 디스크
  { id: 'df', group: '디스크', label: '파일시스템 사용량', linux: L(() => ['df -hP']),
    windows: W(() => 'Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, HealthStatus, Size, SizeRemaining'), note: '멈춘 NFS 가 있으면 시한에 걸림(받은 만큼 보임)' },
  { id: 'df-inode', group: '디스크', label: 'inode 사용량', linux: L(() => ['df -iP']) },
  { id: 'net-mounts', group: '디스크', label: '네트워크 마운트', linux: L(() => ['findmnt -t nfs,nfs4,cifs']), note: 'NFS · CIFS 만(smb3 · ceph · fuse 는 빠짐) · 없으면 빈 출력' },   // 점검 2회차(낮음): util-linux 2.39 는 없어도 끝 코드 0
  { id: 'du-top', group: '디스크', label: '폴더 사용량', params: [{ name: 'path', kind: 'path', label: '폴더 경로' }],
    linux: L((p) => [`du -xh --max-depth=1 -- ${q(p.path)} 2>/dev/null | sort -rh | head -20`], 20), note: '계정이 읽을 수 없는 하위 폴더는 실제보다 작게(4.0K 등) 보이고 합계도 작아짐 — 그때 끝 코드 1 · 큰 순 20개' },   // 점검 2회차 F2(재현): ‘빠짐’ 은 반대 안내였다
  { id: 'ls', group: '디스크', label: '디렉터리 목록', params: [{ name: 'path', kind: 'path', label: '폴더 경로' }],
    linux: L((p) => [`ls -la -- ${q(p.path)}`]), note: '이름 · 크기 · 시각만 — 파일 내용은 읽지 않음 · 길면 출력 상한에서 잘림' },
  // ── 프로세스(이름만 — 인자 · 환경을 싣지 않는다: 인자에 비밀번호가 실린 경우가 있다 · server/CLAUDE.md 8b ‘comm 만’)
  // 점검 2회차 F1(재현): ps 의 %CPU 는 프로세스가 뜬 뒤의 평균 · Windows CPU 칸은 누적 CPU 초 — 지금 순간 값이 아니다(이름 · 메모가 그렇게 말한다).
  { id: 'ps-cpu', group: '프로세스', label: 'CPU 상위 프로세스(누적 평균)', linux: L(() => ['ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu | head -16']),
    windows: W(() => 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, WorkingSet64'), note: '뜬 뒤 평균(Linux %CPU) · 누적 CPU 초(Windows) 순 — 지금 순간 사용률이 아님(오래 돈 프로세스가 지금 바빠도 아래에 있을 수 있음) · 이름만 — 인자는 싣지 않음' },
  { id: 'ps-mem', group: '프로세스', label: '메모리 상위 프로세스', linux: L(() => ['ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pmem | head -16']),
    windows: W(() => 'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id, CPU, WorkingSet64'), note: '이름만 — 인자는 싣지 않음' },
  { id: 'pgrep', group: '프로세스', label: '프로세스 찾기', params: [{ name: 'name', kind: 'name', label: '프로세스 이름' }],
    linux: L((p) => [`pgrep -l -- ${q(p.name)}`]), windows: W((p) => `Get-Process -Name ${psq(p.name)} | Select-Object Name, Id, CPU`), note: '없으면 끝 코드 1(실패가 아님) · Linux 는 이름의 일부로 찾음(정규식 — 프로세스 이름은 15자까지만 보임)' },
  // ── 네트워크(이 서버 자신의 설정만 — 다른 주소로 가는 탐침은 넣지 않는다 · D4)
  { id: 'ip-addr', group: '네트워크', label: 'IP 주소', linux: L(() => ['ip -br addr']),
    windows: W(() => 'Get-NetIPAddress | Select-Object InterfaceAlias, IPAddress, PrefixLength') },
  { id: 'ip-route', group: '네트워크', label: '라우팅 표', linux: L(() => ['ip route']),
    windows: W(() => 'Get-NetRoute -AddressFamily IPv4 | Select-Object DestinationPrefix, NextHop, InterfaceAlias, RouteMetric') },
  { id: 'listen', group: '네트워크', label: '리슨 포트', linux: L(() => ['ss -tlnp']),
    windows: W(() => 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess'), note: 'Linux 의 프로세스 이름은 그 계정 것만 보임' },
  { id: 'dns', group: '네트워크', label: 'DNS 설정', linux: L(() => ['cat /etc/resolv.conf']),
    windows: W(() => 'Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses'), note: '정해진 파일 하나(값으로 받는 경로가 아님)' },
  // ── 서비스 · 로그(status 는 프로세스 인자까지 보여 줘서 show 로)
  { id: 'svc-failed', group: '서비스 · 로그', label: '실패한 서비스', linux: L(() => ['systemctl --failed --no-pager']),
    windows: W(() => `Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" -OperationTimeoutSec ${CIM_T} | Select-Object Name, State, ExitCode`), note: 'Windows 는 ‘자동 시작인데 멈춘 서비스’' },
  { id: 'svc-state', group: '서비스 · 로그', label: '서비스 상태', params: [{ name: 'unit', kind: 'name', label: '서비스 이름' }],
    linux: L((p) => [`systemctl show --no-pager -p Id,LoadState,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,MainPID,NRestarts,Result -- ${q(p.unit)}`]),
    windows: W((p) => `Get-Service -Name ${psq(p.unit)} | Select-Object Name, Status, StartType`) },
  { id: 'svc-log', group: '서비스 · 로그', label: '서비스 로그', params: [{ name: 'unit', kind: 'name', label: '서비스 이름' }],
    linux: L((p) => [`journalctl --no-pager -n 100 -u ${q(p.unit)}`], 20), note: '로그 읽기 권한이 없으면 비어 있음 · 로그에 찍힌 내용(명령 인자 · 잘못 친 비밀번호 등)은 그대로 보임(D5)' },
  { id: 'log-warn', group: '서비스 · 로그', label: '최근 경고 · 오류', linux: L(() => ['journalctl --no-pager -p warning -n 50'], 20),
    windows: W(() => "Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2,3} -MaxEvents 50 | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName", 20), note: '권한이 필요할 수 있음 · 로그에 찍힌 내용(sudo 실패의 명령 인자 등)은 그대로 보임(D5)' },
  // ── 접속
  { id: 'who', group: '접속', label: '접속 세션', linux: L(() => ['who']), windows: W(() => 'quser', 10, false), note: 'Windows 는 접속한 사람이 없으면 오류 문구가 나올 수 있음' },
  { id: 'last-reboot', group: '접속', label: '최근 재부팅', linux: L(() => ['last -x reboot -n 5']),
    windows: W(() => "Get-WinEvent -FilterHashtable @{LogName='System'; Id=6005,6006,1074} -MaxEvents 10 | Select-Object TimeCreated, Id, ProviderName") },
  { id: 'last-login', group: '접속', label: '최근 로그인', linux: L(() => ['last -n 20']), note: '계정 이름 · 접속한 주소가 보임' },
];
export const PRESETS = Object.freeze(LIST.map((p) => Object.freeze({ ...p, params: Object.freeze((p.params || []).map((x) => Object.freeze({ ...x }))) })));
const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
export const presetById = (id) => (typeof id === 'string' && BY_ID.has(id) ? BY_ID.get(id) : null);

/** 값 하나 검사 — 길이 먼저 · 종류 정규식 · 경로는 `..` 조각 없음. */
export function checkParam(kind, v) {
  const k = PARAM_KINDS[kind];
  if (!k) return { ok: false, reason: '모르는 값 종류입니다.' };
  if (typeof v !== 'string' || !v) return { ok: false, reason: `값을 넣으세요(${k.hint}).` };
  if (v.length > k.max) return { ok: false, reason: `${k.max}자까지입니다.` };
  if (!k.re.test(v)) return { ok: false, reason: `쓸 수 없는 글자가 있습니다(${k.hint}).` };
  if (kind === 'path' && v.split('/').some((seg) => seg === '..')) return { ok: false, reason: '경로에 .. 조각을 쓸 수 없습니다.' };
  // 점검 1회차 U2: `//net` · `/./net` 은 커널이 `/net` 으로 풀어 아래 거절을 비켜 갔다(재현) — 빈 조각(`//`) · `.` 조각을 거절해 글자 그대로가 곧 경로가 되게 한다.
  if (kind === 'path' && (v.includes('//') || v.split('/').some((seg) => seg === '.'))) return { ok: false, reason: '경로에 빈 조각(//) · . 조각을 쓸 수 없습니다.' };
  // autofs ‘-hosts’ 지도(/net/<주소>)는 경로를 보는 것만으로 대상 서버가 그 주소에 NFS 마운트를 건다(상태 변경 · 다른 주소로 가는 탐침 — D2 · D4 · 반증 F8).
  //   다른 자동 마운트 자리(서버마다 다른 지도)는 알 수 없다 — 문서의 한계.
  if (kind === 'path' && (v === '/net' || v.startsWith('/net/'))) return { ok: false, reason: '자동 마운트 자리(/net)는 쓸 수 없습니다(보는 것만으로 마운트가 일어납니다).' };
  // 점검 2회차 D1(재현): `/proc/self/root/net/<주소>` · `/proc/<pid>/root/…` 는 커널이 `/` 로 풀어 위 거절을 비켜 갔다 — /proc 아래는 통째로 거절(볼 것도 없다 · 크기 · 목록이 뜻 없음).
  //   심링크가 /net 을 가리키는 경우는 글자로 알 수 없다(문서의 한계 — 다른 자동 마운트 자리와 같이).
  if (kind === 'path' && (v === '/proc' || v.startsWith('/proc/'))) return { ok: false, reason: '/proc 아래는 쓸 수 없습니다(/proc/self/root 로 다른 경로를 가리킬 수 있습니다).' };
  return { ok: true, value: v };
}

/**
 * 프리셋 + 값 → 검사한 값(모르는 값 이름 · 빠진 값은 거절 — 요청 본문의 다른 칸은 명령에 닿지 않는다).
 * @returns {{ok:true, preset:object, params:Record<string,string>} | {ok:false, code:string, reason:string}}
 */
export function checkRequest(presetId, params) {
  const p = presetById(presetId);
  if (!p) return { ok: false, code: 'bad-preset', reason: '모르는 프리셋입니다.' };
  const src = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const names = new Set(p.params.map((x) => x.name));
  for (const k of Object.keys(src)) if (!names.has(k)) return { ok: false, code: 'bad-param', reason: `이 프리셋은 ‘${String(k).slice(0, 32)}’ 값을 받지 않습니다.` };
  if (Object.getPrototypeOf(src) !== Object.prototype && Object.getPrototypeOf(src) !== null) return { ok: false, code: 'bad-param', reason: '값 모양이 틀렸습니다.' };   // 바뀐 프로토타입(반증 F1)
  const out = Object.create(null);
  for (const d of p.params) {
    const c = checkParam(d.kind, Object.hasOwn(src, d.name) ? src[d.name] : undefined);   // 자기 칸만(프로토타입에서 읽지 않는다 — 반증 F1)
    if (!c.ok) return { ok: false, code: 'bad-param', reason: `${d.label}: ${c.reason}` };
    out[d.name] = c.value;
  }
  return { ok: true, preset: p, params: out };
}

/** PowerShell 스크립트 → -EncodedCommand 값(UTF-16LE base64). */
export const psEncode = (script) => Buffer.from(script, 'utf16le').toString('base64');
const PS_ARGS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);

/**
 * 문장마다 끝 코드 표지(반증 F3 — 파이프의 끝 코드는 마지막 프로그램(head)의 것이라 앞 프로그램이 실패 · 시한에 잘려도 0 이었다).
 * 각 문장의 첫 프로그램(timeout 으로 감싼 것)이 끝나면 stderr 에 `\n#DVC-RC=<끝 코드>` 를 쓴다(앞 줄에 붙지 않게 줄바꿈 먼저 · printf — sh 마다 같은 동작).
 * 표지가 문장 수와 꼭 같을 때만 믿는다(`rcOf`) — 프로그램이 같은 글자를 흉내 내도 수가 어긋나면 ‘모름’.
 */
export const RC_MARK = '#DVC-RC=';
const RC_PRINT = `printf '\\n${RC_MARK}%s\\n' "$?" >&2`;
/** Linux 한 줄(문장마다 timeout · LC_ALL=C · 끝 코드 표지). 파이프 뒤는 거르는 프로그램(sort · head)만. */
export function linuxCommand(p, params) {
  const steps = p.linux.steps(params);
  return ['export LC_ALL=C', ...steps.map((s) => {
    const [first, ...pipe] = s.split(' | ');
    const body = `timeout ${p.linux.timeoutS} ${first}`;
    return pipe.length ? `{ ${body}; ${RC_PRINT}; } | ${pipe.join(' | ')}` : `${body}; ${RC_PRINT}`;
  })].join('; ');
}
/** 문장 수(끝 코드 표지 수). */
export const linuxStatements = (p, params) => p.linux.steps(params).length;
/**
 * stderr → 끝 코드 표지 · 표지를 뺀 stderr. 124 = timeout 이 끊음(시한) · 141 = 뒤의 head 가 먼저 닫음(SIGPIPE — 일부러 앞부분만 보는 것 · 실패가 아님).
 * @returns {{known:boolean, codes:number[], exit:number|null, timedOut:boolean, stderr:string}}
 */
export function rcOf(stderr, n) {
  const lines = String(stderr || '').split('\n');
  const codes = []; const rest = [];
  for (const l of lines) {
    const m = l.length <= 16 && l.startsWith(RC_MARK) ? /^#DVC-RC=(\d{1,3})$/.exec(l) : null;
    if (m) codes.push(Number(m[1])); else rest.push(l);
  }
  const text = rest.filter((l, i, a) => l !== '' || (i > 0 && i < a.length - 1 && a[i - 1] !== '')).join('\n').trim();
  if (codes.length !== n) return { known: false, codes, exit: null, timedOut: false, stderr: text };
  const norm = codes.map((c) => (c === 141 ? 0 : c));
  return { known: true, codes, exit: norm.find((c) => c !== 0) ?? 0, timedOut: codes.includes(124), stderr: text };
}
/** Windows 스크립트(사람이 보는 글 — 화면 미리 보기도 이것). */
export function windowsScript(p, params) {
  const body = p.windows.ps(params);
  const tail = p.windows.table ? ' | Format-Table -AutoSize | Out-String -Width 220' : ' | Out-String -Width 220';
  // 끝 코드(반증 F7): PowerShell CLI 의 끝 코드는 마지막 문장($?)의 0/1 이라 Out-String 뒤에는 늘 0 이었다 —
  //   바깥 프로그램의 $LASTEXITCODE → 이 스크립트에서 생긴 오류 수 → 0 순으로 직접 정한다. 출력은 UTF-8(SSH 경로 — WinRM 은 코드 페이지 65001). 실제 Windows 미확인(시험).
  return ["$ProgressPreference='SilentlyContinue'", "$ErrorActionPreference='Continue'", 'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }', '$e0 = $Error.Count',
    `${body}${tail}`, 'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($Error.Count -gt $e0) { exit 1 } else { exit 0 }'].join('\n');
}

/**
 * 검사한 값 → 코어(readServer)에 넘길 계획 — OS 마다 **완성된 문자열** 하나(코어는 글자를 이어 붙이지 않는다).
 * @returns {{linux?:{command,timeoutMs,maxBytes}, windows?:{command,timeoutMs,maxBytes,winrm:{command,args}}}}
 */
export function planOf(p, params) {
  const plan = {};
  if (p.linux) plan.linux = { command: linuxCommand(p, params), timeoutMs: (p.linux.timeoutS * p.linux.steps(params).length + LINUX_SLACK_S) * 1000, maxBytes: MAX_BYTES,
    // 점검 1회차 W3: 끝 코드 표지는 stderr 끝쪽에 온다 — 코어의 기본 2000자 자르기가 표지를 잘라 시한 · 끝 코드를 잃었다(재현: 경고 20줄 뒤 시한 → ‘실행됨’). 상한(MAX_BYTES)까지 받는다.
    stderrMax: MAX_BYTES };
  if (p.windows) {
    const b64 = psEncode(windowsScript(p, params));
    plan.windows = { command: `powershell ${PS_ARGS.join(' ')} ${b64}`, timeoutMs: (p.windows.timeoutS + WIN_SLACK_S) * 1000, maxBytes: MAX_BYTES, stderrMax: MAX_BYTES,
      winrm: { command: 'powershell', args: [...PS_ARGS, b64] } };
  }
  return plan;
}

/** 화면 미리 보기(실행될 글 그대로 — Windows 는 Base64 로 바꾸기 전 스크립트). */
export function previewOf(presetId, params) {
  const c = checkRequest(presetId, params);
  if (!c.ok) return c;
  const p = c.preset;
  return { ok: true, preset: p.id, linux: p.linux ? linuxCommand(p, c.params) : null, windows: p.windows ? windowsScript(p, c.params) : null };
}

/** 화면용 목록(함수 없음). */
export function catalog() {
  return PRESETS.map((p) => ({
    id: p.id, group: p.group, label: p.label, note: p.note || '',
    params: p.params.map((x) => ({ name: x.name, kind: x.kind, label: x.label, hint: PARAM_KINDS[x.kind].hint, max: PARAM_KINDS[x.kind].max })),
    os: [p.linux ? 'linux' : null, p.windows ? 'windows' : null].filter(Boolean),
    // 화면 표시: Linux 는 문장마다(timeout) · Windows 는 SSH exec 시한(스크립트 안에는 시한이 없다 — WinRM 은 서버 한 대 시한 · 서비스 limits.winrmS)
    timeoutS: { linux: p.linux ? p.linux.timeoutS : null, windows: p.windows ? p.windows.timeoutS + WIN_SLACK_S : null },
  }));
}

/**
 * 출력 다듬기(선형 · 정규식 없음): CR 버림 · ESC 순서(CSI · OSC · 두 글자) 버림 · 줄바꿈 · 탭 말고 제어문자 버림 · 줄 수 · 한 줄 글자 상한.
 * 화면은 글자로만 그린다(HTML 로 해석하지 않는다) — 여기는 터미널 제어 순서만 걷어 낸다.
 * @returns {{text:string, lines:number, cut:boolean}}
 */
const BIDI = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
export function cleanOutput(raw, { maxLines = MAX_LINES, maxLineChars = MAX_LINE_CHARS } = {}) {
  const s = typeof raw === 'string' ? raw.slice(0, MAX_BYTES * 2) : '';
  let out = ''; let line = 0; let lineLen = 0; let cut = s.length < (typeof raw === 'string' ? raw.length : 0);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const n = s.charCodeAt(i + 1);
      if (n === 0x0a || n === 0x0d || Number.isNaN(n)) continue;   // ESC 만 버린다(뒤 줄바꿈은 그대로 — 반증 F6)
      if (n === 0x5b) { let j = i + 2; while (j < s.length && j < i + 66 && s.charCodeAt(j) !== 0x0a && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j += 1; i = s.charCodeAt(j) === 0x0a ? j - 1 : j; continue; }   // CSI … 끝 글자
      if (n === 0x5d) {   // OSC … BEL 또는 ESC \ — 끝나지 않으면 줄바꿈에서 멈춘다(뒤 줄을 삼키지 않게 — F6)
        let j = i + 2;
        while (j < s.length && j < i + 260 && s.charCodeAt(j) !== 0x07 && s.charCodeAt(j) !== 0x0a && !(s.charCodeAt(j) === 0x1b && s.charCodeAt(j + 1) === 0x5c)) j += 1;
        i = s.charCodeAt(j) === 0x1b ? j + 1 : s.charCodeAt(j) === 0x0a ? j - 1 : j; continue;
      }
      // 두 글자 · 중간 글자(0x20~0x2F) + 끝 글자 꼴(ESC ( B 등 — F6)
      let j = i + 1;
      while (j < s.length && j < i + 5 && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j += 1;
      i = j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x7e ? j : j - 1; continue;
    }
    if (BIDI.has(c)) continue;   // 양방향 제어 글자(글자 순서를 뒤집어 보이게 한다 — F6)
    if (c === 0x0a) {
      line += 1;
      if (line >= maxLines) { if (i < s.length - 1) cut = true; break; }
      out += '\n'; lineLen = 0; continue;
    }
    if (c === 0x09) { if (lineLen < maxLineChars) { out += '\t'; lineLen += 1; } else cut = true; continue; }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue;
    if (lineLen >= maxLineChars) { cut = true; continue; }
    out += s[i]; lineLen += 1;
  }
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 0x0a) end -= 1;   // 끝 줄바꿈 걷기(정규식 /\n+$/ 은 줄바꿈 덩어리마다 되짚어 O(n²) — 루트 CLAUDE.md ‘정규식’)
  const text = out.slice(0, end);
  return { text, lines: text ? text.split('\n').length : 0, cut };
}
