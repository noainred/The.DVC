/**
 * v2.923(리눅스 성능 4단계) — 수집 구획(용도 감지 · 튜닝 사실): 명령 조각 상수(인자 · 비밀 · sudo 없음) · 파서 경계 · ‘0 은 못 읽음이 아니다’ ·
 *   바이트 산수(D1) 유지 · 튜닝 열 상한(목록부터 뺀다) · 중앙 정제 화이트리스트(새 엣지 필드).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2923fa-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const F = await import('../src/bmusage/parse/linuxFacts.js');
const O = await import('../src/bmusage/collectors/osSsh.js');
const L = await import('../src/bmusage/parse/linuxProc.js');
const U = await import('../src/bmusage/usage.js');
const SAN = await import('../src/central/bmPerfSanitize.js');
const { EXEC_MAX_OUTPUT } = await import('../src/proxy/sshExec.js');

test('명령 조각 — 상수(변수 삽입은 고정 계정 목록 · 화이트리스트 키 · 상한 숫자뿐) · 인자/환경 읽기 없음 · sudo 없음 · 파일 쓰기 없음 · systemctl 없으면 0 을 내지 않는다', () => {
  const all = Object.values(F.FACT_SHELL).join('\n');
  // 파일 쓰기 금지 — 리다이렉트는 /dev/null 로만(2>/dev/null · >/dev/null).
  for (const bad of [/\bsudo\b/, /\bsu\s+-/, /environ/, /\bargs\b/, /-o\s+args/, /\/proc\/[^ ]*\/cmdline/, />>?\s*\/(?!dev\/null)/, /\btee\b/]) {
    assert.ok(!bad.test(all), `${bad}`);
  }
  assert.ok(!/\/proc\/\[0-9\]\*\/cmdline|\/proc\/\$\w+\/cmdline/.test(all), '프로세스 인자 금지');
  assert.ok(/ps -e -o comm=/.test(F.FACT_SHELL.PROCS), '프로세스는 이름만');
  assert.ok(F.FACT_SHELL.KARGS.includes('/proc/cmdline') && /grep -E '\^\(/.test(F.FACT_SHELL.KARGS), '부팅 인자는 화이트리스트 키만');
  assert.ok(/^if command -v systemctl/.test(F.FACT_SHELL.UNITS), 'systemctl 이 없으면 failed=0 을 지어내지 않는다');
  // 반증 R7: 종료 코드를 보고 값을 낸다 — wc -l 은 실패해도 0 을 낸다.
  assert.ok(!/\bwc\b/.test(F.FACT_SHELL.UNITS), 'wc -l 로 실패 수를 세지 않는다');
  assert.ok(/r=\$\?;/.test(F.FACT_SHELL.UNITS) && F.FACT_SHELL.UNITS.includes("echo 'running=ok'") && F.FACT_SHELL.UNITS.includes('failed=rc$r'));
  // 반증 R8: 주기 명령 안 systemctl 은 전부 timeout 3 · getent 는 로컬 파일만.
  const cmd0 = O.linuxCommand(['/']);
  const sysctlCalls = cmd0.match(/(\S+\s+\S+\s+)?systemctl (list-units|is-active)/g) || [];
  assert.ok(sysctlCalls.length >= 3);
  for (const c of sysctlCalls) assert.ok(/timeout 3 systemctl/.test(c), `시한 없는 systemctl: ${c}`);
  assert.equal(F.FACT_SHELL.ACCT, `getent -s files passwd gpadmin airflow 2>/dev/null | cut -d: -f1 | head -n ${F.FACT_LINE_CAP.ACCT}`);
  assert.ok(!/getent (?!-s files)/.test(cmd0), 'getent 는 -s files 만(디렉터리 왕복 없음)');
  // 반증 R1: 비특권 입력이 줄 머리에 오는 구획은 고정 접두.
  assert.ok(F.FACT_SHELL.PROCS.endsWith("| sed 's/^/p:/'"), 'PROCS 줄마다 p: 접두');
  assert.ok(F.FACT_SHELL.UNITS.includes('print "u:" $1'), 'UNITS 줄마다 u: 접두');
  for (const a of F.DETECT_ACCOUNTS) assert.ok(/^[a-z_][a-z0-9_-]{0,31}$/.test(a));
  const cmd = O.linuxCommand(['/']);
  for (const k of ['OSREL', 'UNITS', 'PORTS', 'PROCS', 'ACCT', 'KARGS', 'SOFTNET', 'NETQ', 'XFS']) assert.ok(cmd.includes(`echo '##${k}'; ${F.FACT_SHELL[k]}`), k);
  // 반증 R1: 명령이 표지를 내는 순서 = 파서가 받는 순서(LINUX_SECTIONS).
  const marks = [...O.linuxCommand(['/'], { sampler: true }).matchAll(/echo '##([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(marks, [...O.LINUX_SECTIONS]);
  assert.ok(cmd.indexOf("echo '##XFS'") < cmd.indexOf("echo '##END'"));
  assert.ok(cmd.includes('/sys/block/*/queue/read_ahead_kb'));
  assert.equal(O.linuxCommand(['/']), cmd, '같은 입력 → 같은 명령');
});

