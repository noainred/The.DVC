/**
 * v2.763 그룹 C — Veeam 3회차(bughunt3) 이벤트·보고서 축.
 *  V4-1  미보호 VM 보고서가 실제 vCenter 의 스냅샷 TaskEvent(영어·한국어)를 백업 흔적으로 본다 — 판정 코어는 snapEvents 하나 ·
 *        생성/제거 구분(제거는 계정으로만) · 이름 대소문자 · 라우트는 'Snapshot'·'스냅샷' 두 검색어 · 데모도 TaskEvent 모양을 낸다
 *  V4-2  계정 목록이 전역이라 다른 법인 계정만 알아도 '0대' 가 확정되던 것 — vCenter 단위 accountUnseen 표지(수는 그대로)
 *  V4-4  로그 폴러가 수집기 실제 한도(200쪽 × 200건)를 넘는 maxPerPoll 로 '상한 안 걸림 → 지금까지 온전' 을 기록하던 것
 *  V4-I1 관리자가 지운 학습 계정을 바로 다시 배우던 것 — 시한부 거부 목록
 *  ⚠ 엣지 시계 — 엣지 스냅샷 요약의 collectedAt 을 엣지 시계 차만큼 옮긴다(collectedAt + (수신 − at))
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2763c-'));
process.env.CONFIG_DIR = DIR;
process.env.DB_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [{ id: 'vc-a', name: 'Direct', host: 'a.example.invalid', username: 'u', password: 'p' }],
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const servers = [];
after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const { computeUnprotected, isBackupEvent, snapshotKind } = await import('../src/reports/unprotected.js');
const S = await import('../src/veeam/snapEvents.js');
const { parseEventsXml } = await import('../src/vcenter/soapClient.js');
const { snapVerdict, snapCount } = await import('../src/veeam/backupCounts.js');

// 실제 ReadNextEvents 응답 모양 — 파서를 거친 행으로 시험한다(손으로 type 을 적지 않는다).
const taskXml = (key, ts, user, vm, msg, extra = '') => `<returnval xsi:type="TaskEvent"><key>${key}</key><chainId>${key}</chainId><createdTime>${new Date(ts).toISOString()}</createdTime>`
  + `<userName>${user}</userName><vm><name>${vm}</name><vm type="VirtualMachine">vm-${key}</vm></vm><fullFormattedMessage>${msg}</fullFormattedMessage>${extra}</returnval>`;
const parsed = (xml) => parseEventsXml(xml).map((e) => ({ ...e, vcenterId: 'vc-a' }));
const vm = (name, extra = {}) => ({ id: `vc-a:${name}`, name, vcenterId: 'vc-a', powerState: 'POWERED_ON', storageGB: 10, ...extra });
const COVER = { coveredVcenterIds: new Set(['vc-a']), logSettings: { enabled: true, minSeverity: 'info' } };

/* ── V4-1 ─────────────────────────────────────────────────────────────────────────────────────────── */

test('V4-1 ① 실서버 TaskEvent(영어·한국어) 스냅샷 생성을 백업 흔적으로 본다 — 카드·칩(snapEvents)과 같은 판정', () => {
  const rows = parsed(
    taskXml(101, NOW - 5 * HOUR, 'CORP\\svc-veeam', 'web-01', 'Task: Create virtual machine snapshot', '<info><name>CreateSnapshot_Task</name></info>')
    + taskXml(102, NOW - 4 * HOUR, 'CORP\\svc-veeam', 'app-01', '작업: 가상 시스템 스냅샷 생성'));
  assert.deepEqual(rows.map((r) => r.type), ['TaskEvent', 'TaskEvent']);
  for (const r of rows) {
    assert.equal(S.isSnapshotCreateEvent(r), true, '코어(snapEvents)가 생성으로 본다');
    assert.equal(isBackupEvent(r), true, `보고서도 백업 흔적으로 본다: ${r.message}`);
  }
  const r0 = computeUnprotected([vm('web-01'), vm('app-01'), vm('db-01')], rows, COVER);
  assert.equal(r0.summary.protectedCount, 2);
  for (const r of rows) assert.equal(snapshotKind(r), 'create');
  const r = computeUnprotected([vm('web-01'), vm('app-01'), vm('db-01')], rows, COVER);
  assert.equal(r.summary.protectedCount, 2);
  assert.equal(r.summary.unprotectedCount, 1);
  assert.deepEqual(r.unprotected.map((x) => x.name), ['db-01']);
  assert.equal(r.summary.backupEvents, 2);
});

