// 부품 장애 알림 단계 올리기 · 당직(v3.51 — 설계 docs/design/bm-feature-proposals ⑪).
//   설정 검증(저장 거절 사유 · 원형 열쇠 · 개수 · 중복) · 손상/모르는 꼴은 쓰기 거절 · 정책 대상으로 처음 본 때부터 셈(켬 · 정책 수정 · 상태 왕복 · 키 이전 · 다시 켬) ·
//   가장 높은 단계 하나 · 확인하면 멈춤(회차 중 확인도) · 안 간 발송은 다시(상한) · 꺼짐 · 점검 꺼짐 · 데모 · 정비 창 · 한 회차 상한 · 기록 상한 · 진행 기록 손상/읽기 오류 ·
//   당직(수집 주체 → 모두 · 요일) · 라우트 게이트(확인 = 도구 권한 · 운영자 이상 · 전체 범위 · 설정 = 관리자 · 전체 범위) · 감사 · 가린 행의 표지.
//   반증 A(20건) · B(서버 S1~S4)의 재현 경로를 담는다. 픽스처 식별자 · 주소는 합성(SYNTH · example.test · 192.0.2.x).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfesc351-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
delete process.env.CENTRAL_URL;

const E = await import('../src/partfault/escalation.js');
const RUN = await import('../src/partfault/escalationRun.js');

const MIN = 60_000;
const DAY7 = Array.from({ length: 7 }, (_, i) => ({ name: `당직${i}`, email: `oncall${i}@example.test` }));
const POL = (over = {}) => ({ id: 'p1', name: '이상', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['lead@example.test'], channels: false, oncall: false }, { afterMin: 30, emails: [], channels: true, oncall: true }], ...over });
const PART = (over = {}) => ({ agent: '', partKey: 'idrac:SYNTH01:psu:PSU.Slot.1', scope: 'idrac', kind: 'psu', partId: 'PSU.Slot.1', label: 'PSU 1', deviceName: 'synth-db-01', deviceId: 'SYNTH01', state: 'fault', firstSeenAt: 0, ...over });
const S = (over = {}) => ({ enabled: true, enabledAt: 100 * MIN, policies: [POL()], oncall: { '*': { days: DAY7 } }, ...over });
const K = (p = PART()) => E.partKeyOf(p);
/** 한 회차를 순수 함수로 — plan + 결과 기록. */
const step = (settings, state, open, now, delivered = true) => {
  const pl = E.escalationPlan({ settings, state, open, now });
  const items = E.recordSends(pl.items, pl.sends, pl.sends.map(() => ({ text: delivered ? '감' : '안 감', delivered })), now);
  return { sends: pl.sends, state: { items, enabledAt: pl.enabledAt }, plan: pl };
};

