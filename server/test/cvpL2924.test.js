/**
 * v2.924(SAN·CVP 설계 B-②) — CVP LLDP 이웃 · MAC 테이블(FDB) 수집 → 호스트 업링크 매칭 '확정(LLDP)' · '높음(MAC)'.
 *  ① 파서 — LLDP(포인터 경로 이름의 첫 조각 = 로컬 포트 · 이웃 식별 필드 없는 컨테이너 제외) · FDB(복합 키 {fid, addr} 를 한 개체로 합치지 않는다 ·
 *     포트당 상한을 넘는 트렁크 포트는 버리고 밝힌다 · 알림이 아니면 일반 JSON) · 못 읽으면 null
 *  ② 수집기 상수 — 후보 경로 · 추종 깊이 · 경로 구분자가 파서와 같다 · 기본 켜짐
 *  ③ DB — 장비마다 최신 한 벌(배열이면 교체 · 같은 내용이면 다시 쓰지 않음 · null 이면 실패 시각만 · undefined 면 그대로) · 조회 · 정리(prune)
 *  ④ 엣지 push — 바뀐 장비만 · 전량 갱신 주기 · 구버전 중앙(답 없음)이면 보류
 *  ⑤ 중앙 정제 — MAC 12자 16진 · VLAN 범위 · 상한 · 소유 CVP 만 · 배열이 아닌 쪽은 싣지 않음 · 중앙은 saved.l2 를 늘 수로 답한다
 *  ⑥ 매칭 — LLDP > MAC(NIC) > VM MAC > 설명 · NIC 지목 · VM MAC 비율(트렁크 거름) · 학습 수를 모르면 판정하지 않음 · 충돌 · 설명 매칭과 합치기
 *  ⑦ 실제 라우트 — /hosts/:id/net-uplinks 가 LLDP·MAC 근거로 찾은 포트를 지금 값과 함께 싣는다 · 수집 현황(l2)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { centralSource } from './_centralSource.js'; // v2.954: central.js 가 영역별 파일로 나뉘었다(소스 스윕은 합친 소스로)

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpl2924-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'corp-a', name: 'A' }, { id: 'corp-b', name: 'B' }], assign: { 'vc-a': 'corp-a' } }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-a', name: 'vc-a', host: 'vca.corp.local', username: 'u', password: 'p', collectMode: 'site' }] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
const P = await import('../src/cvp/parse.js');

test('① 파서 — LLDP · FDB', () => {
  // followPtrs 가 만드는 모양: path /leaf/<포트 › remoteSystem › 번호>, updates = 이웃 필드
  const leaf = (name, ups) => ({ notifications: [{ path: `/leaf/${encodeURIComponent(name)}`, updates: ups }] });
  const lldpText = [
    leaf('Ethernet12 › remoteSystem › 1', { sysName: { key: 'sysName', value: 'esx01.corp.local' }, msap: { key: 'msap', value: { portIdentifier: { portId: 'vmnic0' }, chassisIdentifier: { chassisId: '00:50:56:aa:bb:cc' } } } }),
    leaf('Ethernet13 › remoteSystem › 1', { sysName: { key: 'sysName', value: 'esx02' }, msap: { key: 'msap', value: { portIdentifier: { portId: 'vmnic1' } } } }),
    leaf('Ethernet14 › remoteSystem', { count: { key: 'count', value: 1 } }),
  ].map((x) => JSON.stringify(x)).join('\n');
  const l = P.parseLldp(lldpText);
  assert.deepEqual(l.neighbors.map((n) => [n.port, n.idx, n.sysName, n.portId, n.chassisId]), [['Ethernet12', 'remoteSystem/1', 'esx01.corp.local', 'vmnic0', '00:50:56:aa:bb:cc'], ['Ethernet13', 'remoteSystem/1', 'esx02', 'vmnic1', '']], '이웃 식별 필드 없는 컨테이너(Ethernet14)는 세지 않는다');
  assert.equal(P.parseLldp('{"notifications":[]}').neighbors, null, '빈 응답은 못 읽음(null)');
  // FDB — 복합 키({fid, addr}) — 같은 VLAN 의 MAC 이 한 개체로 합쳐지면 안 된다
  const fdbUps = {};
  for (let i = 0; i < 3; i++) fdbUps[`k${i}`] = { key: { fid: { value: 100 }, addr: `00:50:56:00:00:0${i}` }, value: { intf: 'Ethernet12', entryType: 'learnedDynamicMac' } };
  fdbUps.k9 = { key: { fid: { value: 5000 }, addr: '00:50:56:00:00:09' }, value: { intf: 'Ethernet13' } };
  fdbUps.bad = { key: { fid: { value: 1 }, addr: 'zz' }, value: { intf: 'Ethernet1' } };
  const f = P.parseFdb(JSON.stringify({ notifications: [{ path: '/Smash/bridging/status/smashFdbStatus', updates: fdbUps }] }));
  assert.deepEqual(f.entries.map((e) => [e.mac, e.vlan, e.port]), [['005056000000', 100, 'Ethernet12'], ['005056000001', 100, 'Ethernet12'], ['005056000002', 100, 'Ethernet12'], ['005056000009', null, 'Ethernet13']], 'VLAN 범위 밖은 null · MAC 아닌 항목은 버린다');
  // 포트당 상한 — 트렁크 포트는 버리고 밝힌다
  const many = {};
  for (let i = 0; i <= P.FDB_PORT_MAX; i++) many[`t${i}`] = { key: { fid: 1, addr: `02:00:00:00:${String(Math.floor(i / 256)).padStart(2, '0')}:${(i % 256).toString(16).padStart(2, '0')}` }, value: { intf: 'Port-Channel1' } };
  many.h = { key: { fid: 1, addr: '00:50:56:11:22:33' }, value: { intf: 'Ethernet5' } };
  const fm = P.parseFdb(JSON.stringify({ notifications: [{ updates: many }] }));
  assert.deepEqual(fm.entries.map((e) => e.port), ['Ethernet5']); assert.deepEqual(fm.portsOverCap, [{ port: 'Port-Channel1', macs: P.FDB_PORT_MAX + 1 }]); assert.equal(fm.total, P.FDB_PORT_MAX + 2);
  // 알림이 아닌 일반 JSON(배열)
  const plain = P.parseFdb(JSON.stringify([{ name: 'a', macAddress: '0050.5611.2233', vlanId: 10, interface: 'Ethernet7' }]));
  assert.deepEqual(plain.entries, [{ mac: '005056112233', vlan: 10, port: 'Ethernet7' }]);
  assert.equal(P.parseFdb('{"notifications":[]}').entries, null);
  // 반증 L-4: 알림 시각 순 · 같은 키는 마지막 값 · deletes
  const moved = [
    { notifications: [{ timestamp: '2', updates: { a: { key: { fid: 1, addr: '00:50:56:00:00:01' }, value: { intf: 'Ethernet2' } } } }] },
    { notifications: [{ timestamp: '1', updates: { a: { key: { fid: 1, addr: '00:50:56:00:00:01' }, value: { intf: 'Ethernet1' } }, b: { key: { fid: 1, addr: '00:50:56:00:00:02' }, value: { intf: 'Ethernet3' } } } }] },
    { notifications: [{ timestamp: '3', deletes: ['b'] }] },
    { notifications: [{ timestamp: '4', updates: { c: { key: { fid: 1, addr: '00:50:56:00:00:03' }, value: { intf: 'Ethernet4' } } } }] },
    { notifications: [{ timestamp: '5', deletes: { c: { key: { fid: 1, addr: '00:50:56:00:00:03' } } } }] },   // 맵 모양 deletes(반증 r5)
  ].map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(P.parseFdb(moved).entries, [{ mac: '005056000001', vlan: 1, port: 'Ethernet2' }], '옮긴 MAC 은 마지막 포트 · 지운 MAC 은 없다');
  assert.equal(P.normMac('00-50-56-AA-BB-CC'), '005056aabbcc'); assert.equal(P.normMac('vmnic0'), null);
});

test('② 수집기 상수 — 후보 · 추종 깊이 · 구분자 · 기본 켜짐', async () => {
  const C = await import('../src/cvp/client.js');
  assert.match(C.CANDIDATES.lldp[0], /\/Sysdb\/l2discovery\/lldp\/status\/local\/1\/portStatus$/);
  assert.match(C.CANDIDATES.fdb[0], /\/Smash\/bridging\/status\/smashFdbStatus$/);
  assert.equal(C.FOLLOW_DEPTH_BY_KIND.lldp, 3); assert.equal(C.FOLLOW_DEPTH_BY_KIND.fdb, 1);
  assert.equal(C.PART_PATH_SEP, P.ENTITY_PATH_SEP, 'followPtrs 가 잇는 글자와 parseLldp 가 나누는 글자가 같다');
  assert.equal(C.L2_COLLECT, true);
  assert.ok(C.PROBE_PATHS.includes('/Smash/bridging/status/smashFdbStatus') && C.PROBE_PATHS.length <= C.PROBE_MAX);
  const src = fs.readFileSync(new URL('../src/cvp/client.js', import.meta.url), 'utf8');
  assert.match(src, /readKind\('lldp', serial, [\s\S]{0,200}upSet \? \(k\) => upSet\.has\(k\) : null\)/, 'LLDP 는 링크가 올라온 포트만 따라간다');
});

test('③ DB — 최신 한 벌 · 해시 · 실패 · 조회 · 정리', async () => {
  const cdb = await import('../src/cvp/db.js');
  if (!(await cdb.available())) return;
  await cdb.saveDevices({ cvpId: 'cvp-1', devices: [{ key: 'SN1', ts: NOW - 60_000, hostname: 'leaf1', ports: [{ name: 'Ethernet12', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 1e9, outBps: 2e9, inErr: 0, outErr: 0, inDrop: 0, outDrop: 4 }] }] });
  const fdb = [{ mac: '005056aabbcc', vlan: 100, port: 'Ethernet12' }, { mac: '005056000001', vlan: null, port: 'Ethernet12' }, { mac: 'nope', vlan: 1, port: 'x' }];
  const lldp = [{ port: 'Ethernet12', idx: '1', sysName: 'ESX01.corp.local', portId: 'vmnic0', portDesc: 'vmnic0', chassisId: '' }];
  let r = await cdb.saveL2('', 'cvp-1', [{ key: 'SN1', ts: NOW - 50_000, fdb, lldp, fdbMeta: { truncated: 0, portsOverCap: [{ port: 'Po1', macs: 900 }] } }]);
  assert.deepEqual(r, { devices: 1, fdb: 2, lldp: 1 });
  r = await cdb.saveL2('', 'cvp-1', [{ key: 'SN1', ts: NOW - 40_000, fdb, lldp, fdbMeta: { truncated: 0, portsOverCap: [{ port: 'Po1', macs: 900 }] } }]);   // 수집기·중앙 정제는 fdb 배열이면 메타도 늘 싣는다
  assert.deepEqual(r, { devices: 1, fdb: 0, lldp: 0 }, '같은 내용이면 행을 다시 쓰지 않는다(시각만 올린다)');
  r = await cdb.saveL2('', 'cvp-1', [{ key: 'SN1', ts: NOW - 30_000, fdb: null }, { key: 'SN9', ts: NOW }]);
  assert.equal(r.devices, 1, 'fdb·lldp 둘 다 undefined 인 항목은 건너뛴다');
  const rec = await cdb.l2RecordFor('', 'cvp-1', 'SN1');
  assert.deepEqual(rec.fdb, [['005056000001', -1, 'Ethernet12'], ['005056aabbcc', 100, 'Ethernet12']], 'null(실패)은 이전 목록을 지우지 않는다 · 모르는 VLAN 은 -1');
  assert.deepEqual(rec.lldp, [['Ethernet12', '1', 'ESX01.corp.local', 'vmnic0', 'vmnic0', '']]);
  assert.deepEqual(rec.fdbMeta.portsOverCap, [{ port: 'Po1', macs: 900 }]);
  const meta = await cdb.l2MetaFor('', 'cvp-1');
  assert.equal(meta.length, 1); assert.ok(meta[0].fdbHash && meta[0].lldpHash); assert.equal(meta[0].fdbAt, NOW - 40_000, '실패(null)는 읽은 시각을 올리지 않는다');
  const by = await cdb.fdbByMacs(['005056aabbcc', 'bad', '005056ffffff']);
  assert.deepEqual(by.rows.map((x) => [x.key, x.hostname, x.port, x.vlan]), [['SN1', 'leaf1', 'Ethernet12', 100]]);
  const tot = await cdb.fdbPortTotals([{ agent: '', cvpId: 'cvp-1', key: 'SN1' }]);
  assert.equal(tot.get('\u0000cvp-1\u0000SN1').get('Ethernet12'), 2);
  assert.equal((await cdb.lldpByNames(['esx01'])).rows.length, 1, '첫 점 앞(짧은 이름)으로 찾는다 · 대소문자 무시');
  assert.equal((await cdb.lldpByNames(['esx01.corp.local'])).rows.length, 1);
  assert.equal((await cdb.lldpByNames(['ab'])).rows.length, 0, '3자 미만은 단서가 아니다');
  const pk = await cdb.portsByKeys([{ agent: '', cvpId: 'cvp-1', key: 'SN1', port: 'Ethernet12' }]);
  assert.equal(pk.rows[0].outDrop, 4); assert.equal(pk.rows[0].hostname, 'leaf1');
  assert.deepEqual(await cdb.l2Status([{ agent: '', cvpId: 'cvp-1' }]), { fdbDevices: 1, lldpDevices: 1, lastAt: NOW - 40_000, fdbFailing: 1, lldpFailing: 0 }, '마지막 시도가 실패한 장비를 센다(반증 M-3)');
  // 반증 M-3: 종류마다 읽은 시각 — 엣지가 보낸 fdbAt/lldpAt 를 따로 저장한다(늦은 쪽 하나로 둘 다 덮지 않는다)
  await cdb.saveL2('', 'cvp-1', [{ key: 'SN1', ts: NOW - 1000, fdbAt: NOW - 1000, lldpAt: NOW - 48 * H, fdb, lldp, fdbMeta: { truncated: 0, portsOverCap: [] } }]);
  const m2 = (await cdb.l2MetaFor('', 'cvp-1'))[0];
  assert.equal(m2.fdbAt, NOW - 1000); assert.equal(m2.lldpAt, NOW - 48 * H);
  const rec2 = await cdb.l2RecordFor('', 'cvp-1', 'SN1');
  assert.equal(rec2.fdbAt, NOW - 1000); assert.equal(rec2.lldpAt, NOW - 48 * H, 'push 레코드도 종류마다 시각');
  // 반증 M-2: 부분 읽기(추종 잘림)는 읽은 포트만 바꾸고 나머지 포트의 이웃은 둔다
  await cdb.saveL2('', 'cvp-1', [{ key: 'SN1', ts: NOW, lldp: [...lldp, { port: 'Ethernet20', idx: '1', sysName: 'esx02', portId: 'vmnic0' }] }]);
  await cdb.saveL2('', 'cvp-1', [{ key: 'SN1', ts: NOW + 1, lldp: [{ port: 'Ethernet12', idx: '1', sysName: 'esx09', portId: 'vmnic1' }], lldpPartial: true }]);
  const rec3 = await cdb.l2RecordFor('', 'cvp-1', 'SN1');
  assert.deepEqual(rec3.lldp.map((r) => [r[0], r[2]]), [['Ethernet12', 'esx09'], ['Ethernet20', 'esx02']], '읽은 포트(Ethernet12)만 바뀌고 Ethernet20 은 남는다');
  // 반증 L-6: 중앙은 장비 레코드로 보고한 장비만(requireDevice) — 장비 행이 없는 키는 건너뛴다
  const sk = await cdb.saveL2('', 'cvp-1', [{ key: 'GHOST', ts: NOW, fdb }], { requireDevice: true });
  assert.deepEqual(sk, { devices: 0, fdb: 0, lldp: 0, skipped: 1 });
  // 고아 L2(장비 행 없이 L2 만) — 목록을 받은 CVP 의 prune 이 지운다
  await cdb.saveL2('', 'cvp-1', [{ key: 'ORPHAN', ts: NOW, fdb }]);
  await cdb.pruneDevices('', { 'cvp-1': ['SN1'] });
  assert.equal((await cdb.l2MetaFor('', 'cvp-1')).map((x) => x.key).join(','), 'SN1', '고아 L2 는 지우고 장비가 있는 SN1 은 둔다');
  // 반증 L-3: 상한에 닿으면 truncated
  const tr = await cdb.fdbByMacs(['005056aabbcc', '005056000001'], { limit: 1 });
  assert.equal(tr.rows.length, 1); assert.equal(tr.truncated, true);
  assert.equal((await cdb.fdbByMacs(['005056aabbcc'], { limit: 1 })).truncated, undefined, '정확히 상한만큼이면 잘린 것이 아니다');
  await cdb.pruneDevices('', { 'cvp-1': [] });
  assert.equal((await cdb.l2MetaFor('', 'cvp-1')).length, 0, '장비가 정리되면 L2 행도 지운다');
  assert.equal((await cdb.fdbByMacs(['005056aabbcc'])).rows.length, 0);
});

test('④ 엣지 push — 바뀐 장비만 · 전량 갱신 · 구버전 중앙 보류', async () => {
  const { l2Due, L2_UNSUPPORTED_HOLD_MS } = await import('../src/cvp/push.js');
  assert.equal(l2Due(null, 'h1|h2', NOW), true);
  assert.equal(l2Due({ h: 'h1|h2', at: NOW - 60_000 }, 'h1|h2', NOW), false, '같은 해시 · 갱신 주기 안');
  assert.equal(l2Due({ h: 'h1|h2', at: NOW - 60_000 }, 'h1|h3', NOW), true, '내용이 바뀌면 보낸다');
  assert.equal(l2Due({ h: 'h1|h2', at: NOW - 10 * H }, 'h1|h2', NOW, { refreshMs: H }), true, '전량 갱신 주기');
  assert.equal(l2Due(null, 'h', NOW, { unsupportedAt: NOW - 1000 }), false, '구버전 중앙 — 보류');
  assert.equal(l2Due(null, 'h', NOW, { unsupportedAt: NOW - L2_UNSUPPORTED_HOLD_MS - 1 }), true, '보류 시한이 지나면 다시 싣는다');
  assert.equal(l2Due(null, '', NOW), false, '읽은 적 없는 장비(해시 없음)는 싣지 않는다');
  // 반증 L-7: 중앙 답 판정 — saved 자체가 없으면(noDelegation 등) 구버전으로 단정하지 않는다
  const { l2AckOf } = await import('../src/cvp/push.js');
  assert.equal(l2AckOf({ ok: true, saved: { devices: 1, l2: 0 } }), 'acked');
  assert.equal(l2AckOf({ ok: true, saved: { devices: 1 } }), 'old-central');
  assert.equal(l2AckOf({ ok: true, noDelegation: true }), 'unknown');
  assert.equal(l2AckOf(null), 'unknown');
  const src = fs.readFileSync(new URL('../src/cvp/push.js', import.meta.url), 'utf8');
  assert.match(src, /await new Promise\(\(r\) => setImmediate\(r\)\);\s+\/\/ 반증 L-1/, '장비마다 양보(반증 L-1)');
});

test('⑤ 중앙 정제 · 중앙 답', async () => {
  const { sanitizeCvpBody, cleanL2 } = await import('../src/central/cvpEdge.js');
  const c = sanitizeCvpBody({ l2: [
    { cvpId: 'cvp-E', key: 'SN2', ts: NOW, fdb: [['005056AABBCC', 100, 'Ethernet1'], ['bad', 1, 'x'], ['005056aabbcd', 9999, 'Ethernet2'], ['005056aabbce', 1]], lldp: [['Ethernet1', '1', 'esx01', 'vmnic0', '', ''], [null, '1']], fdbMeta: { truncated: -3, portsOverCap: [{ port: 'Po1', macs: 900 }, 'x'] } },
    { cvpId: 'cvp-X', key: 'SN3', ts: NOW, fdb: [] },
    { cvpId: 'cvp-E', key: 'SN4', ts: NOW },
    'str',
  ] }, new Set(['cvp-E']), NOW);
  const list = c.l2ByCvp.get('cvp-E');
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].fdb, [['005056aabbcc', 100, 'Ethernet1'], ['005056aabbcd', null, 'Ethernet2']], 'MAC 12자 16진(소문자) · VLAN 범위 밖 null · 칸 모자라면 버림');
  assert.deepEqual(list[0].lldp, [['Ethernet1', '1', 'esx01', 'vmnic0', '', '']]);
  assert.deepEqual(list[0].fdbMeta, { truncated: 0, portsOverCap: [{ port: 'Po1', macs: 900 }] });
  assert.equal(c.l2ByCvp.has('cvp-X'), false, '소유하지 않은 CVP');
  assert.equal(c.dropped.notOwned, 1); assert.equal(c.dropped.badRow, 1, 'fdb·lldp 둘 다 없는 레코드'); assert.equal(c.dropped.notObject, 1);
  assert.equal(cleanL2({ key: '__proto__', ts: NOW, fdb: [] }), null);
  assert.equal(cleanL2({ key: 'a', ts: NOW + 10 * 86_400_000, fdb: [] }, NOW).ts, NOW, '미래 시각은 수신 시각으로');
  const src = centralSource();
  assert.match(src, /saved\.l2 = 0;\n\s+for \(const \[cvpId, list\] of clean\.l2ByCvp/, '중앙은 saved.l2 를 늘 수로 답한다(L2 가 없어도 0)');
});

test('⑥ 매칭 — 근거 순위 · NIC 지목 · 비율 · 교차 확인 · 충돌 · 합치기', async () => {
  const M = await import('../src/cvp/hostMatch.js');
  const host = { name: 'esx01.corp.local', nics: [{ device: 'vmnic0', mac: '00:50:56:aa:bb:cc' }, { device: 'vmnic1', mac: '00:50:56:aa:bb:cd' }] };
  const at = (key, port, extra = {}) => ({ agent: '', cvpId: 'c1', key, hostname: key.toLowerCase(), port, ts: NOW - 10 * 60_000, ...extra });
  const tot = (entries) => new Map(entries.map(([k, ports]) => [`\u0000c1\u0000${k}`, new Map(ports)]));
  const lldpRows = [at('L1', 'Ethernet12', { sysName: 'esx01.corp.local', sysLc: 'esx01.corp.local', sysShort: 'esx01', portId: 'vmnic0' }),
    at('L2', 'Ethernet12', { sysName: 'ESX01', sysLc: 'esx01', sysShort: 'esx01', portId: '00:50:56:aa:bb:cd' }),
    at('L3', 'Ethernet1', { sysName: 'esx010', sysLc: 'esx010', sysShort: 'esx010', portId: 'vmnic0' }),
    at('L7', 'Ethernet9', { sysName: 'esx01.other.corp', sysLc: 'esx01.other.corp', sysShort: 'esx01', portId: 'vmnic0' }),
    at('L8', 'Ethernet8', { sysName: '10.1.1.5', sysLc: '10.1.1.5', sysShort: '10', portId: 'vmnic3', chassisId: '00:50:56:aa:bb:cc' })];
  const fdbRows = [at('L1', 'Ethernet12', { mac: '005056aabbcc', vlan: 100 }), at('L4', 'Ethernet3', { mac: '005056aabbcd' }),
    at('L5', 'Ethernet7', { mac: '0050560000a1' }), at('L5', 'Ethernet7', { mac: '0050560000a2' }), at('L5', 'Po1', { mac: '0050560000a3' }), at('L5', 'Po1', { mac: '0050560000a4' })];
  const portTotals = tot([['L1', [['Ethernet12', 1]]], ['L4', [['Ethernet3', 2]]], ['L5', [['Ethernet7', 3], ['Po1', 40]]]]);
  const r = M.matchL2({ host, lldpRows, fdbRows, vmMacs: ['00:50:56:00:00:a1', '0050560000a2', '0050560000a3', '0050560000a4'], portTotals });
  const by = Object.fromEntries(r.uplinks.map((u) => [`${u.key}/${u.port}`, u]));
  assert.equal(by['L1/Ethernet12'].basis, 'lldp'); assert.equal(by['L1/Ethernet12'].nic, 'vmnic0'); assert.equal(by['L1/Ethernet12'].also[0].basis, 'mac', 'MAC 근거는 also 로 남는다');
  assert.equal(by['L1/Ethernet12'].l2At, NOW - 10 * 60_000, '근거 나이(반증 M-3)');
  assert.equal(by['L2/Ethernet12'].basis, 'lldp'); assert.equal(by['L2/Ethernet12'].nic, 'vmnic1', '이웃 portId 가 NIC MAC');
  assert.equal(by['L3/Ethernet1'], undefined, '다른 호스트(esx010)는 맞지 않는다');
  assert.equal(by['L7/Ethernet9'], undefined, '반증 M-1: 양쪽에 도메인이 있으면 전체 이름이 같아야 한다(다른 법인의 같은 짧은 이름)');
  assert.equal(by['L8/Ethernet8'].basis, 'lldp'); assert.match(by['L8/Ethernet8'].evidence, /섀시 MAC 일치/, '반증 L-9: IP 로 알린 이웃도 섀시 MAC 이 NIC MAC 이면');
  assert.equal(by['L8/Ethernet8'].nic, 'vmnic3', 'NIC 목록에 없어도 portId 가 vmnicN 이면 그 이름');
  assert.equal(by['L4/Ethernet3'].basis, 'mac'); assert.equal(by['L4/Ethernet3'].nic, 'vmnic1'); assert.match(by['L4/Ethernet3'].evidence, /그 포트 학습 2개/);
  assert.equal(by['L5/Ethernet7'].basis, 'mac-vm'); assert.equal(by['L5/Ethernet7'].nic, null); assert.match(by['L5/Ethernet7'].evidence, /VM MAC 2개 \/ 그 포트 학습 3개/);
  assert.equal(by['L5/Po1'], undefined, '학습 40개 중 2개 — 트렁크로 보고 버린다');
  // 반증 H-1 — MLAG peer-link: vmk0(=vmnic0 MAC)을 peer 가 peer-link 에서 배운다. 비율(이 호스트 것 1 / 학습 30)로 거르고, LLDP 이웃이 다른 장비면 비율과 무관하게 버린다.
  const peer = M.matchL2({ host, fdbRows: [at('P1', 'Port-Channel1000', { mac: '005056aabbcc' }), at('P2', 'Port-Channel1000', { mac: '005056aabbcc' }), at('P2', 'Vxlan1', { mac: '005056aabbcc' })],
    portTotals: tot([['P1', [['Port-Channel1000', 30]]], ['P2', [['Port-Channel1000', 1], ['Vxlan1', 1]]]]),
    portLldp: [at('P2', 'Port-Channel1000', { sysName: 'leaf-02b', sysLc: 'leaf-02b', sysShort: 'leaf-02b' })] });
  assert.deepEqual(peer.uplinks, [], 'peer-link(비율 미달) · 이웃이 다른 스위치인 포트 · Vxlan 은 업링크가 아니다');
  const r2 = M.matchL2({ host, fdbRows: [at('L6', 'Ethernet9', { mac: '0050560000a1' }), at('L6', 'Ethernet9', { mac: '0050560000a2' })], vmMacs: ['0050560000a1', '0050560000a2'] });
  assert.equal(r2.uplinks.length, 0, '포트 학습 수를 모르면 비율을 판정하지 않는다');
  const r3 = M.matchL2({ host, fdbRows: ['A', 'B', 'C'].map((k) => at(k, 'Ethernet1', { mac: '005056aabbcc' })) });
  assert.deepEqual(r3.conflicts, [{ nic: 'vmnic0', ports: 3 }], '충돌은 비율 판정 전 기준으로 표시만');
  // 설명 매칭과 합치기 — 같은 포트면 강한 근거 하나 · 설명 쪽 행 값 유지 · L2 만인 포트는 rowsByKey 의 지금 값
  const desc = [{ ...at('L1', 'Ethernet12'), desc: 'esx01 vmnic0', nic: 'vmnic0', basis: 'desc-nic', inBps: 5 }];
  const rowsByKey = new Map([['\u0000c1\u0000L4\u0000Ethernet3', { ...at('L4', 'Ethernet3'), desc: 'srv', inBps: 7, outDrop: 2 }]]);
  const merged = M.mergeUplinks(desc, r.uplinks, rowsByKey);
  const e12 = merged.find((u) => u.key === 'L1' && u.port === 'Ethernet12');
  assert.equal(e12.basis, 'lldp'); assert.equal(e12.inBps, 5, '설명 쪽 행 값'); assert.ok(e12.also.some((x) => x.basis === 'desc-nic')); assert.equal(e12.l2At, NOW - 10 * 60_000);
  const e3 = merged.find((u) => u.key === 'L4');
  assert.equal(e3.inBps, 7); assert.equal(e3.outDrop, 2); assert.equal(e3.desc, 'srv');
  assert.deepEqual(merged.map((u) => u.basis), ['lldp', 'lldp', 'lldp', 'mac', 'mac-vm'], '강한 근거 순');
  assert.equal(M.BASIS_LABEL['mac-vm'].label, '높음');
});

test('⑦ 실제 라우트 — net-uplinks 가 LLDP·MAC 근거와 수집 현황을 싣는다', async () => {
  const cdb = await import('../src/cvp/db.js');
  if (!(await cdb.available())) return;
  const reg = await import('../src/cvp/registry.js');
  const cvpId = reg.saveServer({ name: 'CVP-T', host: 'https://10.99.0.1', authMode: 'token', token: 't', agent: '' }).id;   // 법인 미지정 CVP — 매칭에 포함
  // 반증 M-1: 다른 법인(corp-b) CVP 에 같은 호스트 이름 이웃이 있어도 그 호스트(corp-a)에는 붙지 않는다(전체 범위 계정이어도)
  const otherId = reg.saveServer({ name: 'CVP-B', host: 'https://10.99.0.2', authMode: 'token', token: 't', agent: '', datacenterId: 'corp-b' }).id;
  await cdb.saveDevices({ cvpId: otherId, devices: [{ key: 'SNB', ts: NOW - 60_000, hostname: 'corpb-leaf1', ports: [{ name: 'Ethernet7', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 9e9 }] }] });
  await cdb.saveL2('', otherId, [{ key: 'SNB', ts: NOW - 50_000, lldp: [{ port: 'Ethernet7', idx: '1', sysName: 'esx77.corp.local', portId: 'vmnic0' }] }]);
  await cdb.saveDevices({ cvpId, devices: [{ key: 'SNR', ts: NOW - 60_000, hostname: 'leafr', ports: [
    { name: 'Ethernet21', desc: '', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 3e9, outBps: 1e9, inErr: 0, outErr: 0, inDrop: 1, outDrop: 2 },
    { name: 'Ethernet22', desc: 'esx77 vmnic1', oper: 'up', admin: 'up', speedBps: 25e9, inBps: 1e8, outBps: 2e8 }] }] });
  await cdb.saveL2('', cvpId, [{ key: 'SNR', ts: NOW - 50_000, lldp: [{ port: 'Ethernet21', idx: '1', sysName: 'esx77.corp.local', portId: 'vmnic0' }], fdb: [{ mac: '00505677aa01', vlan: 10, port: 'Ethernet22' }] }]);
  const { store } = await import('../src/store.js');
  const R = await import('../src/routes/api/hostSan.js');
  const express = (await import('express')).default;
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vc-a', name: 'vc-a' }],
    hosts: [{ id: 'vc-a:h77', name: 'esx77.corp.local', vcenterId: 'vc-a', nics: [{ device: 'vmnic0', mac: '00:50:56:77:00:00' }, { device: 'vmnic1', mac: '00:50:56:77:aa:01' }] }], vms: [], datastores: [] };
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); });
  const api = express.Router(); R.registerHostSan(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const j = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/hosts/${encodeURIComponent('vc-a:h77')}/net-uplinks`)).json();
  assert.equal(j.ok, true);
  const u21 = j.uplinks.find((u) => u.port === 'Ethernet21'); const u22 = j.uplinks.find((u) => u.port === 'Ethernet22');
  assert.equal(u21.basis, 'lldp'); assert.equal(u21.nic, 'vmnic0'); assert.equal(u21.basisLabel.label, '확정'); assert.match(u21.evidence, /LLDP 이웃 esx77\.corp\.local/);
  assert.equal(u21.inBps, 3e9, 'L2 로만 찾은 포트에도 지금 값'); assert.equal(u21.outDrop, 2); assert.equal(u21.hostname, 'leafr');
  assert.equal(u22.basis, 'mac'); assert.equal(u22.nic, 'vmnic1'); assert.ok(u22.also.some((x) => x.basis === 'desc-nic'), '설명 일치는 also 로');
  assert.deepEqual(j.uplinks.map((u) => u.basis), ['lldp', 'mac']);
  assert.equal(j.uplinks.some((u) => u.cvpId === otherId), false, '다른 법인 CVP 의 포트는 붙지 않는다(반증 M-1)');
  assert.equal(j.hostCorpMatched, true); assert.equal(j.servers, 1, '매칭에 쓴 CVP 는 그 호스트 법인 + 법인 미지정');
  assert.equal(u21.l2At, NOW - 50_000, '근거 나이');
  assert.equal(j.l2.fdbDevices, 1); assert.equal(j.l2.lldpDevices, 1);
});
