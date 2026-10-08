/**
 * v2.727 감사 그룹 3b — 서버 데이터 정직성 C-02~C-06 + E-12 회귀.
 *  C-02 라이선스 <used>/<total> 없음 → null(0 아님) · 코어 라이선스 비교는 하나라도 모르면 합을 내지 않는다
 *  E-12 GPU memorySizeInKB 없음 → memGB null(0 아님)
 *  C-03 날짜·슬롯 경계는 util/dayKey.js(기본 540 에서 예전 KST 상수와 바이트 단위로 같다) + 리터럴 스윕은 arch2582
 *  C-04 비용 배분 — thin 여유 모름(provisionedPartial) · 할당 일부 모름(partialCost · partialVms)
 *  C-05 vSAN 멤버 0개 + enabled → null(판정 보류) · 분할 판정은 멤버 수를 아는 호스트끼리만
 *  C-06 전력 합산 — 시각 없음은 stale 이 아니라 noTime
 * ⚠ 보고된 0 은 값이다 — 각 항목이 '0 보고' 와 '없음' 을 함께 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web/src');
const H = 3_600_000;
const DAY = 24 * H;

/* ── C-02 ──────────────────────────────────────────────────────────────────── */
test('C-02 라이선스 파서 — <used>/<total> 태그가 없으면 null, 0 은 0', async () => {
  const { VimSoapClient } = await import('../src/vcenter/soapClient.js');
  const lic = (inner) => `<LicenseManagerLicenseInfo>${inner}</LicenseManagerLicenseInfo>`;
  const xml = lic('<name>x</name><total>200</total><costUnit>core</costUnit>')   // used 없음
    + lic('<name>y</name><total>0</total><used>0</used><costUnit>core</costUnit>')   // 보고된 0
    + lic('<name>z</name><used>96</used><costUnit>core</costUnit>');   // total 없음
  const fake = { sc: { licenseManager: 'LicenseManager' }, async retrieveObjectProps() { return [{ props: { licenses: xml } }]; } };
  const out = await VimSoapClient.prototype.retrieveLicenses.call(fake);
  assert.equal(out.length, 3);
  assert.equal(out[0].used, null, 'used 태그 없음 → null(0 은 없는 값을 지어낸 것)');
  assert.equal(out[0].total, 200);
  assert.equal(out[1].used, 0, '보고된 0 은 값이다'); assert.equal(out[1].total, 0);
  assert.equal(out[2].used, 96); assert.equal(out[2].total, null);
});

test('C-02 코어 라이선스 비교 — used 를 모르는 라이선스가 하나라도 있으면 보고 합·차이는 null + 개수', async () => {
  const { analyzeCoreLicense } = await import('../src/corelicense/analyze.js');
  const hosts = [{ vcenterId: 'a', name: 'h1', cpuSockets: 2, cpuCores: 64, connectionState: 'CONNECTED' }];
  // 재현(감사 c02_license.mjs): used 없는 코어 라이선스 → 예전엔 reportedCoreUsed 0 · reportedDiff −64
  const r = analyzeCoreLicense({ vcenters: [{ id: 'a', name: 'A', licenses: [{ costUnit: 'core', total: 200, used: null }] }], hosts, datastores: [] });
  const v = r.vcenters[0];
  assert.equal(v.coreLicenses, 1);
  assert.equal(v.reportedCoreUsed, null, '모르는 값을 0 으로 더하지 않는다');
  assert.equal(v.reportedDiff, null, '보고값이 없으면 산정과 비교하지 않는다(거짓 −64 금지)');
  assert.equal(v.reportedUsedUnknown, 1);
  assert.equal(v.reportedCoreTotal, 200); assert.equal(v.reportedTotalUnknown, 0);
  assert.equal(r.totals.reportedUsedUnknown, 1);
  // 둘 중 하나만 모르면 부분 합을 내지 않는다
  const r2 = analyzeCoreLicense({ vcenters: [{ id: 'a', name: 'A', licenses: [{ costUnit: 'core', total: 100, used: 40 }, { costUnit: 'core', total: null, used: undefined }] }], hosts, datastores: [] });
  assert.equal(r2.vcenters[0].reportedCoreUsed, null); assert.equal(r2.vcenters[0].reportedUsedUnknown, 1);
  assert.equal(r2.vcenters[0].reportedCoreTotal, null); assert.equal(r2.vcenters[0].reportedTotalUnknown, 1);
  // 전부 읽었으면 예전 그대로(보고 0 포함)
  const r3 = analyzeCoreLicense({ vcenters: [{ id: 'a', name: 'A', licenses: [{ costUnit: 'core', total: 100, used: 0 }, { costUnit: 'core', total: 100, used: 64 }] }], hosts, datastores: [] });
  assert.equal(r3.vcenters[0].reportedCoreUsed, 64); assert.equal(r3.vcenters[0].reportedDiff, 0); assert.equal(r3.vcenters[0].reportedUsedUnknown, 0);
  // 웹 문구 — '없음' 이 아니라 '일부 미상' 을 말한다(문구 모듈은 순수 JS — 서버 테스트에서 그대로 읽는다)
  const web = fs.readFileSync(path.join(WEB, 'views/corelicense/coreLicenseText.js'), 'utf8');
  assert.match(web, /reportedUsedUnknown > 0/, '웹 reportedText 가 reportedUsedUnknown 을 먼저 본다');
});