test('설정 검증 — 분(5~1440 · 늘어나야) · 메일(줄바꿈 · 공백 없음) · 상태 · 수집 주체(한글 · 공백 가능 · 쉼표 · 원형 이름 불가) · 받는 곳 · 개수 · 중복 · 켜려면 정책', () => {
  const ok = E.normalizeEscalation({ enabled: true, policies: [POL({ agents: ['PL Edge', '서울엣지'] })], oncall: JSON.parse(JSON.stringify({ '*': { days: DAY7 }, 'PL-Edge': { days: DAY7 } })) });
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual([ok.value.policies[0].agents, Object.keys(ok.value.oncall)], [['pl edge', '서울엣지'], ['*', 'pl-edge']]);
  const bad = (p, re) => { const r = E.normalizeEscalation(p); assert.equal(r.ok, false, JSON.stringify(p).slice(0, 80)); assert.match(r.reason, re); };
  bad({ enabled: true, policies: [] }, /켜려면 정책이/);
  bad({ policies: [POL({ steps: [{ afterMin: 3, channels: true }] })] }, /5~1440/);
  bad({ policies: [POL({ steps: [{ afterMin: 30, channels: true }, { afterMin: 20, channels: true }] })] }, /앞 단계보다 커야/);
  bad({ policies: [POL({ steps: [{ afterMin: 15.5, channels: true }] })] }, /정수/);
  bad({ policies: [POL({ steps: [{ afterMin: '', channels: true }] })] }, /정책 1 · 2단계/);
  for (const m of ['not-mail', 'a b@example.test', 'a@example.test\r\nBcc: x@example.test', 'a\n@example.test']) bad({ policies: [POL({ steps: [{ afterMin: 15, emails: [m] }] })] }, /메일 주소가 틀렸습니다/);
  bad({ policies: [POL({ steps: [{ afterMin: 15, emails: [], channels: false, oncall: false }] })] }, /받는 곳/);
  bad({ policies: [POL({ states: [] })] }, /대상 상태/);
  bad({ policies: [POL({ states: ['fault', 'evil'] })] }, /모르는 대상 상태/);
  bad({ policies: [POL({ agents: ['a,b'] })] }, /수집 주체 이름/);
  bad({ policies: [POL({ agents: ['__proto__'] })] }, /수집 주체 이름/);
  bad({ policies: [POL({ agents: Array.from({ length: 70 }, (_, i) => `e${i}`) })] }, /64개까지/);
  bad({ policies: [POL({ steps: Array.from({ length: 5 }, (_, i) => ({ afterMin: 10 + i, channels: true })) })] }, /4개까지/);
  bad({ policies: Array.from({ length: 21 }, () => POL()) }, /20개까지/);
  bad({ policies: [POL()], oncall: { '*': { days: [{ name: 'x', email: 'bad' }] } } }, /당직표 모두 · 월요일/);
  bad({ policies: [POL()], oncall: JSON.parse('{"__proto__":{"days":[]}}') }, /당직표/);
  // 중복을 지운 뒤 개수를 센다 — 11개(중복 1) = 10개 · 12개(중복 1) = 거절(조용히 빠지지 않는다)
  const em = (n) => Array.from({ length: n }, (_, i) => `a${i}@example.test`);
  assert.equal(E.normalizeEscalation({ policies: [POL({ steps: [{ afterMin: 15, emails: [...em(10), 'a0@example.test'] }] })] }).ok, true);
  bad({ policies: [POL({ steps: [{ afterMin: 15, emails: [...em(11), 'a0@example.test'] }] })] }, /10개까지/);
  // 대체 id 도 겹치지 않는다
  const ids = E.normalizeEscalation({ policies: [POL({ id: 'p2' }), POL({ id: 'BAD!' })] }).value.policies.map((p) => p.id);
  assert.equal(new Set(ids).size, 2, ids.join(','));
  // 읽기(lenient)는 틀린 줄을 버린다
  const sh = E.escalationShape({ v: 1, enabled: true, enabledAt: 5, policies: [POL(), { states: [] }, 'x'], oncall: { 'bad,agent': { days: DAY7 } } });
  assert.deepEqual([sh.enabled, sh.policies.length, Object.keys(sh.oncall)], [true, 1, []]);
});

test('저장 — 켜는 순간을 enabledAt 으로 · 켜진 채 고치면 유지 · 끄면 지움 · 손상 · 모르는 판은 꺼짐 + 쓰기 거절(보존)', () => {
  E.escalationStore._resetForTest();
  const a = E.escalationStore.save({ enabled: true, policies: [POL()] }, { by: 'admin', now: 1000 });
  assert.deepEqual([a.ok, a.value.enabledAt, a.turnedOn], [true, 1000, true]);
  const b = E.escalationStore.save({ enabled: true, policies: [POL({ name: '고침' })] }, { by: 'admin', now: 2000 });
  assert.deepEqual([b.value.enabledAt, b.value.policies[0].name, b.turnedOn], [1000, '고침', false]);
  assert.equal(E.escalationStore.save({ enabled: false, policies: [POL()] }, { now: 3000 }).value.enabledAt, null);
  assert.equal(E.escalationStore.save({ enabled: true, policies: [] }).status, 400);
  const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    for (const body of ['{oops', JSON.stringify({ v: 2, enabled: true }), JSON.stringify([1])]) {
      E.escalationStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'partfault-escalation.json'), body);
      assert.equal(E.escalationStore.get().enabled, false, '못 읽으면 꺼짐');
      assert.equal(E.escalationStore.save({ enabled: false, policies: [] }).status, 409, body);
      const kept = fs.readdirSync(tmp).filter((f) => f.startsWith('partfault-escalation.json'));
      assert.ok(kept.some((f) => fs.readFileSync(path.join(tmp, f), 'utf8') === body), '손상본 보존');
      for (const f of kept) fs.rmSync(path.join(tmp, f), { force: true });
    }
  } finally { console.error = w; console.warn = ww; E.escalationStore._resetForTest(); }
});

