/**
 * test/tokenCheck2560.test.js — '포탈 점검 › 토큰 점검'(v2.560) 회귀.
 *
 * 사용자 요청(2026-09-18): "특수기능에 '포탈 점검' 메뉴 · 첫 서브메뉴 '토큰 점검' — ① 중복 ②
 * 통신 ③ 동일성 ④ 점검". 이 테스트가 고정하는 것은 **정직성 불변조건**이다:
 *  · 평문·전체 해시가 응답에 절대 들어가지 않는다
 *  · KPI 항등식(합계 = 정상+결함+주의+확인불가)
 *  · '확인 못 한 것' 을 정상으로도 결함으로도 세지 않는다
 *  · 발견 코드 ↔ 화면 문구 1:1(한쪽만 늘면 화면이 코드를 그대로 보여준다)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { tokenFingerprint, tokenFingerprintParts, sameToken, tokenGroupKey } from '../src/util/tokenFingerprint.js';
import * as fpMod from '../src/util/tokenFingerprint.js';
import {
  scanTokens, hygieneOf, cmpVersion, edgeReportCapability, probeState, identityEvidence,
  mergeProbe, mergeEdgeReport, withRowStates, rowStateOf, kpisOf,
  PROBE_STATE, TOKEN_MODE, DUP_KIND, DUP_GRADE, EDGE_TOKEN_FACT, ROW_STATE,
} from '../src/portalcheck/tokenScan.js';
import { findingsOf, findingCounts, FINDING, FINDING_GRADE } from '../src/portalcheck/tokenFindings.js';
import { probeCollectorPing, probeCentralRole, probeAll, errorKindOf, PROBE_TIMEOUT_MS } from '../src/portalcheck/tokenProbe.js';
import { sanitizeEnvelope, putEdgeTokenReport, _resetForTest as resetPull, MIN_EDGE_VERSION } from '../src/central/tokenCheckPull.js';
import { stripComments } from './_stripComments.js';

const SECRET = 'S3cret-token-value-0123456789';

/* ── 1. 지문: 값이 새지 않는다 ─────────────────────────────────────────────── */

test('지문은 sha256 앞 8자 + 길이뿐이고, 전체 해시를 돌려주는 export 가 없다', () => {
  const fp = tokenFingerprint(SECRET);
  assert.match(fp, /^sha256:[0-9a-f]{8}\(len=\d+\)$/);
  assert.ok(!fp.includes(SECRET.slice(0, 4)), '값의 일부도 들어가면 안 된다');

  // ⚠ 전체 해시를 내보내는 export 가 생기면 central-agent-tokens.json 의 저장값이 그대로 유출되고,
  //   수동 입력 토큰에는 오프라인 사전 공격이 성립한다(util/tokenFingerprint.js 규칙 2).
  const leaks = Object.entries(fpMod)
    .filter(([name, fn]) => typeof fn === 'function' && name !== 'tokenGroupKey')
    .filter(([, fn]) => { try { return /^[0-9a-f]{64}$/.test(String(fn(SECRET))); } catch { return false; } });
  assert.deepEqual(leaks.map(([n]) => n), [], '전체 해시를 돌려주는 export 가 있다');
  // tokenGroupKey 는 전체 해시지만 '프로세스 안에서만' 쓰는 계약이다 — 라우트가 응답에 싣지 않는지는 아래 3번이 본다.
  assert.match(tokenGroupKey(SECRET), /^[0-9a-f]{64}$/);
});

test('빈 값은 0·none 을 지어내지 않는다', () => {
  assert.equal(tokenFingerprint(''), '');
  assert.equal(tokenFingerprint(null), '');
  assert.deepEqual(tokenFingerprintParts(''), { set: false, fp: '', short: '', len: 0, space: false });
  // ⚠ 비교 대상이 없으면 false(다르다)가 아니라 null(모른다)이다.
  assert.equal(sameToken('', 'x'), null);
  assert.equal(sameToken('x', null), null);
  assert.equal(sameToken('x', 'x'), true);
  assert.equal(sameToken('x', 'y'), false);
});

test('앞뒤 공백·길이를 원문 그대로 본다 — trim 하면 붙여넣기 사고를 숨긴다', () => {
  const p = tokenFingerprintParts(' tok ');
  assert.equal(p.len, 5, 'trim 하면 이 화면이 가장 잡고 싶은 사고가 사라진다');
  assert.equal(p.space, true);
  assert.deepEqual(hygieneOf(' tok '), ['space', 'short']);
  assert.deepEqual(hygieneOf('a'.repeat(40)), []);
  assert.deepEqual(hygieneOf('"quoted-but-long-enough"'), ['quoted']);
  assert.deepEqual(hygieneOf(''), [], '미설정은 위생 문제가 아니다(별도 축)');
});

/* ── 2. 중복 분류 ─────────────────────────────────────────────────────────── */

