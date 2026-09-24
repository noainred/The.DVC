/**
 * v2.599 감사 수정 — 그룹 d(수집기 절단·결측·단위 + 엣지 push 메타). 전부 실제 함수를 호출해 동작으로 본다.
 *   C2599-01 Isilon REST 노드 처리량 B/s → bps(×8)
 *   C2599-02 PowerStore SSH 공간 지표 = REST 와 같은 '최신 시각' 점
 *   C2599-03 PowerStore SSH 알람 폴백이 CLEARED 를 미해결로 세지 않는다
 *   C2599-04 APC PDU 뱅크·상·센서 탐지가 E1xx 아닌 실패에서 멈추면 그 사실을 남긴다(가짜 ssh2 서버)
 *   C2599-05 NSX cursor 페이징 + DFW 정책 절단 개수
 *   C2599-06 PowerStore 하드웨어 'Empty' 는 이상이 아니다
 *   C2599-07 Unity REST 알람 per_page 절단 · entryCount
 *   C2599-08 PowerStore REST 알람 limit 상한 표시
 *   C2599-09 bmstor 사용률 = df Capacity(used/(used+avail))
 *   LO2599-03 XtremIO 전체 용량을 못 읽은 클러스터는 합계에서 뺀다
 *   EDGE2599-01 storage push — 위임 0대면 중앙 목록을 비우고(상태 보고도 보낸다), 위임이 있으면 비우지 않는다
 *   EDGE2599-04 config push — 8MB 초과로 뺀 파일 목록을 파일로 세지 않고 밝힌다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2599d-'));
process.env.CONFIG_DIR = DIR;
process.env.SSRF_ALLOW_LOOPBACK = 'true';

// ── C2599-01 ────────────────────────────────────────────────────────────────
test('C2599-01 — Isilon REST 노드 처리량은 B/s×8 = bps, 못 읽은 값은 null', async () => {
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const snap = normalizeIsilon({ id: 'i', type: 'isilon', name: 'I' }, {
    nodes: { nodes: [{ lnn: 1, status: 'ok' }, { lnn: 2, status: 'ok' }] },
    nodeStats: { stats: [
      { devid: 1, key: 'node.net.ext.bytes.in.rate', value: 3400000 },
      { devid: 1, key: 'node.net.ext.bytes.out.rate', value: 0 },
    ] },
  });
  const [n1, n2] = snap.nodes.list;
  assert.equal(n1.inBps, 27_200_000, 'SSH 경로(Throughput bps)와 같은 단위여야 한다');
  assert.equal(n1.outBps, 0, '보고된 0 은 값이다');
  assert.equal(n2.inBps, null, '못 읽은 값은 null(0 은 트래픽 없음이라는 거짓)');
});

// ── C2599-02·03 ─────────────────────────────────────────────────────────────
test('C2599-02 — PowerStore SSH 공간 지표는 배열 끝이 아니라 최신 시각 점', async () => {
  const { normalizePowerstoreSsh } = await import('../src/storage/collectors/powerstoreSsh.js');
  const space = JSON.stringify([
    { timestamp: '2026-09-01T02:00:00Z', physical_total: 100, physical_used: 80 },   // 최신(내림차순 출력)
    { timestamp: '2026-09-01T01:00:00Z', physical_total: 100, physical_used: 10 },
  ]);
  const s = normalizePowerstoreSsh({ id: 'p', name: 'P' }, { cluster: '{"name":"C"}', space });
  assert.equal(s.capacity.usedBytes, 80);
  // 최신 점이 아직 집계 전(physical_total 없음)이면 그 앞의 가장 새 점
  const s2 = normalizePowerstoreSsh({ id: 'p', name: 'P' }, { cluster: '{"name":"C"}', space: JSON.stringify([
    { timestamp: '2026-09-01T01:00:00Z', physical_total: 100, physical_used: 30 },
    { timestamp: '2026-09-01T02:00:00Z', physical_total: 100, physical_used: 40 },
    { timestamp: '2026-09-01T03:00:00Z', physical_total: 0, physical_used: 0 },
  ]) });
  assert.equal(s2.capacity.usedBytes, 40);
});

test('C2599-03 — PowerStore SSH 알람 폴백(상태 필터 없음)은 CLEARED 를 미해결로 세지 않고 밝힌다', async () => {
  const { normalizePowerstoreSsh, ALERT_FALLBACK_CMD } = await import('../src/storage/collectors/powerstoreSsh.js');
  const alert = JSON.stringify([
    { id: 1, severity: 'Major', state: 'ACTIVE' },
    { id: 2, severity: 'Minor', state: 'CLEARED' },
    { id: 3, severity: 'Critical', state: 'ACTIVE' },
    { id: 4, severity: 'Info', state: 'CLEARED' },
  ]);
  const s = normalizePowerstoreSsh({ id: 'p', name: 'P' }, { cluster: '{"name":"C"}', alert }, { alertCmd: ALERT_FALLBACK_CMD });
  assert.equal(s.alerts.unresolved, 2);
  assert.deepEqual(s.extra.alertsBySeverity, { Major: 1, Critical: 1 });
  assert.match(s.extra.alertsNote, /미해결 2건/);
  assert.match(s.extra.alertsNote, /pstcli alert show/);
  // 필터 명령으로 읽었고 전부 ACTIVE 면 노트 없음
  const ok = normalizePowerstoreSsh({ id: 'p', name: 'P' }, { cluster: '{"name":"C"}', alert: '[{"id":1,"state":"ACTIVE","severity":"Major"}]' }, { alertCmd: 'pstcli -output json alert show -state ACTIVE' });
  assert.equal(ok.alerts.unresolved, 1);
  assert.equal(ok.extra.alertsNote, undefined);
});

// ── C2599-06·08 ─────────────────────────────────────────────────────────────
test('C2599-06 — PowerStore 하드웨어 Empty 는 이상이 아니다(absent), 초기화 중은 unknown', async () => {
  const { normalizePowerstore, hardwareLifecycleKind } = await import('../src/storage/collectors/powerstore.js');
  assert.equal(hardwareLifecycleKind('Empty'), 'absent');
  assert.equal(hardwareLifecycleKind('Initializing'), 'unknown');
  assert.equal(hardwareLifecycleKind('Healthy'), 'ok');
  assert.equal(hardwareLifecycleKind('Failed'), 'bad');
  const s = normalizePowerstore({ id: 'p', name: 'P' }, { hardware: [
    { type: 'Drive', lifecycle_state: 'Healthy' }, { type: 'Drive', lifecycle_state: 'Empty' },
    { type: 'Drive', lifecycle_state: 'Empty' }, { type: 'Fan', lifecycle_state: 'Failed' },
    { type: 'Drive', lifecycle_state: 'Uninitialized' }, { type: 'Drive' },
  ] });
  assert.equal(s.extra.inventory.hardware.unhealthy, 1);
  assert.equal(s.extra.inventory.hardware.absent, 2);
  assert.equal(s.extra.inventory.hardware.unknown, 2);
});

test('C2599-08 — PowerStore REST 알람이 조회 상한에 닿으면 하한임을 밝힌다', async () => {
  const { normalizePowerstore, ALERT_LIMIT } = await import('../src/storage/collectors/powerstore.js');
  const alerts = Array.from({ length: ALERT_LIMIT }, (_, i) => ({ id: i, severity: 'Minor' }));
  const s = normalizePowerstore({ id: 'p', name: 'P' }, { alerts, alertsTruncated: true });
  assert.equal(s.alerts.unresolved, ALERT_LIMIT);
  assert.equal(s.extra.alertsTruncated, true);
  assert.match(s.extra.alertsNote, /이상일 수 있습니다/);
  const s2 = normalizePowerstore({ id: 'p', name: 'P' }, { alerts: alerts.slice(0, 3) });
  assert.equal(s2.extra.alertsTruncated, undefined);
});

// ── C2599-07 ────────────────────────────────────────────────────────────────
test('C2599-07 — Unity REST 알람은 entryCount 를 쓰고, 없으면 페이지가 가득 찼을 때 하한임을 밝힌다', async () => {
  const { normalizeUnity, UNITY_ALERT_PER_PAGE } = await import('../src/storage/collectors/unity.js');
  const page = { entries: Array.from({ length: UNITY_ALERT_PER_PAGE }, (_, i) => ({ content: { id: `a${i}` } })) };
  const withCount = normalizeUnity({ id: 'u', name: 'u' }, { alerts: { ...page, entryCount: 250 } });
  assert.equal(withCount.alerts.unresolved, 250);
  assert.match(withCount.extra.alertsNote, /250/);
  const noCount = normalizeUnity({ id: 'u', name: 'u' }, { alerts: page });
  assert.equal(noCount.alerts.unresolved, UNITY_ALERT_PER_PAGE);
  assert.equal(noCount.extra.alertsTruncated, true);
  const few = normalizeUnity({ id: 'u', name: 'u' }, { alerts: { entries: [{ content: {} }], entryCount: 1 } });
  assert.equal(few.alerts.unresolved, 1);
  assert.equal(few.extra.alertsTruncated, undefined);
  assert.equal(few.extra.alertsNote, undefined);
});

// ── LO2599-03 ───────────────────────────────────────────────────────────────
test('LO2599-03 — XtremIO 전체 용량을 못 읽은 클러스터는 total·used 합산에서 모두 뺀다', async () => {
  const { normalizeXtremio } = await import('../src/storage/collectors/xtremio.js');
  const s = normalizeXtremio({ id: 'x', name: 'X' }, { clusters: [
    { name: 'c1', 'ud-ssd-space': 1000, 'ud-ssd-space-in-use': 400 },
    { name: 'c2', 'ud-ssd-space-in-use': 900 },   // 전체 용량 결측
  ] });
  assert.equal(s.capacity.totalBytes, 1000 * 1024);
  assert.equal(s.capacity.usedBytes, 400 * 1024, '결측 클러스터의 사용량이 섞이면 사용률이 130% 가 된다');
  assert.equal(s.capacity.pct, 40);
  assert.equal(s.extra.poolsUnreadable, 1);
  assert.equal(s.pools[1].totalBytes, null);
  const { capacityPointEligible } = await import('../src/storage/db.js');
  assert.equal(capacityPointEligible({ ...s, ok: true }).ok, false, '일부 풀이 빠진 주기는 증가량에 적재하지 않는다(partial-pools)');
});

// ── C2599-09 ────────────────────────────────────────────────────────────────
test('C2599-09 — bmstor 사용률은 df Capacity 와 같은 정의(예약 블록 때문에 가득 찬 디스크가 95% 로 보이지 않게)', async () => {
  const { parseDfOutput, dfUsedPct } = await import('../src/bmstor/collect.js');
  const out = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
    + '/dev/sda1 1000 950 0 100% /data\n'
    + '/dev/sdb1 1000 400 550 43% /logs\n';
  const r = parseDfOutput(out, ['/data', '/logs']);
  assert.equal(r.mounts[0].usedPct, 100);
  assert.equal(r.mounts[1].usedPct, 42.1);
  assert.equal(dfUsedPct(0, 0), null, '분모 0 은 0% 가 아니라 모름');
});

// ── C2599-05 ────────────────────────────────────────────────────────────────
test('C2599-05 — NSX 목록은 cursor 를 따라가고, 페이지 상한에 걸리면 truncated', async () => {
  const { listAllPages, listCount } = await import('../src/nsx/client.js');
  const pages = {
    '/x': { results: [1, 2], cursor: 'c1', result_count: 5 },
    '/x?cursor=c1': { results: [3, 4], cursor: 'c2', result_count: 5 },
    '/x?cursor=c2': { results: [5], result_count: 5 },
  };
  const seen = [];
  const all = await listAllPages(async (p) => { seen.push(p); return pages[p]; }, '/x');
  assert.deepEqual(all.results, [1, 2, 3, 4, 5]);
  assert.equal(all.truncated, false);
  assert.equal(all.result_count, 5);
  assert.equal(seen.length, 3);
  const cut = await listAllPages(async (p) => pages[p], '/x', { maxPages: 2 });
  assert.equal(cut.results.length, 4);
  assert.equal(cut.truncated, true);
  assert.equal(listCount(cut), 5, '개수는 장비가 보고한 전체(result_count)가 우선');
  const qs = [];
  const q = await listAllPages(async (p) => { qs.push(p); return { results: [], cursor: 'z' }; }, '/y?page_size=10', { maxPages: 2 });
  assert.deepEqual(qs, ['/y?page_size=10', '/y?page_size=10&cursor=z'], '이미 쿼리가 있으면 & 로 붙인다');
  assert.equal(q.truncated, true);
});

test('C2599-05 — DFW 정책 60개 상한은 뺀 개수·규칙 수 하한으로 밝힌다', async () => {
  const { firewallSummary, NSX_DFW_POLICY_MAX } = await import('../src/nsx/client.js');
  const pols = { results: Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, rule_count: 2 })), result_count: 70 };
  const dfw = pols.results.slice(0, NSX_DFW_POLICY_MAX).map(() => ({ ruleCount: 3 }));
  const f = firewallSummary({ pols, dfw });
  assert.equal(f.policies, 70);
  assert.equal(f.policiesOmitted, 10);
  assert.equal(f.rules, 60 * 3 + 10 * 2, '조회하지 않은 정책은 rule_count 로 더한다');
  assert.equal(f.rulesPartial, undefined);
  const noRc = { results: [...pols.results.slice(0, 60), { id: 'x' }] };
  const f2 = firewallSummary({ pols: noRc, dfw });
  assert.equal(f2.rulesPartial, true, 'rule_count 를 모르는 정책이 빠졌으면 규칙 수는 하한');
  const small = firewallSummary({ pols: { results: [{ id: 'a' }] }, dfw: [{ ruleCount: 4 }] });
  assert.deepEqual(small, { policies: 1, rules: 4 });
});

// ── C2599-04 (가짜 ssh2 APC 서버) ───────────────────────────────────────────
function apcServer(table) {
  const hostKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acc, _rej, info) => {
        const ch = acc();
        const out = Object.prototype.hasOwnProperty.call(table, info.command) ? table[info.command] : 'E102: Parameter Error\n';
        ch.write(out);
        ch.exit(0); ch.end();
      });
    }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
const OK = (v) => `E000: Success\n${v}\n`;

test('C2599-04 — PDU 뱅크·상·센서 탐지가 E1xx 아닌 실패에서 멈추면 incomplete + 노트, E1xx 는 조용한 종료', async () => {
  const { collect } = await import('../src/pdu/collectors/apcSsh.js');
  const { srv, port } = await apcServer({
    about: 'E000: Success\nModel Number: AP8853\n',
    'devReading 1:power': OK('1.98 kW'),
    'bkReading 1:current': OK('5.1'),
    'bkReading 2:current': 'garbage — no code\n',   // 형식 미인식(명령 실패)
    'phReading 1:current': 'E200: Command failed\n',
    'tempReading 1:C': OK('22.9 C'), 'humReading 1:': OK('34 %RH'),
    'tempReading 2:C': 'weird\n', 'humReading 2:': 'weird\n',
  });
  try {
    const s = await collect({ id: 'pdu1', name: 'PDU', host: '127.0.0.1', sshPort: port, username: 'apc', password: 'x' });
    const u = s.units[0];
    assert.equal(u.banks.length, 1);
    assert.equal(u.banksIncomplete, true);
    assert.equal(u.phases.length, 0);
    assert.equal(u.phasesIncomplete, true);
    assert.equal(s.sensors.length, 1);
    assert.equal(s.sensorsIncomplete, true);
    assert.ok(s.notes.some((n) => /뱅크 2/.test(n)), JSON.stringify(s.notes));
    assert.ok(s.notes.some((n) => /상 1/.test(n)));
    assert.ok(s.notes.some((n) => /환경 센서 2/.test(n)));
  } finally { srv.close(); }

  // 대조: 전부 E1xx 로 끝나면 incomplete 가 없다(센서 미장착은 정상 구성)
  const b = await apcServer({ 'devReading 1:power': OK('1 kW'), 'bkReading 1:current': OK('2') });
  try {
    const s = await collect({ id: 'pdu2', name: 'PDU2', host: '127.0.0.1', sshPort: b.port, username: 'apc', password: 'x' });
    assert.equal(s.units[0].banksIncomplete, undefined);
    assert.equal(s.units[0].phasesIncomplete, undefined);
    assert.equal(s.sensorsIncomplete, undefined);
    assert.ok(s.notes.some((n) => /미장착/.test(n)));
  } finally { b.srv.close(); }
});

// ── EDGE2599-01·04 (목 중앙 HTTP 서버) ──────────────────────────────────────
async function mockCentral() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { bodies.push({ url: req.url, body: JSON.parse(buf) }); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, bodies, url: `http://127.0.0.1:${srv.address().port}` };
}

test('EDGE2599-01 — storage push: 위임 0대면 빈 목록(교체) 후 상태 보고, 위임이 있으면 비우지 않는다', async () => {
  const { config } = await import('../src/config.js');
  config.configDir = DIR;
  const c = await mockCentral();
  config.agent = { ...(config.agent || {}), name: 'edge-t2599', centralUrl: c.url, centralToken: 'tok-2599' };
  try {
    const m = await import('../src/storage/push.js');
    const r = await m.pushStorageNow();
    assert.equal(r.cleared, true, JSON.stringify(r));
    assert.equal(c.bodies.length, 2);
    assert.deepEqual(c.bodies[0].body.devices, []);
    assert.equal(c.bodies[0].body.statusOnly, undefined, '첫 요청은 목록 교체(상태 전용이 아니다)');
    assert.equal(c.bodies[1].body.statusOnly, true, '상태 보고가 목록보다 나중이어야 화면이 위임 0대(정상)를 말한다');
    assert.equal(c.bodies[1].body.status.registered, 0);

    // 위임 장비는 있는데 스냅샷이 없으면(재기동 직후) 비우지 않는다 — 상태 보고만
    const reg = await import('../src/storage/registry.js');
    reg.applyPulledDevices([{ id: 'st-1', type: 'unity480', name: 'U', host: '10.0.0.1', username: 'u', password: 'p', agent: 'edge-t2599' }]);
    c.bodies.length = 0;
    const r2 = await m.pushStorageNow();
    assert.equal(r2.cleared, undefined);
    assert.equal(c.bodies.length, 1);
    assert.equal(c.bodies[0].body.statusOnly, true);
    assert.equal(c.bodies[0].body.status.registered, 1);
  } finally { c.srv.close(); }
});

test('EDGE2599-04 — config push: 8MB 초과로 뺀 파일은 파일로 세지 않고 이름·크기를 밝힌다', async () => {
  const { splitConfigMeta } = await import('../src/agent/configPush.js');
  const { SKIPPED_META, REDACTED_META } = await import('../src/backup/service.js');
  const sp = splitConfigMeta({ 'a.json': '{}', [SKIPPED_META]: [{ name: 'big.json', size: 9e6 }], [REDACTED_META]: { 'x.env': ['K'] } });
  assert.deepEqual(Object.keys(sp.files), ['a.json']);
  assert.deepEqual(sp.skipped, [{ name: 'big.json', size: 9e6 }]);

  const { config } = await import('../src/config.js');
  // collectConfigDir 는 모듈 로드 시의 CONFIG_DIR(= DIR)을 읽는다.
  fs.writeFileSync(path.join(DIR, 'small.json'), '{"a":1}');
  fs.writeFileSync(path.join(DIR, 'huge.json'), Buffer.alloc(9 * 1024 * 1024, 0x20));
  const c = await mockCentral();
  config.agent = { ...(config.agent || {}), name: 'edge-t2599', centralUrl: c.url, centralToken: 'tok-2599' };
  try {
    const m = await import('../src/agent/configPush.js');
    const ok = await m.pushConfigNow();
    assert.equal(ok, true);
    const body = c.bodies[0].body;
    assert.equal(Object.prototype.hasOwnProperty.call(body.files, SKIPPED_META), false, '메타 키가 파일로 가면 안 된다');
    assert.ok(body.files['small.json']);
    assert.deepEqual(body.skipped.map((f) => f.name), ['huge.json']);
    const st = m.configPushStatus().last;
    assert.equal(st.files, Object.keys(body.files).length);
    assert.deepEqual(st.skipped.map((f) => f.name), ['huge.json']);
  } finally { c.srv.close(); fs.rmSync(path.join(DIR, 'huge.json'), { force: true }); }
});

// ── 후속(코디네이터 지시): 합계 사용률·PDU 요약 ─────────────────────────────
test('C2599-09 후속 — bmstor 합계 사용률도 df 정의(used/(used+avail)), 분모 0 은 null', async () => {
  const { aggregate } = await import('../src/bmstor/agg.js');
  const GB = 1024 ** 3;
  const servers = [{ id: 'a', name: 'a', host: '10.0.0.1', group: 'G', mounts: ['/'], enabled: true },
    { id: 'b', name: 'b', host: '10.0.0.2', group: 'G', mounts: ['/'], enabled: true }];
  const latest = new Map([
    ['a', { ok: true, at: 1, mounts: [{ mount: '/', totalBytes: 100 * GB, usedBytes: 95 * GB, availBytes: 0 }] }],
    ['b', { ok: true, at: 1, mounts: [] }],
  ]);
  const { total, groups, perServer } = aggregate(servers, latest);
  assert.equal(perServer.find((s) => s.id === 'a').usedPct, 100, '가용 0 인 디스크는 df 처럼 100%');
  assert.equal(perServer.find((s) => s.id === 'b').usedPct, null, '마운트가 없으면 0% 가 아니라 모름');
  assert.equal(groups[0].usedPct, 100);
  assert.equal(total.usedPct, 100);
});

test('C2599-04 후속 — PDU 요약이 센서 부분 집계를 싣는다', async () => {
  const { summarize } = await import('../src/pdu/types.js');
  assert.equal(summarize({ units: [], sensors: [{ tempC: 20 }], sensorsIncomplete: true }).sensorsIncomplete, true);
  assert.equal(summarize({ units: [], sensors: [] }).sensorsIncomplete, undefined);
});
