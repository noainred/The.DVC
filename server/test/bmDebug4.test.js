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

test('8회차 판정 #1 · #3 — 설정을 못 읽은 회차도 닫힌 장애 기록은 정리한다(키 이전 후보는 남김) · DB 파일이 없는 노드에는 만들지 않는다', async () => {
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const partB = { ...part, partKey: 'k2', partId: 'p2' };
  const moved = { ...part, partKey: 'k3' };   // k1 과 같은 sig — 키만 바뀐 같은 장애
  const st0 = { v: 1, enabledAt: 1, items: {
    '|k1': { since: 0, sig: E.partSigOf(part), sent: [[0, 15 * MIN, 'x', 'ok', 'pf']], ackedAt: 20 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 0 } },
    '|k2': { since: 0, sig: E.partSigOf(partB), sent: [[0, 15 * MIN, 'x', 'ok', 'pf']], ackedAt: 20 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 0 } } } };
  fs.writeFileSync(STATE, JSON.stringify(st0));
  fs.rmSync(SET, { recursive: true, force: true }); fs.mkdirSync(SET);   // 설정 읽기 오류
  E._resetEscalationStateForTest(); E.escalationStore._resetForTest();
  RUN._setEscalationDepsForTest({ now: () => 100 * MIN, open: async () => [moved], partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async () => ({ ok: true }), channels: async () => [] });
  try {
    const r = await RUN.runEscalationNow();
    assert.equal(r.why, 'settings-unreadable');
    const items = JSON.parse(fs.readFileSync(STATE, 'utf8')).items;
    assert.deepEqual(Object.keys(items).sort(), ['|k1'], 'k2(닫힘)는 지우고 · k1 은 열린 장애 k3 와 같은 sig 라 남긴다(키 이전)');
    // 행 표지 — 설정을 못 읽으면 ‘꺼짐 · 정책 밖’ 이 아니라 그 사유(확인은 된다)
    assert.deepEqual(await RUN.escalationMarksNow(), { why: 'settings-unreadable', heldKeys: new Set() });
    const m = E.escalationMarkOf(part, items, E.escalationStore.get(), { why: 'settings-unreadable', heldKeys: new Set() });
    assert.deepEqual([m.paused, m.step, m.acked], ['settings-unreadable', null, true]);   // 9회차 화면 U2 — 정책을 모르므로 단계 수를 말하지 않는다
  } finally { RUN._setEscalationDepsForTest(null); fs.rmSync(SET, { recursive: true, force: true }); E.escalationStore._resetForTest(); }
  // DB 파일이 없는 노드 — 기본 open 은 파일을 만들지 않는다
  fs.rmSync(DB_PATH, { recursive: true, force: true });
  fs.writeFileSync(SET, JSON.stringify({ v: 1, enabled: true, enabledAt: 1, policies: [F], oncall: {}, at: 1, by: 'admin' }));
  E._resetEscalationStateForTest(); E.escalationStore._resetForTest();
  RUN._setEscalationDepsForTest({ now: () => 200 * MIN, partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async () => ({ ok: true }), channels: async () => [] });
  try {
    await RUN.runEscalationNow();
    assert.equal(fs.existsSync(DB_PATH), false, '부품 장애 DB 를 새로 만들지 않는다');
  } finally { RUN._setEscalationDepsForTest(null); }
});

test('8회차 화면 U2 — 건너뛴 단계는 알림 본문과 회차 결과 줄에 밝힌다(화면 설명의 ‘결과에 밝힙니다’)', async () => {
  const R = await import('../src/partfault/escalationRun.js');
  const m = R.escalationMessage({ part, policy: { id: 'pf', name: 'fault' }, step: 2, skipped: [0, 1], attempt: 1, since: 0, to: { emails: [], channels: false, oncall: null } }, 300 * MIN);
  assert.match(m.text || m.body || JSON.stringify(m), /2 · 3단계는 시각이 지난 뒤 처음 본 회차라 보내지 않았습니다\(건너뜀\)/);
  const W = await import('../../web/src/views/tools/partFaultEscText.js');
  assert.equal(W.escRunResults({ results: [{ part: 'synth-71 · disk', step: 4, skipped: [2, 3], result: '메일 1명', delivered: true }] })[0].text, 'synth-71 · disk · 4단계(2 · 3단계 건너뜀) · 메일 1명');
});