test('중복은 종류별로 나뉘고 등급이 다르다 — 한 배지로 덮으면 기본 구성을 결함이라 말한다', () => {
  const scan = scanTokens({
    collectors: [
      { id: 'HG', name: 'HG', url: 'http://hg:4000', token: 'SHARED-VALUE-0123456789' },
      { id: 'MI', name: 'MI', url: 'http://mi:4000', token: 'SHARED-VALUE-0123456789' },
      { id: 'WA', name: 'WA', url: 'http://wa:4000', token: 'wa-own-token-0123456789' },
    ],
    sharedCentralToken: 'central-shared-0123456789',
    sharedCollectorToken: '',
    agentTokens: [],
    deployTargets: [],
    knownAgents: ['HG', 'MI', 'WA'],
    status: {},
    minEdgeVersion: MIN_EDGE_VERSION,
  });
  const cross = scan.duplicates.find((d) => d.kind === DUP_KIND.CROSS_EDGE);
  assert.ok(cross, '서로 다른 엣지가 같은 수집 토큰이면 cross-edge');
  assert.equal(cross.grade, 'fault');
  assert.deepEqual(cross.members.map((m) => m.agent).sort(), ['HG', 'MI']);
  assert.ok(!('hash' in cross) && !/[0-9a-f]{40,}/.test(JSON.stringify(cross)), '전체 해시가 실리면 안 된다');
});

test('수집 토큰 == 공유 중앙 토큰은 최상위 결함이고, 정렬이 그것을 먼저 둔다', () => {
  const scan = scanTokens({
    collectors: [{ id: 'A', name: 'A', url: 'http://a:4000', token: 'same-as-central-0123456789' }],
    sharedCentralToken: 'same-as-central-0123456789',
    sharedCollectorToken: 'self-collector-0123456789',
    knownAgents: ['A'],
  });
  assert.equal(scan.duplicates[0].kind, DUP_KIND.COLLECTOR_EQUALS_CENTRAL);
  assert.equal(DUP_GRADE[DUP_KIND.COLLECTOR_EQUALS_CENTRAL], 'fault');
});

test('배포 대상은 agentName 으로 짝을 맞춘다 — name 으로 읽으면 영원히 안 맞는다', () => {
  // agent/deployRegistry.js FIELDS 의 이름은 `agentName` 이다.
  const scan = scanTokens({
    collectors: [{ id: 'HG', name: 'HG', url: 'http://hg:4000', token: 'registry-value-0123456789' }],
    deployTargets: [{ agentName: 'HG', host: '10.0.0.9', collectorToken: 'deploy-value-0123456789' }],
    knownAgents: ['HG'],
  });
  const row = scan.rows.find((r) => r.agent === 'HG');
  assert.equal(row.deploy.present, true, 'agentName 으로 짝이 맞아야 한다');
  assert.equal(row.deploy.collectorMatchesRegistry, false);
});

/* ── 3. 등록부에 없는 엣지도 행이 된다 ────────────────────────────────────── */

test("등록부에 없는 엣지를 빠뜨리면 '전부 정상' 이라는 거짓이 된다", () => {
  const scan = scanTokens({
    collectors: [],
    agentTokens: [{ agent: 'GHOST', createdAt: 1 }],
    knownAgents: ['GHOST'],
    sharedCentralToken: '',
  });
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.rows[0].registered, false);
  assert.equal(scan.rows[0].central.mode, TOKEN_MODE.AGENT);
  // 중앙은 개별 토큰의 평문이 없어 **지문을 만들 수 없다** — null 이어야 한다(지어내지 않는다).
  assert.equal(scan.rows[0].central.expectedShort, null);
});

/* ── 4. 프로브 상태 판정 ──────────────────────────────────────────────────── */

test('프로브 상태는 원인별로 갈린다 — 200 이어도 다른 엣지면 정상이 아니다', () => {
  assert.equal(probeState({ hasToken: true, status: 200 }), PROBE_STATE.OK);
  assert.equal(probeState({ hasToken: true, status: 200, identityMismatch: true }), PROBE_STATE.WRONG_EDGE);
  assert.equal(probeState({ hasToken: true, status: 403 }), PROBE_STATE.TOKEN_MISMATCH);
  assert.equal(probeState({ hasToken: true, status: 404, bodyReason: 'collector 비활성화' }), PROBE_STATE.EDGE_NO_TOKEN);
  assert.equal(probeState({ hasToken: true, status: 404 }), PROBE_STATE.OLD_ROUTE);
  assert.equal(probeState({ hasToken: true, status: 401 }), PROBE_STATE.OLD_ROUTE);
  assert.equal(probeState({ hasToken: true, status: 502 }), PROBE_STATE.HTTP);
  assert.equal(probeState({ hasToken: true, errorKind: 'timeout' }), PROBE_STATE.TIMEOUT);
  assert.equal(probeState({ hasToken: true, errorKind: 'unreachable' }), PROBE_STATE.UNREACHABLE);
  // ⚠ '토큰 없음' 은 인증 실패가 아니다 — 실패로 세면 화면이 멀쩡한 토큰을 의심하게 만든다.
  assert.equal(probeState({ hasToken: false, status: 403 }), PROBE_STATE.SKIP_NO_TOKEN);
});

