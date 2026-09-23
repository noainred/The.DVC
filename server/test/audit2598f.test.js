/**
 * v2.598 감사 수정(그룹 f) 회귀 — 실제 함수를 호출해 동작으로 고정한다.
 *  WEBUI-2598-01 Horizon 전 서버 실패 → 수치 null(0 아님)
 *  WEBUI-2598-02 현재 사용자(Windows) 확인 서버 0대 → 수치 null
 *  WEBUI-2598-04 합집합 문구 백틱 · 출처 0개 → null
 *  RECENT2598-04 PDU 데이지체인 유닛 2+ 뱅크·상 개수 null
 *  INJ-01·06    ReDoS(parseAbout · stripUemcliBanner) — 긴 출력에서 선형 시간
 *  INJ-02       중계 토폴로지 dc 개행 → HAProxy 설정 주입 차단
 *  INJ-03       게스트 디스크 회수 CSV 가 util/csv 가드(탭·CR)를 쓴다
 *  INJ-07       svcmon 로그 분석 unguard 가 탭 가드도 벗긴다
 * 기준 시각에 Date.now() 를 쓰지 않는다(CLAUDE.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2598f-'));
process.env.CONFIG_DIR = DIR;

const { combineServers, seriesRow: hzSeriesRow } = await import('../src/horizon/sessions.js');
const { aggregate, aggregateAll, seriesRow: cuSeriesRow } = await import('../src/curuser/aggregate.js');
const { combineSources, NAME_FORM_NOTE } = await import('../src/curuser/combine.js');
const { detectedUnits } = await import('../src/pdu/poller.js');
const { parseAbout } = await import('../src/pdu/parse.js');
const { stripUemcliBanner } = await import('../src/proxy/sshExec.js');
const { normalizeTopology } = await import('../src/relaytopo/store.js');
const { renderManagedBlock } = await import('../src/relaytopo/haproxy.js');
const { reclaimCsv } = await import('../src/guestdisk/service.js');
const { analyzeLog } = await import('../src/svcmon/loganalyze.js');
const { logDir } = await import('../src/svcmon/logsettings.js');
const { guardCell } = await import('../src/util/csv.js');
const { portalMs } = await import('../src/util/dayKey.js');

test('WEBUI-2598-01 Horizon: 전 서버 조회 실패면 사용자·세션 수는 null(0 아님), 실패 수는 밝힌다', () => {
  const t = combineServers([{ ok: false, serverId: 'a' }, { ok: false, serverId: 'b' }]);
  assert.equal(t.serversOk, 0);
  assert.equal(t.serversFailed, 2);
  for (const k of ['users', 'usersConnected', 'sessions', 'connected', 'disconnected', 'pending', 'usersByServerSum']) {
    assert.equal(t[k], null, `${k} 는 null 이어야 한다`);
  }
  const row = hzSeriesRow(t);
  assert.equal(row.users, null);
  assert.equal(row.sessions, null);
  // 한 대라도 읽었으면 예전과 같다(0 은 값이다)
  const ok = combineServers([{ ok: true, serverId: 'a', sessions: 0, connected: 0, disconnected: 0, pending: 0, users: 0, usersConnected: 0, names: [] }, { ok: false }]);
  assert.equal(ok.users, 0);
  assert.equal(ok.sessions, 0);
  assert.equal(ok.serversFailed, 1);
});

test('WEBUI-2598-02 현재 사용자: 확인한 서버 0대면 사용자 수는 null, 한 대라도 확인했으면 0 은 값이다', () => {
  const recs = [
    { vmId: 'v1', vcenterId: 'vc1', ok: false },
    { vmId: 'v2', vcenterId: 'vc2', ok: false },
    { vmId: 'v3', vcenterId: 'vc2', skipped: true },
  ];
  const a = aggregate(recs);
  assert.equal(a.vmsOk, 0);
  assert.equal(a.users, null);
  assert.equal(a.sessions, null);
  const all = aggregateAll(recs);
  assert.equal(all.total.usersUnion, null);
  assert.equal(all.total.usersByVcSum, null);
  assert.equal(cuSeriesRow(all.total).users, null);
  assert.equal(cuSeriesRow(all.total).vmsOk, 0);

  const b = aggregateAll([{ vmId: 'v1', vcenterId: 'vc1', ok: true, users: [] }, { vmId: 'v2', vcenterId: 'vc2', ok: false }]);
  assert.equal(b.total.users, 0);
  assert.equal(b.total.usersByVcSum, 0);        // vc2 는 모름 — 읽은 vc1 만 더한다
  assert.equal(b.vcenters.find((v) => v.vcenterId === 'vc2').users, null);
});

test('WEBUI-2598-04 합집합: 문구에 백틱 없음 · 읽은 출처가 없으면 null', () => {
  assert.ok(!NAME_FORM_NOTE.includes('`'), '서버 문구가 BoldText 로 그려진다 — 백틱은 글자로 샌다');
  assert.ok(NAME_FORM_NOTE.includes('‘'));
  const none = combineSources({ windows: { state: 'off', names: [] }, vdi: { state: 'failed', names: [] } });
  assert.equal(none.union, null);
  assert.equal(none.both, null);
  assert.equal(none.partial, true);
  const one = combineSources({ windows: { state: 'ok', names: [{ name: 'a' }] }, vdi: { state: 'off', names: [] } });
  assert.equal(one.union, 1);
});

test('RECENT2598-04 PDU: 뱅크·상을 읽지 않은 유닛은 개수가 null(0 이 아니다)', () => {
  const u = detectedUnits({ units: [
    { index: 1, powerW: 100, banks: [{ index: 1 }, { index: 2 }], phases: [{ index: 1 }] },
    { index: 2, powerW: 90, banks: [], phases: [], banksNotCollected: true },
  ] });
  assert.equal(u[0].banks, 2);
  assert.equal(u[0].phases, 1);
  assert.equal(u[1].banks, null);
  assert.equal(u[1].phases, null);
  assert.equal(u[1].banksNotCollected, true);
});

test('INJ-01 parseAbout: 정상 출력은 그대로 읽고, Version 없는 긴 출력에서 선형 시간', () => {
  const about = [
    'Hardware Factory', '---------------', 'Model Number:           AP8941', 'Serial Number:          ZA0000000001',
    '', 'Application Module', '---------------', 'Name:                   rpdu2g', 'Version:                v6.9.6',
    '', 'APC OS(AOS)', '---------------', 'Name:                   aos', 'Version:                v6.9.6',
  ].join('\n');
  const p = parseAbout(about);
  assert.equal(p.model, 'AP8941');
  assert.equal(p.aosVersion, 'v6.9.6');
  assert.equal(p.appVersion, 'v6.9.6');
  const evil = 'aos rpdu2g\n'.repeat(60_000);   // 660KB — 수정 전 약 6초(실측 440KB → 2.9초)
  const t0 = performance.now();
  parseAbout(evil);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `parseAbout ${ms.toFixed(0)}ms`);
});

test('INJ-06 stripUemcliBanner: 인증서 블록은 지우고, [3] 없는 긴 출력에서 선형 시간', () => {
  const raw = [
    'Storage system address: 127.0.0.1', 'Storage system port: 443', 'HTTPS connection', '',
    'Remote certificate:', 'Issuer: CN=x', 'Subject: CN=x', 'Would you like to:',
    '[1] Accept the certificate for this session', '[2] Accept and store', '[3] Reject the certificate',
    'Please input your selection (The default selection is [1]): 1:    ID = pool_1',
    '      Name = pool',
  ].join('\n');
  const out = stripUemcliBanner(raw);
  assert.ok(!out.includes('Remote certificate'));
  assert.ok(!out.includes('Reject the certificate'));
  assert.ok(out.includes('1:    ID = pool_1'));
  assert.ok(out.includes('Name = pool'));
  // [3] 이 너무 멀면(80줄 초과) 블록으로 보지 않는다 — 데이터를 먹지 않는다.
  const far = ['Remote certificate:', ...Array.from({ length: 100 }, (_, i) => `2:  ID = pool_${i}`), '[3] x'].join('\n');
  assert.ok(stripUemcliBanner(far).includes('ID = pool_50'));
  const evil = 'Remote certificate:\n'.repeat(60_000);   // 1.2MB — 수정 전 800KB 에 7.9초
  const t0 = performance.now();
  stripUemcliBanner(evil);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `strip ${ms.toFixed(0)}ms`);
});

test('INJ-02 중계 토폴로지: dc·label·note 의 개행이 HAProxy 설정에 줄로 들어가지 않는다', () => {
  const t = normalizeTopology({
    main: { name: 'M\nain', privateIp: '10.0.0.1' },
    services: [{ key: 'portal', label: 'P\r\nlisten evil', listenPort: 4068, target: 'irs', targetPort: 4000 }],
    sites: [{ dc: 'DC1\nlisten evil\n  bind *:22', note: 'a\nb', edge: { privateIp: '10.0.1.1' }, irs: { privateIp: '10.0.2.1', vcenterIp: '10.0.2.2' } }],
  });
  const site = t.sites[0];
  assert.ok(!/[\r\n]/.test(site.dc), site.dc);
  assert.ok(!/[\r\n]/.test(site.note));
  assert.ok(!/[\r\n]/.test(t.services[0].label));
  assert.ok(!/[\r\n]/.test(t.main.name));
  const { text } = renderManagedBlock(site, t.services, t.main);
  assert.ok(!/^\s*listen evil/m.test(text), '주입된 listen 줄이 없어야 한다');
  assert.ok(!/^\s*bind \*:22/m.test(text));
});

test('INJ-03 회수 CSV: 앞 탭·CR 도 수식 가드, 단독 CR 은 따옴표로 감싼다', () => {
  const csv = reclaimCsv([{ corpName: '\t=cmd', vcenterName: 'a\rb', cluster: '=1+1', vmName: 'vm', allocGB: null }]);
  const line = csv.split('\n')[1];
  assert.ok(line.startsWith("'\t=cmd,"), JSON.stringify(line));
  assert.ok(line.includes('"a\rb"'));
  assert.ok(line.includes("'=1+1"));
  assert.ok(csv.startsWith('﻿'));
});

test('INJ-07 svcmon 로그 분석: 탭으로 시작하는 대상도 필터가 맞는다(guardCell 과 쌍)', async () => {
  const cell = (v) => { const s = guardCell(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const ts = portalMs(2026, 6, 1, 3);
  const line = [new Date(ts).toISOString(), 'A\\B', '\tweb', 'h', 'HTTP', 'http', 'ok', 'r', 12, 1].map(cell).join(',');
  fs.mkdirSync(logDir(), { recursive: true });
  fs.writeFileSync(path.join(logDir(), 'results-20260701.csv'), `﻿시각,경로,대상,호스트,점검명,유형,상태,응답,ms,연속횟수\n${line}\n`);
  const r = await analyzeLog({ from: portalMs(2026, 6, 1, 0), to: portalMs(2026, 6, 2, 0), bucket: 'day', target: '\tweb' });
  assert.equal(r.totals.rows, 1);
});

test('WEBUI-2598-02 후속: 추이 조회는 확인 서버 0대 주기(vms_ok=0)의 수치를 null 로 낸다(저장 0 → 응답 null)', async () => {
  const { commitCurUser, seriesRange } = await import('../src/curuser/db.js');
  const T0 = 1_800_000_000_000;
  const unknown = { vcenterId: '', ...cuSeriesRow(aggregate([{ vmId: 'v', ok: false }])) };
  const known = { vcenterId: '', ...cuSeriesRow(aggregate([{ vmId: 'v', ok: true, users: [{ name: 'a', kind: 'active' }] }])) };
  const zero = { vcenterId: '', ...cuSeriesRow(aggregate([{ vmId: 'v', ok: true, users: [] }])) };
  const w1 = await commitCurUser({ ts: T0, series: [unknown] });
  if (!w1.ok) { assert.ok(/sqlite/i.test(String(w1.reason)), w1.reason); return; }   // node:sqlite 없는 환경
  await commitCurUser({ ts: T0 + 60_000, series: [known] });
  await commitCurUser({ ts: T0 + 120_000, series: [zero] });
  const r = await seriesRange('', T0 - 1, T0 + 200_000);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].users, null);
  assert.equal(r.rows[0].sessions, null);
  assert.equal(r.rows[1].users, 1);
  assert.equal(r.rows[2].users, 0);            // 확인했는데 0명은 값이다
  assert.equal(r.unknownRows, 1);
});
