/**
 * 리눅스 성능 8b단계 ⑳ — `##TOP` 구획(명령 조각 · 파서 · 표지 위조 · 상한 · 세션 예산 산수).
 *   ① 파서: top 경로 · /proc 대안 · 권한 없는 I/O = null(‘—’) · 접두 없는 줄 버림 · 꺼짐 · 값 0 개 = null(missing)
 *   ② 실제 셸(dash · bash) + 가짜 top(PATH 앞): **둘째 프레임**만 · COMMAND 열(인자)이 출력에 없다 · 대안 경로 강제
 *   ③ 실제 프로세스(이 컨테이너 /proc): comm 을 ‘##END’ · 개행 섞인 ‘\n##END\n##MEM’ 으로 바꾼 바쁜 자식 — 두 경로 모두 표지가 생기지 않고 그 PID 가 후보에 나온다
 *      (프로세스 이름은 /proc/<pid>/comm 으로 확인 · 못 읽으면 t.skip — CI 러너)
 *   ④ 상한 · 산수: 40줄 × 201바이트 ≤ 8KB · 바이트 합 < 출력 상한 < sshExec 상한 · 최악 추가 시간 · 세션 예산 < 장비 시한 · 인자 · 환경 · kill 을 읽거나 부르지 않는다
 *   ⑤ shapeLinux: 순서(LINUX_SECTIONS) · 표지 위조 줄이 다른 구획을 덮지 못한다 · 잘림이면 missing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const T = await import('../src/bmusage/parse/linuxTop.js');
const OS = await import('../src/bmusage/collectors/osSsh.js');
const SH = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((x) => { try { return fs.existsSync(x); } catch { return false; } });
const SHELLS = [...new Set(SH.map((x) => { try { return fs.realpathSync(x); } catch { return x; } }))];
const run = (sh, cmd, envPath = null) => execFileSync(sh, ['-c', `export LC_ALL=C; ${cmd}`], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...(envPath ? { PATH: `${envPath}:${process.env.PATH}` } : {}) } });
const HAS_PROC = (() => { try { return fs.readFileSync('/proc/self/stat', 'utf8').length > 0 && fs.existsSync('/proc/uptime'); } catch { return false; } })();
const HAS = (bin) => { try { execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };

test('① 파서 — top 경로 · 권한 없는 I/O · 접두 없는 줄 · 꺼짐 · 빈 값', () => {
  const lines = [
    'tS:src=top dt=1.20 clk=100 pg=4096 up=1000.50 n=412 r=7 d=2 tot=91.0 c=3',
    'tC:41822|gpadmin|R|68.0|1513200|60000|800000|212000000|48000000|postgres',
    'tC:2210|root|R|4.1|132000|100|0|p|p|kswapd0',
    'tC:9931|root|S|1.2|3700|5000|10250|-|-|node_exporter',
    '##END',                                   // 접두 없는 줄 — 버린다(센다)
    'tC:bad|x|R|1|1|1|1|1|1|x',                // PID 형식 밖
    'tM:41822|gpadmin|3100000|R|15120|postgres',
    'tM:41830|gpadmin|2800000|Ssl|14200|postgres worker',
  ];
  const v = T.parseTop(lines);
  assert.equal(v.src, 'top'); assert.equal(v.nproc, 412); assert.equal(v.nrun, 7); assert.equal(v.nd, 2); assert.equal(v.cpuTotal, 91);
  assert.equal(v.cpu[0].pid, 41822); assert.equal(v.cpu[0].comm, 'postgres'); assert.equal(v.cpu[0].cpuS, 15132); assert.equal(v.cpu[0].start, 600);
  assert.equal(v.cpu[0].rssKb, 3_200_000, 'rss 페이지 × 4KB');
  assert.equal(v.cpu[0].rd, 212_000_000);
  const ks = v.cpu.find((x) => x.comm === 'kswapd0');
  assert.equal(ks.ioPerm, true); assert.equal(ks.rd, null, '권한 없는 /proc/<pid>/io 는 null — 0 이 아니다');
  const ne = v.cpu.find((x) => x.comm === 'node_exporter');
  assert.equal(ne.ioPerm, false); assert.equal(ne.rd, null, '첫 읽기가 없던 프로세스(—)도 null');
  assert.equal(v.ioPerm, 1); assert.equal(v.ioUnknown, 1);
  assert.deepEqual(v.io.map((x) => x.pid), [41822], 'I/O 상위는 읽은 것만');
  assert.equal(v.unparsed, 2);
  assert.equal(v.mem[1].comm, 'postgres worker', 'comm 의 공백은 그대로(줄 끝 칸)');
  assert.equal(v.mem[0].start, Math.floor(1000.5 - 15120) < 0 ? 0 : Math.floor(1000.5 - 15120));
  assert.deepEqual(T.parseTop(['tS:off=1']), { off: true });
  assert.equal(T.parseTop([]), null);
  assert.equal(T.parseTop(['##END', 'garbage']), null, '값이 하나도 없으면 null(readSection → missing)');
  // 엣지 문자열(comm · user) 정제 — 길이를 먼저 자르고 제어 · 양방향 · 폭 없는 문자를 ? 로
  assert.equal(T.cleanComm('a‮b\u0007c'), 'a?b?c');
  assert.equal(T.cleanComm('x'.repeat(5000)).length, T.COMM_MAX);
  assert.equal(T.cleanUser('ro ot<script>'), 'ro?ot?script?'.slice(0, T.USER_MAX + 1));
  assert.equal(T.procHint({ comm: 'postgres', user: 'gpadmin' }), 'gpdb');
  assert.equal(T.procHint({ comm: 'postgres', user: 'postgres' }), null, '계정이 gpadmin 이 아니면 GPDB 단서가 아니다');
  assert.equal(T.procHint({ comm: 'celery' }), 'airflow');
});

test('② 실제 셸 + 가짜 top — 둘째 프레임만 · COMMAND(인자) 미출력 · 대안 경로', async (t) => {
  if (!SHELLS.length || !HAS_PROC) return t.skip('셸 · /proc 없음');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bmtop-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // 프레임 1(부팅 이후 평균 — 버려야 한다)은 PID 1 이 99% · 프레임 2 는 이 테스트 프로세스가 77%. COMMAND 칸에 인자 · 비밀(toprc 명령줄 모드 흉내).
  const self = process.pid;
  const frame = (pid, v) => [
    'top - 10:00:00 up 1 day,  1 user,  load average: 1.00, 1.00, 1.00',
    'Tasks: 3 total,   1 running,   2 sleeping,   0 stopped,   0 zombie',
    '%Cpu(s):  1.0 us,  0.0 sy,  0.0 ni, 99.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st',
    '', '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    `${String(pid).padStart(7)} root      20   0   10000   5000   1000 R  ${v}   0.1   0:01.00 /usr/bin/python3 --password=SECRET-ARG`,
    '      2 root      20   0       0      0      0 S   0.0   0.0   0:00.00 kthreadd', ''];
  fs.writeFileSync(path.join(bin, 'top'), `#!/bin/sh\ncat <<'EOF'\n${[...frame(1, '99.0'), ...frame(self, '77.0')].join('\n')}\nEOF\n`, { mode: 0o755 });
  for (const sh of SHELLS) {
    const out = run(sh, T.topShell(), bin);
    assert.ok(!out.includes('SECRET-ARG') && !out.includes('--password'), `${sh}: top COMMAND 열(인자)은 출력에 없다`);
    assert.ok(out.split('\n').filter(Boolean).every((l) => /^t[SCM]:/.test(l)), `${sh}: 모든 줄이 고정 접두`);
    const v = T.parseTop(out.split('\n'));
    assert.equal(v.src, 'top', `${sh}: 가짜 top 의 둘째 프레임 머리글을 찾았다`);
    assert.equal(v.cpu[0].pid, self, `${sh}: 둘째 프레임(이 프로세스 77%)이 1위 — 첫 프레임(PID 1 99%)은 버렸다`);
    assert.equal(v.cpu[0].cpu, 77);
    assert.ok(!v.cpu.some((x) => x.pid === 1 && x.cpu === 99), '첫 프레임 값은 쓰지 않는다');
    const comm = fs.readFileSync(`/proc/${self}/comm`, 'utf8').trim();
    assert.equal(v.cpu[0].comm, comm.slice(0, 64), `${sh}: 이름은 top COMMAND 가 아니라 /proc/<pid>/stat comm`);
    assert.ok(v.nproc === 2 && v.nrun === 1, `${sh}: 둘째 프레임 개수(${v.nproc} · ${v.nrun})`);
    // 대안(/proc 2회 차이) 강제
    const pv = T.parseTop(run(sh, T.topShell({ forceProc: true })).split('\n'));
    assert.equal(pv.src, 'proc'); assert.ok(pv.candidates > 0 && pv.nproc > 0, `${sh}: /proc 대안이 후보를 낸다`);
    assert.ok(pv.dtS > 0.5 && pv.dtS < 5, `${sh}: 1초 간격(${pv.dtS})`);
  }
  // top 이 머리글을 못 주면(형식이 다른 판) 대안으로 넘어간다
  fs.writeFileSync(path.join(bin, 'top'), '#!/bin/sh\necho "top - x"\necho "garbage"\necho "top - y"\necho "no header here"\n', { mode: 0o755 });
  const fb = T.parseTop(run(SHELLS[0], T.topShell(), bin).split('\n'));
  assert.equal(fb.src, 'proc', '머리글이 없으면 /proc 대안');
  // 꺼짐 — 1초 대기 없이 한 줄
  const t0 = Date.now();
  assert.deepEqual(T.parseTop(run(SHELLS[0], T.topShell({ off: true })).split('\n')), { off: true });
  assert.ok(Date.now() - t0 < 900, '꺼짐은 대기하지 않는다');
});

test('③ 실제 프로세스 — comm 위조(##END · 개행 섞인 표지)는 표지가 되지 못하고 그 PID 가 후보에 나온다(두 경로)', async (t) => {
  if (!SHELLS.length || !HAS_PROC) return t.skip('셸 · /proc 없음');
  const kids = [];
  t.after(() => { for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* */ } } });
  const busy = (name) => { const k = spawn('/bin/sh', ['-c', `printf '${name}' > /proc/self/comm; while :; do :; done`], { stdio: 'ignore' }); kids.push(k); return k; };
  const a = busy('##END'); const b = busy('\\n##END\\n##MEM');
  await new Promise((r) => setTimeout(r, 400));
  let ca = ''; let cb = '';
  try { ca = fs.readFileSync(`/proc/${a.pid}/comm`, 'utf8'); cb = fs.readFileSync(`/proc/${b.pid}/comm`, 'utf8'); } catch { /* */ }
  if (ca.trim() !== '##END' || !cb.includes('##MEM')) return t.skip(`이 러너는 /proc/self/comm 쓰기가 반영되지 않는다(${JSON.stringify(ca)})`);
  for (const forceProc of [false, true]) {
    if (!forceProc && !HAS('top')) continue;
    const full = run(SHELLS[0], OS.linuxCommand([], { top: true }).replace(T.topShell(), T.topShell({ forceProc })));
    const lines = full.split('\n');
    assert.equal(lines.filter((l) => l === '##END').length, 1, `forceProc=${forceProc}: 진짜 ##END 하나`);
    assert.equal(lines.filter((l) => l === '##MEM').length, 1, '##MEM 도 진짜 하나');
    const sh = OS.shapeLinux(full, []);
    assert.equal(sh.truncated, false);
    assert.ok(sh.mem && sh.mem.totalBytes > 1024 * 1024, '메모리 구획이 위조 줄로 덮이지 않는다');
    const top = sh.perf.top.value;
    assert.ok(top && top.candidates > 0);
    const pa = top.cpu.find((x) => x.pid === a.pid); const pb = top.cpu.find((x) => x.pid === b.pid);
    assert.ok(pa && pa.comm === '##END', `forceProc=${forceProc}: ##END 프로세스가 후보(이름은 값으로)`);
    assert.ok(pb && pb.comm === '##END ##MEM', `forceProc=${forceProc}: 개행 섞인 이름도 한 줄 · 숨지 않는다(${JSON.stringify(pb)})`);
  }
});

