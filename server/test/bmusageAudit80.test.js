/**
 * bmusageAudit80.test.js — 전체 점검 80회차(베어메탈 사용률 2차 ② — 파서 · 수집기 · 튜닝 · 집중 · 프로파일 · 스냅샷).
 *
 *  F1(재현) 튜닝 탭 · gpdb 프로파일의 HDD 스케줄러 항목이 HDD 위 LVM(dm-*) · 소프트웨어 RAID(md*)를 ‘권고’ 로 판정했다 — 그 장치는 rotational=1 이고
 *     `/sys/block/<dev>/queue/scheduler` 가 'none' 하나뿐(bio 기반 큐 — 스케줄러를 고를 수 없다)이라 mq-deadline · bfq 를 권할 수 없다.
 *     흔한 구성(HDD RAID 가상 디스크 + LVM)이면 항목 · 프로파일이 늘 권고였다. → 스케줄러 항목(sched)에서 고를 수 없는 장치의 권고는 참고(noSched).
 *  F2(재현 — 8b 반증 S1 의 형제) 진단 스냅샷 · 집중 모니터링 경량 스냅샷의 /proc/<pid>/io 읽기에 시한이 없었다 — 한 프로세스가 붙잡으면 진단 스냅샷은
 *     명령 전체가 exec 시한(30초)에 걸려 **전 구획**(ps 상위 · ss · 커널 로그)을 잃었다. → 표본마다 timeout(그 칸만 줄어든다).
 *  F3(재현) grep 을 timeout 이 끊으면 블록 버퍼(4KB) 경계에서 마지막 줄이 숫자 중간에서 잘린다 — Top-N 의 첫 /proc/<pid>/io 읽기(8b) · 스냅샷 첫 표본이 작게 읽혀
 *     (둘째 − 첫째) ÷ 경과가 부풀어 가짜 I/O 상위가 된다(1단계 D1 과 같은 유형). → `--line-buffered`(온전한 줄만).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const { parseBlkq } = await import('../src/bmusage/parse/linuxProc.js');
const { judgeTuning, noSchedChoice } = await import('../src/bmusage/tuning/judge.js');
const { TUNING_REASON } = await import('../src/bmusage/tuning/catalog.js');
const { profileView } = await import('../src/bmusage/profiles/match.js');
const SNAP = await import('../src/bmusage/snapshot/command.js');
const RUN = await import('../src/bmusage/snapshot/run.js');
const T = await import('../src/bmusage/parse/linuxTop.js');

const SRC = (p) => fs.readFileSync(path.join(import.meta.dirname, '../src', p), 'utf8');
const DASH = ['/bin/dash', '/bin/sh'].find((x) => fs.existsSync(x));
const HAS = (bin) => { try { execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };

/* ── F1 ── */
const BLKQ_LINES = [
  // HDD RAID 가상 디스크(sda) — mq 큐(선택지 있음) · 그 위 LVM dm-0 · dm-1 과 md0(bio 기반 — 커널이 'none' 만 낸다)
  '/sys/block/sda/queue/scheduler:[mq-deadline] kyber bfq none', '/sys/block/sda/queue/rotational:1',
  '/sys/block/dm-0/queue/scheduler:none', '/sys/block/dm-0/queue/rotational:1',
  '/sys/block/dm-1/queue/scheduler:none', '/sys/block/dm-1/queue/rotational:1',
  '/sys/block/md0/queue/scheduler:none', '/sys/block/md0/queue/rotational:1',
];
const itemOf = (j, id) => j.items.find((x) => x.id === id);
const gpdbTuning = (tu, key) => profileView({ tuning: { ...tu, accounts: ['gpadmin'], procs: { list: ['postgres'] } } }).profiles.find((p) => p.id === 'gpdb').tunings.find((t) => t.key === key);

