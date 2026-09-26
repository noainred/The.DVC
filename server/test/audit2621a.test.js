/**
 * audit2621a.test.js — v2.621 감사 그룹 A 회귀 고정(RECENT-02·03, DATA-01·02·03·04).
 *
 *  RECENT-02 온도 추이 분 버킷이 step 채움 뒤 상한(5000점)에 걸려 1주 요청이 3.47일만 그려지던 것(조용한 상한)
 *  RECENT-03 점검중(maintenance) vCenter 의 동결 캐시를 샘플러가 '지금 값' 으로 적재하던 것
 *  DATA-01  게스트 로그인 실패 조사가 journalctl '+0900' 오프셋을 '…++09:00' 으로 만들어 ts=지금 이 되던 것
 *  DATA-02  일일 헬스체크가 경보 미조회·첫 수집 중·낡은 위임·사용량 미상 DS 를 '정상(✅)' 으로 보고하던 것
 *  DATA-03  법인 스토리지 사용량(팹 A/B 합산)이 수집 주기보다 짧은 버킷에서 부분 합(절반값)으로 그려지던 것
 *  DATA-04  HPE iLO 의 PSU 흡기 센서가 서버 대표 흡기가 되던 것(실장비 미확인 — PLAUSIBLE)
 *
 * 기준 시각은 Date.now() 를 쓰지 않는다 — 분·시 경계에서 떨어뜨린 고정 시각(CLAUDE.md v2.517 규약).
 * 예외: 라우트 하니스(자식 프로세스)는 라우트가 스스로 Date.now() 로 기간을 잡으므로 그 시각에 맞춰 적재하고,
 * 단언은 경계에 무관한 성질(잘렸는가·덮는 기간)만 본다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2621a-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// 고정 시각: 2026-09-20 03:30:00Z — 정시에서 30분 떨어진 과거.
const NOW = Date.UTC(2026, 8, 20, 3, 30, 0);

/* ── RECENT-02 ──────────────────────────────────────────────────────────── */

const metricsDb = await import('../src/metrics/db.js');

test('RECENT-02 historyCut — 상한이 꽉 찼고 첫 점이 요청 시작보다 뒤면 잘렸다고 밝힌다', () => {
  const pts = (first, n) => Array.from({ length: n }, (_, i) => ({ ts: first + i * MIN }));
  const req = NOW - 10 * MIN;
  assert.deepEqual(metricsDb.historyCut(pts(NOW - 5 * MIN, 5), 5, req), { truncated: true, coveredSince: NOW - 5 * MIN, requestedSince: req });
  // 상한 미만이면(값이 있는 버킷이 적었을 뿐) 잘린 것이 아니다
  assert.equal(metricsDb.historyCut(pts(NOW - 5 * MIN, 4), 5, req).truncated, false);
  // 첫 점이 요청 시작이면 잘리지 않았다
  assert.equal(metricsDb.historyCut(pts(req, 5), 5, req).truncated, false);
  assert.equal(metricsDb.historyCut([], 5, req).truncated, false);
});

test('★ RECENT-02 historyStep — 1주 · 분 버킷 · 상한 5000 이면 truncated·coveredSince 로 밝히고, 기간을 덮는 상한이면 7일을 다 준다', async () => {
  const db = await metricsDb.getMetricsDb();
  assert.equal(db.kind, 'sqlite');
  const start = NOW - 7 * DAY - HOUR;
  // 온도가 안정된 호스트(±0.2℃ — dead-band 로 30분마다 1행만 저장된다)
  for (let t = start; t <= NOW; t += MIN) db.insertMany([{ metric: 'temp_host', k: 'r02-stable', v: 25 + ((t / MIN) % 2) * 0.2 }], t);
  const since = NOW - 7 * DAY;
  const cut = db.historyStep('temp_host', 'r02-stable', since, MIN, 5000, { nowTs: NOW });
  assert.equal(cut.stepped, true);
  assert.equal(cut.points.length, 5000);
  assert.equal(cut.truncated, true, '상한에 걸려 3.47일만 덮는데 잘렸다고 말하지 않았다');
  assert.equal(cut.coveredSince, cut.points[0].ts);
  assert.equal(cut.requestedSince, Math.floor(since / MIN) * MIN);
  // 요청 기간을 덮는 상한(7일 × 1440 + 1)이면 7일 전체
  const full = db.historyStep('temp_host', 'r02-stable', since, MIN, 7 * 1440 + 1, { nowTs: NOW });
  assert.equal(full.truncated, false);
  assert.equal(full.coveredSince, null);
  assert.equal(full.points[0].ts, Math.floor(since / MIN) * MIN);
  assert.ok((full.points[full.points.length - 1].ts - full.points[0].ts) >= 7 * DAY - MIN, '7일을 덮지 못했다');
});