test('9회차 보안 #1 · #2 — DB 자리를 읽지 못하면(ELOOP 등 ENOENT 아님) ‘없음’ 이 아니다: 회차를 건너뛰고 기록을 지우지 않는다 · 확인 단추는 쓰기 범위도 본다', async () => {
  const E = await import('../src/partfault/escalation.js');
  const RUN = await import('../src/partfault/escalationRun.js');
  const DB = await import('../src/partfault/db.js');
  fs.rmSync(DB_PATH, { recursive: true, force: true });
  fs.symlinkSync(path.basename(DB_PATH), DB_PATH);   // 자기 자신을 가리키는 링크 — stat ELOOP(루트에서도)
  try {
    assert.deepEqual([DB.partFaultDbExists(), DB.partFaultDbMissing()], [false, false], 'existsSync 는 false 지만 없는 것은 아니다');
    const before = { v: 1, enabledAt: 1, items: { '|k1': { since: 0, sig: E.partSigOf(part), sent: [[0, 15 * MIN, 'x', 'ok', 'pf']], ackedAt: 20 * MIN, ackBy: 'oper', pol: 'pf', ps: { pf: 0 } } } };
    fs.writeFileSync(STATE, JSON.stringify(before));
    fs.rmSync(SET, { recursive: true, force: true });
    fs.writeFileSync(SET, JSON.stringify({ v: 1, enabled: true, enabledAt: 1, policies: [F], oncall: {}, at: 1, by: 'admin' }));
    E._resetEscalationStateForTest(); E.escalationStore._resetForTest();
    RUN._setEscalationDepsForTest({ now: () => 300 * MIN, partFaultSwitch: async () => ({ enabled: true, source: '' }), hold: async () => ({ hold: null, keyOf: null }), mail: async () => ({ ok: true }), channels: async () => [] });
    const r = await RUN.runEscalationNow();
    assert.match(r.errors.join(' '), /열린 장애를 읽지 못했습니다/);
    assert.deepEqual(JSON.parse(fs.readFileSync(STATE, 'utf8')), before, '확인 · 보낸 단계 기록을 지우지 않는다');
  } finally { RUN._setEscalationDepsForTest(null); fs.rmSync(DB_PATH, { force: true }); }
  const { stripComments } = await import('./_stripComments.js');
  const route = stripComments(fs.readFileSync(new URL('../src/routes/api/partFaults.js', import.meta.url), 'utf8'));
  assert.match(route, /canAck: \['admin', 'operator'\]\.includes\(req\.user\?\.role\) && !isDemoGuest\(req\.user\) && \(\(\) => \{ try \{ return isFullReadWriteScope\(req\.user, store\.get\(\)\); \} catch \{ return false; \} \}\)\(\),/, '확인 라우트와 같은 판정(쓰기 범위 일부면 단추 없음)');
});

test('9회차 화면 U3 — 첫 시도가 안 가 다시 보내는 회차의 본문 · 결과 줄에도 건너뛴 단계를 밝힌다', async () => {
  const E = await import('../src/partfault/escalation.js');
  const R = await import('../src/partfault/escalationRun.js');
  const S = { enabled: true, enabledAt: 1, oncall: {}, policies: [F] };
  const st = { items: { '|k1': { since: 0, sig: 'x', sent: [], ackedAt: null, ackBy: '', pol: 'pf', ps: { pf: 0 } } }, enabledAt: 1 };
  let pl = E.escalationPlan({ settings: S, state: st, open: [part], now: 300 * MIN });
  assert.deepEqual([pl.sends[0].step, pl.sends[0].skipped, pl.sends[0].skippedNote], [2, [0, 1], [0, 1]]);
  const items = E.recordSends(pl.items, pl.sends, [{ delivered: false, text: '안 감' }], 300 * MIN);   // 첫 시도 실패 — skip 줄이 먼저 적힌다
  pl = E.escalationPlan({ settings: S, state: { items, enabledAt: 1 }, open: [part], now: 301 * MIN });
  assert.deepEqual([pl.sends[0].step, pl.sends[0].skipped, pl.sends[0].skippedNote], [2, [], [0, 1]], '다시 시도 — 새로 적을 skip 은 없지만 밝힐 건너뜀은 그대로');
  assert.match(R.escalationMessage(pl.sends[0], 301 * MIN).detail, /2 · 3단계는 시각이 지난 뒤 처음 본 회차라 보내지 않았습니다/);
});