test("'증명' 이라는 근거는 200 에서만 나온다", () => {
  assert.equal(identityEvidence(PROBE_STATE.OK), 'proven-same');
  assert.equal(identityEvidence(PROBE_STATE.TOKEN_MISMATCH), 'differs-or-header');
  assert.equal(identityEvidence(PROBE_STATE.EDGE_NO_TOKEN), 'edge-unset');
  assert.equal(identityEvidence(PROBE_STATE.UNREACHABLE), 'unknown');
  assert.equal(identityEvidence(PROBE_STATE.NOT_RUN), 'unknown');
});

test('프로브는 등록부 URL 로만 나가고 헤더에 토큰을 싣는다 — 응답 객체에는 담지 않는다', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, token: init.headers['X-Collector-Token'] });
    return { status: 200, ok: true, json: async () => ({ ok: true, agent: 'HG', hostname: 'hg-host', version: '2.560.0' }) };
  };
  const row = { agent: 'HG', id: 'HG', url: 'http://hg:4000/', collector: { set: true } };
  const r = await probeCollectorPing(row, { fetchImpl: fake, token: SECRET });
  assert.equal(calls[0].url, 'http://hg:4000/api/collector/ping', '/export 를 쓰면 그 법인 인벤토리 전량이 온다');
  assert.equal(calls[0].token, SECRET);
  assert.equal(r.state, PROBE_STATE.OK);
  assert.equal(r.evidence, 'proven-same');
  assert.ok(!JSON.stringify(r).includes(SECRET), '프로브 결과에 평문이 담기면 안 된다');
});

test('응답한 엣지가 다르면 200 이어도 wrong-edge 다', async () => {
  const fake = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, agent: 'OTHER', hostname: 'relay' }) });
  const row = { agent: 'HG', id: 'HG', url: 'http://hg:4000', collector: { set: true } };
  const r = await probeCollectorPing(row, { fetchImpl: fake, token: SECRET, otherIds: ['HG', 'OTHER'] });
  assert.equal(r.state, PROBE_STATE.WRONG_EDGE);
  assert.equal(r.agentSaid, 'OTHER');
});

test('중앙에 저장된 토큰이 없으면 보내지 않는다(skip) — 요청이 아예 나가지 않아야 한다', async () => {
  let called = 0;
  const fake = async () => { called += 1; return { status: 200, ok: true, json: async () => ({}) }; };
  const r = await probeCollectorPing({ agent: 'X', url: 'http://x:4000', collector: { set: true } }, { fetchImpl: fake, token: '' });
  assert.equal(r.state, PROBE_STATE.SKIP_NO_TOKEN);
  assert.equal(called, 0, '보내 볼 값이 없는데 요청을 내면 엣지의 거부 기록만 채운다');
});

test('무인증 확인은 토큰을 싣지 않고, 403 을 양성 신호로 읽는다', async () => {
  const seen = [];
  const fake = async (url, init) => { seen.push(init.headers); return { status: 403, ok: false, json: async () => ({ ok: false }) }; };
  const r = await probeCentralRole({ url: 'http://hg:4000' }, { fetchImpl: fake });
  assert.equal(r.kind, 'central-enabled');
  assert.ok(!('X-Collector-Token' in seen[0]) && !('X-Central-Token' in seen[0]), '무인증 확인에 토큰을 실으면 유출 위험이 생긴다');
  const r404 = await probeCentralRole({ url: 'http://hg:4000' }, { fetchImpl: async () => ({ status: 404, ok: false, json: async () => ({ reason: 'central 비활성화' }) }) });
  assert.equal(r404.kind, 'not-central');
});

test('시간 예산을 넘기면 시도하지 않고 사유를 남긴다 — 조용히 빼지 않는다', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ agent: `E${i}`, id: `E${i}`, url: 'http://e:4000', collector: { set: true } }));
  const fake = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, agent: 'E0' }) });
  // 예산이 한 요청 시한보다 작으면 첫 항목도 시작하지 않는다.
  const out = await probeAll(rows, { tokenOf: () => SECRET, fetchImpl: fake, budgetMs: 10_000, timeoutMs: 60_000, now: Date.now() });
  assert.equal(out.budgetExceeded, 5);
  assert.ok(out.probes.every((p) => p.probe.state === PROBE_STATE.NOT_RUN));
  assert.ok(out.probes[0].probe.reason.includes('예산'), '왜 안 했는지를 말해야 한다');
});

test('errorKindOf 는 시한과 불통을 가른다(조치가 다르다)', () => {
  assert.equal(errorKindOf('The operation was aborted due to timeout'), 'timeout');
  assert.equal(errorKindOf('signed timed out'), 'timeout');   // Chrome 계열 변형
  assert.equal(errorKindOf('connect ECONNREFUSED 10.0.0.1:4000'), 'unreachable');
});

/* ── 5. 엣지 자기보고 수신 ────────────────────────────────────────────────── */

