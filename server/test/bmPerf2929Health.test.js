/**
 * v2.929(리눅스 성능 5단계) — 점검 소모품 · 변경 이벤트 **수집 구획**(##CHRONY · ##DMESG · ##CHANGES)과 소모품 8칸 판정.
 *   구획 규약(4단계 반증 R1 · 1단계 D1): 줄 머리 고정 접두 · 표지 정확 일치 · 순서 · 재개방 금지 · 상한 · timeout · 실패 = missing.
 *   보관 금지: 설정 파일 내용 · dmesg 원문 · dnf 명령줄은 셸 밖으로 나오지 않는다(CRC · 개수만).
 * 실제 셸(dash · bash)에서 상수 조각을 돌리고(가짜 chronyc · dmesg · needs-restarting · dnf 를 PATH 앞에 둔다) 실제 shapeLinux 로 읽는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

const H = await import('../src/bmusage/parse/linuxHealth.js');
const OS = await import('../src/bmusage/collectors/osSsh.js');
const HL = await import('../src/bmusage/health.js');
const { EXEC_MAX_OUTPUT } = await import('../src/proxy/sshExec.js');
const SRC = path.join(import.meta.dirname, '../src');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const SHELLS = ['/bin/sh', '/bin/bash'].filter((s) => fs.existsSync(s));

/** 가짜 명령 디렉터리(PATH 앞) — 실제 장비 형식(문서 기준) + 표지 위조 시도. */
function fakeBin(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2929bin-'));
  for (const [name, body] of Object.entries(files)) { fs.writeFileSync(path.join(d, name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(d, name), 0o755); }
  return d;
}
const run = (sh, cmd, bin) => execFileSync(sh, ['-c', cmd], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 << 20, env: { ...process.env, PATH: `${bin ? `${bin}:` : ''}${process.env.PATH}` } });