test('판정 — 정책 대상으로 처음 본 때부터 셈(켬 · 정책 수정) · 분 · 가장 높은 단계 하나 · 확인 · 꺼짐 · 닫힌 장애 정리 · 한 회차 상한 · 기록 상한', () => {
  // 오래된 장애(firstSeenAt 0)도 처음 본 때(101분)부터 — 켜자마자 · 정책을 고치자마자 쏟아지지 않는다(반증 A2)
  let r = step(S(), { items: {} }, [PART()], 101 * MIN);
  assert.equal(r.sends.length, 0);
  assert.equal(r.state.items[K()].since, 101 * MIN);
  // 장애 시각(firstSeenAt)이 0 이 아니어도 처음 본 때부터(변이 N13 — 0 은 거짓 값이라 위 픽스처로는 못 가른다)
  const fs50 = step(S(), { items: {} }, [PART({ firstSeenAt: 50 * MIN })], 101 * MIN);
  assert.deepEqual([fs50.sends.length, fs50.state.items[K()].since], [0, 101 * MIN]);
  r = step(S(), r.state, [PART()], 116 * MIN);
  assert.deepEqual(r.sends.map((s) => [s.step, s.skipped, s.to.emails]), [[0, [], ['lead@example.test']]]);
  const r2 = step(S(), r.state, [PART()], 120 * MIN);
  assert.equal(r2.sends.length, 0, '보낸 단계는 다시 보내지 않는다');
  const r3 = step(S(), r2.state, [PART()], 131 * MIN);
  assert.deepEqual(r3.sends.map((s) => [s.step, s.to.channels, !!s.to.oncall]), [[1, true, true]]);
  // 켜진 채 상태를 더한 정책 — 오래된 주의 장애도 지금부터 센다
  const warn = PART({ partKey: 'k-warn', state: 'warn', firstSeenAt: 0 });
  const rw = step(S({ policies: [POL({ states: ['fault', 'warn'] })] }), { items: {}, enabledAt: 100 * MIN }, [warn], 5000 * MIN);
  assert.equal(rw.sends.length, 0, '정책을 고친 직후 옛 장애에 쏟아지지 않는다');
  // 엔진이 멈춰 있던 동안 두 단계가 지났다 — 가장 높은 단계 하나만, 낮은 단계는 건너뜀
  const p3 = E.escalationPlan({ settings: S(), state: { items: { [K()]: { since: 100 * MIN, sig: E.partSigOf(PART()), sent: [], ackedAt: null, ackBy: '' } }, enabledAt: 100 * MIN }, open: [PART()], now: 200 * MIN });
  assert.deepEqual(p3.sends.map((s) => [s.step, s.skipped]), [[1, [0]]]);
  const it3 = E.recordSends(p3.items, p3.sends, [{ text: '채널 감', delivered: true }], 200 * MIN)[K()];
  assert.deepEqual(it3.sent.map((e) => [e[0], e[3]]), [[0, 'skip'], [1, 'ok']]);
  assert.deepEqual([E.escalationMarkOf(PART(), { [K()]: it3 }).step, E.escalationMarkOf(PART(), { [K()]: it3 }).tried], [3, undefined]);
  // 확인하면 멈춘다
  const acked = { [K()]: { since: 100 * MIN, sig: '', sent: [], ackedAt: 110 * MIN, ackBy: 'oper1' } };
  assert.equal(E.escalationPlan({ settings: S(), state: { items: acked, enabledAt: 100 * MIN }, open: [PART()], now: 300 * MIN }).sends.length, 0);
  // 꺼짐 — 보내지 않되 닫힌 장애의 기록은 지운다(다시 열린 장애가 옛 확인을 물려받지 않게 — 반증 A5)
  const off = E.escalationPlan({ settings: S({ enabled: false }), state: { items: { ...acked, 'x|gone': { since: 1, sig: 'g', sent: [] } } }, open: [PART()], now: 300 * MIN });
  assert.deepEqual([off.sends.length, Object.keys(off.items)], [0, [K()]]);
  // 한 회차 상한 · 기록 상한
  const many = Array.from({ length: 25 }, (_, i) => PART({ partKey: `k${i}`, partId: `p${i}` }));
  const st = step(S(), { items: {}, enabledAt: 100 * MIN }, many, 100 * MIN).state;
  const pm = E.escalationPlan({ settings: S(), state: st, open: many, now: 120 * MIN, maxSends: 20 });
  assert.deepEqual([pm.sends.length, pm.deferred], [20, 5]);
  const cap = E.escalationPlan({ settings: S(), state: { items: {}, enabledAt: 100 * MIN }, open: Array.from({ length: E.ESC_ITEMS_MAX + 3 }, (_, i) => PART({ partKey: `c${i}`, partId: `c${i}` })), now: 100 * MIN });
  assert.deepEqual([Object.keys(cap.items).length, cap.overCap], [E.ESC_ITEMS_MAX, 3], '기록할 수 없는 장애에는 보내지 않는다(반증 A7)');
});