/** 실제 api 라우터를 띄워 esxi-temp/history 를 부른다(자식 프로세스 — 라우트가 Date.now() 로 기간을 잡는다). */
function historyViaRoute(queries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2621a-route-'));
  const script = `
    const HOUR = 3600000, MIN = 60000, DAY = 86400000;
    const { getMetricsDb } = await import(${JSON.stringify(path.join(SRC, 'metrics/db.js'))});
    const db = await getMetricsDb();
    const end = Math.floor(Date.now() / MIN) * MIN;
    for (let t = end - 7 * DAY - 2 * HOUR; t <= end; t += MIN) db.insertMany([{ metric: 'temp_host', k: 'h-stable', v: 25 + ((t / MIN) % 2) * 0.2 }], t);
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'u', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const out = [];
    for (const q of ${JSON.stringify(queries)}) {
      const r = await fetch(base + '/api/tools/esxi-temp/history?level=host&key=h-stable&' + q);
      const b = await r.json();
      const p = b.points || [];
      out.push({ q, status: r.status, limit: b.limit, truncated: b.truncated, coveredSince: b.coveredSince, n: p.length,
        first: p.length ? p[0].ts : null, last: p.length ? p[p.length - 1].ts : null, synthesized: b.synthesized });
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, TEMP_DB_PATH: path.join(dir, 'host-temp.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-800)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-600)}`);
  return JSON.parse(line.slice(2));
}

test('★ RECENT-02 라우트 — 1주·분은 7일 전체, 1달·분은 truncated·coveredSince 로 밝힌다(조용한 상한 금지)', () => {
  const [week, month, oneDay] = historyViaRoute(['days=7&bucket=minute', 'days=30&bucket=minute', 'days=1&bucket=minute']);
  for (const x of [week, month, oneDay]) { assert.equal(x.status, 200); assert.equal(x.synthesized, false); }
  // 1주 × 분: 기간을 덮는 상한으로 올렸다 — 예전엔 5000점(3.47일)에서 조용히 잘렸다
  assert.equal(week.truncated, false);
  assert.ok(week.limit > 5000, `상한 ${week.limit}`);
  assert.ok(week.last - week.first >= 7 * DAY - 2 * MIN, `1주 요청이 ${((week.last - week.first) / DAY).toFixed(2)}일만 덮었다`);
  // 1달 × 분: 상한을 넘으므로 잘리되 그 사실과 실제 시작을 밝힌다
  assert.equal(month.truncated, true, '1달·분 버킷이 잘렸는데 truncated 가 아니다');
  assert.equal(typeof month.coveredSince, 'number');
  assert.equal(month.coveredSince, month.first);
  assert.ok(month.last - month.coveredSince < 30 * DAY);
  // 1일 × 분은 원래 상한(5000) 안이라 그대로
  assert.equal(oneDay.truncated, false);
  assert.equal(oneDay.limit, 5000);
});

/* ── RECENT-03 ──────────────────────────────────────────────────────────── */