test('V4-1 ② 반례 — 보호 근거가 늘어나는 쪽이라 공백을 숨기지 않는지: 사람의 제거·되돌리기·실패·다른 작업·사람 계정 생성은 근거가 아니다', () => {
  const rows = [
    // 사람이 지운 스냅샷 — 문구에 'backup' 이 있어도 제거는 계정으로만 본다
    { vcenterId: 'vc-a', type: 'VmSnapshotRemovedEvent', ts: NOW - HOUR, severity: 'info', user: 'CORP\\kim', entity: 'h-remove', message: 'Remove snapshot before backup test' },
    { vcenterId: 'vc-a', type: 'TaskEvent', ts: NOW - HOUR, severity: 'info', user: 'CORP\\kim', entity: 'h-remove2', message: 'Task: Remove snapshot (backup leftover)' },
    // Veeam 계정이라도 되돌리기·실패한 생성·스냅샷이 아닌 작업
    ...parsed(taskXml(201, NOW - HOUR, 'CORP\\svc-veeam', 'v-revert', 'Task: Revert to current snapshot')),
    { vcenterId: 'vc-a', type: 'TaskEvent', ts: NOW - HOUR, severity: 'error', user: 'CORP\\svc-veeam', entity: 'v-fail', message: 'Task: Create virtual machine snapshot' },
    { vcenterId: 'vc-a', type: 'TaskEvent', ts: NOW - HOUR, severity: 'info', user: 'CORP\\svc-veeam', entity: 'v-fail2', message: 'Task: Create virtual machine snapshot — failed' },
    ...parsed(taskXml(202, NOW - HOUR, 'CORP\\svc-veeam', 'v-power', 'Task: Power On virtual machine')),
    // 사람 계정이 만든 스냅샷(TaskEvent 문구에는 계정이 없다)
    ...parsed(taskXml(203, NOW - HOUR, 'CORP\\kim', 'h-create', 'Task: Create virtual machine snapshot')),
  ];
  const names = ['h-remove', 'h-remove2', 'v-revert', 'v-fail', 'v-fail2', 'v-power', 'h-create'];
  const r = computeUnprotected(names.map((n) => vm(n)), rows, COVER);
  assert.equal(r.summary.protectedCount, 0, JSON.stringify(r.protected.map((x) => x.name)));
  assert.equal(r.summary.unprotectedCount, names.length);
  assert.equal(snapshotKind(rows[2]), 'other', '되돌리기는 생성·제거가 아니다');
  assert.equal(snapshotKind(rows[5]), null, '전원 켜기 TaskEvent 는 스냅샷 작업이 아니다');
  // 백업 계정의 제거는 근거다(Veeam 은 백업이 끝나면 자기 계정으로 지운다)
  const rm = parsed(taskXml(204, NOW - HOUR, 'CORP\\svc-veeam', 'v-rm', 'Task: Remove snapshot'));
  assert.equal(snapshotKind(rm[0]), 'remove');
  assert.equal(computeUnprotected([vm('v-rm')], rm, COVER).summary.protectedCount, 1);
});

test('V4-1 ③ 이름 대조는 앞뒤 공백·대소문자를 무시한다(snapEvents 와 같다) · vCenter 는 그대로 맞춘다', () => {
  const rows = [{ vcenterId: 'vc-a', type: 'TaskEvent', ts: NOW - HOUR, severity: 'info', user: 'CORP\\svc-veeam', entity: ' WEB-01 ', message: 'Task: Create virtual machine snapshot' }];
  const r = computeUnprotected([vm('web-01'), { ...vm('web-01'), id: 'vc-b:web-01', vcenterId: 'vc-b' }], rows, {});
  assert.equal(r.summary.protectedCount, 1);
  assert.deepEqual(r.unprotected.map((x) => x.vcenterId), ['vc-b'], '다른 vCenter 의 동명 VM 은 보호로 세지 않는다(v2.583 #21 유지)');
});