test('판정 — 상태 왕복 · 키 이전 · 다시 켬에서 보낸 단계를 다시 보내지 않는다 · 정비 창 보류', () => {
  // 이상 ↔ 주의 왕복(정책은 이상만) — 열려 있는 동안 기록을 둔다(반증 A3)
  let r = step(S(), { items: {}, enabledAt: 100 * MIN }, [PART()], 100 * MIN);
  r = step(S(), r.state, [PART()], 131 * MIN);   // 3단계(건너뜀 2단계)까지
  assert.deepEqual(r.sends.map((s) => s.step), [1]);
  r = step(S(), r.state, [PART({ state: 'warn' })], 140 * MIN);
  assert.ok(r.state.items[K()], '주의일 때도 기록이 남는다');
  r = step(S(), r.state, [PART()], 141 * MIN);
  assert.equal(r.sends.length, 0, '다시 이상이 돼도 보낸 단계를 다시 보내지 않는다');
  // 장비 키 이전(같은 수집 주체 · 장비 id · 종류 · 부품) — 기록 · 확인을 이어받는다(반증 A4)
  const ack = { ...step(S(), { items: {}, enabledAt: 100 * MIN }, [PART()], 100 * MIN).state.items };
  ack[K()] = { ...ack[K()], ackedAt: 105 * MIN, ackBy: 'oper1' };
  const moved = PART({ partKey: 'idrac:TAGNEW:psu:PSU.Slot.1' });
  const mv = E.escalationPlan({ settings: S(), state: { items: ack, enabledAt: 100 * MIN }, open: [moved], now: 300 * MIN });
  assert.deepEqual([mv.sends.length, mv.items[K(moved)].ackedAt, Object.hasOwn(mv.items, K())], [0, 105 * MIN, false]);
  // 껐다 다시 켬 — 확인하지 않은 기록은 지금부터 다시 센다(켜자마자 높은 단계 금지 — 반증 A5)
  const pol3 = POL({ steps: [{ afterMin: 15, channels: true }, { afterMin: 30, channels: true }, { afterMin: 45, channels: true }] });
  let st = step(S({ policies: [pol3] }), { items: {}, enabledAt: 100 * MIN }, [PART()], 100 * MIN).state;
  st = step(S({ policies: [pol3] }), st, [PART()], 116 * MIN).state;
  const re = step(S({ policies: [pol3], enabledAt: 500 * MIN }), st, [PART()], 501 * MIN);
  assert.deepEqual([re.sends.length, re.state.items[K()].since], [0, 501 * MIN]);
  // 정비 창 보류 장비 — 보내지 않는다(기록은 둔다)
  const h = E.escalationPlan({ settings: S(), state: { items: { [K()]: { since: 100 * MIN, sig: '', sent: [] } }, enabledAt: 100 * MIN }, open: [PART()], now: 200 * MIN, hold: new Set(['|SYNTH01']), holdKeyOf: (a, d) => `${a}|${d}` });
  assert.deepEqual([h.sends.length, h.held, !!h.items[K()]], [0, 1, true]);
});

test('안 간 발송 — 다시 시도(상한) · 표지는 ‘보냄’ 과 ‘안 감’ 을 가른다(반증 A8 · B1)', () => {
  let r = step(S(), { items: {}, enabledAt: 100 * MIN }, [PART()], 100 * MIN);
  for (let i = 0; i < E.ESC_RETRY_MAX; i += 1) { r = step(S(), r.state, [PART()], (116 + i) * MIN, false); assert.equal(r.sends.length, 1, `시도 ${i + 1}`); }
  assert.equal(step(S(), r.state, [PART()], 125 * MIN, false).sends.length, 0, '상한 뒤 그만');
  const m = E.escalationMarkOf(PART(), r.state.items);
  assert.deepEqual([m.step, m.tried, m.gaveUp], [null, 2, true], '그만둔 단계');
  // 다시 시도 중(한 번 실패) — 그만둠 표지가 없다
  const one = step(S(), step(S(), { items: {}, enabledAt: 100 * MIN }, [PART()], 100 * MIN).state, [PART()], 116 * MIN, false);
  const m1 = E.escalationMarkOf(PART(), one.state.items);
  assert.deepEqual([m1.tried, m1.gaveUp], [2, undefined]);
  assert.deepEqual(r.state.items[K()].sent.map((e) => e[3]), ['fail', 'fail', 'give']);
});