test('F1 — HDD 위 LVM(dm-*) · md* 의 스케줄러 \'none\' 은 권고가 아니다(고를 수 없다) — 카탈로그 · gpdb 둘 다 · 물리 디스크는 예전대로', () => {
  const blkq = parseBlkq(BLKQ_LINES);
  assert.deepEqual(blkq.find((d) => d.name === 'dm-0').schedulers, ['none'], '파서: bio 기반 큐는 선택지가 none 하나');
  const tu = { blkq, sections: { blkq: 'ok' }, sysctl: {} };
  const it = itemOf(judgeTuning({ tuning: tu }), 'disk.hddSched');
  assert.equal(it.status, 'ok', `항목 상태 — 물리 디스크(sda mq-deadline)만 판정에 남는다: ${JSON.stringify(it.devices)}`);
  for (const n of ['dm-0', 'dm-1', 'md0']) {
    const d = it.devices.find((x) => x.name === n);
    assert.equal(d.status, 'info', `${n} 참고`); assert.equal(d.reason, 'noSched', `${n} 사유`);
  }
  const gp = gpdbTuning(tu, 'gp.schedHdd');
  assert.equal(gp.status, 'ok', `gpdb 요구값도 같은 판정: ${JSON.stringify(gp.devices)}`);
  // 물리 디스크가 'none'(선택지 있음 — 멀티큐 HBA 에서 바꾼 경우)이면 예전대로 권고
  const tu2 = { blkq: parseBlkq(['/sys/block/sdb/queue/scheduler:[none] mq-deadline kyber bfq', '/sys/block/sdb/queue/rotational:1', ...BLKQ_LINES.slice(2)]), sections: { blkq: 'ok' }, sysctl: {} };
  assert.equal(itemOf(judgeTuning({ tuning: tu2 }), 'disk.hddSched').status, 'advise', '고를 수 있는 물리 디스크의 none 은 여전히 권고');
  assert.equal(gpdbTuning(tu2, 'gp.schedHdd').status, 'advise');
  // 관리자 덮어쓰기로 NVMe 를 mq-deadline 으로 정해도 다중 경로 머리(bio 기반 'none')는 권고하지 않는다
  const tu3 = { blkq: parseBlkq(['/sys/block/nvme0n1/queue/scheduler:none', '/sys/block/nvme0n1/queue/rotational:0']), sections: { blkq: 'ok' }, sysctl: {} };
  const ov = itemOf(judgeTuning({ tuning: tu3, overrides: { 'disk.nvmeSched': { value: 'mq-deadline', by: 'override:all' } } }), 'disk.nvmeSched');
  assert.equal(ov.devices[0].status, 'info'); assert.equal(ov.devices[0].reason, 'noSched');
  // 선택지 목록이 없는 옛 행(엣지 정제 [] · 필드 없음)은 예전 판정 그대로(조용히 바꾸지 않는다)
  assert.equal(noSchedChoice({ scheduler: 'none' }), false); assert.equal(noSchedChoice({ scheduler: 'none', schedulers: [] }), false);
  const old = itemOf(judgeTuning({ tuning: { blkq: [{ name: 'dm-0', scheduler: 'none', schedulers: [], rotational: true }], sections: { blkq: 'ok' }, sysctl: {} } }), 'disk.hddSched');
  assert.equal(old.status, 'advise', '근거(선택지 목록) 없이는 바꾸지 않는다');
  // 사유 code 는 서버 열거 · 웹 문구 표에 같이 있다(웹 bmOpsText.test 가 1:1 대조)
  assert.ok(TUNING_REASON.includes('noSched'));
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '../../web/src/views/tools/bmOpsText.js'), 'utf8'), /\n {2}noSched: '/);
  // 스케줄러 항목은 전부 sched 표지(카탈로그 둘 · gpdb 셋) — 새 스케줄러 항목이 빠지지 않게
  const cat = SRC('bmusage/tuning/catalog.js'); const gpdb = SRC('bmusage/profiles/gpdb.js');
  const schedItems = (src) => [...src.matchAll(/devValue: \(d\) => d\.scheduler,([^\n]*)/g)].map((m) => /\bsched: true\b/.test(m[1]));
  assert.deepEqual(schedItems(cat), [true, true]); assert.deepEqual(schedItems(gpdb), [true, true, true]);
});

/* ── F2 ── */
/** 명령 문자열의 timeout · sleep 합(초) — bmTop8bBudget 의 worstOf 와 같은 셈(함수 정의 없음). */
function waitsSum(cmd) {
  const t = [...String(cmd).matchAll(/\btimeout\s+(\d+(?:\.\d+)?)s?\s+\S+/g)].map((m) => Number(m[1]));
  const s = [...String(cmd).matchAll(/\bsleep\s+(\d+(?:\.\d+)?)\b/g)].map((m) => Number(m[1]));
  return [...t, ...s].reduce((a, b) => a + b, 0);
}