test('수신 정제는 아는 키만 담고 전체 해시를 8자로 자른다', () => {
  const s = sanitizeEnvelope({
    at: 1, node: { agent: 'HG', hostname: 'h', version: '2.560.0' },
    tokens: {
      collector: { set: true, short: 'a'.repeat(64), len: '43', space: true, hygiene: ['space', 'x'.repeat(40), 1, 2, 3, 4, 5, 6, 7, 8] },
      collectorEqualsCentralSend: 'yes',
    },
    centralRole: { enabled: 'x' },
    selfProbe: { ran: true, ok: true, tokenMode: 'agent', yourAgent: 'HG' },
    junk: 'X'.repeat(5000),
  });
  assert.equal(s.tokens.collector.short.length, 8, '변조 엣지가 전체 해시를 실어도 중앙에 남지 않아야 한다');
  assert.equal(s.tokens.collector.len, 43);
  assert.equal(s.tokens.collector.space, true);
  assert.equal(s.tokens.collector.hygiene.length, 8, '상한이 있어야 한다');
  // ⚠ 알 수 없는 값은 null(모른다)이다 — false(다르다)로 뭉개면 거짓이다.
  assert.equal(s.tokens.collectorEqualsCentralSend, null);
  assert.equal(s.centralRole.enabled, false, '불리언이 아니면 문제를 지어내지 않는다');
  assert.ok(!('junk' in s));
});

test('인출 실패가 직전 보고를 지우지 않는다 — 지우면 방금 보던 값이 사라진다', () => {
  resetPull();
  putEdgeTokenReport('HG', { ok: true, ms: 5, report: { node: { agent: 'HG' } } });
  const rec = putEdgeTokenReport('HG', { ok: false, ms: 9, kind: 'timeout', reason: 't/o' });
  assert.ok(rec.report, 'v2.550.3 H5 규약');
  assert.equal(rec.lastAttempt.kind, 'timeout');
  assert.equal(rec.ok, false);
  resetPull();
});

test('엣지 보고는 실측으로 중앙 토큰 축을 말한다 — 이름이 다르면 뒤바뀜이다', () => {
  const base = scanTokens({
    collectors: [{ id: 'HG', name: 'HG', url: 'http://hg:4000', token: 'hg-token-0123456789012' }],
    knownAgents: ['HG'], sharedCentralToken: 'shared-0123456789012345',
  });
  const mk = (sp) => mergeEdgeReport(base, [{ agent: 'HG', ok: true, reportAt: 1, report: { node: { agent: 'HG' }, tokens: {}, selfProbe: sp } }]).rows[0].edge.fact;
  assert.equal(mk({ ran: true, ok: true, tokenMode: 'agent', yourAgent: 'HG' }), EDGE_TOKEN_FACT.AGENT);
  assert.equal(mk({ ran: true, ok: true, tokenMode: 'agent', yourAgent: 'MI' }), EDGE_TOKEN_FACT.AGENT_WRONG_NAME);
  assert.equal(mk({ ran: true, ok: true, tokenMode: 'shared', yourAgent: '' }), EDGE_TOKEN_FACT.SHARED);
  assert.equal(mk({ ran: true, ok: false, kind: 'rejected' }), EDGE_TOKEN_FACT.REJECTED);
  assert.equal(mk({ ran: false }), EDGE_TOKEN_FACT.NOT_RUN);
  assert.equal(mk({ ran: true, ok: false, kind: 'unreachable' }), EDGE_TOKEN_FACT.UNKNOWN);
});

test('중앙이 아는 이름과 엣지가 말한 이름이 다르면 한쪽으로 덮지 않는다', () => {
  const base = scanTokens({ collectors: [{ id: 'HG', name: 'HG', url: 'http://hg:4000', token: 'x'.repeat(20) }], knownAgents: ['HG'] });
  const row = mergeEdgeReport(base, [{ agent: 'HG', ok: true, reportAt: 1, report: { node: { agent: 'hg-edge-1' }, tokens: {}, selfProbe: { ran: false } } }]).rows[0];
  assert.equal(row.edge.nameMismatch, true);
  assert.equal(row.edge.said, 'hg-edge-1');
  assert.equal(row.agent, 'HG', '저장 키는 중앙이 아는 이름이다(v2.548 F5)');
});

/* ── 6. 버전 분류 ─────────────────────────────────────────────────────────── */

test('버전을 모르면 구버전이라 단정하지 않는다', () => {
  assert.equal(edgeReportCapability('2.560.0', '2.560.0'), 'capable');
  assert.equal(edgeReportCapability('2.561.1', '2.560.0'), 'capable');
  assert.equal(edgeReportCapability('2.559.0', '2.560.0'), 'old-version');
  assert.equal(edgeReportCapability('', '2.560.0'), 'unknown-version');
  assert.equal(edgeReportCapability('dev-build', '2.560.0'), 'unknown-version');
  assert.equal(cmpVersion('2.10.0', '2.9.0'), 1, '문자열 비교로 하면 2.10 < 2.9 가 된다');
  assert.equal(cmpVersion('x', '1.0.0'), null);
});

/* ── 7. 행 상태 · KPI 항등식 ──────────────────────────────────────────────── */

const ROWS = () => ([
  { agent: 'OK', registered: true, collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.OK }, edge: { fact: EDGE_TOKEN_FACT.AGENT } },
  { agent: 'SHARED', registered: true, collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.SHARED }, probe: { state: PROBE_STATE.OK }, edge: { fact: EDGE_TOKEN_FACT.SHARED } },
  { agent: 'BAD', registered: true, collector: { set: true, hygiene: ['space'] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.TOKEN_MISMATCH } },
  { agent: 'DOWN', registered: true, collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.UNREACHABLE } },
  { agent: 'NEW', registered: true, collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: null },
]);

