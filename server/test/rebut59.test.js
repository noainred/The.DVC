/**
 * rebut59.test.js — 전체 점검 59회차(56~58회차 수정 반증) 회귀 고정.
 *
 *  R2 58회차 F1 은 단건 경로를 '가장 늦은 수집 사본'(edgeSanSwitchSnapshotFor)으로 고쳤지만, 같은 보관소를 읽는 '지금 수집' 기준선
 *     (setCollectBaseResolver)은 첫 일치 그대로였다 — 위임을 옮긴 뒤 중앙 재시작 직후 옛 엣지의 한 달 전 시각을 기준선으로 잡아,
 *     새 엣지가 **이미 보관 중인 스냅샷을 다시 보내기만 해도** 요청이 완료로 지워졌다(재현 — 재인출 안전망까지 사라짐).
 *     스토리지 엣지 보관소(central/storageEdge.js)도 같은 꼴이라 함께 고쳤다.
 *
 * 기준 시각: 실제 시각을 정시 경계로 떨어뜨린 값(고정 epoch 를 쓰지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SRC = path.resolve(import.meta.dirname, '../src');
const mod = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계

/** 새 CONFIG_DIR(= 중앙 재시작 직후 — 보관 파일만 있고 요청 큐는 비어 있음)에서 스크립트를 돌리고 마지막 줄(JSON)을 돌려준다. */
function runFresh(file, body, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb59-'));
  try {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(body));
    const out = execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir, DB_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    return JSON.parse(out.trim().split('\n').pop());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const OLD = NOW - 30 * 86_400_000;   // 철거된 옛 엣지의 마지막 수집(먼저 보관)
const NEW = NOW - 60_000;            // 새 엣지의 최근 수집

const Q_STD = { req: 'requestCollect', take: 'takeRequestsForAgent', ack: 'ackCollect', has: 'hasPendingRequest' };
const twoEdges = (dev) => ({ 'edge-old': { at: OLD, devices: [dev(OLD)] }, 'edge-new': { at: NEW, devices: [dev(NEW)] } });
for (const kind of [
  { name: 'SAN 스위치', file: 'central-agent-sanswitch.json', edge: 'central/sanSwitchEdge.js', queue: 'sanswitch/collectRequests.js', q: Q_STD, id: 'sw-rb59',
    body: () => twoEdges((at) => ({ deviceId: 'sw-rb59', type: 'brocade', name: 'SW', ok: true, collectedAt: at, edgeCollectedAt: at })) },
  { name: '스토리지', file: 'central-agent-storage.json', edge: 'central/storageEdge.js', queue: 'storage/collectRequests.js', q: Q_STD, id: 'st-rb59',
    body: () => twoEdges((at) => ({ deviceId: 'st-rb59', type: 'unity', name: 'ST', ok: true, collectedAt: at, edgeCollectedAt: at })) },
  // 후속②: PDU · CVP 보관소도 같은 꼴이었다(첫 일치)
  { name: 'PDU', file: 'central-pdu.json', edge: 'central/pduEdge.js', queue: 'pdu/collectRequests.js', q: Q_STD, id: 'pdu-rb59',
    body: () => ({ edges: [{ agent: 'edge-old', at: OLD, snapshots: [{ id: 'pdu-rb59', ok: true, collectedAt: OLD, edgeCollectedAt: OLD }] },
      { agent: 'edge-new', at: NEW, snapshots: [{ id: 'pdu-rb59', ok: true, collectedAt: NEW, edgeCollectedAt: NEW }] }] }) },
  { name: 'CVP', file: 'central-agent-cvp.json', edge: 'central/cvpEdge.js', queue: 'cvp/collectRequests.js', id: 'cvp-rb59',
    q: { req: 'requestCvpCollect', take: 'takeCvpRequests', ack: 'ackCvpCollect', has: 'hasPendingCvpRequest' },
    body: () => ({ 'edge-old': { at: OLD, servers: [{ cvpId: 'cvp-rb59', ok: true, collectedAt: OLD, edgeCollectedAt: OLD }] },
      'edge-new': { at: NEW, servers: [{ cvpId: 'cvp-rb59', ok: true, collectedAt: NEW, edgeCollectedAt: NEW }] } }) },
]) {
  test(`R2 — ${kind.name}: '지금 수집' 기준선은 가장 늦은 수집 사본 — 새 엣지가 같은 스냅샷을 다시 보내도 완료가 아니다`, () => {
    const id = JSON.stringify(kind.id); const q = kind.q;
    const r = runFresh(kind.file, kind.body(), `
      await import(${mod(kind.edge)});   // 기준선 resolver 등록
      const q = await import(${mod(kind.queue)});
      q.${q.req}(${id}, 'edge-new');
      q.${q.take}('edge-new');
      const resend = q.${q.ack}(${id}, ${NEW});        // 이미 보관 중이던 스냅샷의 재전송
      const pendingAfterResend = q.${q.has}(${id});
      const fresh = q.${q.ack}(${id}, ${NEW + 120_000}); // 요청 뒤 새 수집
      console.log(JSON.stringify({ resend, pendingAfterResend, fresh, pendingAfterFresh: q.${q.has}(${id}) }));`);
    assert.equal(r.resend, false, '수정 전: 옛 엣지 시각이 기준선이라 재전송이 완료로 처리됐다');
    assert.equal(r.pendingAfterResend, true);
    assert.equal(r.fresh, true, '요청 뒤 새 수집은 완료');
    assert.equal(r.pendingAfterFresh, false);
  });
}

/* ── 59회차 후속 ① — 57회차 F1 업그레이드 경계(등록 시각이 v2.541 정리 마커보다 늦은 장비는 지우지 않는다) ── */
const DAY = 86_400_000;
function runIsolated(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb59m-'));
  try {
    const out = execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir, DB_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    return JSON.parse(out.trim().split('\n').pop());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const MIG = `
  const db = await import(${mod('storage/db.js')});
  const { runCapacityBasisMigration, newBasisOnly } = await import(${mod('storage/capacityBasisMigration.js')});
  const { PURGE_ID } = await import(${mod('storage/zeroCapacityPurge.js')});
  const seed = async (id, n) => { for (let i = 0; i < n; i++) await db.saveCapacityPoint({ deviceId: id, ok: true, collectedAt: ${NOW} - i * ${DAY}, capacity: { totalBytes: 100e12, usedBytes: 40e12 } }); };
  const left = async (id) => (await db.dailySeries(id, 0)).length;
`;

test('후속① — v2.541 정리 마커의 at 은 처음 값이다(두 번째 기동이 덮지 않는다)', () => {
  const r = runIsolated(`${MIG}
    await db.purgeZeroCapacityRows({ once: PURGE_ID, at: ${NOW - 100 * DAY} });
    await db.purgeZeroCapacityRows({ once: PURGE_ID, at: ${NOW} });
    console.log(JSON.stringify({ at: (await db.migrationMarker(PURGE_ID))?.at, none: await db.migrationMarker('no-such') }));`);
  assert.equal(r.at, NOW - 100 * DAY, '처음 기동 시각이 남는다');
  assert.equal(r.none, null);
});

test('후속① — 마커 뒤 등록한 PowerMax 는 지우지 않고, 그 전 등록 · 등록 시각 모름 · 마커 없음 · 마커가 지금(덮인 판본 가정)이면 예전처럼 지운다', () => {
  const T = NOW - 100 * DAY;   // 이 설치가 v2.541 을 처음 돈 시각
  const r = runIsolated(`${MIG}
    await db.purgeZeroCapacityRows({ once: PURGE_ID, at: ${T} });
    for (const id of ['pmNew', 'pmOld', 'pmNoCreated', 'pmBadCreated']) await seed(id, 3);
    const devices = [
      { id: 'pmNew', type: 'powermax', createdAt: ${T + DAY} },
      { id: 'pmOld', type: 'vmax', createdAt: ${T - DAY} },
      { id: 'pmNoCreated', type: 'powermax' },
      { id: 'pmBadCreated', type: 'powermax', createdAt: '2026-01-01' },
      { id: 'un1', type: 'unity', createdAt: ${T - DAY} },
    ];
    const out = await runCapacityBasisMigration({ devices });
    const resets = Object.keys(await db.capacityResets()).sort();
    console.log(JSON.stringify({ out, pmNew: await left('pmNew'), pmOld: await left('pmOld'), pmNoCreated: await left('pmNoCreated'), pmBadCreated: await left('pmBadCreated'), resets,
      fns: [newBasisOnly({ createdAt: ${T + 1} }, ${T}), newBasisOnly({ createdAt: ${T + 1} }, null), newBasisOnly({ createdAt: ${T + 1} }, ${NOW + DAY}), newBasisOnly({}, ${T}), newBasisOnly({ createdAt: '' }, ${T})] }));`);
  assert.equal(r.out.ran, true);
  assert.ok(r.pmNew > 0, '등록 시각이 마커보다 늦은 장비 이력은 남는다(수정 전: 0행)');
  assert.equal(r.pmOld, 0, '마커 전 등록 — 예전처럼 지운다');
  assert.equal(r.pmNoCreated, 0, '등록 시각 모름 — 예전처럼 지운다');
  assert.equal(r.pmBadCreated, 0, '해석 불가 등록 시각 — 예전처럼 지운다');
  assert.deepEqual(r.resets, ['pmBadCreated', 'pmNoCreated', 'pmOld'], "남긴 장비에는 '기준 변경' 재시작 기록이 없다");
  // 마커 없음(null) · 마커가 지금(매 기동 덮이는 판본이라면) → 남기지 않는다(삭제를 줄이는 방향으로만)
  assert.deepEqual(r.fns, [true, false, false, false, false]);
});

test('후속① — 마커가 없으면 예전 동작(지움) · 대상이 모두 새 기준이면 마커만 남기고 다음 기동도 지우지 않는다', () => {
  const T = NOW - 100 * DAY;
  const noMarker = runIsolated(`${MIG}
    await seed('pm1', 3);
    const out = await runCapacityBasisMigration({ devices: [{ id: 'pm1', type: 'powermax', createdAt: ${NOW - DAY} }] });
    console.log(JSON.stringify({ out, left: await left('pm1') }));`);
  assert.equal(noMarker.out.ran, true);
  assert.equal(noMarker.left, 0, 'v2.541 마커가 없으면 판단 근거가 없다 — 예전처럼 지운다');

  const allNew = runIsolated(`${MIG}
    await db.purgeZeroCapacityRows({ once: PURGE_ID, at: ${T} });
    await seed('pm1', 3);
    const devices = [{ id: 'pm1', type: 'powermax', createdAt: ${T + DAY} }];
    const boot1 = await runCapacityBasisMigration({ devices });
    const boot2 = await runCapacityBasisMigration({ devices, zeroPurgeAt: null });   // 다음 기동 — 마커를 못 읽어도 1회 마커가 막는다
    console.log(JSON.stringify({ boot1, boot2, left: await left('pm1'), resets: Object.keys(await db.capacityResets()) }));`);
  assert.equal(allNew.boot1.ran, false);
  assert.equal(allNew.boot1.marked, true, '지울 장비가 없으면 1회 마커만');
  assert.equal(allNew.boot1.skipped, 1);
  assert.equal(allNew.boot2.ran, false);
  assert.equal(allNew.left, 3);
  assert.deepEqual(allNew.resets, []);
});