test('바이트 산수(1단계 반증 D1) — 새 구획을 더해도 구획 상한 × 줄 폭의 합 < 전체 상한 < sshExec 상한', () => {
  assert.ok(O.SECTION_BYTES_SUM < O.OUTPUT_MAX_BYTES, `${O.SECTION_BYTES_SUM} < ${O.OUTPUT_MAX_BYTES}`);
  assert.ok(O.OUTPUT_MAX_BYTES < EXEC_MAX_OUTPUT);
  for (const k of Object.keys(F.FACT_LINE_CAP)) { assert.equal(O.SECTION_LINE_CAP[k], F.FACT_LINE_CAP[k]); assert.equal(O.SECTION_LINE_BYTES[k], F.FACT_LINE_BYTES[k]); }
  assert.equal(L.BLKQ_SHELL_LINES, 4 * 1024);
});

test('파서 — os-release 따옴표 · selinux 빈 값 = null · RemoveIPC 명시만 · 유닛 상한 · 포트(IPv4/IPv6/와일드) · 프로세스 이름 · 계정 고정 목록만 · 커널 인자 화이트리스트 · softnet 16진 · NIC 큐 · xfs', () => {
  assert.deepEqual(F.parseOsRel(['ID="rocky"', 'VERSION_ID="9.4"', 'PRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"', 'pagesize=4096', 'selinux=', 'removeipc:RemoveIPC=no']),
    { id: 'rocky', versionId: '9.4', prettyName: 'Rocky Linux 9.4 (Blue Onyx)', pageSize: 4096, selinux: null, removeIpc: 'no' });
  assert.equal(F.parseOsRel(['ID=rocky', 'removeipc:RemoveIPC=maybe']).removeIpc, null);
  assert.equal(F.parseOsRel(['ID=$(reboot)']), null, '이상한 값은 받지 않는다');
  const u = F.parseUnits([...Array.from({ length: 300 }, (_, i) => `u:s${i}.service`), 'running=ok', 'failed=3', 'u:bad name!']);
  assert.equal(u.units.length, 256); assert.equal(u.capped, true); assert.equal(u.failed, 3);
  assert.equal(F.parseUnits([]), null);
  // 반증 R7: systemctl 이 실패하면 그 칸은 null(확인 불가) — 빈 목록 · 0 을 지어내지 않는다.
  assert.equal(F.parseUnits(['running=rc1', 'failed=rc1']), null, '둘 다 실패 = 못 읽음');
  assert.deepEqual(F.parseUnits(['running=rc124', 'failed=0']), { units: null, failed: 0, capped: false }, 'running 만 실패');
  assert.deepEqual(F.parseUnits(['u:a.service', 'failed=rc1']), null, 'running=ok 가 오지 않았다(잘림) — 이름 줄만으로 목록을 확정하지 않는다');
  assert.deepEqual(F.parseUnits(['u:a.service', 'running=ok', 'failed=rc1']), { units: ['a.service'], failed: null, capped: false });
  assert.deepEqual(F.parseUnits(['running=ok', 'failed=0']), { units: [], failed: 0, capped: false }, '성공한 빈 목록은 값이다');
  assert.equal(F.parseUnits(['a.service', 'running=ok']).units.length, 0, '접두 없는 이름 줄은 받지 않는다');
  assert.deepEqual(F.parsePorts(['0.0.0.0:22', '[::]:5432', '*:8080', '127.0.0.1%lo:53', '[::ffff:10.0.0.1]:6000', 'garbage', '0.0.0.0:70000']).ports, [22, 53, 5432, 6000, 8080]);
  assert.deepEqual(F.parseProcs(['p:airflow', 'p:postgres', 'p:  ', `p:${'x'.repeat(40)}`, 'nopfx']).names, ['airflow', 'postgres', 'x'.repeat(32)]);
  assert.equal(F.parseProcs(['airflow', '##MEM']), null, '접두 없는 줄은 프로세스 이름이 아니다');
  assert.deepEqual(F.parseAccts(['gpadmin', 'root', 'airflow', 'gpadmin']), ['gpadmin', 'airflow']);
  assert.equal(F.parseAccts(['root']), null);
  assert.deepEqual(F.parseKargs(['isolcpus=4-63', 'root=/dev/sda1', 'nohz_full=4-63', 'isolcpus=1', 'psi=1']), { isolcpus: '4-63', nohz_full: '4-63', psi: '1' });
  assert.deepEqual(F.parseSoftnet(['0000a000 00000001 00000002', '00000010 00000000 0000000f', 'zz']), { cpus: 2, processed: 0xa010, dropped: 1, squeezed: 0x11 });
  assert.deepEqual(F.parseNetq(['eno1|1000|8|8', 'bad name|1|1|1', 'eno2||4|4']), [{ name: 'eno1', txqlen: 1000, rxq: 8, txq: 8 }, { name: 'eno2', txqlen: null, rxq: 4, txq: 4 }]);
  assert.deepEqual(F.parseXfs(['/data rw,nodev,noatime,inode64', 'relative rw', '/x bad opts!']), [{ mount: '/data', opts: ['rw', 'nodev', 'noatime', 'inode64'] }]);
});