/* ── E-12 ──────────────────────────────────────────────────────────────────── */
test('E-12 GPU 파서 — memorySizeInKB 가 없으면 memGB null, 0 은 0', async () => {
  const { parseGpus } = await import('../src/vcenter/soapClient.js');
  const g = (inner) => `<HostGraphicsInfo>${inner}</HostGraphicsInfo>`;
  const xml = g('<deviceName>NVIDIA A40</deviceName><vendorName>NVIDIA</vendorName><graphicsType>sharedDirect</graphicsType><pciId>0000:3b:00.0</pciId>')
    + g('<deviceName>NVIDIA A40</deviceName><vendorName>NVIDIA</vendorName><graphicsType>sharedDirect</graphicsType><memorySizeInKB>0</memorySizeInKB><pciId>0000:3c:00.0</pciId>')
    + g('<deviceName>NVIDIA A40</deviceName><vendorName>NVIDIA</vendorName><graphicsType>sharedDirect</graphicsType><memorySizeInKB>47185920</memorySizeInKB><pciId>0000:3d:00.0</pciId>');
  const out = parseGpus(xml);
  assert.equal(out.length, 3);
  assert.equal(out[0].memGB, null, 'VRAM 을 모르면 0 GB 가 아니라 null');
  assert.equal(out[1].memGB, 0, '보고된 0 은 0');
  assert.equal(out[2].memGB, 45);
});