test('당직 — 그 수집 주체 표의 그 요일 → 모두 표 · 원형 이름 열쇠 무시', () => {
  const ST = { oncall: { '*': { days: DAY7 }, 'pl-edge': { days: DAY7.map((d, i) => ({ name: i === 1 ? '' : `PL${i}`, email: '' })) } } };
  const mon = new Date(2026, 10, 23, 12).getTime();   // 2026-11-23 월요일(이 서버 시각)
  assert.deepEqual(E.oncallFor(ST, 'PL-Edge', mon), { name: 'PL0', email: '', agent: 'pl-edge', day: 'mon' });
  assert.equal(E.oncallFor(ST, 'PL-Edge', mon + 86_400_000).name, '당직1', '그 주체 표의 화요일이 비어 있으면 모두 표');
  assert.equal(E.oncallFor(ST, '', mon + 6 * 86_400_000).name, '당직6');
  assert.equal(E.oncallFor({ oncall: {} }, 'constructor', mon), null, '원형 이름은 표가 아니다');
  assert.equal(E.oncallFor({ oncall: { '*': { days: Array.from({ length: 7 }, () => ({ name: '', email: '' })) } } }, '', mon), null);
});

test('확인 열쇠 — 키를 싣지 않음 · 수집 주체가 다르면 다른 열쇠 · 진행 기록 꼴(단계 번호 범위)', () => {
  const a = E.ackIdOf(PART()); const b = E.ackIdOf(PART({ agent: 'pl-edge' }));
  assert.notEqual(a, b, '다른 법인 엣지의 같은 파트 키');
  assert.ok(!a.includes('SYNTH01') && a.length === 22);
  assert.equal(E.partOfAckId([PART(), PART({ agent: 'pl-edge' })], b).agent, 'pl-edge');
  assert.equal(E.partOfAckId([PART()], ['x']), null);
  E._resetEscalationStateForTest();
  fs.writeFileSync(path.join(tmp, 'partfault-escalation-state.json'), JSON.stringify({ v: 1, items: { [K()]: { since: 5, sent: [[9, 1, 'x', 'ok'], [-1, 1, 'x', 'ok'], [0, 1, 'x', 'weird']] } } }));
  assert.deepEqual(E.loadEscalationState().items[K()].sent, [[0, 1, 'x', 'ok']]);
  E._resetEscalationStateForTest(); fs.rmSync(path.join(tmp, 'partfault-escalation-state.json'), { force: true });
});