test('④ 상한 · 산수 · 읽지 않는 것', () => {
  assert.ok(T.TOP_LINE_CAP.TOP * T.TOP_LINE_BYTES.TOP <= 8192, '40줄 × 201바이트 ≤ 8KB');
  assert.equal(T.TOP_LINE_BYTES.TOP, T.TOP_LINE_WIDTH + 1);
  assert.match(T.TOP_SHELL.TOP, new RegExp(`cut -c1-${T.TOP_LINE_WIDTH} \\| head -n ${T.TOP_LINE_CAP.TOP}$`), '구획 끝에 줄 폭 · 줄 수 상한');
  assert.ok(OS.SECTION_BYTES_SUM < OS.OUTPUT_MAX_BYTES, '구획 상한 바이트 합 < 출력 상한');
  assert.equal(OS.SECTION_LINE_CAP.TOP, T.TOP_LINE_CAP.TOP); assert.equal(OS.SECTION_LINE_BYTES.TOP, T.TOP_LINE_BYTES.TOP);
  // 세션 예산: 이 구획의 최악 추가 시간(top 시한 + 대안)이 명령 시한보다 충분히 작고, 세션 예산 < 장비 시한(60초)은 그대로
  assert.ok(T.TOP_WORST_MS <= 5_000, `최악 추가 ${T.TOP_WORST_MS}ms`);
  assert.ok(OS.SESSION_BUDGET_MS < 60_000 && OS.SESSION_BUDGET_MS - 15_000 >= 30_000, '세션 예산 50초(READY 15 + 명령 30 안) < 장비 시한 60초');
  assert.match(T.TOP_SHELL.TOP, /timeout 3 top -b -n 2 -d 1 -w 512 -o %CPU/);
  // 인자 · 환경 · 열린 파일 · 조작 — 읽거나 부르지 않는다(명령 문자열 스윕)
  for (const bad of [/cmdline/, /environ/, /\/fd\b/, /\bkill\b/, /\brenice\b/, /\bsudo\b/, /\bargs\b/, /\bcmd\b/]) assert.doesNotMatch(T.TOP_SHELL.TOP, bad, String(bad));
  assert.match(T.TOP_SHELL.TOP, /HOME=\/nonexistent XDG_CONFIG_HOME=\/nonexistent/, '개인 toprc 를 읽지 않는다');
  // 순서 — CHANGES 다음 · SAMPLER 앞
  const i = OS.LINUX_SECTIONS.indexOf('TOP');
  assert.ok(i > OS.LINUX_SECTIONS.indexOf('CHANGES') && i < OS.LINUX_SECTIONS.indexOf('SAMPLER'));
  const cmd = OS.linuxCommand([]);
  const markers = [...cmd.matchAll(/echo '##([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(markers, OS.LINUX_SECTIONS.filter((x) => x !== 'SAMPLER'), '명령 표지 순서 = LINUX_SECTIONS');
  assert.ok(OS.linuxCommand([], { top: false }).includes("echo 'tS:off=1'"), '끄면 꺼짐 한 줄');
});

test('⑤ shapeLinux — 위조 표지 줄 · 잘림 · 순서', () => {
  const base = ['##STAT', 'cpu  1 0 1 100 0 0 0 0 0 0', '##MEM', 'MemTotal: 1000 kB', 'MemAvailable: 500 kB'];
  const out = [...base, '##TOP', 'tS:src=top dt=1 clk=100 pg=4096 up=10 n=1 r=1 d=0 tot=5 c=1', 'tC:9|root|R|5.0|10|1|10|0|0|##MEM', '##MEM', 'MemTotal: 9 kB', '##END'].join('\n');
  const s = OS.shapeLinux(out, []);
  assert.equal(s.mem.totalBytes, 1000 * 1024, '##TOP 안의 ##MEM(접두 없는 위조 줄)은 앞 구획을 다시 열지 못한다(재개방 금지)');
  assert.equal(s.perf.top.value.cpu[0].comm, '##MEM');
  assert.equal(s.perf.top.value.unparsed, 2, '접두 없는 줄은 버리고 센다');
  // 잘림 — ##END 가 안 오면 마지막 구획(TOP)은 missing(0 · 정상으로 두지 않는다)
  const cut = [...base, '##TOP', 'tS:src=top dt=1 clk=100 pg=4096 up=10 n=1 r=1 d=0 tot=5 c=1', 'tC:9|root|R|5.0|10'].join('\n');
  const c = OS.shapeLinux(cut, []);
  assert.equal(c.truncated, true); assert.equal(c.perf.top.missing, true); assert.equal(c.perf.top.value, null);
});
