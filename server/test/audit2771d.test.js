/**
 * v2.771 6회차 점검 — 수정 그룹 G4(SAN·PDU) 회귀 테스트.
 *
 *  F1-1 slimSnapshot 이 상한(64)을 포트 순서로 잘라 disc_c3 누적 포트가 뒤 번호의 faulty·crc 포트를 밀어내던 것(v2.770 회귀)
 *       + 중앙 ports 항목이 엣지 전체 집계(ports.faulty)를 보지 않던 것
 *  F1-2 judgePortErrors 가 리셋을 키별로만 감지해 같은 포트의 다른 키를 cur-base 로 과소 집계하던 것
 *  F1-3 PDU 임계 _assigned — 표지 없는(v2.769) 파일을 같은 값으로 다시 저장해도 지정되지 않던 것
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2771d-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
delete process.env.PDU_THRESHOLDS_LOCAL;

const H = await import('../src/sanswitch/healthCheck.js');
const { slimSnapshot } = await import('../src/sanswitch/push.js');
const TH = await import('../src/pdu/thresholds.js');
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

const Z = { errCrc: 0, errEncIn: 0, errEncOut: 0, errLinkFail: 0, errLossSync: 0, errLossSig: 0, discC3: 0 };
const port = (o) => ({ index: 0, state: 'online', stateRaw: 'Online', rxPowerDbm: -3, ...Z, ...o });
const snapOf = (list, extraPorts = {}) => ({
  deviceId: 'sw1', ok: true, collectedAt: 1, switchState: 'Online', health: {}, extra: {},
  sections: { counters: 'ok', sfp: 'ok', health: 'skip', ports: 'ok' },
  ports: { list, total: list.length, online: list.length, licensed: list.length, free: 0, portsOmitted: 0, ...extraPorts },
});
const item = (snap, key, opts) => H.checkDevice(snap, opts).items.find((x) => x.key === key);

/* ── F1-1 ─────────────────────────────────────────────────────────────────── */

/** 재현 slim.mjs: 128포트, 0~99 포트 disc_c3 누적(기준선과 같음), 120번 faulty + crc 5000(기준선 0). */
function bigSwitch() {
  const list = [];
  for (let i = 0; i < 128; i++) {
    const p = port({ index: i, state: i < 100 ? 'online' : 'offline' });
    if (i < 100) p.discC3 = 10 + i;
    if (i === 120) { p.state = 'faulty'; p.errCrc = 5000; }
    list.push(p);
  }
  return list;
}

test('F1-1 상한을 넘으면 심각도 순으로 고른다 — 뒤 번호 faulty·crc 포트가 disc_c3 포트에 밀리지 않는다', () => {
  const list = bigSwitch();
  const s = slimSnapshot(snapOf(list, { faulty: 1 }), 64);
  const idx = s.ports.list.map((p) => p.index);
  assert.equal(idx.length, 64);
  assert.ok(idx.includes(120), '수정 전: 포트 순서로 잘라 120번(faulty·crc 5000)이 빠졌다');
  assert.equal(s.ports.portsOmitted, 64);
  // 반환은 원래 포트 순서(audit2770a E3-2 와 같은 기대)
  assert.deepEqual(idx, idx.slice().sort((a, b) => a - b));
  // disc_c3 등급 안에서는 값 큰 순으로 남는다(가장 큰 99 는 남고 가장 작은 0 은 빠진다)
  assert.ok(idx.includes(99) && !idx.includes(0), JSON.stringify(idx.slice(0, 5)));
  const baseline = { at: 1, ports: Object.fromEntries(list.map((p) => [p.index, { ...Z, discC3: p.discC3 }])) };
  assert.equal(item(s, 'ports', { baseline }).status, 'bad');
  assert.equal(item(s, 'portErrors', { baseline }).status, 'bad', '수정 전: warn(올라온 포트에서는 새 에러 없음)');
});

