/**
 * 결정(56~75 남긴 것) 그룹 G3 — 판정 정확성 · 입력 상한 · 프로비저닝 회귀 고정.
 *
 *  68 D1  게스트 파티션 판정 단위 'vm' — 값 모름 파티션이 있는 VM 은 아는 파티션만의 부분 합으로 판정하지 않는다('값 모름' 으로 따로 센다).
 *  68 P1  guestdisk sanitizeGuestDiskVms — 글자 · NaN · 빈 값 · 음수는 0 이 아니라 null(파티션은 '값 모름', VM 합계는 적재하지 않고 센다).
 *  68 P2  ESXi 경로 표본 가중치 — 표본이 빠진 경로(partial)가 있는 어댑터의 그 표본은 가중치에서 빼고 '제외 n개' 로 밝힌다.
 *  69 ①  vm-lifecycle · vm-changes 하루 막대 — since 가 걸친 첫날도 싣는다(KPI 합 = 막대 합).
 *  62     중복 IP 묶음 알림 — 묶음 해제 문구는 남은 중복 수를 말하고, 묶음으로 보류한 IP 별 알림은 시한 뒤 '해소' 가 아니라 '묶음으로 대체'.
 *  60     공유 토큰 /ip-scan-result 의 에이전트별 보고 기록 상한(cvp-data admitAgent 와 같은 판정).
 *  57·58  env 상한 — 포트 1~65535 · 시한 · 개수의 Infinity · 2^31 초과 · 음수는 기본값.
 *  67     LLM 동시 실행 상한(넘치면 429 '다른 질의 처리 중').
 *  74     프로비저닝 — ② vCenter 작업 결과 추적 · ③ 연속 IP 서브넷 밖 사유 · ④ VM 사양 변경 VM 단위 잠금.
 *
 * 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'decideG3-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
process.env.CENTRAL_EDGE_MAX_AGENTS = '8';   // 60: 상한을 작게(하한 8) — 시험이 빨리 넘친다
process.env.IPAM_WRITE_WORKER = '0';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
const { stripComments } = await import('./_stripComments.js');
const H = 3_600_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 정시 −30분 고정

/* ── 68 D1 ─────────────────────────────────────────────────────────────── */
const R = await import('../src/guestpart/rules.js');
const partsOf = (vm, list, vc = 'vc-a') => list.map(([p, cap, used]) => ({ vmId: vm, vmName: vm, vcenterId: vc, vcenterName: vc, path: p, capGB: cap, usedGB: used, unknown: used == null, ts: NOW }));

test("68 D1 ① 'vm' 단위 — 값 모름 파티션이 있는 VM 은 초과에도 정상에도 넣지 않는다 · 모두 아는 VM 은 예전 그대로", () => {
  const parts = [
    ...partsOf('A', [['C:\\', 10, 9], ['D:\\', null, null]]),     // 예전: 아는 C: 만으로 90% 초과
    ...partsOf('B', [['C:\\', 100, 10], ['D:\\', null, null]]),   // 예전: 10% 정상
    ...partsOf('C', [['C:\\', 10, 9], ['D:\\', 10, 9]]),          // 모두 앎 — 90% 초과
    ...partsOf('D', [['/', 100, 90], ['/boot', null, null]]),     // 값 모름은 무시 규칙(/boot) — 판정에 안 쓰므로 90% 초과
    ...partsOf('E', [['C:\\', 100, 10], ['D:\\', 100, 20]]),      // 모두 앎 — 15% 정상
  ];
  const ev = R.evaluate(parts, { threshold: 80 }, { mode: 'vm' });
  const v = (id) => ev.vms.get(id);
  assert.equal(v('A').over, false); assert.equal(v('A').pct, null); assert.equal(v('A').unknown, 1); assert.equal(v('A').partial, true);
  assert.equal(v('B').over, false); assert.equal(v('B').pct, null, '10% 정상으로 단정하지 않는다');
  assert.equal(v('C').over, true); assert.equal(v('C').pct, 90);
  assert.equal(v('D').over, true); assert.equal(v('D').unknown, 0, '무시한 값 모름 파티션은 판정을 막지 않는다');
  assert.equal(v('E').over, false); assert.equal(v('E').pct, 15);
  assert.deepEqual(R.overKeys(ev).sort(), ['C', 'D']);
  // 파티션 단위는 그대로 — A 의 C: 는 혼자 90% 초과
  const evp = R.evaluate(parts, { threshold: 80 }, { mode: 'part' });
  assert.ok(evp.parts.some((p) => p.vmId === 'A' && p.path === 'C:\\' && p.over));
  assert.ok(evp.vms.get('A').over);
});

