/**
 * bmusage/parse/linuxFacts.js — 리눅스 성능 4단계(v2.923 예정)의 **용도 감지 · 튜닝 사실** 구획 파서(순수).
 *
 * 설계 `docs/design/linux-bm-perf/PROFILES.md` §1(감지 구획 ##OSREL · ##UNITS · ##PORTS · ##PROCS) · `TUNING-SOURCES.md` 구현 메모
 * (`tuned-adm active` · `/proc/net/softnet_stat` · NIC 큐). 같은 SSH 1회 명령(`collectors/osSsh.js linuxCommand`)의 구획을 쪼갠 것을 받는다.
 *
 * ⚠⚠ **읽기 전용 · 인자 없음 · sudo 없음** — 명령은 전부 상수이고(`linuxCommand` 가 이 모듈의 상수로 조립한다), 프로세스는 **이름(comm)만**
 *   읽는다(`ps -o args` · `/proc/<pid>/cmdline` 금지 — 인자에 비밀번호·토큰이 실린 프로세스가 흔하다). 계정 감지는 **고정 이름 목록**
 *   (`DETECT_ACCOUNTS`)의 존재만 본다(`getent passwd` 의 첫 칸 — 홈·셸은 버린다).
 * ⚠ 장비 출력은 줄 길이 · 줄 수를 먼저 자르고(splitSections · 명령의 head/cut) 정규식은 앵커 + 길이 상한으로만 쓴다(루트 CLAUDE.md ‘정규식’).
 * ⚠ 값이 없으면 null — 0 이나 기본값을 지어내지 않는다(‘확인 불가’ 는 판정 모듈이 따로 센다).
 */

/** 감지용 계정 이름(고정 목록 — 명령에 그대로 들어간다). 프로파일의 계정 규칙은 이 목록 안의 이름만 쓸 수 있다(테스트가 대조). */
export const DETECT_ACCOUNTS = Object.freeze(['gpadmin', 'airflow']);
/** 커널 부팅 인자 중 읽는 키(화이트리스트 — 나머지 인자는 명령 단계에서 버린다: root= · rd.* 같은 경로·장치 정보를 싣지 않는다). */
export const KARG_KEYS = Object.freeze(['isolcpus', 'nohz_full', 'rcu_nocbs', 'default_hugepagesz', 'hugepagesz', 'hugepages', 'transparent_hugepage', 'numa_balancing', 'psi']);

/** 구획별 줄 상한(명령의 head -n 과 같은 값 — 상한+1 줄이 오면 ‘상한 도달’). */
export const FACT_LINE_CAP = Object.freeze({ OSREL: 8, UNITS: 256, PORTS: 512, PROCS: 512, ACCT: 16, KARGS: 16, SOFTNET: 1_025, NETQ: 64, XFS: 32 });
/** 줄 최대 바이트(가정 — cut 폭 + 개행). osSsh 의 SECTION_BYTES_SUM 산수에 더한다. */
export const FACT_LINE_BYTES = Object.freeze({ OSREL: 129, UNITS: 99, PORTS: 65, PROCS: 35, ACCT: 33, KARGS: 201, SOFTNET: 41, NETQ: 129, XFS: 301 });
/** 구획 순서(linuxCommand 가 이 순서로 붙이고 splitSections 가 이 순서로만 받는다 — osSsh LINUX_SECTIONS). */
export const FACT_SECTIONS = Object.freeze(['OSREL', 'UNITS', 'PORTS', 'PROCS', 'ACCT', 'KARGS', 'SOFTNET', 'NETQ', 'XFS']);
/**
 * v2.923(반증 R1) — **줄 머리에 비특권 입력이 오는 구획은 고정 접두를 붙인다**(파서가 벗긴다). 전수 점검 결과(줄 머리를 누가 정하나):
 *   PROCS = 프로세스 이름(comm — **아무 사용자나** 정한다 · setproctitle 포함) → `p:` 필수. UNITS = 유닛 이름(root · ‘#’ 은 유닛 이름에 쓸 수 없다) → R7 형식 변경과 함께 `u:`.
 *   PORTS(ss 의 숫자 주소) · ACCT(고정 이름 목록 · getent -s files) · KARGS(앵커 grep 키=) · SOFTNET(16진 수) · OSREL(앵커 grep · 고정 접두) · NETQ(인터페이스 이름 — root 만 만든다) ·
 *   XFS(마운트 지점 — ‘/’ 로 시작) 는 줄 머리를 비특권 사용자가 정할 수 없다. 기존 구획(NETINFO · FC · DF · HOST)도 root · 커널이 정한다.
 *   그래도 파서는 순서 · 정확 일치 · 재개방 금지로 표지를 받는다(splitSections) — 접두는 그 위의 둘째 겹.
 */