const sampler = await import('../src/metrics/sampler.js');
const snapOf = (vcs) => ({
  vcenters: vcs,
  hosts: vcs.map((vc) => ({ id: `h-${vc.id}`, vcenterId: vc.id, name: `esx-${vc.id}`, cluster: 'c1', cpuCores: 10, cpuTotalMhz: 20000, tempC: 31 })),
  vms: vcs.map((vc) => ({ id: `v-${vc.id}`, vcenterId: vc.id, host: `esx-${vc.id}`, powerState: 'POWERED_ON', memMB: 4096, memUsagePct: 50, cpuCount: 2, cpuUsagePct: 40, storageGB: 10 })),
  datastores: vcs.map((vc) => ({ id: `d-${vc.id}`, vcenterId: vc.id, capacityGB: 100, usedGB: 50 })),
  alarms: [],
});
const ALL = { enabled: true, vcenterIds: [], trackTotal: true };

test('★ RECENT-03 점검중(maintenance) vCenter 도 적재 제외 — 사유를 구분한다', () => {
  const snap = snapOf([
    { id: 'vc-maint', status: 'maintenance', maintenance: true },
    { id: 'vc-down', status: 'unreachable', stale: true },
    { id: 'vc-site', status: 'connected', collectSource: 'site', stale: true },
    { id: 'vc-ok', status: 'connected' },
    { id: 'vc-pend', status: 'pending' },
  ]);
  assert.deepEqual([...sampler.staleVcenterIds(snap)].sort(), ['vc-down', 'vc-maint', 'vc-site']);
  assert.deepEqual(Object.fromEntries(sampler.unreadVcenterReasons(snap)), { 'vc-maint': 'maintenance', 'vc-down': 'unreachable', 'vc-site': 'stale' });
  // VM 집계도 동결 캐시를 적재하지 않고, 대상 vCenter 가 빠졌으니 전체('') 합계는 보류한다
  const r = sampler.vmAllocRows(snapOf([{ id: 'vc-maint', status: 'maintenance', maintenance: true }, { id: 'vc-ok', status: 'connected' }]), ALL);
  assert.equal(r.has('vc-maint'), false, '점검중 vCenter 의 동결 값이 적재됐다');
  assert.ok(r.has('vc-ok'));
  assert.equal(r.has(''), false);
  assert.equal(r.totalWithheld, true);
});

test('★ RECENT-03 실제 샘플 1회 — 점검중 호스트의 온도는 적재하지 않고 lastRun.staleSkipped.byReason 에 사유를 싣는다', async () => {
  const { store } = await import('../src/store.js');
  const snap = snapOf([{ id: 'r03-maint', status: 'maintenance', maintenance: true }, { id: 'r03-ok', status: 'connected' }]);
  store.snapshot = snap;
  await sampler._sampleOnceForTest();
  const st = sampler.metricsSamplerStatus();
  assert.ok(st.lastRun, '샘플이 돌지 않았다');
  assert.equal(st.lastRun.staleSkipped?.vcenters, 1);
  assert.deepEqual(st.lastRun.staleSkipped?.byReason, { maintenance: 1 });
  assert.equal(st.lastRun.staleSkipped?.hosts, 1);
  assert.equal(st.lastRun.staleSkipped?.datastores, 1);
  const db = await metricsDb.getMetricsDb();
  const latest = db.latestAll('temp_host');
  assert.equal(latest.has('h-r03-maint'), false, '점검중 호스트의 동결 온도가 지금 값으로 적재됐다');
  assert.ok(latest.has('h-r03-ok'));
});

/* ── DATA-01 ────────────────────────────────────────────────────────────── */

const gls = await import('../src/security/guestLoginScan.js');

