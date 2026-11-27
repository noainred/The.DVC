// 물리서버 기능 디버깅 회차 11 → 반증 12c(v3.54) — 알림 단계 회차와 부품 장애 DB(별도 프로세스 — db.js 는 한 번 열기에 실패하면 재시작 전까지 다시 열지 않는다).
//   ‘열린 장애에 없음 = 닫힘’ 은 **이 DB 에서 판정된 수집 주체의 기록에만** 쓴다(판정이 같은 트랜잭션에 적는 judged_agents). 10회차의 시간 유예 · 11회차의
//   ‘DB 에 이력이 있는가’ 는 일부만 채워진 새 DB(재시작 뒤 엣지 보고 전 — D1)와 계속 빈 DB(D2)를 가르지 못했다 · 판정 기록을 못 읽으면 건너뜀(D3) ·
//   조회 · 상태는 DB 파일을 만들지 않는다(D4). 픽스처는 합성.
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
const F = { id: 'pf', name: 'fault', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a1@example.test'], channels: false, oncall: false }, { afterMin: 30, emails: ['a2@example.test'], channels: false, oncall: false }] };
const partOf = (agent, k, dev) => ({ agent, partKey: k, state: 'fault', scope: 'idrac', deviceId: dev, deviceKey: dev, kind: 'disk', partId: k, label: `disk ${k}` });
const pC = partOf('', 'k1', 'SYNTH81');
const pE = partOf('edge1', 'k2', 'SYNTH82');
const tr0 = { opened: [], updated: [], closed: [], held: [] };

test('반증 12c — 판정된 수집 주체만 닫힘으로 정리(D1 일부 채워진 새 DB · D2 계속 빈 DB) · 판정 기록 못 읽음은 건너뜀(D3) · 조회는 DB 를 만들지 않음(D4)', async () => {
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const DB = await import('../src/partfault/db.js');
  const PF = await import('../src/partfault/poller.js');
  const mails = [];
  const deps = (now) => ({ now: () => now, partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async (o) => { mails.push(o.subject || o.to); return { ok: true }; }, channels: async () => [] });
  // D4 — 점검을 켠 적 없는 노드: 상태 · 조회 · 회차가 DB 파일을 만들지 않는다
  const st = await DB.partFaultDbStatus();
  assert.deepEqual([st.available, st.notCreated, st.rows, st.error], [true, true, 0, '']);
  assert.deepEqual(await DB.openFaults(), []);
  await PF.partFaultStatus();
  RUN._setEscalationDepsForTest(deps(5 * MIN));
  await RUN.runEscalationNow();
  assert.equal(fs.existsSync(DB_PATH), false, '상태 · 조회 · 기록 0건 회차는 DB 를 만들지 않는다');
  RUN._setEscalationDepsForTest(null);
  // 확인한 장애 둘(중앙 직접 · 엣지 edge1)
  const st0 = { v: 1, enabledAt: 1, items: {
    '|k1': { since: 10 * MIN, sig: E.partSigOf(pC), sent: [[0, 25 * MIN, 'x', 'ok', 'pf']], ackedAt: 30 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 10 * MIN } },
    'edge1|k2': { since: 10 * MIN, sig: E.partSigOf(pE), sent: [[0, 25 * MIN, 'x', 'ok', 'pf']], ackedAt: 30 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 10 * MIN } },
  } };
  fs.writeFileSync(STATE, JSON.stringify(st0));
  E._resetEscalationStateForTest();
  fs.writeFileSync(SET, JSON.stringify({ v: 1, enabled: true, enabledAt: 1, policies: [F], oncall: {}, at: 1, by: 'admin' }));
  E.escalationStore._resetForTest();   // 앞의 D4 회차가 읽어 둔 빈 설정(꺼짐)을 버린다
  assert.equal(E.escalationStore.get().enabled, true);
  try {
    RUN._setEscalationDepsForTest(deps(60 * MIN));
    // DB 파일 없음 + 진행 기록 있음 → 못 읽음 · 만들지 않음(9회차)
    let r = await RUN.runEscalationNow();
    assert.match(r.errors.join(' '), /DB 파일이 없습니다/);
    assert.equal(fs.existsSync(DB_PATH), false);
    // 새 DB — 아무 주체도 판정하지 않음 → 기록을 그대로 둔다(닫힘을 모른다 · 오류 아님)
    await DB.applyTransition(tr0, { judgedAgents: [] });
    r = await RUN.runEscalationNow();
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(STATE, 'utf8')).items).sort(), ['edge1|k2', '|k1'], '판정 전에는 지우지 않는다');
    // D1 — 재시작 뒤 첫 판정이 중앙 직접분만 봄(엣지 보고 전) · 중앙 장애는 닫힘 → 중앙 기록만 정리 · 엣지 기록은 남김
    await DB.applyTransition(tr0, { judgedAgents: [''] });
    r = await RUN.runEscalationNow();
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(STATE, 'utf8')).items), ['edge1|k2'], '판정된 중앙 기록만 닫힘 · 엣지 기록은 남김(D1)');
    // 엣지가 보고 — 같은 장애가 열려 있음 → 확인 · 보낸 단계를 잇는다(2단계가 다시 가지 않음)
    await DB.applyTransition({ ...tr0, opened: [{ ...pE, firstSeenAt: 61 * MIN, lastSeenAt: 61 * MIN }] }, { judgedAgents: ['', 'edge1'], now: 61 * MIN });
    mails.length = 0;
    RUN._setEscalationDepsForTest(deps(80 * MIN));
    r = await RUN.runEscalationNow();
    const it = JSON.parse(fs.readFileSync(STATE, 'utf8')).items['edge1|k2'];
    assert.equal(it?.ackedAt, 30 * MIN, '엣지 장애의 확인을 잇는다(D1)');
    assert.equal(r.why, undefined, '켜진 회차');
    assert.equal(mails.length, 0, '확인한 장애에 단계가 다시 가지 않는다');
    // D2 — 엣지 장애도 닫힘(판정된 주체 · 0건) → 정리 · 뒤에 같은 부품의 새 장애는 처음부터(옛 확인 · 단계를 물려받지 않음)
    await DB.applyTransition({ ...tr0, closed: [{ ...pE, closeReason: 'ok', prevState: 'fault' }] }, { judgedAgents: ['', 'edge1'], now: 90 * MIN });
    RUN._setEscalationDepsForTest(deps(91 * MIN));
    r = await RUN.runEscalationNow();
    assert.deepEqual(JSON.parse(fs.readFileSync(STATE, 'utf8')).items, {}, '판정된 주체의 0건은 진짜 닫힘(D2 — 기한 없이 남지 않는다)');
    await DB.applyTransition({ ...tr0, opened: [{ ...pE, firstSeenAt: 30 * 1440 * MIN, lastSeenAt: 30 * 1440 * MIN }] }, { judgedAgents: ['edge1'], now: 30 * 1440 * MIN });
    RUN._setEscalationDepsForTest(deps(30 * 1440 * MIN + MIN));
    r = await RUN.runEscalationNow();
    const fresh = JSON.parse(fs.readFileSync(STATE, 'utf8')).items['edge1|k2'];
    assert.deepEqual([fresh?.ackedAt, fresh?.sent?.length, fresh?.since], [null, 0, 30 * 1440 * MIN + MIN], '새 장애는 처음부터(D2)');
    // D3 — 판정 기록을 못 읽으면 회차를 건너뛰고 기록을 지우지 않는다
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(DB_PATH);
    raw.prepare("UPDATE meta SET v='[1]' WHERE k='judged_agents'").run();
    raw.close();
    assert.equal(await DB.partFaultJudgedAgentsOrNull(), null);
    const before = fs.readFileSync(STATE, 'utf8');
    r = await RUN.runEscalationNow();
    assert.match(r.errors.join(' '), /판정 기록을 읽지 못했습니다/);
    assert.equal(fs.readFileSync(STATE, 'utf8'), before, '기록을 그대로 둔다(D3)');
  } finally { RUN._setEscalationDepsForTest(null); }
});
