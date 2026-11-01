/**
 * bareos/install/precheck.js — 완전 설치 사전 점검(v2.844 · **쓰기 없음**). 배포 등록부의 SSH 계정으로 엣지 노드에 붙어 명령 하나로 읽는다.
 *
 * 판정은 순수 함수(judgePrecheck)이고 화면의 표 한 줄 = 항목 하나다: status 'ok' | 'warn' | 'bad' | 'unknown'.
 *  - 'unknown' = 읽지 못함(0 이 아니다 — 루트 규칙 '못 읽은 값은 0 이 아니다'). 설치를 막지는 않는다.
 *  - 'bad' 가 하나라도 있으면 설치를 시작하지 않는다(라우트가 시작 직전에 다시 점검한다 — 화면 결과는 그 순간의 상태다).
 * 스크립트는 고정 문자열이다 — 사용자 입력은 볼륨 경로 하나뿐이고 plan.volumeDirIssue 를 지난 값만 넣는다.
 */
import { volumeDirIssue, REMOTE_ROOT, UNIT, DEFAULT_VOLUME_DIR } from './plan.js';
import { numOrNull } from '../../util/numOrNull.js';

const PORTS = [9101, 9102, 9103];
const WEB_PORT = 80;

/** 읽기 전용 스크립트(섹션 머리 '@@이름'). */
export function precheckScript(volumeDir = DEFAULT_VOLUME_DIR) {
  if (volumeDirIssue(volumeDir)) throw Object.assign(new Error('볼륨 경로가 허용 형식이 아닙니다'), { code: 'invalid' });
  return [
    'export LC_ALL=C',
    'echo @@id; id -u',
    'echo @@os; . /etc/os-release 2>/dev/null; echo "ID=$ID"; echo "VERSION_ID=$VERSION_ID"; echo "PRETTY=$PRETTY_NAME"; echo "ARCH=$(uname -m)"',
    'echo @@tools; for c in systemd-run dnf rpm ss python3 chronyc getenforce semanage bconsole psql; do command -v $c >/dev/null 2>&1 && echo "$c=1" || echo "$c=0"; done',
    'echo @@selinux; getenforce 2>/dev/null || echo unknown',
    "echo @@pkgs; rpm -qa --qf '%{NAME} %{VERSION}\\n' 2>/dev/null | grep -E '^(bareos|postgresql-server|python3-pyvmomi|httpd|nginx)( |-)' | sort",
    'echo @@etc; [ -d /etc/bareos ] && find /etc/bareos -type f 2>/dev/null | wc -l || echo none',
    'echo @@svc; for u in bareos-dir bareos-sd bareos-fd postgresql; do echo "$u=$(systemctl is-active $u 2>/dev/null || true)"; done',
    `echo @@ports; ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -E '[:.](${[...PORTS, WEB_PORT].join('|')})$' || true`,
    'echo @@python; python3 -c "import sys; print(\'%d.%d.%d\' % sys.version_info[:3])" 2>/dev/null || echo none',
    'echo @@pyvmomi; python3 -c "import importlib.metadata as m; print(m.version(\'pyvmomi\'))" 2>/dev/null || echo none',
    'echo @@bpp; for d in /usr/lib64/bareos/plugins /usr/lib/bareos/plugins; do ls -d $d/pyVmomi $d/pyvmomi-*.dist-info 2>/dev/null; done; true',
    // 볼륨 경로가 아직 없으면 있는 조상까지 올라가 df
    `echo @@disk; p=${volumeDir}; while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done; echo "PATH=$p"; df -Pk "$p" 2>/dev/null | awk 'NR==2{print "AVAIL_KB="$4; print "SIZE_KB="$2; print "MOUNT="$6}'; [ -e ${volumeDir} ] && echo EXISTS=1 || echo EXISTS=0`,
    "echo @@varlib; df -Pk /var/lib 2>/dev/null | awk 'NR==2{print $4}'",
    "echo @@clock; chronyc tracking 2>/dev/null | awk -F': *' '/^System time/{print $2}' | head -1",
    "echo @@addr; ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p' | head -1; hostname -f 2>/dev/null || hostname",
    `echo @@runner; systemctl is-active ${UNIT} 2>/dev/null || true; tail -n 3 ${REMOTE_ROOT}/run/state 2>/dev/null || true`,
    // 초기화용(설치돼 있을 때만 의미): 실행 중 작업 · 카탈로그 DB 크기 · SD 볼륨 경로별 파일 수·크기·마지막 수정
    // 반증 L2: bconsole 이 실패해도 grep -c 가 0 을 내 '실행 중 0개 ✓' 가 됐다 — 접속이 확인될 때만 센다(못 읽으면 none = 확인 불가)
    "echo @@running; if systemctl is-active -q bareos-dir 2>/dev/null && command -v bconsole >/dev/null; then o=$(printf 'llist jobs jobstatus=R\\n' | timeout 30 bconsole 2>&1); rc=$?; if [ $rc -eq 0 ] && printf '%s\\n' \"$o\" | grep -q 'Connecting to Director' && ! printf '%s\\n' \"$o\" | grep -qiE 'Authorization failed|Failed to connect|ERR='; then printf '%s\\n' \"$o\" | grep -cE '^[[:space:]]*jobid:[[:space:]]*[0-9]+'; else echo none; fi; else echo none; fi",
    "echo @@catalog; if systemctl is-active -q postgresql 2>/dev/null; then su - postgres -c \"psql -tAc \\\"SELECT pg_database_size('bareos')\\\"\" 2>/dev/null | tr -d '[:space:]'; echo; else echo none; fi",
    "echo @@volumes; for f in /etc/bareos/bareos-sd.d/device/*.conf; do [ -f \"$f\" ] || continue; sed -n 's/^[[:space:]]*Archive[[:space:]]*Device[[:space:]]*=[[:space:]]*\"\\{0,1\\}\\([^\"]*\\)\"\\{0,1\\}[[:space:]]*$/\\1/Ip' \"$f\"; done | sort -u | while read -r d; do [ -d \"$d\" ] || { echo \"$d|missing\"; continue; }; n=$(find \"$d\" -maxdepth 1 -type f 2>/dev/null | wc -l); s=$(du -sk \"$d\" 2>/dev/null | cut -f1); t=$(find \"$d\" -maxdepth 1 -type f -printf '%T@\\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1); echo \"$d|$n|$s|$t\"; done",
    'echo @@end',
  ].join('\n');
}