test('KPI 네 칸은 겹치지 않는다 — 합계 = 정상 + 결함 + 주의 + 확인 불가', () => {
  const k = kpisOf({ rows: ROWS(), duplicates: [{ grade: 'fault' }, { grade: 'warn' }, { grade: 'info' }] });
  assert.equal(k.total, k.ok + k.fault + k.warn + k.unknown);
  assert.equal(k.ok, 1);
  assert.equal(k.fault, 1);
  assert.equal(k.warn, 1, '공유 토큰은 전용 주의 칸이다(사용자 선택)');
  assert.equal(k.unknown, 2, '닿지 못한 것과 점검 전은 확인 불가다');
  assert.equal(k.sharedToken, 1);
  assert.equal(k.dupFault, 1, '별도 축이라 네 칸과 더하지 않는다');
});

test('정상률 분모는 응답을 받은 행뿐이다 — 값 위생만으로 warn 이 된 행을 측정분에 넣지 않는다', () => {
  // ⚠ v2.560 자체 검증에서 잡은 결함: 점검을 한 번도 누르지 않은 상태에서 '측정 1곳 · 정상률 0%'
  //    라고 말했다('통신이 실패했다' 로 읽히는 거짓).
  const k = kpisOf({ rows: [
    { agent: 'A', registered: true, collector: { set: true, hygiene: ['space'] }, central: { mode: TOKEN_MODE.AGENT }, probe: null },
  ] });
  assert.equal(k.warn, 1);
  assert.equal(k.measured, 0, '네트워크 측정을 한 적이 없다');
  assert.equal(k.okRate, null, '0% 가 아니다');
  // 응답을 받은 것만 분모다(닿지 못한 것·토큰 없음·미실행 제외).
  const k2 = kpisOf({ rows: [
    { agent: 'A', registered: true, collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.OK }, edge: { fact: EDGE_TOKEN_FACT.AGENT } },
    { agent: 'B', registered: true, collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.TOKEN_MISMATCH } },
    { agent: 'C', registered: true, collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.UNREACHABLE } },
    { agent: 'D', registered: true, collector: { set: false, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.SKIP_NO_TOKEN } },
  ] });
  assert.equal(k2.measured, 2, '응답을 받은 것은 A·B 뿐이다');
  assert.equal(k2.probeOk, 1);
  assert.equal(k2.okRate, 50);
});

test('점검하지 않은 행을 정상으로 칠하지 않는다', () => {
  assert.equal(rowStateOf({ probe: null, registered: true, collector: { hygiene: [] }, central: {} }), ROW_STATE.UNKNOWN);
  assert.equal(rowStateOf({ probe: { state: PROBE_STATE.NOT_RUN }, registered: true, collector: { hygiene: [] }, central: {} }), ROW_STATE.UNKNOWN);
});

test('측정분이 0 이면 정상률은 null 이다(0% 가 아니다)', () => {
  const k = kpisOf({ rows: [{ agent: 'A', registered: true, collector: { hygiene: [] }, central: {}, probe: null }] });
  assert.equal(k.measured, 0);
  assert.equal(k.okRate, null);
});

test('withRowStates 가 행에 state 를 붙인다 — 화면이 판정을 복제하지 않게', () => {
  const s = withRowStates({ rows: ROWS() });
  assert.deepEqual(s.rows.map((r) => r.state), ['ok', 'warn', 'fault', 'unknown', 'unknown']);
});

/* ── 8. 발견 목록 ─────────────────────────────────────────────────────────── */

test('발견 코드는 모두 등급이 있고, 화면 문구와 1:1 이다', async () => {
  const codes = Object.values(FINDING);
  assert.deepEqual(codes.filter((c) => !FINDING_GRADE[c]), [], '등급이 빠진 코드가 있다');
  const T = await import('../../web/src/views/tools/tokenCheckText.js');
  assert.deepEqual(codes.filter((c) => !T.FINDING_TEXT[c]), [], '서버 코드에 화면 문구가 없다 — 화면이 코드를 그대로 보여준다');
  assert.deepEqual(Object.keys(T.FINDING_TEXT).filter((c) => !codes.includes(c)), [], '화면에만 있는 코드가 있다');
});

test('화면 문구에 백틱이 없다 — BoldText 는 **강조** 만 해석하고 백틱은 글자로 샌다', async () => {
  const T = await import('../../web/src/views/tools/tokenCheckText.js');
  const bad = [];
  for (const [c, v] of Object.entries(T.FINDING_TEXT)) {
    for (const k of ['title', 'fix']) if (String(v[k]).includes('`')) bad.push(`${c}.${k}`);
  }
  for (const st of Object.keys(T.PROBE_LABEL)) {
    if (T.evidenceText({ probe: { state: st } }).includes('`')) bad.push(`evidenceText(${st})`);
  }
  for (const f of ['agent', 'agent-wrong-name', 'shared', 'rejected', 'not-run', 'unknown']) {
    if (T.centralAxisText({ edge: { fact: f, selfProbe: {} } }).includes('`')) bad.push(`centralAxisText(${f})`);
  }
  if (T.fpLimitNote().includes('`')) bad.push('fpLimitNote');
  assert.deepEqual(bad, []);
});

