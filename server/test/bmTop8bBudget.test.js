/**
 * 8b 반증 F1 · S1 · F10 — **SSH 세션 시한 산수**(구획 안 timeout 합 < exec 시한)와 실제 수집 경로.
 *
 *   ① 기계 산수: 명령 문자열에서 `timeout N` · `sleep N` 을 뽑아 합 + 여유 ≤ exec 시한
 *      · 주 명령(linuxCommand — 샘플러 끔/켬 · 8b 끔/켬 같음: Top-N 은 주 명령 밖) — needs-restarting ↔ dnf 는 한 주기에 하나(②가 실제 셸로 확인)
 *      · Top-N 별도 exec(topCommand) · 전 프로세스 /proc 읽기 · ps 는 모두 timeout 안(S1)
 *      · 집중 모니터링 경로(run.js — top:false 명시 · 스냅샷 exec)
 *      ⚠ 8b 이전부터의 결함: 주 명령 최악 합이 34초(> 30초)였다 — 이 시험이 없어서 고정되지 않았다(반증 F1).
 *   ② 실제 셸(dash): CHANGES 조각을 가짜 find · dnf · needs-restarting(호출 기록)으로 돌려 둘이 한 주기에 함께 돌지 않는지
 *   ③ 실제 collectOsUsage + 실제 sshExec(exec 시한 · 출력 버림) — ssh2 Client 만 로컬 dash 로 바꾼 자식 프로세스(--experimental-test-module-mocks).
 *      가짜 PATH 에서 systemctl · chronyc · dmesg · needs-restarting · dnf · top 이 전부 멈춤(`sleep 100`) → 주 표본이 살아남고(ok · CPU · 메모리) Top-N 은 /proc 대안으로.
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
const SRC = (p) => fs.readFileSync(path.join(import.meta.dirname, '../src', p), 'utf8');
const DASH = ['/bin/dash', '/bin/sh'].find((x) => fs.existsSync(x));

/** 명령 문자열 → [{ s, what }](timeout) · [s](sleep). `timeout -k 1 2 cmd` 꼴의 선택 인자도 넘는다. */
export function waitsOf(cmd) {
  const t = [...String(cmd).matchAll(/\btimeout\s+(?:-[a-zA-Z]+\s+\S+\s+)*(\d+(?:\.\d+)?)s?\s+(\S+)/g)].map((m) => ({ s: Number(m[1]), what: m[2] }));
  const sl = [...String(cmd).matchAll(/\bsleep\s+(\d+(?:\.\d+)?)\b/g)].map((m) => Number(m[1]));
  return { t, sl };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('① 기계 산수 — 주 명령 · Top-N exec · 집중 경로: 안 timeout · sleep 합 + 여유 ≤ exec 시한', () => {
  assert.equal(OS.CMD_TIMEOUT_MS, 30_000, '운영 기본값(env 없음)');
  for (const sampler of [false, true]) {
    const cmd = OS.linuxCommand(['/'], { sampler });
    // 8b 끔/켬: Top-N 은 주 명령 밖이라 옵션이 주 명령을 바꾸지 않는다(반증 F1 — 예전에는 켬이면 +3초 timeout +1초 대기)
    assert.equal(OS.linuxCommand(['/'], { sampler, top: true }), cmd, '주 명령은 top 옵션과 무관');
    const { t, sl } = waitsOf(cmd);
    assert.ok(t.length >= 6, `timeout 을 뽑았다(${t.length})`);
    const nr = t.filter((x) => x.what === 'needs-restarting'); const dnf = t.filter((x) => x.what === 'dnf');
    assert.equal(nr.length, 1); assert.equal(dnf.length, 1, 'needs-restarting · dnf 는 하나씩(배타 쌍 — ② 가 실제 셸로 확인)');
    assert.match(cmd, /\[ "\$_dh" = 1 \] && nrr=0;/, 'dnf 차례면 needs-restarting 을 건너뛰는 장치');
    const worstS = sum(t.map((x) => x.s)) - Math.min(nr[0].s, dnf[0].s) + sum(sl);
    assert.ok(worstS * 1000 + OS.CMD_INNER_MARGIN_MS <= OS.CMD_TIMEOUT_MS,
      `sampler=${sampler}: 주 명령 최악 ${worstS}초 + 여유 ${OS.CMD_INNER_MARGIN_MS / 1000}초 ≤ ${OS.CMD_TIMEOUT_MS / 1000}초(${t.map((x) => `${x.what} ${x.s}`).join(' · ')})`);
    // 예전 값(배타 없이 8 + 8)이면 넘는다 — 산수가 실제로 무엇을 막는지 고정
    assert.ok((sum(t.map((x) => x.s)) - nr[0].s - dnf[0].s + 8 + 8) * 1000 > OS.CMD_TIMEOUT_MS - OS.CMD_INNER_MARGIN_MS, '예전 최악(34초)은 이 산수를 넘었다');
  }
  // Top-N 별도 exec — 전부 합(배타 없음) + 여유 5초 ≤ TOP_EXEC_TIMEOUT_MS · 그 시한은 세션 예산 안(남은 예산과 작은 쪽)
  for (const forceProc of [false, true]) {
    const { t, sl } = waitsOf(T.topCommand({ forceProc }));
    const worst = sum(t.map((x) => x.s)) + sum(sl);
    assert.ok(worst * 1000 + 5_000 <= T.TOP_EXEC_TIMEOUT_MS, `Top-N 최악 ${worst}초 + 여유 5초 ≤ ${T.TOP_EXEC_TIMEOUT_MS / 1000}초`);
  }
  assert.ok(T.TOP_EXEC_TIMEOUT_MS < OS.SESSION_BUDGET_MS - 15_000, 'Top-N exec 시한 < 세션 예산 − READY');
  // S1: 전 프로세스 · 후보 /proc 읽기와 ps 는 모두 timeout 안 — 커널 잠금 대기로 멈춰도 그 칸만 빈다
  const tc = T.TOP_COMMAND;
  const reads = [...tc.matchAll(/(\S+ \S+ )?(grep -H |ps -eo )/g)];
  assert.equal(reads.length, 7, `/proc 읽기(grep -H) · ps 7곳(io 전체 · stat 전체 ×2 · 후보 io · stat · status · ps) — ${reads.length}`);
  for (const m of reads) assert.match(m[1] || '', /(?:^|\W)timeout \d+ $/, `시한 없는 읽기: ${m[0].slice(0, 60)}`);
  assert.match(tc, new RegExp(`timeout ${T.TOP_TIMEOUT_S} top -b`));
  // 집중 모니터링(반증 F10): run.js 가 top:false 를 명시 · 주 명령은 같은 산수 · 스냅샷 exec 은 자기 시한(12초) 안
  const fr = SRC('bmusage/focus/run.js');
  assert.match(fr, /_D\.collectOs\(tg\.osHost, \{[\s\S]{0,900}?top: false,[\s\S]{0,40}?\}\), '집중 수집 시한 초과'\)/, '집중 경로는 Top-N 을 끈다');
  const snapTmo = Number(/name: 'snap', cmd: FOCUS_SNAPSHOT_COMMAND, timeoutMs: (\d[\d_]*)/.exec(fr)?.[1]?.replace(/_/g, ''));
  assert.ok(snapTmo > 0);
  const sw = waitsOf(SNAP.FOCUS_SNAPSHOT_COMMAND);
  assert.ok((sum(sw.t.map((x) => x.s)) + sum(sw.sl)) * 1000 + 5_000 <= snapTmo, '집중 스냅샷 안 대기 + 여유 ≤ 스냅샷 exec 시한');
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
const FAKE = process.env.BUD_FAKEBIN; const execs = [];
class FakeClient extends EventEmitter {
  connect() { setImmediate(() => this.emit('ready')); }
  exec(cmd, a, b) {
    const cb = typeof a === 'function' ? a : b;
    execs.push(cmd.includes('_tsrc=proc') ? 'top' : cmd.includes("echo '##STAT'") ? 'main' : cmd.includes('##PSCPU') ? 'snap' : 'other');
    if (process.env.BUD_FAIL_TOP === '1' && cmd.includes('_tsrc=proc')) { setImmediate(() => cb(new Error('channel open failure'))); return; }
    const ch = spawn('/bin/dash', ['-c', cmd], { env: { ...process.env, PATH: FAKE + ':' + process.env.PATH }, detached: true });
    const st = new EventEmitter(); st.stderr = new EventEmitter();
    ch.stdout.on('data', (d) => st.emit('data', d)); ch.stderr.on('data', (d) => st.stderr.emit('data', d));
    ch.on('close', (code) => st.emit('close', code));
    st.close = () => { try { process.kill(-ch.pid, 'SIGKILL'); } catch {} }; st.destroy = st.close; st.signal = () => {};
    setImmediate(() => cb(null, st));
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
  top: top ? { missing: !!top.missing, off: !!top.value?.off, src: top.value?.src || null, cands: top.value?.candidates ?? null, error: top.error || null, skipped: top.skipped || null } : null, execs }) + '\\n');
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
  const bin = fakeBin({ systemctl: hang, chronyc: hang, dmesg: hang, 'needs-restarting': hang, dnf: hang, top: hang,
    // 패키지 DB 가 방금 바뀐 것처럼(dnf 차례) · 매일 창(03:00 — needs-restarting 도 해당) → 배타 쌍의 최악
    find: 'case "$*" in *rpm*) echo /var/lib/rpm/rpmdb.sqlite;; esac; exit 0', date: '[ "$1" = "+%H%M" ] && { echo 0300; exit 0; }; exec /bin/date "$@"' });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const r = runChild({ BUD_FAKEBIN: bin, BUD_OPTS: JSON.stringify({ top: true }) });
  assert.equal(r.ok, true, `주 표본이 살아남는다(예전: ok:false · 전 구획 유실) — ${r.error}`);
  assert.ok(r.cpu && r.mem && r.changes, 'CPU · 메모리 · 변경 사실 구획이 있다');
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