test('68 D1 ② 개요 · 상세 · CSV · 메일 — 판정하지 않은 VM 수를 밝힌다', async () => {
  const db = await import('../src/guestdisk/db.js');
  const { overview, vcenterDetail, overCsv, unknownVmsNote, _resetPartsCache } = await import('../src/guestpart/report.js');
  const vm1 = { vmId: 'vc-g:vm1', vmName: 'g1', allocGB: 10, usedGB: 9, partCount: 1, parts: [{ path: 'C:\\', capGB: 10, usedGB: 9 }], partsUnknown: 1, unknownPaths: ['D:\\'] };
  const vm2 = { vmId: 'vc-g:vm2', vmName: 'g2', allocGB: 20, usedGB: 18, partCount: 2, parts: [{ path: 'C:\\', capGB: 10, usedGB: 9 }, { path: 'D:\\', capGB: 10, usedGB: 9 }] };
  assert.ok((await db.commitCollection('vc-g', 'VC-G', [vm1, vm2], { ts: NOW })).ok);
  _resetPartsCache();
  const r = await overview({ allowed: new Set(['vc-g']), mode: 'vm', now: NOW, all: true });
  assert.equal(r.kpi.overVms, 1);
  assert.deepEqual(r.rows.map((x) => x.vmId), ['vc-g:vm2']);
  assert.equal(r.kpi.unknownVms, 1, '판정하지 않은 VM 을 따로 센다');
  assert.equal(r.vcenters.find((x) => x.id === 'vc-g').unknownVms, 1);
  const lines = overCsv(r).trim().split('\r\n');
  assert.match(lines[lines.length - 1], /판정하지 않은 게스트 1대/, 'CSV 마지막 줄에 밝힌다');
  const d = await vcenterDetail('vc-g', { allowed: null, mode: 'vm', onlyOver: false, now: NOW });
  const row = d.vms.find((x) => x.vmId === 'vc-g:vm1');
  assert.equal(row.over, false); assert.equal(row.pct, null); assert.equal(row.unknownParts, 1);
  assert.equal(d.kpi.unknownVms, 1);
  // 파티션 단위 — 판정 보류 수는 null(0 이 아니다) · CSV 안내 없음 · vm1 의 C: 는 90% 초과
  const rp = await overview({ allowed: new Set(['vc-g']), mode: 'part', now: NOW, all: true });
  assert.equal(rp.kpi.unknownVms, null);
  assert.equal(unknownVmsNote(rp), '');
  assert.ok(rp.rows.some((x) => x.vmId === 'vc-g:vm1' && x.path === 'C:\\'));
  // 메일 — 본문 · 텍스트에 같은 안내(HTML 이스케이프)
  const { renderOverMail } = await import('../src/guestpart/mailHtml.js');
  const m = renderOverMail({ kind: 'digest', scopeLabel: '전체', thr: 80, mode: 'vm', rows: r.rows, total: r.rows.length, topN: 10, newKeys: new Set(), newOnly: false,
    kpi: { overVms: 1, crit: 0, notReported: 0, newCount: 0 }, unknownNote: unknownVmsNote(r) });
  assert.match(m.html, /판정하지 않은 게스트 1대/); assert.match(m.text, /판정하지 않은 게스트 1대/);
  // 메일 '새로 넘음' 기억 — 값 모름이 있는 VM 은 초과가 아니어도 회복이 아니다(키를 남긴다) · 모두 아는 VM 은 회복이면 뺀다
  const N = await import('../src/guestpart/notify.js');
  const kept = await N._prunedKeysForTest(['vc-g:vm1', 'vc-g:vm2'], new Set(), ['vc-g']);
  assert.deepEqual(kept, ['vc-g:vm1']);
});

/* ── 68 P1 ─────────────────────────────────────────────────────────────── */
test('68 P1 sanitizeGuestDiskVms — 못 읽은 수치는 null · 파티션은 값 모름 · VM 합계 null 은 적재하지 않고 센다', async () => {
  const { sanitizeGuestDiskVms } = await import('../src/guestdisk/analyze.js');
  const out = sanitizeGuestDiskVms([
    { vmId: 'vc-p:1', vmName: 'p1', allocGB: 'abc', usedGB: '', parts: [{ path: 'C:\\', capGB: 'x', usedGB: 5 }, { path: 'D:\\', capGB: 10, usedGB: 'NaN' }, { path: 'E:\\', capGB: 10, usedGB: 0 }] },
    { vmId: 'vc-p:2', vmName: 'p2', allocGB: 30, usedGB: 0, parts: [{ path: '/', capGB: 30, usedGB: 0 }] },
  ]);
  assert.equal(out[0].allocGB, null); assert.equal(out[0].usedGB, null);
  assert.deepEqual(out[0].parts.map((p) => [p.path, p.capGB, p.usedGB]), [['E:\\', 10, 0]], '읽은 0 은 0');
  assert.equal(out[0].partsUnknown, 2); assert.deepEqual(out[0].unknownPaths, ['C:\\', 'D:\\']);
  assert.equal(out[1].usedGB, 0, '보고된 0 은 0');
  const db = await import('../src/guestdisk/db.js');
  const c = await db.commitCollection('vc-p', 'VC-P', out, { ts: NOW });
  assert.ok(c.ok); assert.equal(c.skippedVms, 1, 'VM 합계를 못 읽은 VM 은 0/0 으로 적재하지 않고 센다'); assert.equal(c.vms, 1);
  assert.equal(await db.vmPartLatest('vc-p:1').then((x) => x?.vm ?? null), null);
});