test('★ DATA-01 journalctl short-iso — +0900·+09:00·-0500 을 모두 읽는다(예전: +0900 → …++09:00 → null → ts=지금)', () => {
  const at = Date.UTC(2026, 8, 26, 12, 5, 1);   // 21:05:01 +09:00
  assert.equal(gls.parseLogTs('2026-09-26T21:05:01+0900 web01 sshd[811]: Failed password for root from 10.0.0.5 port 22 ssh2', { nowMs: NOW }), at);
  assert.equal(gls.parseLogTs('2026-09-26T21:05:01+09:00 web01 sshd[811]: Failed password for root from 10.0.0.5', { nowMs: NOW }), at);
  assert.equal(gls.parseLogTs('2026-09-26T10:00:00-0500 web01 sshd[1]: Failed password for root from 10.0.0.5', { nowMs: NOW }), Date.UTC(2026, 8, 26, 15, 0, 0));
  assert.equal(gls.parseLogTs('2026-09-26T12:05:01Z web01 sshd[1]: x', { nowMs: NOW }), at);
});

test('★ DATA-01 syslog(연도·TZ 없음)은 게스트 오프셋(TZ 줄)으로 해석한다 — 포탈 프로세스 TZ 와 무관', () => {
  // 게스트가 폴란드(+0200). Sep 19 10:00:00 게스트 시각 = 08:00Z
  const out = ['TZ|+0200', 'Sep 19 10:00:00 db01 sshd[42]: Failed password for invalid user admin from 10.1.2.3 port 5000 ssh2'].join('\n');
  const [f] = gls.parseLinuxFailOutput(out, { nowMs: NOW });
  assert.equal(f.ts, Date.UTC(2026, 8, 19, 8, 0, 0));
  assert.equal(f.user, 'admin');
  assert.equal(f.ip, '10.1.2.3');
  assert.equal(gls.parseTzLine('TZ|-0500'), -300);
  assert.equal(gls.parseTzLine('TZ|'), null, '모양이 다르면 추측하지 않는다');
  // 연말 → 연초: 미래(하루 이상)면 작년
  assert.equal(gls.parseLogTs('Dec 31 23:00:00 h sshd: x', { tzOffsetMin: 0, nowMs: Date.UTC(2027, 0, 2, 0, 0, 0) }), Date.UTC(2026, 11, 31, 23, 0, 0));
});

test('★ DATA-01 같은 줄은 같은 ts — 두 번 조사해도 로그인 실패 저장소에 다시 쌓이지 않는다', async () => {
  const out = ['TZ|+0900', '2026-09-17T10:00:00+0900 web01 sshd[811]: Failed password for root from 10.0.0.5 port 22 ssh2'].join('\n');
  const a = gls.parseLinuxFailOutput(out, { nowMs: NOW });
  const b = gls.parseLinuxFailOutput(out, { nowMs: NOW + 15 * MIN });   // 15분 뒤 다음 조사
  assert.equal(a[0].ts, b[0].ts, '조사 시각이 ts 가 됐다');
  assert.equal(a[0].ts, Date.UTC(2026, 8, 17, 1, 0, 0));
  const { recordLoginFails } = await import('../src/security/loginStore.js');
  const tag = (list) => list.map((f) => ({ ...f, source: 'vm-a', kind: 'guest', vm: 'vm-a', vcenterId: 'vc1', os: 'linux' }));
  assert.equal(recordLoginFails(tag(a)), 1);
  assert.equal(recordLoginFails(tag(b)), 0, '같은 실패가 새 ts 로 다시 적재됐다(브루트포스 오탐의 원인)');
});