test('V4-1 ④ 두 검색어를 합치면 호출자가 준 truncated 로 상한을 판정한다', () => {
  const rows = [{ vcenterId: 'vc-a', type: 'TaskEvent', ts: NOW, severity: 'info', user: 'svc-veeam', entity: 'a', message: 'Task: Create virtual machine snapshot' }];
  assert.equal(computeUnprotected([vm('a')], rows, { rowLimit: 1, truncated: false }).summary.eventsTruncated, false);
  assert.equal(computeUnprotected([vm('a')], rows, { rowLimit: 10, truncated: true }).summary.eventsTruncated, true);
  assert.equal(computeUnprotected([vm('a')], rows, { rowLimit: 1 }).summary.eventsTruncated, true, '안 주면 예전 판정');
});

test('V4-1 ⑤ 데모도 실서버 모양(TaskEvent 영어·한국어)을 섞어 내고, 보고서가 그 VM 전부를 보호로 본다', async () => {
  const { demoBackupEvents, demoBackedUp } = await import('../src/mock/demo/backup.js');
  const vms = Array.from({ length: 60 }, (_, i) => ({ id: `vc1:vm-${i}`, name: `vm-${i}`, vcenterId: 'vc1', powerState: i % 10 === 0 ? 'POWERED_OFF' : 'POWERED_ON' }));
  const ev = demoBackupEvents('vc1', vms, NOW - 8 * DAY, NOW).map((e) => ({ ...e, vcenterId: 'vc1' }));
  const types = new Set(ev.map((e) => e.type));
  assert.ok(types.has('TaskEvent'), '실서버 모양 TaskEvent 가 있다');
  assert.ok(ev.some((e) => e.type === 'TaskEvent' && /스냅샷/.test(e.message)), '한국어 문구도 있다');
  assert.ok(ev.some((e) => e.type === 'TaskEvent' && /snapshot/i.test(e.message)), '영어 문구도 있다');
  for (const e of ev) assert.notEqual(snapshotKind(e), null, `스냅샷 작업으로 읽힌다: ${e.type} ${e.message}`);
  const r = computeUnprotected(vms, ev, { lookbackDays: 7, coveredVcenterIds: new Set(['vc1']) });
  const backed = vms.filter(demoBackedUp).map((v) => v.name).sort();
  assert.deepEqual(r.protected.map((x) => x.name).sort(), backed, '데모 백업 대상이 전부 보호');
  // 카드·칩(snapEvents)도 Veeam 계정 VM 을 같은 행으로 센다
  const sum = S.summarizeVeeamSnapEvents(vms, ev, { since: NOW - 7 * DAY });
  assert.ok(sum.events > 0);
});

test('V4-1 ⑥ 실제 라우트 — 영어·한국어 TaskEvent 를 읽어 보호로 판정(예전: 한국어는 오지 않고 영어는 종류에서 버림)', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { api } = await import('../src/routes/api.js');
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const T = Date.now() - 2 * HOUR;
  db.insertMany([
    { vcenterId: 'vc-a', key: 'r1', ts: T, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: 'en-vm', message: 'Task: Create virtual machine snapshot' },
    { vcenterId: 'vc-a', key: 'r2', ts: T + 1000, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: 'ko-vm', message: '작업: 가상 시스템 스냅샷 생성' },
    { vcenterId: 'vc-a', key: 'r3', ts: T + 2000, severity: 'info', type: 'TaskEvent', user: 'CORP\\kim', entity: 'human-vm', message: 'Task: Remove snapshot (backup)' },
    { vcenterId: 'vc-a', key: 'r4', ts: T + 3000, severity: 'info', type: 'VmPoweredOnEvent', user: '', entity: 'none-vm', message: 'none-vm is powered on' },
  ]);
  store.snapshot = {
    generatedAt: new Date().toISOString(), source: 'live',
    vcenters: [{ id: 'vc-a', name: 'Direct', status: 'ok' }],
    hosts: [], vms: ['en-vm', 'ko-vm', 'human-vm', 'none-vm'].map((n) => vm(n)), datastores: [], networks: [], alarms: [], collectionErrors: [],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', name: 'adm', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/report/unprotected?lookbackDays=7`);
  const b = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(b.protected.map((x) => x.name).sort(), ['en-vm', 'ko-vm']);
  assert.deepEqual(b.unprotected.map((x) => x.name).sort(), ['human-vm', 'none-vm']);
  assert.equal(b.summary.eventsTruncated, false);
  // 합친 행 수가 아니라 검색어마다 상한을 판정해 넘긴다(두 검색어 합이 2만을 넘어도 각각은 안 걸렸으면 잘린 것이 아니다)
  const src = fs.readFileSync(new URL('../src/routes/api/reports.js', import.meta.url), 'utf8');
  assert.match(src, /const truncated = parts\.some\(\(x\) => x\.length >= ROW_LIMIT\);/);
  // 같은 행이 두 검색어에 걸리면 한 번만(영어 문구에 '스냅샷' 이 든 VM 이름 등)
  const { mergeSnapRows } = await import('../src/reports/unprotected.js');
  const a = { vcenterId: 'vc-a', ts: 1, type: 'TaskEvent', entity: '스냅샷-vm', user: 'u', message: 'Task: Create virtual machine snapshot' };
  assert.equal(mergeSnapRows([[a], [{ ...a }], [{ ...a, vcenterId: 'vc-b' }]]).length, 2);
  assert.match(src, /computeUnprotected\(scoped\.vms, rows, \{[^}]*truncated,[^}]*\}\)/);
});