test('실행 — 순차 · 받는 곳에 간 것만 보냄 · 회차 중 확인은 덮지 않고 보내지도 않음 · 점검 꺼짐 · 데모 · 진행 기록 손상(보존 · 지금부터) · 읽기 오류(보내지 않음) · 재진입 · 중앙만', async () => {
  E.escalationStore._resetForTest(); E._resetEscalationStateForTest();
  fs.rmSync(path.join(tmp, 'partfault-escalation-state.json'), { force: true });
  E.escalationStore.save({ enabled: true, policies: [POL()], oncall: { '*': { days: DAY7 } } }, { by: 'admin', now: 0 });
  const mails = []; const chans = [];
  let now = 0; let sw = { enabled: true, source: 'settings' };
  const P2 = PART({ partKey: 'k2', partId: 'p2' });
  const base = { open: async () => [PART(), P2], mail: async (o) => { mails.push(o); return { ok: true }; }, channels: async (a) => { chans.push(a); return ['slack:200']; }, now: () => now, partFaultSwitch: async () => sw, hold: async () => ({ hold: new Set(), keyOf: null }) };
  RUN._setEscalationDepsForTest(base);
  try {
    assert.equal((await RUN.runEscalationNow()).sent, 0, '처음 본 회차 — 지금부터 센다');
    now = 16 * MIN;
    // 회차 도중(첫 메일을 보내는 동안) 둘째 장애를 확인 — 둘째는 보내지 않고, 회차 끝 저장이 확인을 덮지 않는다(반증 A1)
    RUN._setEscalationDepsForTest({ ...base, mail: async (o) => { mails.push(o); if (mails.length === 1) E.ackEscalation(P2, { by: 'oper1', now }); return { ok: true }; } });
    const r1 = await RUN.runEscalationNow();
    assert.deepEqual([r1.sent, r1.delivered, mails.length], [1, 1, 1]);
    assert.match(mails[0].subject, /^\[2단계 · 확인 없음\] 파트 장애 — synth-db-01/);
    assert.equal(mails[0].kind, 'alert');
    assert.equal(E.loadEscalationState().items[E.partKeyOf(P2)].ackedAt, 16 * MIN, '회차 중 확인이 남는다');
    RUN._setEscalationDepsForTest(base);
    assert.equal((await RUN.runEscalationNow()).sent, 0);
    // 채널 억제 열쇠에 수집 주체(반증 A17)
    now = 31 * MIN;
    await RUN.runEscalationNow();
    assert.equal(chans.at(-1).key, `partfault-esc:|${PART().partKey}:1`);
    // 진행 기록 파일 — 다음 기동(메모리 비움)에도 다시 보내지 않는다
    E._resetEscalationStateForTest(); now = 60 * MIN;
    assert.equal((await RUN.runEscalationNow()).sent, 0);
    // 점검 꺼짐 · 데모로만 켜짐 — 보내지 않는다(반증 A12 · S1)
    E.escalationStore.save({ enabled: true, policies: [POL({ steps: [{ afterMin: 15, emails: [], channels: true, oncall: false }] })] }, { now: 0 });
    RUN._setEscalationDepsForTest({ ...base, open: async () => [PART({ partKey: 'k3', partId: 'p3' })] });
    await RUN.runEscalationNow(); now = 200 * MIN;
    for (const s2 of [{ enabled: false, source: 'settings' }, { enabled: true, source: 'demo' }]) {
      sw = s2; const n0 = chans.length;
      const r = await RUN.runEscalationNow();
      assert.deepEqual([r.sent, chans.length - n0, r.why], [0, 0, s2.enabled ? 'demo' : 'partfault-off']);
    }
    sw = { enabled: true, source: 'settings' };
    assert.equal((await RUN.runEscalationNow()).sent, 1);
    // 재진입 — 진행 중이면 건너뛴다
    let release; const gate = new Promise((r) => { release = r; });
    RUN._setEscalationDepsForTest({ ...base, open: async () => { await gate; return []; } });
    const pA = RUN.runEscalationNow(); const pB = await RUN.runEscalationNow();
    assert.deepEqual(pB, { skipped: 'busy' }); release(); await pA;
    // 진행 기록 손상 — 보존본을 남기고, 열린 장애는 지금부터(바로 쏟아지지 않는다 — 반증 A6)
    RUN._setEscalationDepsForTest(base);
    E._resetEscalationStateForTest(); fs.writeFileSync(path.join(tmp, 'partfault-escalation-state.json'), '{broken');
    const n1 = mails.length + chans.length;
    assert.equal((await RUN.runEscalationNow()).sent, 0);
    assert.equal(mails.length + chans.length, n1);
    assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('partfault-escalation-state.json.corrupt')), '손상본 보존');
    assert.match(E.escalationStateError(), /손상/);
    // 읽기 오류(없음이 아님) — 보내지도 쓰지도 않는다
    E._resetEscalationStateForTest();
    fs.rmSync(path.join(tmp, 'partfault-escalation-state.json'), { force: true }); fs.mkdirSync(path.join(tmp, 'partfault-escalation-state.json'));
    const ru = await RUN.runEscalationNow();
    assert.deepEqual([ru.sent, ru.why], [0, 'state-unreadable']);
    fs.rmSync(path.join(tmp, 'partfault-escalation-state.json'), { recursive: true, force: true });
    // 중앙만 — 엣지 노드는 타이머를 켜지 않는다
    const { config } = await import('../src/config.js');
    const prev = config.agent.centralUrl; config.agent.centralUrl = 'https://central.example.test';
    try { RUN.startEscalation(); assert.equal(RUN.escalationRunning(), false); } finally { config.agent.centralUrl = prev; }
  } finally { RUN._setEscalationDepsForTest(null); RUN._stopEscalationForTest(); E.escalationStore._resetForTest(); E._resetEscalationStateForTest(); }
});