/* ── 68 P2 ─────────────────────────────────────────────────────────────── */
test('68 P2 경로 표본 — partial 타깃이 있는 어댑터의 그 표본은 가중치에서 빼고 제외 수를 밝힌다', async () => {
  const HI = await import('../src/storpath/history.js');
  const A = await import('../src/sanswitch/attribution.js');
  HI._resetStorPathHistory();
  HI.recordHosts([{ id: 'h1', spath: { at: NOW - 2 * H, samples: 15, targets: [
    { adapter: 'vmhba1', wwn: 't1', readKB: 100, writeKB: 0, partial: false },
    { adapter: 'vmhba1', wwn: 't2', readKB: 10, writeKB: 0, partial: true },   // 표본이 빠져 실제보다 작다
    { adapter: 'vmhba2', wwn: 't1', readKB: 50, writeKB: 50, partial: false },
  ] } }]);
  let w = HI.weightsFor('h1');
  assert.equal(w.kb.has('vmhba1|t1'), false); assert.equal(w.kb.has('vmhba1|t2'), false);
  assert.equal(w.kb.get('vmhba2|t1'), 100, '다른 어댑터는 그대로');
  assert.equal(w.excluded, 1); assert.equal(w.excludedOf.get('vmhba1'), 1);
  assert.equal(A.measuredSharesOf(w, 'vmhba1'), null, '온전한 표본이 없으면 실측 비율을 만들지 않는다(IPF · 비율로)');
  HI.recordHosts([{ id: 'h1', spath: { at: NOW - H, samples: 15, targets: [{ adapter: 'vmhba1', wwn: 't1', readKB: 30 }, { adapter: 'vmhba1', wwn: 't2', readKB: 10 }] } }]);
  w = HI.weightsFor('h1');
  const ms = A.measuredSharesOf(w, 'vmhba1');
  assert.equal(ms.get('t1'), 0.75, '온전한 표본만 — 예전에는 partial 의 KB 까지 더해 130:20(0.867)'); assert.equal(ms.get('t2'), 0.25);
  // 분배 근거 문구가 제외 수를 밝힌다(sanStorPath2935 의 고정물과 같은 모양)
  const HB1 = '10:00:00:10:9b:00:00:01', OTH = '21:00:00:24:ff:00:00:09', T1 = '50:00:09:73:00:00:00:01', T2 = '58:cc:f0:00:00:00:00:c0';
  const portOf = (index, attached, attachedName) => ({ index, slotPort: `0/${index}`, name: `p${index}`, state: 'online', attached, attachedName, inBps: 100, outBps: 200 });
  const f = A.buildFabrics([{ deviceId: 'swA', name: 'SW-A', datacenterId: 'corp-a', collectedAt: NOW,
    ports: { list: [portOf(0, [HB1], 'Emulex'), portOf(1, [T1], 'SYMMETRIX::000497700230::FA-1D:4'), portOf(2, [T2], 'PowerStore::PS12345::node-A'), portOf(3, [OTH], 'QLogic')] },
    zoning: { available: true, zones: [{ name: 'Z1', members: [HB1, T1] }, { name: 'Z2', members: [HB1, T2] }] },
    nsRoles: { [HB1]: 'initiator', [OTH]: 'initiator', [T1]: 'target', [T2]: 'target' } }])[0];
  const host = { id: 'vc:h1', name: 'esx01', vcenterId: 'vc', hbas: [{ name: 'vmhba1', type: 'FibreChannel', wwn: HB1 }] };
  const pb = new Map([['swA|0', { bytes: 1000 }], ['swA|1', { bytes: 900 }], ['swA|2', { bytes: 700 }]]);
  const pw = { kb: new Map([[`vmhba1|${T1}`, 800], [`vmhba1|${T2}`, 200]]), samples: 3, excluded: 2, excludedOf: new Map([['vmhba1', 2]]) };
  const v = A.attributeHost(host, [f], { portBytes: pb, pathWeights: pw }).hbas.find((x) => x.hba === 'vmhba1');
  assert.equal(v.split, 'measured'); assert.equal(v.splitInfo.excludedPartial, 2); assert.match(v.basis, /표본이 빠진 경로 2개 제외/);
  const v2 = A.attributeHost(host, [f], { portBytes: pb, pathWeights: { kb: new Map(), samples: 1, excluded: 1, excludedOf: new Map([['vmhba1', 1]]) } }).hbas[0];
  assert.notEqual(v2.split, 'measured'); assert.match(v2.basis, /실측 비율을 쓰지 않음\(제외 1개\)/);
});

