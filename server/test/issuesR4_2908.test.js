/**
 * issuesR4_2908.test.js — v2.908 기능 추천 6~10(사용자 '모두 적용' — 기존 화면 틀대로).
 *  6 자동화 규칙(완료 → 위키 체크 · 하위 전부 완료 → 상위 검토 · P0 즉시 채팅 · 멈춤 알림/배지)
 *  7 리포트(주별 생성/완료 · 평균 해결 · SLA 준수율 · 법인 · 담당자 · CSV)
 *  8 SLA 업무 시간(요일 · 시각 · 휴일 · 시간대 · 법인별)
 *  9 포탈 알림함(받을 사람 판정 공유 · 메일 스위치와 따로 · 지금 범위로 다시 거름)
 * 10 다른 알람 · 백업 실패 → 이슈 자동 등록(지연 · 중복 · 해소 · 하루 상한)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSla, calendarFor, businessMs, addBusinessMin, slaOf } from '../src/issues/sla.js';
import { buildIssueReport, issueReportCsv, weekStartDay } from '../src/issues/report.js';
import { planAlertIssues, planBackupIssues, defaultAlertAuto, normalizeAlertAuto, alertKindOf } from '../src/issues/alertIssues.js';
import { normalizeIssueSettings } from '../src/issues/settings.js';
import { staleDaysOf } from '../src/issues/store.js';
import { dayIndex } from '../src/util/dayKey.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function run(body, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2908-'));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const wk = await import(${JSON.stringify(path.join(SRC, 'wiki/store.js'))});
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    let who = { username: 'adm', role: 'admin', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    app.use('/api', api);
    app.use((err, _req, res, _next) => { res.status(err.status || err.statusCode || 500).json({ ok: false, reason: String(err.message || err).slice(0, 200) }); });
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = u; };
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const up = async (p, name, buf) => {
      const r = await fetch(base + p + '?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const WA = { username: 'wa', role: 'admin', scope: { writeVcenters: ['vc-a'] } };
    const SA = { username: 'sa', role: 'operator', scope: { vcenters: ['vc-a'] } };
    const DEMO = { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true };
    const out = {};
    ${body}
    st.flushIssuesNow(); wk.flushWikiNow();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir };
}



const H = 3_600_000;
const D = 24 * H;
const kst = (s) => Date.parse(`${s}+09:00`);

test('8 SLA 업무 시간 — 요일 · 휴일 · 법인 시간대 · 서머타임 · 남은 시각', () => {
  const sla = normalizeSla({ enabled: true, calendar: { mode: 'business', holidays: ['2026-11-06'], byVcenter: { 'vc-pl': { tz: 'Europe/Warsaw' }, 'vc-us': { tz: 'America/New_York', holidays: [] } } } });
  const kr = calendarFor(sla, '');
  // 목 08:00 → 월 10:00(KST): 목 9h + 금(휴일) 0 + 주말 0 + 월 1h
  assert.equal(businessMs(kst('2026-11-05T08:00:00'), kst('2026-11-09T10:00:00'), kr) / H, 10);
  // 같은 구간을 폴란드(UTC+1) 법인으로 — 목 00:00~월 02:00 현지 → 목 9h(금은 공통 휴일)
  assert.equal(businessMs(kst('2026-11-05T08:00:00'), kst('2026-11-09T10:00:00'), calendarFor(sla, 'vc-pl')) / H, 9);
  // 미국 동부(EST)는 법인 휴일 목록이 비어 있어 공통 휴일(11-06)을 쓰지 않는다 — 수 18:00 ~ 일 20:00 현지 → 목 9h + 금 9h
  assert.equal(businessMs(kst('2026-11-05T08:00:00'), kst('2026-11-09T10:00:00'), calendarFor(sla, 'vc-us')) / H, 18);
  // 서머타임 끝(2026-10-25 바르샤바) 을 넘어도 업무 시간은 하루 9시간씩
  assert.equal(businessMs(Date.parse('2026-10-23T09:00:00+02:00'), Date.parse('2026-10-26T18:00:00+01:00'), calendarFor(sla, 'vc-pl')) / H, 18);
  // 목 17:00 에 2시간 남음 → 월 10:00(금 휴일 · 주말 건너뜀)
  assert.equal(addBusinessMin(kst('2026-11-05T17:00:00'), 120, kr), kst('2026-11-09T10:00:00'));
  // slaOf — 업무 시간으로 센 흐른 분 · 달력 표지
  const x = { type: 'incident', priority: 'p2', createdAt: kst('2026-11-05T08:00:00'), status: 'todo', history: [], comments: [] };
  const s = slaOf(x, sla, kst('2026-11-09T10:00:00'));
  assert.equal(s.resolve.usedMin, 600);
  assert.deepEqual(s.calendar, { mode: 'business', tz: 'Asia/Seoul' });
  // 24×7(기본)은 달력 시간 그대로
  const s24 = slaOf(x, normalizeSla({ enabled: true }), kst('2026-11-09T10:00:00'));
  assert.equal(s24.resolve.usedMin, 98 * 60);
  assert.equal(s24.calendar, null);
  // 보류 구간도 업무 시간으로 뺀다 — 목 10~12시 보류
  const xb = { ...x, history: [{ at: kst('2026-11-05T10:00:00'), field: 'blocked', to: true }, { at: kst('2026-11-05T12:00:00'), field: 'blocked', to: false }] };
  assert.equal(slaOf(xb, sla, kst('2026-11-09T10:00:00')).resolve.usedMin, 480);
  // 저장 판정
  assert.throws(() => normalizeSla({ calendar: { mode: 'business', startMin: 600, endMin: 600 } }), /끝 시각/);
  assert.throws(() => normalizeSla({ calendar: { tz: 'Mars/Base' } }), /시간대/);
  assert.throws(() => normalizeSla({ calendar: { holidays: ['2026-02-30'] } }), /YYYY-MM-DD/);
  assert.throws(() => normalizeSla({ calendar: { days: [] } }), /요일/);
  assert.equal(normalizeSla({ calendar: { tz: 'Mars/Base' } }, { strict: false }).calendar.tz, 'Asia/Seoul', '파일 읽기는 기본값으로');
});

test('6 · 9 설정 — 자동화 기본 꺼짐 · 알림함 기본 켬 · 부분 저장이 끄지 않는다', () => {
  const v = normalizeIssueSettings({}).value;
  assert.deepEqual(v.automation, { wikiCheck: false, stale: false, staleDays: 7, p0Chat: false, childrenReview: false });
  assert.equal(v.inbox.enabled, true);
  assert.equal(normalizeIssueSettings({ inbox: { enabled: false } }).value.inbox.enabled, false);
  assert.throws(() => normalizeIssueSettings({ automation: { staleDays: 91 } }), /staleDays/);
  assert.equal(staleDaysOf({ status: 'progress', updatedAt: Date.now() - 8 * D }, { stale: true, staleDays: 7 }), 8);
  assert.equal(staleDaysOf({ status: 'progress', updatedAt: Date.now() - 8 * D }, { stale: false, staleDays: 7 }), null, '규칙이 꺼져 있으면 배지 없음');
  assert.equal(staleDaysOf({ status: 'todo', updatedAt: Date.now() - 30 * D }, { stale: true, staleDays: 7 }), null, '진행 중만');
  assert.equal(staleDaysOf({ status: 'progress', updatedAt: Date.now() - 6 * D }, { stale: true, staleDays: 7 }), null);
});

test('7 리포트 — 주별 · 평균 해결(보류 제외) · SLA 준수율 · 법인 · 담당자 · CSV', () => {
  const now = kst('2026-11-05T12:00:00'); // 목
  assert.equal(weekStartDay(now), dayIndex(kst('2026-11-02T00:00:00')), '월요일 시작');
  const rows = [
    { key: 'ISS-1', type: 'incident', status: 'done', assignee: 'kim', vcenterId: 'vc-a', createdAt: kst('2026-11-03T09:00:00'), closedAt: kst('2026-11-03T11:00:00'), resolveMin: 120, auto: true, sla: { state: 'met', respond: { state: 'met' }, resolve: { state: 'met' } }, worklog: [{ by: 'kim', at: kst('2026-11-03T10:00:00'), minutes: 30 }] },
    { key: 'ISS-2', type: 'task', status: 'done', assignee: 'lee', vcenterId: '', createdAt: kst('2026-10-27T09:00:00'), closedAt: kst('2026-11-04T09:00:00'), resolveMin: 600, auto: false, sla: { state: 'late', respond: { state: 'met' }, resolve: { state: 'late' } }, worklog: [] },
    { key: 'ISS-3', type: 'request', status: 'progress', assignee: 'kim', vcenterId: 'vc-a', createdAt: kst('2026-11-04T09:00:00'), closedAt: null, resolveMin: null, auto: false, sla: { state: 'breached' }, worklog: [{ by: 'lee', at: kst('2026-11-04T10:00:00'), minutes: 45 }] },
    { key: 'ISS-4', type: 'task', status: 'todo', assignee: '', vcenterId: 'vc-b', createdAt: kst('2026-01-01T09:00:00'), closedAt: null, resolveMin: null, auto: false, sla: null, worklog: [] },
  ];
  const r = buildIssueReport(rows, { weeks: 2, now, vcName: (id) => id.toUpperCase() });
  assert.deepEqual(r.trend.map((t) => [t.week, t.created, t.closed, t.current]), [['2026-10-26', 1, 0, false], ['2026-11-02', 2, 2, true]]);
  assert.equal(r.summary.created, 3); assert.equal(r.summary.closed, 2);
  assert.equal(r.summary.avgResolveHours, 6); assert.equal(r.summary.medianResolveHours, 6);
  assert.equal(r.summary.autoPct, 33.3);
  assert.equal(r.sla.resolvePct, 50); assert.equal(r.sla.respondPct, 100); assert.equal(r.sla.breachedOpen, 1);
  assert.deepEqual(r.byCorp.map((c) => [c.name, c.open, c.created, c.closed]), [['VC-A', 1, 2, 1], ['VC-B', 1, 0, 0], ['공용', 0, 1, 1]]);
  assert.deepEqual(r.byAssignee.map((p) => [p.user, p.open, p.closed, p.loggedMin]), [['kim', 1, 1, 30], ['lee', 0, 1, 45]]);
  // SLA 가 꺼져 있으면 준수율은 null(0% 로 적지 않는다)
  assert.equal(buildIssueReport(rows.map((x) => ({ ...x, sla: null })), { weeks: 2, now }).sla, null);
  // CSV — 수식 주입 가드 · 빈 값은 빈 칸
  const csv = issueReportCsv(buildIssueReport([{ ...rows[0], assignee: '=cmd' }], { weeks: 1, now }));
  assert.match(csv, /'=cmd/);
  assert.ok(csv.startsWith('\ufeff'));
  assert.equal(buildIssueReport([], { weeks: 99, now }).weeks, 52, '주 상한');
});

test('10 판정 — 지연 · 중복 · 다시 발생 · 해소 · 하루 상한 · 대상 밖 종류 · 백업 jobid', () => {
  const cfg = { ...defaultAlertAuto(), enabled: true, delayMin: 10, dailyMax: 2 };
  const now = 10_000_000;
  const f = (key, ageMin, extra = {}) => ({ key, since: now - ageMin * 60_000, alert: { title: key, vcenterId: 'vc-a', ...extra } });
  const p = planAlertIssues({ firing: [f('vc:vc-a', 11), f('vc:vc-b', 5), f('ramoc:vc-a:c1', 60), f('host:h1', 60), f('vcstale:vc-c', 30), f('massoff:vc-a', 20)], resolved: [] }, cfg, { now });
  assert.deepEqual(p.actions.map((a) => [a.type, a.f.key]), [['create', 'vc:vc-a'], ['create', 'vcstale:vc-c']], '10분 미만 · 오버커밋 · 꺼진 종류(host) 는 만들지 않는다');
  assert.equal(p.capped, 1, '하루 상한 2건 — massoff 는 세고 만들지 않는다');
  const existing = [{ key: 'ISS-1', origin: { alertKey: 'vc:vc-a', resolvedAt: null } }, { key: 'ISS-2', origin: { alertKey: 'ds:d1', resolvedAt: 123 } }];
  const p2 = planAlertIssues({ firing: [f('vc:vc-a', 99), f('ds:d1', 1)], resolved: [{ key: 'vc:vc-a', alert: {} }, { key: 'ds:zz', alert: {} }] }, { ...cfg, kinds: { ...cfg.kinds, ds: true } }, { existing, now });
  assert.deepEqual(p2.actions.map((a) => [a.type, a.key]), [['again', 'ISS-2'], ['resolve', 'ISS-1']], '열린 이슈가 있으면 만들지 않고 · 해소된 뒤 다시 나면 다시 발생 · 이슈 없는 해소는 무시');
  assert.equal(alertKindOf('backup:x'), '', '백업은 알람 엔진 키가 아니다');
  // 백업 — 잡마다 하나 · 이미 적은 jobid 는 다시 쓰지 않는다 · 복원 실패는 대상 밖
  const bcfg = { ...cfg, kinds: { ...cfg.kinds, backup: true } };
  const rows = [{ kind: 'backup', jobid: 11, directorId: 'd1', jobName: 'vm-a' }, { kind: 'backup', jobid: 12, directorId: 'd1', jobName: 'vm-a' }, { kind: 'restore', jobid: 13, directorId: 'd1', jobName: 'vm-b' }, { kind: 'backup', jobid: 14, directorId: 'd1', jobName: 'vm-c' }];
  const b = planBackupIssues(rows, bcfg, { existing: [{ key: 'ISS-9', origin: { alertKey: 'd1|vm-c', partKeys: ['14'] } }] });
  assert.deepEqual(b.actions.map((a) => [a.type, a.jobKey || a.key, (a.rows || []).map((r) => r.jobid)]), [['create', 'd1|vm-a', [11, 12]]]);
  assert.equal(planBackupIssues(rows, cfg).actions.length, 0, '백업 칸이 꺼져 있으면 없음');
  assert.throws(() => normalizeAlertAuto({ delayMin: 2000 }), /delayMin/);
  assert.throws(() => normalizeAlertAuto({ kinds: { vc: 'yes' } }), /kinds\.vc/);
});

test('6 · 9 · 10 실제 경로 — 알림함 · 자동화 규칙 · 멈춤 · 알람 자동 등록 · 리포트 범위 · 문지기', () => {
  const { out } = run(`
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    const nt = await import(${JSON.stringify(path.join(SRC, 'issues/notify.js'))});
    const ib = await import(${JSON.stringify(path.join(SRC, 'issues/inbox.js'))});
    const au = await import(${JSON.stringify(path.join(SRC, 'issues/automation.js'))});
    const ai = await import(${JSON.stringify(path.join(SRC, 'issues/alertIssues.js'))});
    auth.createUser({ username: 'kim', role: 'operator' }, { trusted: true });
    auth.createUser({ username: 'sa', role: 'operator', scope: { vcenters: ['vc-a'] } }, { trusted: true });
    const mails = []; const chats = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async (t) => { chats.push(t); return ['slack:200']; } });
    au._setAutomationChatForTest(async (t, title) => { chats.push(title + '|' + t); return ['slack:200']; });
    nt.startIssueNotify(); au.startIssueAutomation();
    const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));
    as(ADM);
    // 9 알림함 — 메일 알림이 꺼져 있어도(기본) 담당자 지정이 kim 의 알림함에 쌓인다
    const i1 = (await call('POST', '/issues', { title: '법인 A 장애', assignee: 'kim', vcenterId: 'vc-a', type: 'incident', priority: 'p0' })).j.issue.key;
    const i0 = (await call('POST', '/issues', { title: '공용 작업', assignee: 'kim' })).j.issue.key;
    await call('POST', '/issues/' + i0 + '/comments', { body: '확인 부탁 @kim' });
    as({ username: 'kim', role: 'operator', scope: null });
    const inb = (await call('GET', '/issues/inbox')).j;
    out.inbox = { unread: inb.unread, kinds: inb.items.map((x) => x.kind), keys: inb.items.map((x) => x.key) };
    out.read = (await call('POST', '/issues/inbox/read', { ids: [inb.items[0].id] })).j.changed;
    out.unreadAfter = (await call('GET', '/issues/inbox')).j.unread;
    out.mails = mails.length;
    // 범위가 줄면 예전 줄도 다시 거른다 — kim 을 vc-b 로 좁혀 본다
    as({ username: 'kim', role: 'operator', scope: { vcenters: ['vc-b'] } });
    out.inboxScoped = (await call('GET', '/issues/inbox')).j.items.map((x) => x.key);
    as(DEMO);
    out.inboxDemo = (await call('GET', '/issues/inbox')).j;
    out.inboxDemoRead = (await call('POST', '/issues/inbox/read', {})).s;
    as(ADM);
    await call('PUT', '/issues/settings', { inbox: { enabled: false } });
    await call('POST', '/issues/' + i0 + '/comments', { body: '두 번째 @kim' });
    out.inboxOff = ib.listInbox('kim').total;
    // 6 자동화 — P0 즉시 채팅 · 하위 전부 완료 → 상위 검토 · 완료 → 위키 체크
    await call('PUT', '/issues/settings', { inbox: { enabled: true }, automation: { p0Chat: true, childrenReview: true, wikiCheck: true, stale: true, staleDays: 3 } });
    const p0 = (await call('POST', '/issues', { title: 'P0 다운', type: 'incident', priority: 'p0', vcenterId: 'vc-a' })).j.issue.key;
    await call('POST', '/issues', { title: 'P0 작업', type: 'task', priority: 'p0' });
    await tick();
    out.p0chat = chats.filter((c) => c.startsWith('이슈 트래커 — P0 즉시|')).map((c) => c.includes(p0));
    const par = (await call('POST', '/issues', { title: '상위', assignee: 'kim' })).j.issue.key;
    const c1 = (await call('POST', '/issues', { title: '하위1', parentKey: par })).j.issue.key;
    const c2 = (await call('POST', '/issues', { title: '하위2', parentKey: par })).j.issue.key;
    const pg = (await call('POST', '/wiki/pages', { spaceId: 'pub', title: '런북', body: ['- [ ] ' + c1 + ' 확인', '- [ ] ' + c1 + '0 다른 것', '- [ ] 그냥 항목'].join(String.fromCharCode(10)) })).j.page;
    await call('POST', '/issues/' + c1 + '/status', { status: 'done' });
    await tick();
    out.afterOne = (await call('GET', '/issues/' + par)).j.issue.status;
    const pgv = (await call('GET', '/wiki/pages/' + pg.id)).j.page;
    out.wiki = { body: pgv.body, version: pgv.version, checkRev: pgv.checkRev, by: pgv.checkLog?.[0]?.by };
    await call('POST', '/issues/' + c2 + '/status', { status: 'done' });
    await tick();
    const pv = (await call('GET', '/issues/' + par)).j.issue;
    out.parent = { status: pv.status, note: pv.history.find((h) => h.field === 'status' && h.to === 'review')?.note, by: pv.history.find((h) => h.to === 'review')?.by };
    // 상위를 하위와 함께 완료하면(closeChildren) 자식 완료 이벤트가 상위를 '검토' 로 되돌리지 않는다
    const par2 = (await call('POST', '/issues', { title: '상위2', assignee: 'kim' })).j.issue.key;
    await call('POST', '/issues', { title: '하위', parentKey: par2 });
    await call('POST', '/issues/' + par2 + '/status', { status: 'done', closeChildren: true });
    await tick();
    out.parent2 = (await call('GET', '/issues/' + par2)).j.issue.status;
    out.autoStatus = au.automationStatus();
    // 6 멈춤 — 진행 중 · 갱신 4일 전 → 알림함 한 줄 · 다시 검사해도 한 번 · 배지
    const sk = (await call('POST', '/issues', { title: '멈춘 일', assignee: 'kim' })).j.issue.key;
    await call('POST', '/issues/' + sk + '/status', { status: 'progress' });
    const later = Date.now() + 4 * 86400000;
    out.stale1 = nt.scanStale(later);
    await nt.flushIssueNotify();
    out.stale2 = nt.scanStale(later + 3600000);
    out.staleInbox = ib.listInbox('kim').items.filter((x) => x.kind === 'stale').map((x) => x.key);
    { const iv = (await call('GET', '/issues/' + sk)).j.issue; out.badge = 'stale' in iv ? iv.stale : 'missing'; }
    // 10 알람 자동 등록 — 저장 문지기 · 지연 지난 알람 → 이슈 · 해소 → 검토
    as(WA);
    out.alertPutWA = (await call('PUT', '/issues/autocreate/alerts', { enabled: true })).s;
    as(ADM);
    out.alertPutBad = (await call('PUT', '/issues/autocreate/alerts', { delayMin: -1 })).s;
    out.alertPut = (await call('PUT', '/issues/autocreate/alerts', { enabled: true, delayMin: 5, kinds: { backup: true } })).j.settings.kinds.backup;
    const now = Date.now();
    ai.applyAlertState({ firing: [{ key: 'vc:vc-a', since: now - 6 * 60000, alert: { title: 'vCenter 수집 실패: A', vcenterId: 'vc-a', severity: 'critical', detail: '연결 불가' } }], resolved: [] }, { now });
    ai.applyAlertState({ firing: [{ key: 'vc:vc-a', since: now - 7 * 60000, alert: { title: 'vCenter 수집 실패: A', vcenterId: 'vc-a' } }], resolved: [] }, { now: now + 60000 });
    const made = (await call('GET', '/issues?done=open&q=' + encodeURIComponent('[알람]'))).j.rows.filter((r) => r.origin?.kind === 'alert');
    out.alertIssue = made.map((r) => ({ title: r.title, vc: r.vcenterId, prio: r.priority, kind: r.origin.alertKind }));
    ai.applyAlertState({ firing: [], resolved: [{ key: 'vc:vc-a', alert: { title: 'vCenter 수집 실패: A' } }] }, { now: now + 120000 });
    const ad = (await call('GET', '/issues/' + made[0].key)).j.issue;
    out.alertResolved = { status: ad.status, comments: ad.comments.map((c) => c.body.slice(0, 3)), resolvedAt: !!ad.origin?.resolvedAt };
    ai.applyBackupFailures([{ kind: 'backup', jobid: 5, state: 'error', status: 'f', directorId: 'd1', jobName: 'job-a', vmName: 'vm-a', vcenterId: 'vc-a', at: now }]);
    ai.applyBackupFailures([{ kind: 'backup', jobid: 5, state: 'error', directorId: 'd1', jobName: 'job-a', vcenterId: 'vc-a', at: now }, { kind: 'backup', jobid: 6, state: 'error', directorId: 'd1', jobName: 'job-a', vcenterId: 'vc-a', at: now }]);
    const bk = (await call('GET', '/issues?done=open')).j.rows.filter((r) => r.origin?.kind === 'backup');
    out.backup = bk.map((r) => ({ title: r.title, parts: r.origin.parts, comments: r.comments }));
    // 7 리포트 — 범위 계정은 자기 법인만 · CSV 는 data.csv 권한
    as(SA);
    const rep = (await call('GET', '/issues/report?weeks=4')).j;
    out.repScoped = { corps: rep.byCorp.map((c) => c.vcenterId), weeks: rep.trend.length };
    as(ADM);
    out.repAll = (await call('GET', '/issues/report')).j.byCorp.map((c) => c.vcenterId).sort();
    const csvR = await fetch(base + '/issues/report.csv');
    out.csv = { s: csvR.status, type: csvR.headers.get('content-type'), head: (await csvR.text()).slice(0, 12) };
    as({ username: 'v', role: 'viewer', scope: null });
    out.csvViewer = (await fetch(base + '/issues/report.csv')).status;
    ib.flushInboxNow();
  `);
  assert.deepEqual(out.inbox.keys.slice(0, 1), [out.inbox.keys[0]]);
  assert.equal(out.inbox.unread, 3, '할당 2 + 댓글 언급 1');
  assert.equal(out.inbox.kinds[0], 'mention', '최신 먼저 · 언급은 mention');
  assert.equal(out.read, 1); assert.equal(out.unreadAfter, 2);
  assert.equal(out.mails, 0, '메일 알림은 꺼져 있다(기본) — 알림함만');
  assert.ok(!out.inboxScoped.includes('ISS-1'), '범위 밖 법인(vc-a) 줄은 지금 범위로 다시 거른다');
  assert.ok(out.inboxScoped.length >= 2, '공용 이슈 줄은 보인다');
  assert.equal(out.inboxDemo.demo, true); assert.equal(out.inboxDemo.items.length, 0);
  assert.equal(out.inboxDemoRead, 403);
  assert.equal(out.inboxOff, 3, '알림함을 끄면 더 쌓지 않는다');
  assert.deepEqual(out.p0chat, [true], 'P0 장애만 즉시 채팅(P0 작업은 아님)');
  assert.equal(out.afterOne, 'backlog', '하위가 하나 남아 있으면 그대로');
  assert.match(out.wiki.body, /^- \[x\] ISS-\d+ 확인/);
  assert.match(out.wiki.body, /- \[ \] ISS-\d+0 다른 것/, '뒤에 숫자가 이어지는 다른 키는 건드리지 않는다');
  assert.match(out.wiki.body, /- \[ \] 그냥 항목/);
  assert.equal(out.wiki.version, 1, '판을 만들지 않는다'); assert.equal(out.wiki.checkRev, 1); assert.equal(out.wiki.by, 'automation');
  assert.equal(out.parent.status, 'review'); assert.match(out.parent.note, /^자동화: 하위 작업이 모두 완료/); assert.equal(out.parent.by, 'automation');
  assert.equal(out.parent2, 'done', '한꺼번에 완료한 상위는 검토로 되돌리지 않는다');
  assert.equal(out.autoStatus.errors, 0, JSON.stringify(out.autoStatus));
  assert.equal(out.stale1, 1); assert.equal(out.stale2, 0, '같은 멈춤은 staleDays 일마다 한 번');
  assert.equal(out.staleInbox.length, 1);
  assert.equal(out.badge, null, '배지는 지금 시각 기준 — 방금 옮겼으니 없다');
  assert.equal(out.alertPutWA, 403, '쓰기 범위 관리자는 전 법인 설정을 못 바꾼다');
  assert.equal(out.alertPutBad, 400);
  assert.equal(out.alertPut, true);
  assert.deepEqual(out.alertIssue, [{ title: '[알람] vCenter 수집 실패: A', vc: 'vc-a', prio: 'p1', kind: 'vc' }], '같은 알람은 한 건');
  assert.equal(out.alertResolved.status, 'review'); assert.equal(out.alertResolved.resolvedAt, true);
  assert.deepEqual(out.alertResolved.comments, ['해소:']);
  assert.equal(out.backup.length, 1); assert.equal(out.backup[0].parts, 2, 'jobid 5 · 6 — 5 는 두 번 쓰지 않는다'); assert.equal(out.backup[0].comments, 1);
  assert.match(out.backup[0].title, /^\[백업 실패\] vm-a/);
  assert.deepEqual(out.repScoped.corps, ['vc-a'], '범위 계정 리포트에는 자기 법인만(공용 이슈도 빠진다)');
  assert.equal(out.repScoped.weeks, 4);
  assert.ok(out.repAll.includes('') && out.repAll.includes('vc-a'));
  assert.equal(out.csv.s, 200); assert.match(out.csv.type, /text\/csv/);
  assert.equal(out.csvViewer, 403);
});
