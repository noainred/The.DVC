/**
 * test/unityMetricsSsh3460.test.js — v3.46.0 SSH 로 등록한 Unity 의 사용량(사용자 요청 "SSH 장비도 사용량은 REST 로 읽게 해줘, 안되면 SSH 로 진행"
 * · 선택 'SSH 계정 그대로' · 표준 검증).
 *  ① 표본 대상 판정 하나(sampleCapableOf · sampleTargets · CSV) — SSH Unity 포함, 다른 SSH 어레이는 그대로 제외
 *  ② REST 먼저 · 실패하면 SSH: REST 인증 거절은 그 장비의 REST 만 멈춘다(자격증명이 바뀔 때까지) — **장비 인증 정지로 번지지 않는다**
 *  ③ 비인증 REST 실패는 1시간만 건너뛴다 · 시한이 지나면 다시 REST
 *  ④ 두 경로 모두 실패: REST 원문의 'Authentication failed' 가 SSH 인증 정지 판정을 일으키지 않는다(변이 검증 대상)
 *  ⑤ uemcli /metrics/value/hist 파서 — 레코드 · 표 두 모양(⚠ 실장비 출력 미확인 — 문서 모양) · 못 읽으면 []
 *  ⑥ SSH 표본 조립 — REST 와 같은 조립(FC 쓰기 = in · 읽기 = out · 이더넷 kind eth) · target 이 비면 fePort · 세션 예산 산수
 *  ⑦ 이유 판정에서 'ssh' 사유가 없어졌다
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과와 무관 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });
process.env.CONFIG_DIR = tmpDir('unitymetssh3460-');
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const MIN = 60_000; const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR + 17 * MIN;   // 정시 경계에서 떨어뜨려 고정(CLAUDE.md)

let M; let G; let A; let P; let C; let S; let X;
before(async () => {
  M = await import('../src/storage/collectors/unityMetricsSsh.js');
  G = await import('../src/storage/restSampleGate.js');
  A = await import('../src/storage/collectors/arrayPerf.js');
  P = await import('../src/storage/nodeLoadPoller.js');
  C = await import('../src/storage/csv.js');
  S = await import('../src/storage/ifaceSummary.js');
  X = await import('../src/proxy/sshExec.js');
});

const dev = (o = {}) => ({ id: 'u-ssh', type: 'unity480', collectMethod: 'ssh', host: '10.0.0.9', username: 'admin', password: 'pw1', ...o });
const fakeSample = (via) => ({ ts: NOW, nodes: [], units: [], probe: { via } });
const credErr = () => Object.assign(new Error('HTTP 401 Unauthorized — Authentication failed'), { status: 401 });

test('① 표본 대상 판정 하나 — SSH Unity 포함 · 다른 SSH 어레이 제외 · CSV 도 같은 판정', () => {
  assert.equal(A.sampleCapableOf('unity480', 'ssh'), true);
  assert.equal(A.sampleCapableOf('unity480', 'api'), true);
  assert.equal(A.sampleCapableOf('powerstore', 'ssh'), false, 'SSH PowerStore 는 경로가 없다(그대로)');
  assert.equal(A.sampleCapableOf('isilon', 'ssh'), true);
  const t = P.sampleTargets([dev(), dev({ id: 'off', nodeLoadEnabled: false }), dev({ id: 'ps', type: 'powerstore' }), dev({ id: 'dis', enabled: false })]);
  assert.deepEqual(t.map((d) => d.id), ['u-ssh']);
  assert.equal(C.exportedNodeLoad(dev()), 'true');
  assert.equal(C.exportedNodeLoad(dev({ nodeLoadEnabled: false })), 'false');
});

test('② REST 먼저 · 인증 거절이면 REST 만 멈추고 SSH 로 — 자격증명이 바뀌면 다시 REST', async () => {
  G._resetRestGateForTest();
  let restCalls = 0; let sshCalls = 0;
  const rest = async () => { restCalls += 1; throw credErr(); };
  const ssh = async () => { sshCalls += 1; return fakeSample('ssh'); };
  const s1 = await M.sampleUnityAny(dev(), { now: NOW, rest, ssh });
  assert.deepEqual([restCalls, sshCalls, s1.probe.via, s1.probe.restSkip], [1, 1, 'ssh', 'auth']);
  // 다음 주기 — REST 를 다시 부르지 않는다(실패 로그인 누적 금지)
  const s2 = await M.sampleUnityAny(dev(), { now: NOW + 5 * MIN, rest, ssh });
  assert.deepEqual([restCalls, sshCalls, s2.probe.restSkip], [1, 2, 'auth']);
  // 하루가 지나도 인증 거절 멈춤은 풀리지 않는다(시한 없음)
  await M.sampleUnityAny(dev(), { now: NOW + 26 * HOUR, rest, ssh });
  assert.equal(restCalls, 1);
  // 비밀번호를 바꾸면 다시 시도한다
  const okRest = async () => { restCalls += 1; return fakeSample('rest'); };
  const s3 = await M.sampleUnityAny(dev({ password: 'pw2' }), { now: NOW + 27 * HOUR, rest: okRest, ssh });
  assert.deepEqual([restCalls, s3.probe.via], [2, 'rest']);
  assert.equal(G.restSkipReason(dev({ password: 'pw2' }), NOW + 27 * HOUR), null, '성공하면 기록을 지운다');
});

test('② REST 인증 거절은 장비 인증 정지(authGuard)로 번지지 않는다 — 폴러로 가는 오류가 없다', async () => {
  G._resetRestGateForTest();
  // sampleUnityAny 는 REST 인증 거절을 삼키고 SSH 결과를 돌려준다 → 폴러의 isCredReject/isSshAuthError 판정에 닿지 않는다.
  const s = await M.sampleUnityAny(dev(), { now: NOW, rest: async () => { throw credErr(); }, ssh: async () => fakeSample('ssh') });
  assert.equal(s.probe.via, 'ssh');
  const src = fs.readFileSync(new URL('../src/storage/collectors/unityMetricsSsh.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /markAuthStopped/, 'REST 경로에서 장비 인증 정지를 걸지 않는다');
});

test('③ 비인증 REST 실패는 1시간만 건너뛴다', async () => {
  G._resetRestGateForTest();
  let restCalls = 0;
  const rest = async () => { restCalls += 1; throw new Error('connect ETIMEDOUT'); };
  const ssh = async () => fakeSample('ssh');
  const s = await M.sampleUnityAny(dev(), { now: NOW, rest, ssh });
  assert.equal(s.probe.restSkip, 'other');
  await M.sampleUnityAny(dev(), { now: NOW + 30 * MIN, rest, ssh });
  assert.equal(restCalls, 1, '1시간 안에는 다시 부르지 않는다');
  await M.sampleUnityAny(dev(), { now: NOW + G.REST_RETRY_MS + MIN, rest, ssh });
  assert.equal(restCalls, 2, '시한이 지나면 다시 REST');
});

test('④ 두 경로 모두 실패 — REST 원문의 Authentication failed 가 SSH 인증 정지 판정을 일으키지 않는다', async () => {
  G._resetRestGateForTest();
  const netErr = new Error('connect ECONNREFUSED 10.0.0.9:22');
  await assert.rejects(M.sampleUnityAny(dev(), { now: NOW, rest: async () => { throw credErr(); }, ssh: async () => { throw netErr; } }), (e) => {
    assert.match(e.message, /ECONNREFUSED/);
    assert.match(e.message, /REST:/, '두 사유를 함께 말한다');
    assert.equal(X.isSshAuthError(e), false, 'SSH 가 인증 문제가 아니면 인증 정지가 아니다(REST 글 때문에 바뀌면 SSH 용량 수집까지 멈춘다)');
    return true;
  });
  // SSH 가 정말 인증 실패면 그대로 인증 정지 판정
  G._resetRestGateForTest();
  const sshAuth = Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
  await assert.rejects(M.sampleUnityAny(dev(), { now: NOW, rest: async () => { throw new Error('timeout'); }, ssh: async () => { throw sshAuth; } }), (e) => {
    assert.equal(X.isSshAuthError(e), true);
    return true;
  });
  // 인증 실패가 메시지가 아니라 level 로만 드러나는 경우도 그대로 전한다(변이 M2 — 합친 오류에서 level 이 빠지면 인증 정지를 놓친다)
  G._resetRestGateForTest();
  const levelOnly = Object.assign(new Error('denied'), { level: 'client-authentication' });
  await assert.rejects(M.sampleUnityAny(dev(), { now: NOW, rest: async () => { throw new Error('timeout'); }, ssh: async () => { throw levelOnly; } }), (e) => {
    assert.equal(X.isSshAuthError(e), true);
    return true;
  });
});

const REC = `1:    Timestamp     = 2026-11-26 05:20:00
      SP            = spa
      FE port       = spa_iom_0_fc0
      Value         = 600000000

2:    Timestamp     = 2026-11-26 05:20:00
      SP            = spb
      FE port       = spb_iom_0_fc0
      Value         = 300000000

3:    Timestamp     = 2026-11-26 05:19:00
      SP            = spa
      FE port       = spa_iom_0_fc0
      Value         = 0

4:    Timestamp     = 2026-11-26 05:19:00
      SP            = spb
      FE port       = spb_iom_0_fc0
      Value         = 0
`;
const TABLE = `Timestamp           | SP  | Value
2026-11-26 05:20:00 | spa | 41.5
2026-11-26 05:20:00 | spb | 22
`;

test('⑤ uemcli 지표 파서 — 레코드 · 표 두 모양 · 못 읽으면 []', () => {
  const e = M.parseMetricHist(REC);
  assert.equal(e.length, 2);
  assert.ok(e[0].ts > e[1].ts, '최신 먼저(arrayPerf.parseUnityEntries 와 같은 순서)');
  assert.deepEqual(e[0].values, { spa: { spa_iom_0_fc0: 600000000 }, spb: { spb_iom_0_fc0: 300000000 } });
  const r = A.unityCounterRate(e);
  assert.equal(r.perPort.spa_iom_0_fc0.rate, 10_000_000, '60초 델타 = 10 MB/s');
  const t = M.parseMetricHist(TABLE);
  assert.deepEqual(t[0].values, { spa: 41.5, spb: 22 });
  assert.deepEqual(M.parseMetricHist('Operation failed. Error code: 0x1000002'), []);
  assert.deepEqual(M.parseMetricHist(''), []);
  const big = 'x'.repeat(3_000_000);
  const t0 = Date.now(); M.parseMetricHist(big); assert.ok(Date.now() - t0 < 2000, '긴 입력은 먼저 자른다');
});

test('⑥ SSH 표본 조립 — REST 와 같은 조립 · target 이 비면 fePort · 세션 예산 산수', async () => {
  const outs = {
    cpu: TABLE, readBytes: '', writeBytes: '',
    ethIn: REC.replace(/FE port {7}= spa_iom_0_fc0/g, 'Device = spa_eth2').replace(/FE port {7}= spb_iom_0_fc0/g, 'Device = spb_eth2'), ethOut: null,
    readBytesFe: REC, writeBytesFe: REC.replace(/600000000/, '1200000000'),
  };
  const sessions = [];
  const run = async (full, specs) => {
    sessions.push(specs.map((s) => s.key));
    const out = {}; const errors = {};
    for (const s of specs) { if (outs[s.key] == null) errors[s.key] = '빈 출력'; else out[s.key] = outs[s.key]; }
    return { out, errors, skipped: [], raw: [] };
  };
  const s = await M.sampleUnitySsh(dev(), { now: NOW, run });
  assert.deepEqual(sessions, [['cpu', 'readBytes', 'writeBytes', 'ethIn', 'ethOut'], ['readBytesFe', 'writeBytesFe']]);
  assert.equal(s.probe.fcPath, 'fePort');
  const port = s.units.find((u) => u.name === 'SPA IOM 0 FC0');
  const node = s.nodes.find((n) => n.id === port.id);
  assert.equal(node.out, 10_000_000 * 8, 'FC 읽기 = out(bps)');
  assert.equal(node.in, 20_000_000 * 8, 'FC 쓰기 = in(bps)');
  const eth = s.units.find((u) => u.name === 'SPA ETH2');
  assert.equal(eth.kind, 'eth');
  assert.equal(s.probe.paths.ethOut, 'error');
  // 예산 산수: 세션 예산 < 표본 시한(넘으면 시한이 세션을 먼저 끊어 모은 결과가 버려진다) · 명령 최악 합 ≤ 예산 × 1.25
  assert.ok(M.SSH_METRIC_BUDGET_MS < P.SAMPLE_TIMEOUT_MS, `${M.SSH_METRIC_BUDGET_MS} < ${P.SAMPLE_TIMEOUT_MS}`);
  assert.ok(M.SSH_METRIC_SPECS.length * M.SSH_METRIC_CMD_MS <= M.SSH_METRIC_BUDGET_MS * 1.25);
  for (const sp of [...M.SSH_METRIC_SPECS, ...M.SSH_METRIC_ALT_SPECS]) {
    assert.equal(sp.cmds.length, 1);
    assert.match(sp.cmds[0], /^uemcli \/metrics\/value\/hist -path sp\.\*\.[A-Za-z.*]+ show -interval 60 -count [12]$/, '명령은 상수 경로만(사용자 입력 없음)');
  }
  // SP 값이 하나도 없으면 표본을 만들지 않는다(지어내지 않는다)
  await assert.rejects(M.sampleUnitySsh(dev(), { now: NOW, run: async () => ({ out: {}, errors: { cpu: '권한 없음' }, skipped: [], raw: [] }) }), /SP 값을 읽지 못했습니다/);
});

test('⑦ 이유 판정 — SSH 장비도 표본을 읽으므로 ssh 사유가 없다', () => {
  const base = { ports: 10, method: 'ssh', db: true, units: 6, portUnits: 4, upPorts: 4, unmatched: 0, withData: 3 };
  assert.equal(S.throughputWhyOf(base), '');
  assert.equal(S.throughputWhyOf({ ...base, units: 0, portUnits: 0, withData: 0 }), 'no-samples');
});