test('실행 — 받는 곳에 가지 않으면 ‘안 감’(메일 꺼짐 · 켜진 채널 없음 · 채널 실패) · 하나라도 가면 ‘감’', async () => {
  E.escalationStore._resetForTest(); E._resetEscalationStateForTest();
  for (const f of ['partfault-escalation.json', 'partfault-escalation-state.json']) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  E.escalationStore.save({ enabled: true, policies: [POL({ steps: [{ afterMin: 15, emails: ['lead@example.test'], channels: true, oncall: false }] })] }, { now: 0 });
  let now = 0; let mail = { ok: false, reason: '메일 꺼짐' }; let chan = [];
  RUN._setEscalationDepsForTest({ open: async () => [PART()], mail: async () => mail, channels: async () => chan, now: () => now, partFaultSwitch: async () => ({ enabled: true, source: 'settings' }), hold: async () => ({ hold: new Set(), keyOf: null }) });
  try {
    await RUN.runEscalationNow(); now = 16 * MIN;
    const r1 = await RUN.runEscalationNow();
    assert.deepEqual([r1.sent, r1.delivered, r1.failed], [1, 0, 1]);
    assert.match(r1.results[0].result, /메일 안 감\(메일 꺼짐\)/); assert.match(r1.results[0].result, /채널 안 감\(켜진 채널 없음\)/);
    assert.equal(r1.results[0].delivered, false);
    chan = ['slack:err timeout']; now = 17 * MIN;
    const r2 = await RUN.runEscalationNow();
    assert.deepEqual([r2.delivered, r2.failed], [0, 1]); assert.match(r2.results[0].result, /채널 실패/);
    chan = ['slack:200']; now = 18 * MIN;
    const r3 = await RUN.runEscalationNow();
    assert.deepEqual([r3.delivered, r3.failed], [1, 0], '채널 하나라도 가면 감');
    assert.equal(E.escalationMarkOf(PART(), E.loadEscalationState().items).step, 2);
  } finally { RUN._setEscalationDepsForTest(null); RUN._stopEscalationForTest(); E.escalationStore._resetForTest(); E._resetEscalationStateForTest(); }
});