test('발견은 위험한 것이 먼저다 — 상한으로 잘릴 때 결함이 밀려나지 않게', () => {
  const scan = withRowStates({
    rows: [
      { agent: 'A', registered: true, url: 'http://a', collector: { set: true, short: 'aaaa1111', hygiene: ['space'] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.TOKEN_MISMATCH }, capability: 'capable' },
    ],
    duplicates: [{ kind: DUP_KIND.CROSS_EDGE, grade: 'fault', short: 'bbbb2222', len: 30, members: [] }],
  });
  const f = findingsOf(scan);
  assert.equal(f[0].grade, 'fault');
  const c = findingCounts(f);
  assert.equal(c.total, f.length);
  assert.ok(c.fault >= 2);
  // 같은 사실을 두 줄로 내지 않는다(엣지 보고 + 무인증 확인이 둘 다 말할 때).
  const both = findingsOf(withRowStates({
    rows: [{ agent: 'B', registered: true, url: 'http://b', collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.OK }, capability: 'capable', centralRole: { kind: 'central-enabled' }, edge: { fact: EDGE_TOKEN_FACT.AGENT, centralRole: { enabled: true, byEnv: true }, tokens: {}, selfProbe: { ran: true, ok: true, tokenMode: 'agent', yourAgent: 'B' } } }],
    duplicates: [],
  }));
  assert.equal(both.filter((x) => x.code === FINDING.EDGE_IS_ALSO_CENTRAL).length, 1);
});

test('엣지 보고가 없는 이유를 버전으로 가른다 — 조치가 정반대다', () => {
  const mk = (capability, version) => findingsOf({
    rows: [{ agent: 'A', registered: true, url: 'http://a', collector: { set: true, hygiene: [] }, central: { mode: TOKEN_MODE.AGENT }, probe: { state: PROBE_STATE.OK }, capability, version }],
    duplicates: [],
  }).map((f) => f.code);
  assert.ok(mk('old-version', '2.500.0').includes(FINDING.EDGE_OLD_VERSION));
  assert.ok(mk('capable', '2.560.0').includes(FINDING.EDGE_NO_REPORT));
});

/* ── 9. 응답에 평문·전체 해시가 없다(전 경로) ────────────────────────────── */

test('스캔 결과 전체를 직렬화해도 평문·전체 해시가 없다', () => {
  const scan = withRowStates(mergeEdgeReport(mergeProbe(scanTokens({
    collectors: [{ id: 'HG', name: 'HG', url: 'http://hg:4000', token: SECRET }],
    sharedCentralToken: `${SECRET}-central`,
    sharedCollectorToken: `${SECRET}-self`,
    agentTokens: [{ agent: 'HG', createdAt: 1, lastUsedAt: 2 }],
    deployTargets: [{ agentName: 'HG', collectorToken: SECRET, centralToken: `${SECRET}-central` }],
    knownAgents: ['HG'],
  }), [{ agent: 'HG', probe: { state: PROBE_STATE.OK, evidence: 'proven-same' }, centralRole: { kind: 'not-central' } }]),
  [{ agent: 'HG', ok: true, reportAt: 1, report: sanitizeEnvelope({ node: { agent: 'HG' }, tokens: { collector: { set: true, short: 'deadbeef', len: 29 } }, selfProbe: { ran: true, ok: true, tokenMode: 'agent', yourAgent: 'HG' } }) }]));
  const json = JSON.stringify({ ...scan, kpis: kpisOf(scan), findings: findingsOf(scan) });
  assert.ok(!json.includes(SECRET), '평문이 응답에 들어 있다');
  assert.ok(!json.includes('S3cret'), '평문 조각이 들어 있다');
  assert.deepEqual(json.match(/[0-9a-f]{40,}/g) || [], [], '전체 해시처럼 긴 16진 문자열이 들어 있다');
});

/* ── 10. 엣지 라우트·경로 계약 ────────────────────────────────────────────── */

test('엣지 라우트는 COLLECTOR_TOKEN 게이트 뒤에 있고 개별 토큰 전용이 아니다', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/collector.js', import.meta.url), 'utf8');
  assert.match(src, /collectorRouter\.get\('\/token-check'/, '엣지 보고 경로가 없다');
  // ⚠ 개별 토큰 전용(/api/central/*)으로 만들면 공유 토큰만 쓰는 법인이 403 이라 그 사실조차
  //   보고할 수 없다(v2.554 가 기록한 한계). 이 경로 선택이 설계의 핵심이다.
  const seg = src.slice(src.indexOf("collectorRouter.get('/token-check'"));
  assert.match(seg.slice(0, 600), /checkToken\(req\)/);
  assert.match(seg.slice(0, 600), /logCollectorDeny\(req, 'token-check'\)/);
});