test('F2 — 스냅샷 /proc/<pid>/io 읽기는 표본마다 timeout 안 · 줄 단위 출력 — 안 대기 합 + 여유 ≤ exec 시한(진단 · 집중 둘 다)', () => {
  for (const [name, cmd] of [['진단', SNAP.SNAPSHOT_COMMAND], ['집중', SNAP.FOCUS_SNAPSHOT_COMMAND]]) {
    const reads = [...cmd.matchAll(/(\S+ \S+ )?grep -s -H /g)];
    assert.equal(reads.length, 2, `${name}: io 표본 두 번`);
    for (const m of reads) assert.match(m[1] || '', /^timeout \d+ $/, `${name}: 시한 없는 io 읽기`);
    assert.equal([...cmd.matchAll(/grep -s -H --line-buffered -E '\^\(read_bytes\|write_bytes\):' \/proc\/\[0-9\]\*\/io/g)].length, 2, `${name}: --line-buffered`);
  }
  assert.ok(waitsSum(SNAP.SNAPSHOT_COMMAND) * 1000 + 5_000 <= RUN.SNAPSHOT_CMD_MS, `진단 스냅샷 안 대기 ${waitsSum(SNAP.SNAPSHOT_COMMAND)}초 + 여유 5초 ≤ ${RUN.SNAPSHOT_CMD_MS / 1000}초`);
  const fr = SRC('bmusage/focus/run.js');
  const snapTmo = Number(/name: 'snap', cmd: FOCUS_SNAPSHOT_COMMAND, timeoutMs: (\d[\d_]*)/.exec(fr)?.[1]?.replace(/_/g, ''));
  assert.ok(waitsSum(SNAP.FOCUS_SNAPSHOT_COMMAND) * 1000 + 5_000 <= snapTmo, `집중 스냅샷 안 대기 ${waitsSum(SNAP.FOCUS_SNAPSHOT_COMMAND)}초 + 여유 5초 ≤ ${snapTmo / 1000}초`);
});

function fakeBin(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-audit80-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return d;
}

test('F2 — 실제 셸: /proc/<pid>/io 읽기가 멈춰도(가짜 grep) 진단 스냅샷이 시한 안에 끝나고 ps · ss · 커널 로그 구획이 남는다 · 예전 명령은 끝나지 않았다', (t) => {
  if (!DASH || !HAS('timeout')) return t.skip('dash · timeout 없음');
  const realGrep = execFileSync('/bin/sh', ['-c', 'command -v grep'], { encoding: 'utf8' }).trim();
  // /proc/…/io 를 읽는 grep 만 멈춘다(커널 exec 잠금 대기 흉내) — 나머지 grep 은 진짜로
  const bin = fakeBin({ grep: `case "$*" in *"/io"*) exec sleep 60;; esac; exec ${realGrep} "$@"` });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const t0 = Date.now();
  const out = execFileSync(DASH, ['-c', SNAP.SNAPSHOT_COMMAND], { encoding: 'utf8', timeout: 20_000, env, maxBuffer: 8 << 20 });
  const ms = Date.now() - t0;
  assert.ok(ms < RUN.SNAPSHOT_CMD_MS - 5_000, `시한 안에 끝남(${ms}ms)`);
  const r = SNAP.parseSnapshot(out, { topN: 5, dmesgLines: 5 });
  assert.equal(r.truncated, false, '##END 도착');
  assert.equal(r.states.cpu, 'ok'); assert.equal(r.states.mem, 'ok');
  assert.ok(['perm', 'partial'].includes(r.states.io), `io 칸만 줄어든다(${r.states.io})`);
  // 예전 명령(시한 없는 io 읽기) — 같은 가짜 grep 이면 exec 시한까지 끝나지 않는다(그 사이 모은 출력은 sshExec 가 버린다)
  const OLD = SNAP.SNAPSHOT_COMMAND.split(`timeout ${SNAP.SNAPSHOT_IO_TIMEOUT_S} grep -s -H --line-buffered `).join('grep -s -H ');
  assert.notEqual(OLD, SNAP.SNAPSHOT_COMMAND);
  const old = spawnSync(DASH, ['-c', OLD], { encoding: 'utf8', timeout: 8_000, env, killSignal: 'SIGKILL' });
  assert.ok(old.error?.code === 'ETIMEDOUT' || old.signal === 'SIGKILL', '예전 명령은 8초 안에 끝나지 않았다');
});

