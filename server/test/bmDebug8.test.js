// 물리서버 기능 디버깅 회차 11 — 알림 단계 회차와 부품 장애 DB(별도 프로세스 — db.js 는 한 번 열기에 실패하면 재시작 전까지 다시 열지 않는다).
//   새로 만들어진 빈 DB(기록 이력 없음)의 ‘열린 장애 0건’ 은 닫힘이 아니다(진행 기록이 있는 동안 회차를 건너뜀) · DB 에 이력이 생긴 뒤 빠진 장애는 진짜 닫힘이라 지운다(반증 A5).
//   10회차의 ‘만든 시각 2시간 유예’ 는 점검이 꺼진 노드에 DB 를 만들고 · 진짜 닫힘의 옛 확인을 남겨 되돌렸다(11회차 보안 #1~#3). 픽스처는 합성.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdebug8-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
const DB_PATH = path.join(tmp, 'part-faults.db');
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', PARTFAULT_DB_PATH: DB_PATH });
delete process.env.CENTRAL_URL;
const MIN = 60_000;
const SET = path.join(tmp, 'partfault-escalation.json');
const STATE = path.join(tmp, 'partfault-escalation-state.json');
const F = { id: 'pf', name: 'fault', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a1@example.test'], channels: false, oncall: false }] };
const part = { agent: '', partKey: 'k1', state: 'fault', scope: 'idrac', deviceId: 'SYNTH81', kind: 'disk', partId: 'p1' };

test('11회차 — 새 빈 DB 의 0건은 닫힘이 아님(건너뜀 · 기록 유지) · DB 를 만들지 않는 노드 · 이력이 생기면 진짜 닫힘은 지움', async () => {
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const DB = await import('../src/partfault/db.js');
  // 진행 기록 0건 · DB 파일 없음(점검을 켠 적 없는 노드) — 회차는 DB 를 만들지 않는다(8회차 판정 #3 · 11회차 보안 #1)
  RUN._setEscalationDepsForTest({ now: () => 5 * MIN, partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async () => ({ ok: true }), channels: async () => [] });
  await RUN.runEscalationNow();
  assert.equal(fs.existsSync(DB_PATH), false, '기록 0건 노드에도 DB 를 만들지 않는다');
  RUN._setEscalationDepsForTest(null);
  const st0 = { v: 1, enabledAt: 1, items: { '|k1': { since: 10 * MIN, sig: E.partSigOf(part), sent: [[0, 25 * MIN, 'x', 'ok', 'pf']], ackedAt: 30 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 10 * MIN } } } };
  fs.writeFileSync(STATE, JSON.stringify(st0));
  E._resetEscalationStateForTest();   // 앞 회차가 읽어 둔 빈 기록을 버리고 파일을 다시 읽게
  fs.writeFileSync(SET, JSON.stringify({ v: 1, enabled: true, enabledAt: 1, policies: [F], oncall: {}, at: 1, by: 'admin' }));
  RUN._setEscalationDepsForTest({ now: () => 60 * MIN, partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async () => ({ ok: true }), channels: async () => [] });
  try {
    // DB 파일 없음 + 진행 기록 있음 → 못 읽음(9회차) · 회차가 DB 를 만들지 않는다(11회차 보안 #1)
    let r = await RUN.runEscalationNow();
    assert.match(r.errors.join(' '), /DB 파일이 없습니다/);
    assert.equal(fs.existsSync(DB_PATH), false, '회차가 DB 를 만들지 않는다');
    // 빈 DB 가 새로 생김(판정 폴러 · 목록) → 0건이지만 이력 없음 → 건너뜀 · 기록 유지
    assert.deepEqual(await DB.openFaultsOrNull(), []);
    assert.equal(await DB.partFaultDbHasHistory(), false);
    r = await RUN.runEscalationNow();
    assert.match(r.errors.join(' '), /비어 있습니다/);
    assert.deepEqual(JSON.parse(fs.readFileSync(STATE, 'utf8')), st0, '확인 · 보낸 단계 기록을 지우지 않는다');
    // DB 에 이력이 생김(장애가 열렸다 닫힘) → 이제 0건은 진짜 닫힘 — 기록을 지운다(반증 A5 — 다시 열린 장애가 옛 확인을 물려받지 않게)
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(DB_PATH);
    raw.prepare("INSERT INTO part_event (at, agent, part_key, scope, device_id, event, state) VALUES (?, '', 'k1', 'idrac', 'SYNTH81', 'close', 'ok')").run(55 * MIN);
    raw.close();
    assert.equal(await DB.partFaultDbHasHistory(), true);
    r = await RUN.runEscalationNow();
    assert.deepEqual(r.errors, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(STATE, 'utf8')).items, {}, '진짜 닫힘이라 지운다');
  } finally { RUN._setEscalationDepsForTest(null); }
});