/** 섹션 나누기. */
export function sectionsOf(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^@@([a-z]+)$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line.replace(/\r$/, ''));
  }
  return out;
}
const kv = (lines = []) => Object.fromEntries(lines.map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean));
const first = (lines = []) => (lines.find((l) => l.trim() !== '') || '').trim();

/**
 * 출력 → 사실(facts). 못 읽은 값은 null.
 */
export function parsePrecheck(text) {
  const s = sectionsOf(text);
  const os = kv(s.os); const tools = kv(s.tools); const disk = kv(s.disk);
  const pkgs = (s.pkgs || []).map((l) => l.trim().split(/\s+/)).filter((x) => x[0]).map(([name, version]) => ({ name, version: version || '' }));
  const etc = first(s.etc);
  const svc = kv(s.svc);
  const ports = (s.ports || []).map((l) => Number(/[:.](\d+)$/.exec(l.trim())?.[1])).filter((n) => PORTS.includes(n) || n === WEB_PORT);
  const py = first(s.python);
  const pyv = first(s.pyvmomi);
  const bpp = (s.bpp || []).map((l) => l.trim()).filter(Boolean).slice(0, 10);
  const clock = first(s.clock);
  const clockSec = /^([\d.]+) seconds (fast|slow)/.exec(clock);
  const addrLines = (s.addr || []).map((l) => l.trim()).filter(Boolean);
  const runnerLines = (s.runner || []).map((l) => l.trim()).filter(Boolean);
  const running = first(s.running);
  const catalog = first(s.catalog);
  const volumes = (s.volumes || []).map((l) => l.trim()).filter(Boolean).slice(0, 20).map((l) => {
    const [path, n, kb, t] = l.split('|');
    if (n === 'missing') return { path, missing: true };
    return { path, files: numOrNull(n), bytes: numOrNull(kb) == null ? null : numOrNull(kb) * 1024, lastAt: numOrNull(t) == null ? null : numOrNull(t) * 1000 };
  });
  return {
    complete: Object.prototype.hasOwnProperty.call(s, 'end'),
    uid: numOrNull(first(s.id)),
    os: { id: os.ID || '', versionId: os.VERSION_ID || '', pretty: os.PRETTY || '', arch: os.ARCH || '' },
    tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v === '1'])),
    selinux: first(s.selinux) || null,
    pkgs,
    etcFiles: etc === 'none' || etc === '' ? null : numOrNull(etc),
    services: svc,
    portsInUse: [...new Set(ports)],
    python: /^\d+\.\d+\.\d+$/.test(py) ? py : null,
    pyvmomi: pyv && pyv !== 'none' ? pyv : null,
    pluginPathCopies: bpp,
    disk: { path: disk.PATH || '', availKb: numOrNull(disk.AVAIL_KB), sizeKb: numOrNull(disk.SIZE_KB), mount: disk.MOUNT || '', exists: disk.EXISTS === '1' },
    varLibAvailKb: numOrNull(first(s.varlib)),
    clockOffsetSec: clockSec ? Number(clockSec[1]) : null,
    hostAddr: /^\d{1,3}(\.\d{1,3}){3}$/.test(addrLines[0] || '') ? addrLines[0] : null,
    hostname: addrLines.find((x) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(x)) || null,
    runnerActive: runnerLines[0] === 'active' || runnerLines[0] === 'activating',
    runnerState: runnerLines.slice(1),
    runningJobs: running === 'none' || running === '' ? null : numOrNull(running),
    catalogBytes: catalog === 'none' || catalog === '' ? null : numOrNull(catalog),
    volumes,
  };
}