/* ── F3 ── */
test('F3 — timeout 이 끊은 grep: 블록 버퍼는 마지막 줄을 숫자 중간에서 자른다 · --line-buffered 는 온전한 줄만(실제 GNU grep) — Top-N 두 io 읽기 · 스냅샷 표본이 쓴다', (t) => {
  // Top-N(8b) 의 전 프로세스 · 후보 io 읽기도 줄 단위(시한 · 접두는 bmTop8bBudget 이 고정)
  const tc = T.topCommand();
  assert.equal([...tc.matchAll(/timeout \d+ grep -H --line-buffered -E '\^\(read\|write\)_bytes:'/g)].length, 2, 'Top-N io 읽기 두 곳');
  assert.equal([...tc.matchAll(/grep -H -E '\^\(read\|write\)_bytes:'/g)].length, 0, '블록 버퍼 io 읽기 없음');
  if (!HAS('timeout') || !HAS('mkfifo')) return t.skip('timeout · mkfifo 없음');
  const grepV = spawnSync('grep', ['--version'], { encoding: 'utf8' });
  if (!/GNU grep/.test(grepV.stdout || '')) return t.skip('GNU grep 아님');
  // 가짜 /proc: 프로세스 300개 io + 마지막에 FIFO(읽기가 멈춘다 — exec 잠금 대기 흉내)
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-audit80-proc-'));
  t.after(() => fs.rmSync(D, { recursive: true, force: true }));
  for (let i = 100; i < 400; i += 1) { fs.mkdirSync(path.join(D, String(i))); fs.writeFileSync(path.join(D, String(i), 'io'), `rchar: 1\nread_bytes: 123456789${i}\nwrite_bytes: 987654321${i}\n`); }
  fs.mkdirSync(path.join(D, '400')); execFileSync('mkfifo', [path.join(D, '400', 'io')]);
  const run = (lb) => spawnSync('/bin/sh', ['-c', `timeout 1 grep -s -H ${lb ? '--line-buffered ' : ''}-E '^(read_bytes|write_bytes):' ${D}/[0-9]*/io`], { encoding: 'utf8', timeout: 10_000 });
  const blk = run(false); const lb = run(true);
  assert.equal(blk.status, 124); assert.equal(lb.status, 124);
  assert.ok(blk.stdout.length > 0 && !blk.stdout.endsWith('\n'), `블록 버퍼: 마지막 줄이 잘린다(${blk.stdout.length}바이트 · ${JSON.stringify(blk.stdout.slice(-24))})`);
  assert.ok(lb.stdout.endsWith('\n'), '--line-buffered: 온전한 줄로 끝난다');
  for (const l of lb.stdout.split('\n').filter(Boolean)) assert.match(l, /io:(read|write)_bytes: \d{12}$/, `잘린 줄 없음: ${l.slice(-40)}`);
});

test('F3 — 스냅샷 awk: 첫 표본이 숫자 중간에서 잘린 줄이면 가짜 I/O 가 생긴다(예전 판의 결과) — 줄 단위 출력이면 생기지 않는다', (t) => {
  if (!HAS('awk')) return t.skip('awk 없음');
  // IO 구획 조각(상수)에서 awk 프로그램만 떼어 같은 입력을 먹인다(명령 문자열 그대로 — 사본을 만들지 않는다)
  const m = /\| (awk -F'\[\/:\]' '[\s\S]*?\}\s*\}') \| head -n/.exec(SNAP.SNAPSHOT_COMMAND);
  assert.ok(m, 'IO awk 조각');
  const feed = (first) => spawnSync('/bin/sh', ['-c', m[1]], { input: ['t=100.00', ...first, '@@', 't=102.00', '/proc/7/io:read_bytes: 4096000', '/proc/7/io:write_bytes: 0', ''].join('\n'), encoding: 'utf8' }).stdout;
  const cut = feed(['/proc/7/io:read_bytes: 40', '/proc/7/io:write_bytes: 0']);   // 4096000 이 '40' 으로 잘린 첫 표본(예전 블록 버퍼 + 끊김)
  const whole = feed(['/proc/7/io:read_bytes: 4096000', '/proc/7/io:write_bytes: 0']);
  assert.match(cut, /^io 7 4095960 0 /m, '잘린 첫 표본 → 2초에 4MB 를 읽은 가짜 1위');
  assert.doesNotMatch(whole, /^io 7 /m, '온전한 표본 → 차이 0(목록에 없음)');
});

/* ── 개선 ── */
test('개선 — ##NETINFO 속도 4294967295(부호 없는 SPEED_UNKNOWN) · 65535(u16 -1)는 모르는 속도(null) — 실제 등급은 그대로', async () => {
  const { parseNetInfo } = await import('../src/bmusage/parse/linuxProc.js');
  const m = parseNetInfo(['eth0 4294967295 up 1', 'eth1 65535 up 1', 'eth2 25000 up 1', 'eth3 -1 down 1', 'eth4 100000 up 1']);
  assert.equal(m.eth0.bitsPerSec, null); assert.equal(m.eth1.bitsPerSec, null);
  assert.equal(m.eth2.bitsPerSec, 25e9); assert.equal(m.eth3.bitsPerSec, null); assert.equal(m.eth4.bitsPerSec, 100e9);
  assert.equal(m.eth0.state, 'up', '상태는 그대로');
});
