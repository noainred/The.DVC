/**
 * rebut115.test.js — 전체 점검 115회차: 107회차('읽기 오류 ≠ 손상' 스윕 잔여 · 30개 모듈) 수정에 대한 적대적 재검토(반증).
 *
 * 107 은 쓰기를 닫았다(503 settingsUnreadable). 여기서 고정하는 것은 그 뒤에 남은 **읽는 쪽 · 다시 읽힌 뒤**다:
 *  R1 hostaccess  기동 때 읽기 오류면 확정 대기(pending)가 없어 보여 자동 되돌림 타이머가 걸리지 않았다 — 다시 읽혀도(107 추정 E1 · 재현)
 *  R2 ipam/scanStore  대역 정책을 못 읽는 동안 '관리 IP 아님' 으로 판정해 정책 관리 IP 의 스캔 결과를 보존 기간으로 지웠다(25회차 F-4 ③ 의 형제)
 *  R3 ipam/rangePolicies · settings  '읽히면 리비전을 올려 판정 캐시를 버린다' 는 load() 를 직접 부르는 길에서만 일어났다 — 매칭 인덱스 · 무시 매처 · 분류기는
 *     캐시를 먼저 돌려줘 다시 읽힌 뒤에도 빈 정책 · 빈 설정으로 계속 판정했다
 *  R4 focusmon/store  못 읽은 동안 건 잠깐 보기가, 다시 읽힌 계속 수집에서 그 서버를 빼고 그 정의를 파일에 썼다(계속 수집이 잠깐 보기를 넘겨받는 규칙의 반대)
 *  R5 security/loginMonitor  기동 때 기본값(15분)으로 건 타이머가 다시 읽힌 뒤에도 그대로였다(107 추정 E2 · 재현)
 *  R6 attach/store  목록을 못 읽은 동안 지워진 문서 · 이슈의 첨부가 다시 읽힌 뒤에도 남았다(107 추정 E3 · 재현)
 *  R7 central/agentConfig  못 읽은 동안 온 retain(413 으로 못 보낸 파일 — 직전 사본 유지) push 가, 다시 읽힌 뒤 합칠 때 파일의 그 사본을 지웠다
 *  R8 문구  svcmon/batches '읽히면 다시 기록됩니다'(다시 기록하지 않는다) · focusmon/audit '30초마다 다시 읽습니다'(상태가 바뀐 뒤에는 다시 읽지 않는다)
 *  R10 ping/settings  읽기 오류 → 그 파일을 치움 → 새로 저장 — 재읽기 간격(30초) 안에서는 옛 읽기 오류가 다시 서고 방금 저장한 값이 적용되지 않았다(106회차 R2 와 같은 꼴)
 *  R9 분류표  readErrorSweep97 의 남은 'left'(ipam/vcRangeMigrate) 사유가 낡았다 — 105회차 A2 에서 읽기 단계를 이미 갈랐다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut115-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.IPAM_WRITE_DEBOUNCE_MS = '20';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const put = (n, v) => fs.writeFileSync(F(n), typeof v === 'string' ? v : JSON.stringify(v));
const realRead = fs.readFileSync;
const raw = (n) => realRead.call(fs, F(n), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

let seq = 0;
const fresh = (rel) => import(`../src/${rel}?r115=${++seq}`);

/** 그 파일 이름만 EIO — 파일은 그대로 있는 읽기 오류(권한 · 디스크). 돌려주는 함수가 주입을 푼다(비동기 구간에도 쓸 수 있게 손으로 푼다). */
function eio(...names) {
  const prev = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (names.includes(path.basename(String(f)))) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return prev.call(fs, f, ...a); };
  return () => { fs.readFileSync = prev; };
}
const quiet = async (fn) => { const w = console.warn; const e = console.error; const l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; fs.readFileSync = realRead; } };   // 실패한 시험의 주입이 다음 시험으로 새지 않게