/* ── C-03 ──────────────────────────────────────────────────────────────────── */
test('C-03 날짜 경계 — dayKey 코어를 쓰고, 기본 오프셋(540)에서 예전 KST 상수 결과와 바이트 단위로 같다', async () => {
  const dk = await import('../src/util/dayKey.js');
  assert.equal(dk.DAY_OFFSET_MIN, 540, '이 테스트는 기본 오프셋 전제 — env PORTAL_TZ_OFFSET_MIN 을 세우고 돌리지 말 것');
  const KST = 9 * H;
  const now = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;
  // vmchanges — 이동 일별 칸
  const vc = await import('../src/vmchanges/analyze.js');
  const rows = [0, 1, 2, 5].map((d, i) => ({ vcenterId: 'vc', entity: `vm${i}`, ts: now - d * DAY - 123_456, type: 'DrsVmMigratedEvent', detail: null }));
  const mv = vc.analyzeMoves(rows, { days: 7, now });
  const today = Math.floor((now + KST) / DAY);
  const expectSeries = [];
  for (let d = today - 6; d <= today; d++) expectSeries.push(d * DAY - KST);
  assert.deepEqual(mv.series.map((s) => s.day), expectSeries, '예전 `Math.floor((ts + 9h)/DAY)` · `d*DAY − 9h` 와 같은 값');
  assert.equal(mv.series.reduce((a, s) => a + s.moves, 0), 4);
  // vmlife — 생성·삭제 일별 칸
  const vl = await import('../src/vmlife/analyze.js');
  const life = vl.analyzeLifecycle([{ vcenterId: 'vc', entity: 'n', ts: now - 2 * DAY, type: 'VmCreatedEvent', detail: null }], { days: 7, now });
  assert.deepEqual(life.series.map((s) => s.day), expectSeries);
  // bmstor — 12시간 슬롯
  const bh = await import('../src/bmstor/history.js');
  for (const ts of [now, now - 7 * H, now + 11 * H + 59 * 60_000, Date.UTC(2026, 8, 28, 15, 0, 0)]) {
    assert.equal(bh.slotOf(ts, 12), Math.floor((ts + KST) / (12 * H)), `slotOf(${ts})`);
    assert.equal(bh.slotStart(bh.slotOf(ts, 12), 12), bh.slotOf(ts, 12) * 12 * H - KST);
  }
  // 소스 — 세 모듈이 dayKey 를 import 하고 KST 리터럴이 없다
  for (const f of ['vmchanges/analyze.js', 'vmlife/analyze.js', 'bmstor/history.js']) {
    const s = fs.readFileSync(path.resolve(HERE, '../src', f), 'utf8');
    assert.match(s, /from '\.\.\/util\/dayKey\.js'/, `${f} 가 dayKey 를 쓴다`);
    assert.ok(!/\b9\s*\*\s*(3_?600_?000|HOUR\b)/.test(s), `${f} 에 KST 리터럴이 없다`);
  }
});

/* ── C-04 ──────────────────────────────────────────────────────────────────── */
test('C-04 비용 배분 — thin 여유 모름은 provisionedPartial, 할당 일부 모름은 partialCost · 그룹 partialVms · 노트', async () => {
  const { vmAllocation, costOf, analyzeCost } = await import('../src/cost/analyze.js');
  const s = { offPolicy: 'full', storageBasis: 'provisioned', vcpu: 10, ramGB: 1, storageGB: 1, currency: 'KRW' };
  // 재현(감사 c03_cost.mjs): uncommitted null + provisioned → 사용량만으로 '할당' 을 만들며 표지 없음
  const a = vmAllocation({ powerState: 'POWERED_ON', cpuCount: 2, memMB: 2048, storageGB: 100, uncommittedGB: null }, s);
  assert.equal(a.storageGB, 100); assert.equal(a.provisionedPartial, true); assert.equal(a.partialCost, true);
  // uncommitted 를 알면(0 포함) 표지 없음 — 보고된 0 은 값
  const b = vmAllocation({ powerState: 'POWERED_ON', cpuCount: 2, memMB: 2048, storageGB: 100, uncommittedGB: 0 }, s);
  assert.equal(b.storageGB, 100); assert.equal('provisionedPartial' in b, false); assert.equal('partialCost' in b, false);
  // used 기준이면 uncommitted 를 몰라도 부분이 아니다
  const c = vmAllocation({ powerState: 'POWERED_ON', cpuCount: 2, memMB: 2048, storageGB: 100, uncommittedGB: null }, { ...s, storageBasis: 'used' });
  assert.equal('provisionedPartial' in c, false); assert.equal('partialCost' in c, false);
  // vcpu 모름 → partialCost(비용 합은 아는 항목만)
  const d = vmAllocation({ powerState: 'POWERED_ON', cpuCount: null, memMB: 2048, storageGB: 100 }, { ...s, storageBasis: 'used' });
  assert.equal(d.vcpu, null); assert.equal(d.partialCost, true); assert.equal(costOf(d, s).cpu, null); assert.equal(costOf(d, s).total, 102);
  // 꺼진 VM 의 storage 정책 0 은 값이다 — 부분이 아니다
  const e = vmAllocation({ powerState: 'POWERED_OFF', cpuCount: 2, memMB: 2048, storageGB: 10, uncommittedGB: 0 }, { ...s, offPolicy: 'storage' });
  assert.equal(e.vcpu, 0); assert.equal('partialCost' in e, false);
  const mk = (name, extra) => ({ id: `vc1:${name}`, name, vcenterId: 'vc1', cluster: 'C1', powerState: 'POWERED_ON', ...extra });
  const r = analyzeCost({ vcenters: [{ id: 'vc1', name: 'VC1' }], vms: [
    mk('ok', { cpuCount: 2, memMB: 2048, storageGB: 100, uncommittedGB: 50 }),
    mk('thin', { cpuCount: 2, memMB: 2048, storageGB: 100, uncommittedGB: null }),
    mk('cpu', { cpuCount: null, memMB: 2048, storageGB: 100, uncommittedGB: 0 }),
  ] }, s);
  assert.equal(r.notes.provisionedPartial, 1); assert.equal(r.notes.partialVms, 2); assert.equal(r.notes.cpuUnknown, 1);
  assert.equal(r.groups[0].partialVms, 2); assert.equal(r.groups[0].vms, 3);
  const byName = Object.fromEntries(r.vms.map((v) => [v.name, v]));
  assert.equal(byName.thin.provisionedPartial, true); assert.equal(byName.thin.partialCost, true);
  assert.equal(byName.cpu.partialCost, true); assert.equal('provisionedPartial' in byName.cpu, false);
  assert.equal('partialCost' in byName.ok, false);
  const web = fs.readFileSync(path.join(WEB, 'views/bizreport/costText.js'), 'utf8');
  assert.match(web, /n\.provisionedPartial/); assert.match(web, /n\.partialVms/);
});