test('실제 셸(dash/sh) 실행 — 새 구획 표지가 전부 오고 파서가 상태(ok · absent · missing)를 낸다(이 개발 컨테이너 — 현장 Rocky 출력 아님)', (t) => {
  let out = '';
  try { out = execFileSync('/bin/sh', ['-c', O.linuxCommand([])], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }); } catch (e) { return t.skip(`셸 실행 불가: ${e.message}`); }
  const shaped = O.shapeLinux(out, []);
  assert.ok(shaped && !shaped.truncated);
  const sec = L.splitSections(out, { order: O.LINUX_SECTIONS });
  // (반증 테스트 품질) 예전 첫 단언은 readSection 결과면 항상 참이었다 — 표지 도착을 직접 본다.
  for (const k of F.FACT_SECTIONS) assert.ok(Object.hasOwn(sec, k), `${k} 표지가 왔다`);
  assert.ok(shaped.perf.osrel.value?.id, 'os-release ID');
  assert.ok(shaped.perf.procs.value?.names.length > 0, '프로세스 이름(접두를 벗긴 값)');
  assert.ok(!shaped.perf.procs.value.names.some((x) => x.startsWith('p:')));
  // 반증 R7: 이 환경의 systemctl 실제 결과와 대조 — 없으면 absent · 실패면 확인 불가(null) · 성공이면 목록.
  const probe = spawnSync('sh', ['-c', 'command -v systemctl >/dev/null 2>&1 || exit 200; timeout 3 systemctl list-units --type=service --state=running --no-legend --plain >/dev/null 2>&1'], { encoding: 'utf8' });
  const u = shaped.perf.units;
  if (probe.status === 200) assert.equal(u.absent, true, 'systemctl 없음 → absent');
  else if (probe.status !== 0) assert.ok(u.missing || u.value?.units === null, `systemctl 실패(rc ${probe.status}) → 확인 불가(지어낸 빈 목록 · 0 금지): ${JSON.stringify(u)}`);
  else assert.ok(Array.isArray(u.value?.units), 'systemctl 성공 → 목록');
  // 반증 R1: shapeLinux 는 순서를 준다 — 명령에 없는 표지(‘##ZZZ’)가 MEM 안에 끼어도 MEM 을 끊지 않는다(내용 줄).
  const inj = out.replace('##MEM\n', '##MEM\n##ZZZ\n');
  assert.equal(O.shapeLinux(inj, []).mem.totalBytes, shaped.mem.totalBytes, '순서 밖 표지는 구획을 열지 않는다');
  // 반증 R7: 한쪽만 읽혔으면 그 칸만 null — usage.js 도 그대로 싣는다(빈 목록으로 바꾸지 않는다).
  const bp = U.buildPerf({ os: { ok: true, counters: {}, perf: { units: { value: { units: null, failed: 0, capped: false }, absent: false, missing: false } } }, now: 1, lim: 1 });
  assert.deepEqual(bp.tuning.units, { list: null, failed: 0, capped: false });
});

/* ── 반증 R7 · R8 — 가짜 systemctl 로 종료 코드 · 시한 경로를 실제 셸에서 고정 ───────────────────────── */
function unitsWith(fakeBody) {
  const bin = fs.mkdtempSync(path.join(DIR, 'bin-'));
  for (const tool of ['awk', 'head', 'cut', 'grep', 'timeout', 'sleep']) {
    const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(bin, tool));
  }
  if (fakeBody != null) fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\n${fakeBody}\n`, { mode: 0o755 });
  const out = execFileSync('/bin/sh', ['-c', `echo '##UNITS'; ${F.FACT_SHELL.UNITS}; echo '##END'`], { encoding: 'utf8', env: { PATH: bin }, timeout: 20_000 });
  return { out, r: L.readSection(L.splitSections(out), 'UNITS', F.parseUnits) };
}
test('##UNITS(반증 R7 · R8) — systemctl 없음 = absent · 실패 = 확인 불가(‘실패 0’ 을 지어내지 않는다) · 성공 = 목록 · 시한(3초) 초과 = 그 칸만 확인 불가', (t) => {
  if (!fs.existsSync('/bin/sh')) return t.skip('sh 없음');
  assert.equal(unitsWith(null).r.absent, true, 'systemctl 없음 → 0줄(absent)');
  const fail = unitsWith('echo "Failed to connect to bus" >&2; exit 1');
  assert.match(fail.out, /running=rc1/); assert.match(fail.out, /failed=rc1/);
  assert.equal(fail.r.missing, true, '실패 → missing'); assert.equal(fail.r.value, null);
  const ok = unitsWith('case "$*" in *running*) printf "a.service loaded active running A\\nb.service loaded active running B\\n";; *failed*) printf "x.service loaded failed failed X\\n";; esac; exit 0');
  assert.deepEqual(ok.r.value, { units: ['a.service', 'b.service'], failed: 1, capped: false });
  const none = unitsWith('exit 0');
  assert.deepEqual(none.r.value, { units: [], failed: 0, capped: false }, '성공한 빈 출력 = 0 (grep -c)');
  const t0 = Date.now();
  const hang = unitsWith('case "$*" in *running*) sleep 10;; esac; exit 0');
  assert.ok(Date.now() - t0 < 9_000, 'timeout 3 이 끊는다');
  assert.match(hang.out, /running=rc124/);
  assert.deepEqual(hang.r.value, { units: null, failed: 0, capped: false }, '끊긴 칸만 확인 불가');
});

/* ── 반증 R1 — 표지 위조(비특권 프로세스 이름) ─────────────────────────────────────────────── */
test('표지 파서(반증 R1) — 줄 머리 정확 일치 · 이미 본 표지 재개방 금지 · 순서 밖(앞) 표지는 내용 줄', () => {
  const order = ['A', 'B', 'C', 'END'];
  const s1 = L.splitSections(['##A', '1', '##B', '2', '##A', 'x', '  ##C', '##C ', '##C', '3', '##END'].join('\n'), { order });
  assert.deepEqual(s1, { A: ['1'], B: ['2', '##A', 'x', '  ##C', '##C '], C: ['3'], END: [] });
  const s2 = L.splitSections(['##B', '1', '##A', '2'].join('\n'), { order });
  assert.deepEqual(s2, { B: ['1', '##A', '2'] }, '뒤로 가는 표지는 받지 않는다');
  const s3 = L.splitSections(['##A', '1', '##A', '2'].join('\n'));
  assert.deepEqual(s3, { A: ['1', '##A', '2'] }, '순서가 없어도 재개방은 하지 않는다');
});
test('실제 셸 + 실제 shapeLinux(반증 R1 재현) — ‘##MEM’ · ‘MemTotal: 9 kB’ · ‘##END’ 이름의 프로세스가 있어도 메모리 값 · 프로세스 목록 · 잘림 판정이 그대로', async (t) => {
  if (!fs.existsSync('/bin/sh') || !fs.existsSync('/proc/self/comm')) return t.skip('sh · /proc/self/comm 없음');
  const names = ['##MEM', 'MemTotal: 9 kB', 'MemFree: 0 kB', 'MemAvailable: 0', '##END', '##PROCS', 'ID=ubuntu'];
  /*
   * v2.926(CI 실패 수정): 예전에는 /bin/sleep 을 그 이름으로 **복사해** 띄웠다. 이 개발 컨테이너에서는 통과했지만 GitHub
   *   러너에서는 ‘##MEM’ 이 ps 에 나오지 않았다(원인 미확정 — 다중 호출(multicall) coreutils 이면 복사본이 argv[0] 을 몰라 곧바로
   *   끝난다는 것이 가장 유력한 추정). 그래서 **셸이 자기 comm 을 바꾸는** 방식으로 띄운다 — 실제 공격(prctl PR_SET_NAME ·
   *   setproctitle)과 같은 경로이고 바이너리 종류에 기대지 않는다. 이름이 실제로 바뀌었는지 먼저 확인하고, 못 바꾸는 환경이면 건너뛴다.
   */
  const kids = names.map((n) => spawn('/bin/sh', ['-c', 'printf %s "$N" > /proc/$$/comm; while :; do sleep 1; done'], { stdio: 'ignore', env: { ...process.env, N: n } }));
  try {
    await new Promise((r) => setTimeout(r, 300));
    const forged = kids.map((k) => { try { return fs.readFileSync(`/proc/${k.pid}/comm`, 'utf8').replace(/\n$/, ''); } catch { return ''; } });
    if (forged.some((c, i) => c !== names[i])) return t.skip(`이 환경에서는 프로세스 이름을 바꿀 수 없음(${JSON.stringify(forged)})`);
    const out = execFileSync('/bin/sh', ['-c', O.linuxCommand([])], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    const realTotalKb = Number(/^MemTotal:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]);
    const shaped = O.shapeLinux(out, []);
    assert.equal(shaped.truncated, false);
    assert.equal(shaped.mem.totalBytes, realTotalKb * 1024, 'MEM 은 /proc/meminfo 실제값(위조 줄이 끼지 않는다)');
    assert.ok(shaped.mem.usedPct < 100);
    const procs = shaped.perf.procs.value?.names || [];
    assert.ok(procs.length > names.length, `PROCS 가 비지 않는다(${procs.length})`);
    for (const n of ['##MEM', '##END', 'MemTotal: 9 kB']) assert.ok(procs.includes(n), `위조 이름은 프로세스 이름으로만 남는다: ${n}`);
    assert.equal(shaped.perf.osrel.value?.id === 'ubuntu' && !/ubuntu/i.test(fs.readFileSync('/etc/os-release', 'utf8')), false, 'OSREL 위조 없음');
    // ##END 위조 무력 — 진짜 ##END 앞에서 자른 출력은 여전히 ‘잘림’(1단계 D1)이다.
    const cut = out.slice(0, out.lastIndexOf('\n##END'));
    assert.equal(O.shapeLinux(cut, []).truncated, true, '프로세스 이름 ##END 로 잘림 보호가 꺼지지 않는다');
  } finally {
    for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* */ } }
  }
});

test('튜닝 열 상한 — 넘치면 sysctl 을 지키고 목록(프로세스 → 유닛 → 포트 …)부터 null + trimmed · 여전히 넘치면 예전 규약', () => {
  const tu = { v: 1, sysctl: { 'vm.swappiness': '60' }, procs: { list: Array.from({ length: 4000 }, (_, i) => `p${i}-${'x'.repeat(10)}`) }, units: { list: ['a.service'] } };
  const j = JSON.parse(U.tuningCol(tu));
  assert.equal(j.sysctl['vm.swappiness'], '60');
  assert.equal(j.procs, null); assert.deepEqual(j.trimmed, ['procs']); assert.deepEqual(j.units.list, ['a.service']);
  const small = JSON.parse(U.tuningCol({ v: 1, sysctl: {} }));
  assert.equal(small.trimmed, undefined);
});

test('중앙 정제(tuningFactsOf) — 아는 필드만 · 계정은 고정 목록만 · 이상한 이름 · 포트 · 키 버림 · 문자열 수치 → 수', () => {
  const t = SAN.tuningFactsOf({
    os: { id: 'rocky', versionId: '9.4', pageSize: '4096', selinux: 'enforcing', removeIpc: 'maybe', evil: 'x' },
    units: { list: ['ok.service', 'bad name', 5], failed: '2', capped: true, filtered: true }, ports: { list: [22, '5432', 99999, 'x'], capped: false },
    procs: { list: ['postgres', '\u0007bell'], capped: false }, accounts: ['gpadmin', 'root'], kargs: { isolcpus: '4-63', root: '/dev/sda', psi: 1 },
    softnet: { cpus: '4', squeezed: '3', junk: 1 }, netq: [{ name: 'eno1', txqlen: '1000', rxq: 8, x: 1 }, 'bad'], xfs: [{ mount: '/d', opts: ['rw', 7] }], memTotalKb: '1024', cores: 8, extra: 'drop',
  });
  assert.deepEqual(t.os, { id: 'rocky', versionId: '9.4', prettyName: null, pageSize: 4096, selinux: 'enforcing', removeIpc: null });
  assert.deepEqual(t.units, { list: ['ok.service'], failed: 2, capped: true, filtered: true });
  assert.equal(SAN.tuningFactsOf({ units: { list: null, failed: 0 } }).units.list, null, '반증 R7 — 못 읽은 목록은 null 그대로(빈 목록 = running 0개를 지어내지 않는다)');
  assert.deepEqual(t.ports.list, [22, 5432]);
  assert.deepEqual(t.procs.list, ['postgres']);
  assert.deepEqual(t.accounts, ['gpadmin']);
  assert.deepEqual(t.kargs, { isolcpus: '4-63' });
  assert.deepEqual(t.softnet, { cpus: 4, processed: null, dropped: null, squeezed: 3 });
  assert.deepEqual(t.netq, [{ name: 'eno1', txqlen: 1000, rxq: 8, txq: null }]);
  assert.deepEqual(t.xfs, [{ mount: '/d', opts: ['rw'] }]);
  assert.equal(t.memTotalKb, 1024); assert.equal(t.extra, undefined);
  const e = SAN.sanitizePerfEntry({ key: 'K', tuning: { v: 1, sysctl: { 'kernel.shmmax': '1', 'evil.key': 'x' }, blkq: [{ name: 'sda', readAheadKb: '8192' }], blkqTotal: 3, os: { id: 'rocky' }, sections: { osrel: 'ok', units: 'weird', bogus: 'ok' } } });
  assert.deepEqual(e.tuning.sysctl, { 'kernel.shmmax': '1' }, '새 sysctl 키는 SYSCTL_PATHS 화이트리스트로');
  assert.equal(e.tuning.blkq[0].readAheadKb, 8192); assert.equal(e.tuning.blkqTotal, 3);
  assert.deepEqual(e.tuning.sections, { osrel: 'ok', units: 'missing' });
});
