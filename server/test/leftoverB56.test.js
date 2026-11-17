/**
 * 남긴 결정(Bareos) · 남은 작업 회귀 — 사용자 '권장 사항으로 진행' · '남은 작업 수행해줘'(2026-11-17).
 *  D1  Director 하나에 vCenter 하나 — 새로 묶는 저장 거부 · 이미 묶인 짝은 둔다(서버 · 웹 같은 규칙) · 완전 설치도 시작 전에
 *  D2  수동 조회의 대조(잡 끄기 · 켜기)는 그 Director 의 vCenter 가 모두 쓰기 범위 안인 계정만
 *  N4  함께 쓰는 Director 재설치 — 다른 vCenter 목록을 따로 확인 · 목록이 바뀌면 시작 · 0단계 다시 하기 거부
 *  N8  등록 명령 도중 끊김 뒤 `.jobs` 확인 창도 업그레이드 대기 목록에
 *  S1  Backup Summary — Director 조회 실패 법인의 Bareos 결과는 모름(오래됨 확정이 아니다)
 *  #8  현황판 — 결과 모름 법인은 '조회 실패' 거르기에 든다(KPI 와 같은 수)
 *  #9  잘린 조회 — 진행 중 실행이 있는 VM 의 결과는 모름(서버 · 웹 같은 판정)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lb56-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const SRC = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 10, 17, 1, 23);

test('D1: 새로 같은 Director 에 둘째 vCenter 를 묶으면 거부 · 이미 묶인 짝은 그대로 · 웹 규칙과 같다', async () => {
  const S = await import('../src/bareos/settings.js');
  const web = await import('../../web/src/views/tools/bareosText.js');
  const dirs = [{ id: 'dA', name: '한국' }, { id: 'dB', name: '폴란드' }];
  assert.equal(S.directorBindIssue([{ vcenterId: 'a', directorId: 'dA' }, { vcenterId: 'b', directorId: 'dB' }], [], dirs), '');
  assert.match(S.directorBindIssue([{ vcenterId: 'a', directorId: 'dA' }, { vcenterId: 'b', directorId: 'dA' }], [{ vcenterId: 'a', directorId: 'dA' }], dirs), /한국.*이미 vCenter ‘a’.*‘b’/);
  const legacy = [{ vcenterId: 'a', directorId: 'dA' }, { vcenterId: 'b', directorId: 'dA' }];
  assert.equal(S.directorBindIssue(legacy, legacy, dirs), '', '이미 함께 묶여 있던 짝은 둔다');
  assert.match(S.directorBindIssue([...legacy, { vcenterId: 'c', directorId: 'dA' }], legacy, dirs), /‘c’/, '옛 묶음에 새 vCenter 를 더하지 않는다');
  // 웹 bindAllowed — 같은 상황에서 같은 답
  assert.equal(web.bindAllowed('b', new Set(['a']), new Set(['a'])), false);
  assert.equal(web.bindAllowed('b', new Set(['a']), new Set(['a', 'b'])), true);
  assert.equal(web.bindAllowed('a', new Set(), new Set()), true);
  // 반증 C1: 저장된 a 를 끄고 새 c 를 켠 뒤 a 를 다시 켜기 — 서버는 거부하므로 웹도 막는다
  assert.equal(web.bindAllowed('a', new Set(['c']), new Set(['a'])), false);
  assert.match(S.directorBindIssue([{ vcenterId: 'c', directorId: 'dA' }, { vcenterId: 'a', directorId: 'dA' }], [{ vcenterId: 'a', directorId: 'dA' }], dirs), /‘c’/);
  // 실제 저장 경로
  const da = S.addDirector({ name: '한국', host: 'kr.corp', consoleName: 'portal', password: 'pw' }).director.id;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: da }] });
  assert.throws(() => S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: da }, { vcenterId: 'vc-b', directorId: da }] }), /서비스 하나 = vCenter 하나/);
  // 완전 설치: 사전 점검이 bindIssue 를 싣고 시작은 같은 판정으로 거부한다(소스)
  const job = SRC('bareos/install/job.js');
  assert.match(job, /const bindIssue = directorBindIssueFor\(t, vcenterId[,)]/);   // 104회차: 새 설치는 4단계가 등록할 Director(서버 주소)도 넘긴다
  assert.match(job, /if \(pre\.bindIssue\) throw fail\('invalid', pre\.bindIssue\)/);
});

test('N4: 함께 쓰는 vCenter 확인 — 지금 목록과 같을 때만 · 시작 · 0단계 다시 하기가 대조한다', async () => {
  const { sharedAckIssue } = await import('../src/bareos/install/job.js');
  assert.equal(sharedAckIssue([], undefined), '', '함께 쓰는 vCenter 가 없으면 확인이 필요 없다');
  assert.match(sharedAckIssue(['vc-b'], undefined), /다른 vCenter 1곳\(vc-b\)/);
  assert.equal(sharedAckIssue(['vc-b', 'vc-c'], ['vc-c', 'vc-b']), '');
  assert.match(sharedAckIssue(['vc-b', 'vc-c'], ['vc-b']), /목록이 다르면 시작하지 않습니다/, '그사이 묶인 vCenter 가 늘었다');
  assert.match(sharedAckIssue(['vc-b'], ['vc-b'], { volumes: true }) || '백업 볼륨', /백업 볼륨/);
  const job = SRC('bareos/install/job.js');
  const start = job.slice(job.indexOf('async function startInner('), job.indexOf('load().push(j);', job.indexOf('async function startInner(')));
  assert.match(start, /sharedAckIssue\(sharedIds, body\.sharedAck\?\.vcenterIds/, '시작은 작업을 만들기 전에 대조한다');
  assert.match(job, /fromStep === 0 && j\.mode === 'reinstall' && j\.directorId\)[\s\S]{0,400}sharedAckIssue\(nowIds, j\.sharedAck/, '0단계 다시 하기도');
  const web = await import('../../web/src/views/tools/bareosInstallText.js');
  const pre = { sharedVcenters: [{ vcenterId: 'vc-b', targets: 3 }] };
  const t = { mode: 'reinstall', vcenterName: '한국' };
  const p = { pyvmomi: '8.0.3.0.1', volumeDir: '/var/lib/bareos/storage', reset: { ack: true, catalog: true, volumes: false, confirmName: '' } };
  assert.match(web.planIssues(p, t, pre).join(' '), /함께 쓰는 다른 vCenter 1곳/);
  assert.deepEqual(web.planBody({ ...p, reset: { ...p.reset, sharedAck: ['vc-b'] } }, { pre, target: t }).sharedAck, { vcenterIds: ['vc-b'] });
  assert.equal('sharedAck' in web.planBody({ ...p, reset: { ...p.reset, sharedAck: ['vc-b'] } }, { pre: { sharedVcenters: [] }, target: t }), false, '지금 점검에 함께 쓰는 vCenter 가 없으면 싣지 않는다');
  // 반증 E1: '다시 점검' 으로 목록이 늘면 앞의 확인은 풀린다(본 적 없는 목록을 싣지 않는다)
  const pre2 = { sharedVcenters: [{ vcenterId: 'vc-b', targets: 3 }, { vcenterId: 'vc-c', targets: 1 }] };
  assert.equal('sharedAck' in web.planBody({ ...p, reset: { ...p.reset, sharedAck: ['vc-b'] } }, { pre: pre2, target: t }), false);
  assert.match(web.planIssues({ ...p, reset: { ...p.reset, sharedAck: ['vc-b'] } }, t, pre2).join(' '), /2곳/);
});

test('D2: 수동 대조는 그 Director 의 vCenter 가 모두 쓰기 범위 안인 계정만 — 조회 전용은 상태만', async () => {
  const S = await import('../src/bareos/settings.js');
  const { _reconcileDirectorIdsForTest: rec } = await import('../src/routes/api/bareosBackup.js');
  const db = S.addDirector({ name: '폴란드', host: 'pl.corp', consoleName: 'portal', password: 'pw' }).director.id;
  const da = S.loadSettings().directors.find((d) => d.name === '한국').id;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: da }, { vcenterId: 'vc-p', directorId: db }] });
  const st = S.loadSettings();
  assert.equal(rec({ role: 'admin' }, st), null, '쓰기 무제한 — 전부(예전대로)');
  assert.deepEqual([...rec({ role: 'admin', scope: { vcenters: ['vc-a', 'vc-p'], writeVcenters: ['vc-a'] } }, st)], [da], '쓰기 범위 안 Director 만');
  assert.deepEqual([...rec({ role: 'admin', scope: { vcenters: ['vc-p'], writeVcenters: ['vc-x'] } }, st)], [], '조회 전용 — 대조 없음');
  const legacy = { ...st, sites: [{ vcenterId: 'vc-a', directorId: 'dL' }, { vcenterId: 'vc-z', directorId: 'dL' }] };   // 예전 설정 — vCenter 둘이 한 Director
  assert.deepEqual([...rec({ role: 'admin', scope: { vcenters: ['vc-a', 'vc-z'], writeVcenters: ['vc-a'] } }, legacy)], [], '그 Director 의 vCenter 중 하나라도 쓰기 범위 밖이면 대조하지 않는다');
  const route = SRC('routes/api/bareosBackup.js');
  const h = route.slice(route.indexOf("api.post('/tools/bareos-backup/poll'"), route.indexOf("api.get('/tools/bareos-backup/badges'"));
  assert.match(h, /reconcileOnly: recOnly/);
  assert.match(SRC('bareos/poller.js'), /doReconcile: doReconcile && \(!recOnly \|\| recOnly\.has\(d\.id\)\), reconcileAllowed: !recOnly \|\| recOnly\.has\(d\.id\)/);
  assert.match(SRC('bareos/poller.js'), /const due = reconcileAllowed && \(doReconcile \|\| _reconcileDue\.has\(d\.id\)\)/, '반증 D1: 밀린 대조도 막는다');
});

test('N8: 등록 명령 도중 끊긴 뒤 .jobs 확인 · 끄기는 업그레이드 대기 목록에 있다', async () => {
  const svc = SRC('bareos/service.js');
  const fn = svc.slice(svc.indexOf('async function settleMidCommandAdds('), svc.indexOf('async function settleMidCommandAddsInner('));
  assert.match(fn, /noteDirectOpStart\('addJobs-settle', directorId\)/);
  assert.match(fn, /finally \{ noteDirectOpEnd\(noteId\); \}/);
  const { noteDirectOpStart, noteDirectOpEnd, runningBareosWork } = await import('../src/bareos/inflight.js');
  const id = noteDirectOpStart('addJobs-settle', 'dA');
  assert.ok(runningBareosWork().some((x) => /addJobs-settle/.test(x.label)));
  noteDirectOpEnd(id);
});

test('S1: Director 조회 실패 · 인증 정지 법인의 Bareos 결과는 Backup Summary 에서 모름 — 묶지 않은 법인(unset)은 예전대로', async () => {
  const { directorState } = await import('../src/bareos/vmView.js');
  assert.equal(directorState({ mapped: true, configured: true, poll: { ok: false, code: 'connect' } }).resultsKnown, false);
  assert.equal(directorState({ mapped: true, configured: true, authStopped: true }).state, 'auth');
  const v = SRC('routes/api/veeam.js');
  assert.match(v, /const dirFail = !!dirInfo && !dirInfo\.resultsKnown && \(dirInfo\.state === 'auth' \|\| dirInfo\.state === 'error'\);/, "unset 은 빼지 않는다(방식 bareos VM 의 '미등록' 은 아는 사실)");
  assert.match(v, /const ledger = bareosStatesOf\(vc\.id\);[^\n]*\n\s*const bareos = dirFail \? null : ledger;/);
  assert.match(v, /if \(partialPoll && b && b\.run\) return \{ \.\.\.row, b: null \};/, '반증 G1: Summary 도 잘린 조회의 진행 중 VM 은 모름');
  assert.match(v, /if \(vr\.ledger\) pushAll\(rows, bareosRows\(vr\.ledger,/, '반증 F1: 오류 목록은 Director 조회 실패여도 원장의 지난 실패를 낸다');
  const web = await import('../../web/src/views/tools/backupSummaryText.js');
  assert.match(web.siteNote({ bareosUnknown: true, bareosDirFail: true }), /Director 조회 실패/);
  assert.match(web.siteNote({ bareosUnknown: true }), /원장 못 읽음/);
});

test('#8: 결과 모름 법인은 실행 · 대기 행이 있어도 조회 실패 거르기에 든다(KPI resultsUnknownCorps 와 같은 수)', async () => {
  const w = await import('../../web/src/views/tools/bareosLiveText.js');
  const corps = [
    { resultsKnown: false, resultsState: 'error', running: 1, waiting: 0, live: null, stuck: 0, slow: 0 },
    { resultsKnown: false, resultsState: 'error', running: 2, waiting: 0, live: { ok: true }, stuck: 1, slow: 0 },
    { resultsKnown: false, resultsState: 'auth', running: 0, waiting: 0, live: null, stuck: 0, slow: 0 },
    { resultsKnown: true, running: 1, waiting: 0, live: null, stuck: 0, slow: 0 },
  ];
  assert.equal(w.corpBadge(corps[0]).key, 'fail', "'조회 전' 이 아니다");
  assert.equal(w.corpFilterCounts(corps).fail, corps.filter((c) => c.resultsKnown === false).length);
  assert.equal(w.corpBadge(corps[1]).key, 'stuck', '멈춤 의심 표지는 덮지 않는다(53회차 N5)');
  assert.equal(w.corpBadge(corps[3]).key, 'pending');
});

test('#9: 잘린 조회 — 진행 중 실행이 있는 VM 은 결과 모름(서버 corpCounts · priorityKind · 웹 rowMatches 같은 판정)', async () => {
  const V = await import('../src/bareos/vmView.js');
  const web = await import('../../web/src/views/tools/bareosViewText.js');
  const st = V.directorState({ mapped: true, configured: true, poll: { ok: false, code: 'aborted', checked: 3 } });
  assert.equal(st.resultsKnown, true); assert.equal(st.partial, true);
  const old = NOW - 3 * 86_400_000;
  const rows = [
    { id: 'v1', method: 'bareos', b: { job: true, on: true, st: 'ok', ok: old, run: 'running' } },   // 진행 중 — 옛 값
    { id: 'v2', method: 'bareos', b: { job: true, on: true, st: 'error', ok: old, run: null } },      // 끝난 실행 — 안다
  ];
  const c = V.corpCounts(rows, { now: NOW, partial: true });
  assert.equal(c.old, 1, '진행 중 VM 은 오래됨으로 세지 않는다');
  assert.equal(c.fail, 1); assert.equal(c.run, 1); assert.equal(c.unknown, 1);
  assert.equal(V.priorityKind(rows[0], { now: NOW, partial: true }), '');
  assert.equal(V.priorityKind(rows[0], { now: NOW }), 'old', '잘리지 않았으면 예전대로');
  for (const f of ['old', 'bad', 'attn']) assert.equal(web.rowMatches(rows[0], f, { now: NOW, partial: true }), false, f);
  assert.equal(web.rowMatches(rows[0], 'run', { now: NOW, partial: true }), true);
  assert.equal(web.rowMatches(rows[1], 'bad', { now: NOW, partial: true }), true);
  const s = V.corpCounts(rows, { now: NOW });
  assert.equal(s.old, 2, '잘리지 않았으면 예전대로');
});

test('반증 G1: 그룹 카드도 잘린 조회의 진행 중 VM 결과는 세지 않는다', async () => {
  const g = await import('../../web/src/views/tools/bareosGroupText.js');
  const rows = [{ b: { st: 'error', run: 'running' } }, { b: { st: 'ok', run: null } }];
  const m = g.memberResults(rows, { partial: true });
  assert.equal(m.fail, 0, '옛 실패를 세지 않는다'); assert.equal(m.ok, 1); assert.equal(m.run, 1); assert.equal(m.runUnread, 1);
  assert.equal(g.memberResults(rows).fail, 1, '잘리지 않았으면 예전대로');
});
