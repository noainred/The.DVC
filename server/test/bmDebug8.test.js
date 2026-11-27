// 물리서버 기능 디버깅 회차 11 → 반증 12c · 13c(v3.54) — 알림 단계 회차와 부품 장애 DB(별도 프로세스 — db.js 는 한 번 열기에 실패하면 재시작 전까지 다시 열지 않는다).
//   ‘열린 장애에 없음’ 은 닫힘이 아니다 — **닫힘 근거가 있는 기록만** 정리한다: ① DB 의 그 열쇠 마지막 이벤트가 닫힘(평소 · 수동 닫기) ② 판정 폴러의 가상 전이가 닫음(closeEvidence).
//   근거가 없으면(새 DB · 장비 실패 · 보고 없음) 남긴다(D1 · D2 · N1 · N2) · 근거를 못 읽으면 건너뜀(D3) · 조회는 DB 를 만들지 않음(D4). 픽스처는 합성.
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

test('반증 12c · 13c — 닫힘 근거가 있는 기록만 정리(새 DB · 일부 판정 · 평소 닫힘 · 수동 닫기 · 가상 전이) · 근거 못 읽음은 건너뜀 · 조회는 DB 를 만들지 않음', async () => {
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const DB = await import('../src/partfault/db.js');
  const PF = await import('../src/partfault/poller.js');
  const CE = await import('../src/partfault/closeEvidence.js');
  const mails = [];
  const deps = (now) => ({ now: () => now, partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async (o) => { mails.push(o.subject || o.to); return { ok: true }; }, channels: async () => [] });
  // D4 — 점검을 켠 적 없는 노드: 상태 · 조회 · 장애별 보기 입력 · 회차가 DB 파일을 만들지 않는다
  const st = await DB.partFaultDbStatus();
  assert.deepEqual([st.available, st.notCreated, st.rows, st.error], [true, true, 0, '']);
  assert.deepEqual(await DB.openFaults(), []);
  const inc = await DB.incidentInputs({});
  assert.deepEqual([inc.available, inc.notCreated, inc.events.length], [true, true, 0], '만들지 않은 DB 의 장애별 보기는 ‘열 수 없음’ 이 아니다(13c N3)');
  await PF.partFaultStatus();
  RUN._setEscalationDepsForTest(deps(5 * MIN));
  await RUN.runEscalationNow();
  assert.equal(fs.existsSync(DB_PATH), false, '상태 · 조회 · 기록 0건 회차는 DB 를 만들지 않는다');
  RUN._setEscalationDepsForTest(null);
  // 확인한 장애 둘(중앙 직접 · 엣지 edge1) — 판정 재료(pk)가 있는 기록
  const pkOf = (p) => ({ scope: p.scope, deviceId: p.deviceId, deviceKey: p.deviceKey, kind: p.kind, partId: p.partId, state: p.state, label: p.label });
  const st0 = { v: 1, enabledAt: 1, items: {
    '|k1': { since: 10 * MIN, sig: E.partSigOf(pC), sent: [[0, 25 * MIN, 'x', 'ok', 'pf']], ackedAt: 30 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 10 * MIN }, pk: pkOf(pC) },
    'edge1|k2': { since: 10 * MIN, sig: E.partSigOf(pE), sent: [[0, 25 * MIN, 'x', 'ok', 'pf']], ackedAt: 30 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 10 * MIN }, pk: pkOf(pE) },
  } };
  fs.writeFileSync(STATE, JSON.stringify(st0));
  E._resetEscalationStateForTest();
  assert.deepEqual(E.loadEscalationState().items['|k1'].pk, pkOf(pC), '판정 재료를 읽어 들인다');
  fs.writeFileSync(SET, JSON.stringify({ v: 1, enabled: true, enabledAt: 1, policies: [F], oncall: {}, at: 1, by: 'admin' }));
  E.escalationStore._resetForTest();   // 앞의 D4 회차가 읽어 둔 빈 설정(꺼짐)을 버린다
  assert.equal(E.escalationStore.get().enabled, true);
  const keys = () => Object.keys(JSON.parse(fs.readFileSync(STATE, 'utf8')).items).sort();
  try {
    RUN._setEscalationDepsForTest(deps(60 * MIN));
    // DB 파일 없음 + 진행 기록 있음 → 못 읽음 · 만들지 않음(9회차)
    let r = await RUN.runEscalationNow();
    assert.match(r.errors.join(' '), /DB 파일이 없습니다/);
    assert.equal(fs.existsSync(DB_PATH), false);
    // 새 DB — 열린 장애 0건이지만 닫힘 근거가 없다 → 기록을 그대로 둔다(오류 아님)
    await DB.applyTransition(tr0);
    r = await RUN.runEscalationNow();
    assert.deepEqual(r.errors, []);
    assert.equal(r.why, undefined, '켜진 회차');
    assert.deepEqual(keys(), ['edge1|k2', '|k1'], '근거 없이는 지우지 않는다(12c D1 · D2)');
    // 판정 폴러의 가상 전이가 중앙 장애만 닫음(장비를 읽었고 부품이 없음) · 엣지 장비는 읽지 못해 보류 → 중앙 기록만 정리(13c N1)
    CE.setJudgedClosed(['|k1']);
    r = await RUN.runEscalationNow();
    assert.deepEqual(keys(), ['edge1|k2'], '가상 전이가 닫은 기록만 정리 · 보류한 엣지 기록은 남김');
    CE.setJudgedClosed([]);
    // 엣지가 보고 — 같은 장애가 열려 있음 → 확인 · 보낸 단계를 잇는다(2단계가 다시 가지 않음)
    await DB.applyTransition({ ...tr0, opened: [{ ...pE, firstSeenAt: 61 * MIN, lastSeenAt: 61 * MIN }] }, { now: 61 * MIN });
    mails.length = 0;
    RUN._setEscalationDepsForTest(deps(80 * MIN));
    r = await RUN.runEscalationNow();
    const it = JSON.parse(fs.readFileSync(STATE, 'utf8')).items['edge1|k2'];
    assert.equal(r.why, undefined, '켜진 회차');
    assert.equal(it?.ackedAt, 30 * MIN, '엣지 장애의 확인을 잇는다(D1)');
    assert.deepEqual(it?.pk?.deviceId, 'SYNTH82', '열려 있는 동안 판정 재료를 새로 적는다');
    assert.equal(mails.length, 0, '확인한 장애에 단계가 다시 가지 않는다');
    // 평소 닫힘(또는 수동 닫기) — DB 의 마지막 이벤트가 닫힘 → 정리(D2 · N2) · 뒤에 같은 부품의 새 장애는 처음부터
    await DB.applyTransition({ ...tr0, closed: [{ ...pE, closeReason: 'manual', prevState: 'fault' }] }, { now: 90 * MIN });
    RUN._setEscalationDepsForTest(deps(91 * MIN));
    r = await RUN.runEscalationNow();
    assert.deepEqual(keys(), [], 'DB 의 닫힘 이벤트가 근거(수동 닫기 포함 — 13c N2)');
    await DB.applyTransition({ ...tr0, opened: [{ ...pE, firstSeenAt: 30 * 1440 * MIN, lastSeenAt: 30 * 1440 * MIN }] }, { now: 30 * 1440 * MIN });
    RUN._setEscalationDepsForTest(deps(30 * 1440 * MIN + MIN));
    r = await RUN.runEscalationNow();
    const fresh = JSON.parse(fs.readFileSync(STATE, 'utf8')).items['edge1|k2'];
    assert.deepEqual([fresh?.ackedAt, fresh?.sent?.length, fresh?.since], [null, 0, 30 * 1440 * MIN + MIN], '새 장애는 처음부터(D2)');
    // D3 — 닫힘 이력을 못 읽으면 회차를 건너뛰고 기록을 지우지 않는다(열린 장애에 없는 기록이 있을 때)
    const st1 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    st1.items['|kz'] = { since: MIN, sig: 'x', sent: [], ackedAt: 2 * MIN, ackBy: 'oper', pol: 'pf', ps: {} };
    fs.writeFileSync(STATE, JSON.stringify(st1)); E._resetEscalationStateForTest();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(DB_PATH);
    raw.exec('ALTER TABLE part_event RENAME TO part_event_gone');
    raw.close();
    assert.equal(await DB.partFaultClosedKeysOrNull(['|kz']), null);
    const before = fs.readFileSync(STATE, 'utf8');
    r = await RUN.runEscalationNow();
    assert.match(r.errors.join(' '), /닫힘 이력을 읽지 못했습니다/);
    assert.equal(fs.readFileSync(STATE, 'utf8'), before, '기록을 그대로 둔다(D3)');
  } finally { RUN._setEscalationDepsForTest(null); CE._resetJudgedClosedForTest(); }
});