test('구획 순서 · 상수 조각 — LINUX_SECTIONS 에 ##CHRONY · ##DMESG · ##CHANGES 가 사실 구획 뒤 · 샘플러 앞 · 명령 표지 순서와 같다', () => {
  const idx = (k) => OS.LINUX_SECTIONS.indexOf(k);
  assert.ok(idx('XFS') < idx('CHRONY') && idx('CHRONY') < idx('DMESG') && idx('DMESG') < idx('CHANGES') && idx('CHANGES') < idx('SAMPLER'));
  const cmd = OS.linuxCommand([]);
  const order = [...cmd.matchAll(/echo '##([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(order, OS.LINUX_SECTIONS.filter((k) => k !== 'SAMPLER'), '명령 표지 순서 = 파서 순서');
  for (const k of H.HEALTH_SECTIONS) {
    assert.equal(typeof H.HEALTH_SHELL[k], 'string');
    assert.ok(!/\$\{(?!f##)/.test(H.HEALTH_SHELL[k]), `${k}: 셸 조각에 외부 값 삽입 없음(셸 지역 \${f##*/} 만)`);
    assert.ok(!/\b(sudo|su|pkexec|doas)\b/.test(H.HEALTH_SHELL[k]), `${k}: sudo 없음`);
    assert.ok(!/(>\s*\/(?!dev\/null)|\brm\b|\bkill\b|\btee\b)/.test(H.HEALTH_SHELL[k]), `${k}: 읽기 전용(쓰기 · 삭제 · kill 없음)`);
  }
  // 멈출 수 있는 명령은 timeout(R8)
  assert.match(H.HEALTH_SHELL.CHRONY, /timeout 3 chronyc/);
  assert.match(H.HEALTH_SHELL.DMESG, /timeout 3 dmesg/);
  assert.match(H.HEALTH_SHELL.CHANGES, /timeout 8 needs-restarting/);
  assert.match(H.HEALTH_SHELL.CHANGES, /timeout 8 dnf/);
  assert.match(H.HEALTH_SHELL.CHANGES, /timeout 3 systemctl is-active firewalld/);
});

test('바이트 산수(D1) — 새 구획을 더해도 SECTION_BYTES_SUM < OUTPUT_MAX_BYTES < EXEC_MAX_OUTPUT', () => {
  for (const k of H.HEALTH_SECTIONS) { assert.ok(OS.SECTION_LINE_CAP[k] > 0, k); assert.ok(OS.SECTION_LINE_BYTES[k] > 0, k); }
  assert.ok(OS.SECTION_BYTES_SUM < OS.OUTPUT_MAX_BYTES, `${OS.SECTION_BYTES_SUM} < ${OS.OUTPUT_MAX_BYTES}`);
  assert.ok(OS.OUTPUT_MAX_BYTES < EXEC_MAX_OUTPUT);
  // 명령의 줄 상한 = 상수(cut 폭 · head -n)
  assert.match(H.HEALTH_SHELL.CHANGES, new RegExp(`head -n ${H.HEALTH_FILES_MAX}`));
  assert.match(H.HEALTH_SHELL.CHRONY, /head -n 1 \| cut -c1-300/);
});

test('보관 금지(소스 스윕) — 설정 파일 · crontab 은 cksum 만 · dmesg 는 awk 개수만 · dnf 는 명령줄을 버린다 · sysctl -a 는 CRC 하나', () => {
  const sh = H.HEALTH_SHELL.CHANGES;
  // 설정 파일을 cat · head · grep 으로 내보내지 않는다(cksum 입력으로만).
  for (const f of ['/etc/sysctl', '/etc/cron', '/etc/crontab', '/var/spool/cron']) {
    for (const m of sh.matchAll(new RegExp(`(cat|head|tail|grep|awk|sed)[^|;]*${f.replace(/\//g, '\\/')}`, 'g'))) assert.fail(`${f} 내용을 읽는 명령: ${m[0]}`);
  }
  assert.match(sh, /cksum < "\$f"/);
  assert.match(sh, /sysctl -a 2>\/dev\/null \| grep -v -E '[^']+' \| cksum/, 'sysctl 값은 CRC 로만 나온다');
  // dmesg 원문이 awk 밖으로 나오지 않는다 — END 에서 개수만 출력 · 줄 출력 없음
  const awk = H.HEALTH_SHELL.DMESG;
  assert.ok(!/print \$0|print s\b|print substr\(\$0/.test(awk), 'dmesg 줄을 출력하지 않는다');
  assert.match(awk, /print "k:err=" e/);
  // dnf 명령줄 칸 — 파서가 버린다(비밀 혼입).
  const d = H.parseDnfLine(' 214 | install kernel --setopt=proxy_password=SECRET | 2026-11-05 22:05 | Install, Upgrade | 12 ');
  assert.deepEqual(d, { id: 214, at: '2026-11-05 22:05', action: 'Install, Upgrade', altered: 12 });
  assert.ok(!JSON.stringify(d).includes('SECRET'));
  // 파서 · 변경 모듈 · 소모품 모듈 소스에 원문 보관 경로가 없다(cmdline · environ · 파일 내용 키 없음).
  for (const f of ['bmusage/parse/linuxHealth.js', 'bmusage/changes.js', 'bmusage/health.js', 'bmusage/cycleOps.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.ok(!/\/proc\/[^'"`]*\/(cmdline|environ)/.test(s), `${f}: 인자 · 환경 읽기 없음`);
    assert.ok(!/readFileSync\([^)]*(sysctl\.d|cron)/.test(s), `${f}: 설정 파일을 읽지 않는다`);
  }
});

test('실제 셸(dash · bash) + 가짜 장비 명령 — 줄마다 접두 · 표지 위조 불가 · 값 · 실패 = missing · 없음 = absent', async (t) => {
  if (!SHELLS.length) return t.skip('셸 없음');
  // chronyc 가 표지 모양 · 메모리 줄을 내도(참조 이름 위조) 한 줄 · c: 접두 뒤라 구획이 되지 못한다.
  const bin = fakeBin({
    chronyc: "printf 'C0A80101,##MEM,3,1762500000.1,0.000812345,-0.000101,0.000200,-3.1,0.0,0.03,0.0123,0.0011,64.5,Normal\\n##END\\nMemTotal: 9 kB\\n'",
    dmesg: "printf 'kern  :err   : [   10.000000] nvme nvme1: I/O 1024 QID 7 timeout\\nkern  :warn  : [   20.500000] ##MEM\\nkern  :warn  : [   21.000000] MemTotal: 9 kB\\n'",
    'needs-restarting': 'exit 1',
    dnf: "printf 'ID     | Command line                       | Date and time    | Action(s)      | Altered\\n-------------------------------------------\\n   214 | install kernel --setopt=p=SECRET   | 2026-11-05 22:05 | Install        |   12\\n'",
  });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const sh of SHELLS) {
    const out = run(sh, OS.linuxCommand([]), bin);
    const shaped = OS.shapeLinux(out, []);
    assert.equal(shaped.truncated, false, `${sh}: ##END 도착(위조 ##END 로 잘림 판정이 바뀌지 않는다)`);
    // 위조 줄은 MEM 구획을 덮지 못한다(실제 /proc/meminfo 값이 남는다).
    assert.ok(shaped.mem && shaped.mem.totalBytes > 9 * 1024, `${sh}: 메모리 실제값 유지`);
    const raw = out.split('##CHRONY\n')[1].split('\n##DMESG')[0].split('\n').filter(Boolean);
    assert.ok(raw.every((l) => l.startsWith('c:')), `${sh}: CHRONY 줄은 전부 c: 접두`);
    const c = shaped.perf.chrony.value;
    assert.equal(c.offsetMs, 0.812, `${sh}: System time 0.000812345초 → 0.812ms`);
    assert.equal(c.stratum, 3); assert.equal(c.leap, 'Normal'); assert.equal(c.synced, true); assert.equal(c.refId, 'C0A80101');
    assert.ok(!JSON.stringify(c).includes('##MEM'), '참조 이름(장비 입력)은 보관하지 않는다');
    const dm = shaped.perf.dmesg.value;
    assert.deepEqual({ err: dm.err, warn: dm.warn }, { err: 1, warn: 2 }, `${sh}: 개수만`);
    const dmRaw = out.split('##DMESG\n')[1].split('\n##CHANGES')[0];
    assert.ok(!dmRaw.includes('nvme') && !dmRaw.includes('MemTotal'), `${sh}: 커널 메시지 원문이 출력에 없다`);
    const ch = shaped.perf.changes.value;
    assert.equal(ch.needsRestart, true, 'needs-restarting -r 종료 1 = 재부팅 필요');
    assert.ok(ch.upS > 0 && /^[0-9a-f-]{36}$/.test(ch.bootId));
    const chRaw = out.split('##CHANGES\n')[1].split('\n##END')[0].split('\n').filter(Boolean);
    assert.ok(chRaw.every((l) => l.startsWith('x:')), `${sh}: CHANGES 줄은 전부 x: 접두`);
    assert.ok(!out.includes('SECRET'), 'dnf 는 rpmdb 가 최근에 바뀐 때만 — 이 컨테이너엔 rpmdb 가 없어 돌지 않는다(바뀐 때도 파서가 명령줄을 버린다)');
  }
  // chronyc 실패 = missing(값을 지어내지 않는다) · chronyc 없음 = absent · dmesg 실패 = failed(rc)
  const bin2 = fakeBin({ chronyc: 'echo "506 Cannot talk to daemon" >&2; exit 1', dmesg: 'echo "dmesg: read kernel buffer failed: Operation not permitted" >&2; exit 1', 'needs-restarting': 'sleep 20' });
  t.after(() => fs.rmSync(bin2, { recursive: true, force: true }));
  const out2 = run(SHELLS[0], OS.linuxCommand([]), bin2);
  const s2 = OS.shapeLinux(out2, []);
  assert.equal(s2.perf.chrony.missing, true, 'chronyc 실패 → missing');
  assert.deepEqual(s2.perf.dmesg.value, { failed: true, rc: 1 }, 'dmesg 실패 → 개수 없음');
  assert.equal(s2.perf.changes.value.needsRestart, null, 'needs-restarting 시한(8초 · 124) → 확인 불가(재부팅 불필요로 보지 않는다)');
});

test('파서 — 접두 없는 줄 · 형식 밖 줄은 버린다 · 하나도 못 읽으면 null', () => {
  assert.equal(H.parseChrony(['t,C0A80101,a,3,1,0.1,0,0,0,0,0,0,0,0,Normal', 'rc=0']), null, '접두 없는 줄');
  assert.equal(H.parseChrony(['c:rc=1']), null, 'rc ≠ 0');
  const ns = H.parseChrony(['c:t,00000000,,0,0.0,0.000000,0.0,0.0,0.0,0.0,0.0,1.0,1.0,0.0,Not synchronised', 'c:rc=0']);
  assert.equal(ns.synced, false, '소스 없음(Not synchronised · stratum 0)');
  assert.equal(H.parseDmesgCounts(['err=1 warn=2 err24=0 warn24=0 rc=0']), null, '접두 없음');
  assert.equal(H.parseChanges(['up=1', 'sf:a.conf|123']), null, '접두 없음');
  const c = H.parseChanges(['x:sf:../../etc/shadow|1', 'x:sf:ok.conf|123', 'x:cf:bad name|1', 'x:ct:root|perm', 'x:fd=1	0	100', 'x:fw=active', 'x:kern=5.14.0-427.el9.x86_64', 'x:nr=0']);
  assert.deepEqual(c.sysctlFiles, { 'ok.conf': '123' }, '경로 · 형식 밖 이름은 버린다');
  assert.deepEqual(c.cronFiles, {});
  assert.equal(c.spoolPerm, true, '읽지 못한 crontab 은 perm(내용 변화로 세지 않는다)');
  assert.deepEqual(c.fd, { alloc: 1, max: 100, pct: 1 });
  assert.equal(c.needsRestart, false);
  // ReDoS 방어 — 긴 줄도 선형(줄 길이를 먼저 자른다)
  const long = `x:sf:${'a'.repeat(200_000)}|1`;
  // 상한은 회귀와 확실히 갈리는 값(앵커 없는 반복이면 20만 자 × 3줄이 수십 초 — 선형이면 수 ms). CPU 에 따라 깨지는 200ms 이하 절대 상한은 쓰지 않는다(audit2613h).
  const t0 = performance.now(); H.parseChanges([long, long, long]); assert.ok(performance.now() - t0 < 2_000);
});

test('소모품 8칸 판정 — 못 읽음 · 없음 · 해당 없음은 주의에도 정상에도 넣지 않는다(attention 은 warn · bad 만)', () => {
  const hf = {
    chrony: { offsetMs: -150, stratum: 3, leap: 'Normal', synced: true }, dmesg: { err: 3, warn: 9, err24: 1, warn24: 2 },
    upS: 41 * 86_400 + 5, kernel: '5.14.0-362', needsRestart: true, nrAbsent: false, firewalld: 'inactive',
    fd: { alloc: 30, max: 100, pct: 30 }, conntrack: { count: 85, max: 100, pct: 85 }, oomTotal: 2,
    sections: { chrony: 'ok', dmesg: 'ok', changes: 'ok' },
  };
  const tuning = { units: { failed: 0 }, os: { selinux: 'disabled' }, sysctl: { 'tuned.active_profile': 'throughput-performance' } };
  const h = HL.judgeHealth({ hfacts: hf, tuning, row: { oom_kill_delta: 0 }, cert: { days: 12, count: 1 }, th: {}, now: NOW });
  assert.equal(h.cells.chrony.code, 'warn', '|−150ms| ≥ 100ms');
  assert.equal(h.cells.units.code, 'ok');
  assert.equal(h.cells.oom.code, 'ok', '증가 0 · 누적 2');
  assert.equal(h.cells.dmesg.code, 'warn', '24시간 오류 1 > 기준 0');
  assert.equal(h.cells.uptime.code, 'warn'); assert.equal(h.cells.uptime.upDays, 41);
  assert.equal(h.cells.fdct.code, 'warn', 'conntrack 85% ≥ 80');
  assert.equal(h.cells.cert.code, 'warn', '12일 ≤ 30');
  assert.equal(h.cells.tuned.code, 'info');
  assert.equal(h.attention, 5);
  // 못 읽음 — OS 구획이 없으면 전부 missing(또는 해당 없음) · attention 0
  const none = HL.judgeHealth({ hfacts: null, tuning: null, row: null, cert: null, th: {}, now: NOW });
  assert.equal(none.attention, 0);
  assert.equal(none.cells.cert.code, 'na', '등록된 TLS 점검 없음 = 해당 없음(확인 불가와 구분)');
  assert.ok(['chrony', 'units', 'oom', 'dmesg', 'uptime', 'fdct', 'tuned'].every((k) => none.cells[k].code === 'missing'));
  // chrony 없음(absent) · dmesg 권한(perm) · needs-restarting 없음(na) · OOM 증가 = bad · conntrack 모듈 없음은 FD 만
  const h2 = HL.judgeHealth({ hfacts: { ...hf, chrony: null, dmesg: { failed: true, rc: 1 }, needsRestart: null, nrAbsent: true, conntrack: null, sections: { chrony: 'absent', dmesg: 'ok', changes: 'ok' } }, tuning: { units: { failed: null } }, row: { oom_kill_delta: 1 }, cert: null, th: {}, now: NOW });
  assert.equal(h2.cells.chrony.code, 'absent'); assert.equal(h2.cells.dmesg.code, 'perm'); assert.equal(h2.cells.uptime.code, 'na'); assert.equal(h2.cells.uptime.upDays, 41);
  assert.equal(h2.cells.oom.code, 'bad'); assert.equal(h2.cells.units.code, 'missing', '실패 유닛 수를 못 읽음(R7)');
  assert.equal(h2.cells.fdct.code, 'ok'); assert.equal(h2.cells.fdct.conntrackAbsent, true);
  // 기준값은 설정 — 바꾸면 판정이 따라간다(숫자를 박지 않는다)
  const h3 = HL.judgeHealth({ hfacts: hf, tuning, row: {}, cert: null, th: { chronyMs: 200, conntrackPct: 90 }, now: NOW });
  assert.equal(h3.cells.chrony.code, 'ok'); assert.equal(h3.cells.fdct.code, 'ok');
  // 목록용 — code · since 만
  const c = HL.compactHealth({ ...h, since: { chrony: NOW - 86_400_000 } });
  assert.deepEqual(Object.keys(c.cells).sort(), [...HL.HEALTH_CELLS].sort());
  assert.deepEqual(c.cells.chrony, { code: 'warn', since: NOW - 86_400_000 });
  assert.equal(c.attention, 5);
});

test('인증서 — svcmon cert 점검 재사용(서버 주소 · 이름 정확 일치 · 가장 짧은 남은 일수) · 없으면 null', () => {
  const certDaysOf = (r) => (r === 'D-21' ? 21 : r === 'D-3' ? 3 : null);
  const src = { targets: [{ host: 'bm-a.example', tests: [{ id: 'x1', type: 'cert' }, { id: 'x2', type: 'cert' }, { id: 'p', type: 'ping' }] }, { host: 'other', tests: [{ id: 'y', type: 'cert' }] }],
    results: new Map([['x1', { reply: 'D-21' }], ['x2', { reply: 'D-3' }], ['y', { reply: 'D-3' }]]), certDaysOf };
  assert.deepEqual(HL.certForServer({ name: 'BM-A.example' }, src), { days: 3, count: 2 });
  assert.equal(HL.certForServer({ name: 'bm-a' }, src), null, '부분 일치는 쓰지 않는다');
  assert.equal(HL.certForServer({ osHost: { host: 'https://bm-a.example/' } }, src).count, 2, '스킴 · 경로는 뗀다');
});