export const FACT_PREFIX = Object.freeze({ PROCS: 'p:', UNITS: 'u:' });

const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const clip = (s, n) => String(s ?? '').slice(0, n);

/**
 * 셸 조각(상수) — `linuxCommand` 가 이 순서로 붙인다. ⚠ 여기에 변수·외부 입력을 넣지 말 것(테스트가 `${` 와 sudo 를 소스 스윕한다).
 *  · OSREL: os-release 의 ID · VERSION_ID · PRETTY_NAME 세 줄 + PAGE_SIZE + getenforce + logind 의 RemoveIPC 명시 설정(없으면 줄 없음 = 명시 설정 없음).
 *  · UNITS: running 서비스 유닛 이름(첫 칸) + 실패 유닛 수. `--plain` 은 앞의 ● 표지를 뺀다.
 *  · PORTS: 수신(LISTEN) TCP 소켓의 로컬 주소:포트(머리글 1줄을 awk 로 뺀다 — `-H` 가 없는 옛 ss 에서도 같다). 프로세스(-p)는 읽지 않는다.
 *  · PROCS: 프로세스 이름(comm) 중복 제거(커널 스레드 제외) — 인자 없음.
 *  · ACCT: 고정 계정 이름의 존재(getent 첫 칸만).
 *  · KARGS: /proc/cmdline 의 화이트리스트 키만.
 *  · SOFTNET: /proc/net/softnet_stat 앞 세 열(16진 — CPU 마다 한 줄).
 *  · NETQ: 물리 NIC(device 링크가 있는 것) — 이름|tx_queue_len|rx 큐 수|tx 큐 수(큐 수는 셸 글롭으로 센다 — 프로세스를 띄우지 않는다).
 *  · XFS: /proc/mounts 의 xfs 마운트 지점과 옵션.
 */
