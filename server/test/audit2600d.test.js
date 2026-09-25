/**
 * v2.600 감사 수정 그룹 d — 수집기·파서(COL-2600-01~10 · SEC2600-02 · LO2600-07).
 *
 * 전부 실제 함수를 호출해 동작으로 본다. REST 수집기 두 건(PowerMax·XtremIO)은 전역 fetch 를 가짜로 바꿔 collect()
 * 를 끝까지 돌린다 — 정규화만 보면 '상세 조회에 실패한 어레이·클러스터' 가 raw 에 들어오지 않는 경로를 못 잡는다.
 * 픽스처의 식별자는 전부 합성이다(v2.513 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function withFetch(route, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => route(new URL(String(url)));
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('COL-2600-01: PowerMax — 상세·용량을 못 읽은 어레이는 poolsUnreadable 로 세고 부분 합은 적재하지 않는다', async () => {
  const { collect, normalizePowermax } = await import('../src/storage/collectors/powermax.js');
  const { capacityPointEligible } = await import('../src/storage/db.js');
  const dev = { id: 'pm-d', type: 'powermax', name: 'PM', host: 'pm.example.test', username: 'u', password: 'p' };
  // ① 어레이 B 의 상세 조회(②)가 503 — 예전에는 raw.arrays 에 없어 아무 데서도 세지 않았다.
  const snap = await withFetch((u) => {
    const p = u.pathname;
    if (p === '/univmax/restapi/version') return json(200, { version: 'V9.2.1.6' });
    if (/\/system\/symmetrix$/.test(p)) return json(200, { symmetrixId: ['SYNTHA', 'SYNTHB'] });
    if (/\/system\/symmetrix\/SYNTHA$/.test(p)) return json(200, { symmetrixId: 'SYNTHA', local: true, model: 'PowerMax_2000' });
    if (/\/system\/symmetrix\/SYNTHB$/.test(p)) return json(503, { message: 'busy' });
    if (/\/sloprovisioning\/symmetrix\/SYNTHA$/.test(p)) return json(200, { system_capacity: { usable_total_tb: 100, usable_used_tb: 40 } });
    return json(404, { message: 'nf' });
  }, () => collect(dev));
  assert.equal(snap.capacity.totalBytes, 100e12);
  assert.equal(snap.extra.poolsUnreadable, 1, '상세 조회에 실패한 어레이가 개수에서 빠졌다');
  assert.deepEqual(capacityPointEligible(snap), { ok: false, reason: 'partial-pools' });
  // ② 목록·상세는 읽었는데 용량(caps)이 없는 어레이.
  const s2 = normalizePowermax(dev, {
    arrays: [{ symmetrixId: 'SYNTHA', local: true }, { symmetrixId: 'SYNTHB', local: true }],
    caps: { SYNTHA: { usable_total_tb: 100, usable_used_tb: 40 } },
  });
  assert.equal(s2.extra.poolsUnreadable, 1);
  assert.equal(capacityPointEligible(s2).reason, 'partial-pools');
  // ③ 전부 읽었으면 적재 대상 그대로.
  const s3 = normalizePowermax(dev, { arrays: [{ symmetrixId: 'SYNTHA', local: true }], caps: { SYNTHA: { usable_total_tb: 100, usable_used_tb: 40 } } });
  assert.equal(s3.extra.poolsUnreadable, undefined);
  assert.equal(capacityPointEligible(s3).ok, true);
});

test('COL-2600-02: XtremIO REST — 상세 조회에 실패한 클러스터를 세고 적재를 막는다', async () => {
  const { collect } = await import('../src/storage/collectors/xtremio.js');
  const { capacityPointEligible } = await import('../src/storage/db.js');
  const dev = { id: 'xt-d', type: 'xtremio', name: 'XT', host: 'xms.example.test', username: 'u', password: 'p' };
  const snap = await withFetch((u) => {
    const p = u.pathname; const n = u.searchParams.get('name');
    if (p === '/api/json/v3/types/clusters' && !n) return json(200, { clusters: [{ name: 'c1' }, { name: 'c2' }] });
    if (p === '/api/json/v3/types/clusters' && n === 'c1') return json(200, { content: { name: 'c1', 'ud-ssd-space': 1e9, 'ud-ssd-space-in-use': 5e8 } });
    if (n === 'c2') return json(500, { message: 'boom' });
    return json(404, { message: 'nf' });
  }, () => collect(dev));
  assert.equal(snap.capacity.totalBytes, 1e9 * 1024);
  assert.equal(snap.extra.poolsUnreadable, 1, '실패한 클러스터가 합계에서 조용히 빠졌다');
  assert.ok(snap.pools.some((p) => p.name === 'c2' && p.totalBytes == null && p.capacityCounted === false));
  assert.equal(capacityPointEligible(snap).reason, 'partial-pools');
});

test('COL-2600-03: XtremIO SSH — 전체 용량을 못 읽은 클러스터를 세고 적재를 막는다', async () => {
  const { normalizeXtremioSsh } = await import('../src/storage/collectors/xtremioSsh.js');
  const { capacityPointEligible } = await import('../src/storage/db.js');
  const info = 'Name      Physical-Space   Space-In-Use\n'
    + '--------  ---------------  ------------\n'
    + 'c1        10T              4T\n'
    + 'c2        N/A              1T\n';
  const snap = normalizeXtremioSsh({ id: 'x', name: 'x', type: 'xtremio' }, { clusters: 'Name  Index\n----  -----\nc1    1\n', clustersInfo: info });
  assert.equal(snap.capacity.totalBytes, 10 * 1024 ** 4);
  assert.equal(snap.extra.poolsUnreadable, 1);
  assert.equal(snap.pools.find((p) => p.name === 'c2')?.capacityCounted, false);
  assert.equal(capacityPointEligible(snap).reason, 'partial-pools');
});

test('COL-2600-04: xmcli 표의 가운데 빈 칸이 뒤 열을 당겨 끊긴 컨트롤러를 숨기지 않는다', async () => {
  const { parseTable, normalizeXtremioSsh } = await import('../src/storage/collectors/xtremioSsh.js');
  const t = 'Name     Index  IP-Address  State\n-------  -----  ----------  -----\nSC1      1      10.0.0.1    healthy\nSC2      2                  disconnected';
  const rows = parseTable(t);
  assert.equal(rows[1].State, 'disconnected');
  assert.equal(rows[1]['IP-Address'], '');
  assert.equal(rows[0].State, 'healthy');              // 칸 수가 맞는 행은 예전 방식 그대로
  const snap = normalizeXtremioSsh({ id: 'x', name: 'x', type: 'xtremio' }, { clusters: '', controllers: t });
  assert.equal(snap.nodes.unhealthy, 1, '끊긴 컨트롤러가 비정상으로 세지지 않았다');
});

test('COL-2600-05: Isilon REST — status 가 health 없는 객체면 비정상이 아니라 미상', async () => {
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const dev = { id: 'i', name: 'i', type: 'isilon' };
  const s = normalizeIsilon(dev, { nodes: { nodes: [{ lnn: 1, status: { batterystatus: {} } }, { lnn: 2, status: {} }] } });
  assert.equal(s.nodes.unhealthy, 0);
  assert.deepEqual(s.nodes.list.map((n) => n.health), ['unknown', 'unknown']);
  const s2 = normalizeIsilon(dev, { nodes: { nodes: [{ lnn: 1, status: { health: 'OK' } }, { lnn: 2, status: 'down' }] } });
  assert.equal(s2.nodes.unhealthy, 1);
});

test('COL-2600-06: NSX — 목록 조회 실패는 0 이 아니라 표식이 붙는다', async () => {
  const { failedList, listFailures, firewallSummary } = await import('../src/nsx/client.js');
  const f = failedList(new Error('HTTP 503 page 2'));
  assert.deepEqual(f.results, []);
  assert.equal(f.failed, true);
  assert.match(f.error, /503/);
  const lf = listFailures([['segments', f], ['groups', { results: [1] }]]);
  assert.deepEqual(lf.listsFailed, ['segments']);
  assert.match(lf.listFailReasons.segments, /503/);
  const fw = firewallSummary({ pols: f, dfw: [], ruleSets: [] });
  assert.equal(fw.policies, null);
  assert.equal(fw.failed, true);
  // collectFromNsx 가 목록 6종의 실패를 이 표식으로 받는지(주석 제거 후 소스) — 조용한 빈 목록 폴백이 돌아오면 실패.
  const { readFileSync } = await import('node:fs');
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(readFileSync(new URL('../src/nsx/client.js', import.meta.url), 'utf8'));
  for (const m of ['transportNodes', 'tier0s', 'tier1s', 'segments', 'securityPolicies', 'groups']) {
    assert.match(src, new RegExp(`client\\.${m}\\(\\)\\.catch\\(failedList\\)`), `${m} 실패가 표식 없이 빈 목록이 된다`);
  }
});

test('COL-2600-08: nvidia-smi 의 GPU 오류 줄을 세어 밝힌다', async () => {
  const { parseNvidiaSmiCsv } = await import('../src/gpu/guestops.js');
  const r = parseNvidiaSmiCsv('35, 10, 4000, 81920, Disabled\nUnable to determine the device handle for GPU0000:3B:00.0: Unknown Error\n40, 12, 5000, 81920, Disabled');
  assert.equal(r.count, 2);
  assert.equal(r.gpuErrors, 1);
  assert.match(r.gpuErrorLines[0], /Unable to determine/);
  assert.equal(parseNvidiaSmiCsv('35, 10, 4000, 81920, Disabled').gpuErrors, undefined);
});

test('COL-2600-09: Isilon 경보 — total 이 없으면 목록 길이는 하한이고 v1 events 키도 읽는다', async () => {
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const dev = { id: 'i', name: 'i', type: 'isilon' };
  const a = normalizeIsilon(dev, { events: { events: [{}] } });
  assert.equal(a.alerts.unresolved, 1);
  assert.equal(a.extra.alertsLowerBound, true);
  const b = normalizeIsilon(dev, { events: { total: 7, eventgroups: [{}] } });
  assert.equal(b.alerts.unresolved, 7);
  assert.equal(b.extra.alertsLowerBound, undefined);
  const c = normalizeIsilon(dev, { events: { eventgroups: [] } });
  assert.equal(c.alerts.unresolved, 0);
  assert.equal(c.extra.alertsLowerBound, undefined);
});

test('COL-2600-10: porterrshow — crc g_eof 없는 머리글은 열을 밀지 않고, 머리글 없는 짧은 행은 형식 미인식', async () => {
  const { parsePortErrShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const old = `          frames      enc    crc    too   too    bad   enc   disc   link   loss   loss   frjt   fbsy
       tx     rx      in    err    shrt  long   eof   out    c3    fail   sync   sig
  0:   100    200     1      2      3     4      5     6      7     8      9      10     11     12
`;
  const r = parsePortErrShow(old);
  assert.equal(r[0].crc_err, 2);
  assert.equal(r[0].bad_eof, 5);
  assert.equal(r[0].enc_out, 6, 'enc_out 이 한 칸 밀려 읽혔다');
  assert.equal(r[0].fbsy, 12);
  assert.equal(r[0].crc_g_eof, undefined);
  const bare = parsePortErrShow('  0:   100  200  1  2  3  4  5  6  7  8  9  10  11  12\n');
  assert.equal(bare[0]._format, 'unrecognized');
  assert.equal(bare[0].enc_out, undefined);
});

test('SEC2600-02: toBytes 는 단위 없는 긴 숫자열에서도 선형이다(150ms 안)', async () => {
  const { toBytes, toBytesOrNull } = await import('../src/storage/collectors/cliSsh.js');
  const { normalizeXtremioSsh } = await import('../src/storage/collectors/xtremioSsh.js');
  for (const big of ['1'.repeat(60000) + 'x', '1.'.repeat(30000) + 'x', '1'.repeat(300000), `${'9'.repeat(40000)} ${'1'.repeat(40000)}`]) {
    const t0 = performance.now();
    toBytes(big); toBytesOrNull(big);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `toBytes ${big.length}자 ${ms.toFixed(0)}ms`);   // v2.613 TESTDOC2613-02: 절대 상한은 1초(회귀와 확실히 갈리는 값 — v2.603) · 입력은 옛 O(n²) 구현이 수 초가 되는 크기
  }
  const t0 = performance.now();
  normalizeXtremioSsh({ id: 'x', name: 'x', type: 'xtremio' }, { clustersInfo: `Name      Physical-Space   Space-In-Use\n---\nc1        ${'1'.repeat(60000)}x   5T\n` });
  assert.ok(performance.now() - t0 < 1000);
  // 정상 표기는 그대로.
  assert.equal(toBytes('12094627905536 (11.0T)'), 12094627905536);
  assert.equal(toBytes('11.0T'), Math.round(11 * 1024 ** 4));
  assert.equal(toBytes('Size: 11.0T'), Math.round(11 * 1024 ** 4));
  assert.equal(toBytes('11.0T (12094627905536)'), Math.round(11 * 1024 ** 4));
  assert.equal(toBytes('.5 GB'), Math.round(0.5 * 1024 ** 3));
  assert.equal(toBytesOrNull('1'.repeat(300)), null);
  assert.equal(toBytesOrNull('0'), 0);
});

test('LO2600-07: freeSpace 가 없는 파티션은 사용·여유 null + freeUnknown, 소비처는 할당·사용 양쪽에서 빼고 센다', async () => {
  const { parseGuestDisks } = await import('../src/vcenter/soapParse.js');
  const [p] = parseGuestDisks('<GuestDiskInfo><diskPath>C:</diskPath><capacity>107374182400</capacity></GuestDiskInfo>');
  assert.equal(p.freeUnknown, true);
  assert.equal(p.usedGB, null);           // 예전: 100(지어낸 '가득 참')
  assert.equal(p.freeGB, null);
  assert.equal(p.capacityGB, 100);
  const [q] = parseGuestDisks('<GuestDiskInfo><diskPath>C:</diskPath><capacity>107374182400</capacity><freeSpace>53687091200</freeSpace></GuestDiskInfo>');
  assert.equal(q.freeUnknown, undefined);
  assert.equal(q.usedGB, 50);
  // 소비처 ① vmSummary — 모르는 파티션을 할당에서도 빼야 '여유 100GB(회수 후보)' 가 생기지 않는다.
  const { vmSummary, sanitizeGuestDiskVms, rankReclaim } = await import('../src/guestdisk/analyze.js');
  const s = vmSummary([p, q]);
  assert.deepEqual([s.allocGB, s.usedGB, s.freeGB, s.partsUnknown, s.partCount], [100, 50, 50, 1, 2]);
  assert.equal(vmSummary([p]).freeGB, 0);
  assert.equal(vmSummary([p]).ratioPct, null);
  assert.equal(rankReclaim([{ vmId: 'v', ...vmSummary([p]) }], { minReclaimGB: 5 }).vmCount, 0, '모르는 파티션이 회수 후보가 됐다');
  // 소비처 ② sanitize — 사용량 null 파티션을 0 으로 저장하지 않는다.
  const [vm] = sanitizeGuestDiskVms([{ vmId: 'v1', allocGB: 50, usedGB: 10, parts: [{ path: 'C:', capGB: 100, usedGB: null }, { path: 'D:', capGB: 50, usedGB: 10 }] }]);
  assert.deepEqual(vm.parts.map((x) => x.path), ['D:']);
  assert.equal(vm.partsUnknown, 1);
  // 소비처 ③ vmExport — 사용·여유 합에서 빼고 미보고 개수를 싣는다.
  const { VM_EXPORT_COLUMNS, guestKnownSum } = await import('../src/vcenter/vmExport.js');
  const col = (k) => VM_EXPORT_COLUMNS.find((c) => c.key === k).get({}, { guest: [p, q] });
  assert.equal(col('guestCapacityGB'), 200);
  assert.equal(col('guestUsedGB'), 50);
  assert.equal(col('guestFreeGB'), 50);
  assert.equal(col('guestPartsUnknown'), 1);
  assert.match(col('guestParts'), /C: \?\/100GB/);
  assert.equal(guestKnownSum([p], 'usedGB'), '');
});

test('COL-2600-06 후속: NSX 합계 — 실패한 목록은 0 이 아니라 null + 실패 매니저 수', async () => {
  const { scopedNsxRollup } = await import('../src/nsx/scope.js');
  const { merge, rollup } = await import('../src/nsx/store.js');
  const failedPart = {
    manager: { id: 'm1', name: 'M1', status: 'connected', listsFailed: ['segments', 'securityPolicies', 'groups'] },
    gateways: [{ tier: 'T0' }], segments: [], transportNodes: [{ type: 'host' }],
    firewall: { policies: null, rules: null, failed: true }, groups: null,
  };
  const okPart = { manager: { id: 'm2', name: 'M2', status: 'connected' }, gateways: [], segments: [{ type: 'VLAN' }], transportNodes: [], firewall: { policies: 3, rules: 9 }, groups: 2 };
  const snap = rollup(merge([failedPart, okPart], [], 'real'));
  assert.equal(snap.managers[0].segments, null, '매니저 행의 세그먼트 수가 0 으로 남았다');
  assert.equal(snap.managers[0].gateways, 1);
  assert.equal(snap.managers[1].segments, 1);
  const r = snap.rollup;
  assert.equal(r.segments, null);
  assert.equal(r.overlaySegments, null);
  assert.equal(r.dfwPolicies, null);
  assert.equal(r.dfwRules, null);
  assert.equal(r.groups, null);
  assert.equal(r.t0, 1);
  assert.equal(r.hostNodes, 1);
  assert.deepEqual(r.listsFailed, { segments: 1, securityPolicies: 1, groups: 1 });
  // 실패가 없으면 예전과 같은 합계(firewall 없는 구버전 매니저는 0 으로).
  const r2 = scopedNsxRollup({ managers: [okPart.manager && { ...okPart.manager, firewall: okPart.firewall, groups: 2 }, { id: 'old' }], gateways: [], segments: [{ type: 'VLAN' }], transportNodes: [] });
  assert.deepEqual([r2.segments, r2.dfwPolicies, r2.dfwRules, r2.groups, r2.listsFailed], [1, 3, 9, 2, undefined]);
});

test('COL-2600-04 후속: vplexcli ll 표도 가운데 빈 칸이 상태 열을 당기지 않는다', async () => {
  const { parseLl } = await import('../src/storage/collectors/vplexSsh.js');
  const t = 'Name        management-ip  operational-status\n----------  -------------  ------------------\ndirector-1  10.0.0.1       ok\ndirector-2                 lost-communication';
  const rows = parseLl(t);
  assert.equal(rows[1]['operational-status'], 'lost-communication');
  assert.equal(rows[1]['management-ip'], '');
  assert.equal(rows[0]['operational-status'], 'ok');
});

test('LO2600-07 후속: 게스트 디스크 수집 결과·폴러 상태가 제외한 파티션 수를 싣는다(소스 — vCenter 없이 실행 불가)', async () => {
  const { readFileSync } = await import('node:fs');
  const { stripComments } = await import('./_stripComments.js');
  const svc = stripComments(readFileSync(new URL('../src/guestdisk/service.js', import.meta.url), 'utf8'));
  assert.match(svc, /partsUnknown \+= s\.partsUnknown/);
  assert.match(svc, /withGuest: out\.length, \.\.\.\(partsUnknown \? \{ partsUnknown \} : \{\}\)/);
  const pol = stripComments(readFileSync(new URL('../src/guestdisk/poller.js', import.meta.url), 'utf8'));
  assert.match(pol, /partsUnknown \+= r\.partsUnknown/);
  assert.match(pol, /lastResult = \{[^}]*\.\.\.\(partsUnknown \? \{ partsUnknown \} : \{\}\)/);
});