test('중앙 라우트는 adminOnly + 전체 범위 전용이고, 본문에서 url·token 을 읽지 않는다', async () => {
  const fs = await import('node:fs');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/portalCheck.js', import.meta.url), 'utf8'));  // 주석이 통과 근거가 되면 안 된다(v2.535 규약)
  for (const m of ['/tools/portal-check/tokens', '/tools/portal-check/tokens/probe', '/tools/portal-check/tokens/edge-pull']) {
    const i = src.indexOf(`'${m}'`);
    assert.ok(i > 0, `${m} 라우트가 없다`);
    const decl = src.slice(i, i + 200);
    assert.match(decl, /adminOnly/, `${m} 에 adminOnly 가 없다`);
    assert.match(decl, /fullScopeOnly/, `${m} 에 fullScopeOnly 가 없다`);
  }
  // 본문에서 읽는 것은 이름 필터뿐이어야 한다.
  const bodyReads = [...src.matchAll(/req\.body\?\.([A-Za-z]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bodyReads)].sort(), ['agent', 'selfProbe'],
    '본문에서 url·token 을 받으면 저장 토큰을 공격자 호스트로 보내는 경로가 된다(v2.480 규약)');
});

test('토큰을 싣는 요청은 resilientFetch(retries 0)로만 나간다 — 전역 fetch 금지', async () => {
  const fs = await import('node:fs');
  for (const f of ['../src/portalcheck/tokenProbe.js', '../src/central/tokenCheckPull.js']) {
    const src = stripComments(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    assert.match(src, /resilientFetch/, `${f} 가 resilientFetch 를 쓰지 않는다(전역 fetch 는 DNS 리바인딩 lookup 이 없다)`);
    assert.ok(!/\bglobalThis\.fetch\b/.test(src) && !/(^|[^.\w])fetch\(/.test(src), `${f} 에 전역 fetch 호출이 있다`);
    assert.match(src, /retries:\s*0/, `${f} 의 점검 요청에 retries:0 이 없다`);
  }
});

test('엣지 자기보고는 racadm 류 부하를 만들지 않는다 — 중앙 표적은 health-probe 하나다', async () => {
  const fs = await import('node:fs');
  const src = stripComments(fs.readFileSync(new URL('../src/portalcheck/edgeReport.js', import.meta.url), 'utf8'));
  assert.match(src, /\/api\/central\/health-probe/);
  // ⚠ 5분마다 로그인하면 세션 테이블을 채우고 계정을 잠근다(v2.553 규약) — 인증 경로를 쓰지 않는다.
  assert.ok(!src.includes('/api/central/export') && !src.includes('/api/collector/export'), '무거운 경로를 표적으로 쓰면 점검이 곧 부하가 된다');
  // 원문 토큰을 trim 하지 않는다(붙여넣기 공백 사고를 숨기지 않기 위해).
  assert.ok(!/t\(config\.collector\.token\)/.test(src), 'trim 하면 앞뒤 공백 사고가 화면에서 사라진다');
  assert.ok(!/t\(config\.agent\.centralToken\)/.test(src), 'trim 하면 앞뒤 공백 사고가 화면에서 사라진다');
});

/* ── 11. 등록 6곳 ─────────────────────────────────────────────────────────── */

test('도구 키가 6곳에 등록돼 있다 — 하나만 빠져도 메뉴에서 못 찾거나 권한이 안 걸린다', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  // ① 카드 목록: `{ k: 'portal-check'` 형태여야 검색·권한 테스트의 정규식이 잡는다.
  assert.match(read('../../web/src/views/specialToolsList.js'), /\{\s*k:\s*'portal-check'/);
  // ② SpecialTools 디스패처
  const st = read('../../web/src/views/SpecialTools.jsx');
  assert.match(st, /PortalCheck = React\.lazy/);
  assert.match(st, /tool === 'portal-check' && <PortalCheck \/>/);
  // ③ V4 트리(안 넣으면 내비에서 영원히 못 찾는다)
  assert.match(read('../../web/src/version_4/tree.js'), /tool\('portal-check'\)/);
  // ④ 카테고리 프리셋(빠지면 '기타' 로 밀린다)
  assert.match(read('../src/toolcats/catalog.js'), /'portal-check'/);
  // ⑤ 서버 집행 매핑
  assert.match(read('../src/auth/toolAccess.js'), /'portal-check':\s*'portal-check'/);
  // ⑥ 라우터 등록
  assert.match(read('../src/routes/api.js'), /registerPortalCheck\(api\)/);
});

/* ── 12. '빈 인벤토리' 진단 — vCenter 수집 상태를 엣지 로그 표에 등재했다 ──────── */

test("vCenter 인벤토리 수집 상태가 엣지 로그 표에 있다 — 없으면 '빈 인벤토리' 원인을 볼 길이 없다", async () => {
  const { STATUS_SPEC, STATUS_KEYS, STATUS_LABEL } = await import('../src/edgelog/spec.js');
  const row = STATUS_SPEC.find((x) => x.key === 'collect.inventory');
  assert.ok(row, "STATUS_SPEC 에 'collect.inventory' 가 없다 — 새 폴러는 이 표에 함께 넣는다(v2.554 규약)");
  assert.equal(row.fn, 'storeStatus');
  assert.equal(row.mod, '../store.js');
  assert.ok(STATUS_KEYS.has('collect.inventory'), '중앙 수신이 모르는 키가 되면 조용히 버려진다');
  assert.ok(STATUS_LABEL['collect.inventory']);
});

test('storeStatus 는 자격증명을 담지 않고 상한을 밝힌다', async () => {
  const { storeStatus } = await import('../src/store.js');
  const s = storeStatus();
  assert.equal(typeof s.registered, 'number');
  assert.equal(typeof s.intervalMs, 'number');
  assert.ok(s.counts && typeof s.counts.total === 'number');
  assert.equal(typeof s.truncated, 'boolean');
  const json = JSON.stringify(s);
  for (const k of ['password', 'passwd', 'token', 'secret', 'username', 'user']) {
    assert.ok(!new RegExp(k, 'i').test(json), `storeStatus 에 ${k} 가 들어 있다`);
  }
});

test('mock vCenter id 판정은 한 곳이 소유한다 — Collectors.jsx 가 지역 복사본을 두지 않는다', async () => {
  const fs = await import('node:fs');
  const col = fs.readFileSync(new URL('../../web/src/views/Collectors.jsx', import.meta.url), 'utf8');
  assert.match(col, /import \{ MOCK_VC_RE \} from '\.\/collectors\/emptyInvText\.js'/);
  assert.ok(!/^const MOCK_VC_RE\s*=/m.test(col), '지역 복사본이 있으면 배지와 모달이 다른 원인을 말한다');
  const mod = fs.readFileSync(new URL('../../web/src/views/collectors/emptyInvText.js', import.meta.url), 'utf8');
  // ⚠ `/^vc-/` 로 넓히면 현장에서 `vc-hg01` 로 이름 지은 실제 vCenter 가 mock 으로 오판된다.
  assert.match(mod, /MOCK_VC_RE = \/\^vc-\(us\|br\|eu\|me\|ap\|cn\)-\[a-z\]\+\$\//);
});

test("'빈 인벤토리' 배지는 버튼이다 — 툴팁에만 두면 복사·공유가 안 되고 모바일에서 못 본다", async () => {
  const fs = await import('node:fs');
  const col = fs.readFileSync(new URL('../../web/src/views/Collectors.jsx', import.meta.url), 'utf8');
  // ⚠ 주석에도 같은 낱말이 있어 `indexOf` 로 잡으면 엉뚱한 곳을 본다(v2.535 규약의 변형) —
  //   주석을 먼저 제거하고 **마지막** 등장(= JSX 라벨)을 기준으로 본다.
  const bare = stripComments(col);   // v2.613 TESTDOC2613-08: JSX 의 {/* */} 도 블록 주석으로 지워진다(빈 {} 만 남는다)
  const i = bare.lastIndexOf('빈 인벤토리');
  assert.ok(i > 0, 'JSX 에 배지 라벨이 없다');
  const seg = bare.slice(Math.max(0, i - 700), i + 100);
  assert.match(seg, /<button type="button" className="badge amber"/);
  assert.match(seg, /setInvDiag\(\{ agent: r\.agent, push: r\.last \}\)/);
  assert.match(col, /EmptyInvModal/);
});

/* ── 13. 배포 대상 중복은 '여러 엣지에 걸쳤을 때' 만 경고다(오탐 방지) ────────── */

test('배포 대상의 중앙 토큰이 공유 중앙 토큰과 같은 것은 의도된 구성이다 — 경고로 올리지 않는다', () => {
  const scan = scanTokens({
    collectors: [{ id: 'HG', name: 'HG', url: 'http://hg:4000', token: 'hg-own-collector-0123456789' }],
    sharedCentralToken: 'central-shared-value-0123456789',
    deployTargets: [{ agentName: 'HG', centralToken: 'central-shared-value-0123456789', collectorToken: 'hg-own-collector-0123456789' }],
    knownAgents: ['HG'],
  });
  const grades = scan.duplicates.map((d) => d.grade);
  assert.ok(!grades.includes('warn'), `정상 구성인데 경고가 났다: ${JSON.stringify(scan.duplicates)}`);
  assert.ok(!grades.includes('fault'));
  // 발견 목록에도 나오지 않는다(by-design·same-edge 는 발견이 아니거나 info 다).
  const codes = findingsOf(withRowStates(scan)).map((f) => f.code);
  assert.ok(!codes.includes(FINDING.DUP_DEPLOY_TARGET), '정상 배포 구성을 발견으로 올렸다');
});

test('배포 대상 값이 다른 엣지 값과 겹치면 경고다', () => {
  const scan = scanTokens({
    collectors: [
      { id: 'HG', name: 'HG', url: 'http://hg:4000', token: 'shared-by-mistake-0123456789' },
      { id: 'MI', name: 'MI', url: 'http://mi:4000', token: 'mi-own-collector-0123456789' },
    ],
    deployTargets: [{ agentName: 'MI', collectorToken: 'shared-by-mistake-0123456789' }],
    knownAgents: ['HG', 'MI'],
  });
  const dep = scan.duplicates.find((d) => d.kind === DUP_KIND.DEPLOY_TARGET);
  assert.ok(dep, `배포 대상 경고가 없다: ${JSON.stringify(scan.duplicates)}`);
  assert.equal(dep.grade, 'warn');
});