const GB = 1024 * 1024;
const MIN_VARLIB_KB = 3 * GB;   // 번들(전송본 + 풀어 둔 것) + 설치 여유

/**
 * 사실 → 표(순수). mode 'install' | 'reinstall'. bundle = 번들 내용 목록(없으면 null).
 * @returns {{ items: {key,label,status,detail,action}[], counts, blocked: boolean, hostAddr, installed: boolean }}
 */
export function judgePrecheck(f, { mode = 'install', bundle = null, plan = null } = {}) {
  const items = [];
  const add = (key, label, status, detail, action = '') => items.push({ key, label, status, detail, action });
  const bareosPkgs = f.pkgs.filter((p) => p.name.startsWith('bareos'));
  const installed = bareosPkgs.length > 0 || f.etcFiles != null;
  if (!f.complete) add('read', '점검 출력', 'unknown', '점검 출력이 끝까지 오지 않았습니다(중간에 끊김).', '다시 점검하세요.');
  add('root', 'SSH root', f.uid === 0 ? 'ok' : (f.uid == null ? 'unknown' : 'bad'), f.uid === 0 ? '저장된 계정이 root 입니다(sudo 경로는 쓰지 않습니다).' : `uid ${f.uid ?? '읽지 못함'} — root 계정이어야 합니다.`,
    f.uid === 0 ? '' : '배포 등록부의 이 엣지 SSH 계정을 root 로 바꾸세요.');
  const osOk = /^(rocky|rhel|almalinux|centos|ol)$/.test(f.os.id) && /^9(\.|$)/.test(f.os.versionId) && f.os.arch === 'x86_64';
  add('os', 'OS', osOk ? 'ok' : (f.os.id ? 'bad' : 'unknown'), `${f.os.pretty || '읽지 못함'} · ${f.os.arch || '?'}${f.selinux ? ` · SELinux ${f.selinux}` : ''}`, osOk ? '' : '이 번들은 Rocky/RHEL 9 x86_64 용입니다.');
  const toolMiss = ['systemd-run', 'dnf', 'rpm', 'ss'].filter((t) => f.tools[t] === false);
  add('tools', '필수 명령', toolMiss.length ? 'bad' : (Object.keys(f.tools).length ? 'ok' : 'unknown'), toolMiss.length ? `없음: ${toolMiss.join(', ')}` : 'systemd-run · dnf · rpm · ss 있음', toolMiss.length ? 'OS 기본 패키지를 먼저 설치하세요.' : '');
  if (mode === 'install') {
    add('bareos', '이미 설치된 Bareos', installed ? 'bad' : 'ok', installed ? `${bareosPkgs.map((p) => `${p.name} ${p.version}`).slice(0, 6).join(' · ') || '패키지 없음'}${f.etcFiles != null ? ` · /etc/bareos 파일 ${f.etcFiles}개` : ''}` : 'bareos 패키지 · /etc/bareos 없음',
      installed ? '기존 설치를 덮어쓰지 않습니다 — 대상 표에서 ‘초기화 후 재설치’ 를 고르세요.' : '');
  } else {
    add('bareos', '지울 기존 Bareos', installed ? 'warn' : 'ok', installed ? `${bareosPkgs.length}개 패키지 · /etc/bareos 파일 ${f.etcFiles ?? 0}개 — 지우기 전에 /etc/bareos 를 엣지 안에 tar 로 보관합니다` : '설치된 Bareos 가 없습니다(초기화할 것 없음)', '');
    add('running', '실행 중 작업', f.runningJobs == null ? 'unknown' : (f.runningJobs > 0 ? 'bad' : 'ok'), f.runningJobs == null ? 'Director 에 묻지 못했습니다(꺼져 있거나 bconsole 없음) — 0 이 아닙니다' : `${f.runningJobs}개`,
      f.runningJobs > 0 ? '실행 중 작업이 끝난 뒤 다시 점검하세요.' : '');
  }
  const foreignPorts = installed ? [] : f.portsInUse.filter((p) => PORTS.includes(p));
  add('ports', '포트 9101 · 9102 · 9103', foreignPorts.length ? 'bad' : 'ok', foreignPorts.length ? `다른 프로그램이 사용 중: ${foreignPorts.join(', ')}` : '비어 있음(같은 서버 안에서만 통신 — 방화벽은 바꾸지 않습니다)', foreignPorts.length ? '그 포트를 쓰는 프로그램을 확인하세요(ss -ltnp).' : '');
  const web = f.portsInUse.includes(WEB_PORT);
  const hasHttpd = f.pkgs.some((p) => p.name === 'httpd');
  const nginx = f.pkgs.some((p) => p.name === 'nginx');
  if (plan?.webui !== false) {
    add('web', 'WebUI 웹 포트 80', web && !hasHttpd ? 'bad' : (hasHttpd ? 'warn' : 'ok'),
      web && !hasHttpd ? `80 포트를 httpd 가 아닌 프로그램이 씁니다${nginx ? '(nginx 설치됨)' : ''}` : (hasHttpd ? '이미 httpd 가 있습니다 — bareos-webui 설정(conf.d)이 더해지고 httpd 를 다시 읽힙니다' : '비어 있음 — httpd 를 켜고 firewalld 에 http 를 엽니다(켜져 있을 때)'),
      web && !hasHttpd ? '80 포트를 쓰는 프로그램을 확인하거나 계획에서 WebUI 를 끄세요.' : '');
  }
  const pyMajor = f.python ? f.python.split('.').map(Number) : null;
  add('python', 'Python', f.python ? 'ok' : 'warn', f.python ? `${f.python}${pyMajor && pyMajor[1] < 10 ? ' — pyVmomi 9.x 는 Python 3.10 이상이 필요해 8.x 를 씁니다' : ''}` : 'python3 없음 — 번들에서 함께 설치합니다', '');
  const pv = f.pyvmomi;
  const nine = pv && /^9\./.test(pv);
  add('pyvmomi', 'pyVmomi', nine ? 'warn' : 'ok', pv ? `서버 판 ${pv}${nine ? ' — 9.x 는 이 Python 에서 플러그인이 시작하지 못합니다. 계획에서 고른 8.x 로 바꿉니다' : ''}` : '없음 — 계획에서 고른 8.x 를 설치합니다',
    nine ? '계획의 pyVmomi 판(권고 8)을 확인하세요.' : '');
  if (f.pluginPathCopies.length) add('bpp', '플러그인 경로의 pyVmomi 사본', 'warn', f.pluginPathCopies.join(' · '), '두 곳에 다른 판이 있으면 플러그인 경로 쪽이 먼저 불립니다 — 계획에서 ‘옮기기’ 를 켜면 설치 때 옆으로 옮깁니다(지우지 않음).');
  const avail = f.disk.availKb;
  const capGb = plan?.pools ? plan.pools.maxVolumeGB * 2 : null;
  const diskStatus = avail == null ? 'unknown' : (capGb != null && avail / GB < capGb ? 'warn' : 'ok');
  add('disk', `볼륨 경로 여유(${plan?.volumeDir || DEFAULT_VOLUME_DIR})`, diskStatus,
    avail == null ? '여유를 읽지 못했습니다' : `${f.disk.exists ? '경로 있음' : `경로 없음(설치 때 만듦) · 기준 ${f.disk.path}`} · 여유 ${(avail / GB).toFixed(1)} GB / 전체 ${f.disk.sizeKb == null ? '—' : (f.disk.sizeKb / GB).toFixed(1)} GB · 마운트 ${f.disk.mount || '—'}`,
    diskStatus === 'warn' ? '여유가 볼륨 2개 크기보다 작습니다 — 볼륨 크기를 줄이거나 디스크를 넓히세요.' : '');
  const vl = f.varLibAvailKb;
  add('varlib', '/var/lib 여유(번들)', vl == null ? 'unknown' : (vl < MIN_VARLIB_KB ? 'bad' : 'ok'), vl == null ? '읽지 못했습니다' : `${(vl / GB).toFixed(1)} GB(번들 전송본·풀기에 약 3 GB 필요)`, vl != null && vl < MIN_VARLIB_KB ? '/var/lib 여유를 3 GB 이상 확보하세요.' : '');
  add('clock', '시계(NTP) 차이', f.clockOffsetSec == null ? 'unknown' : (f.clockOffsetSec > 5 ? 'warn' : 'ok'),
    f.clockOffsetSec == null ? 'chronyc 로 읽지 못했습니다 — 값 없음(0 이 아닙니다)' : `${f.clockOffsetSec.toFixed(3)}초`, f.clockOffsetSec == null || f.clockOffsetSec > 5 ? '설치는 막지 않습니다. 설치 뒤 서버 시각을 확인하세요(스케줄·보존 계산).' : '');
  add('addr', 'Director 주소(이 서버)', f.hostAddr ? 'ok' : 'bad', f.hostAddr ? `${f.hostAddr}${f.hostname ? ` · ${f.hostname}` : ''} — 엣지 포탈이 이 주소로 Director 에 붙습니다` : '서버의 IPv4 주소를 읽지 못했습니다', f.hostAddr ? '' : '기본 경로(ip route)가 있는지 확인하세요.');
  if (f.runnerActive) add('runner', '진행 중인 설치', 'bad', '이 서버에서 완전 설치 러너가 돌고 있습니다.', '끝난 뒤 다시 점검하세요.');
  if (bundle) add('bundle', '오프라인 번들', 'ok', `Bareos ${bundle.bareosVersion || '?'} · PostgreSQL ${bundle.postgresqlVersion || '?'} · pyVmomi ${bundle.pyvmomi.versions.join(' · ')}${bundle.vddk.length ? ` · VDDK ${bundle.vddk.join(' · ')}` : ''}`, '');
  else add('bundle', '오프라인 번들', 'bad', '받아 둔 번들이 없습니다.', '번들 카드에서 ‘번들 받기’ 를 누르세요.');
  const counts = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const i of items) counts[i.status] += 1;
  return { items, counts, blocked: counts.bad > 0, hostAddr: f.hostAddr, installed, volumes: f.volumes, catalogBytes: f.catalogBytes, pyvmomi: f.pyvmomi, pluginPathCopies: f.pluginPathCopies };
}
