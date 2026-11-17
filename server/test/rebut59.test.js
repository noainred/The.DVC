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

for (const kind of [
  { name: 'SAN 스위치', file: 'central-agent-sanswitch.json', edge: 'central/sanSwitchEdge.js', queue: 'sanswitch/collectRequests.js', dev: (at) => ({ deviceId: 'sw-rb59', type: 'brocade', name: 'SW', ok: true, collectedAt: at, edgeCollectedAt: at }) },
  { name: '스토리지', file: 'central-agent-storage.json', edge: 'central/storageEdge.js', queue: 'storage/collectRequests.js', dev: (at) => ({ deviceId: 'st-rb59', type: 'unity', name: 'ST', ok: true, collectedAt: at, edgeCollectedAt: at }) },
]) {
  test(`R2 — ${kind.name}: '지금 수집' 기준선은 가장 늦은 수집 사본 — 새 엣지가 같은 스냅샷을 다시 보내도 완료가 아니다`, () => {
    const id = kind.dev(0).deviceId;
    const body = { 'edge-old': { at: OLD, devices: [kind.dev(OLD)] }, 'edge-new': { at: NEW, devices: [kind.dev(NEW)] } };
    const r = runFresh(kind.file, body, `
      await import(${mod(kind.edge)});   // 기준선 resolver 등록
      const q = await import(${mod(kind.queue)});
      q.requestCollect(${JSON.stringify(id)}, 'edge-new');
      q.takeRequestsForAgent('edge-new');
      const resend = q.ackCollect(${JSON.stringify(id)}, ${NEW});        // 이미 보관 중이던 스냅샷의 재전송
      const pendingAfterResend = q.hasPendingRequest(${JSON.stringify(id)});
      const fresh = q.ackCollect(${JSON.stringify(id)}, ${NEW + 120_000}); // 요청 뒤 새 수집
      console.log(JSON.stringify({ resend, pendingAfterResend, fresh, pendingAfterFresh: q.hasPendingRequest(${JSON.stringify(id)}) }));`);
    assert.equal(r.resend, false, '수정 전: 옛 엣지 시각이 기준선이라 재전송이 완료로 처리됐다');
    assert.equal(r.pendingAfterResend, true);
    assert.equal(r.fresh, true, '요청 뒤 새 수집은 완료');
    assert.equal(r.pendingAfterFresh, false);
  });
}