/* ── C-05 ──────────────────────────────────────────────────────────────────── */
test('C-05 vSAN — enabled + membershipList 0개는 members null(판정 보류) · 꺼진 호스트의 0 은 값 · 분할 판정은 아는 호스트끼리', async () => {
  const { parseVsan, sanitizeHostCfg } = await import('../src/hostcfg/parse.js');
  const { analyzeVsan } = await import('../src/dscfg/analyze.js');
  assert.deepEqual(parseVsan('true', '<diskIssues><diskId>d</diskId></diskIssues>'), { enabled: true, diskIssues: 1, members: null }, '켜져 있는데 멤버 0 → 못 읽은 것');
  assert.deepEqual(parseVsan('true', ''), { enabled: true, diskIssues: 0, members: null });
  assert.deepEqual(parseVsan('false', ''), { enabled: false, diskIssues: 0, members: 0 }, '꺼진 호스트의 0 은 값(멤버 아님)');
  assert.deepEqual(parseVsan('true', '<membershipList><nodeUuid>a</nodeUuid></membershipList><membershipList><nodeUuid>b</nodeUuid></membershipList>'), { enabled: true, diskIssues: 0, members: 2 });
  assert.equal(sanitizeHostCfg({ vsan: { enabled: true, diskIssues: 0, members: null } }).vsan.members, null, '엣지 정제가 null 을 0 으로 바꾸지 않는다');
  const h = (id, cluster, members) => ({ id, name: id, vcenterId: 'v', cluster, connectionState: 'CONNECTED', hcfg: { vsan: { enabled: true, diskIssues: 0, members } } });
  // ① 전부 멤버 0개(null) — 재현: 예전엔 minMembers 0 < hosts 2 → vsan-partition(crit)
  const r1 = analyzeVsan([h('a', 'C', null), h('b', 'C', null)], []);
  const c1 = r1.clusters[0];
  assert.deepEqual(c1.findings, [], '멤버 수를 모르면 분할이라 말하지 않는다');
  assert.equal(c1.minMembers, null); assert.equal(c1.membersUnknown, 2); assert.equal(c1.hosts, 2);
  // ② 3대 중 1대 모름, 2대는 멤버 2 → 아는 호스트 2 와 비교 → 분할 아님
  const r2 = analyzeVsan([h('a', 'C', 2), h('b', 'C', 2), h('c', 'C', null)], []);
  assert.deepEqual(r2.clusters[0].findings, []); assert.equal(r2.clusters[0].membersUnknown, 1);
  // ③ 3대 중 1대 모름, 2대는 멤버 1 → 아는 호스트 2 보다 작다 → 분할(개수 밝힘)
  const r3 = analyzeVsan([h('a', 'C', 1), h('b', 'C', 1), h('c', 'C', null)], []);
  assert.equal(r3.clusters[0].findings.length, 1);
  assert.deepEqual(r3.clusters[0].findings[0].facts, { members: 1, hosts: 2, membersUnknown: 1 });
  // ④ 전부 아는 경우는 예전 그대로(facts 에 membersUnknown 없음)
  const r4 = analyzeVsan([h('a', 'C', 2), h('b', 'C', 2), h('c', 'C', 3)], []);
  assert.deepEqual(r4.clusters[0].findings[0].facts, { members: 2, hosts: 3 });
});