/* ── 69 ① ──────────────────────────────────────────────────────────────── */
test('69 ① 하루 막대는 since 가 걸친 날부터 — KPI 합 = 막대 합 · 첫 칸은 partialFrom', async () => {
  const { analyzeLifecycle } = await import('../src/vmlife/analyze.js');
  const { analyzeMoves, createMovesAcc } = await import('../src/vmchanges/analyze.js');
  const { dayIndex, dayStartMs } = await import('../src/util/dayKey.js');
  const since = NOW - 7 * DAY;
  const life = (vm, ts, type) => ({ vcenterId: 'vc', entity: vm, ts, type, detail: null });
  const rows = [life('a', since + 60_000, 'VmCreatedEvent'), life('b', NOW - DAY, 'VmRemovedEvent'), life('c', NOW, 'VmClonedEvent')];
  const r = analyzeLifecycle(rows, { days: 7, now: NOW, since });
  assert.equal(r.series[0].day, dayStartMs(dayIndex(since)));
  assert.equal(r.series.reduce((a, s) => a + s.added, 0), r.added, '첫날 생성도 막대에 — 예전에는 KPI 2 · 막대 1');
  assert.equal(r.series.reduce((a, s) => a + s.removed, 0), r.removed);
  assert.equal(r.series[0].partialFrom, since);
  assert.equal(r.series.slice(1).some((s) => 'partialFrom' in s), false);
  const mv = (vm, ts) => ({ vcenterId: 'vc', entity: vm, ts, type: 'DrsVmMigratedEvent', detail: null });
  const mrows = [mv('x', since + 60_000), mv('y', NOW - 3 * DAY), mv('x', NOW)];
  const m = analyzeMoves(mrows, { days: 7, now: NOW, since });
  assert.equal(m.series.reduce((a, s) => a + s.moves, 0), m.total);
  const acc = createMovesAcc({ days: 7, now: NOW });
  acc.add(mrows);
  assert.deepEqual(acc.result({ since }).series, m.series, '라우트는 읽은 뒤 그 조회의 since 를 넘긴다');
  // 라우트가 since 를 넘긴다(소스)
  const lc = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/vmLifecycle.js'), 'utf8'));
  assert.match(lc, /analyzeLifecycle\(L\.rows, \{[^}]*since: L\.since/);
  assert.match(stripComments(fs.readFileSync(path.join(SRC, 'routes/api/vmChanges.js'), 'utf8')), /mv\.result\(\{ since: L\.since \}\)/);
});

/* ── 62 ────────────────────────────────────────────────────────────────── */
test('62 중복 IP 묶음 — 해제 문구는 남은 중복 수 · 묶음 보류 IP 키는 시한 뒤 묶음으로 대체(해소 아님 · 구독자에 안 감)', async () => {
  const { store } = await import('../src/store.js');
  const alerts = await import('../src/alerts.js');
  const ledger = await import('../src/ipam/ledger.js');
  const { DUP_ALERT_MAX, DUP_MANY_KEY } = await import('../src/ipam/instantAlerts.js');
  const CFG = { cooldownMin: 60, rules: { ipamDuplicate: { enabled: true } } };
  const ipOf = (i) => `10.${50 + Math.floor(i / 250)}.${Math.floor((i % 250) / 1)}.${7}`;
  let gen = 0;
  const snapWith = (n) => {
    const vms = [];
    for (let i = 0; i < n; i++) for (const s of ['a', 'b']) vms.push({ id: `vc1:vm-${i}-${s}`, name: `vm-${i}-${s}`, vcenterId: 'vc1', ipAddress: ipOf(i), powerState: 'POWERED_ON', guestOS: 'Linux' });
    return { generatedAt: new Date(NOW + (gen += 1000)).toISOString(), initial: false, vcenters: [{ id: 'vc1', name: 'VC1', status: 'connected' }], vms, hosts: [], datastores: [], alarms: [], networks: [] };
  };
  const resolvedSeen = [];
  const off = alerts.onAlertState((ev) => { for (const r of ev.resolved || []) resolvedSeen.push(r.key); });
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const orig = store.get;
  const run = async (n) => { const s = snapWith(n); ledger.buildIpamRows(s, '', null); store.get = () => s; try { await alerts._refreshStateForTest(CFG, false); } finally { store.get = orig; } return alerts.alertStatus(); };
  try {
    alerts._resetAlertStateForTest();
    let st = await run(150);
    assert.equal(st.firing.filter((f) => f.key.startsWith('ipdup:')).length, 150);
    st = await run(DUP_ALERT_MAX + 50);   // 묶음 회차 — IP 별 키는 보류(해소 아님)
    assert.ok(st.firing.some((f) => f.key === DUP_MANY_KEY));
    assert.equal(st.recent.filter((r) => r.severity === 'resolved').length, 0);
    clock += alerts.HELD_MAX_MS + 60_000;   // 보류 시한을 넘긴다(묶음은 그대로)
    st = await run(DUP_ALERT_MAX + 50);
    const ended = st.recent.filter((r) => r.key.startsWith('ipdup:10.'));
    assert.equal(ended.length, Math.min(150, st.recent.length), '조용히 사라지지 않는다 — 정리 기록(alertStatus 는 최근 100건만 싣는다)');
    assert.ok(ended.length >= 100);
    assert.ok(ended.every((r) => r.severity === 'info' && /묶음으로 대체: .* — 개별 상태 모름/.test(r.title)));
    assert.equal(st.firing.filter((f) => f.key.startsWith('ipdup:10.')).length, 0);
    await new Promise((r) => setImmediate(r));
    assert.equal(resolvedSeen.filter((k) => k.startsWith('ipdup:10.')).length, 0, '해소 구독자에게 거짓 해소를 보내지 않는다');
    st = await run(120);   // 상한 아래로 — 묶음 해제(남은 중복 120개)
    const end = st.recent.find((r) => r.key === DUP_MANY_KEY);
    assert.ok(end, '묶음 키의 끝 기록');
    assert.match(end.title, /상한\(200개\) 아래로 내려감 · 중복 120개 남음\(개별 알림으로 계속\)/);
    assert.doesNotMatch(end.title, /^해소:/);
    assert.equal(st.firing.filter((f) => f.key.startsWith('ipdup:10.')).length, 120);
  } finally { Date.now = realNow; store.get = orig; off(); }
});

/* ── 60 ────────────────────────────────────────────────────────────────── */
test('60 스캔 보고 기록 상한 — 설정에 없는 이름은 admitAgent 판정(오래 조용한 것을 내리고 모두 최근이면 거절) · 등록 엣지 · LOCAL 은 언제나', async () => {
  const S = await import('../src/ipam/scanStore.js');
  assert.equal(S.AGENT_REPORTS_MAX, 8);
  S.saveScanSettings('edge-real', { enabled: true, ranges: ['10.9.0.0/24'] });
  for (let i = 0; i < 8; i++) assert.equal(S.recordAgentReport(`fake-${i}`, { scanned: 1, alive: 0 }).ok, true);
  const r = S.recordAgentReport('fake-8', { scanned: 1, alive: 0 });
  assert.equal(r.ok, false); assert.equal(r.refused, true);
  assert.equal(Object.hasOwn(S.getAgentReports(), 'fake-8'), false, '넘친 이름은 기록하지 않는다');
  assert.equal(S.recordAgentIncomplete('fake-9', { code: 'timeout' }), null, '미완료 보고도 같은 상한');
  assert.equal(S.agentReportsCapStatus().refused, 2);
  assert.equal(S.recordAgentReport('edge-real', { scanned: 1 }).ok, true, '설정에 등록된 엣지는 상한과 무관');
  assert.equal(S.recordAgentReport(S.LOCAL, { scanned: 1 }).ok, true);
  assert.equal(S.recordAgentReport('fake-3', { scanned: 2 }).ok, true, '이미 있는 이름은 갱신');
  S.getAgentReports()['fake-0'].at = Date.now() - 25 * H;   // 오래 조용한 이름
  const e = S.recordAgentReport('fake-10', { scanned: 1 });
  assert.equal(e.ok, true); assert.equal(e.evicted, 'fake-0');
  assert.equal(Object.hasOwn(S.getAgentReports(), 'fake-0'), false);
  assert.equal(S.agentReportsCapStatus().evicted, 1);
  const unconfigured = Object.keys(S.getAgentReports()).filter((k) => k.startsWith('fake-'));
  assert.equal(unconfigured.length, 8);
});

/* ── 57 · 58 ───────────────────────────────────────────────────────────── */
test('57 · 58 env 상한 — 포트는 1~65535 정수 · 시한 · 개수의 Infinity · 2^31 초과 · 음수는 기본값', async () => {
  const E = await import('../src/util/envNumber.js');
  assert.deepEqual(['8443', '-1', '70000', 'Infinity', '', 'abc', '0', '65535'].map((v) => E.envPort(v, 443)), [8443, 443, 443, 443, 443, 443, 443, 65535]);
  assert.deepEqual(['Infinity', '3000000000', '-5', '90000', '1e400'].map((v) => E.envPositive(v, 180_000, { max: E.ENV_INT_MAX })), [180_000, 180_000, 180_000, 90_000, 180_000]);
  assert.equal(E.envPositive('3000000000', 5), 3_000_000_000, 'max 를 주지 않은 호출부는 예전 그대로');
  const src = (f) => stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  for (const f of ['storage/collectors/xtremio.js', 'storage/collectors/unity.js', 'storage/collectors/arrayPerf.js', 'storage/collectors/powerstore.js', 'storage/collectors/vplex.js']) {
    assert.doesNotMatch(src(f), /Number\(process\.env\.STORAGE_[A-Z]+_PORT\)\s*\|\|/, `${f}: 포트 env 를 Number()||443 으로 읽지 않는다`);
    assert.match(src(f), /envPort\(process\.env\.STORAGE_[A-Z]+_PORT, 443\)/);
  }
  for (const [f, k] of [['storage/poller.js', 'STORAGE_DEVICE_TIMEOUT_MS'], ['storage/poller.js', 'STORAGE_AREAS_TIMEOUT_MS'], ['storage/collectors/cliSsh.js', 'STORAGE_CLI_SESSION_BUDGET_MS'],
    ['storage/collectRequests.js', 'STORAGE_DEVICE_TIMEOUT_MS'], ['sanswitch/healthHistory.js', 'SANHEALTH_MAX_RUNS'], ['sanswitch/storageCheckHistory.js', 'SANSTORAGE_CHECK_MAX_RUNS'],
    ['sanswitch/activityLog.js', 'SANSWITCH_ACTIVITY_MAX'], ['sanswitch/perfActivityLog.js', 'SANSW_PERF_ACTIVITY_MAX']]) {
    assert.match(src(f), new RegExp(`envPositive\\(process\\.env\\.${k}, [0-9_]+, \\{ max: ENV_INT_MAX \\}\\)`), `${f}: ${k}`);
  }
  // 실제 모듈 값 — 'Infinity' 를 넣고 새 프로세스에서 읽는다(모듈 로드 때 굳는다)
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const h = await import(${JSON.stringify(path.join(SRC, 'sanswitch/healthHistory.js'))}); const s = await import(${JSON.stringify(path.join(SRC, 'sanswitch/storageCheckHistory.js'))}); console.log('@@' + JSON.stringify([h.MAX_RUNS, s.MAX_RUNS]));`],
  { env: { ...process.env, CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'g3env-')), SANHEALTH_MAX_RUNS: 'Infinity', SANSTORAGE_CHECK_MAX_RUNS: '-3' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2)), [24, 48], '예전: Infinity → 무제한 · 음수 → 하한 10');
});

/* ── 67 ────────────────────────────────────────────────────────────────── */
test('67 LLM 동시 실행 상한 — 넘치면 429 · 한 요청(ChatOps)은 한 자리 · 끝나면 풀린다', async () => {
  const L = await import('../src/llm/limit.js');
  assert.equal(L.LLM_MAX_CONCURRENT, 2);
  L._resetLlmLimitForTest();
  let release = null;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', async () => {
      calls += 1;
      await gate;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: JSON.stringify({ entity: 'vm', filters: [], match: 'all' }) }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(DIR, 'llm.json'), JSON.stringify({ enabled: true, url: `http://127.0.0.1:${srv.address().port}`, model: 'm', timeoutMs: 20_000 }));
  const { store } = await import('../src/store.js');
  const orig = store.get;
  const snap = { generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vc-a' }], hosts: [], vms: [{ id: 'v1', name: 'vm-1', vcenterId: 'vc-a', powerState: 'POWERED_ON' }], datastores: [], networks: [], alarms: [] };
  store.get = () => snap;
  try {
    const nl = await import('../src/llm/nlSearch.js');
    const { chatOps } = await import('../src/llm/chatops.js');
    const p1 = nl.nlSearch('vm 목록');
    const p2 = chatOps('vm 목록 보여줘');   // 검색 해석 + 답변 = 두 호출이지만 자리는 하나
    while (calls < 2) await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(nl.nlSearch('vm 목록'), (e) => e.status === 429 && /다른 질의 처리 중/.test(e.message), '세 번째는 기다리지 않고 거절');
    await assert.rejects(chatOps('vm 목록'), (e) => e.status === 429);
    assert.equal(L.llmLimitStatus().inflight, 2);
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.source, 'llm'); assert.equal(b.source, 'llm');
    assert.ok(b.search, 'ChatOps 안의 검색은 같은 자리로 LLM 을 썼다(429 로 빠지지 않았다)');
    assert.equal(L.llmLimitStatus().inflight, 0, '끝나면 풀린다');
    assert.equal((await nl.nlSearch('vm 목록')).source, 'llm');
    // LLM 꺼짐(폴백)은 자리를 잡지 않는다
    fs.writeFileSync(path.join(DIR, 'llm.json'), JSON.stringify({ enabled: false }));
    const held = [L.acquireLlmSlot(), L.acquireLlmSlot()];
    assert.equal((await nl.nlSearch('vm 목록')).source, 'fallback');
    held.forEach((f) => f());
  } finally { store.get = orig; srv.close(); }
  // 라우트는 429 + 사유
  for (const [f, re] of [['routes/api/searchNotes.js', /err\?\.status === 429[^\n]*status\(429\)/], ['routes/insights.js', /e\?\.status === 429[^\n]*status\(429\)/]]) {
    assert.match(stripComments(fs.readFileSync(path.join(SRC, f), 'utf8')), re, f);
  }
});

/* ── 74 ────────────────────────────────────────────────────────────────── */
test('74 ② waitTask(사양 변경) — 상태 순서 · 시간 초과 표지 · 시한 뒤에도 한 번은 본다', async () => {
  const { waitTask } = await import('../src/provision/reconfig.js');
  const client = (states) => ({ n: 0, async retrieveObjectProps() { const s = states[Math.min(this.n++, states.length - 1)]; return [{ props: { 'info.state': s, 'info.error': s === 'error' ? '<localizedMessage>disk full</localizedMessage>' : '' } }]; } });
  assert.deepEqual(await waitTask(client(['queued', 'running', 'success']), 't', { pollMs: 1 }), { ok: true });
  assert.deepEqual(await waitTask(client(['running', 'error']), 't', { pollMs: 1 }), { ok: false, error: 'disk full' });
  assert.deepEqual(await waitTask(client(['running']), 't', { pollMs: 1, timeoutMs: 5 }), { ok: false, timeout: true, error: '작업 시간 초과' });
  assert.deepEqual(await waitTask(client(['success']), 't', { timeoutMs: 1, t0: 0 }), { ok: true }, '늦게 시작한 대기도 한 번은 상태를 본다');
});

/** 가짜 provisioner — 제출 시각 · 순서와 조회(묶음 크기 · 동시성)를 기록한다. states(ref) 가 그 회차의 상태(또는 던질 오류). */
function fakeProv({ submitMs = 1, states = () => ({ state: 'running' }) } = {}) {
  const log = { submits: [], fetches: [], inflight: 0, maxInflight: 0 };
  let seq = 0;
  return {
    log,
    async cloneOne(_src, v) { await new Promise((r) => setTimeout(r, submitMs)); log.submits.push({ name: v.name, at: performance.now() }); return { task: `task-${++seq}` }; },
    async fetchTaskStates(refs) {
      log.inflight += 1; log.maxInflight = Math.max(log.maxInflight, log.inflight);
      log.fetches.push([...refs]);
      try {
        await new Promise((r) => setTimeout(r, 1));
        const out = new Map();
        for (const r of refs) { const s = states(r, refs); if (s instanceof Error) throw s; if (s) out.set(r, s); }
        return out;
      } finally { log.inflight -= 1; }
    },
  };
}
const vmsOf = (n) => Array.from({ length: n }, (_, i) => ({ name: `v${i}`, status: 'queued', error: null, task: null }));
const guard = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} — ${ms}ms 안에 끝나지 않았다`)), ms))]);

test('74 ② 제출은 추적을 기다리지 않는다 — N건이 곧바로 모두 나가고, 결과는 분리된 추적기가 묶어 조회한다', async () => {
  const T = await import('../src/provision/taskTracker.js');
  let release = false; let firstDoneAt = null;
  const prov = fakeProv({ states: () => (release ? { state: 'success' } : { state: 'running' }) });
  const vms = vmsOf(10);
  const run = T.runLiveVms(prov, { id: 's' }, vms, { concurrency: 4, timeoutMs: 60_000, pollMs: 5, chunk: 3, trackConcurrency: 2,
    onChange: () => { if (firstDoneAt == null && vms.some((v) => v.status === 'done')) firstDoneAt = performance.now(); } });
  await guard((async () => { while (!vms.every((v) => v.status === 'submitted')) await new Promise((r) => setTimeout(r, 2)); })(), 3000, '제출 10건');
  assert.equal(prov.log.submits.length, 10, '추적이 끝나지 않았는데도 10건 모두 제출(예전 같은 풀 대기면 4건에서 멈춘다)');
  assert.deepEqual(prov.log.submits.map((x) => x.name), vms.map((v) => v.name), '제출 순서 = 목록 순서');
  assert.equal(vms.some((v) => v.status === 'done'), false);
  release = true;
  await guard(run, 3000, '추적');
  assert.ok(vms.every((v) => v.status === 'done'));
  assert.ok(prov.log.submits.every((x) => x.at < firstDoneAt), '모든 제출 시각 < 첫 완료 시각');
  assert.ok(prov.log.fetches.every((g) => g.length <= 3), '묶음 크기 상한');
  assert.ok(prov.log.maxInflight <= 2, `묶음 조회 동시성 상한(실제 ${prov.log.maxInflight})`);
  assert.ok(prov.log.fetches.some((g) => g.length > 1), '작업 id 를 묶어 조회한다');
});

test('74 ② 추적기는 시한에 끝난다 — 시간 초과 · 조회 실패는 결과 모름 · 사라진 작업은 그것만 · 작업 실패는 실패', async () => {
  const T = await import('../src/provision/taskTracker.js');
  // ① 계속 running — 시한(40ms)에 끝나고 결과 모름(시간 초과)
  let vms = vmsOf(5);
  const t0 = performance.now();
  await guard(T.runLiveVms(fakeProv(), { id: 's' }, vms, { concurrency: 4, timeoutMs: 40, pollMs: 5, chunk: 2 }), 3000, '시한');
  assert.ok(performance.now() - t0 < 1500);
  assert.ok(vms.every((v) => v.status === 'unknown' && /시간 초과.*vCenter 에서 계속될 수 있습니다/.test(v.error)));
  // ② 연결 오류(fault 없음) — 하나씩 다시 묻지 않고 시한에 '조회하지 못했습니다'
  vms = [1, 2, 3, 4].map((i) => ({ name: `w${i}`, status: 'submitted', task: `task-${i}`, submittedAt: performance.now() }));
  const p2 = fakeProv({ states: () => new Error('ECONNRESET') });
  await guard(T.trackTasks(p2, vms, { timeoutMs: 30, pollMs: 5, chunk: 4, now: () => performance.now() }), 3000, '조회 실패');
  assert.ok(vms.every((v) => v.status === 'unknown' && /조회하지 못했습니다\(ECONNRESET\)/.test(v.error)));
  assert.ok(p2.log.fetches.length >= 2 && p2.log.fetches.every((g) => g.length === 4), '연결 오류에 작업 수만큼 하나씩 다시 묻지 않는다(묶음 그대로)');
  // ③ 사라진 작업 하나가 묶음을 fault 로 실패시키면 그 묶음만 하나씩 — 사라진 것만 결과 모름, 나머지는 성공 · 실패
  vms = vmsOf(3);
  const gone = Object.assign(new Error('SOAP 500: ManagedObjectNotFound'), { fault: 'ManagedObjectNotFound' });
  const p3 = fakeProv({ states: (r, refs) => (r === 'task-2' ? gone : (refs.length > 1 && refs.includes('task-2') ? gone : (r === 'task-3' ? { state: 'error', error: 'disk full' } : { state: 'success' }))) });
  await guard(T.runLiveVms(p3, { id: 's' }, vms, { concurrency: 4, timeoutMs: 60_000, pollMs: 5, chunk: 3 }), 3000, '사라진 작업');
  assert.deepEqual(vms.map((v) => v.status), ['done', 'unknown', 'error']);
  assert.match(vms[1].error, /찾을 수 없습니다/); assert.match(vms[2].error, /vCenter 복제 작업 실패: disk full/);
  // ④ 시한을 넘긴 VM 도 한 번은 상태를 본다(이미 성공이면 성공)
  const late = [{ name: 'x', status: 'submitted', task: 'task-9', submittedAt: 0 }];
  await T.trackTasks(fakeProv({ states: () => ({ state: 'success' }) }), late, { timeoutMs: 1, pollMs: 1 });
  assert.equal(late[0].status, 'done');
  // ⑤ 제출 실패 · 작업 번호 없음
  const bad = vmsOf(2);
  const p5 = { async cloneOne(_s, v) { if (v.name === 'v0') throw new Error('NoPermission'); return { task: null }; }, async fetchTaskStates() { return new Map(); } };
  await guard(T.runLiveVms(p5, { id: 's' }, bad, { timeoutMs: 1000, pollMs: 5 }), 3000, '제출 실패');
  assert.deepEqual(bad.map((v) => v.status), ['error', 'unknown']);
  // 추적할 것이 없으면 간격(60초)을 기다리지 않고 제출이 끝나는 순간 끝난다
  const t5 = performance.now();
  await guard(T.runLiveVms(p5, { id: 's' }, vmsOf(3), { timeoutMs: 1000, pollMs: 60_000 }), 2000, '모두 제출 실패한 배치');
  assert.ok(performance.now() - t5 < 1500);
  // 작업 상태 · 실제 provisioner 는 작업을 취소하지 않고 id 를 묶어 조회한다 · jobs.js 는 추적기를 쓴다
  const J = await import('../src/provision/jobs.js');
  assert.equal(J.jobStatusOf([{ status: 'done' }, { status: 'unknown' }]), 'completed_with_unknown');
  assert.equal(J.jobStatusOf([{ status: 'error' }, { status: 'unknown' }]), 'completed_with_errors');
  assert.equal(J.jobStatusOf([{ status: 'done' }]), 'completed');
  const vs = stripComments(fs.readFileSync(path.join(SRC, 'provision/vsphere.js'), 'utf8'));
  assert.match(vs, /retrieveManyObjectProps\('Task', safe,/);
  assert.doesNotMatch(vs, /CancelTask/);
  const jsrc = stripComments(fs.readFileSync(path.join(SRC, 'provision/jobs.js'), 'utf8'));
  assert.match(jsrc, /await runLiveVms\(prov, source, job\.vms,/);
  assert.doesNotMatch(jsrc, /trackTask\(|cloneAndTrack/);
});

test('74 ② 재기동 · 멈춘 추적 — submitted 를 영원히 두지 않는다(재기동 = 결과 모름 · 시한 + 여유 뒤 정리)', async () => {
  const J = await import('../src/provision/jobs.js');
  const job = { id: 'j', status: 'running', vms: [{ name: 'a', status: 'submitted' }, { name: 'b', status: 'running' }, { name: 'c', status: 'queued' }, { name: 'd', status: 'done' }] };
  J.settleAfterRestart(job);
  assert.deepEqual(job.vms.map((v) => v.status), ['unknown', 'unknown', 'error', 'done']);
  assert.equal(job.vms[0].error, J.RESTART_UNKNOWN); assert.match(J.RESTART_UNKNOWN, /재기동으로 추적 중단/);
  assert.equal(job.status, 'completed_with_errors');
  // 같은 프로세스에서 고리가 사라진 채 남은 submitted — 시한 + 여유 뒤 정리, 그 전은 그대로
  const j2 = { id: 'k', status: 'running', vms: [{ name: 'a', status: 'submitted', submittedAt: NOW }, { name: 'b', status: 'done' }] };
  assert.equal(J.sweepStale(j2, NOW + J.TASK_TIMEOUT_MS), false);
  assert.equal(J.sweepStale(j2, NOW + J.TASK_TIMEOUT_MS + 10 * 60_000), true);
  assert.equal(j2.vms[0].status, 'unknown'); assert.equal(j2.status, 'completed_with_unknown');
  // 실제 재기동 — 남겨 둔 파일을 새 프로세스가 읽어 결과 모름으로 보인다
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3jobs-'));
  fs.writeFileSync(path.join(dir, 'provision-runs.json'), JSON.stringify({ jobs: [{ id: 'job-1', createdAt: new Date(NOW).toISOString(), createdBy: 'admin', vcenterId: 'vc-a', sourceId: 's', sourceName: 'tmpl', live: true, status: 'running', placement: {},
    vms: [{ name: 'a', status: 'submitted', task: 'task-1', submittedAt: NOW }, { name: 'b', status: 'done', task: 'task-2' }] }] }));
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e',
    `const J = await import(${JSON.stringify(path.join(SRC, 'provision/jobs.js'))}); const j = J.getJob('job-1', null, null); console.log('@@' + JSON.stringify({ status: j.status, vms: j.vms.map((v) => [v.status, v.error]) }));`],
  { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.equal(out.status, 'completed_with_unknown');
  assert.deepEqual(out.vms.map((x) => x[0]), ['unknown', 'done']);
  assert.match(out.vms[0][1], /재기동으로 추적 중단/);
});

test('74 ③ 연속 IP 가 마스크 · 게이트웨이 서브넷 밖이거나 네트워크 · 브로드캐스트 주소를 포함하면 미리보기 사유', async () => {
  const { expandSpec } = await import('../src/provision/spec.js');
  const spec = (ipStart, count, extra = {}) => ({ namePattern: 'v{n}', count, guest: { ipMode: 'static', ipStart, subnetMask: '255.255.255.0', gateway: '10.0.0.1', ...extra } });
  assert.deepEqual(expandSpec(spec('10.0.0.10', 5)).errors, []);
  assert.match(expandSpec(spec('10.0.0.250', 10)).errors.join(), /10\.0\.0\.250 ~ 10\.0\.1\.3 이\(가\) 서브넷 10\.0\.0\.0\/24\(게이트웨이 10\.0\.0\.1\) 밖으로/);
  assert.match(expandSpec(spec('10.0.0.250', 6)).errors.join(), /브로드캐스트 주소/);
  assert.match(expandSpec(spec('10.0.1.10', 3)).errors.join(), /밖으로/, '게이트웨이와 다른 서브넷');
  assert.deepEqual(expandSpec(spec('10.0.0.250', 10, { subnetMask: '' })).errors, [], '마스크가 없으면 이 검사 밖');
  assert.deepEqual(expandSpec(spec('10.0.0.10', 3, { subnetMask: '255.255.255.255' })).errors, [], '/32 는 판정하지 않는다');
  const nic2 = { ...spec('10.0.0.10', 5), guest: { ...spec('10.0.0.10', 5).guest, extraNics: [{ ipMode: 'static', ipStart: '192.168.1.253', subnetMask: '255.255.255.0', gateway: '192.168.1.1' }] } };
  assert.match(expandSpec(nic2).errors.join(), /NIC2 연속 IP 192\.168\.1\.253 ~ 192\.168\.2\.1/);
});

test('74 ④ VM 사양 변경 — 같은 VM 의 두 번째 요청은 409 · 끝나면 해제 · 시한 뒤 새 요청 · 옛 해제가 새 잠금을 풀지 않는다', async () => {
  const { tryLockVmReconfig, reconfigLocksForTest, RECONFIG_LOCK_TTL_MS } = await import('../src/provision/reconfig.js');
  reconfigLocksForTest().clear();
  const u1 = tryLockVmReconfig('vc:vm-1', { now: NOW });
  assert.equal(typeof u1, 'function');
  assert.equal(tryLockVmReconfig('vc:vm-1', { now: NOW + 1000 }), null, '진행 중이면 거절');
  assert.equal(typeof tryLockVmReconfig('vc:vm-2', { now: NOW }), 'function', '다른 VM 은 따로');
  u1();
  const u2 = tryLockVmReconfig('vc:vm-1', { now: NOW + 2000 });
  assert.equal(typeof u2, 'function', '끝나면 해제');
  const u3 = tryLockVmReconfig('vc:vm-1', { now: NOW + 2000 + RECONFIG_LOCK_TTL_MS });
  assert.equal(typeof u3, 'function', '멈춘 요청의 잠금은 시한 뒤 새 요청이 가져간다');
  u2();   // 늦게 끝난 옛 요청
  assert.equal(tryLockVmReconfig('vc:vm-1', { now: NOW + 3000 + RECONFIG_LOCK_TTL_MS }), null, '옛 해제가 새 잠금을 풀지 않는다');
  u3();
  // 라우트 — 잠금을 잡고 reconfigVm 을 부르며 finally 에서 푼다 · 진행 중이면 409
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/admin/collectorsDc.js'), 'utf8'));
  const body = src.slice(src.indexOf("'/vm/:id/reconfig'"), src.indexOf("'/collectors/pull'"));
  assert.match(body, /const unlock = tryLockVmReconfig\(t\.vm\.id\);\s*if \(!unlock\) return res\.status\(409\)/);
  assert.ok(body.indexOf('tryLockVmReconfig') < body.indexOf('await reconfigVm('), '잠금이 실행보다 먼저');
  assert.match(body, /\} finally \{ unlock\(\); \}/);
});
