// 물리서버 기능 디버깅 회차 7(v3.52 — 6회차 수정 반영본 251bd269c · 5축 × 1인) 회귀. 6회차 수정의 회귀(설정을 못 읽은 회차에 옛 기록 lp 가 빈 목록으로 굳음)와
//   남은 경로(부품 장애 DB 를 못 열면 ‘열린 장애 0건’ 으로 기록을 지움 · 제조사 + 세대뿐인 권고 줄)를 동작으로 고정한다. 픽스처는 합성(SYNTH · example.test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdebug4-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
const DB_PATH = path.join(tmp, 'part-faults.db');
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', PARTFAULT_DB_PATH: DB_PATH });
delete process.env.CENTRAL_URL;

const MIN = 60_000;
const SET = path.join(tmp, 'partfault-escalation.json');
const STATE = path.join(tmp, 'partfault-escalation-state.json');
const step = (a, m) => ({ afterMin: a, emails: [m], channels: false, oncall: false });
const F = { id: 'pf', name: 'fault', agents: [], states: ['fault'], steps: [step(15, 'a1@example.test'), step(60, 'amgr@example.test'), step(240, 'adir@example.test')] };
const part = { agent: '', partKey: 'k1', state: 'fault', scope: 'idrac', deviceId: 'SYNTH71', kind: 'disk', partId: 'p1', deviceName: 'synth-71', label: 'disk' };

test('7회차 판정 #3 — 부품 장애 DB 를 못 열면 그 회차를 건너뛴다(진행 · 확인 기록을 지우지 않음 · ‘열린 장애 0건’ 이 아니다)', async () => {
  fs.mkdirSync(DB_PATH);   // DB 자리에 폴더 — 열기 실패
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const DB = await import('../src/partfault/db.js');
  assert.equal(await DB.openFaultsOrNull(), null, 'DB 를 못 열면 null(빈 목록이 아니다)');
  fs.writeFileSync(SET, JSON.stringify({ v: 1, enabled: true, enabledAt: 1, policies: [F], oncall: {}, at: 1, by: 'admin' }));
  const before = { v: 1, enabledAt: 1, items: { '|k1': { since: 0, sig: E.partSigOf(part), sent: [[0, 15 * MIN, 'x', 'ok', 'pf']], ackedAt: 20 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 0 } } } };
  fs.writeFileSync(STATE, JSON.stringify(before));
  E._resetEscalationStateForTest(); E.escalationStore._resetForTest();
  const mails = [];
  // open 은 기본(실제 DB) — 나머지만 바꾼다
  RUN._setEscalationDepsForTest({ now: () => 100 * MIN, partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async (o) => { mails.push(o.to); return { ok: true }; }, channels: async () => [] });
  try {
    const r = await RUN.runEscalationNow();
    assert.equal(r.sent, 0);
    assert.match(r.errors.join(' '), /열린 장애를 읽지 못했습니다/);
    assert.deepEqual(JSON.parse(fs.readFileSync(STATE, 'utf8')), before, '진행 · 확인 기록을 그대로 둔다');
    assert.equal(mails.length, 0);
  } finally { RUN._setEscalationDepsForTest(null); fs.rmSync(DB_PATH, { recursive: true, force: true }); }
});

test('7회차 판정 #1 — 단계 · 당직 설정을 못 읽은 회차는 계획 · 저장을 하지 않는다(옛 v3.51 기록의 그때 정책이 빈 목록으로 굳지 않음)', async () => {
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const legacy = { v: 1, enabledAt: 1, items: { '|k1': { since: 0, sig: E.partSigOf(part), sent: [[0, 15 * MIN, 'x', 'ok'], [1, 60 * MIN, 'x', 'ok']], ackedAt: null, ackBy: '' } } };
  fs.writeFileSync(STATE, JSON.stringify(legacy));
  fs.rmSync(SET, { force: true }); fs.mkdirSync(SET);   // 설정 자리에 폴더 — 읽기 오류
  E._resetEscalationStateForTest(); E.escalationStore._resetForTest();
  RUN._setEscalationDepsForTest({ now: () => 100 * MIN, open: async () => [part], partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async () => ({ ok: true }), channels: async () => [] });
  try {
    assert.ok(E.escalationStore.loadError(), '설정 읽기 오류');
    const r = await RUN.runEscalationNow();
    assert.deepEqual([r.why, r.sent], ['settings-unreadable', 0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(STATE, 'utf8')), legacy, '옛 기록에 lp · pol 을 적지 않는다');
    assert.deepEqual(RUN.escalationRunMarks(), { why: 'settings-unreadable', heldKeys: new Set() });
  } finally { RUN._setEscalationDepsForTest(null); fs.rmSync(SET, { recursive: true, force: true }); E.escalationStore._resetForTest(); }
});

test('7회차 판정 #2 — 제조사 + 세대 · 판 낱말뿐인 권고 줄(제품군 · 모델 없음)은 올릴 때 거절한다', async () => {
  const A = await import('../src/bmcheck/advisory.js');
  const csv = 'advisory_id,component_type,model,fixed_version\nB1,BIOS,Fujitsu M5,1.4\nB2,BIOS,Cisco M6,1.4\nB3,BIOS,HPE Gen10,1.4\nB4,BIOS,PRIMERGY M5,1.4\nB5,BIOS,RX2540 M5,1.4\nB6,BIOS,ProLiant Gen10,1.4\n';
  const r = A.parseAdvisoryCsv(csv);
  assert.deepEqual(r.rows.map((x) => x.id), ['B4', 'B5', 'B6'], '제품군 · 모델이 있는 줄만 받는다');
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4]);
  assert.match(r.errors[0].reason, /세대 · 판 낱말/);
});