test('F1-1 등급: faulty > 링크 에러 > rx 하한 > disabled > disc_c3·rx 주의', () => {
  const list = [
    port({ index: 0, discC3: 900000 }), port({ index: 1, rxPowerDbm: -9.5 }), port({ index: 2, state: 'disabled' }),
    port({ index: 3, rxPowerDbm: -20 }), port({ index: 4, errEncOut: 3 }), port({ index: 5, state: 'faulty' }),
    port({ index: 6, errCrc: 7 }),
  ];
  const pick = (n) => slimSnapshot(snapOf(list), n).ports.list.map((p) => p.index);
  assert.deepEqual(pick(1), [5]);
  assert.deepEqual(pick(3), [4, 5, 6], '링크 에러는 값 큰 순(crc 7 > enc_out 3) — 둘 다 disc_c3 90만보다 앞');
  assert.deepEqual(pick(4), [3, 4, 5, 6]);
  assert.deepEqual(pick(5), [2, 3, 4, 5, 6], 'disabled(판정 warn 뿐)는 rx 하한 뒤');
  assert.deepEqual(pick(6), [0, 2, 3, 4, 5, 6], 'disc_c3 는 rx 주의보다 값으로 앞선다');
  assert.deepEqual(pick(64), [0, 1, 2, 3, 4, 5, 6], '상한 안이면 문제 포트 전부·원래 순서');
});

test('F1-1 축약 목록에 장애 포트가 없어도 엣지 전체 집계(ports.faulty)>0 이면 ports 항목은 bad', () => {
  const s = snapOf([port({ index: 0, discC3: 5 })], { portsOmitted: 200, faulty: 2 });
  const it = item(s, 'ports', {});
  assert.equal(it.status, 'bad', it.detail);
  assert.match(it.detail, /장애 포트 2개/);
  // 목록이 비어 있어도 같다(수정 전: unknown)
  const empty = snapOf([], { portsOmitted: 200, faulty: 1 });
  assert.equal(item(empty, 'ports', {}).status, 'bad');
  // 집계 0 이면 예전대로(일부 누락 warn · 0포트 unknown)
  assert.equal(item(snapOf([port({ index: 0, discC3: 5 })], { portsOmitted: 200, faulty: 0 }), 'ports', {}).status, 'warn');
  assert.equal(item(snapOf([], { portsOmitted: 200, faulty: 0 }), 'ports', {}).status, 'unknown');
  // 전체 스냅샷(누락 0)은 목록이 진실이다
  assert.equal(item(snapOf([port({ index: 0 })], { faulty: 3 }), 'ports', {}).status, 'ok');
});

/* ── F1-2 ─────────────────────────────────────────────────────────────────── */

test('F1-2 한 키라도 리셋이면 포트 단위 리셋 — 다른 키도 \'리셋 이후 최소 = cur\'(재현 judge.mjs)', () => {
  const p = { index: 1, state: 'online', errCrc: 0, errEncOut: 140, rxPowerDbm: -3 };
  const row = { errCrc: 10000, errEncOut: 50 };
  const j = H.judgePortErrors(p, { hasBaseline: true, row });
  assert.equal(j.newMin, 140, `수정 전: 90(enc_out 140-50) — ${j.newMin}`);
  assert.equal(j.status, 'bad');
  assert.equal(j.held, 'reset');
  assert.equal(j.newBy.errEncOut, 140);
  assert.match(j.reason, /리셋 이후 최소 140건/);

  const snap = snapOf([p]);
  const baseline = { at: 1, ports: { 1: row } };
  const r = H.checkPorts(snap, { baseline }).rows[0];
  assert.equal(r.errNew, null);
  assert.equal(r.errNewMin, 140);
  assert.equal(r.errHeld, 'reset', '수정 전: null → 웹 errorText 가 \'기준선 없음\' 으로 말했다');

  const it = item(snap, 'portErrors', { baseline });
  assert.equal(it.status, 'bad');
  assert.doesNotMatch(it.detail, /리셋 이후 0건/, '신규 하한이 있는 포트를 \'리셋 이후 0건\' 으로 동시에 적지 않는다');
  assert.equal(it.resetPorts, 1);
  assert.ok(it.evidence.some((e) => /enc out 140 \(리셋 — 이후 최소 140\)/.test(e)), JSON.stringify(it.evidence));
});

