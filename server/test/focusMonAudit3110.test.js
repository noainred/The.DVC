/**
 * test/focusMonAudit3110.test.js — v3.11.0 서버 집중 모니터링 ‘디스크 점검’(배드 섹터 점검 프로그램) — 사용자 요청(2026-11-14 · 15)
 * "집중 모니터링 기능에 배드섹터 점검 프로그램 추가해줘"(+ 프로그램 원문) · "법인별로 보는 기능, 모델별로 보는 기능 등" · "법인별로 디스크 모델별로" ·
 * "기본값대로 모두 구현해줘"(설계 docs/design/focus-mon/README.md §20 · 고정 설치 + sudoers 한 줄 · 중앙 · 엣지 모두).
 *
 *  ① 설치 묶음 — 원격 명령은 상수 둘 · 받은 프로그램 그대로(sha) · 설치 파일 문법 · 끝 표지 · 시한 산수
 *  ② 실행 파일을 실제 sh 로 — 표지 · 종료값 · 임시 폴더 지움 · 인자 거절
 *  ③ 해석 — 실제 프로그램 출력 픽스처(이 컨테이너에서 sudo 로 돌린 것) · 준비 판정 표 · 끝 상태
 *  ④ 출력 예산 — 구획 머리 보존 · 생략 줄 · 판정 줄 수로 합계
 *  ⑤ 실행기 — 가짜 SSH: 준비 → 실행 · 준비 안 됨이면 실행하지 않음 · 인증 거부 정지 · 시한
 *  ⑥ 중앙 — 접수 문턱 · 결과 반영(DB) · 새 근거 · 엣지 배달 · ack · 남의 대상 결과 거절 · 정제 상한
 *  ⑦ 묶어 보기 — 끝까지 돈 회차만 · 비율 문턱 · 법인 × 모델
 *  ⑧ 등록부 법인 칸 · CSV · 라우트(권한 · 데모 · 404) · 엣지 워커 왕복
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('focusmonaudit3110-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-audit-3110';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-audit-3110-xxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { centralRouter } = await import('../src/routes/central.js');
const { issueAgentToken } = await import('../src/central/agentTokens.js');
const B = await import('../src/focusmon/audit/bundle.js');
const P = await import('../src/focusmon/audit/parse.js');
const R = await import('../src/focusmon/audit/runner.js');
const A = await import('../src/focusmon/audit/service.js');
const G = await import('../src/focusmon/audit/aggregate.js');
const registry = await import('../src/focusmon/registry.js');
const db = await import('../src/focusmon/db.js');
const svc = await import('../src/focusmon/service.js');
const worker = await import('../src/agent/focusMonWorker.js');
const mock = await import('../src/focusmon/mock.js');
const { focusAuthGuard, authDevOf } = await import('../src/focusmon/collector.js');
const { config } = await import('../src/config.js');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FX = (n) => fs.readFileSync(path.join(HERE, 'fixtures/diskaudit', n), 'utf8').split('\n');
const users = { admin: { username: 'a', role: 'admin', scope: null }, operator: { username: 'o', role: 'operator', scope: null }, rscoped: { username: 'r', role: 'admin', scope: { vcenters: ['vc-x'] } }, demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true } };
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use('/api/central', centralRouter);
app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
after(() => { worker.stopFocusMonWorker(); svc.stopFocusMon(); srv.close(); });
async function call(method, p, { who = 'admin', body } = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text };
}
const want = { programPath: B.PROGRAM_PATH, wrapperPath: B.WRAPPER_PATH, programSha: B.programSha(), wrapperSha: B.wrapperSha() };
const resetAll = () => { fs.rmSync(path.join(DIR, 'focusmon-targets.json'), { force: true }); fs.rmSync(path.join(DIR, 'focusmon-audit.json'), { force: true }); registry._resetForTest(); A._resetForTest(); };

/* ── ① ── */
test('① 설치 묶음 — 원격 명령 상수 · 받은 프로그램 그대로 · 설치 파일 문법 · 시한 산수', () => {
  assert.equal(B.programSha(), crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, '../../docs/design/focus-mon/ref/rhel_disk_audit.py'))).digest('hex'), '받은 원문(docs ref)과 같은 바이트');
  assert.equal(B.RUN_COMMAND, 'sudo -n /usr/local/sbin/dvc-disk-audit', '실행은 인자 없는 고정 명령 하나');
  for (const c of [B.READY_COMMAND, B.RUN_COMMAND, B.WRAPPER_TEXT.replace('${#N}', '')]) assert.ok(!/\$\{|<%|\{\{/.test(c), '끼워 넣을 자리 없음(셸 길이 \${#N} 하나만)');
  assert.match(B.READY_COMMAND, /sudo -n -l \/usr\/local\/sbin\/dvc-disk-audit/, '준비 확인은 sudo 를 실행하지 않고 허용 여부만');
  assert.ok(!/sudo -n \/usr/.test(B.READY_COMMAND), '준비 확인은 root 로 아무것도 돌리지 않는다');
  assert.match(B.WRAPPER_TEXT, /if \[ "\$#" -ne 0 \]; then echo '##DA ERR args'; exit 64; fi/, '실행 파일은 인자를 거절');
  assert.match(B.WRAPPER_TEXT, /timeout -s KILL 1200 nice -n 19 \$IO "\$PY" -I -S "\$PROG"/, '시한 · 낮은 우선순위 · 격리 모드(-I -S)');
  assert.match(B.WRAPPER_TEXT, /trap 'exit 141' PIPE/, 'SIGPIPE 에도 EXIT trap(임시 폴더 지움 — dash)');
  assert.match(B.WRAPPER_TEXT, /flock -n 9 \|\| \{ echo '##DA ERR busy'; exit 75; \}/, '겹쳐 돌지 않게 잠금');
  assert.match(B.WRAPPER_TEXT, /echo "##DA BEGIN 2 \$N"/, '실행마다 난수 표지');
  assert.ok(!/export N\b/.test(B.WRAPPER_TEXT), '표지는 내보내지 않는다(하위 프로세스 환경에 없다)');
  assert.match(B.READY_COMMAND, /^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin; export PATH/, '준비 확인은 실행 파일과 같은 PATH(반증 F6)');
  assert.match(B.WRAPPER_TEXT, /trap 'rm -rf "\$D"' EXIT/, '임시 폴더를 지운다');
  // 시한 산수: 노드 세션 시한 > 실행 파일 시한 + RAID 목록 + 준비 확인
  assert.ok(B.AUDIT_DEADLINE_MS > (B.WRAPPER_TIMEOUT_S + B.RAID_TIMEOUT_S) * 1000 + B.READY_EXEC_MS, `${B.AUDIT_DEADLINE_MS}`);
  const inst = B.installScript();
  const f = path.join(DIR, 'install.sh'); fs.writeFileSync(f, inst);
  assert.equal(spawnSync('sh', ['-n', f]).status, 0, '설치 파일 문법');
  assert.equal(inst.split('DVC_DISK_AUDIT_PROGRAM_EOF').length - 1, 2, '끝 표지는 여는 · 닫는 자리 둘뿐');
  assert.ok(inst.includes(`${B.programSha()}  $T/rhel_disk_audit.py`) && inst.includes(`${B.wrapperSha()}  $T/dvc-disk-audit`), '설치 전 sha 재확인');
  assert.match(inst, /NOPASSWD: \/usr\/local\/sbin\/dvc-disk-audit \\"\\""/, 'sudoers 는 인자 없이만("")');
  assert.match(inst, /visudo -cf/, 'visudo 검사 뒤에만 넣는다');
  assert.match(inst, /\*\[!A-Za-z0-9._-\]\*\) echo '##DI fail args'; echo "사용법/, '계정 이름 글자 제한(v3.17.0 — 자동 설치가 읽는 ##DI 표지 줄을 함께 낸다)');
  const bad = spawnSync('sh', [f, 'x;id'], { encoding: 'utf8' });
  assert.equal(bad.status, 64, '이상한 계정 이름은 바로 거절');
});

/* ── ② ── */
test('② 실행 파일을 실제 sh 로 — 표지 · 종료값 · 임시 폴더 지움 · 인자 거절', () => {
  const py = spawnSync('sh', ['-c', 'command -v python3']).stdout?.toString().trim();
  if (!py) return; // python3 가 없는 빌드 환경 — 문법만은 ① 이 봤다
  const prog = path.join(DIR, 'fake_audit.py');
  fs.writeFileSync(prog, 'import sys, os\nprint("RHEL 디스크 오류 이력 점검 | t | x")\nprint("\\n[판정]")\nprint("  [불명] 가용 자료에서 대상 오류 패턴 미검출. 과거 무장애 여부는 알 수 없음.")\nopen(os.path.join(sys.argv[sys.argv.index("--output-dir")+1], "r.txt"), "w").write("x")\nprint("완료 | x")\n');
  const w = path.join(DIR, 'wrap.sh');
  fs.writeFileSync(w, B.WRAPPER_TEXT.replace(`PROG=${B.PROGRAM_PATH}`, `PROG=${prog}`).replace('mktemp -d /tmp/dvc-disk-audit.XXXXXXXX', `mktemp -d ${DIR}/dvc-disk-audit.XXXXXXXX`)
    .replace('[ -d /run ] && [ -w /run ]', `[ -d ${DIR} ]`).replace('/run/dvc-disk-audit.lock', `${DIR}/dvc-disk-audit.lock`));
  const r = spawnSync('sh', [w], { encoding: 'utf8', timeout: 60_000 });
  const lines = r.stdout.split('\n');
  const sp = P.splitRun(lines);
  assert.equal(sp.begun, true); assert.equal(sp.ended, true); assert.equal(sp.rc, 0, r.stdout.slice(0, 400));
  assert.ok(sp.report.some((l) => l.includes('[불명]')));
  assert.equal(fs.readdirSync(DIR).filter((n) => n.startsWith('dvc-disk-audit.') && !n.endsWith('.lock')).length, 0, '임시 폴더(보고서 파일 포함)를 지웠다');
  const r2 = spawnSync('sh', [w, 'extra'], { encoding: 'utf8' });
  assert.equal(r2.status, 64); assert.match(r2.stdout, /##DA ERR args/);
  const sp2 = P.splitRun(r2.stdout.split('\n')); assert.equal(sp2.err, 'args');
  assert.match(sp.nonce || '', /^[0-9a-f]{16}$/, '첫 줄의 표지');
  // 잠금 — 다른 실행이 잡고 있으면 프로그램을 돌리지 않고 'busy'(flock 이 있는 곳에서만)
  if (spawnSync('sh', ['-c', 'command -v flock']).status === 0) {
    const hold = spawnSync('sh', ['-c', `flock ${DIR}/dvc-disk-audit.lock sh ${w}`], { encoding: 'utf8', timeout: 60_000 });
    assert.match(hold.stdout, /^##DA ERR busy/m, hold.stdout.slice(0, 200));
    assert.equal(A.runOutcome(P.splitRun(hold.stdout.split('\n')), { kind: 'done' }, { complete: false }), 'wrapper-busy');
  }
  // 채널이 먼저 닫혀도(SIGPIPE) 임시 폴더를 지운다 — dash 계열 sh(반증 F9-d)
  spawnSync('sh', ['-c', `sh ${w} | head -n 1 >/dev/null`], { timeout: 60_000 });
  assert.equal(fs.readdirSync(DIR).filter((n) => n.startsWith('dvc-disk-audit.') && !n.endsWith('.lock')).length, 0, 'SIGPIPE 뒤에도 임시 폴더 없음');
  // 준비 확인을 이 계정으로 실제로 — 표지 처음 · 끝
  const rd = spawnSync('sh', ['-c', B.READY_COMMAND], { encoding: 'utf8', timeout: 30_000 });
  const pr = P.parseReady(rd.stdout.split('\n'));
  assert.equal(pr.begun && pr.ended, true, rd.stdout);
});

/* ── ③ ── */
test('③ 해석 — 실제 프로그램 출력(sudo 로 돌린 픽스처) · 준비 판정 표 · 끝 상태', () => {
  const sp = P.splitRun(FX('run-hit.txt'));
  assert.equal(sp.begun && sp.ended, true); assert.equal(sp.rc, 0);
  const rep = P.parseReport(sp.report);
  assert.deepEqual(rep.sections, P.SECTIONS, '구획 여덟 개를 모두 읽었다');
  assert.equal(rep.complete, true);
  assert.deepEqual(rep.counts, { media: 5, io: 1, realloc: 1, fsok: 0, fscmd: 1 });
  assert.deepEqual(rep.judgeCounts, { media: 5, io: 1, realloc: 1 }, '판정 줄의 건수와 근거 줄 수가 같다');
  assert.equal(rep.gaps, 1);
  assert.deepEqual(rep.others, [], '모르는 줄 없음(보고서 경로 줄은 건너뛴다)');
  const ev = rep.evidence.find((e) => e.n === 5);
  assert.equal(ev.kind, '매체 오류 기록'); assert.equal(ev.slot, '/c0/e32/s5'); assert.deepEqual(ev.ids, { sn: 'ZC1A2B3C', wwn: '5000c500a1b2c3d4' });
  assert.equal(rep.evidence.find((e) => e.n === 1).source, '/var/log/messages'); assert.equal(rep.evidence.find((e) => e.n === 1).line, 1);
  assert.equal(rep.evidence.find((e) => e.n === 6).slot, '', 'PERC 이벤트 PD 05(e0x20/s5) — 인클로저가 16진이면 프로그램이 슬롯을 붙이지 않는다(그대로 옮긴다)');
  const disks = P.parseDisks(sp.lsblk, sp.raid);
  const raid = disks.filter((d) => d.src === 'raid');
  assert.deepEqual(raid.map((d) => [d.dev, d.sn, d.wwn, d.model, d.size, d.media]), [['/c0/e32/s4', 'ZC1A2B39', '5000c500a1b2c3a0', 'ST4000NM0035-1V4107', '3.637 TB', 'HDD'], ['/c0/e32/s5', 'ZC1A2B3C', '5000c500a1b2c3d4', 'ST4000NM0035-1V4107', '3.637 TB', 'HDD']]);
  const sum = P.summarize(rep, disks);
  assert.equal(sum.hit, true); assert.equal(sum.errTotal, 7); assert.equal(sum.unattributed, 4, '식별자 없는 근거 4줄은 디스크에 붙이지 않는다');
  assert.deepEqual(sum.disks.map((d) => [d.label, d.model, d.mediaN, d.reallocN]), [['/c0/e32/s4', 'ST4000NM0035-1V4107', 0, 0], ['/c0/e32/s5', 'ST4000NM0035-1V4107', 2, 1]]);
  // 깨끗한 회차
  const c = P.parseReport(P.splitRun(FX('run-clean.txt')).report);
  assert.equal(c.complete, true); assert.equal(c.evidenceTotal, 0); assert.equal(c.verdicts[0].tag, '불명');
  // 준비 판정 표
  assert.deepEqual(P.readyState(P.parseReady(FX('ready-ok.txt')), want), { state: 'ready', reason: '' });
  const base = FX('ready-ok.txt').join('\n');
  const st = (text) => P.readyState(P.parseReady(text.split('\n')), want).state;
  assert.equal(st(base.replace(/##DR py .*/, '##DR py -')), 'nopy');
  assert.equal(st(base.replace(/##DR py .*/, '##DR py 3.5.2')), 'pyold');
  assert.equal(st(base.replace(/##DR file \/usr\/local\/sbin\/dvc-disk-audit .*/, '##DR file /usr/local/sbin/dvc-disk-audit - -')), 'notinstalled');
  assert.equal(st(base.replace(/##DR file \/usr\/local\/sbin\/dvc-disk-audit .*/, '##DR file /usr/local/sbin/dvc-disk-audit unreadable -')), 'unreadable');
  assert.equal(st(base.replace(B.programSha(), 'b'.repeat(64))), 'version');
  assert.equal(st(base.replace(/(dvc-disk-audit \S+) 0:0:755/, '$1 1000:0:755')), 'owner', '실행 파일이 root 소유가 아니면');
  assert.equal(st(base.replace('/usr/local/libexec/dvc 0:0:755', '/usr/local/libexec/dvc 0:0:777')), 'owner', '경로 폴더를 남이 쓸 수 있으면');
  assert.equal(st(base.replace(/(rhel_disk_audit.py \S+) 0:0:644/, '$1 0:0:4755')), 'owner', 'setuid 비트');
  assert.equal(st(base.replace('##DR sudo ok', '##DR sudo no')), 'nosudo');
  assert.equal(st(base.replace('##DR end', '')), 'bad-output', '끝 표지가 없으면');
  // 끝 상태
  const out = (o) => A.runOutcome(P.splitRun(o.lines || []), { kind: o.kind || 'done', stderr: o.stderr || '' }, { complete: o.complete !== false });
  const N = '0123456789abcdef'; const BG = `##DA BEGIN 2 ${N}`; const M = (x) => `##DA ${N} ${x}`;
  assert.equal(out({ lines: [], stderr: 'sudo: a password is required' }), 'sudo-denied');
  assert.equal(out({ lines: [], stderr: 'sudo: sorry, you must have a tty to run sudo' }), 'sudo-tty');
  // 실행 파일의 오류 표지는 첫 줄(BEGIN 앞) — 실제 순서 그대로(반증 F6: 예전 시험은 실행 파일이 내지 않는 순서를 썼다)
  for (const e of ['nopython', 'tmp', 'args', 'busy', 'nonce']) assert.equal(out({ lines: [`##DA ERR ${e}`] }), `wrapper-${e}`);
  assert.equal(out({ lines: ['##DA ERR zzz'] }), 'wrapper-other');
  assert.equal(out({ lines: [BG, 'x', M('EXIT 137'), M('END')] }), 'program-timeout');
  assert.equal(out({ lines: [BG, 'x', M('EXIT 1'), M('END')] }), 'program-error');
  assert.equal(out({ lines: [BG, 'x'] }), 'cut');
  assert.equal(out({ lines: [BG], kind: 'timeout' }), 'timeout');
  assert.equal(out({ lines: [BG, M('EXIT 0'), M('END')], complete: false }), 'incomplete');
  assert.equal(out({ lines: ['##DA BEGIN 1', 'x', '##DA EXIT 0', '##DA END'] }), 'no-start', '옛 판(표지 없음)의 출력은 실행 파일 출력으로 보지 않는다');
  assert.equal(out({ lines: [BG, 'x', '##DA EXIT 0', '##DA END'] }), 'cut', '표지 없는 표지 꼴 줄은 보고서 글자 — 끝 표지로 받지 않는다');
  assert.equal(out({ lines: FX('run-hit.txt') }), 'done');
});

/* ── ④ ── */
test('④ 출력 예산 — 구획 머리 보존 · 생략 줄 · 근거가 잘리면 판정 줄 건수로', () => {
  const k = R.createOutputKeeper({ budget: { ...R.SECTION_BUDGET, '상세 근거': 600, '해석 범위': 1 } }); // 해석 범위 예산 1바이트 — 머리는 그래도 남아야 한다
  const hit = FX('run-hit.txt'); const nonce = P.splitRun(hit).nonce;
  for (const l of hit) k.push(l);
  const lines = k.done();
  assert.ok(lines.includes('[상세 근거]') && lines.includes('[해석 범위]') && lines.includes(`##DA ${nonce} END`), '머리(머리 예산 안) · 그 실행의 표지는 구획 예산과 상관없이');
  assert.ok(lines.some((l) => /^…\(이 구획 \d+줄 생략\)$/.test(l)), '생략 줄');
  assert.equal(k.truncated(), true);
  const sp = P.splitRun(lines); const rep = P.parseReport(sp.report);
  const sum = P.summarize(rep, []);
  assert.equal(sum.evidenceCut, true);
  assert.ok(sum.counts.media >= 5, '받은 근거 줄이 적어도 판정 줄의 건수 이상으로 말한다');
  // 정규식 상한 — 아주 긴 줄도 선형(잘라서 본다)
  const t0 = Date.now(); P.parseReport(['[상세 근거]', `  #1 [매체 오류 기록] ${'a | '.repeat(50_000)}`]); assert.ok(Date.now() - t0 < 500);
});

/* ── ⑤ ── */
function fakeConnect({ ready, out = [], fail = null, hang = false }) {
  const calls = [];
  const fn = async (creds, run, { signal } = {}) => {
    calls.push(creds.host);
    if (fail) throw fail;
    const api = {
      exec: async () => ({ stdout: ready.join('\n'), code: 0 }),
      execStream: async (cmd, { onLine, signal: sg }) => {
        calls.push(cmd);
        if (hang) return new Promise((resolve) => sg.addEventListener('abort', () => resolve({ code: null, aborted: true, stderr: '' }), { once: true }));
        for (const l of out) onLine(l); return { code: 0, stderr: '' };
      },
    };
    const p = run(api);
    if (signal) return Promise.race([p, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('SSH 세션 취소(타임아웃)')), { once: true }))]);
    return p;
  };
  fn.calls = calls; return fn;
}
const keys = { keyInfo: () => ({ fingerprint: 'SHA256:x' }), privateKeyForConnect: () => 'PEM' };
const T = { id: 'fm-aaaa0001', host: '10.40.0.1', port: 22, username: 'dvcmon' };

test('⑤ 실행기 — 준비 → 실행 · 준비 안 됨이면 실행하지 않음 · 인증 거부 정지 · 시한', async () => {
  const c1 = fakeConnect({ ready: FX('ready-ok.txt'), out: FX('run-hit.txt') });
  const r1 = await R.auditOnce(T, { mode: 'run', keys, connect: c1 });
  assert.equal(r1.kind, 'done'); assert.ok(r1.out.length > 100); assert.ok(c1.calls.includes(B.RUN_COMMAND), '고정 명령으로 실행');
  const nos = FX('ready-ok.txt').map((l) => (l === '##DR sudo ok' ? '##DR sudo no' : l));
  const c2 = fakeConnect({ ready: nos, out: FX('run-hit.txt') });
  const r2 = await R.auditOnce(T, { mode: 'run', keys, connect: c2 });
  assert.equal(r2.kind, 'not-ready'); assert.ok(!c2.calls.includes(B.RUN_COMMAND), 'sudo 규칙이 없으면 sudo 를 부르지 않는다');
  const c3 = fakeConnect({ ready: FX('ready-ok.txt'), out: FX('run-hit.txt') });
  const r3 = await R.auditOnce(T, { mode: 'check', keys, connect: c3 });
  assert.equal(r3.kind, 'done'); assert.equal(r3.out.length, 0); assert.ok(!c3.calls.includes(B.RUN_COMMAND), '준비 확인은 실행하지 않는다');
  // 다른 판본을 기대하는 중앙(엣지 작업의 expect) — 설치본과 다르면 실행하지 않는다
  const c4 = fakeConnect({ ready: FX('ready-ok.txt'), out: FX('run-hit.txt') });
  const r4 = await R.auditOnce(T, { mode: 'run', keys, connect: c4, expect: { program: 'c'.repeat(64), wrapper: B.wrapperSha() } });
  assert.equal(r4.kind, 'not-ready');
  // 인증 거부 → 정지 기록 → 다음은 접속조차 하지 않는다
  const authErr = Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
  const T2 = { ...T, id: 'fm-aaaa0002' };
  const r5 = await R.auditOnce(T2, { mode: 'run', keys, connect: fakeConnect({ ready: [], fail: authErr }) });
  assert.equal(r5.kind, 'auth');
  const c6 = fakeConnect({ ready: FX('ready-ok.txt') });
  const r6 = await R.auditOnce(T2, { mode: 'run', keys, connect: c6 });
  assert.equal(r6.kind, 'auth-stopped'); assert.equal(c6.calls.length, 0, '정지된 대상에 다시 로그인하지 않는다(자동 재시도 금지)');
  focusAuthGuard.clearAuthStop(authDevOf(T2, 'SHA256:x').id);
  // 시한 — 세션을 끊고 'timeout'
  const r7 = await R.auditOnce({ ...T, id: 'fm-aaaa0003' }, { mode: 'run', keys, connect: fakeConnect({ ready: FX('ready-ok.txt'), hang: true }), deadlineMs: 200 });
  assert.equal(r7.kind, 'timeout');
  // 대기열 — 같은 대상 겹침 거절 · 동시 1
  let active = 0; let peak = 0;
  const q = R.createAuditRunner({ keys, onResult: () => {}, exec: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active -= 1; return { ok: true, kind: 'done', ready: [], out: [] }; } });
  assert.equal(q.submit({ runId: 'r1', mode: 'run', target: T }).ok, true);
  assert.equal(q.submit({ runId: 'r2', mode: 'check', target: T }).code, 'busy');
  q.submit({ runId: 'r3', mode: 'run', target: { ...T, id: 'fm-aaaa0009' } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(peak, 1, '노드당 동시 1');
});

/* ── ⑥ ── */
test('⑥ 중앙 — 접수 문턱 · 결과 반영(DB · 새 근거) · 엣지 배달 · ack · 남의 대상 거절 · 정제 상한', async () => {
  resetAll();
  const t = registry.addTarget({ name: 'db-a', host: '10.41.0.1', port: 22, username: 'dvcmon', agent: 'edge-kr' }, { agents: ['edge-kr', 'edge-pl'] }).target;
  const other = registry.addTarget({ name: 'db-b', host: '10.41.0.2', port: 22, username: 'dvcmon', agent: 'edge-pl' }, { agents: ['edge-kr', 'edge-pl'] }).target;
  A.startAuditService({ keys });
  const r1 = A.requestAudit(t, { mode: 'run', by: 'a' });
  assert.equal(r1.ok, true); assert.equal(r1.via, 'edge');
  assert.equal(A.requestAudit(t, { mode: 'check' }).code, 'busy', '한 서버에 작업 하나');
  const mine = new Map([[t.id, t]]);
  const d1 = A.handleEdgeAudit('EDGE-KR', mine, {}, Date.now());
  assert.equal(d1.jobs.length, 1); assert.equal(d1.jobs[0].runId, r1.runId); assert.equal(d1.jobs[0].expect.program, B.programSha(), '중앙이 아는 판본을 함께 준다');
  assert.equal(A.handleEdgeAudit('edge-kr', mine, {}, Date.now()).jobs.length, 0, '2분 안에는 다시 주지 않는다');
  assert.equal(A.handleEdgeAudit('edge-pl', new Map([[other.id, other]]), {}, Date.now()).jobs.length, 0, '다른 엣지에는 주지 않는다');
  // 진행 상태
  A.handleEdgeAudit('edge-kr', mine, { active: [{ runId: r1.runId, state: 'running', phase: '로그 수집 범위' }] });
  assert.equal(A.jobOf(t.id).phase, '로그 수집 범위');
  // 남의 엣지가 이 작업 결과를 올리면 — ack 는 하되 반영하지 않는다
  const fake = { runId: r1.runId, result: { mode: 'run', ok: true, kind: 'done', ready: FX('ready-ok.txt'), out: FX('run-hit.txt'), outBytes: 1 } };
  const x = A.handleEdgeAudit('edge-pl', new Map([[other.id, other]]), { results: [fake] });
  assert.deepEqual(x.ack, [r1.runId]);
  await new Promise((r) => setTimeout(r, 200)); // 반영은 뒤에서 도므로 기다린 뒤에 본다
  assert.ok(A.jobOf(t.id), '반영하지 않았다(작업이 남아 있다)'); assert.equal(A.readinessOf(t.id), null, '남의 엣지 결과로 준비 상태가 생기지 않았다');
  // 제 엣지라도 그 대상을 지금 맡고 있지 않으면(담당 노드가 바뀐 뒤 늦게 온 결과) 반영하지 않는다
  A.handleEdgeAudit('edge-kr', new Map(), { results: [fake] });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(A.jobOf(t.id) && A.readinessOf(t.id) == null, '맡지 않은 대상의 결과는 버린다');
  // 제 엣지의 결과 — 반영(뒤에서 DB 쓰기)
  const y = A.handleEdgeAudit('edge-kr', mine, { results: [fake] });
  assert.deepEqual(y.ack, [r1.runId]);
  for (let i = 0; i < 50 && A.jobOf(t.id); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(A.jobOf(t.id), null, '작업이 끝났다');
  const rec = A.readinessOf(t.id);
  assert.equal(rec.state, 'ready'); assert.equal(rec.node, 'edge-kr'); assert.ok(rec.lastExecAt);
  const latest = (await A.latestFor([t.id])).get(t.id);
  assert.equal(latest.outcome, 'done'); assert.equal(latest.summary.counts.media, 5); assert.equal(latest.summary.newN, null, '첫 회차는 비교 대상이 없다(새 근거 수 null)');
  assert.ok(Array.isArray(latest.summary.ek) && latest.summary.ek.length === 8);
  // 10분 문턱
  const r2 = A.requestAudit(t, { mode: 'run' });
  assert.equal(r2.code, 'too-soon'); assert.ok(r2.waitSec > 500);
  // 정제 — 모르는 칸 · 큰 줄 · 줄 수 · 모르는 kind
  const c = A.cleanEdgeResult({ mode: 'x', ok: true, kind: 'pwned', ready: ['a', 5, { x: 1 }], out: [`${'z'.repeat(20_000)}`, 'b'], code: 9999, ms: -5, extra: 'x', stderr: 's'.repeat(9000) });
  assert.equal(c.mode, 'run'); assert.equal(c.kind, 'unreachable'); assert.deepEqual(c.ready, ['a']); assert.ok(c.out[0].length < 8300); assert.equal(c.code, null); assert.equal(c.ms, 0); assert.equal(c.stderr.length, 4096); assert.equal(c.extra, undefined);
  assert.equal(A.cleanEdgeResult('x'), null); assert.equal(A.cleanEdgeResult([]), null);
  // 두 번째 회차(문턱을 지난 것으로) — 새 근거 수
  const st = JSON.parse(fs.readFileSync(path.join(DIR, 'focusmon-audit.json'), 'utf8'));
  st.ready[t.id].lastExecAt = Date.now() - 11 * 60_000; fs.writeFileSync(path.join(DIR, 'focusmon-audit.json'), JSON.stringify(st)); A._resetForTest(); A.startAuditService({ keys });
  const r3 = A.requestAudit(t, { mode: 'run' }); assert.equal(r3.ok, true, JSON.stringify(r3));
  const more = [...FX('run-hit.txt')]; more.splice(more.indexOf('[해석 범위]') - 1, 0, '  #8 [매체 오류 기록] /var/log/messages:9 | 시간 비교 불가 | 식별자 없음 | 장치 sdc | kernel host=vm Nov 14 01:00:00 | critical medium error, dev sdc, sector 1');
  await A.ingestResult({ runId: r3.runId, tid: t.id, mode: 'run', requestedAt: Date.now() }, { ok: true, kind: 'done', ready: FX('ready-ok.txt'), out: more, outBytes: 1 }, { node: 'edge-kr' });
  const l2 = (await A.latestFor([t.id])).get(t.id);
  assert.equal(l2.summary.newN, 1, '지난 회차에 없던 근거 1줄'); assert.equal(l2.summary.prevId, r1.runId);
  // 상태 파일 손상 → 보존 · 빈 상태로 시작(작업을 지어내지 않는다)
  fs.writeFileSync(path.join(DIR, 'focusmon-audit.json'), '{bad');
  A._resetForTest(); assert.equal(A.readinessOf(t.id), null); assert.ok(A.auditStateError());
  assert.ok(fs.readdirSync(DIR).some((n) => n.startsWith('focusmon-audit.json.corrupt')), '손상본 보존');
});

/* ── ⑦ ── */
test('⑦ 묶어 보기 — 끝까지 돈 회차만 · 비율 문턱 · 법인 × 모델 · 결과 없는 서버 밝힘', () => {
  const disk = (model, n, bad = 0) => Array.from({ length: n }, (_, i) => ({ label: `/c0/e32/s${i}`, model, size: '3.6 TB', media: 'HDD', mediaN: i < bad ? 1 : 0, reallocN: 0, ioN: 0 }));
  const row = (id, corp, smodel, last) => ({ id, name: id, agent: '', group: '', corp: corp ? { id: corp, name: corp.toUpperCase() } : null, smodel, ready: { state: 'ready' }, job: null, last });
  const done = (counts, disks) => ({ outcome: 'done', at: 1, summary: { counts, disks, hit: counts.media + counts.io + counts.realloc > 0 } });
  const rows = [
    row('a', 'kr', 'R740', done({ media: 3, io: 1, realloc: 0 }, disk('ST4000', 12, 1))),
    row('b', 'kr', 'R740', done({ media: 0, io: 0, realloc: 0 }, disk('MG04', 4))),
    row('c', 'pl', 'R640', { outcome: 'timeout', at: 2, summary: { counts: { media: 99, io: 0, realloc: 0 }, disks: disk('ST4000', 4, 4), hit: true } }),
    row('d', null, null, null),
  ];
  const corp = G.groupRows(rows, (r) => ({ key: r.corp?.id || '', name: r.corp?.name || G.NO_CORP }), ['kr', 'pl']);
  assert.deepEqual(corp.map((g) => [g.name, g.n, g.done, g.media, g.disks]), [['KR', 2, 2, 3, 16], ['PL', 1, 0, null, null], [G.NO_CORP, 1, 0, null, null]], '시한 초과 회차의 99 는 더하지 않는다 · 결과가 없으면 null(0 아님)');
  const dm = G.byDiskModel(rows);
  const st = dm.find((m) => m.model === 'ST4000');
  assert.equal(st.n, 12, '끝까지 돈 회차의 디스크만'); assert.equal(st.bad, 1); assert.equal(st.rate, 8.3);
  assert.equal(dm.find((m) => m.model === 'MG04').rate, null, `${G.RATE_MIN_DISKS}개 미만은 비율 없음`);
  const cc = G.crossCorpModel(rows, 'corp', { corpKey: (r) => r.corp?.id || '', corpName: (r) => r.corp?.name || G.NO_CORP, corpOrder: ['kr', 'pl'] });
  assert.deepEqual(cc.map((g) => [g.name, g.rows.map((x) => x.name), g.noResult]), [['KR', ['ST4000', 'MG04'], []], ['PL', [], ['c']], [G.NO_CORP, [], ['d']]]);
  const cm = G.crossCorpModel(rows, 'model', { corpKey: (r) => r.corp?.id || '', corpName: (r) => r.corp?.name || G.NO_CORP });
  assert.deepEqual(cm.map((g) => [g.name, g.rows.map((x) => x.name)]), [['ST4000', ['KR']], ['MG04', ['KR']]]);
  assert.deepEqual(cm[0].rows[0].serverNames, ['a']); assert.equal(cm[0].rows[0].servers, 1, '서버 수(수)와 서버 이름(배열)이 서로 덮어쓰지 않는다 — 화면 크래시 회귀');
  assert.deepEqual(cc[0].rows[0].serverNames, ['a']);
  const k = G.auditKpis([...rows, { ...row('e', null, null, null), ready: { state: 'nosudo' } }]);
  assert.equal(k.done, 2); assert.equal(k.hit, 1); assert.equal(k.notReady, 1); assert.deepEqual(k.notReadyBy, { nosudo: 1 });
});

/* ── ⑧ ── */
test('⑧ 등록부 법인 칸 · CSV · 라우트(권한 · 데모 · 404 · 설치 파일) · 엣지 워커 왕복', async () => {
  resetAll();
  const corps = [{ id: 'kr-hq', name: '한국 본사' }, { id: 'pl-wro', name: 'Wroclaw' }];
  const add = registry.addTarget({ name: 'c1', host: '10.42.0.1', username: 'dvcmon', corp: 'KR-HQ' }, { agents: [], corps });
  assert.equal(add.ok, true); assert.equal(add.target.corp, 'kr-hq', '대소문자만 다르면 목록의 id 로');
  assert.equal(registry.addTarget({ name: 'c2', host: '10.42.0.2', username: 'dvcmon', corp: 'nope' }, { agents: [], corps }).code, 'bad-corp');
  const up = registry.updateTarget(add.target.id, { name: 'c1x' }, { agents: [], corps: [] });
  assert.equal(up.ok, true); assert.equal(up.target.corp, 'kr-hq', '법인 칸을 보내지 않은 수정은 저장값 그대로(목록에 없어도)');
  assert.deepEqual(registry.targetChanges({ corp: '' }, { corp: 'kr-hq' }), [{ k: 'corp', from: '', to: 'kr-hq' }]);
  // CSV — 이름으로도 · 열이 없으면 그대로 · 모르는 법인은 그 줄 오류
  const p1 = registry.planCsv('이름,IP,포트,계정,담당 노드,법인\nc1x,10.42.0.1,22,dvcmon,중앙,Wroclaw\nc3,10.42.0.3,22,dvcmon,중앙,없는곳', { agents: [], corps });
  assert.equal(p1.rows[0].value.corp, 'pl-wro'); assert.equal(p1.rows[1].action, 'error'); assert.equal(p1.rows[1].code, 'bad-corp');
  const p2 = registry.planCsv('이름,IP,포트,계정\nc1x,10.42.0.1,22,dvcmon', { agents: [], corps });
  assert.equal(p2.rows[0].value.corp, 'kr-hq'); assert.equal(p2.rows[0].action, 'same');
  const ex = registry.exportRows(null, { corpName: (id) => corps.find((c) => c.id === id)?.name });
  assert.equal(ex[0][6], '법인'); assert.equal(ex[1][6], '한국 본사');
  // 라우트 — 데모 대상(목 모드)으로 실제 흐름: 실행 → 결과 → 묶어 보기
  const dcs = await import('../src/datacenter/store.js');
  dcs.addDatacenter({ id: 'kr-hq', name: '한국 본사' });
  const demo = mock.DEMO_TARGETS.find((d) => d.name === 'kr-db-01');
  A.startAuditService({ keys: svc.focusKeys });
  const g0 = await call('GET', '/api/tools/focus-mon/audit');
  assert.equal(g0.status, 200, g0.text); assert.ok(g0.body.rows.some((r) => r.id === demo.id)); assert.ok(g0.body.limits.runGapMin === 10);
  assert.equal((await call('GET', '/api/tools/focus-mon/audit', { who: 'rscoped' })).status, 403, '범위 계정');
  assert.equal((await call('GET', '/api/tools/focus-mon/audit', { who: 'operator' })).status, 403, '관리자만');
  assert.equal((await call('POST', '/api/tools/focus-mon/audit/run', { who: 'demo', body: { ids: [demo.id] } })).status, 403, '데모 계정은 실행 못 함');
  const gd = await call('GET', '/api/tools/focus-mon/audit', { who: 'demo' });
  assert.deepEqual(gd.body.corps, [], '데모 계정에 실제 법인 목록 없음'); assert.ok(gd.body.rows.every((r) => r.demo));
  assert.ok(g0.body.corps.some((c) => c.id === 'kr-hq'), '관리자에게는 법인 목록이 간다(데모 판본과 다름을 확인)');
  const run = await call('POST', '/api/tools/focus-mon/audit/run', { body: { ids: [demo.id, 'fm-zzzz9999'], mode: 'run' } });
  assert.equal(run.status, 200, run.text); assert.equal(run.body.results[0].ok, true); assert.equal(run.body.results[1].code, 'not-found');
  for (let i = 0; i < 100 && A.jobOf(demo.id); i += 1) await new Promise((r) => setTimeout(r, 30));
  const g1 = await call('GET', '/api/tools/focus-mon/audit');
  const row = g1.body.rows.find((r) => r.id === demo.id);
  assert.equal(row.last.outcome, 'done', JSON.stringify(row.last)); assert.equal(row.last.summary.ek, undefined, '근거 열쇠는 화면에 싣지 않는다');
  assert.equal(row.smodel, 'PowerEdge R740xd'); assert.equal(row.corp.name, '한국(데모)');
  assert.ok(g1.body.views.corp.some((x) => x.name === '한국(데모)' && x.done === 1));
  assert.ok(g1.body.views.disk.some((x) => x.model === 'ST4000NM0035-1V4107' && x.bad === 1));
  const det = await call('GET', `/api/tools/focus-mon/audit/run/${row.last.id}`);
  assert.equal(det.status, 200); assert.ok(det.body.evidence.length >= 6); assert.ok(det.body.verdicts.some((v) => v.tag === '확정'));
  const rep = await call('GET', `/api/tools/focus-mon/audit/run/${row.last.id}/report.txt`);
  assert.equal(rep.status, 200); assert.match(rep.text, /^##DA BEGIN 2 [0-9a-f]{16}$/m);
  assert.equal((await call('GET', `/api/tools/focus-mon/audit/run/${row.last.id}`, { who: 'rscoped' })).status, 403);
  assert.equal((await call('GET', '/api/tools/focus-mon/audit/run/da-000000000000')).status, 404);
  const runs = await call('GET', `/api/tools/focus-mon/audit/${demo.id}/runs`);
  assert.equal(runs.body.runs.length, 1);
  assert.equal((await call('POST', '/api/tools/focus-mon/audit/run', { body: { ids: [demo.id] } })).body.results[0].code, 'too-soon');
  const ins = await call('GET', '/api/tools/focus-mon/audit/install.sh');
  assert.equal(ins.status, 200); assert.match(ins.text, /^#!\/bin\/sh/); assert.ok(!/PRIVATE KEY|token/i.test(ins.text), '설치 파일에 비밀 없음');
  // 준비 안 된 데모 서버 — 실행 요청해도 sudo 를 부르지 않고 '준비 안 됨' 으로
  const nos = mock.DEMO_TARGETS.find((d) => d.name === 'us-db-01');
  await call('POST', '/api/tools/focus-mon/audit/run', { body: { ids: [nos.id] } });
  for (let i = 0; i < 100 && A.jobOf(nos.id); i += 1) await new Promise((r) => setTimeout(r, 30));
  const g2 = await call('GET', '/api/tools/focus-mon/audit');
  const nr = g2.body.rows.find((r) => r.id === nos.id);
  assert.equal(nr.ready.state, 'nosudo'); assert.equal(nr.last, null, '실행하지 않았으니 회차 없음');
  // 엣지 워커 왕복 — 키가 없는 엣지: 작업을 받아 'no-key' 결과를 올리고 중앙이 반영 · ack 로 비운다
  const tok = issueAgentToken('edge-au').token;
  const et = registry.addTarget({ name: 'e1', host: '10.43.0.1', username: 'dvcmon', agent: 'edge-au' }, { agents: ['edge-au'], corps: [] }).target;
  const req = A.requestAudit(et, { mode: 'check', by: 'a' }); assert.equal(req.via, 'edge');
  // 실제 SSH 를 열지 않게 — 키를 만들고 그 대상을 인증 정지로 둔다(엣지 실행기는 정지된 대상에 접속하지 않고 곧바로 결과를 낸다)
  svc.focusKeys.ensureKey();
  const dev = authDevOf(et, svc.focusKeys.keyInfo().fingerprint); focusAuthGuard.markAuthStopped(dev.id, dev, '시험');
  const saved = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  config.agent.centralUrl = base; config.agent.centralToken = tok; config.agent.name = 'edge-au';
  try {
    worker._resetForTest();
    const s1 = await worker.syncOnce(); assert.equal(s1.ok, true, JSON.stringify(s1));
    // 엣지 실행기가 결과를 내면 워커가 곧바로(schedule 0) 다음 동기화로 올리고, 중앙의 ack 로 비운다
    for (let i = 0; i < 100 && (A.jobOf(et.id) || worker.focusMonWorkerStatus().auditResults); i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      if (worker.focusMonWorkerStatus().auditResults) await worker.syncOnce();
    }
    assert.equal(A.jobOf(et.id), null, '중앙이 결과를 받아 작업을 끝냈다');
    assert.equal(worker.focusMonWorkerStatus().auditResults, 0, 'ack 받은 결과는 지운다');
    assert.equal(A.readinessOf(et.id).lastError?.kind, 'auth-stopped', JSON.stringify(A.readinessOf(et.id)));
    focusAuthGuard.clearAuthStop(dev.id);
  } finally { Object.assign(config.agent, { centralUrl: saved.url, centralToken: saved.tok, name: saved.name }); worker._resetForTest(); }
});

/* ── ⑨ 반증 1인(2026-11-15) — F1 · F2 · F5 · F9 해석 쪽 ─────────────────────────────────────── */
const N9 = 'fedcba9876543210';
const hitWith = (fn) => { const L = [...FX('run-hit.txt')]; fn(L); return L; };
test('⑨ 반증 F1 · F2 · F5 — 출력 보관 상한 · 표지 위조 · 보고서 모양 · 잘린 근거의 디스크 값', () => {
  // F1 — 표지 꼴 줄(표지 없음)을 아무리 많이 넣어도 예산 안 · 결과 JSON 이 엣지 동기화 상한을 넘지 않는다
  const k = R.createOutputKeeper();
  k.push(`##DA BEGIN 2 ${N9}`);
  for (let i = 0; i < 3000; i += 1) k.push(`##DA ${'A'.repeat(7990)}`);
  for (let i = 0; i < 20_000; i += 1) k.push('[판정]'); // 머리 꼴 줄 폭주(머리 예산 32KB 를 넘게)
  k.push(`##DA ${N9} EXIT 0`); k.push(`##DA ${N9} END`);
  for (let i = 0; i < 100; i += 1) k.push(`##DA ${N9} END`); // END 뒤 · 되풀이 표지는 받지 않는다
  const kept = k.done(); const json = Buffer.byteLength(JSON.stringify(kept));
  const k4 = R.createOutputKeeper({ budget: { ...R.SECTION_BUDGET, 판정: 1000 } }); k4.push(`##DA BEGIN 2 ${N9}`);
  for (let i = 0; i < 20_000; i += 1) k4.push('[판정]');
  assert.ok(k4.done().filter((l) => l === '[판정]').length * 7 <= R.HEAD_BUDGET + 1000, '머리 꼴 줄은 머리 예산 안에서만 머리로 남고, 넘치면 그 구획 예산으로 센다');
  assert.ok(json < R.OUTPUT_MAX_BYTES + 512 * 1024, `보관 ${json}B — 상한 ${R.OUTPUT_MAX_BYTES}B(예전 23.5MB)`);
  assert.ok(kept.length <= R.OUT_LINES_MAX + 100); assert.equal(k.truncated(), true);
  assert.equal(kept.filter((l) => l === `##DA ${N9} END`).length, 1, 'END 는 한 번');
  // 줄 수 상한 — 짧은 줄이 많아도 중앙 정제(80,000줄)에서 끝 표지가 잘리지 않게
  const k2 = R.createOutputKeeper(); k2.push(`##DA BEGIN 2 ${N9}`); k2.push('[상세 근거]');
  for (let i = 0; i < 200_000; i += 1) k2.push('x');
  k2.push(`##DA ${N9} EXIT 0`); k2.push(`##DA ${N9} END`);
  const kept2 = k2.done(); assert.ok(kept2.length < 80_000, `${kept2.length}`); assert.equal(P.splitRun(kept2).ended, true, '끝 표지가 남는다');
  // 넘친 구획은 그 뒤를 받지 않는다(앞부분만 — 작은 줄이 뒤에 끼어 근거 번호가 중간에서 빠지지 않게)
  const k3 = R.createOutputKeeper({ budget: { ...R.SECTION_BUDGET, '상세 근거': 200 } });
  for (const l of [`##DA BEGIN 2 ${N9}`, '[상세 근거]', `  #1 ${'a'.repeat(150)}`, `  #2 ${'b'.repeat(150)}`, '  #3 short']) k3.push(l);
  const kept3 = k3.done(); assert.ok(kept3.some((l) => l.startsWith('  #1 ')) && !kept3.includes('  #3 short'), JSON.stringify(kept3.map((l) => l.slice(0, 8))));
  // F2 — 근거 메시지에 줄바꿈으로 넣은 '완료 | x' · 표지 꼴 END → 숫자를 쓰지 않는다(report-shape) · 표지로 받지 않는다
  const inj = hitWith((L) => { const i = L.findIndex((l) => l.startsWith('  #1 ')); L.splice(i + 1, 0, '완료 | x', '##DA END'); });
  const a1 = A.analyzeRun({ kind: 'done', out: inj });
  assert.equal(a1.outcome, 'report-shape', JSON.stringify(a1.summary.shape)); assert.ok(a1.summary.shape.includes('done-early'));
  assert.equal(P.splitRun(inj).ended, true, '표지 없는 ##DA END 는 끝 표지가 아니다 — 진짜 END 까지 읽는다');
  // 깨끗한 서버에 근거 한 줄(번호 · 식별자 포함)을 넣으면 — 판정 건수 합과 맞지 않아 report-shape(‘기록 있음’ 으로 세지 않는다)
  const clean = [...FX('run-clean.txt')]; const ci = clean.indexOf('[상세 근거]');
  clean.splice(ci + 1, 0, '  #1 [매체 오류 기록] /var/log/messages:9 | 시간 비교 불가 | SN=ZZ99 | 장치 sdb | kernel | critical medium error');
  const a2 = A.analyzeRun({ kind: 'done', out: clean });
  assert.equal(a2.outcome, 'report-shape'); assert.ok(a2.summary.shape.includes('judge-mismatch'));
  // 구획 머리 되풀이 · 번호 건너뜀 · 번호 없는 오류 근거
  assert.ok(A.analyzeRun({ kind: 'done', out: hitWith((L) => L.splice(L.indexOf('[상세 근거]') + 2, 0, '[해석 범위]', '[상세 근거]')) }).summary.shape.includes('section-order'));
  assert.ok(A.analyzeRun({ kind: 'done', out: hitWith((L) => L.splice(L.indexOf('[상세 근거]') + 1, 0, '  #9 [매체 오류 기록] x:1 | 시간 비교 불가 | 식별자 없음 | m')) }).summary.shape.includes('evidence-number'));
  assert.ok(A.analyzeRun({ kind: 'done', out: hitWith((L) => L.splice(L.indexOf('[해석 범위]') - 1, 0, '  [매체 오류 기록] x:1 | 시간 비교 불가 | 식별자 없음 | m')) }).summary.shape.includes('evidence-kind'));
  assert.deepEqual(A.analyzeRun({ kind: 'done', out: FX('run-hit.txt') }).summary.shape, [], '진짜 출력은 모양 검사를 지난다');
  // 여러 줄 로그의 이어진 줄(근거 꼴이 아님)은 숫자를 바꾸지 않으므로 모양 이상이 아니다
  assert.equal(A.analyzeRun({ kind: 'done', out: hitWith((L) => { const i = L.findIndex((l) => l.startsWith('  #2 ')); L.splice(i + 1, 0, '    call trace: blk_update_request+0x1a/0x2c'); }) }).outcome, 'done');
  // F5 — 근거가 2,000줄(화면 상한)을 넘어도 디스크별 값은 모든 줄로 센다 · 보관 상한에서 잘리면 디스크 값은 null(0 아님)
  const many = hitWith((L) => {
    const i = L.indexOf('[상세 근거]');
    const ev = []; let n = 0;
    for (let j = 0; j < 2500; j += 1) ev.push(`  #${++n} [I/O·경로 오류 기록] /var/log/messages:${j} | 시간 비교 불가 | 식별자 없음 | 장치 sdc | kernel | I/O error ${j}`);
    let k3 = i + 1; while (L[k3] && /^ {2}#\d+ /.test(L[k3])) { L[k3] = L[k3].replace(/^ {2}#\d+ /, () => `  #${++n} `); k3 += 1; }
    L.splice(i + 1, 0, ...ev);
    const jx = L.findIndex((l) => l.startsWith('    I/O·경로 오류 기록 | ')); L[jx] = `    I/O·경로 오류 기록 | ${1 + 2500}건`;
  });
  const a3 = A.analyzeRun({ kind: 'done', out: many });
  assert.equal(a3.outcome, 'done', JSON.stringify(a3.summary.shape)); assert.equal(a3.summary.disksKnown, true);
  assert.deepEqual(a3.summary.disks.map((d) => d.mediaN), [0, 2], '앞 2,000줄 밖의 SN 근거도 디스크에 붙는다');
  const kc = R.createOutputKeeper({ budget: { ...R.SECTION_BUDGET, '상세 근거': 64 * 1024 } }); for (const l of many) kc.push(l);
  const a4 = A.analyzeRun({ kind: 'done', out: kc.done() });
  assert.equal(a4.summary.disksKnown, false); assert.deepEqual(a4.summary.disks.map((d) => d.mediaN), [null, null], '잘렸으면 디스크 값은 모름');
  assert.ok(a4.summary.counts.io >= 2501, '서버 합계는 판정 줄 건수로');
  const row4 = { id: 'q', name: 'q', corp: null, smodel: null, ready: { state: 'ready' }, job: null, last: { outcome: a4.outcome, at: 1, summary: a4.summary } };
  const dm = G.byDiskModel([row4]);
  assert.equal(dm[0].n, 0); assert.equal(dm[0].unknown, 2); assert.equal(dm[0].rate, null, '모르는 디스크는 비율 분모에서 빠진다(0% 가 아니다)');
  // F9-c — RAID 줄 해석은 되돌아가기 없이(공백 긴 줄 8,000개)
  const raid = ['Drive /c0/e32/s1 :', ...Array.from({ length: 8000 }, () => `SN = ${' '.repeat(270)}${'Z'.repeat(126)}`)];
  // 비율로(절대 시간 단언 금지 규약 TESTDOC2613-02) — 같은 줄 수 · 길이의 평범한 줄과 견준다(예전 정규식은 546ms 대 수 ms)
  const plain = ['Drive /c0/e32/s1 :', ...Array.from({ length: 8000 }, () => `SN = ${'Z'.repeat(396)}`)];
  const tm = (l) => { const a = performance.now(); P.parseDisks([], l); return performance.now() - a; };
  tm(plain); const tPlain = Math.max(2, tm(plain)); const tBad = tm(raid);
  assert.ok(tBad / tPlain < 8, `되돌아가기 줄 ${tBad.toFixed(1)}ms · 평범한 줄 ${tPlain.toFixed(1)}ms`);
  // F9-g — 원격 이름을 열쇠로 쓰는 표는 프로토타입 없는 객체
  const pr = P.parseReady(['##DR 1', '##DR file __proto__ x 0:0:644', '##DR end']);
  assert.equal(Object.getPrototypeOf(pr.files), null); assert.equal(({}).sha, undefined, '프로토타입 오염 없음');
});

/* ── ⑩ 반증 F3 · F4 · F7 · F8 · F9 — 중앙 작업 · 반영 ───────────────────────────────────────── */
test('⑩ 반증 F3 · F4 · F7 · F8 · F9 — 엣지 줄 대기 · 늦은 결과 · sudo 실패 회차 · 접속처 변경 · 상태 파일 쓰기', async () => {
  resetAll();
  const ag = ['edge-kr'];
  const ts = [1, 2, 3].map((i) => registry.addTarget({ name: `q${i}`, host: `10.44.0.${i}`, port: 22, username: 'dvcmon', agent: 'edge-kr' }, { agents: ag }).target);
  A.startAuditService({ keys });
  const t0 = Date.now();
  const reqs = ts.map((t) => A.requestAudit(t, { mode: 'run', now: t0 }));
  const mine = new Map(ts.map((t) => [t.id, t]));
  assert.equal(A.handleEdgeAudit('edge-kr', mine, {}, t0).jobs.length, 3);
  // F3 — 40분 동안 매분 진행 목록에 실리면 지우지 않는다(노드 동시 1 — 앞 작업을 기다린다)
  for (let m = 1; m <= 40; m += 1) A.handleEdgeAudit('edge-kr', mine, { active: reqs.map((r, i) => ({ runId: r.runId, state: i === 0 && m < 20 ? 'running' : 'queued' })) }, t0 + m * 60_000);
  assert.ok(ts.every((t) => A.jobOf(t.id)), '엣지가 보고하는 동안은 lost 가 아니다');
  // 두 번째 작업만 보고가 끊기면 10분 뒤 lost · 그 뒤 온 결과는 반영한다(기억 2시간)
  for (let m = 41; m <= 51; m += 1) A.handleEdgeAudit('edge-kr', mine, { active: [reqs[0], reqs[2]].map((r) => ({ runId: r.runId, state: 'queued' })) }, t0 + m * 60_000);
  A.sweep(t0 + 51 * 60_000);
  assert.ok(A.jobOf(ts[0].id) && A.jobOf(ts[2].id), '계속 보고되는 작업은 남는다');
  assert.equal(A.jobOf(ts[1].id), null); assert.equal(A.readinessOf(ts[1].id).lastError.kind, 'lost');
  const late = { runId: reqs[1].runId, result: { mode: 'run', ok: true, kind: 'done', ran: true, ready: FX('ready-ok.txt'), out: FX('run-hit.txt'), outBytes: 1 } };
  const y = A.handleEdgeAudit('edge-kr', mine, { results: [late] }, t0 + 55 * 60_000);
  assert.deepEqual(y.ack, [reqs[1].runId]);
  for (let i = 0; i < 50 && !A.readinessOf(ts[1].id)?.lastExecAt; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(A.readinessOf(ts[1].id).lastExecAt, '늦게 온 결과를 반영했다');
  assert.equal((await A.latestFor([ts[1].id])).get(ts[1].id).summary.ep, A.endpointKey(ts[1]), '회차에 접속처 지문');
  // 같은 결과가 두 번 와도(ack 를 잃음) 한 번만 반영
  A.handleEdgeAudit('edge-kr', mine, { results: [late] }, t0 + 56 * 60_000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await db.listAudits(ts[1].id)).length, 1);
  // 중앙이 모르는 진행 중 작업 → 엣지에 '빼라'(cancel)
  const z = A.handleEdgeAudit('edge-kr', mine, { active: [{ runId: 'da-0123456789ab', state: 'queued' }] }, t0 + 57 * 60_000);
  assert.deepEqual(z.cancel, ['da-0123456789ab']);
  // F8 — 상태가 그대로인 진행 보고는 상태 파일을 다시 쓰지 않는다
  const f = path.join(DIR, 'focusmon-audit.json');
  const act = { active: [{ runId: reqs[0].runId, state: 'queued' }] };
  A.handleEdgeAudit('edge-kr', mine, act, t0 + 58 * 60_000); const m1 = fs.statSync(f).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 5; i += 1) A.handleEdgeAudit('edge-kr', mine, act, t0 + 58 * 60_000 + i * 2000);
  assert.equal(fs.statSync(f).mtimeMs, m1, '바뀐 것이 없으면 쓰지 않는다');
  // F7 — 접속처가 바뀌면 진행 중 작업을 지우고 결과를 반영하지 않는다 · 준비 상태를 되살리지 않는다
  A.forgetReadiness(ts[0].id);
  assert.equal(A.jobOf(ts[0].id), null);
  const old = { runId: reqs[0].runId, result: { mode: 'run', ok: true, kind: 'done', ran: true, ready: FX('ready-ok.txt'), out: FX('run-hit.txt'), outBytes: 1 } };
  A.handleEdgeAudit('edge-kr', mine, { results: [old] }, t0 + 59 * 60_000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await db.listAudits(ts[0].id)).length, 0, '지운 작업의 결과는 쓰지 않는다'); assert.equal(A.readinessOf(ts[0].id)?.state, undefined);
  const dr = await A.ingestResult({ runId: reqs[0].runId, tid: ts[0].id, mode: 'run', requestedAt: t0 }, old.result, { node: 'edge-kr' });
  assert.equal(dr.dropped, true, '지운 작업을 직접 넘겨도 반영하지 않는다(심층 방어)');
  // 반영 중에 접속처가 바뀌어도 준비 상태를 되살리지 않는다
  const r9 = A.requestAudit(ts[2], { mode: 'run', now: Date.now() }) ; assert.equal(r9.code, 'busy', '아직 앞 작업이 있다');
  const job2 = { runId: reqs[2].runId, tid: ts[2].id, mode: 'run', requestedAt: t0, ep: A.endpointKey(ts[2]) };
  const p = A.ingestResult(job2, { ok: true, kind: 'done', ran: true, ready: FX('ready-ok.txt'), out: FX('run-hit.txt') }, { node: 'edge-kr' });
  A.forgetReadiness(ts[2].id); await p;
  assert.equal(A.readinessOf(ts[2].id)?.state, undefined, '반영 도중 지운 준비 상태가 되살아나지 않는다');
  // 라우트 — 접속처가 바뀐 대상의 '최근 결과' 는 비고, 회차 목록에 '예전 접속처' 표시
  const up = registry.updateTarget(ts[1].id, { host: '10.44.0.99' }, { agents: ag });
  assert.equal(up.moved, true);
  const g = await call('GET', '/api/tools/focus-mon/audit');
  assert.equal(g.body.rows.find((r) => r.id === ts[1].id).last, null, '예전 주소의 회차를 새 주소의 최근 결과로 쓰지 않는다');
  const rr = await call('GET', `/api/tools/focus-mon/audit/${ts[1].id}/runs`);
  assert.equal(rr.body.runs[0].oldEndpoint, true);
  // 엣지가 아예 연락하지 않으면(재배달도 없음) 마지막으로 본 때부터 SEEN_TTL 뒤 lost
  const t6 = registry.addTarget({ name: 'q6', host: '10.44.0.6', port: 22, username: 'dvcmon', agent: 'edge-kr' }, { agents: ag }).target;
  const n6 = Date.now(); const r6 = A.requestAudit(t6, { mode: 'run', now: n6 });
  A.handleEdgeAudit('edge-kr', new Map([[t6.id, t6]]), {}, n6);
  A.sweep(n6 + A.SEEN_TTL_MS - 60_000); assert.ok(A.jobOf(t6.id), '시한 전');
  A.sweep(n6 + A.SEEN_TTL_MS + 60_000); assert.equal(A.jobOf(t6.id), null, `${A.SEEN_TTL_MS / 60_000}분 동안 보지 못하면 lost`); void r6;
  // F4 — sudo 자체가 실패(표준 출력 빔)해도 회차를 남기고 까닭(표준 오류 첫 줄)을 싣는다 · 실행 간격은 세지 않는다
  const t4 = registry.addTarget({ name: 'q4', host: '10.44.0.4', port: 22, username: 'dvcmon', agent: 'edge-kr' }, { agents: ag }).target;
  const r4 = A.requestAudit(t4, { mode: 'run' });
  await A.ingestResult({ runId: r4.runId, tid: t4.id, mode: 'run', requestedAt: Date.now(), ep: A.endpointKey(t4) }, { ok: true, kind: 'done', ran: true, ready: FX('ready-ok.txt'), out: [], code: 1, stderr: 'sudo: unable to execute /usr/local/sbin/dvc-disk-audit: Permission denied\n' }, { node: 'edge-kr' });
  const l4 = (await A.latestFor([t4.id])).get(t4.id);
  assert.equal(l4.outcome, 'no-start'); assert.match(l4.summary.stderr, /unable to execute/); assert.equal(A.readinessOf(t4.id).lastExecAt, undefined, '돌지 않았으니 10분 문턱을 세지 않는다');
  // F9-b — 여유 공간이 부족하면 쓰지 않고 까닭을 남긴다
  A.setSpaceProbe(() => true);
  const t5 = registry.addTarget({ name: 'q5', host: '10.44.0.5', port: 22, username: 'dvcmon', agent: 'edge-kr' }, { agents: ag }).target;
  const r5 = A.requestAudit(t5, { mode: 'run' });
  await A.ingestResult({ runId: r5.runId, tid: t5.id, mode: 'run', requestedAt: Date.now(), ep: A.endpointKey(t5) }, { ok: true, kind: 'done', ran: true, ready: FX('ready-ok.txt'), out: FX('run-hit.txt') }, { node: 'edge-kr' });
  assert.equal((await db.listAudits(t5.id)).length, 0); assert.equal(A.readinessOf(t5.id).lastError.kind, 'db');
  A.setSpaceProbe(() => false);
  // F9-i — 등록부를 못 읽으면 보조 조회도 503
  fs.writeFileSync(path.join(DIR, 'focusmon-targets.json'), '{bad'); registry._resetForTest();
  for (const p2 of ['/api/tools/focus-mon/audit/jobs', `/api/tools/focus-mon/audit/${t4.id}/runs`, `/api/tools/focus-mon/audit/run/${l4.id}`, `/api/tools/focus-mon/audit/run/${l4.id}/report.txt`]) {
    assert.equal((await call('GET', p2)).status, 503, p2);
  }
  resetAll();
});

/* ── ⑪ 반증 F1 · F3 · F9-e — 엣지 보관 · 줄 자르기 · 대기열 취소 ─────────────────────────────── */
test('⑪ 반증 F1 · F3 · F9-e — 엣지 결과 크기 · 413 · 보관 시한 · 실패 뒤 한 번 건너뛰기 · 긴 줄 자르기 · 취소', async () => {
  const W = worker._auditForTest(); W.reset();
  const big = { mode: 'run', ok: true, kind: 'done', ran: true, ready: ['##DR 1'], out: Array.from({ length: 1500 }, () => 'z'.repeat(8000)), outBytes: 12e6 };
  worker.queueAuditResult('da-aaaaaaaaaaaa', big, 1000);
  assert.equal(W.results[0].result.kind, 'too-big', '결과 하나가 상한을 넘으면 원문을 빼고 싣는다'); assert.ok(W.results[0].size < 64 * 1024);
  W.reset();
  worker.queueAuditResult('da-bbbbbbbbbbbb', { mode: 'run', ok: true, kind: 'done', ready: [], out: ['x'] }, 1000);
  const sent = worker.auditResultsToSend(); assert.equal(sent.length, 1);
  worker.auditSendFailed(sent, 413, 2000);
  // 51회차 #5: 작은 결과는 첫 413 에 원문을 지우지 않는다(원인이 표본 · 프로세스일 수 있다 — 성공한 설치가 'unreachable' 로 남던 것) — 두 번째 413 에 지운다
  assert.equal(worker._auditForTest().results[0].result.kind, 'done', '첫 413 — 작은 결과는 그대로');
  assert.deepEqual(worker.auditResultsToSend(), [], '실패 뒤 한 번은 결과 없이(표본 · 보류 시한이 먼저)');
  worker.auditSendFailed(worker._auditForTest().results.slice(), 413, 2100);
  assert.equal(worker._auditForTest().results[0].result.kind, 'too-big', '두 번째 413 — 그 결과의 원문을 버린다(같은 본문으로 영원히 막히지 않게)');
  worker.auditResultsToSend();
  worker.expireAuditResults(1000 + worker.AUDIT_HOLD_MS + 1);
  assert.equal(worker._auditForTest().results.length, 0); assert.equal(worker._auditForTest().dropped, 1, '보관 시한 — 버리고 센다');
  W.reset();
  // 긴 줄 — 끊지 않고 자른다
  const { EventEmitter } = await import('node:events');
  const { _execStreamForTest } = await import('../src/proxy/sshExec.js');
  const conn = { exec: (cmd, o, cb) => { const s = new EventEmitter(); s.stderr = new EventEmitter(); s.close = () => {}; s.destroy = () => {}; cb(null, s); setImmediate(() => { s.emit('data', Buffer.from('a'.repeat(300))); s.emit('data', Buffer.from('b'.repeat(300) + '\nnext\n')); s.emit('close', 0); }); } };
  const got = []; const res = await _execStreamForTest(conn, 'x', { onLine: (l) => got.push(l), maxLine: 100, cutLong: true });
  assert.deepEqual(got.map((l) => l.length), [100, 4]); assert.equal(got[1], 'next'); assert.equal(res.cutLines, 1);
  await assert.rejects(_execStreamForTest(conn, 'x', { onLine: () => {}, maxLine: 100 }), /상한/, '기본(집중 모니터링 수집)은 예전처럼 끊는다');
  // 대기열 취소 — 기다리는 것만
  const q = R.createAuditRunner({ keys, onResult: () => {}, exec: () => new Promise((r) => setTimeout(() => r({ ok: true, kind: 'done', ready: [], out: [] }), 50)) });
  q.submit({ runId: 'c1', mode: 'run', target: T }); q.submit({ runId: 'c2', mode: 'run', target: { ...T, id: 'fm-aaaa0077' } });
  assert.equal(q.cancel('c1'), false, '도는 중인 것은 끝까지'); assert.equal(q.cancel('c2'), true); assert.equal(q.has('c2'), false);
  await new Promise((r) => setTimeout(r, 80));
});