test('DATA-01 조사 스크립트 — 첫 줄은 게스트 오프셋, 저널이 읽히면 파일(secure·auth.log)은 읽지 않는다(같은 사건 이중 적재 방지)', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2621a-bin-'));
  const script = path.join(bin, 's.sh');
  fs.writeFileSync(script, gls.LINUX_SCRIPT(7, 80));
  const J = '2026-09-26T21:05:01+0900 web01 sshd[811]: Failed password for root from 10.0.0.5 port 22 ssh2';
  const S = 'Sep 26 21:05:01 web01 sshd[811]: Failed password for root from 10.0.0.5 port 22 ssh2';
  const write = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  // 가짜 cat — /var/log/secure 를 읽으면 syslog 줄을, 그 밖은 진짜 cat 처럼(스크립트는 파일 읽기에만 cat 을 쓴다)
  write('cat', `for a in "$@"; do case "$a" in /var/log/secure) echo "${S}";; esac; done`);
  const run = () => execFileSync('sh', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  try {
    write('journalctl', `echo "${J}"\necho "2026-09-26T21:05:02+0900 web01 sshd[811]: Accepted password for bob from 10.0.0.6"`);
    const lines = run().trim().split('\n');
    assert.match(lines[0], /^TZ\|[+-]\d{4}$/, '첫 줄이 게스트 오프셋이 아니다');
    assert.deepEqual(lines.slice(1), [J], '저널이 읽혔는데 파일도 읽었거나 필터가 틀렸다');
    // 저널에서 아무것도 안 나오면 파일로 폴백
    write('journalctl', 'exit 0');
    const fb = run().trim().split('\n');
    assert.deepEqual(fb.slice(1), [S]);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

/* ── DATA-02 ────────────────────────────────────────────────────────────── */

const hr = await import('../src/reports/healthReport.js');

test('★ DATA-02 경보 미조회·첫 수집 중·낡은 위임·사용량 미상 DS 는 정상(✅)이 아니라 확인 불가다', () => {
  const snap = {
    vcenters: [
      { id: 'vc1', name: 'REST', status: 'connected', collectSource: 'rest', alarmsUnknown: true },
      { id: 'vc2', name: 'PEND', status: 'pending' },
      { id: 'vc3', name: 'SITE', status: 'connected', collectSource: 'site', stale: true },
    ],
    hosts: [{ name: 'h1', vcenterId: 'vc1', connectionState: 'CONNECTED' }],
    vms: [],
    datastores: [{ name: 'ds-null', vcenterId: 'vc1', usagePct: null }, { name: 'ds-ok', vcenterId: 'vc1', usagePct: 40 }],
    alarms: [],
  };
  const r = hr.computeHealthReport(snap, { now: NOW });
  assert.notEqual(r.overall, 'ok', '확인하지 못한 부분이 있는데 종합이 정상이다');
  assert.equal(r.overall, 'unknown');
  const by = Object.fromEntries(r.sections.map((s) => [s.key, s]));
  assert.equal(by.vcenters.status, 'unknown');
  assert.equal(by.vcenters.count, 0);
  assert.match(by.vcenters.detail, /첫 수집 중 1곳/);
  assert.match(by.vcenters.detail, /낡은 위임 보고 1곳/);
  assert.equal(by.alarms.status, 'unknown');
  assert.match(by.alarms.detail, /경보 미조회 vCenter 1곳/);
  assert.equal(by.datastores.status, 'unknown');
  assert.match(by.datastores.detail, /사용량 미상 데이터스토어 1개/);
  assert.deepEqual(r.summary.unknown, { pending: 1, stale: 1, maintenance: 0, alarmsUnknown: 1, dsUsageUnknown: 1 });
  assert.equal(r.summary.issues, 0, '확인 불가는 발견 이슈가 아니다(다른 축)');
  const text = hr.buildDailyReportText(r, 'P');
  assert.match(text.split('\n')[0], /^❔ P 일일 헬스체크/);
  assert.match(text, /확인 불가: 첫 수집 중 vCenter 1곳 · 낡은 위임 보고 1곳 · 경보 미조회 vCenter 1곳 · 사용량 미상 데이터스토어 1개/);
  assert.doesNotMatch(text, /✅ vCenter 수집 실패/, '확인 불가 섹션을 ✅ 로 보냈다');
});

test('DATA-02 발견이 있으면 그 판정이 이긴다 · 확인 불가가 없으면 예전 그대로 ok', () => {
  const r = hr.computeHealthReport({
    vcenters: [{ id: 'a', status: 'unreachable' }, { id: 'b', status: 'pending' }],
    hosts: [], vms: [], alarms: [], datastores: [{ name: 'hot', usagePct: 97 }, { name: 'u', usagePct: undefined }],
  }, { now: NOW });
  const by = Object.fromEntries(r.sections.map((s) => [s.key, s]));
  assert.equal(r.overall, 'crit');
  assert.equal(by.vcenters.status, 'crit');
  assert.equal(by.vcenters.unknown, 1);
  assert.equal(by.datastores.status, 'crit');
  assert.equal(by.datastores.unknown, 1);
  const ok = hr.computeHealthReport({ vcenters: [{ id: 'a', status: 'connected' }, { id: 'd', status: 'disabled' }], hosts: [], vms: [], alarms: [], datastores: [{ name: 'x', usagePct: 10 }] }, { now: NOW });
  assert.equal(ok.overall, 'ok');
  assert.ok(ok.sections.every((s) => s.status === 'ok'));
  // 점검중은 수집을 멈춘 상태 — 확인 불가로 센다(agent/inventoryPush.js UNREAD_STATUSES 와 같은 판단)
  const m = hr.computeHealthReport({ vcenters: [{ id: 'm', status: 'maintenance', maintenance: true }], hosts: [], vms: [], alarms: [], datastores: [] }, { now: NOW });
  assert.equal(m.overall, 'unknown');
  assert.equal(m.summary.unknown.maintenance, 1);
  // 위임 vCenter 의 REST 수집 표지(collectMethod) 도 경보 미조회다
  const s = hr.computeHealthReport({ vcenters: [{ id: 's', status: 'connected', collectSource: 'site', collectMethod: 'rest' }], hosts: [], vms: [], alarms: [], datastores: [] }, { now: NOW });
  assert.equal(s.summary.unknown.alarmsUnknown, 1);
});

/* ── DATA-03 ────────────────────────────────────────────────────────────── */

const perf = await import('../src/sanswitch/perfDb.js');
const ARR_META = [{ port: 1, attachedName: 'SYMMETRIX::000497700230::SAF-1d', speed: '16G', portType: 'F-Port' }];
const T0 = Date.UTC(2026, 8, 20, 1, 0, 0);   // 정시 — 표본은 +45초·+85초로 어긋나게 심는다

async function seedPair(a, b, { stopBAfter = Infinity } = {}) {
  for (let i = 0; i < 16; i++) {
    const t = T0 + i * 5 * MIN + 45_000;
    await perf.savePerfSample(a, t, { 1: 125e6 }, ARR_META);
    if (i < stopBAfter) await perf.savePerfSample(b, t + 40_000, { 1: 125e6 }, ARR_META);
  }
}

test('★ DATA-03 팹 A/B 합산 — 수집 주기보다 짧은 버킷(1h 조회 = 60초)에서도 절반 값 버킷이 없다', async () => {
  await seedPair('d03-swA', 'd03-swB');
  const r = await perf.storageSeriesMulti(['d03-swA', 'd03-swB'], { from: T0 + 20 * MIN, to: T0 + 80 * MIN });
  assert.equal(r.bucketMs, 60_000);
  const s = r.series[0];
  const vals = s.sum.filter((v) => v != null);
  assert.ok(vals.length >= 20, `버킷 ${vals.length}`);
  assert.equal(vals.filter((v) => v < 200e6).length, 0, `한 스위치만 담긴 부분 합(절반값) 버킷: ${vals.filter((v) => v < 200e6).length}`);
  assert.equal(Math.round(s.avgTotal / 1e6), 250, `avgTotal ${s.avgTotal / 1e6}MB/s(정답 250)`);
  assert.equal(Math.round(s.maxTotal / 1e6), 250);
  assert.ok(s.carriedCells > 0, '직전 표본으로 채운 칸을 밝혀야 한다');
  assert.equal(s.partialBuckets, 0);
  assert.equal(r.carryMs, 10 * MIN, '이월 한계 = 수집 주기(기본 5분) × 2');
});

test('★ DATA-03 한 스위치가 도중에 끊기면 그 뒤 버킷은 부분 합으로 그리지 않고(null) partial 로 밝힌다', async () => {
  await seedPair('d03-cutA', 'd03-cutB', { stopBAfter: 6 });   // B 는 T0+30분 이후 표본 없음
  const r = await perf.storageSeriesMulti(['d03-cutA', 'd03-cutB'], { from: T0 + 10 * MIN, to: T0 + 80 * MIN });
  const s = r.series[0];
  const vals = s.sum.filter((v) => v != null);
  assert.equal(vals.filter((v) => v < 200e6).length, 0, '절반 값(부분 합)을 전체처럼 그렸다');
  assert.ok(s.partialBuckets > 0, '빠진 포트가 있는 버킷을 밝히지 않았다');
  for (const i of s.partial) { assert.equal(s.sum[i], null); assert.equal(s.peak[i], null); }
  assert.equal(Math.round(s.avgTotal / 1e6), 250, '부분 합 버킷이 평균을 끌어내렸다');
});

/* ── DATA-04 ────────────────────────────────────────────────────────────── */

const room = await import('../src/idrac/roomTemp.js');
const sts = await import('../src/idrac/serverTempSeries.js');
const tst = await import('../src/tools/serverTemp.js');

test('★ DATA-04 HPE iLO PSU 흡기 센서는 흡기가 아니다 — 서버 대표 흡기가 PSU 온도가 되지 않는다', () => {
  for (const n of ['32-P/S 1 Inlet', '34-P/S 2 Inlet', 'PS 1 Inlet', 'PS1 Inlet Temp', 'PSU2 Inlet', 'Power Supply 1 Inlet', '35-P/S 2 Zone']) {
    assert.equal(room.classifySensor(n), 'other', n);
  }
  const temps = { '01-Inlet Ambient': 22, '32-P/S 1 Inlet': 36, '34-P/S 2 Inlet': 38, '41-Sys Exhaust': 33, '02-CPU 1': 45 };
  const k = sts.serverTempKinds({ temps });
  assert.equal(k.inlet, 22, `대표 흡기가 ${k.inlet}℃ — PSU 흡기를 흡기로 셌다`);
  assert.equal(k.exhaust, 33);
  assert.equal(k.cpu, 45);
  assert.equal(k.max, 45, '최고 온도는 전 센서 최댓값 그대로');
  assert.equal(room.inletStatus(k.inlet), 'ok');
  assert.equal(tst.summarizeSensors(temps).inlet, 22);
  const rep = room.roomTempReport([{ id: 'hpe1', name: 'hpe1', datacenterId: 'dc-h', remote: true, sensors: { t: NOW, temps } }], { now: NOW });
  const host = rep.groups[0].hosts[0];
  assert.equal(host.inlet, 22);
  assert.equal(host.deltaT, 11, 'ΔT(배기−흡기)가 음수로 뒤집혔다');
  assert.equal(rep.groups[0].status, 'ok', '법인 흡기 판정이 PSU 온도로 주의·고온이 됐다');
});

test('DATA-04 Dell 센서 분류는 그대로다', () => {
  for (const n of ['System Board Inlet Temp', 'Inlet Ambient', 'Intake Temp', 'Front Panel Temp', 'CPU Inlet Temp', '01-Inlet Ambient']) assert.equal(room.classifySensor(n), 'inlet', n);
  for (const n of ['System Board Exhaust Temp', 'Outlet Temp', 'Exhaust', 'Rear Temp', '41-Sys Exhaust']) assert.equal(room.classifySensor(n), 'exhaust', n);
  for (const n of ['CPU1 Temp', 'CPU2 Temp', 'CPU 2 Temp', 'Proc 1 Package', 'CPU Die', 'Core 0 Temp', '02-CPU 1']) assert.equal(room.classifySensor(n), 'cpu', n);
  for (const n of ['DIMM Temp', 'PSU1 Temp', 'System Board Temp', 'Diode Bay']) assert.equal(room.classifySensor(n), 'other', n);
});

test.after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });
