// v3.7.0 IP 관리 재설계 묶음 라 — 쉬는 시간 · 주기 스캔 일정 · 바로 알림 3가지 · 정기 보고.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanQuiet, parseQuietInput, quietWindowAt, quietSpansOfDay } from '../src/ipam/scanQuiet.js';
import { buildScanSchedule } from '../src/ipam/scanSchedule.js';
import { duplicateAlerts, subnetFullAlerts, scanStaleAlerts, DUP_ALERT_MAX } from '../src/ipam/instantAlerts.js';
import { normalizeReport, reportOf, planReportTick, nextReportSlots, tzOffsetMin, validTimeZone, corpOffsetMin } from '../src/ipam/reportRules.js';
import { buildReportModel, renderCorpMail, renderOverallMail, scanCell } from '../src/ipam/reportModel.js';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();   // 이 프로세스의 현지 시각(쉬는 시간은 스캔하는 쪽 현지 시각)

test('v3.7.0 쉬는 시간 — 정제 · 저장 검사(자르지 않고 오류) · 자정 넘는 창은 시작한 날 요일 · 수동은 판정 밖', () => {
  assert.deepEqual(cleanQuiet([{ from: '01:00', to: '05:00' }, { from: 'x', to: '02:00' }, { from: '03:00', to: '03:00' }, { from: '22:00', to: '06:00', days: [5, 5, 9] }]),
    [{ from: '01:00', to: '05:00' }, { from: '22:00', to: '06:00', days: [5] }]);
  assert.match(parseQuietInput([{ from: '25:00', to: '01:00' }]).error, /형식/);
  assert.match(parseQuietInput([{ from: '01:00', to: '01:00' }]).error, /같습니다/);
  assert.match(parseQuietInput([{ from: '01:00', to: '02:00', days: [] }]).error, /요일/);
  assert.match(parseQuietInput('x').error, /형식/);
  assert.deepEqual(parseQuietInput(null), { quiet: [] });
  const q = [{ from: '22:00', to: '06:00', days: [5] }];   // 금요일 밤 22시 ~ 토요일 06시
  const fri = new Date(2026, 10, 13);                       // 2026-11-13 은 금요일
  assert.equal(fri.getDay(), 5);
  assert.ok(quietWindowAt(q, at(2026, 11, 13, 23, 0)), '금 23:00 — 창 안');
  assert.ok(quietWindowAt(q, at(2026, 11, 14, 5, 59)), '토 05:59 — 금요일에 시작한 창 안');
  assert.equal(quietWindowAt(q, at(2026, 11, 14, 23, 0)), null, '토 23:00 — 토요일엔 창이 시작하지 않는다');
  assert.equal(quietWindowAt(q, at(2026, 11, 13, 21, 59)), null);
  assert.deepEqual(quietSpansOfDay(q, at(2026, 11, 14, 12, 0)), [{ fromMin: 0, toMin: 360, label: '22:00~06:00(금)' }]);
});

test('v3.7.0 쉬는 시간 — 저장 · 배정 · 폴러 · 엣지 연결(소스 계약)', () => {
  const store = fs.readFileSync(new URL('../src/ipam/scanStore.js', import.meta.url), 'utf8');
  assert.match(store, /quiet: cleanQuiet\(p\.quiet\)/); assert.match(store, /if \(partial\.quiet !== undefined\) next\.quiet = cleanQuiet\(partial\.quiet\)/);
  const poller = fs.readFileSync(new URL('../src/ipam/scanPoller.js', import.meta.url), 'utf8');
  assert.match(poller, /const qw = trigger === 'periodic' \? quietWindowAt\(s\.quiet\) : null;/, '주기 회차만 — 수동 · 재개는 막지 않는다');
  const edge = fs.readFileSync(new URL('../src/agent/ipScanWorker.js', import.meta.url), 'utf8');
  assert.match(edge, /const qw = dueOnly \? quietWindowAt\(cleanQuiet\(a\.quiet\)\) : null;/, '엣지 — 주기 틱만 · 받은 값을 다시 정제');
  const i = edge.indexOf('const qw = dueOnly'); const j = edge.indexOf('_lastScanAt = Date.now()', i);
  assert.ok(i > 0 && j > i && !edge.slice(i, edge.indexOf('return last;', i)).includes('_lastScanAt ='), '쉬는 시간 건너뛰기는 기준 시각을 바꾸지 않는다(끝난 뒤 한 번 돈다)');
  const route = fs.readFileSync(new URL('../src/routes/admin/centralIpam.js', import.meta.url), 'utf8');
  assert.match(route, /const q = parseQuietInput\(req\.body\.quiet\);\s*if \(q\.error\) return res\.status\(400\)/);
});

test('v3.7.0 주기 스캔 일정 — 오늘 조각(이 포탈 start/finish · 엣지 report) · 늦음 · 기록 없음 · 걸린 시간 > 주기', () => {
  const now = Date.UTC(2026, 10, 13, 6, 0);   // 포탈 날짜(+540) 2026-11-13 15:00
  const log = [
    { at: now - 3 * 3_600_000, event: 'start', agent: '__local__' }, { at: now - 3 * 3_600_000 + 600_000, event: 'finish', agent: '__local__', durationMs: 600_000 },
    { at: now - 3_600_000, event: 'report', agent: 'Edge-PL', durationMs: 7_200_000 },
    { at: now - 1_800_000, event: 'skip', agent: '__local__', message: '쉬는 시간', count: 2, lastAt: now - 600_000 },
    { at: now - 40 * 3_600_000, event: 'finish', agent: '__local__', durationMs: 1000 },   // 어제 — 오늘 조각 아님
  ];
  const agents = [{ name: '__local__', enabled: true, intervalMs: 3_600_000, quiet: [{ from: '01:00', to: '05:00' }], ranges: ['10.0.0.0/24'] },
    { name: 'edge-pl', enabled: true, intervalMs: 3_600_000, ranges: ['10.1.0.0/24'] }, { name: 'edge-us', enabled: true, intervalMs: 3_600_000, ranges: ['x'] }, { name: 'edge-off', enabled: false }];
  const reports = { __local__: { at: now - 3 * 3_600_000 + 600_000 }, 'edge-pl': { at: now - 3_600_000 } };
  const r = buildScanSchedule({ agents, log, reports, now });
  const by = Object.fromEntries(r.rows.map((x) => [x.agent, x]));
  assert.equal(r.nowMin, 900);
  assert.deepEqual(by.__local__.runs.map((x) => x.kind), ['done', 'skip']);
  assert.equal(by.__local__.runs[0].fromMin, 720); assert.equal(by.__local__.runs[0].toMin, 730);
  assert.equal(by.__local__.counts.skip, 2); assert.deepEqual(by.__local__.quiet, ['01:00~05:00']);
  // v3.8.1: '늦음' = 주기 × 2 + 가장 긴 쉬는 시간 — 쉬는 시간 4시간이 있는 이 포탈은 2시간 50분 전 완료가 아직 늦음이 아니다(늦음 판정은 stabilize381 ①).
  assert.equal(by.__local__.state, 'ok', '마지막 완료 2시간 50분 전 < 주기 2배 + 쉬는 시간 4시간');
  assert.equal(by['edge-pl'].runs[0].fromMin, 720, '엣지 report — 끝난 시각 - 걸린 시간'); assert.equal(by['edge-pl'].overrun, true);
  assert.equal(by['edge-us'].state, 'none', '완료 기록 없음 — 0회가 아니라 모름'); assert.equal(by['edge-off'].state, 'off');
  assert.equal(by['edge-pl'].nextAt, now, '다음 예정 어림 — 이미 지났으면 지금');
});

test('v3.7.0 바로 알림 — 중복(못 읽은 vCenter 는 보류 · 상한 요약) · 대역 가득 참(점유 = 대장 + 예약 + DHCP) · 스캔 보고 끊김(기록 없음은 보류)', () => {
  const rows = [{ ip: '10.0.0.5', duplicate: true, vcenterId: 'vc1', ownerName: 'a' }, { ip: '10.0.0.5', duplicate: true, vcenterId: 'vc1', ownerName: 'b' },
    { ip: '10.0.0.6', duplicate: true, vcenterId: 'vc2' }, { ip: '10.0.0.7', vcenterId: 'vc1' }];
  const d = duplicateAlerts(rows, { unreadVc: new Set(['vc2']) });
  assert.deepEqual(d.alerts.map((x) => x.key), ['ipdup:10.0.0.5']); assert.deepEqual(d.held, ['ipdup:10.0.0.6']);
  const many = duplicateAlerts(Array.from({ length: DUP_ALERT_MAX + 1 }, (_, i) => ({ ip: `10.9.${Math.floor(i / 250)}.${i % 250}`, duplicate: true, vcenterId: 'vc1' })));
  assert.deepEqual(many.alerts.map((x) => x.key), ['ipdup:__many__']);
  const f = subnetFullAlerts([{ subnet: '10.0.0.0/24', base: '10.0.0', used: 200, rsv: 20, dhcp: 9 }, { subnet: '10.0.1.0/24', base: '10.0.1', used: 200, rsv: 0, dhcp: 0 }], { threshold: 90 });
  assert.deepEqual(f.map((x) => x.key), ['ipfull:10.0.0'], '229/254 = 90.2%(예약 · DHCP 포함) · 200/254 = 78.7% 아님');
  const now = 10 * 3_600_000;
  const s = scanStaleAlerts([{ name: 'edge-a', enabled: true, intervalMs: 3_600_000, ranges: ['x'] }, { name: 'edge-b', enabled: true, intervalMs: 3_600_000, ranges: ['x'] },
    { name: 'edge-c', enabled: true, intervalMs: 3_600_000, ranges: ['x'] }, { name: 'edge-d', enabled: false, ranges: ['x'] }], { 'Edge-A': { at: now - 4 * 3_600_000 }, 'edge-b': { at: now - 2 * 3_600_000 } }, { threshold: 3, now });
  assert.deepEqual(s.alerts.map((x) => x.key), ['ipscanstale:edge-a'], '대소문자 무시 · 주기 × 3 초과만'); assert.deepEqual(s.held, ['ipscanstale:edge-c']);
  const alerts = fs.readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8');
  assert.match(alerts, /ipamDuplicate: \{ enabled: false \}/); assert.match(alerts, /ipamSubnetFull: \{ enabled: false, threshold: 90 \}/); assert.match(alerts, /ipamScanStale: \{ enabled: false, threshold: 3 \}/);
  assert.match(alerts, /unreadVc: new Set\(\[\.\.\.unreadVc, \.\.\.staleVc\]\)/, '낡은 위임 보고 vCenter 도 보류');
});

test('v3.7.0 정기 보고 규칙 — 기본 매주 일 09:00 · 저장 검사 · 법인 시간대 · 소급 금지(since)', () => {
  const d = reportOf(null);
  assert.deepEqual([d.enabled, d.freq, d.days, d.time, d.clock], [false, 'weekly', [0], '09:00', 'main']);
  assert.match(normalizeReport({ enabled: true, days: [] }, null).error, /요일/);
  assert.match(normalizeReport({ to: ['not-an-email'] }, null).error, /주소 형식/);
  assert.match(normalizeReport({ corps: { pl: { tz: 'Mars/Base' } } }, null).error, /시간대/);
  assert.match(normalizeReport({ fullPct: 30 }, null).error, /50~100/);
  assert.equal(validTimeZone('Europe/Warsaw'), true); assert.equal(validTimeZone('../etc'), false);
  assert.equal(tzOffsetMin('Asia/Seoul', Date.UTC(2026, 10, 13)), 540);
  assert.equal(tzOffsetMin('Europe/Warsaw', Date.UTC(2026, 10, 13)), 60); assert.equal(tzOffsetMin('Europe/Warsaw', Date.UTC(2026, 6, 13)), 120, '서머타임');
  const now = Date.UTC(2026, 10, 13, 0, 0);
  const r = normalizeReport({ enabled: true, clock: 'corp', corps: { pl: { to: ['a@corp.example'], tz: 'Europe/Warsaw' } } }, null, now).report;
  assert.equal(r.since, now, '켠 시각 — 이미 지난 회차를 소급하지 않는다');
  assert.equal(corpOffsetMin(r, 'pl', now), 60); assert.equal(corpOffsetMin(r, 'kr', now), 540, '시간대가 없으면 메인 서버 시각');
  assert.deepEqual(nextReportSlots(r, now).map((x) => new Date(x).toISOString().slice(0, 16)), ['2026-11-15T00:00', '2026-11-22T00:00', '2026-11-29T00:00'], '일요일 09:00 KST');
  const p = planReportTick({ report: r, corpIds: ['pl', 'kr'], now: Date.UTC(2026, 10, 15, 8, 5) });
  assert.equal(p.overall.action, 'missed', '메인 09:00 회차를 8시간 늦게 — 몰아서 보내지 않음');
  assert.equal(p.corps.pl.action, 'send', '바르샤바 09:00(= 08:00Z) 회차');
  const same = normalizeReport({ to: ['b@corp.example'] }, r, now + 3_600_000).report;
  assert.equal(same.since, now, '회차 정의가 같으면 기준 시각 유지');
});

