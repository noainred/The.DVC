/**
 * v2.922(B-①) — CVP 포트 드롭(discards) 카운터: 파서 · 델타 · DB(최신·원시 표본·일 롤업) · 엣지 push 형식 · 중앙 정제 · 24시간 합 · 데모.
 *  ① 파서는 IF-MIB 계열 이름을 읽고, 없는 필드는 null(0 을 지어내지 않는다) · 델타는 오류와 같은 규칙(첫 표본·리셋·간격 비정상 null)
 *  ② 로컬 수집 적재 → port_latest·port_sample·port_daily(합 + 표본 수) · samplesAfter 는 12칸(끝 두 칸 드롭)
 *  ③ 중앙 적재 — 새 엣지 12칸은 드롭까지 · 구버전 엣지 10칸은 드롭 null(0 이 아니다) · 최신 행 갱신(rateFromSample)도 같은 규칙
 *  ④ 중앙 정제 — 장비 포트·표본 행의 드롭은 0 이상 유한수만 · 10칸 행도 받는다(구버전 엣지) · 구버전 중앙도 12칸을 받는다(길이 ≥ 10 검사 그대로)
 *  ⑤ 24시간 합(portWindowSums) — 값이 있는 표본만 더하고 몇 표본인지 센다 · 원시 추이(portSeries)·일 롤업에도 실린다
 *  ⑥ 데모 합성 포트·백필 행에 드롭이 있다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpdisc2922-'));
const P = await import('../src/cvp/parse.js');
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)

test('① 파서 · 델타 — 드롭은 오류와 같은 규칙', () => {
  // 형식은 cvp2608a 의 와일드카드 응답과 같다(updates = 이름 → { key, value }).
  const text = JSON.stringify({ notifications: [{ path: '/Sysdb/interface/counter/eth/phy/slice/1/intfCounterDir', updates: {
    Ethernet1: { key: 'Ethernet1', value: { inOctets: 1000, outOctets: 2000, inErrors: 1, outErrors: 0, inDiscards: 5, outDiscards: 9 } },
    Ethernet2: { key: 'Ethernet2', value: { inOctets: 10, outOctets: 20, ifInDiscards: 3, ifOutDiscards: 4 } },
    Ethernet3: { key: 'Ethernet3', value: { inOctets: 10, outOctets: 20 } },
  } }] });
  const { counters } = P.parseCounters(text);
  assert.ok(counters, '파서가 카운터를 읽는다');
  assert.equal(counters.get('Ethernet1').inDiscards, 5); assert.equal(counters.get('Ethernet1').outDiscards, 9);
  assert.equal(counters.get('Ethernet2').inDiscards, 3, 'ifInDiscards 별칭'); assert.equal(counters.get('Ethernet2').outDiscards, 4);
  assert.equal(counters.get('Ethernet3').inDiscards, null, '없는 필드는 null(0 이 아니다)');
  const c0 = { inOctets: 0, outOctets: 0, inErrors: 0, outErrors: 0, inDiscards: 10, outDiscards: 100 };
  const first = P.portDelta(null, { at: NOW, c: c0 }, 1e9, 300_000);
  assert.equal(first.inDisc, null); assert.equal(first.outDisc, null);
  const d = P.portDelta({ at: NOW - 300_000, c: c0 }, { at: NOW, c: { ...c0, inDiscards: 12, outDiscards: 160 } }, 1e9, 300_000);
  assert.equal(d.inDisc, 2); assert.equal(d.outDisc, 60);
  const reset = P.portDelta({ at: NOW - 300_000, c: c0 }, { at: NOW, c: { ...c0, inDiscards: 1, outDiscards: 100 } }, 1e9, 300_000);
  assert.equal(reset.inDisc, null, '음수 델타(리셋)는 null'); assert.equal(reset.outDisc, 0, '변화 없음은 0(값이다)');
  const gap = P.portDelta({ at: NOW - 10 * 300_000, c: c0 }, { at: NOW, c: { ...c0, inDiscards: 12 } }, 1e9, 300_000);
  assert.equal(gap.inDisc, null, '간격 비정상은 null');
  const oneSide = P.portDelta({ at: NOW - 300_000, c: { ...c0, inDiscards: null } }, { at: NOW, c: { ...c0, inDiscards: 12 } }, 1e9, 300_000);
  assert.equal(oneSide.inDisc, null, '한쪽 표본에 값이 없으면 null');
});

test('①-b poller.applyDeltas 가 드롭을 포트에 싣는다 · 카운터 없음은 null', async () => {
  const { applyDeltas } = await import('../src/cvp/poller.js');
  const prev = new Map();
  const dev = (at, inD, outD) => ({ key: 'SN1', countersAt: at, ports: [{ name: 'Ethernet1', speedBps: 1e9 }, { name: 'Ethernet9', speedBps: 1e9 }],
    counters: new Map([['Ethernet1', { inOctets: 0, outOctets: 0, inErrors: 0, outErrors: 0, inDiscards: inD, outDiscards: outD }]]) });
  const a = dev(NOW - 300_000, 1, 1); applyDeltas('c1', a, 300_000, prev);
  assert.equal(a.ports[0].inDisc, null, '첫 표본');
  const b = dev(NOW, 4, 1); applyDeltas('c1', b, 300_000, prev);
  assert.equal(b.ports[0].inDisc, 3); assert.equal(b.ports[0].outDisc, 0);
  assert.equal(b.ports[1].inDisc, null, '카운터가 없는 포트는 null'); assert.equal(b.ports[1].outDisc, null);
});

test('② · ③ · ⑤ DB — 로컬 적재 · 12칸 내보내기 · 중앙 적재(12칸/10칸) · 24시간 합 · 추이 · 일 롤업', async () => {
  const cdb = await import('../src/cvp/db.js');
  if (!(await cdb.available())) return;
  const port = (ts, inDisc, outDisc, extra = {}) => ({ name: 'Ethernet1', desc: 'esx01 vmnic0', oper: 'up', admin: 'up', speedBps: 1e9, inBps: 100, outBps: 200, inUtil: 1, outUtil: 2, inErr: 0, outErr: 1, inDisc, outDisc, ...extra });
  const t1 = NOW - 20 * 60_000; const t2 = NOW - 15 * 60_000; const t3 = NOW - 10 * 60_000;
  await cdb.saveDevices({ cvpId: 'cvp-L', devices: [{ key: 'SN1', ts: t1, hostname: 'leaf1', ports: [port(t1, 2, 7)] }], samples: true });
  await cdb.saveDevices({ cvpId: 'cvp-L', devices: [{ key: 'SN1', ts: t2, hostname: 'leaf1', ports: [port(t2, null, null)] }], samples: true });
  await cdb.saveDevices({ cvpId: 'cvp-L', devices: [{ key: 'SN1', ts: t3, hostname: 'leaf1', ports: [port(t3, 0, 5)] }], samples: true });
  const det = await cdb.deviceDetail(cdb.LOCAL_AGENT, 'cvp-L', 'SN1');
  assert.equal(det.ports[0].inDisc, 0); assert.equal(det.ports[0].outDisc, 5, 'port_latest 는 마지막 델타');
  const exp = await cdb.samplesAfter(0, 100);
  const mine = exp.rows.filter((r) => r[0] === 'cvp-L');
  assert.equal(mine.length, 3); assert.equal(mine[0].length, 12, '내보내기는 12칸(끝 두 칸 드롭)');
  assert.deepEqual(mine.map((r) => [r[10], r[11]]), [[2, 7], [null, null], [0, 5]]);
  const sums = await cdb.portWindowSums([{ agent: '', cvpId: 'cvp-L', key: 'SN1', port: 'Ethernet1' }], { now: NOW });
  const s = sums.get('\u0000cvp-L\u0000SN1\u0000Ethernet1');
  assert.deepEqual(s, { inErr: 0, outErr: 3, inDisc: 2, outDisc: 12, samples: 3, discN: 2, errN: 3 }, '값이 없는 표본은 더하지 않고 discN 에 세지 않는다');
  const raw = await cdb.portSeries({ agent: '', cvpId: 'cvp-L', key: 'SN1', port: 'Ethernet1', hours: 1, now: NOW });
  assert.deepEqual(raw.points.map((p) => p.outDisc), [7, null, 5]);
  const daily = await cdb.portSeries({ agent: '', cvpId: 'cvp-L', key: 'SN1', port: 'Ethernet1', hours: 24 * 30, now: NOW });
  const day = daily.points.find((p) => p.outDisc != null);
  assert.equal(day.inDisc, 2); assert.equal(day.outDisc, 12); assert.equal(day.inDiscN, 2, '일 롤업 표본 수 — 값이 있는 표본만');
  // ③ 중앙 적재 — 새 엣지(12칸) · 구버전 엣지(10칸)
  const A = 'edge-a';
  await cdb.saveDevices({ agent: A, cvpId: 'cvp-E', devices: [{ key: 'SN2', ts: t1, hostname: 'leaf2', ports: [port(t1, 1, 1)] }] });
  const r1 = await cdb.importSamples(A, [['cvp-E', 'SN2', 'Ethernet1', t2, 100, 200, 1, 2, 0, 0, 4, 9]]);
  assert.equal(r1.inserted, 1);
  let e = await cdb.deviceDetail(A, 'cvp-E', 'SN2');
  assert.equal(e.ports[0].inDisc, 4); assert.equal(e.ports[0].outDisc, 9, '표본이 최신 행도 올린다(rateFromSample)');
  await cdb.importSamples(A, [['cvp-E', 'SN2', 'Ethernet1', t3, 100, 200, 1, 2, 0, 0]]);
  e = await cdb.deviceDetail(A, 'cvp-E', 'SN2');
  assert.equal(e.ports[0].inDisc, null, '구버전 엣지(10칸)의 드롭은 null — 0 이 아니다'); assert.equal(e.ports[0].outDisc, null);
  const es = (await cdb.portWindowSums([{ agent: A, cvpId: 'cvp-E', key: 'SN2', port: 'Ethernet1' }], { now: NOW })).get(`${A}\u0000cvp-E\u0000SN2\u0000Ethernet1`);
  assert.equal(es.inDisc, 4); assert.equal(es.discN, 1); assert.equal(es.samples, 2);
});

test('④ 중앙 정제 — 드롭은 0 이상 유한수만 · 10칸/12칸 행 모두 받는다', async () => {
  const { sanitizeCvpBody } = await import('../src/central/cvpEdge.js');
  const owned = new Set(['cvp-E']);
  const body = {
    devices: [{ cvpId: 'cvp-E', key: 'SN2', ts: NOW, ports: [{ name: 'Ethernet1', oper: 'up', inDisc: 3, outDisc: -1 }, { name: 'Ethernet2', oper: 'up', inDisc: 'x', outDisc: '7' }, { name: 'Ethernet3', oper: 'up' }] }],
    rows: [['cvp-E', 'SN2', 'Ethernet1', NOW, 1, 2, 3, 4, 0, 0, 5, 6], ['cvp-E', 'SN2', 'Ethernet1', NOW - 1000, 1, 2, 3, 4, 0, 0], ['cvp-E', 'SN2', 'Ethernet1', NOW - 2000, 1, 2, 3, 4, 0, 0, -2, 'z'], ['cvp-E', 'SN2', 'Ethernet1', NOW, 1, 2, 3]],
  };
  const c = sanitizeCvpBody(body, owned, NOW);
  const ports = c.devicesByCvp.get('cvp-E')[0].ports;
  assert.deepEqual(ports.map((p) => [p.inDisc, p.outDisc]), [[3, null], [null, 7], [null, null]], '음수·숫자 아님은 null · 문자열 수치는 수로');
  assert.deepEqual(c.rows.map((r) => [r.length, r[10], r[11]]), [[12, 5, 6], [12, null, null], [12, null, null]]);
  assert.equal(c.dropped.badRow, 1, '10칸 미만만 버린다(구버전 중앙과 같은 검사)');
  // 구버전 중앙 호환: 새 엣지가 보내는 12칸 행은 '길이 ≥ 10' 검사를 통과한다(바뀌지 않은 계약)
  const src = fs.readFileSync(new URL('../src/central/cvpEdge.js', import.meta.url), 'utf8');
  assert.match(src, /r\.length < 10/);
});

test('⑥ 데모 — 합성 포트와 백필 행에 드롭이 있다', () => {
  const src = fs.readFileSync(new URL('../src/mock/demo/cvp.js', import.meta.url), 'utf8');
  assert.match(src, /inDisc: ph % 29 === 0 \? 1 : 0, outDisc: hot \?/);
  assert.match(src, /v\.inErr, v\.outErr, v\.inDisc, v\.outDisc\]/);
});