test('라우트 — 표지(가린 행도 원본 키로 · 열쇠는 키를 싣지 않음) · 확인 = 도구 권한 · 운영자 이상 · 전체 범위 · 404 · 감사 · 설정 = 관리자 · 전체 범위(운영자 PUT 403)', async () => {
  let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
  if (!sqlite) return;
  const pfDb = await import('../src/partfault/db.js');
  // IP 로 등록한 장비(비관리자 판본은 장비 식별자를 가린다) — 표지는 가리기 전 원본 키로 만든다(반증 P06)
  const IPP = PART({ partKey: 'idrac:192.0.2.40:psu:PSU.Slot.1', deviceId: '192.0.2.40', deviceName: '192.0.2.40' });
  await pfDb.applyTransition({ opened: [{ ...IPP, deviceKey: '192.0.2.40', deviceKeyKind: 'localId', keyKind: 'fqdd', detail: '', rawState: 'Critical' }] }, { now: 1_790_000_000_000 });
  fs.writeFileSync(path.join(tmp, 'idrac.json'), JSON.stringify({ servers: [{ id: '192.0.2.40', name: '192.0.2.40', host: 'https://192.0.2.40', username: 'u', password: 'p' }] }));
  const { registerPartFaults } = await import('../src/routes/api/partFaults.js');
  const routes = new Map();
  registerPartFaults({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h), put: (p, ...h) => routes.set(`PUT ${p}`, h) });
  const U = (username, role, vcenters = []) => ({ username, role, scope: { vcenters, regions: [], writeVcenters: [] }, tokenVersion: 0 });
  const ADMIN = U('admin', 'admin'); const OPER = U('oper1', 'operator'); const VIEWER = U('viewer1', 'viewer'); const SCOPED = U('scoped', 'admin', ['vc-a']);
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
  const call = async (key, { user = ADMIN, body = {}, query = {} } = {}) => {
    const res = { statusCode: 200, body: undefined, headersSent: false, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; }, set() { return this; }, setHeader() {} };
    const req = { user, body, query, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0] };
    for (const h of routes.get(key)) {
      let called = false;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => { const nx = (err) => { if (err) reject(err); else { called = true; resolve(); } }; Promise.resolve(h(req, res, nx)).then(() => { if (!called) resolve(); }, reject); });
      if (!called || res.headersSent) break;
    }
    return res;
  };
  const audit = () => { try { return fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x).action); } catch { return []; } };
  try {
    // 앞 시험(실행)이 남긴 설정 · 진행 기록을 지운다 — 이 시험은 ‘꺼짐’ 에서 시작한다
    for (const f of ['partfault-escalation.json', 'partfault-escalation-state.json']) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
    E._resetEscalationStateForTest(); E.escalationStore._resetForTest();
    const list = (await call('GET /tools/part-faults', { user: OPER })).body;
    const row = list.open.find((x) => x.partId === 'PSU.Slot.1');
    assert.ok(!JSON.stringify(row).includes('192.0.2.40'), '비관리자 판본은 장비 주소를 가린다');
    assert.equal(row.esc.ackId, E.ackIdOf(IPP), '표지는 가리기 전 원본 키로');
    assert.deepEqual([row.esc.acked, row.esc.covered, list.canAck, list.escalation.enabled], [false, false, true, false]);
    const gv = await call('GET /tools/part-faults', { user: VIEWER });
    assert.ok(gv.statusCode === 403 || gv.body.canAck === false, `조회 계정: ${gv.statusCode}`);
    assert.equal((await call('POST /tools/part-faults/ack', { user: VIEWER, body: { ackId: row.esc.ackId } })).statusCode, 403);
    assert.equal((await call('POST /tools/part-faults/ack', { user: SCOPED, body: { ackId: row.esc.ackId } })).statusCode, 403);
    const nf = await call('POST /tools/part-faults/ack', { user: OPER, body: { ackId: 'nope' } });
    assert.deepEqual([nf.statusCode, /다시 시작됐을 수/.test(nf.body.reason)], [404, true]);
    assert.equal((await call('POST /tools/part-faults/ack', { user: OPER, body: { ackId: ['x'] } })).statusCode, 400);
    const a0 = audit().length;
    const ok = await call('POST /tools/part-faults/ack', { user: OPER, body: { ackId: row.esc.ackId } });
    assert.deepEqual([ok.statusCode, ok.body.changed], [200, true]);
    assert.equal((await call('POST /tools/part-faults/ack', { user: OPER, body: { ackId: row.esc.ackId } })).body.changed, false);
    assert.deepEqual(audit().slice(a0), ['파트 장애 알림 확인(단계 올리기 멈춤)']);
    assert.equal((await call('GET /tools/part-faults', { user: OPER })).body.open.find((x) => x.partId === 'PSU.Slot.1').esc.ackBy, 'oper1');
    // 설정 — 관리자 · 전체 범위만(운영자 PUT 403 · 범위 관리자 403)
    assert.equal((await call('GET /tools/part-faults/escalation', { user: OPER })).statusCode, 403);
    assert.equal((await call('PUT /tools/part-faults/escalation', { user: OPER, body: { enabled: false, policies: [] } })).statusCode, 403);
    assert.equal((await call('PUT /tools/part-faults/escalation', { user: SCOPED, body: { enabled: false } })).statusCode, 403);
    const g = (await call('GET /tools/part-faults/escalation')).body;
    assert.deepEqual([g.ok, g.settings.enabled, g.limits.steps, g.limits.retries, g.tickMs], [true, false, 4, 3, RUN.ESC_TICK_MS], '주기는 API 값으로(반증 B10)');
    const bad = await call('PUT /tools/part-faults/escalation', { body: { enabled: true, policies: [] } });
    assert.deepEqual([bad.statusCode, /켜려면 정책/.test(bad.body.reason)], [400, true]);
    const a1 = audit().length;
    const put = await call('PUT /tools/part-faults/escalation', { body: { enabled: true, policies: [POL()] } });
    assert.deepEqual([put.statusCode, put.body.settings.enabled], [200, true]);
    assert.match(audit().slice(a1)[0], /알림 단계 · 당직 설정 저장/);
    assert.equal((await call('GET /tools/part-faults', { user: OPER })).body.open.find((x) => x.partId === 'PSU.Slot.1').esc.covered, true);
    assert.equal(E.escalationMarkOf(PART({ state: 'warn' }), {}, E.escalationStore.get()).covered, false);
  } finally { store.snapshot = prev; E.escalationStore._resetForTest(); }
});

test('복원 · 백업 · 데모 — 진행 기록은 상태 파일(지금 것 유지) · 데모 계정은 설정을 읽지 못한다 · 확인 단추는 데모 계정에 없다', async () => {
  const SR = await import('../src/backup/stagedRestore.js');
  assert.equal(SR.RESTORE_KEEP_CURRENT.has('partfault-escalation-state.json'), true);
  const { isRegisteredStateFile } = await import('../src/util/stateFiles.js');
  assert.equal(isRegisteredStateFile('partfault-escalation-state.json'), true);
  const { READ_DENY } = await import('../src/auth/demoGuest.js');
  assert.ok(READ_DENY.includes('/api/tools/part-faults/escalation'));
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/partFaults.js', import.meta.url), 'utf8'));
  assert.match(src, /canAck: \['admin', 'operator'\]\.includes\(req\.user\?\.role\) && !isDemoGuest\(req\.user\)/);
  assert.match(src, /api\.post\('\/tools\/part-faults\/ack', toolsPerm, writeRole, fullScopeOnly/);
});