export const FACT_SHELL = Object.freeze({
  OSREL: [
    "grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release 2>/dev/null | head -n 3 | cut -c1-128",
    'echo "pagesize=`getconf PAGE_SIZE 2>/dev/null`"',
    'echo "selinux=`getenforce 2>/dev/null`"',
    "grep -h -E '^[[:space:]]*RemoveIPC[[:space:]]*=' /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf 2>/dev/null | tail -n 1 | sed 's/^/removeipc:/' | cut -c1-64",
  ].join('; '),
  /*
   * systemctl 이 없으면(systemd 없는 서버) 아무것도 내지 않는다 — 구획은 왔는데 0줄(absent).
   * ⚠⚠ v2.923(반증 R7): systemctl 이 **있지만 실패**하면(버스 오류 · PID 1 이 systemd 아님 · 바쁜 systemd 시한) 예전 `| wc -l` 은 그래도 0 을 내 ‘실패 유닛 0’ ·
   *   빈 running 목록을 지어냈다(이 개발 컨테이너 재현 — systemctl 있음 · rc=1 ‘Failed to connect to bus’). 이제 두 호출 모두 **종료 코드를 보고** 성공했을 때만 값을 내고
   *   (`running=ok` · `failed=<수>`), 실패면 `running=rc<코드>` · `failed=rc<코드>` 만 낸다 → 파서가 그 칸을 null(확인 불가)로. 줄 수는 wc 가 아니라 grep -c 로(빈 출력 = 0 줄).
   *   (반증 R8) `timeout 3` — D-Bus 기본 시한(25초)까지 기다리면 주기 명령 전체가 시한 하나라 전 구획을 잃는다. `timeout` 이 없으면 rc 127 → 확인 불가.
   */
  UNITS: [
    'if command -v systemctl >/dev/null 2>&1; then',
    'l=$(timeout 3 systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null); r=$?;',
    `if [ "$r" -eq 0 ]; then printf '%s\\n' "$l" | awk 'NF{print "u:" $1}' | head -n ${FACT_LINE_CAP.UNITS + 1} | cut -c1-98; echo 'running=ok'; else echo "running=rc$r"; fi;`,
    'l=$(timeout 3 systemctl list-units --state=failed --no-legend --plain 2>/dev/null); r=$?;',
    `if [ "$r" -eq 0 ]; then echo "failed=$(printf '%s\\n' "$l" | grep -c .)"; else echo "failed=rc$r"; fi;`,
    'fi',
  ].join(' '),
  PORTS: `ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | head -n ${FACT_LINE_CAP.PORTS + 1} | cut -c1-64`,
  // '/' 가 든 이름은 커널 스레드(kworker/0:1 · ksoftirqd/3)라 뺀다 — 수백 개라 목록 상한을 먼저 채운다.
  // ⚠ v2.923(반증 R1): 줄마다 `p:` 접두 — 비특권 사용자가 ‘##MEM’ · ‘##END’ 같은 이름의 프로세스를 띄워 구획 표지를 위조하지 못하게(파서가 벗긴다).
  PROCS: `ps -e -o comm= 2>/dev/null | grep -v / | sort -u | head -n ${FACT_LINE_CAP.PROCS + 1} | cut -c1-32 | sed 's/^/p:/'`,
  // v2.923(반증 R8): `-s files` — 로컬 /etc/passwd 만(SSSD · LDAP 디렉터리 왕복 없음: DC 불통이면 sssd 시한까지 주기 명령이 멈춘다). gpadmin · airflow 는 보통 로컬 계정이다(디렉터리 계정이면 ‘없음’ — 정직 기록).
  ACCT: `getent -s files passwd ${DETECT_ACCOUNTS.join(' ')} 2>/dev/null | cut -d: -f1 | head -n ${FACT_LINE_CAP.ACCT}`,
  KARGS: `tr ' ' '\\n' < /proc/cmdline 2>/dev/null | grep -E '^(${KARG_KEYS.join('|')})=' | head -n ${FACT_LINE_CAP.KARGS} | cut -c1-200`,
  // 앞 세 열(처리 · 드롭 · time_squeeze)만 — 원문은 CPU 마다 13열(약 120B)이라 1,024코어면 바이트 산수(D1)를 넘긴다.
  SOFTNET: `awk '{print $1" "$2" "$3}' /proc/net/softnet_stat 2>/dev/null | head -n ${FACT_LINE_CAP.SOFTNET} | cut -c1-40`,
  NETQ: 'for d in /sys/class/net/*; do n=${d##*/}; if [ "$n" = lo ]; then continue; fi; if [ ! -e "$d/device" ]; then continue; fi; q=`cat "$d/tx_queue_len" 2>/dev/null`; '
    + 'set -- "$d"/queues/rx-*; if [ -e "$1" ]; then r=$#; else r=0; fi; set -- "$d"/queues/tx-*; if [ -e "$1" ]; then x=$#; else x=0; fi; echo "$n|$q|$r|$x"; done'
    + ` 2>/dev/null | head -n ${FACT_LINE_CAP.NETQ + 1} | cut -c1-128`,
  XFS: `awk '$3=="xfs"{print $2" "$4}' /proc/mounts 2>/dev/null | head -n ${FACT_LINE_CAP.XFS + 1} | cut -c1-300`,
});

/** os-release 값(따옴표 제거 · 글자 제한). */
const osVal = (v) => {
  const s = clip(v, 128).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  return /^[A-Za-z0-9 ._()+,:/-]{1,128}$/.test(s) ? s : null;
};