test('v3.7.0 정기 보고 내용 — 법인 메일에 그 법인 것만 · 데모 법인 표시 · 스캔 끊김은 변화 없음이 아님 · 지난 보고 대비', () => {
  const now = Date.UTC(2026, 10, 15, 0, 0); const period = 7 * 86_400_000;
  const rows = [
    { ip: '10.1.0.5', ownerType: 'vm', vcenterId: 'vc-kr', ownerName: 'web01' }, { ip: '10.1.0.6', ownerType: 'vm', vcenterId: 'vc-kr', duplicate: true },
    { ip: '10.2.0.5', ownerType: 'vm', vcenterId: 'vc-pl' }, { ip: '10.3.0.9', ownerType: 'scan', datacenterId: 'pl' }, { ip: '10.9.0.1', ownerType: 'vm', vcenterId: 'vc-mock' },
  ];
  const changes = [{ ts: now - 3_600_000, type: 'new-ip', ip: '10.3.0.9', agent: 'edge-pl', name: 'nas' }, { ts: now - period - 1, type: 'new-ip', ip: '10.1.0.99', agent: 'edge-kr' },
    { ts: now - 100, type: 'mac-change', ip: '10.1.0.5', agent: 'edge-kr', from: 'aa', to: 'bb' }];
  const m = buildReportModel({ rows, assign: { 'vc-kr': 'kr', 'vc-pl': 'pl', 'vc-mock': 'demo' }, datacenters: [{ id: 'kr', name: '한국' }, { id: 'pl', name: '폴란드' }, { id: 'demo', name: '데모' }],
    changes, agents: [{ name: 'edge-pl', enabled: true, intervalMs: 3_600_000, ranges: ['x'] }], reports: {}, agentDc: (a) => ({ 'edge-pl': 'pl', 'edge-kr': 'kr' }[a] || ''),
    mockVc: new Set(['vc-mock']), prevOcc: { kr: { '10.1.0': 1 } }, now, periodMs: period });
  const by = Object.fromEntries(m.corps.map((c) => [c.id, c]));
  assert.equal(by.kr.totals.ips, 2); assert.equal(by.kr.totals.dup, 1); assert.equal(by.kr.changes['new-ip'], 0, '구간 밖 기록은 세지 않는다'); assert.equal(by.kr.changes['mac-change'], 1);
  assert.equal(by.pl.totals.ips, 2); assert.equal(by.pl.changes['new-ip'], 1); assert.equal(by.pl.scanGap, true, '완료 기록 없는 에이전트 — 끊김 표시');
  assert.equal(by.demo.mock, true); assert.equal(by.kr.mock, false);
  assert.equal(by.kr.subnets[0].delta, 1, '지난 보고 1 → 이번 2');
  const mail = renderCorpMail(by.kr, { model: m, sections: reportOf(null).sections, offsetMin: 540, freqLabel: '주간' });
  assert.match(mail.subject, /한국/); assert.doesNotMatch(mail.html, /10\.2\.0\.5|10\.3\.0\.9|폴란드/, '법인 메일에 다른 법인 내용 없음');
  const plMail = renderCorpMail(by.pl, { model: m, sections: reportOf(null).sections, offsetMin: 60, freqLabel: '주간' });
  assert.match(plMail.html, /변화 없음이 아닙니다/);
  const all = renderOverallMail(m, { sections: reportOf(null).sections, offsetMin: 540, freqLabel: '주간', corps: m.corps.filter((c) => !c.mock) });
  assert.match(all.html, /한국/); assert.match(all.html, /폴란드/); assert.doesNotMatch(all.html, /데모/);
  assert.equal(scanCell({ scan: [{ state: 'off' }] }), '스캔 꺼짐', '꺼진 에이전트뿐이면 정상이라고 쓰지 않는다'); assert.equal(scanCell({ scan: [] }), '스캔 없음');
  assert.doesNotMatch(renderCorpMail({ ...by.kr, name: '<b>x</b>' }, { model: m, sections: reportOf(null).sections, offsetMin: 540, freqLabel: '주간' }).html, /<b>x<\/b>/, '이름은 이스케이프');
});

test('v3.7.0 정기 보고 — 라우트 게이트 · 메일 종류 · 중앙 전용 기동', () => {
  const route = fs.readFileSync(new URL('../src/routes/admin/centralIpam.js', import.meta.url), 'utf8');
  for (const p of ["adminRouter.get('/ipam/report', adminOnly, fleetOnly", "adminRouter.put('/ipam/report', adminOnly, fleetOnly", "adminRouter.post('/ipam/report/preview', adminOnly, fleetOnly",
    "adminRouter.post('/ipam/report/send-now', adminOnly, fleetOnly", "adminRouter.get('/ipam/scan/schedule', adminOnly, fleetOnly"]) assert.ok(route.includes(p), p);
  const kinds = fs.readFileSync(new URL('../src/mail/kinds.js', import.meta.url), 'utf8');
  assert.match(kinds, /id: 'ipam-report'/);
  const rep = fs.readFileSync(new URL('../src/ipam/report.js', import.meta.url), 'utf8');
  assert.match(rep, /if \(_timer \|\| isEdge\(\)\) return;/); assert.match(rep, /const real = model\.corps\.filter\(\(c\) => !c\.mock\)/, '데모 법인은 실제 메일 밖');
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(idx, /startIpamReport,/);
});