/* ── V4-2 ─────────────────────────────────────────────────────────────────────────────────────────── */

const evOk = (o = {}) => ({ status: 'ok', byVm: {}, events: 0, ambiguous: 0, unmatched: 0, unpaired: 0, truncated: false, accounts: 1, days: 7, at: NOW, ...o });

test('V4-2 ① 아는 계정(다른 법인)이 있어도 이 vCenter 에서 한 번도 안 보이면 accountUnseen — 수는 그대로', () => {
  const vms = Array.from({ length: 300 }, (_, i) => ({ id: `vc-b:vm-${i}`, name: `b${i}`, vcenterId: 'vc-b' }));
  const v = snapVerdict(evOk(), NOW);
  assert.equal(v.ok, true);
  assert.equal(v.accountUnseen, true);
  const c = snapCount({ ev: evOk(), vms, now: NOW });
  assert.equal(c.n, 0, '수는 숨기지 않는다(정말 0대일 수도 있다)');
  assert.equal(c.accountUnseen, true);
  assert.equal(c.vmTotal, 300);
});

test('V4-2 ② 표지를 달지 않는 경우 — 이벤트가 있음 · 짝 못 맞춘 공용 계정 이벤트 · 지금 임시 스냅샷 · 계정 0개(no-account) · events 모름', () => {
  assert.equal(snapVerdict(evOk({ events: 3, byVm: { 'vc-b:vm-1': [NOW, 3] } }), NOW).accountUnseen, undefined);
  assert.equal(snapVerdict(evOk({ events: 2 }), NOW).accountUnseen, undefined, '이벤트는 있었다(이름 불일치·동명)');
  assert.equal(snapVerdict(evOk({ unpaired: 1 }), NOW).accountUnseen, undefined);
  assert.equal(snapVerdict(evOk({ accounts: 0 }), NOW).reason, 'no-account');
  assert.equal(snapVerdict(evOk({ events: undefined }), NOW).accountUnseen, undefined, '옛 요약(events 없음)은 모름 — 표지를 지어내지 않는다');
  const vms = [{ id: 'vc-b:vm-1', veeamSnaps: 1, veeamSnapTs: NOW - HOUR }, { id: 'vc-b:vm-2' }];
  const c = snapCount({ ev: evOk(), vms, now: NOW });
  assert.equal(c.n, 1);
  assert.equal(c.accountUnseen, undefined, '지금 Veeam 임시 스냅샷이 보이면 Veeam 흔적은 있다');
});

test('V4-2 ③ 실제 경로 — 다른 vCenter 에서 배운 전역 계정 1개 + 이 vCenter 는 다른 계정 → localSnapSummary → accountUnseen', async () => {
  S._resetForTest();
  S.saveManualAccounts(['CORP\\bk-svc']);
  const vms = [vm('p1'), vm('p2')];
  const rows = [{ vcenterId: 'vc-a', ts: NOW - HOUR, type: 'TaskEvent', severity: 'info', user: 'PL\\backup01', entity: 'p1', message: 'Task: Create virtual machine snapshot' }];
  const db = { query: (f) => rows.filter((r) => r.message.toLowerCase().includes(String(f.q).toLowerCase())) };
  try {
    const r = await S.localSnapSummary(db, 'vc-a', vms, { now: NOW });
    assert.equal(r.accounts, 1);
    assert.equal(r.events, 0);
    const c = snapCount({ ev: { status: 'ok', ...r }, vms, now: NOW });
    assert.equal(c.n, 0);
    assert.equal(c.accountUnseen, true);
  } finally { S.saveManualAccounts([]); }
});

/* ── V4-4 ─────────────────────────────────────────────────────────────────────────────────────────── */

test('V4-4 ① 수집기 한도(200쪽 × 200건)를 넘는 설정은 그 한도로 자르고, 그만큼 읽었으면 capped(지금까지 온전으로 기록하지 않음)', async () => {
  const P = await import('../src/logs/poller.js');
  assert.equal(P.COLLECTOR_MAX_EVENTS, 40_000);
  assert.equal(P.effectiveMaxPerPoll({ maxPerPoll: 50_000 }), 40_000);
  assert.equal(P.effectiveMaxPerPoll({ maxPerPoll: 5_000 }), 5_000, '기본값은 그대로');
  const events = Array.from({ length: 40_000 }, (_, i) => ({ ts: NOW - 12 * HOUR + i * 1000 }));   // 12h 전 ~ 약 0.9h 전
  const startedAt = NOW;
  const done = P.eventsCompleteUntil(events, { startedAt, max: P.effectiveMaxPerPoll({ maxPerPoll: 50_000 }) });
  assert.equal(done.capped, true);
  assert.equal(done.at, events.at(-1).ts, '마지막으로 읽은 이벤트 시각까지만 온전');
  assert.ok(done.at < startedAt);
  // 그 시각이 한도보다 오래되면 스냅샷 판정은 '오래됨' 이다(예전: 지금으로 기록돼 '신선')
  assert.equal(snapVerdict(evOk({ collectedAt: NOW - 8 * HOUR, events: 1, byVm: { x: [NOW, 1] } }), NOW).reason, 'stale-events');
});

test('V4-4 ② 폴러는 설정 상한을 수집기에 그대로 넘기지 않는다(묶음 수집 — 시간 예산) · 수집기 쪽 수·쪽 크기는 상수와 같다', () => {
  // v2.764(재검토 1-c): 폴러는 onBatch 묶음 수집으로 바뀌어 상한(maxEv)을 수집 호출에 넘기지 않는다 — '같은 상한을 두 곳에 쓴다' 단언은 대상이 없어졌다.
  //   남는 불변조건: 설정값(maxPerPoll)을 수집기 max 로 넘기는 곳이 없다 · onBatch 호출에 시간 예산(budgetMs)이 실린다 · 수집기 비묶음 경로의 쪽 상수.
  const src = fs.readFileSync(new URL('../src/logs/poller.js', import.meta.url), 'utf8');
  assert.match(src, /collectVCenterEvents\(vc, \{ sinceTs, signal, onBatch, batchSize: EVENT_BATCH_ROWS, budgetMs: budget \}\)/);
  assert.ok(!/max: s\.maxPerPoll/.test(src), '설정값을 그대로 쓰는 곳이 남지 않는다');
  assert.ok(!/max: maxEv/.test(src), '설정 상한을 수집기에 넘기는 곳이 남지 않는다(시간 예산으로 대체)');
  const soap = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  const fn = soap.slice(soap.indexOf('export async function collectVCenterEvents'), soap.indexOf('export function parseEventsXml'));
  assert.match(fn, /pageSize = 200/);
  assert.match(fn, /guard < EVENT_PAGES_MAX && out\.length < max/);   // v2.764: 쪽 수 한도는 상수(EVENT_PAGES_MAX)
  assert.match(soap, /export const EVENT_PAGES_MAX = 200;/);
});

/* ── V4-I1 ────────────────────────────────────────────────────────────────────────────────────────── */

test('V4-I1 ① 지운 학습 계정은 근거가 남아 있어도 시한 동안 다시 배우지 않는다 · 시한 뒤에는 다시 배운다 · 사람이 적으면 쓴다', async () => {
  S._resetForTest();
  const vms = [1, 2].map((i) => ({ id: `vc-a:vm-${i}`, name: `v${i}`, vcenterId: 'vc-a', veeamSnaps: 1, veeamSnapTs: NOW - 2 * DAY }));
  const rows = vms.map((v) => ({ vcenterId: 'vc-a', ts: v.veeamSnapTs + 60_000, type: 'TaskEvent', severity: 'info', user: 'CORP\\svc-patch', entity: v.name, message: 'Task: Create virtual machine snapshot' }));
  const db = { query: (f) => rows.filter((r) => r.message.includes(f.q)) };
  await S.localSnapSummary(db, 'vc-a', vms, { now: NOW });
  assert.deepEqual(S.veeamAccounts(NOW), ['CORP\\svc-patch'], '먼저 배운다(전제)');
  assert.equal(S.forgetLearned(['CORP\\svc-patch'], NOW), 1);
  await S.localSnapSummary(db, 'vc-a', vms, { now: NOW + 60_000 });
  assert.deepEqual(S.veeamAccounts(NOW + 60_000), [], '60초 뒤 다음 계산에서 다시 배우지 않는다');
  // 재시작해도(파일) 유지 · 표기가 달라도(대소문자) 같은 계정
  S._resetForTest();
  assert.equal(S.rememberLearned([{ account: 'corp\\SVC-PATCH', vm: 'v1' }, { account: 'corp\\SVC-PATCH', vm: 'v2' }], NOW + DAY), 0);
  assert.deepEqual(S.veeamAccounts(NOW + DAY), []);
  // 시한(이벤트 창 7일)이 지나면 다시 배울 수 있다
  const later = NOW + S.FORGET_TTL_MS + 60_000;
  assert.ok(S.rememberLearned([{ account: 'CORP\\svc-patch', vm: 'v1' }, { account: 'CORP\\svc-patch', vm: 'v2' }], later) > 0);
  assert.deepEqual(S.veeamAccounts(later), ['CORP\\svc-patch']);
  // 시계가 되돌려져 지운 시각이 먼 미래가 돼도 영구 거부가 아니다(시한만큼만)
  assert.equal(S.forgetLearned(['CORP\\svc-patch'], later + 10 * S.FORGET_TTL_MS), 1);
  assert.deepEqual(S.veeamAccounts(later), []);
  assert.ok(S.rememberLearned([{ account: 'CORP\\svc-patch', vm: 'v1' }, { account: 'CORP\\svc-patch', vm: 'v2' }], later) > 0);
  assert.deepEqual(S.veeamAccounts(later), ['CORP\\svc-patch']);
  // 사람이 적은 계정은 막지 않는다
  S.forgetLearned(['CORP\\svc-patch'], later);
  S.saveManualAccounts(['CORP\\svc-patch']);
  assert.deepEqual(S.veeamAccounts(later), ['CORP\\svc-patch']);
  S.saveManualAccounts([]);
});

test('V4-I1 ② 거부 목록은 상한·시한이 있고, 옛 파일(필드 없음)·잘못된 값은 빈 목록으로 읽는다', () => {
  const file = path.join(DIR, 'veeam-vc-accounts.json');
  fs.writeFileSync(file, JSON.stringify({ manual: [], learned: {}, pulled: [] }));
  S._resetForTest();
  assert.ok(S.rememberLearned([{ account: 'A\\x', vm: 'v1' }], NOW) > 0, '옛 파일 — 거부 목록 없음');
  fs.writeFileSync(file, JSON.stringify({ manual: [], learned: {}, pulled: [], forgotten: { 'a\\y': 'soon', 'a\\z': -1 } }));
  S._resetForTest();
  assert.ok(S.rememberLearned([{ account: 'A\\y', vm: 'v1' }, { account: 'A\\z', vm: 'v1' }], NOW) > 0, '수가 아닌 시각은 버린다');
  // 상한: 3회에 걸쳐 96개를 지워도 파일의 거부 목록은 64개 이하(오래된 것부터 버린다)
  let forgotten = {};
  for (let round = 0; round < 3; round++) {
    const learned = {};
    for (let i = 0; i < 32; i++) learned[`D\\u${round}-${i}`] = { t: NOW, vms: ['a', 'b'] };
    fs.writeFileSync(file, JSON.stringify({ manual: [], learned, pulled: [], forgotten }));
    S._resetForTest();
    assert.equal(S.forgetLearned(Object.keys(learned), NOW + round), 32);
    forgotten = JSON.parse(fs.readFileSync(file, 'utf8')).forgotten;
  }
  assert.equal(Object.keys(forgotten).length, 64);
  assert.ok(!Object.keys(forgotten).some((k) => k.startsWith('u0-')), '가장 오래된 회차가 버려졌다');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 시한이 지난 항목은 다음 지우기 때 정리된다
  saved.learned = { 'E\\w': { t: NOW, vms: ['a', 'b'] } };
  fs.writeFileSync(file, JSON.stringify(saved));
  S._resetForTest();
  S.forgetLearned(['E\\w'], NOW + S.FORGET_TTL_MS + 10);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).forgotten), ['w@e'], '정규형(user@domain)으로 적는다 · 지난 것은 지웠다');
  S._resetForTest();
});

