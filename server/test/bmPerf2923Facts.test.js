/**
 * v2.923(리눅스 성능 4단계) — 수집 구획(용도 감지 · 튜닝 사실): 명령 조각 상수(인자 · 비밀 · sudo 없음) · 파서 경계 · ‘0 은 못 읽음이 아니다’ ·
 *   바이트 산수(D1) 유지 · 튜닝 열 상한(목록부터 뺀다) · 중앙 정제 화이트리스트(새 엣지 필드).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  assert.equal(F.FACT_SHELL.ACCT, `getent passwd gpadmin airflow 2>/dev/null | cut -d: -f1 | head -n ${F.FACT_LINE_CAP.ACCT}`);
  for (const a of F.DETECT_ACCOUNTS) assert.ok(/^[a-z_][a-z0-9_-]{0,31}$/.test(a));
  const cmd = O.linuxCommand(['/']);
  for (const k of ['OSREL', 'UNITS', 'PORTS', 'PROCS', 'ACCT', 'KARGS', 'SOFTNET', 'NETQ', 'XFS']) assert.ok(cmd.includes(`echo '##${k}'; ${F.FACT_SHELL[k]}`), k);
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
  const u = F.parseUnits([...Array.from({ length: 300 }, (_, i) => `s${i}.service`), 'failed=3', 'bad name!']);
  assert.equal(u.units.length, 256); assert.equal(u.capped, true); assert.equal(u.failed, 3);
  assert.equal(F.parseUnits([]), null);
  assert.deepEqual(F.parsePorts(['0.0.0.0:22', '[::]:5432', '*:8080', '127.0.0.1%lo:53', '[::ffff:10.0.0.1]:6000', 'garbage', '0.0.0.0:70000']).ports, [22, 53, 5432, 6000, 8080]);
  assert.deepEqual(F.parseProcs(['airflow', 'postgres', '  ', 'x'.repeat(40)]).names, ['airflow', 'postgres', 'x'.repeat(32)]);
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
  for (const k of ['osrel', 'units', 'ports', 'procs', 'acct', 'kargs', 'softnet', 'netq', 'xfs']) {
    const s = shaped.perf[k];
    assert.ok(s && (s.value != null || s.absent || s.missing), k);
    assert.equal(s.missing && !s.absent && s.value == null && !Object.hasOwn(L.splitSections(out), k.toUpperCase() === 'ACCT' ? 'ACCT' : k.toUpperCase()), false, `${k} 표지가 왔다`);
  }
  assert.ok(shaped.perf.osrel.value?.id, 'os-release ID');
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