/** ##OSREL → { id, versionId, prettyName, pageSize, selinux, removeIpc } — 줄이 하나도 못 읽히면 null. */
export function parseOsRel(lines = []) {
  const out = { id: null, versionId: null, prettyName: null, pageSize: null, selinux: null, removeIpc: null };
  let seen = 0;
  for (const l of lines) {
    const s = clip(l, 200).trim();
    let m = /^(ID|VERSION_ID|PRETTY_NAME)=(.{0,128})$/.exec(s);
    if (m) {
      const v = osVal(m[2]);
      if (v == null) continue;
      if (m[1] === 'ID') out.id = v.toLowerCase();
      else if (m[1] === 'VERSION_ID') out.versionId = v;
      else out.prettyName = v;
      seen += 1; continue;
    }
    m = /^pagesize=(\d{1,8})$/.exec(s);
    if (m) { out.pageSize = num(m[1]); seen += 1; continue; }
    m = /^selinux=([A-Za-z]{0,16})$/.exec(s);
    if (m) { out.selinux = m[1] ? m[1].toLowerCase() : null; seen += 1; continue; }
    m = /^removeipc:\s*RemoveIPC\s*=\s*([A-Za-z]{1,8})\s*$/.exec(s);
    if (m) { const v = m[1].toLowerCase(); out.removeIpc = v === 'yes' || v === 'no' ? v : null; seen += 1; }
  }
  return seen ? out : null;
}

/**
 * ##UNITS → { units:[이름]|null, failed:n|null, capped }.
 *  · running 목록은 `running=ok` 줄이 왔을 때만 값이다(systemctl 성공) — `running=rc<코드>` 거나 줄이 없으면(잘림) null(확인 불가 — 빈 목록을 지어내지 않는다 · 반증 R7).
 *  · 실패 수도 `failed=<수>` 일 때만 · `failed=rc<코드>` 면 null. 둘 다 못 읽었으면 null(→ 구획 missing).
 *  · 유닛 이름 줄은 `u:` 접두(반증 R1)만 받는다.
 */
export function parseUnits(lines = []) {
  const units = []; let failed = null; let names = 0; let runOk = false;
  for (const l of lines) {
    const raw = clip(l, 128);
    if (raw.startsWith(FACT_PREFIX.UNITS)) {
      const s = raw.slice(FACT_PREFIX.UNITS.length).trim();
      if (!/^[A-Za-z0-9@._:\\-]{1,96}$/.test(s)) continue;
      names += 1;
      if (units.length < FACT_LINE_CAP.UNITS) units.push(s);
      continue;
    }
    const s = raw.trim();
    if (s === 'running=ok') { runOk = true; continue; }
    const f = /^failed=(\d{1,6})$/.exec(s);
    if (f) failed = num(f[1]);
  }
  if (!runOk && failed == null) return null;
  return { units: runOk ? units : null, failed, capped: runOk && names > FACT_LINE_CAP.UNITS };
}

/** ##PORTS → { ports:[수 — 오름차순 · 중복 제거], capped }. `0.0.0.0:22` · `[::]:5432` · `*:8080` · `127.0.0.1%lo:53` 모두 마지막 ':' 뒤. */
export function parsePorts(lines = []) {
  const set = new Set(); let rows = 0;
  for (const l of lines) {
    const s = clip(l, 80).trim();
    const m = /:(\d{1,5})$/.exec(s);
    if (!m) continue;
    rows += 1;
    const p = Number(m[1]);
    if (p >= 1 && p <= 65535 && rows <= FACT_LINE_CAP.PORTS) set.add(p);
  }
  if (!rows) return null;
  return { ports: [...set].sort((a, b) => a - b), capped: rows > FACT_LINE_CAP.PORTS };
}

