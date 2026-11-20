/**
 * 8b 반증 F1 · S1 · F10 — **SSH 세션 시한 산수**(구획 안 timeout 합 < exec 시한)와 실제 수집 경로.
 *
 *   ① 기계 산수: 명령 문자열에서 `timeout N` · `sleep N` 을 뽑아 합 + 여유 ≤ exec 시한
 *      · 주 명령(linuxCommand — 샘플러 끔/켬 · 8b 끔/켬 같음: Top-N 은 주 명령 밖) — needs-restarting ↔ dnf 는 한 주기에 하나(②가 실제 셸로 확인)
 *      · Top-N 별도 exec(topCommand) · 전 프로세스 /proc 읽기 · ps 는 모두 timeout 안(S1)
 *      · 7a 로그 exec(logCommand — 셸 함수 rdf 안 timeout 은 호출 수만큼) · 집중 모니터링 경로(run.js — top:false 명시 · 스냅샷 exec)
 *      모든 exec 가 같은 함수(worstOf)로 센다.
 *      ⚠ 8b 이전부터의 결함: 주 명령 최악 합이 34초(> 30초 — 4 · 5단계) · 로그 exec 46초(rdf 호출 수까지 61초 — 7a)였다 — 이 시험이 없어서 고정되지 않았다(반증 F1 · 후속).
 *   ② 실제 셸(dash): CHANGES 조각을 가짜 find · dnf · needs-restarting(호출 기록)으로 돌려 둘이 한 주기에 함께 돌지 않는지
 *   ③ 실제 collectOsUsage + 실제 sshExec(exec 시한 · 출력 버림) — ssh2 Client 만 로컬 dash 로 바꾼 자식 프로세스(--experimental-test-module-mocks).
 *      가짜 PATH 에서 systemctl · chronyc · dmesg · needs-restarting · dnf · top · df 가 전부 멈춤(`sleep 100`) → 주 표본이 살아남고(ok · CPU · 메모리) Top-N 은 /proc 대안으로.
 *      1회차 점검 D2: df(##DF · ##DFI)에 시한이 없어 멈춘 마운트 하나가 주 명령 전체를 exec 시한에 걸리게 했다(재현 30,029ms · 전 구획 유실 · 사유 not-linux) —
 *      이제 df 도 timeout 안이고(① 산수에 df 두 번 · 주 명령 시한 34초) 멈추면 디스크 사용 공간 구획만 missing 이다(③).
 *      Top-N exec 실패 → 본 표본 유지 · top 만 missing. 집중 경로 옵션 → Top-N exec 없음(반증 F10). 반증 r-f1(rv8b/budget.test.mjs)을 옮긴 것.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const OS = await import('../src/bmusage/collectors/osSsh.js');
const T = await import('../src/bmusage/parse/linuxTop.js');
const H = await import('../src/bmusage/parse/linuxHealth.js');
const SNAP = await import('../src/bmusage/snapshot/command.js');
const FOCUS = await import('../src/bmusage/focus/run.js');
const LC = await import('../src/bmusage/logs/command.js');
const LR = await import('../src/bmusage/logs/run.js');
/** 이어 읽기 상태(커서 · inode · offset · boot — 화이트리스트를 지나는 꼴) — 로테이트 경로(find)가 명령에 들어간다. */
const LOGSTATE = { journal: { cursor: `s=${'a'.repeat(32)};i=1f;b=${'b'.repeat(32)};m=2;t=3;x=4` }, jsec: { cursor: `s=${'c'.repeat(32)};i=1;b=${'d'.repeat(32)};m=2;t=3;x=4` },
  kernel: { boot: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', last: '123.5' }, secure: { ino: '1234', off: '99' }, audit: { ino: '5678', off: '0' }, apps: { gpdb: { dir: 0, ino: '42', off: '7' } } };
const SRC = (p) => fs.readFileSync(path.join(import.meta.dirname, '../src', p), 'utf8');
const DASH = ['/bin/dash', '/bin/sh'].find((x) => fs.existsSync(x));

/** 명령 문자열 → [{ s, what }](timeout) · [s](sleep). `timeout -k 1 2 cmd` 꼴의 선택 인자도 넘는다. */
export function waitsOf(cmd) {
  const t = [...String(cmd).matchAll(/\btimeout\s+(?:-[a-zA-Z]+\s+\S+\s+)*(\d+(?:\.\d+)?)s?\s+(\S+)/g)].map((m) => ({ s: Number(m[1]), what: m[2] }));
  const sl = [...String(cmd).matchAll(/\bsleep\s+(\d+(?:\.\d+)?)\b/g)].map((m) => Number(m[1]));
  return { t, sl };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
/**
 * 한 exec 명령의 최악 대기(초) — 줄 단위로 셸 함수 정의(`이름() {`)를 찾아 그 안 timeout · sleep 은 **호출 수만큼** 곱하고, 나머지 줄은 한 번씩 더한다.
 *   exclusive = [[명령 a, 명령 b]] — 한 주기에 하나만 도는 쌍(실제 셸 시험이 따로 확인)은 작은 쪽을 뺀다(각각 바깥에 정확히 한 번 있어야 한다).
 */
export function worstOf(cmd, { exclusive = [] } = {}) {
  const lines = String(cmd).split('\n');
  const fns = new Map();
  for (const l of lines) { const m = /^\s*([A-Za-z_]\w*)\(\) \{/.exec(l); if (m) fns.set(m[1], waitsOf(l)); }
  const outer = lines.filter((l) => !/^\s*[A-Za-z_]\w*\(\) \{/.test(l)).join('\n');
  const top = waitsOf(outer);
  let total = sum(top.t.map((x) => x.s)) + sum(top.sl);
  const calls = {};
  for (const [name, w] of fns) {
    const n = [...outer.matchAll(new RegExp(`(?:^|[\\s;&|(])${name}\\s`, 'g'))].length;
    calls[name] = n;
    total += n * (sum(w.t.map((x) => x.s)) + sum(w.sl));
  }
  for (const [a, b] of exclusive) {
    const xa = top.t.filter((x) => x.what === a); const xb = top.t.filter((x) => x.what === b);
    assert.equal(xa.length, 1, `배타 쌍 ${a} 는 한 번`); assert.equal(xb.length, 1, `배타 쌍 ${b} 는 한 번`);
    total -= Math.min(xa[0].s, xb[0].s);
  }
  return { worstS: total, top: top.t, fns: Object.fromEntries([...fns].map(([k, w]) => [k, w.t])), calls };
}

test('① 기계 산수 — 주 명령 · Top-N exec · 7a 로그 exec · 집중 경로: 안 timeout · sleep 합 + 여유 ≤ exec 시한(같은 함수)', () => {
  assert.equal(OS.CMD_TIMEOUT_MS, 34_000, '운영 기본값(env 없음) — 1회차 점검 D2: df 시한 2 × 2초만큼 30 → 34초');
  for (const sampler of [false, true]) {
    const cmd = OS.linuxCommand(['/'], { sampler });
    // 8b 끔/켬: Top-N 은 주 명령 밖이라 옵션이 주 명령을 바꾸지 않는다(반증 F1 — 예전에는 켬이면 +3초 timeout +1초 대기)
    assert.equal(OS.linuxCommand(['/'], { sampler, top: true }), cmd, '주 명령은 top 옵션과 무관');
    const { t } = waitsOf(cmd);
    assert.ok(t.length >= 6, `timeout 을 뽑았다(${t.length})`);
    const nr = t.filter((x) => x.what === 'needs-restarting'); const dnf = t.filter((x) => x.what === 'dnf');
    // 1회차 점검 D2: df 두 곳(##DF · ##DFI)이 모두 timeout 안 — 시한 없는 df 가 남으면 실패(변이: timeout 을 빼면 여기서 잡힌다)
    assert.deepEqual(t.filter((x) => x.what === 'df').map((x) => x.s), [OS.DF_TIMEOUT_S, OS.DF_TIMEOUT_S], 'df -k · df -i 둘 다 timeout 안');
    assert.equal([...cmd.matchAll(/(?:^|[;|&{(]\s*)df -P/g)].length, 0, '시한 없이 시작하는 df 없음');
    assert.match(cmd, /\[ "\$_dh" = 1 \] && nrr=0;/, 'dnf 차례면 needs-restarting 을 건너뛰는 장치');
    const { worstS } = worstOf(cmd, { exclusive: [['needs-restarting', 'dnf']] });
    assert.ok(worstS * 1000 + OS.CMD_INNER_MARGIN_MS <= OS.CMD_TIMEOUT_MS,
      `sampler=${sampler}: 주 명령 최악 ${worstS}초 + 여유 ${OS.CMD_INNER_MARGIN_MS / 1000}초 ≤ ${OS.CMD_TIMEOUT_MS / 1000}초(${t.map((x) => `${x.what} ${x.s}`).join(' · ')})`);
    // 예전 값(배타 없이 8 + 8)이면 넘는다 — 산수가 실제로 무엇을 막는지 고정
    assert.ok((sum(t.map((x) => x.s)) - nr[0].s - dnf[0].s + 8 + 8) * 1000 > OS.CMD_TIMEOUT_MS - OS.CMD_INNER_MARGIN_MS, '예전 최악(34초)은 이 산수를 넘었다');
  }
  // Top-N 별도 exec — 전부 합(배타 없음) + 여유 5초 ≤ TOP_EXEC_TIMEOUT_MS · 그 시한은 세션 예산 안(남은 예산과 작은 쪽)
  for (const forceProc of [false, true]) {
    const worst = worstOf(T.topCommand({ forceProc })).worstS;
    assert.ok(worst * 1000 + 5_000 <= T.TOP_EXEC_TIMEOUT_MS, `Top-N 최악 ${worst}초 + 여유 5초 ≤ ${T.TOP_EXEC_TIMEOUT_MS / 1000}초`);
  }
  // 7a 로그 exec(반증 후속) — 첫 읽기 · 이어 읽기(커서 · offset · 로테이트) 명령 모두. rdf(파일 증분 함수) 안 find 시한은 호출(secure · audit · 앱 수)만큼
  for (const state of [{}, LOGSTATE]) {
    const lw = worstOf(LC.logCommand(state, {}));
    assert.equal(lw.calls.rdf, 2 + LC.APP_LOGS.length, `rdf 호출 = secure · audit · 앱 ${LC.APP_LOGS.length}(${lw.calls.rdf})`);
    assert.ok(lw.fns.rdf.some((x) => x.what === 'find'), 'rdf 안 find 시한을 함수 안 것으로 셌다');
    assert.ok(lw.worstS * 1000 + LC.LOG_INNER_MARGIN_MS <= LR.LOG_EXEC_TIMEOUT_MS,
      `로그 exec 최악 ${lw.worstS}초 + 여유 ${LC.LOG_INNER_MARGIN_MS / 1000}초 ≤ ${LR.LOG_EXEC_TIMEOUT_MS / 1000}초(${lw.top.map((x) => `${x.what} ${x.s}`).join(' · ')} · rdf ${lw.calls.rdf} × find)`);
    assert.ok(LR.LOG_EXEC_TIMEOUT_MS < OS.SESSION_BUDGET_MS - 15_000 + 1, '로그 exec 시한 ≤ 세션 예산 − READY');
  }
  // 예전 값(journalctl 15 ×2 · dmesg 5 · systemctl 3 ×2 · find 5 × rdf 4 = 61초)은 넘었다 — 산수가 무엇을 막는지 고정
  assert.ok((15 + 15 + 5 + 3 + 3 + 5 * (2 + LC.APP_LOGS.length)) * 1000 + LC.LOG_INNER_MARGIN_MS > LR.LOG_EXEC_TIMEOUT_MS, '예전 로그 exec 최악(61초)은 이 산수를 넘었다');
  assert.ok(T.TOP_EXEC_TIMEOUT_MS < OS.SESSION_BUDGET_MS - 15_000, 'Top-N exec 시한 < 세션 예산 − READY');
  // S1: 전 프로세스 · 후보 /proc 읽기와 ps 는 모두 timeout 안 — 커널 잠금 대기로 멈춰도 그 칸만 빈다
  const tc = T.TOP_COMMAND;
  const reads = [...tc.matchAll(/(\S+ \S+ )?(grep -H |ps -eo )/g)];
  assert.equal(reads.length, 7, `/proc 읽기(grep -H) · ps 7곳(io 전체 · stat 전체 ×2 · 후보 io · stat · status · ps) — ${reads.length}`);
  for (const m of reads) assert.match(m[1] || '', /(?:^|\W)timeout \d+ $/, `시한 없는 읽기: ${m[0].slice(0, 60)}`);
  assert.match(tc, new RegExp(`timeout ${T.TOP_TIMEOUT_S} top -b`));
  // 집중 모니터링(반증 F10): run.js 가 top:false 를 명시 · 주 명령은 같은 산수 · 스냅샷 exec 은 자기 시한(12초) 안
  const fr = SRC('bmusage/focus/run.js');
  assert.match(fr, /_D\.collectOs\((?:tg\.osHost|osHostNow), \{[\s\S]{0,900}?top: false,[\s\S]{0,40}?\}\), '집중 수집 시한 초과'\)/, '집중 경로는 Top-N 을 끈다');
  const snapTmo = Number(/name: 'snap', cmd: FOCUS_SNAPSHOT_COMMAND, timeoutMs: (\d[\d_]*)/.exec(fr)?.[1]?.replace(/_/g, ''));
  assert.ok(snapTmo > 0);
  assert.ok(worstOf(SNAP.FOCUS_SNAPSHOT_COMMAND).worstS * 1000 + 5_000 <= snapTmo, '집중 스냅샷 안 대기 + 여유 ≤ 스냅샷 exec 시한');
  assert.ok(FOCUS.FOCUS_BUDGET_MS - 15_000 >= OS.CMD_TIMEOUT_MS && FOCUS.FOCUS_BUDGET_MS < FOCUS.FOCUS_DEADLINE_MS, '집중 예산 − READY ≥ 주 명령 시한 · 예산 < 집중 시한');
  // 폴러는 설정 top.on 을 넘긴다 · 수집기 기본값은 끔(호출부가 켜야 돈다)
  assert.match(SRC('bmusage/collectors/osSsh.js'), /extraCommands = \[\], top = false \} = \{\}\) \{/);
  assert.match(SRC('bmusage/poller.js'), /collectOne\(tg, \{[^}]*top: topOn \}\)/);
});

function fakeBin(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm8bbud-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return d;
}
const HAS = (bin) => { try { execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };

test('② 실제 셸 — needs-restarting 과 dnf history 는 한 주기에 함께 돌지 않는다(패키지 DB 20분 안 = dnf · 20~40분 = needs-restarting)', async (t) => {
  if (!DASH) return t.skip('셸 없음');
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm8bbud-log-')), 'calls');
  const bin = fakeBin({
    find: 'case "$*" in *"-mmin -20"*) [ "$F20" = 1 ] && echo /var/lib/rpm/rpmdb.sqlite;; *"-mmin -40"*) [ "$F40" = 1 ] && echo /var/lib/rpm/rpmdb.sqlite;; esac; exit 0',
    dnf: `echo dnf >> "${log}"; printf 'ID | Command line | Date and time | Action(s) | Altered\\n 7 | up | 2026-11-08 10:00 | Upgrade | 3\\n'`,
    'needs-restarting': `echo nr >> "${log}"; printf 'Reboot should not be necessary.\\n'`,
    date: '[ "$1" = "+%H%M" ] && { echo "$DHM"; exit 0; }; exec /bin/date "$@"',
  });
  t.after(() => { fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(path.dirname(log), { recursive: true, force: true }); });
  const justBooted = os.uptime() < 1800;
  const realDnf = HAS('dnf');
  const runCase = (env) => {
    try { fs.rmSync(log, { force: true }); } catch { /* */ }
    const out = execFileSync(DASH, ['-c', `export LC_ALL=C; ${H.HEALTH_SHELL.CHANGES}`], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
    let calls = []; try { calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { calls = []; }
    return { calls, v: H.parseChanges(out.split('\n')) };
  };
  // 20분 안(dnf 차례) — 매일 창(03:05) · 방금 부팅이어도 needs-restarting 은 건너뛴다
  const a = runCase({ F20: '1', F40: '1', DHM: '0305', SSH_CONNECTION: '10.1.2.3 51515 10.0.0.9 22' });
  assert.equal(a.v.selfIp, '10.1.2.3', '반증 F5: 수집 세션 출발 주소(자기 세션 SSH_CONNECTION 첫 칸)');
  assert.equal(runCase({ F20: '0', F40: '0', DHM: '1234', SSH_CONNECTION: '$(id) 1 2 3' }).v.selfIp, null, '형식 밖 주소는 버린다');
  assert.deepEqual(a.calls, ['dnf'], `dnf 만(${a.calls})`); assert.equal(a.v.nrSkipped, true); assert.equal(a.v.dnf?.[0]?.id, 7);
  // 20~40분 — needs-restarting 만
  const b = runCase({ F20: '0', F40: '1', DHM: '1234' });
  assert.deepEqual(b.calls, ['nr'], `needs-restarting 만(${b.calls})`); assert.equal(b.v.needsRestart, false);
  // 변화 없음 · 매일 창 — needs-restarting 만
  const c = runCase({ F20: '0', F40: '0', DHM: '0905' });
  assert.deepEqual(c.calls, ['nr']);
  // 변화 없음 · 창 밖 — 방금 부팅이 아니면 아무것도 돌지 않는다
  const d = runCase({ F20: '0', F40: '0', DHM: '1234' });
  assert.deepEqual(d.calls, justBooted ? ['nr'] : [], `창 밖(${d.calls})`);
  // 어떤 경우에도 둘이 함께가 아니다
  for (const r of [a, b, c, d]) assert.ok(!(r.calls.includes('nr') && r.calls.includes('dnf')), '한 주기에 둘 다 돌지 않는다');
  // dnf 가 없으면(PATH 에서 찾을 수 없음) 20분 안에도 needs-restarting 이 돈다 — 가짜 dnf 를 지운 PATH(실제 dnf 가 있는 러너는 건너뜀)
  if (!realDnf) {
    fs.rmSync(path.join(bin, 'dnf'));
    const e = runCase({ F20: '1', F40: '1', DHM: '1234' });
    assert.deepEqual(e.calls, ['nr'], 'dnf 없음 → needs-restarting');
  }
});

/* ③ 실제 collectOsUsage — 자식 프로세스(ssh2 Client 만 가짜: 로컬 dash) */
const SSH2 = pathToFileURL(createRequire(fileURLToPath(new URL('../src/proxy/sshExec.js', import.meta.url))).resolve('ssh2')).href;
const OS_URL = new URL('../src/bmusage/collectors/osSsh.js', import.meta.url).href;
const CHILD = `
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
const FAKE = process.env.BUD_FAKEBIN; const execs = []; let dropped = 0;
class FakeClient extends EventEmitter {
  connect() { setImmediate(() => this.emit('ready')); }
  exec(cmd, a, b) {
    const cb = typeof a === 'function' ? a : b;
    execs.push(cmd.includes('_tsrc=proc') ? 'top' : cmd.includes("echo '##STAT'") ? 'main' : cmd.includes('##PSCPU') ? 'snap' : 'other');
    if (process.env.BUD_FAIL_TOP === '1' && cmd.includes('_tsrc=proc')) { setImmediate(() => cb(new Error('channel open failure'))); return; }
    // ⚠ spawn · 배선 · cb 를 **한 차례**(같은 setImmediate)에서 한다 — 출력은 리스너가 붙은 뒤에만 흐른다. 예전에는 spawn 을 먼저 하고 cb 를 다음 차례로 미뤄,
    //   그 사이 이벤트 루프가 I/O 를 한 번 돌면 첫 출력 묶음(head -c 의 4KB — STAT · MEM 구획)이 리스너 없는 EventEmitter 로 버려졌다
    //   (CI 간헐 실패: ok 인데 CPU · 메모리 없음 — DF 앞 출력이 4KB 를 넘는 러너 + 부하로 부모가 밀릴 때). 진짜 ssh2 채널은 스트림이라 버퍼에 둔다 — 이 가짜만의 결함.
    //   BUD_STALL_MS: spawn 직후 부모가 밀려나는 상황을 흉내 낸다(시험 ④).
    setImmediate(() => {
      const ch = spawn('/bin/dash', ['-c', cmd], { env: { ...process.env, PATH: FAKE + ':' + process.env.PATH }, detached: true });
      if (Number(process.env.BUD_STALL_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BUD_STALL_MS));
      const st = new EventEmitter(); st.stderr = new EventEmitter();
      ch.stdout.on('data', (d) => { if (!st.listenerCount('data')) dropped += d.length; st.emit('data', d); }); ch.stderr.on('data', (d) => st.stderr.emit('data', d));
      ch.on('close', (code) => st.emit('close', code));
      st.close = () => { try { process.kill(-ch.pid, 'SIGKILL'); } catch {} }; st.destroy = st.close; st.signal = () => {};
      cb(null, st);
    });
  }
  end() { setImmediate(() => this.emit('close')); }
}
mock.module(${JSON.stringify(SSH2)}, { namedExports: { Client: FakeClient } });
const OS = await import(${JSON.stringify(OS_URL)});
const opts = JSON.parse(process.env.BUD_OPTS || '{}');
const t0 = Date.now();
const r = await OS.collectOsUsage({ host: '10.9.9.9', username: 'u', password: 'p', mounts: ['/'] }, opts);
const top = r.perf?.top || null;
process.stdout.write('@@' + JSON.stringify({ ms: Date.now() - t0, ok: r.ok, error: r.error || null, cpu: !!r.counters?.cpu, mem: !!r.mem?.totalBytes, changes: !!r.perf?.changes?.value,
  missing: r.missing || null, read: r.read || null, dfi: r.perf?.dfi ? { missing: !!r.perf.dfi.missing, absent: !!r.perf.dfi.absent } : null, disks: (r.counters?.disks || []).length, nets: (r.counters?.nets || []).length,
  dropped, top: top ? { missing: !!top.missing, off: !!top.value?.off, src: top.value?.src || null, cands: top.value?.candidates ?? null, error: top.error || null, skipped: top.skipped || null } : null, execs }) + '\\n');
process.exit(0);
`;
function runChild(env, timeoutMs = 120_000) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bm8bbud-cfg-'));
  try {
    const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', CHILD],
      { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env } });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
    assert.ok(line, `자식 출력 없음: ${String(r.stderr || '').slice(0, 600)}`);
    return JSON.parse(line.slice(2));
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
}

test('③ 실제 collectOsUsage — 멈추는 명령이 다 시한까지 가도 주 표본은 살아남고 Top-N 은 같은 세션의 별도 exec(반증 r-f1)', { timeout: 150_000 }, async (t) => {
  if (!fs.existsSync('/bin/dash')) return t.skip('dash 없음');
  const hang = 'exec sleep 100';
  const bin = fakeBin({ systemctl: hang, chronyc: hang, dmesg: hang, 'needs-restarting': hang, dnf: hang, top: hang, df: hang,   // df — 1회차 점검 D2(멈춘 마운트)
    // 패키지 DB 가 방금 바뀐 것처럼(dnf 차례) · 매일 창(03:00 — needs-restarting 도 해당) → 배타 쌍의 최악
    find: 'case "$*" in *rpm*) echo /var/lib/rpm/rpmdb.sqlite;; esac; exit 0', date: '[ "$1" = "+%H%M" ] && { echo 0300; exit 0; }; exec /bin/date "$@"' });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const r = runChild({ BUD_FAKEBIN: bin, BUD_OPTS: JSON.stringify({ top: true }) });
  assert.equal(r.ok, true, `주 표본이 살아남는다(예전: ok:false · 전 구획 유실) — ${r.error}`);
  assert.ok(r.cpu && r.mem && r.changes, `CPU · 메모리 · 변경 사실 구획이 있다(read ${r.read} · missing ${r.missing} · 버린 출력 ${r.dropped}B)`);
  assert.equal(r.dropped, 0, '가짜 스트림이 리스너 없이 흘린 출력이 없다');
  // 1회차 점검 D2: df 가 멈추면 그 구획(디스크 사용 공간)만 못 읽음 — 나머지(디스크 I/O · 네트워크)는 산다 · inode 구획도 값 없음(0 이 아니다)
  assert.ok(r.missing.includes('diskspace'), `디스크 사용 공간만 missing(${r.missing})`);
  assert.ok(r.read.includes('cpu') && r.read.includes('mem') && r.read.includes('diskio') && r.read.includes('net'), `나머지 구획은 읽었다(${r.read})`);
  assert.ok(r.disks > 0 && r.nets > 0);
  assert.ok(r.dfi && (r.dfi.absent || r.dfi.missing), `inode 구획은 값 없음(${JSON.stringify(r.dfi)})`);
  assert.deepEqual(r.execs, ['main', 'top'], '주 명령 → Top-N exec(같은 세션)');
  assert.ok(r.top && !r.top.missing && r.top.src === 'proc' && r.top.cands > 0, `top 이 멈추면 /proc 대안(${JSON.stringify(r.top)})`);
  assert.ok(r.ms < OS.SESSION_BUDGET_MS, `세션 ${r.ms}ms < 예산`);
  // Top-N exec 이 실패해도 본 표본은 그대로 · top 만 missing(빠른 PATH — 멈춤 없음)
  const bin2 = fakeBin({ systemctl: 'exit 1', chronyc: 'exit 1', dmesg: 'exit 1' });
  t.after(() => fs.rmSync(bin2, { recursive: true, force: true }));
  const f = runChild({ BUD_FAKEBIN: bin2, BUD_FAIL_TOP: '1', BUD_OPTS: JSON.stringify({ top: true }) });
  assert.equal(f.ok, true); assert.ok(f.cpu && f.mem);
  assert.equal(f.top.missing, true); assert.match(String(f.top.error), /channel open failure/, 'Top-N 실패는 그 칸만');
  // 끔(설정 top.on=false · 기본값) — Top-N exec 없음 · ‘꺼짐’
  const off = runChild({ BUD_FAKEBIN: bin2, BUD_OPTS: JSON.stringify({}) });
  assert.deepEqual(off.execs, ['main']); assert.equal(off.top.off, true, '기본값은 끔(호출부가 켜야 돈다)');
  // 집중 모니터링과 같은 옵션(예산 · 피크 창 0 · 스냅샷 exec) — Top-N exec 이 없다(반증 F10)
  const fo = runChild({ BUD_FAKEBIN: bin2, BUD_OPTS: JSON.stringify({ budgetMs: FOCUS.FOCUS_BUDGET_MS, partitionIo: false, peakWindowS: 0, top: false,
    extraCommands: [{ name: 'snap', cmd: SNAP.FOCUS_SNAPSHOT_COMMAND, timeoutMs: 12_000, maxBytes: 16 * 1024 }] }) });
  assert.equal(fo.ok, true); assert.deepEqual(fo.execs, ['main', 'snap'], '집중 경로: 주 명령 + 스냅샷만'); assert.equal(fo.top.off, true);
});

/*
 * ④ 가짜 SSH 스트림의 출력 유실 — ③ 이 CI 에서 간헐 실패한 원인(2026-11-17 재현: release run 1149 · 1153 · ci main 10:39Z).
 *   예전 하네스는 spawn 을 먼저 하고 cb(리스너 부착)를 다음 setImmediate 로 미뤘다 — 그 사이 이벤트 루프가 I/O 를 돌면 출력이 리스너 없는 EventEmitter 로 사라졌다.
 *   ③ 에서는 DF 앞 출력이 4KB(head -c 의 첫 묶음)를 넘는 러너에서만 첫 묶음(STAT · MEM)이 버려져 'ok 인데 CPU · 메모리 없음' 이 됐다(이 컨테이너는 3.7KB 라 재현되지 않았다).
 *   여기서는 멈춤 없는 빠른 PATH 로 출력 전체가 지연 안에 끝나게 해 같은 결함을 매번 드러낸다(예전 하네스: ok:false · 약 9KB 유실).
 */
test('④ 가짜 SSH 스트림 — spawn 직후 부모가 밀려나도 출력을 잃지 않는다(③ CI 간헐 실패의 원인)', { timeout: 60_000 }, (t) => {
  if (!fs.existsSync('/bin/dash')) return t.skip('dash 없음');
  const bin = fakeBin({ systemctl: 'exit 1', chronyc: 'exit 1', dmesg: 'exit 1' });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const r = runChild({ BUD_FAKEBIN: bin, BUD_STALL_MS: '300', BUD_OPTS: JSON.stringify({}) });
  assert.equal(r.dropped, 0, `리스너 없이 버린 출력 ${r.dropped}B`);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.cpu && r.mem && r.changes, `read ${r.read} · missing ${r.missing}`);
});