let scanStore = null;
after(() => {
  fs.readFileSync = realRead;
  RD._setJsonFileLoadClockForTest();
  try { scanStore?.flushAllNow(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

/* ── R1 ───────────────────────────────────────────────────────────────────── */
test('R1 호스트 접근 제어: 기동 때 읽기 오류였어도 다시 읽히면 확정 대기의 자동 되돌림이 돈다(기한 지남 = 곧바로 · 기한 전 = 기한에)', () => quiet(async () => {
  const H = await import('../src/hostaccess/settings.js');
  const S = await import('../src/hostaccess/service.js');
  const calls = [];
  S._setExec({ fw: async (args) => { calls.push(args.join(' ')); return { ok: true, stdout: '', stderr: '', code: 0 }; }, isSudoDenied: () => false, sshdActive: async () => true, sshdCtl: async () => ({ ok: true, stdout: '', stderr: '' }) });
  S._setResumeRetryMs?.(15);
  try {
    // ① 기한이 이미 지난 확정 대기 — 재시작 전에 적용만 하고 확정하지 않은 런타임 규칙이 남아 있다
    put('host-access.json', { draft: {}, applied: null, pending: { at: Date.now() - 600_000, deadline: Date.now() - 1_000, by: 'adm', fingerprint: 'fp-1', rich: [] } });
    H._resetHostAccessCache();
    let off = eio('host-access.json');
    const before = raw('host-access.json');
    await S.resumeHostAccessPending();
    assert.equal(calls.length, 0, '못 읽는 동안은 판정하지 않는다');
    await sleep(60);   // 다시 보기 타이머가 몇 번 돌아도 — 아직 못 읽는다
    assert.equal(calls.length, 0);
    assert.equal(raw('host-access.json'), before, '못 읽는 동안 원본을 건드리지 않는다');
    off(); pass();
    await sleep(120);
    assert.deepEqual(calls, ['--reload'], '다시 읽히면 기한이 지난 확정 대기를 자동으로 되돌린다(예전: 재시작 · 수동 되돌림까지 런타임 규칙이 남았다)');
    assert.equal(JSON.parse(raw('host-access.json')).pending, null);

    // ② 기한이 아직 남은 확정 대기 — 다시 읽히면 기한에 맞춰 타이머를 건다
    calls.length = 0;
    put('host-access.json', { draft: {}, applied: null, pending: { at: Date.now(), deadline: Date.now() + 250, by: 'adm', fingerprint: 'fp-2', rich: [] } });
    H._resetHostAccessCache();
    off = eio('host-access.json');
    await S.resumeHostAccessPending();
    off(); pass();
    await sleep(100);
    assert.equal(calls.length, 0, '기한 전에는 되돌리지 않는다(확정할 시간을 뺏지 않는다)');
    await sleep(350);
    assert.deepEqual(calls, ['--reload'], '기한에 자동 되돌림');
    assert.equal(JSON.parse(raw('host-access.json')).pending, null);
  } finally { S._setExec(null); S._setResumeRetryMs?.(); H._resetHostAccessCache(); }
}));

/* ── R2 ───────────────────────────────────────────────────────────────────── */
test('R2 IP 스캔 결과 정리: 대역 정책 파일을 못 읽는 동안에는 정책 관리 IP 를 지우지 않는다(모르면 모두 관리로 본다)', () => quiet(async () => {
  // 10.77.0.0/24 를 덮는 정책 — 이 대역의 스캔 결과는 보존 기간이 지나도 남아야 한다
  put('ipam-range-policies.json', { policies: [{ id: 'p-r115', spec: '10.77.0.0/24', specLo: 172818432, specHi: 172818687, specSize: 256, status: 'reserved', priority: 100, enabled: true }] });
  const off = eio('ipam-range-policies.json');   // 공용 인스턴스가 처음 읽기 전에 건다(기동 때 읽기 오류)
  const ss = await import('../src/ipam/scanStore.js');
  scanStore = ss;
  const P = await import('../src/ipam/rangePolicies.js');
  const old = Date.now() - 400 * 86_400_000;
  ss.mergeScanResults([{ ip: '10.77.0.5', openPorts: [22], services: ['SSH'] }, { ip: '10.88.0.5', openPorts: [22], services: ['SSH'] }], old, 'edge-r115');
  assert.ok(P.rangePoliciesWriteRefusal(), '준비: 정책 파일이 읽기 오류 상태가 아니다');
  ss.pruneScanResults(30);
  assert.ok(ss.getScanResults()['10.77.0.5'], '정책을 못 읽는 동안 정책 관리 IP 의 스캔 결과를 지웠다(빈 정책 = 관리 IP 없음으로 판정)');
  assert.ok(ss.getScanResults()['10.88.0.5'], '못 읽는 동안에는 어느 IP 가 관리 대상인지 모른다 — 지우지 않는다');
  off(); pass();
  ss.pruneScanResults(30);
  assert.equal(P.rangePoliciesWriteRefusal(), null);
  assert.ok(ss.getScanResults()['10.77.0.5'], '다시 읽힌 뒤: 정책이 덮는 IP 는 남는다');
  assert.equal(ss.getScanResults()['10.88.0.5'], undefined, '다시 읽힌 뒤: 정책 밖 IP 는 예전처럼 보존 기간으로 정리된다');
}));

/* ── R3 ───────────────────────────────────────────────────────────────────── */
test('R3 대역 정책 · IP 관리 설정: 다시 읽히면 캐시된 매칭 인덱스 · 무시 매처 · 분류기도 풀린다(load 를 직접 부르는 길이 없어도)', () => quiet(async () => {
  put('ipam-range-policies.json', { policies: [{ id: 'p1', spec: '10.5.0.0/24', specLo: 168099840, specHi: 168100095, specSize: 256, status: 'reserved', priority: 100, enabled: true }] });
  let off = eio('ipam-range-policies.json');
  const P = await fresh('ipam/rangePolicies.js');
  const ip = 168099845;   // 10.5.0.5
  assert.equal(P.findPolicy(ip, ''), null, '못 읽는 동안은 정책이 없어 보인다');
  assert.equal(P.isCoveredByAnyPolicy(ip), false);
  const rev0 = P.policiesRev();
  off(); pass();
  // 대장 재구성 경로는 policiesRev()(캐시 키) · findPolicy(인덱스)만 부른다 — getPolicies()/화면 조회가 없어도 풀려야 한다
  assert.ok(P.policiesRev() > rev0, '다시 읽혔는데 리비전이 그대로다 — 빈 정책으로 만든 대장 캐시가 남는다');
  assert.equal(P.findPolicy(ip, '')?.id, 'p1', '다시 읽혔는데 빈 인덱스로 계속 판정한다');
  assert.equal(P.isCoveredByAnyPolicy(ip), true);

  // 인덱스만 부르는 길(리비전 조회 없이)도 같다
  off = eio('ipam-range-policies.json');
  const P2 = await fresh('ipam/rangePolicies.js');
  assert.equal(P2.isCoveredByAnyPolicy(ip), false);
  off(); pass();
  assert.equal(P2.isCoveredByAnyPolicy(ip), true, '인덱스 경로만으로도 다시 읽는다');

  put('ipam-settings.json', { global: ['10.9.0.0/16'], vcenters: {}, publicRanges: ['10.200.0.0/16'], privateRanges: [] });
  off = eio('ipam-settings.json');
  const S = await fresh('ipam/settings.js');
  assert.equal(S.getIgnoreMatcher()('10.9.1.1', ''), false, '못 읽는 동안은 무시 대역이 없어 보인다');
  assert.equal(S.getClassifier()('10.200.1.1'), 'private');
  const r0 = S.settingsRev();
  off(); pass();
  assert.equal(S.getIgnoreMatcher()('10.9.1.1', ''), true, '다시 읽혔는데 빈 무시 매처로 계속 판정한다(무시 대역 IP 가 대장 · 외부 공유 원장에 실린다)');
  assert.equal(S.getClassifier()('10.200.1.1'), 'public', '다시 읽혔는데 빈 분류기로 계속 판정한다');
  assert.ok(S.settingsRev() > r0, '리비전이 올라 대장 캐시가 풀린다');
  // 리비전 조회만으로도(대장 캐시 키) 다시 읽는다
  off = eio('ipam-settings.json');
  const S2 = await fresh('ipam/settings.js');
  S2.getIgnoreMatcher();
  const r1 = S2.settingsRev();
  off(); pass();
  assert.ok(S2.settingsRev() > r1);
  // 분류기만 부르는 길(인벤토리 공인 · 사설 분류 — 매처 · 리비전 조회 없이)도 같다
  off = eio('ipam-settings.json');
  const S3 = await fresh('ipam/settings.js');
  assert.equal(S3.getClassifier()('10.200.1.1'), 'private');
  off(); pass();
  assert.equal(S3.getClassifier()('10.200.1.1'), 'public', '분류기 경로만으로도 다시 읽는다');
  // 못 읽는 동안에는 간격 안에서 디스크를 다시 보지 않는다(요청마다 부르는 길 — 30초 간격은 reader 가 지킨다)
  let reads = 0;
  const prev = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === 'ipam-settings.json') { reads += 1; const e = new Error('EIO'); e.code = 'EIO'; throw e; } return prev.call(fs, f, ...a); };
  try {
    const S4 = await fresh('ipam/settings.js');
    for (let i = 0; i < 50; i++) { S4.settingsRev(); S4.getIgnoreMatcher(); S4.getClassifier(); }
    assert.equal(reads, 1, '읽기 오류 동안 요청마다 디스크를 읽으면 안 된다');
    pass();
    for (let i = 0; i < 50; i++) { S4.settingsRev(); S4.getIgnoreMatcher(); S4.getClassifier(); }
    assert.equal(reads, 2, '간격이 지나면 한 번만 다시 읽는다');
  } finally { fs.readFileSync = prev; }
}));

/* ── R4 ───────────────────────────────────────────────────────────────────── */
test('R4 집중 모니터링: 못 읽은 동안 건 잠깐 보기가 저장된 계속 수집의 서버를 빼앗지 않는다(계속 수집이 넘겨받는다)', () => quiet(async () => {
  const F1 = await import('../src/focusmon/store.js');
  F1._resetForTest();
  put('focusmon-sessions.json', { v: 1, sessions: [{ id: 'fs-abcdef12', mode: 'record', by: 'adm', targets: ['fm-aaaaaa1', 'fm-bbbbbb2'], interval: 5, startedAt: NOW - 60_000 }] });
  const off = eio('focusmon-sessions.json');
  assert.deepEqual(F1.listSessions(NOW), []);
  const w = F1.startSession({ targets: ['fm-aaaaaa1'], mode: 'watch', by: 'op' }, NOW);
  assert.equal(w.ok, true, '준비: 못 읽는 동안에는 그 서버가 수집 중인지 몰라 잠깐 보기가 걸린다');
  const r = F1.startSession({ targets: ['fm-cccccc3'], mode: 'record', by: 'op' }, NOW);
  assert.equal(r.ok, true);
  off(); pass();
  const all = F1.listSessions(NOW);
  const rec = all.find((x) => x.id === 'fs-abcdef12');
  assert.deepEqual(rec?.targets, ['fm-aaaaaa1', 'fm-bbbbbb2'], '잠깐 보기가 계속 수집의 서버를 빼앗았다 — 잠깐 보기가 끝나면 그 서버의 계속 수집이 말없이 사라진다');
  assert.ok(!all.some((x) => x.mode === 'watch' && x.targets.includes('fm-aaaaaa1')), '서버는 수집 하나에만 — 잠깐 보기는 넘겨주고 끝난다');
  assert.ok(all.some((x) => x.id === r.session.id), '그동안 시작한 계속 수집은 남는다');
  assert.ok(F1.endedSessions().some((x) => x.id === w.session.id && x.why === 'moved'), '넘겨준 잠깐 보기는 평소 규칙대로 끝난다(why moved)');
  assert.deepEqual(F1.drainLoadFixes(), [], "옛 판본의 '겹친 계속 수집 정리' 로 처리하지 않는다(그 안내 · fm_run 고쳐 쓰기는 이 경우가 아니다)");
  const saved = JSON.parse(raw('focusmon-sessions.json')).sessions;
  assert.deepEqual(saved.find((x) => x.id === 'fs-abcdef12')?.targets, ['fm-aaaaaa1', 'fm-bbbbbb2'], '정의 파일에도 줄어든 계속 수집을 쓰지 않는다');
  F1._resetForTest();
}));

/* ── R5 ───────────────────────────────────────────────────────────────────── */
test('R5 로그인 실패 감시: 기동 때 기본 주기로 건 타이머를 다시 읽힌 설정의 주기로 다시 건다', () => quiet(async () => {
  put('login-monitor.json', { enabled: true, intervalMin: 60, days: 7, threshold: 5, windowMin: 10, alert: false });
  const M = await fresh('security/loginMonitor.js');
  const realSI = globalThis.setInterval; const realST = globalThis.setTimeout; const realCI = globalThis.clearInterval;
  const armed = []; const cleared = [];
  globalThis.setInterval = (fn, ms) => { const t = realSI(() => {}, 2 ** 30); t.unref?.(); armed.push({ ms, t }); return t; };
  globalThis.clearInterval = (t) => { cleared.push(t); return realCI(t); };
  globalThis.setTimeout = (fn, ms, ...a) => (ms === 40_000 ? { unref() {} } : realST(fn, ms, ...a));   // 기동 40초 뒤 첫 분석은 돌리지 않는다
  const off = eio('login-monitor.json');
  try {
    M.startLoginMonitor();
    assert.deepEqual(armed.map((x) => x.ms), [15 * 60_000], '준비: 못 읽는 동안은 기본 주기(15분)');
    off(); pass();
    assert.equal(M.loginMonitorStatus().settings.intervalMin, 60, '다시 읽힌 설정');
    assert.deepEqual(armed.map((x) => x.ms), [15 * 60_000, 60 * 60_000], '다시 읽혔는데 타이머는 기본 주기 그대로였다(다음 저장 · 재시작까지)');
    assert.ok(cleared.includes(armed[0].t), '기본 주기 타이머는 지운다(둘이 함께 돌지 않게)');
    // 꺼 둔 감시는 다시 읽히면 타이머를 건 채 두지 않는다
    put('login-monitor.json', { enabled: false, intervalMin: 60 });
    const M2 = await fresh('security/loginMonitor.js');
    armed.length = 0; cleared.length = 0;
    const off2 = eio('login-monitor.json');
    M2.startLoginMonitor();
    assert.equal(armed.length, 1);
    off2(); pass();
    assert.equal(M2.loginMonitorStatus().settings.enabled, false);
    assert.ok(cleared.includes(armed[0].t), '꺼 둔 감시의 기본 주기 타이머를 지운다');
    assert.equal(armed.length, 1);
  } finally {
    fs.readFileSync = realRead;
    for (const x of armed) realCI(x.t);
    globalThis.setInterval = realSI; globalThis.setTimeout = realST; globalThis.clearInterval = realCI;
  }
}));

/* ── R6 ───────────────────────────────────────────────────────────────────── */
test('R6 첨부: 목록을 못 읽은 동안 지워진 문서의 첨부는 다시 읽힌 뒤 지운다(본체도)', () => quiet(async () => {
  const A = await import('../src/attach/store.js');
  A._resetAttachCache();
  const a = A.addAttachment('wiki', 'W5', 'a.txt', Buffer.from('rebut115 첨부 하나'), 'adm');
  const keep = A.addAttachment('wiki', 'W6', 'b.txt', Buffer.from('rebut115 첨부 둘'), 'adm');
  assert.ok(fs.existsSync(A.blobOf(a.id)));
  A._resetAttachCache();
  const off = eio('attachments.json');
  const before = raw('attachments.json');
  assert.equal(A.removeOwner('wiki', 'W5'), 0, '못 읽는 동안에는 지울 것을 모른다');
  assert.equal(raw('attachments.json'), before, '못 읽는 동안 목록을 쓰지 않는다');
  off(); pass();
  assert.deepEqual(A.listFor('wiki', 'W5'), [], '지워진 문서의 첨부가 다시 읽힌 뒤에도 남았다(주인 없는 첨부 — 전체 상한을 차지하고 목록 · 본체 점검에도 보이지 않는다)');
  assert.equal(fs.existsSync(A.blobOf(a.id)), false, '본체도 지운다');
  assert.equal(A.listFor('wiki', 'W6').length, 1, '다른 문서의 첨부는 그대로');
  assert.ok(fs.existsSync(A.blobOf(keep.id)));
  assert.deepEqual(JSON.parse(raw('attachments.json')).items.map((x) => x.owner), ['W6']);

  // 결정(권장안): 전체 상한 설정을 못 읽는 동안에는 기본 상한(2GB)으로 판정하지 않는다 — 올리기 503(본체를 쓰기 전에)
  A.saveAttachSettings({ maxTotalMB: 1 });
  A._resetAttachCache();
  const blobs = () => fs.readdirSync(A.attachDir()).length;
  const n0 = blobs();
  const off2 = eio('attach-settings.json');
  let thrown = null;
  try { A.addAttachment('wiki', 'W6', 'c.txt', Buffer.alloc(1_200_000, 0x61), 'adm'); } catch (e) { thrown = e; }
  assert.equal(thrown?.status, 503, '못 읽은 상한을 기본값(2GB)으로 보고 1MB 상한을 넘는 파일을 받았다');
  assert.equal(thrown?.extra?.code, 'settingsUnreadable');
  assert.match(thrown.message, /읽기 오류\(EIO\)/);
  assert.equal(blobs(), n0, '본체를 남기지 않는다');
  off2(); pass();
  try { A.addAttachment('wiki', 'W6', 'c.txt', Buffer.alloc(1_200_000, 0x61), 'adm'); thrown = null; } catch (e) { thrown = e; }
  assert.equal(thrown?.status, 409, '다시 읽히면 저장된 상한(1MB)으로 판정한다');
  assert.equal(thrown?.extra?.code, 'attach-full');
  assert.equal(A.addAttachment('wiki', 'W6', 'd.txt', Buffer.from('작은 파일'), 'adm').name, 'd.txt', '상한 안의 올리기는 다시 열린다');
  A._resetAttachCache();
}));

/* ── R7 ───────────────────────────────────────────────────────────────────── */
test('R7 엣지 설정 사본: 못 읽은 동안 온 retain push 가 다시 읽힌 뒤 파일의 그 사본을 지우지 않는다', () => quiet(async () => {
  put('central-agent-config.json', { 'edge-a': { at: 1000, files: { 'idrac.json': '{"big":true}', 'small.json': '{"v":1}' } }, 'edge-z': { at: 5, files: { 'z.json': '{}' } } });
  const off = eio('central-agent-config.json');
  const C = await fresh('central/agentConfig.js');
  assert.equal(C.agentConfigUnread(), true);
  // 엣지가 413 으로 못 보낸 큰 파일은 retain 으로 '직전 사본 유지' 를 청한다 — 못 읽는 동안에는 직전 사본을 모른다
  const r = C.setAgentConfig('edge-a', { 'small.json': '{"v":2}' }, { retain: ['idrac.json', 'never.json'] });
  assert.equal(r.ok, true);
  off(); pass();
  const all = C.getAllAgentConfigs();
  assert.equal(all['edge-a'].files['small.json'], '{"v":2}', '그동안 받은 것이 더 최근이다');
  assert.equal(all['edge-a'].files['idrac.json'], '{"big":true}', '다시 읽힌 뒤 합치면서 retain 으로 청한 직전 사본을 지웠다(중앙 통합 백업에서 그 엣지의 큰 설정이 사라진다)');
  assert.deepEqual((all['edge-a'].retained || []).map((x) => x.name), ['idrac.json'], '유지한 파일은 낡음을 밝힌다');
  assert.equal(all['edge-a'].retained[0].since, 1000);
  assert.ok(!Object.hasOwn(all['edge-a'].files, 'never.json'), '직전 사본에도 없는 이름은 지어내지 않는다');
  assert.ok(all['edge-z'], '파일에만 있던 엣지의 사본은 그대로');
  // retain 없는 전체 push 는 예전처럼 통째로 바꾼다(엣지에서 지운 파일을 따라간다)
  put('central-agent-config.json', { 'edge-a': { at: 1000, files: { 'gone.json': '{}' } } });
  const off2 = eio('central-agent-config.json');
  const C2 = await fresh('central/agentConfig.js');
  C2.setAgentConfig('edge-a', { 'small.json': '{}' }, { retain: ['gone.json'] });
  C2.setAgentConfig('edge-a', { 'small.json': '{}' });
  off2(); pass();
  assert.deepEqual(Object.keys(C2.getAllAgentConfigs()['edge-a'].files), ['small.json']);
}));

/* ── R8 ───────────────────────────────────────────────────────────────────── */
test('R8 문구: 못 읽은 동안의 안내가 하지 않는 일을 말하지 않는다(배치 원장 · 디스크 점검 상태)', async () => {
  const B = await import('../src/svcmon/batches.js');
  put('svcmon-batches.json', { batches: [] });
  B._resetBatchCache();
  const warns = [];
  const w = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
  let off = eio('svcmon-batches.json');
  let rec;
  try { rec = B.recordBatch({ source: 'test', targets: 1 }); } finally { console.warn = w; }
  off(); pass();
  assert.equal(B.getBatch(rec.id), null, '준비: 못 읽은 동안의 등록은 다시 읽혀도 원장에 없다(다시 기록하지 않는다)');
  const line = warns.find((s) => s.includes('배치 원장을 읽지 못한')) || '';
  assert.ok(line, '무음이면 안 된다');
  assert.doesNotMatch(line, /다시 기록됩니다/, '다시 기록하지 않는데 그렇게 말한다');
  B._resetBatchCache();

  const A = await import('../src/focusmon/audit/service.js');
  A._resetForTest();
  put('focusmon-audit.json', { v: 1, ready: { 'fm-abcd12': { state: 'ready', at: 1 } }, jobs: [], lost: {} });
  off = eio('focusmon-audit.json');
  assert.match(A.auditStateError(), /30초마다 다시 읽습니다/, '상태가 바뀌기 전에는 30초마다 다시 읽는다');
  A.forgetTarget('fm-zzzz99');   // 못 읽은 동안 상태가 바뀜 — 이 프로세스는 메모리로 계속 돌고 파일을 다시 읽지 않는다
  off(); pass();
  const msg = A.auditStateError();
  assert.match(msg, /읽기 오류/);
  assert.doesNotMatch(msg, /30초마다 다시 읽습니다/, '다시 읽지 않는데 그렇게 말한다');
  assert.match(msg, /다시 시작/, '재시작해야 파일 상태로 돌아온다는 사실을 말한다');
  A._resetForTest();
});

/* ── R10 ──────────────────────────────────────────────────────────────────── */
test('R10 Ping 설정: 읽기 오류 뒤 그 파일을 치우고 새로 저장하면 옛 읽기 오류가 다시 서지 않는다(저장한 값이 곧바로 적용된다)', () => quiet(async () => {
  const P = await import('../src/ping/settings.js');
  put('ping-settings.json', { probeIntervalMs: 5000 });
  P._resetPingSettingsForTest();
  const off = eio('ping-settings.json');
  assert.equal(P.loadPingSettings().loadError?.readError, true, '준비: 읽기 오류 표지');
  assert.equal(P.savePingSettings({ timeoutMs: 3000 }).ok, false, '못 읽는 동안 저장 거절');
  off();
  fs.rmSync(F('ping-settings.json'));   // 운영자가 못 읽는 파일을 치웠다(재읽기 간격 30초가 지나기 전)
  assert.equal(P.loadPingSettings().loadError, null, '파일 없음은 읽기 오류가 아니다');
  const r = P.savePingSettings({ timeoutMs: 3000 }, { actor: 'adm' });
  assert.equal(r.ok, true);
  assert.equal(r.settings.loadError, null, '저장에 성공했는데 옛 읽기 오류(간격 안이라 디스크를 보지 않은 판정)가 다시 섰다');
  assert.equal(r.settings.timeoutMs, 3000, '방금 저장한 값이 적용되지 않았다(재읽기 간격이 지날 때까지 기본값)');
  assert.equal(P.loadPingSettings().source.timeoutMs, 'ui');
  assert.equal(P.savePingSettings({ timeoutMs: 3500 }).ok, true, '이어지는 저장도 거절되지 않는다');
  // 손으로 다시 놓은 파일(백업에서 되돌림)도 같다 — 간격을 기다리지 않고 읽는다
  P._resetPingSettingsForTest();
  put('ping-settings.json', { probeIntervalMs: 5000 });
  const off2 = eio('ping-settings.json');
  assert.equal(P.loadPingSettings().loadError?.readError, true);
  off2();
  fs.rmSync(F('ping-settings.json'));
  assert.equal(P.loadPingSettings().loadError, null);
  put('ping-settings.json', { timeoutMs: 4000 });
  assert.equal(P.loadPingSettings().timeoutMs, 4000, '되돌려 놓은 파일을 간격 안이라고 읽지 않았다');
  assert.equal(P.loadPingSettings().loadError, null);
  P._resetPingSettingsForTest();
}));

/* ── R9 ───────────────────────────────────────────────────────────────────── */
test('R9 분류표: ipam/vcRangeMigrate 의 분류 · 사유가 코드와 맞다 — 읽기 단계는 105회차 A2 에서 이미 갈랐다', () => {
  const t = realRead.call(fs, path.join(SRC, '..', 'test', 'readErrorSweep97.test.js'), 'utf8');
  const row = t.split('\n').find((l) => l.includes("'ipam/vcRangeMigrate.js'")) || '';
  // 119회차가 이 줄을 'left'(사유만 정정 — 이 회차) → 'own'(자체 분리 · 확인함 — left 0)으로 올렸다. 둘 다 같은 사실을 말한다 — 낡은 사유로 돌아가지 않는지만 고정한다.
  assert.match(row, /\['(?:left|own)'/);
  assert.doesNotMatch(row, /이전 안 함으로 읽음/, '낡은 사유 — 지금 코드는 읽기 오류를 표지로 세우고 이전을 건너뛴다');
  assert.match(row, /105회차/);
  const s = realRead.call(fs, path.join(SRC, 'ipam/vcRangeMigrate.js'), 'utf8');
  assert.match(s, /export function migrationStateReadError\(\)/, '분류표가 말하는 표지가 실제로 있다');
  assert.match(s, /try \{ raw = fs\.readFileSync\(STATE_FILE\(\), 'utf8'\); \} catch/, '읽기는 자기 try — parse 실패만 손상 보존으로 간다');
});