/* ── C-06 ──────────────────────────────────────────────────────────────────── */
test('C-06 전력 합산 — 시각이 둘 다 없는 장비는 stale 이 아니라 noTime(합계 제외는 같다) · 웹 사유 문구 1:1', async () => {
  const { buildPowerTotal } = await import('../src/power/total.js');
  const NOW = 1_800_000_000_000;
  const psu = (w) => ({ kind: 'psu', state: 'ok', power: { inW: w } });
  const r = buildPowerTotal({
    now: NOW,
    network: [
      { cvpId: 'c', key: 'n1', partsList: [psu(100)], partsAt: null, collectedAt: null },           // 시각 없음
      { cvpId: 'c', key: 'n2', partsList: [psu(100)], partsAt: NOW - 7 * H },                     // 오래됨
      { cvpId: 'c', key: 'n3', partsList: [psu(100)], partsAt: NOW - 60_000 },                    // 정상
      { cvpId: 'c', key: 'n4', partsList: [] },                                                   // 못 읽음
    ],
    storage: [
      { id: 's1', type: 'powerstore', snap: { ok: true, extra: { power: { watts: 500, source: 'PowerStore' } } } },                 // 시각 없음(at·collectedAt 둘 다)
      { id: 's2', type: 'powerstore', snap: { ok: true, collectedAt: NOW - 7 * H, extra: { power: { watts: 500 } } } },           // 오래됨
      { id: 's3', type: 'powerstore', snap: { ok: true, collectedAt: NOW - 60_000, extra: { power: { watts: 500 } } } },           // 정상
    ],
  });
  assert.equal(r.network.noTime, 1); assert.equal(r.network.stale, 1); assert.equal(r.network.unread, 1); assert.equal(r.network.measured, 1);
  assert.equal(r.network.watts, 100, '시각 없는 값은 합계에 넣지 않는다');
  assert.equal(r.storage.noTime, 1); assert.equal(r.storage.stale, 1); assert.equal(r.storage.measured, 1); assert.equal(r.storage.watts, 500);
  const i1 = r.storage.issues.find((x) => x.id === 's1'); assert.equal(i1.state, 'no-time'); assert.equal(i1.reason, 'no-time'); assert.equal(i1.ts, null);
  const i2 = r.storage.issues.find((x) => x.id === 's2'); assert.equal(i2.reason, 'stale');
  assert.equal(r.totalWatts, 600);
  const web = fs.readFileSync(path.join(WEB, 'views/overviewCardsText.js'), 'utf8');
  assert.match(web, /'no-time':\s*'/, '웹 STORAGE_POWER_REASON 에 no-time 문구가 있다(없으면 화면이 코드를 그대로 보인다)');
  assert.match(web, /x\.noTime/, 'powerCatNote 가 noTime 을 말한다');
});
