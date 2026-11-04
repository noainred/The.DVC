/**
 * test/bareosErrLog2872.test.js — v2.872 통합 에러 로그 '로그 서랍 · 묶어 보기'(시안 docs/design/bareos-errlog · 사용자 컨펌 2026-11-04 '구현해').
 *  ① logFirstError — 첫 오류 줄(Fatal error 먼저 · 보고 머리줄 · 보고 칸 제외 · 없으면 null) · 서명(VM · 숫자 지움) · 대조(같은 · 다른 · 없음 · 못 읽음 · 전부 제각각이면 same 없음)
 *  ② withShapeGroups — Bareos 실행은 법인 · 결과 · 메시지가 같고 1시간 안이면 한 묶음(잡 이름이 달라도 — 예전 키로는 한 번도 묶이지 않았다) · 그 밖은 예전 키
 *  ③ bareosRows 에 jobKey(원장 잡 id) · relay
 *  ④ ops.logs — 이 잡의 실행인지 검사 · 세션째 끊기면 남은 것 건너뜀 · 시한 신호 · 첫 오류 줄만
 *  ⑤ edgeResult.logs — 아는 칸 · 상한 · firstError 칸이 없으면 못 읽음
 *  ⑥ POST /tools/bareos-backup/logs/bulk(실제 라우터 + 가짜 Director) — 400(빈 · 상한 초과) · 범위 밖은 없는 대상과 같은 답 · 대조 결과 · 원문 없음
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2872-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const LF = await import('../src/bareos/logFirstError.js');
const ER = await import('../src/veeam/backupErrors.js');
const { OPS, LOGS_MAX } = await import('../src/bareos/ops.js');
const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

const L = (t, s) => `2026-11-04 02:44:${String(s).padStart(2, '0')} ${t}`;
const SNAP = (vm) => `bareos-fd JobId 20612: Fatal error: python-fd: Error creating snapshot for VM ${vm}: A general system error occurred: Operation timed out`;

test('① 첫 오류 줄 · 서명 · 대조', () => {
  const lines = [
    L('bareos-dir JobId 20612: Start Backup JobId 20612, Job=pv-x.2026-11-04_02.42.11_05', 1),
    L('bareos-sd JobId 20612: Error: block.c:123 Write error', 2),
    L(SNAP('LESASHSPO04'), 3),
    L('bareos-dir JobId 20612: Error: Bareos bareos-dir 25.1.2 (01Jan26):', 4),
    L('bareos-dir JobId 20612:   SD Errors:              0', 5),
  ];
  assert.match(LF.firstErrorLine(lines), /^Fatal error: python-fd: Error creating snapshot for VM LESASHSPO04/, 'Fatal error 가 앞의 Error 보다 먼저');
  assert.equal(LF.firstErrorLine([lines[0], lines[1]]), 'Error: block.c:123 Write error', 'Fatal 이 없으면 첫 Error');
  assert.equal(LF.firstErrorLine([lines[0], lines[3], lines[4]]), null, '보고 머리줄 · 보고 칸(SD Errors: 0)은 오류가 아니다 — 없으면 null(0 이 아니다)');
  assert.equal(LF.firstErrorLine(null), null);
  assert.ok(LF.firstErrorLine([L(`bareos-fd JobId 1: Fatal error: ${'x'.repeat(5000)}`, 1)]).length <= 400, '길이 상한');
  const a = LF.errorSig(LF.firstErrorLine([L(SNAP('LESASHSPO04'), 1)]), { vmName: 'LESASHSPO04' });
  const b = LF.errorSig(LF.firstErrorLine([L(SNAP('LESASHSP07'), 1)]), { vmName: 'LESASHSP07' });
  assert.equal(a, b, 'VM 이름 · 숫자를 지우면 같은 오류');
  assert.match(a, /<vm>/);
  const c = LF.compareFirstErrors([
    { ok: true, firstError: 'Fatal error: snap VM A1: timed out', vmName: 'A1' },
    { ok: true, firstError: 'Fatal error: snap VM B2: timed out', vmName: 'B2' },
    { ok: true, firstError: "Fatal error: Disk '[DS02] C/c.vmdk' is not accessible", vmName: 'C' },
    { ok: false, reason: 'connect' },
    { ok: true, firstError: null },
  ]);
  assert.deepEqual(c.items.map((x) => x.match), ['same', 'same', 'other', 'unread', 'none']);
  assert.deepEqual([c.summary.same, c.summary.other, c.summary.none, c.summary.unread, c.summary.total], [2, 1, 1, 1, 5]);
  assert.equal(c.summary.topLine, 'Fatal error: snap VM A1: timed out');
  const d = LF.compareFirstErrors([{ ok: true, firstError: 'Fatal error: a' }, { ok: true, firstError: 'Fatal error: b' }]);
  assert.deepEqual(d.items.map((x) => x.match), ['other', 'other'], '전부 제각각이면 같은 오류라고 말할 근거가 없다');
  assert.equal(d.summary.topLine, null);
  assert.deepEqual(LF.compareFirstErrors([{ ok: true, firstError: 'Fatal error: a' }]).items[0].match, 'same', '한 건뿐이면 그 줄이 대표');
});

// v2.887: 예전 판(2배 크기 · 한 번씩 재기 · 기준 4배)은 CI 병렬 실행에서 비율 16.35 로 흔들렸다(PR #906 CI — 대상 코드는 그대로, 로컬 3/3 통과).
//   ReDoS 회귀는 비율로 재되(docs/rules/common.md) 8배 크기 · 작은 쪽 · 큰 쪽 번갈아 5회 각각 최솟값 · 기준 24배(선형 약 8 · 제곱 약 64) — wiki 마크다운(#905)과 같은 틀.
test('① ReDoS — 따옴표 · 공백 긴 줄도 선형(길이 8배에 시간 24배 미만 · 번갈아 5회 최솟값)', () => {
  const mk = (n) => `Fatal error: ${'"'.repeat(n)} ${' '.repeat(n)}x`;
  const run = (s) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) LF.errorSig(LF.firstErrorLine([s])); return Number(process.hrtime.bigint() - t0); };
  const small = mk(1000); const big = mk(8000);
  run(small); run(big); // 데우기
  let a = Infinity; let b = Infinity;
  for (let k = 0; k < 5; k++) { a = Math.min(a, run(small)); b = Math.min(b, run(big)); }
  const r = b / Math.max(1, a);
  assert.ok(r < 24, `비율 ${r.toFixed(2)}(작은 쪽 ${(a / 1e6).toFixed(2)}ms · 큰 쪽 ${(b / 1e6).toFixed(2)}ms)`);
});

test('② 같은 모양 묶음 — Bareos 실행은 1시간 창 · 잡 이름 무관 · 그 밖은 예전 키', () => {
  const T = Date.UTC(2026, 10, 4, 2, 48);
  const run = (k, at, o = {}) => ({ at, vc: 'oc2', vcName: 'OC2', src: 'bareos', kind: 'fail', job: `pv-54220daf-vm-${k}`, vm: `VM${k}`, vmId: `oc2:vm-${k}`, jobKey: `j${k}`, jobid: 20600 + k, msg: '치명 오류 · Full · 오류 1건', open: 'bareos', ...o });
  const rows = [];
  for (let k = 0; k < 15; k++) rows.push(run(k, T - k * 25_000));
  rows.push(run(20, T - 3 * 3_600_000));                          // 같은 모양이지만 3시간 전 — 다른 묶음
  rows.push(run(21, T - 60_000, { kind: 'warn', msg: '경고와 함께 끝남 · Incremental' }));
  rows.push(run(22, T - 120_000, { vc: 'oc3', vcName: 'OC3' }));     // 다른 법인
  for (let k = 0; k < 4; k++) rows.push({ at: T - k * 600_000, vc: '', vcName: '', src: 'veeam', kind: 'fail', job: '11. H/W Monitoring', vm: 'HM', msg: 'EM 세션 결과 Failed · HM', open: 'em' });
  const g = ER.withShapeGroups(rows);
  const oc2 = g.filter((r) => r.vc === 'oc2' && r.kind === 'fail' && r.jobKey !== 'j20');
  assert.equal(new Set(oc2.map((r) => r.group)).size, 1, 'OC2 15건은 한 묶음');
  assert.ok(oc2.every((r) => r.same === 15));
  const far = g.find((r) => r.jobKey === 'j20');
  assert.notEqual(far.group, oc2[0].group, '1시간 넘게 떨어지면 다른 묶음');
  assert.equal(far.same, 1);
  assert.equal(g.find((r) => r.jobKey === 'j21').same, 1);
  assert.equal(g.find((r) => r.jobKey === 'j22').same, 1);
  const vee = g.filter((r) => r.src === 'veeam');
  assert.equal(new Set(vee.map((r) => r.group)).size, 1);
  assert.equal(vee[0].same, 4, 'Veeam 은 예전처럼 같은 잡 · 메시지(창 없음)');
  // 창은 묶음의 가장 옛 행 기준으로 이어진다(사슬 — 40분 간격 셋은 한 묶음)
  const chain = ER.withShapeGroups([run(1, T), run(2, T - 40 * 60_000), run(3, T - 80 * 60_000)]);
  assert.equal(new Set(chain.map((r) => r.group)).size, 1);
  assert.equal(ER.SHAPE_WINDOW_MS, 3_600_000);
  const fin = ER.finishErrors(rows);
  assert.ok(fin.rows.every((r) => typeof r.group === 'string' && r.same >= 1), 'finishErrors 가 묶음을 단다');
});

test('③ bareosRows — jobKey(원장 잡 id) · relay(엣지 대행 법인)', () => {
  const now = Date.now();
  const digests = new Map([['vc-a:vm-1', { id: 'job-1', vmId: 'vc-a:vm-1', vmName: 'web-01', bareosJob: 'pv-a-web', lastRun: { jobid: 31, status: 'f', level: 'F', endedAt: now - 1000 } }]]);
  const [r] = ER.bareosRows(digests, null, { id: 'vc-a', name: 'Seoul', relay: true }, now - 86_400_000);
  assert.deepEqual([r.jobKey, r.jobid, r.relay, r.open], ['job-1', 31, true, 'bareos']);
  assert.equal(r.msg, '치명 오류 · Full', '원문 안내 꼬리 없음 — 원문은 [로그] 서랍(열기 칸이 가로 스크롤 뒤로 밀렸다)');
  const [r2] = ER.bareosRows(digests, null, { id: 'vc-a', name: 'Seoul' }, now - 86_400_000);
  assert.equal('relay' in r2, false);
});

test('④ ops.logs — 이 잡의 실행인지 · 세션 끊김 · 시한 · 첫 오류 줄만', async () => {
  const mk = (rows, fail = {}) => ({
    async call(cmd) {
      const id = Number(/jobid=(\d+)/.exec(cmd)?.[1]);
      if (fail[id]) { const e = new Error(fail[id]); e.code = fail[id]; throw e; }
      if (cmd.startsWith('llist jobid=')) return { jobs: rows[id] ? [{ jobid: id, name: rows[id].name, type: 'B', level: 'F', jobstatus: 'f', starttime: '2026-11-04 02:42:00', endtime: '2026-11-04 02:44:00' }] : [] };
      if (cmd.startsWith('list joblog')) return { joblog: (rows[id]?.log || []).map((t) => ({ time: '2026-11-04 02:44:21', logtext: t })) };
      return { error: ['unknown'] };
    },
  });
  const rows = { 1: { name: 'pv-a', log: [SNAP('A')] }, 2: { name: 'pv-b', log: ['bareos-dir JobId 2: Start Backup'] }, 3: { name: 'pv-c', log: [SNAP('C')] } };
  const out = await OPS.logs(mk(rows), { items: [{ key: 0, jobid: 1, name: 'pv-a' }, { key: 1, jobid: 2, name: 'pv-b' }, { key: 2, jobid: 3, name: 'pv-other' }] });
  assert.match(out[0].firstError, /^Fatal error: python-fd: Error creating snapshot for VM A/);
  assert.equal(out[0].ok, true);
  assert.equal(out[0].lines, 1);
  assert.equal('log' in out[0], false, '원문은 돌려주지 않는다');
  assert.deepEqual([out[1].ok, out[1].firstError], [true, null], '오류 줄이 없으면 null');
  assert.deepEqual([out[2].ok, out[2].code], [false, 'invalid'], '다른 잡의 jobid 는 읽지 않는다');
  const dead = await OPS.logs(mk(rows, { 1: 'closed' }), { items: [{ key: 0, jobid: 1, name: 'pv-a' }, { key: 1, jobid: 3, name: 'pv-c' }] });
  assert.deepEqual(dead.map((x) => x.code), ['closed', 'skipped'], '세션째 끊기면 남은 것은 건너뜀');
  const ac = new AbortController(); ac.abort();
  const late = await OPS.logs(mk(rows), { items: [{ key: 0, jobid: 1, name: 'pv-a' }] }, { signal: ac.signal });
  assert.equal(late[0].code, 'skipped', '시한이 지나면 시작하지 않는다');
  const many = await OPS.logs(mk(rows), { items: Array.from({ length: 40 }, (_, i) => ({ key: i, jobid: 1, name: 'pv-a' })) });
  assert.equal(many.length, LOGS_MAX, `상한 ${LOGS_MAX}`);
});

test('⑤ edgeResult.logs — 아는 칸 · 상한 · firstError 칸이 없으면 못 읽음', () => {
  const r = sanitizeEdgeResult('logs', { ok: true, value: [
    { key: 0, ok: true, firstError: `Fatal error: ${'x'.repeat(900)}`, lines: 12, state: 'error', status: 'f', raw: 'secret' },
    { key: 1, ok: true, firstError: null, lines: 3 },
    { key: 2, ok: true, lines: 3 },
    { key: 3, ok: false, code: 'connect', message: 'm'.repeat(900) },
    { key: 'x', ok: true, firstError: 'a' },
  ] });
  const v = r.value;
  assert.equal(v[0].firstError.length, 400);
  assert.equal('raw' in v[0], false, '아는 칸만');
  assert.deepEqual([v[1].ok, v[1].firstError], [true, null]);
  assert.deepEqual([v[2].ok, v[2].code], [false, 'unknown'], 'firstError 칸이 없는 성공은 못 읽음');
  assert.equal(v[3].message.length, 300);
  assert.equal(v[4].key, -1);
});

/* ── ⑥ 실제 라우터 ── */
const JOBLOG = new Map([
  [901, [SNAP('web-01')]],
  [902, [SNAP('app-05')]],
  [903, ["bareos-fd JobId 903: Fatal error: Disk '[DS02] db-09/db-09.vmdk' is not accessible"]],
]);
const NAMES = new Map([[901, 'pv-web'], [902, 'pv-app'], [903, 'pv-db']]);
const D = { cmds: [] };
let srv; let base; let fd;
const USERS = { admin: { username: 'adm', role: 'admin', scope: null }, sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } } };
before(async () => {
  fd = await startFakeDirector({ name: 'portal', password: 'pw-1', handle: async (cmd) => {
    D.cmds.push(cmd);
    const id = Number(/jobid=(\d+)/.exec(cmd)?.[1]);
    if (cmd.startsWith('llist jobid=')) return { jobs: NAMES.has(id) ? [{ jobid: id, name: NAMES.get(id), type: 'B', level: 'F', jobstatus: 'f', starttime: '2026-11-04 02:42:00', endtime: '2026-11-04 02:44:00' }] : [] };
    if (cmd.startsWith('list joblog')) return { joblog: (JOBLOG.get(id) || []).map((t) => ({ time: '2026-11-04 02:44:21', logtext: t })) };
    if (cmd === '.jobs') return { jobs: [] };
    if (cmd.startsWith('list jobs') || cmd.startsWith('llist')) return { jobs: [] };
    return { error: [`unknown ${cmd}`] };
  } });
  fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin' }, { username: 'sadm', role: 'admin' }] }));
  fs.writeFileSync(path.join(tmp, 'bareos.json'), JSON.stringify({
    version: 2,
    directors: [{ id: 'dir_kr', name: 'KR-dir', host: '127.0.0.1', port: fd.port, consoleName: 'portal', password: 'pw-1', timeoutMs: 5000 }],
    defaults: {},
    sites: [
      { vcenterId: 'vc-a', directorId: 'dir_kr', vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'p', configFile: '/etc/bareos/vmware/kr.ini' },
      { vcenterId: 'vc-b', directorId: 'dir_kr', vcserver: 'vc-b.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'p', configFile: '/etc/bareos/vmware/kr.ini' },
    ],
  }));
  const job = (id, vcenterId, vmId, vmName, bareosJob) => ({ id, vcenterId, vmId, vmName, directorId: 'dir_kr', bareosJob, client: 'kr-fd', storage: 'kr-sd', pool: 'p', schedule: '', level: 'Incremental', enabled: true, createdBy: 'adm', createdAt: Date.now() - 86_400_000, pending: null, lastRun: null, lastError: null, missingInDirector: false, restores: [] });
  fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), JSON.stringify({ version: 1, retired: [], jobs: [
    job('j-web', 'vc-a', 'vc-a:vm-1', 'web-01', 'pv-web'), job('j-app', 'vc-a', 'vc-a:vm-5', 'app-05', 'pv-app'), job('j-db', 'vc-b', 'vc-b:vm-9', 'db-09', 'pv-db'),
  ] }));
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul' }, { id: 'vc-b', name: 'Warsaw' }], hosts: [], datastores: [], alarms: [], networks: [], vms: [] };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools/bareos-backup`;
});
after(async () => { try { srv?.close(); } catch { /* */ } await fd?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const post = async (u, body) => { const r = await fetch(`${base}/logs/bulk`, { method: 'POST', headers: { 'x-u': u, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { s: r.status, j, t }; };

test('⑥ POST logs/bulk — 400 · 범위 밖은 없는 대상과 같은 답 · 대조 · 원문 없음', async () => {
  assert.equal((await post('admin', { items: [] })).s, 400);
  assert.equal((await post('admin', { items: Array.from({ length: LOGS_MAX + 1 }, () => ({ id: 'j-web', jobid: 901 })) })).s, 400, `상한 ${LOGS_MAX} 초과는 거절`);
  const items = [{ id: 'j-web', jobid: 901 }, { id: 'j-app', jobid: 902 }, { id: 'j-db', jobid: 903 }, { id: 'nope', jobid: 1 }, { id: 'j-web', jobid: 'x' }];
  const a = await post('admin', { items });
  assert.equal(a.s, 200, a.t);
  assert.deepEqual(a.j.items.map((x) => x.match), ['same', 'same', 'other', 'unread', 'unread']);
  assert.deepEqual([a.j.summary.same, a.j.summary.other, a.j.summary.unread], [2, 1, 2]);
  assert.match(a.j.summary.topLine, /Error creating snapshot for VM web-01/);
  assert.equal(a.j.items[3].code, 'not-found');
  assert.equal(a.j.items[4].code, 'invalid');
  assert.ok(!/logtext|joblog|jobName/.test(a.t), '원문 · 내부 칸을 싣지 않는다');
  assert.equal(D.cmds.filter((c) => c.startsWith('list joblog')).length, 3, '읽을 수 있는 실행만 Director 에 묻는다');
  // 범위 계정(vc-a 만) — vc-b 대상은 없는 대상과 같은 답(존재를 흘리지 않는다) · Director 에 묻지 않는다
  D.cmds.length = 0;
  const s = await post('sadm', { items: [{ id: 'j-web', jobid: 901 }, { id: 'j-db', jobid: 903 }] });
  assert.equal(s.s, 200, s.t);
  assert.deepEqual([s.j.items[0].ok, s.j.items[1].ok, s.j.items[1].code, s.j.items[1].reason], [true, false, 'not-found', '백업 대상을 찾을 수 없습니다.']);
  assert.equal(D.cmds.some((c) => c.includes('jobid=903')), false, '범위 밖 실행은 Director 에 묻지 않는다');
  // 다른 잡의 jobid 를 섞어 보내면 그 항목은 못 읽음(이 잡의 실행이 아님)
  const x = await post('admin', { items: [{ id: 'j-web', jobid: 903 }] });
  assert.deepEqual([x.j.items[0].ok, x.j.items[0].code], [false, 'invalid']);
});
