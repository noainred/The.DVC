/**
 * v2.922(리눅스 성능 3a) — CVP 포트 연동(서버 쪽): 드롭 열 마이그레이션(실제 옛 스키마 DB) · parseCounters 후보(추정 — 못 읽으면 null) ·
 * 표본 → 일 롤업 드롭 합 · 수동 매핑(원자 쓰기 · 손상 보존 · 확정/삭제) · 설명 매칭 후보 · 상태 5종 · 대조 ⑤ 경계(창 불일치면 비교 안 함 · 기준 5%) ·
 * 라우트 범위(다른 법인 CVP 매핑은 범위 계정에 숨김 · 법인 CVP 없음 = no-cvp).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bm2921cvp-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('드롭 열: v2.920 모양의 port 표에 ALTER 로 더한다(기존 행 보존 · 새 열 null · 멱등)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const D = await import('../src/cvp/db.js');
  const c = new DatabaseSync(path.join(DIR, 'old-cvp.db'));
  c.exec(`CREATE TABLE port_latest (agent TEXT, cvp_id TEXT, device_key TEXT, port TEXT, ts INTEGER, in_err INTEGER, out_err INTEGER);
    CREATE TABLE port_sample (agent TEXT, cvp_id TEXT, device_key TEXT, port TEXT, ts INTEGER, in_err INTEGER, out_err INTEGER);
    CREATE TABLE port_daily (agent TEXT, cvp_id TEXT, device_key TEXT, port TEXT, day INTEGER, in_err_sum INTEGER);`);
  c.prepare('INSERT INTO port_latest VALUES (?,?,?,?,?,?,?)').run('', 'c1', 'd1', 'Ethernet1', 1, 3, 0);
  assert.equal(D.addPortDropCols(c), 8);
  assert.equal(D.addPortDropCols(c), 0, '멱등');
  const r = c.prepare('SELECT * FROM port_latest').get();
  assert.equal(r.in_err, 3); assert.equal(r.in_drop, null, '기존 행은 null(드롭 0 이 아니다)');
  const cols = c.prepare('PRAGMA table_info(port_daily)').all().map((x) => x.name);
  assert.ok(['in_drop_sum', 'out_drop_sum', 'in_drop_n', 'out_drop_n'].every((x) => cols.includes(x)));
  c.close();
});

test('parseCounters 드롭 후보(inDiscards — 추정) · 못 읽으면 null · portDelta 드롭 델타 · 리셋은 null', async () => {
  const P = await import('../src/cvp/parse.js');
  const T = 1_000_000; const I = 300_000;
  const prev = { at: T, c: { inOctets: 0, outOctets: 0, inErrors: 0, outErrors: 0, inDiscards: 10, outDiscards: null } };
  const cur = { at: T + I, c: { inOctets: 100, outOctets: 100, inErrors: 0, outErrors: 0, inDiscards: 14, outDiscards: 5 } };
  const d = P.portDelta(prev, cur, 1e9, I);
  assert.equal(d.inDrop, 4); assert.equal(d.outDrop, null, '한쪽을 못 읽었으면 null');
  const reset = P.portDelta(prev, { at: T + I, c: { ...cur.c, inDiscards: 2 } }, 1e9, I);
  assert.equal(reset.inDrop, null);
});

test('saveDevices → port_latest·port_sample·port_daily 에 드롭 · push 행(12칸) 적재 · 구버전 행(10칸)은 드롭 null', async () => {
  const D = await import('../src/cvp/db.js');
  D._resetForTest?.();
  const ts = Date.now() - 60_000;
  const r = await D.saveDevices({ agent: '', cvpId: 'c1', samples: true, devices: [{ key: 'SW1', ts, hostname: 'sw1', ports: [{ name: 'Ethernet1', oper: 'up', admin: 'up', inBps: 1000, outBps: 2000, inErr: 0, outErr: 0, inDrop: 7, outDrop: 0 }] }] });
  assert.ok(r.samples >= 1, JSON.stringify(r));
  const rows = (await D.portLatestRows({ cvpIds: ['c1'] })).rows;
  assert.equal(rows[0].in_drop, 7); assert.equal(rows[0].out_drop, 0); assert.equal(rows[0].hostname, 'sw1');
  assert.equal((await D.portLatestRows({ cvpIds: [] })).rows.length, 0, '빈 목록은 넓히지 않는다');
  await D.importSamples('edge-a', [['c2', 'SW2', 'Ethernet9', ts, 1, 2, 3, 4, 0, 0, 5, 6], ['c2', 'SW2', 'Ethernet9', ts + 300_000, 1, 2, 3, 4, 0, 0]]);
  const s = await D.portSeries({ agent: 'edge-a', cvpId: 'c2', key: 'SW2', port: 'Ethernet9', hours: 1 });
  assert.deepEqual(s.points.map((p) => [p.inDrop, p.outDrop]), [[5, 6], [null, null]]);
  const daily = await D.portSeries({ agent: 'edge-a', cvpId: 'c2', key: 'SW2', port: 'Ethernet9', hours: 24 * 30, rawRetentionDays: 7 });
  assert.equal(daily.points[0].inDrop, 5); assert.equal(daily.points[0].inDropN, 1, '드롭은 읽은 표본만 합(부분 합 수를 밝힌다)');
});

test('수동 매핑 파일: 확정·덮어쓰기·삭제 · 0600 · 손상이면 원본 보존하고 저장 거부(빈 목록으로 덮지 않는다)', async () => {
  const M = await import('../src/bmusage/portMap.js');
  M._resetPortMapForTest();
  assert.equal(M.setPortMapping({ key: 'S', nic: 'eno1', cvpId: 'c1', deviceKey: 'SW1', port: 'Ethernet1' }, { by: 'admin' }).ok, true);
  const r2 = M.setPortMapping({ key: 'S', nic: 'eno1', cvpId: 'c1', deviceKey: 'SW1', port: 'Ethernet2' }, { by: 'admin' });
  assert.equal(r2.replaced.port, 'Ethernet1');
  assert.equal(M.listPortMap({ key: 'S' }).length, 1);
  assert.equal(M.setPortMapping({ key: 'S', nic: 'eno1;rm -rf', cvpId: 'c1', deviceKey: 'x', port: 'y' }).ok, false);
  const file = path.join(DIR, 'bmusage-portmap.json');
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.equal(M.removePortMapping({ key: 'S', nic: 'eno1' }).ok, true);
  assert.equal(M.removePortMapping({ key: 'S', nic: 'eno1' }).notFound, true);
  fs.writeFileSync(file, '{ broken');
  M._resetPortMapForTest();
  assert.equal(M.listPortMap().length, 0);
  assert.ok(M.portMapLoadError());
  assert.equal(M.setPortMapping({ key: 'S', nic: 'eno2', cvpId: 'c1', deviceKey: 'SW1', port: 'Ethernet3' }).ok, false, '손상 상태에서 저장하면 보존 대상을 덮는다');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('bmusage-portmap.json.corrupt') || f.includes('corrupt')), fs.readdirSync(DIR).join(','));
  fs.rmSync(file, { force: true }); M._resetPortMapForTest();
});

test('설명 매칭 후보는 cvp/hostMatch 하나(v2.920 업링크 매칭 재사용): 서비스 태그 별칭 · 리눅스 NIC 이름 · db01 은 db010 에 걸리지 않음', async () => {
  const H = await import('../src/cvp/hostMatch.js');
  const ports = [{ cvpId: 'c1', key: 'SW1', port: 'Et1', desc: 'bm-kr1-db01 eno1' }, { cvpId: 'c1', key: 'SW1', port: 'Et2', desc: 'bm-kr1-db010 eno1' },
    { cvpId: 'c1', key: 'SW1', port: 'Et3', desc: 'SVC ABC1234' }, { cvpId: 'c1', key: 'SW1', port: 'Et4', desc: '' }];
  const r = H.matchUplinks(ports, { name: 'bm-kr1-db01.corp.local', aliases: ['ABC1234'], nics: [{ device: 'eno1' }] });
  assert.deepEqual(r.uplinks.map((x) => [x.port, x.nic, x.basis]), [['Et1', 'eno1', 'desc-nic'], ['Et3', null, 'desc-name']]);
  // 가상화 호스트 호출(aliases 없음)은 예전과 같다
  assert.deepEqual(H.matchUplinks([{ desc: 'esx01 vmnic0' }], { name: 'esx01', nics: [{ device: 'vmnic0' }] }).uplinks.map((x) => x.basis), ['desc-nic']);
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/bmusage/portCompare.js'), 'utf8');
  assert.ok(!/function (candidatesFor|descMatches|matchTokens)/.test(src), '설명 매칭 판정을 두 벌 두지 않는다');
});

test('상태 5종 + 확정: no-cvp · no-mapping · candidate · no-counters · stale · mapped', async () => {
  const P = await import('../src/bmusage/portCompare.js');
  const now = 10_000_000;
  assert.equal(P.portState({ corpHasCvp: false }), 'no-cvp');
  assert.equal(P.portState({ corpHasCvp: true }), 'no-mapping');
  assert.equal(P.portState({ candidates: [{}] }), 'candidate');
  const m = { cvpId: 'c1' };
  assert.equal(P.portState({ mapping: m, port: null }), 'no-counters');
  assert.equal(P.portState({ mapping: m, port: { in_bps: null, out_bps: null, in_err: null, out_err: null, rate_ts: now } , now }), 'no-counters');
  assert.equal(P.portState({ mapping: m, port: { in_bps: 1, rate_ts: now - 3_600_000 }, now, freshMs: 1_800_000 }), 'stale');
  assert.equal(P.portState({ mapping: m, port: { in_bps: 1, rate_ts: now }, now }), 'mapped');
});

test('대조 ⑤ 경계: 창을 맞출 수 없으면 비교하지 않음 · 기준 5% 미만 ok / 이상 mismatch · 포트 오류만 → port-errors · 서버 드롭만 → server-drops · 0 근처 idle · 못 읽은 값은 비교 안 함', async () => {
  const P = await import('../src/bmusage/portCompare.js');
  const S = (o = {}) => ({ txBps: 1_000_000, rxBps: 500_000, at: 1_000_000, spanMs: 300_000, ...o });
  const Pt = (o = {}) => ({ in_bps: 8_000_000, out_bps: 4_000_000, rate_ts: 1_000_000, spanMs: 300_000, ...o });   // bit/s
  assert.equal(P.compareTraffic({ server: S(), port: Pt() }).verdict, 'ok');
  assert.equal(P.compareTraffic({ server: S(), port: Pt({ spanMs: 60_000 }) }).verdict, 'window-mismatch', '창 길이가 다르면 비교하지 않는다');
  assert.equal(P.compareTraffic({ server: S(), port: Pt({ rate_ts: 1_000_000 + 120_000 }) }).verdict, 'window-mismatch', '끝 시각이 어긋나면 비교하지 않는다');
  assert.equal(P.compareTraffic({ server: S(), port: Pt({ rate_ts: 1_000_000 + 59_000 }) }).verdict, 'ok', '20% 안');
  // 4.9% / 5.0%
  assert.equal(P.compareTraffic({ server: S({ txBps: 1_000_000 }), port: Pt({ in_bps: 0.951 * 8_000_000 }) }).verdict, 'ok');
  assert.equal(P.compareTraffic({ server: S({ txBps: 1_000_000 }), port: Pt({ in_bps: 0.95 * 8_000_000 }) }).verdict, 'mismatch');
  assert.equal(P.compareTraffic({ server: S(), port: Pt({ in_drop: 3 }) }).verdict, 'port-errors');
  assert.equal(P.compareTraffic({ server: S({ dropDelta: 2 }), port: Pt() }).verdict, 'server-drops');
  assert.equal(P.compareTraffic({ server: S({ txBps: 10, rxBps: 0 }), port: Pt({ in_bps: 0, out_bps: 0 }) }).verdict, 'idle');
  assert.equal(P.compareTraffic({ server: S({ txBps: null, rxBps: null }), port: Pt() }).verdict, 'no-data');
  assert.equal(P.compareTraffic({ server: S({ spanMs: null }), port: Pt() }).verdict, 'no-data');
});

test('라우트(bmPortsView): 범위 밖 404 · 법인 CVP 없음 → no-cvp · 다른 법인 CVP 매핑은 범위 계정에 숨기고 센다 · 확정 매핑은 대조', async () => {
  const B = await import('../src/routes/api/bmUsage.js');
  const now = Date.now();
  const target = { key: 'S', name: 'bm-kr1-db01', vcenterId: 'vc1', paths: ['os'] };
  const base = {
    currentTargets: async () => ({ targets: [target] }), bmAddressHosts: async () => [], listEdgeBmUsage: async () => [],
    nicLatestFor: async () => ({ ok: true, nics: [{ nic: 'eno1', at: now, spanMs: 300_000, rxBps: 500_000, txBps: 1_000_000 }, { nic: 'eno2', at: now, spanMs: 300_000, rxBps: 1, txBps: 1 }] }),
    cvpServers: async () => [{ id: 'c1', datacenterId: 'DC-KR' }, { id: 'c9', datacenterId: 'DC-PL' }],
    datacenterOfVcenter: async (vc) => (vc === 'vc1' ? 'DC-KR' : ''),
    portLatestRows: async () => ({ rows: [{ cvp_id: 'c1', device_key: 'SW1', port: 'Et1', descr: 'bm-kr1-db01 eno1', in_bps: 8_000_000, out_bps: 4_000_000, rate_ts: now, hostname: 'sw1' },
      { cvp_id: 'c9', device_key: 'SWX', port: 'Et5', descr: 'x', in_bps: 1, out_bps: 1, rate_ts: now }] }),
    portsByDesc: async () => ({ rows: [{ cvpId: 'c1', key: 'SW1', port: 'Et1', desc: 'bm-kr1-db01 eno1', hostname: 'sw1' }, { cvpId: 'c9', key: 'SWX', port: 'Et7', desc: 'bm-kr1-db01' }] }),
    cvpIntervalMs: async () => 300_000,
    listPortMap: async () => [{ nic: 'eno1', cvpId: 'c1', deviceKey: 'SW1', port: 'Et1', by: 'admin', at: 1 }, { nic: 'eno2', cvpId: 'c9', deviceKey: 'SWX', port: 'Et5' }],
  };
  const admin = { user: { username: 'a', role: 'admin' }, params: { key: 'S' }, query: {} };
  const r = await B.bmPortsView(admin, {}, base);
  assert.equal(r.ok, true); assert.equal(r.corpId, 'DC-KR'); assert.deepEqual(r.notBuilt, ['lldp', 'mac']);
  const e1 = r.nics.find((x) => x.nic === 'eno1');
  assert.equal(e1.state, 'mapped'); assert.equal(e1.compare.verdict, 'ok');
  assert.equal(r.nics.find((x) => x.nic === 'eno2').state, 'mapped', '전체 범위는 다른 법인 매핑도 본다');
  assert.deepEqual(r.candidates.map((c) => [c.port, c.nic]), [['Et1', 'eno1']], '후보는 그 법인 CVP 포트만(c9 는 다른 법인)');
  const scoped = { user: { username: 'u', role: 'admin', scope: { vcenters: ['vc1'] } }, params: { key: 'S' }, query: {} };
  const rs = await B.bmPortsView(scoped, {}, base);
  assert.equal(rs.hiddenOutOfScope, 1); assert.notEqual(rs.nics.find((x) => x.nic === 'eno2').state, 'mapped');
  const out = await B.bmPortsView({ ...scoped, user: { ...scoped.user, scope: { vcenters: ['vc2'] } } }, {}, base);
  assert.equal(out.__status, 404);
  const noCvp = await B.bmPortsView(admin, {}, { ...base, datacenterOfVcenter: async () => 'DC-NONE' });
  assert.equal(noCvp.cvpRegistered, false); assert.ok(noCvp.nics.every((x) => x.state === 'no-cvp'));
});
