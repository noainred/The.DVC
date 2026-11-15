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

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonaudit3110-'));
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
  for (const c of [B.READY_COMMAND, B.RUN_COMMAND, B.WRAPPER_TEXT]) assert.ok(!/\$\{|<%|\{\{/.test(c), '끼워 넣을 자리 없음');
  assert.match(B.READY_COMMAND, /sudo -n -l \/usr\/local\/sbin\/dvc-disk-audit/, '준비 확인은 sudo 를 실행하지 않고 허용 여부만');
  assert.ok(!/sudo -n \/usr/.test(B.READY_COMMAND), '준비 확인은 root 로 아무것도 돌리지 않는다');
  assert.match(B.WRAPPER_TEXT, /if \[ "\$#" -ne 0 \]; then echo '##DA ERR args'; exit 64; fi/, '실행 파일은 인자를 거절');
  assert.match(B.WRAPPER_TEXT, /timeout -s KILL 1200 nice -n 19 \$IO "\$PY" -I "\$PROG"/, '시한 · 낮은 우선순위 · 격리 모드');
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
  assert.match(inst, /\*\[!A-Za-z0-9._-\]\*\) echo "사용법/, '계정 이름 글자 제한');
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
  fs.writeFileSync(w, B.WRAPPER_TEXT.replace(`PROG=${B.PROGRAM_PATH}`, `PROG=${prog}`).replace('mktemp -d /tmp/dvc-disk-audit.XXXXXXXX', `mktemp -d ${DIR}/dvc-disk-audit.XXXXXXXX`));
  const r = spawnSync('sh', [w], { encoding: 'utf8', timeout: 60_000 });
  const lines = r.stdout.split('\n');
  const sp = P.splitRun(lines);
  assert.equal(sp.begun, true); assert.equal(sp.ended, true); assert.equal(sp.rc, 0, r.stdout.slice(0, 400));
  assert.ok(sp.report.some((l) => l.includes('[불명]')));
  assert.equal(fs.readdirSync(DIR).filter((n) => n.startsWith('dvc-disk-audit.')).length, 0, '임시 폴더(보고서 파일 포함)를 지웠다');
  const r2 = spawnSync('sh', [w, 'extra'], { encoding: 'utf8' });
  assert.equal(r2.status, 64); assert.match(r2.stdout, /##DA ERR args/);
  const sp2 = P.splitRun(r2.stdout.split('\n')); assert.equal(sp2.err, 'args');
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
  assert.equal(out({ lines: [], stderr: 'sudo: a password is required' }), 'sudo-denied');
  assert.equal(out({ lines: [], stderr: 'sudo: sorry, you must have a tty to run sudo' }), 'sudo-tty');
  assert.equal(out({ lines: ['##DA ERR nopython'] }), 'no-start');
  assert.equal(out({ lines: ['##DA BEGIN 1', '##DA ERR tmp'] }), 'wrapper-tmp');
  assert.equal(out({ lines: ['##DA BEGIN 1', 'x', '##DA EXIT 137', '##DA END'] }), 'program-timeout');
  assert.equal(out({ lines: ['##DA BEGIN 1', 'x', '##DA EXIT 1', '##DA END'] }), 'program-error');
  assert.equal(out({ lines: ['##DA BEGIN 1', 'x'] }), 'cut');
  assert.equal(out({ lines: ['##DA BEGIN 1'], kind: 'timeout' }), 'timeout');
  assert.equal(out({ lines: ['##DA BEGIN 1', '##DA EXIT 0', '##DA END'], complete: false }), 'incomplete');
  assert.equal(out({ lines: FX('run-hit.txt') }), 'done');
});

/* ── ④ ── */
test('④ 출력 예산 — 구획 머리 보존 · 생략 줄 · 근거가 잘리면 판정 줄 건수로', () => {
  const k = R.createOutputKeeper({ budget: { ...R.SECTION_BUDGET, '상세 근거': 600, '해석 범위': 1 } }); // 해석 범위 예산 1바이트 — 머리는 그래도 남아야 한다
  for (const l of FX('run-hit.txt')) k.push(l);
  for (let i = 0; i < 50; i += 1) k.push(`  #${100 + i} [매체 오류 기록] /var/log/messages:${i} | 시간 비교 불가 | 식별자 없음 | kernel host=vm | medium error ${i}`);
  const lines = k.done();
  assert.ok(lines.includes('[상세 근거]') && lines.includes('[해석 범위]') && lines.includes('##DA END'), '머리 · 표지는 예산과 상관없이');
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
  assert.equal(rep.status, 200); assert.match(rep.text, /##DA BEGIN 1/);
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