test('F1-2 리셋 포트의 하한이 0 이면 보류, 리셋 없는 포트는 예전대로 cur-base', async () => {
  const z = H.judgePortErrors({ errCrc: 0, errEncOut: 0 }, { hasBaseline: true, row: { errCrc: 10000, errEncOut: 0 } });
  assert.equal(z.status, 'unknown'); assert.equal(z.held, 'reset'); assert.equal(z.newMin, 0);
  const n = H.judgePortErrors({ errCrc: 10050, errEncOut: 140 }, { hasBaseline: true, row: { errCrc: 10000, errEncOut: 50 } });
  assert.equal(n.newMin, 140); assert.equal(n.held, null); assert.equal(n.dltSum, 140);
  // 키 없는 옛 기준선은 리셋이 아니다(sanHealthCheck2519 유지)
  const old = H.judgePortErrors({ errCrc: 40000, errEncOut: 3 }, { hasBaseline: true, row: { errCrc: 40000 } });
  assert.equal(old.status, 'ok'); assert.deepEqual(old.resetKeys, []);
  // 축약(k/m/g) 키는 리셋 하한에 넣지 않는다
  const ap = H.judgePortErrors({ errCrc: 0, discC3: 1200000, errApprox: ['discC3'] }, { hasBaseline: true, row: { errCrc: 500, discC3: 1100000 } });
  assert.equal(ap.newMin, 0); assert.equal(ap.approxHeld, true); assert.equal(ap.newBy.discC3, undefined);
  // 웹 문구: 기준선이 있는 리셋 포트를 '기준선 없음' 으로 말하지 않는다
  const { errorText } = await import('../../web/src/views/tools/sanHealthText.js');
  const r = H.checkPorts(snapOf([{ index: 1, state: 'online', errCrc: 0, errEncOut: 140 }]), { baseline: { at: 1, ports: { 1: { errCrc: 10000, errEncOut: 50 } } } }).rows[0];
  assert.doesNotMatch(errorText(r), /기준선 없음/);
  assert.match(errorText(r), /리셋 이후 최소 140/);
});

/* ── F1-3 ─────────────────────────────────────────────────────────────────── */

const thFile = path.join(TMP, 'pdu-thresholds.json');

test('F1-3 표지 없는(v2.769) 파일을 같은 값으로 다시 저장하면 DEFAULTS 와 다른 키가 지정된다(재현 pdu.mjs)', () => {
  TH._resetForTest();
  fs.writeFileSync(thFile, JSON.stringify({ ...TH.DEFAULTS, bankWarnA: 28 }));
  assert.deepEqual(TH.thresholdsForEdge(), {}, '업그레이드 직후 표지 없음 = 중앙 지정 없음(audit2770d 유지)');
  const web = Object.fromEntries(Object.entries({ ...TH.DEFAULTS, bankWarnA: 28 }).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
  TH.saveThresholds(web);
  assert.deepEqual(JSON.parse(fs.readFileSync(thFile, 'utf8'))._assigned, ['bankWarnA'], '수정 전: [] — 바뀐 키가 없어 영원히 미배포');
  assert.deepEqual(TH.thresholdsForEdge(), { bankWarnA: 28 });
  // 표지가 생긴 뒤로는 바뀐 키만 누적(기본값과 같은 값을 다시 저장해도 새 지정 없음)
  TH.saveThresholds(web);
  assert.deepEqual(TH.thresholdsForEdge(), { bankWarnA: 28 });
  TH.saveThresholds({ ...web, tempWarnC: '30' });
  assert.deepEqual(TH.thresholdsForEdge(), { tempWarnC: 30, bankWarnA: 28 });
  fs.rmSync(thFile, { force: true }); TH._resetForTest();
});

test('F1-3 표지 있는 파일은 DEFAULTS 와 달라도 바뀌지 않은 키를 새로 지정하지 않는다 · enabled 는 지정 대상 아님', () => {
  TH._resetForTest();
  fs.writeFileSync(thFile, JSON.stringify({ ...TH.DEFAULTS, enabled: false, tempWarnC: 35, _assigned: [] }));
  TH.saveThresholds({ ...TH.DEFAULTS, enabled: false, tempWarnC: 35 });
  assert.deepEqual(TH.thresholdsForEdge(), {}, '엣지 자신의 현장 파일(표지 있음)은 같은 값 저장으로 지정되지 않는다');
  // 표지 없는 첫 저장이어도 enabled 는 배포하지 않는다
  fs.writeFileSync(thFile, JSON.stringify({ ...TH.DEFAULTS, enabled: false }));
  TH.saveThresholds({ ...TH.DEFAULTS, enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(thFile, 'utf8'))._assigned, []);
  assert.deepEqual(TH.thresholdsForEdge(), {});
  fs.rmSync(thFile, { force: true }); TH._resetForTest();
});