/* ── ⚠ 엣지 시계 — 스냅샷 요약 collectedAt 보정 ──────────────────────────────────────────────────── */

const edgeItem = (o) => ({ vcenterId: 'vc-s', status: 'ok', byVm: {}, events: 0, accounts: 1, days: 7, ...o });
const owns = () => true;

test('엣지 시계 ① 엣지 시계가 30분 늦으면 — 정상 수집(10분 전)이 수신 시각 기준 10분 전으로(예전: 40분 전) · 원본은 edgeCollectedAt', () => {
  const at = NOW - 30 * 60_000;
  const { items } = S.sanitizeEdgeSnap([edgeItem({ at, collectedAt: at - 10 * 60_000 })], owns, NOW);
  assert.equal(items[0].collectedAt, NOW - 10 * 60_000);
  assert.equal(items[0].edgeCollectedAt, at - 10 * 60_000);
  assert.equal(items[0].edgeAt, at);
  assert.equal(items[0].at, NOW);
});

test('엣지 시계 ② 엣지 시계가 2시간 빠르면 — 7시간 멈춘 수집이 오래됨으로 보인다(예전: 미래 자르기로 5시간 전 → 신선)', () => {
  const at = NOW + 2 * HOUR;
  const { items } = S.sanitizeEdgeSnap([edgeItem({ at, collectedAt: at - 7 * HOUR, events: 1, byVm: { 'vc-s:vm-1': [NOW - HOUR, 1] } })], owns, NOW);
  assert.equal(items[0].collectedAt, NOW - 7 * HOUR);
  assert.equal(snapVerdict({ ...items[0] }, NOW).reason, 'stale-events');
  // 보정은 미래 자르기보다 먼저 — 2시간 빠른 엣지의 '1시간 전'(엣지 시계로는 미래가 아님)은 수신 기준 1시간 전(자르고 옮기면 2시간 전)
  const g = S.sanitizeEdgeSnap([edgeItem({ at, collectedAt: at - HOUR })], owns, NOW).items[0];
  assert.equal(g.collectedAt, NOW - HOUR);
  // 보정 뒤에도 미래는 수신 시각으로 자른다
  const f = S.sanitizeEdgeSnap([edgeItem({ at: NOW, collectedAt: NOW + HOUR })], owns, NOW).items[0];
  assert.equal(f.collectedAt, NOW);
});

test('엣지 시계 ③ 보정하지 않는 경우 — at 이 수가 아님(옛 엣지·문자열) · 차가 30일 초과 · collectedAt 없음', () => {
  const s1 = S.sanitizeEdgeSnap([edgeItem({ at: String(NOW - HOUR), collectedAt: NOW - 2 * HOUR })], owns, NOW).items[0];
  assert.equal(s1.collectedAt, NOW - 2 * HOUR);
  assert.equal(s1.edgeCollectedAt, undefined);
  const s2 = S.sanitizeEdgeSnap([edgeItem({ collectedAt: NOW - 2 * HOUR })], owns, NOW).items[0];
  assert.equal(s2.collectedAt, NOW - 2 * HOUR);
  const far = NOW - 31 * DAY;
  const s3 = S.sanitizeEdgeSnap([edgeItem({ at: far, collectedAt: far - HOUR })], owns, NOW).items[0];
  assert.equal(s3.collectedAt, far - HOUR, '비상식적인 차는 옮기지 않는다(원값 그대로 — 예전과 같다)');
  assert.equal(s3.edgeCollectedAt, undefined);
  const s4 = S.sanitizeEdgeSnap([edgeItem({ at: NOW - HOUR })], owns, NOW).items[0];
  assert.equal(s4.collectedAt, null);
  assert.equal(s4.edgeCollectedAt, undefined);
  // 차가 30일 안이면 보정한다(경계)
  const near = NOW - 29 * DAY;
  assert.equal(S.sanitizeEdgeSnap([edgeItem({ at: near, collectedAt: near - HOUR })], owns, NOW).items[0].collectedAt, NOW - HOUR);
});