/** ##PROCS → { names:[comm], capped } — 이름만(인자 없음). 인쇄 가능한 글자만 받는다. 줄은 `p:` 접두(반증 R1)가 있어야 한다(없는 줄은 버린다). */
export function parseProcs(lines = []) {
  const names = []; let rows = 0;
  for (const l of lines) {
    const raw = String(l ?? '');
    if (!raw.startsWith(FACT_PREFIX.PROCS)) continue;
    const s = clip(raw.slice(FACT_PREFIX.PROCS.length), 32).trim();
    if (!s || !/^[\x21-\x7e][\x20-\x7e]{0,31}$/.test(s)) continue;
    rows += 1;
    if (names.length < FACT_LINE_CAP.PROCS) names.push(s);
  }
  if (!rows) return null;
  return { names, capped: rows > FACT_LINE_CAP.PROCS };
}

/** ##ACCT → 있는 계정 이름(고정 목록 안의 것만). 구획은 왔는데 0줄이면 readSection 이 absent(= 그 계정 없음)로 본다. */
export function parseAccts(lines = []) {
  const known = new Set(DETECT_ACCOUNTS);
  const out = [];
  for (const l of lines) { const s = clip(l, 32).trim(); if (known.has(s) && !out.includes(s)) out.push(s); }
  return out.length ? out : null;
}

/** ##KARGS → { key: 값 } (화이트리스트 키만). */
export function parseKargs(lines = []) {
  const out = {}; let seen = 0;
  const keys = new Set(KARG_KEYS);
  for (const l of lines) {
    const s = clip(l, 200).trim();
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i);
    if (!keys.has(k) || Object.hasOwn(out, k)) continue;
    const v = s.slice(i + 1);
    if (!/^[A-Za-z0-9,._:-]{0,180}$/.test(v)) continue;
    out[k] = v; seen += 1;
  }
  return seen ? out : null;
}

/**
 * ##SOFTNET → { cpus, processed, dropped, squeezed } — 열 1(처리) · 2(드롭) · 3(time_squeeze) 은 16진 누적(부팅 이후).
 * ⚠ 누적값이다 — ‘지금 늘고 있는가’ 는 이 값 하나로 모른다(판정 모듈이 그렇게 말한다).
 */
export function parseSoftnet(lines = []) {
  let cpus = 0; let processed = 0; let dropped = 0; let squeezed = 0;
  for (const l of lines.slice(0, FACT_LINE_CAP.SOFTNET)) {
    const f = clip(l, 200).trim().split(/\s+/);
    if (f.length < 3 || !f.slice(0, 3).every((x) => /^[0-9a-fA-F]{1,16}$/.test(x))) continue;
    cpus += 1;
    processed += parseInt(f[0], 16); dropped += parseInt(f[1], 16); squeezed += parseInt(f[2], 16);
  }
  return cpus ? { cpus, processed, dropped, squeezed } : null;
}

/** ##NETQ → [{ name, txqlen, rxq, txq }] (물리 NIC). */
export function parseNetq(lines = []) {
  const out = [];
  for (const l of lines) {
    const f = clip(l, 128).trim().split('|');
    if (f.length < 4 || !/^[A-Za-z0-9._:@-]{1,32}$/.test(f[0])) continue;
    if (out.length >= FACT_LINE_CAP.NETQ) break;
    out.push({ name: f[0], txqlen: num(f[1]), rxq: num(f[2]), txq: num(f[3]) });
  }
  return out.length ? out : null;
}

/** ##XFS → [{ mount, opts:[…] }]. */
export function parseXfs(lines = []) {
  const out = [];
  for (const l of lines) {
    const s = clip(l, 300).trim();
    const sp = s.lastIndexOf(' ');
    if (sp <= 0) continue;
    const mount = s.slice(0, sp); const opts = s.slice(sp + 1);
    if (!mount.startsWith('/') || !/^[A-Za-z0-9=,._:-]{1,256}$/.test(opts)) continue;
    if (out.length >= FACT_LINE_CAP.XFS) break;
    out.push({ mount: mount.slice(0, 128), opts: opts.split(',').slice(0, 32) });
  }
  return out.length ? out : null;
}
