/**
 * pduPowerAudit78.test.js — 전체 점검 78회차(PDU · 전력 · 중계 점검) 확정분 회귀.
 *  F1 PDU 연결 테스트가 저장 비밀번호를 물려받는 판정 — host 만 보던 것을 저장 경로와 같은 판정(host · 계정 · SSH 포트)으로
 *  F2 HAProxy 경로 점검이 IP 리터럴(루프백 · 링크로컬)에 ipBlockReason 없이 접속하던 것
 *  F3 HQ 포탈 점검이 인스턴스 값 없는 응답(이 중앙이 아님)을 정상으로 보던 것
 *  F4 PDU 요약의 순시 전력 합이 유닛 일부를 못 읽은 부분 합인데 표지가 없던 것(서버 summarize + 웹 pduTotals)
 *  F5 PDU CSV 가져오기가 수정 행의 빈 계정 · 포트 칸을 기본값으로 덮어 저장 비밀번호를 조용히 버리던 것
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdu78-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

let srv, base, reg;
const ADMIN = { username: 'full', role: 'admin', scope: null };

/** 접속 수만 세는 TCP 서버(받자마자 끊는다) — 저장 비밀번호로 접속을 시도했는지를 '연결이 왔는가' 로 본다. */
async function countingServer() {
  const s = { n: 0 };
  s.srv = net.createServer((sock) => { s.n += 1; sock.destroy(); });
  await new Promise((r) => s.srv.listen(0, '127.0.0.1', r));
  s.port = s.srv.address().port;
  return s;
}
const withLoopback = async (on, fn) => {
  const prev = process.env.SSRF_ALLOW_LOOPBACK;
  if (on) process.env.SSRF_ALLOW_LOOPBACK = 'true'; else delete process.env.SSRF_ALLOW_LOOPBACK;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.SSRF_ALLOW_LOOPBACK; else process.env.SSRF_ALLOW_LOOPBACK = prev; }
};

before(async () => {
  const express = (await import('express')).default;
  reg = await import('../src/pdu/registry.js');
  const { registerPdu } = await import('../src/routes/api/pdu.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = ADMIN; next(); });
  const router = express.Router();
  registerPdu(router);
  app.use('/api', router);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { s: r.status, j: await r.json().catch(() => null) };
}

test('F1: 연결 테스트 — 계정 · SSH 포트를 바꾸고 비밀번호를 비우면 저장 비밀번호로 접속하지 않는다(400 · 연결 0)', async () => {
  await withLoopback(true, async () => {
    const s = await countingServer();
    try {
      const saved = reg.saveDevice({ name: 'P78', host: '127.0.0.1', username: 'apc', password: 'S3cret-78', sshPort: s.port });
      assert.equal(saved.ok, true, saved.reason);
      const id = saved.device.id;
      // 계정만 바꿈 — 예전에는 host 가 같아 저장 비밀번호가 'root' 로 나갔다
      const a = await post('/tools/pdu/test', { id, name: 'P78', host: '127.0.0.1', username: 'root', password: '', sshPort: s.port });
      assert.equal(a.s, 400, JSON.stringify(a.j));
      assert.match(a.j.reason, /접속처/);
      // SSH 포트만 바꿈(같은 호스트의 다른 포트) — 이 서버로는 연결이 오지 않아야 한다
      const other = await countingServer();
      try {
        const b = await post('/tools/pdu/test', { id, name: 'P78', host: '127.0.0.1', username: 'apc', password: '', sshPort: other.port });
        assert.equal(b.s, 400, JSON.stringify(b.j));
        assert.equal(other.n, 0, '바뀐 포트로 저장 비밀번호를 들고 접속하지 않는다');
      } finally { other.srv.close(); }
      assert.equal(s.n, 0, '바뀐 계정으로도 접속하지 않았다');
      // 접속처가 같으면 예전처럼 저장 비밀번호로 시도한다(재입력 없는 재테스트 — 연결이 온다)
      const c = await post('/tools/pdu/test', { id, name: 'P78', host: '127.0.0.1', username: 'APC ', password: '', sshPort: s.port });
      assert.notEqual(c.j?.reason, '비밀번호가 필요합니다.');
      assert.ok(!/접속처/.test(String(c.j?.reason || '')), JSON.stringify(c.j));
      assert.ok(s.n >= 1, '같은 접속처면 저장 비밀번호로 시도한다');
    } finally { s.srv.close(); }
  });
});

test('F1: 저장 경로와 테스트가 같은 판정 — pduAccessMoved(포트 빈 값 · 대소문자 · 공백)', () => {
  const saved = { host: '10.0.0.5', username: 'apc', sshPort: 22 };
  assert.equal(reg.pduAccessMoved(saved, { host: '10.0.0.5', username: 'APC' }), false, '포트를 안 보내면 저장값 유지');
  assert.equal(reg.pduAccessMoved(saved, { host: '10.0.0.5', username: 'apc', sshPort: '' }), false, '빈 포트 = 기본 22');
  assert.equal(reg.pduAccessMoved(saved, { host: '10.0.0.5', username: 'apc', sshPort: 2222 }), true);
  assert.equal(reg.pduAccessMoved(saved, { host: '10.0.0.6', username: 'apc' }), true);
  assert.equal(reg.pduAccessMoved(null, { host: 'x' }), false);
});

test('F2: 중계 점검은 IP 리터럴 루프백 · 링크로컬에 접속하지 않는다(ssrfLookup 은 리터럴을 보지 못한다)', async () => {
  const { runCheck } = await import('../src/relaycheck/checks.js');
  const s = await countingServer();
  try {
    await withLoopback(false, async () => {
      for (const kind of ['irs-ssh', 'edge-portal', 'irs-portal', 'hq-portal']) {
        const r = await runCheck({ host: '127.0.0.1', port: s.port, kind }, { timeoutMs: 2_000 });
        assert.equal(r.ok, false, kind);
        assert.match(String(r.error), /루프백/, kind);
      }
      const md = await runCheck({ host: '169.254.169.254', port: 80, kind: 'hq-portal' }, { timeoutMs: 2_000 });
      assert.equal(md.ok, false);
      assert.match(String(md.error), /링크로컬|메타데이터/);
      const v6 = await runCheck({ host: '::ffff:127.0.0.1', port: s.port, kind: 'irs-ssh' }, { timeoutMs: 2_000 });
      assert.equal(v6.ok, false);
    });
    assert.equal(s.n, 0, '루프백 시험 서버로 연결이 오지 않았다');
    // 운영 탈출구(SSRF_ALLOW_LOOPBACK=true)는 예전처럼 접속한다
    await withLoopback(true, async () => { await runCheck({ host: '127.0.0.1', port: s.port, kind: 'irs-ssh' }, { timeoutMs: 2_000 }); });
    assert.ok(s.n >= 1);
  } finally { s.srv.close(); }
});

test('F3: HQ 포탈 — 인스턴스 값이 없는 200 응답은 이 중앙이 아니다(실패 hq) · 같은 인스턴스면 정상', async () => {
  const { runCheck } = await import('../src/relaycheck/checks.js');
  const { instanceId } = await import('../src/instanceId.js');
  let body = '{"status":"ok","version":"2.400.0"}';
  const h = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  await new Promise((r) => h.listen(0, '127.0.0.1', r));
  const port = h.address().port;
  try {
    await withLoopback(true, async () => {
      const a = await runCheck({ host: '127.0.0.1', port, kind: 'hq-portal' }, { timeoutMs: 3_000 });
      assert.equal(a.ok, false, JSON.stringify(a));
      assert.equal(a.phase, 'hq');
      body = '<html>default page</html>';   // 포탈이 아닌 웹 서버(본문을 JSON 으로 못 읽음)
      const b = await runCheck({ host: '127.0.0.1', port, kind: 'hq-portal' }, { timeoutMs: 3_000 });
      assert.equal(b.ok, false, JSON.stringify(b));
      body = JSON.stringify({ instance: instanceId(), version: '9.9.9' });
      const c = await runCheck({ host: '127.0.0.1', port, kind: 'hq-portal' }, { timeoutMs: 3_000 });
      assert.equal(c.ok, true, JSON.stringify(c));
      const { remedyFor } = await import('../src/relaycheck/remedy.js');
      assert.match(remedyFor({ kind: 'hq-portal', host: 'h', port, phase: a.phase, error: a.error }).title, /중앙 자신이 아님/);
    });
  } finally { h.close(); }
});

test('F4: 순시 전력 합이 부분 합이면 powerPartial · 읽은 유닛 수를 싣고, 화면 합계 · 표지가 부분 합으로 센다', async () => {
  const { summarize } = await import('../src/pdu/types.js');
  const part = summarize({ units: [{ index: 1, powerW: 1000 }, { index: 2, powerW: null }] });
  assert.equal(part.powerW, 1000);
  assert.equal(part.powerPartial, true);
  assert.equal(part.powerUnitsRead, 1);
  const full = summarize({ units: [{ index: 1, powerW: 1000 }, { index: 2, powerW: 500 }] });
  assert.equal(full.powerW, 1500);
  assert.equal(full.powerPartial, undefined, '온전하면 필드를 싣지 않는다(예전 응답 모양)');
  const none = summarize({ units: [{ index: 1, powerW: null }] });
  assert.equal(none.powerW, null);
  assert.equal(none.powerPartial, undefined, '하나도 못 읽으면 부분 합이 아니라 미측정(null)');
  const web = await import('../../web/src/views/tools/pduTotals.js');
  const t = web.pduTotals([{ snapshot: { summary: part } }, { snapshot: { summary: full } }]);
  assert.equal(t.powerW, 2500);
  assert.equal(t.powerPartial, 1);
  assert.match(web.pduTotalNote(t), /부분 합 1대/);
  const mark = web.pduPowerMark(part);
  assert.equal(mark?.label, '부분 합');
  assert.match(mark.title, /2대 중 1대/);
  assert.equal(web.pduPowerMark(full), null);
});

test('F5: CSV 가져오기 — 수정 행의 빈 계정 · 포트는 저장값 유지(비밀번호 보존) · 바뀐 접속처의 비밀번호 폐기는 응답에 밝힌다', async () => {
  const s0 = reg.saveDevice({ name: 'C78', host: '10.78.0.5', username: 'admin', password: 'pw-78', sshPort: 2222 });
  assert.equal(s0.ok, true, s0.reason);
  // 계정 · 포트 열이 없는 부분 CSV(예: 이름만 고침)
  const a = await post('/tools/pdu/csv/import', { csv: 'name,host,password\nC78-renamed,10.78.0.5,\n' });
  assert.equal(a.s, 200, JSON.stringify(a.j));
  assert.equal(a.j.updated, 1);
  assert.equal(a.j.droppedSecrets, undefined, JSON.stringify(a.j));
  const d = reg.getDeviceWithSecret(s0.device.id);
  assert.equal(d.name, 'C78-renamed');
  assert.equal(d.username, 'admin', '빈 계정 칸이 기본값 apc 로 덮이지 않는다');
  assert.equal(d.sshPort, 2222, '빈 포트 칸이 22 로 덮이지 않는다');
  assert.equal(d.password, 'pw-78', '저장 비밀번호가 유지된다');
  // 새 장비는 예전처럼 기본값
  const b = await post('/tools/pdu/csv/import', { csv: 'name,host,password\nN78,10.78.0.6,pw\n' });
  assert.equal(b.j.added, 1);
  const n = reg.listDevices().find((x) => x.host === '10.78.0.6');
  assert.equal(n.username, 'apc'); assert.equal(n.sshPort, 22);
  // 계정을 실제로 바꾸고 비밀번호를 비우면 — 폐기 사실을 응답에 싣는다
  const c = await post('/tools/pdu/csv/import', { csv: 'name,host,username,password\nC78-renamed,10.78.0.5,root,\n' });
  assert.equal(c.j.updated, 1);
  assert.equal(c.j.droppedSecrets?.length, 1, JSON.stringify(c.j));
  assert.equal(c.j.droppedSecrets[0].host, '10.78.0.5');
  assert.equal(reg.getDeviceWithSecret(s0.device.id).password, '');
});

test('F6: 임계치 · 주기 파일의 읽기 오류(EISDIR)는 손상이 아니다 — 원본을 옮기지 않고 저장은 409 · 목록 응답에 표지', async () => {
  const jl = await import('../src/util/jsonFileLoad.js');
  const th = await import('../src/pdu/thresholds.js');
  const iv = await import('../src/pdu/intervals.js');
  let now = Date.now();
  jl._setJsonFileLoadClockForTest(() => now);
  try {
    for (const [name, loadErr, route, body] of [
      ['pdu-thresholds.json', th.pduThresholdsLoadError, '/tools/pdu/thresholds', { tempWarnC: 30 }],
      ['pdu-intervals.json', iv.pduIntervalsLoadError, '/tools/pdu/intervals', { pollMs: 120_000 }],
    ]) {
      const f = path.join(tmp, name);
      fs.rmSync(f, { recursive: true, force: true });
      fs.mkdirSync(f);   // 읽기 단계 실패(EISDIR) — 운영의 EACCES · EIO 와 같은 갈래(root 로 도는 시험이라 권한으로는 재현되지 않는다)
      now += 60_000;
      const e = loadErr();
      assert.ok(e, `${name} 못 읽음 표지`);
      assert.equal(e.readError, true, `${name} 읽기 오류로 갈린다 — ${e.reason}`);
      assert.ok(fs.statSync(f).isDirectory(), `${name} 원본을 옆으로 옮기지 않았다`);
      assert.equal(fs.readdirSync(tmp).filter((x) => x.startsWith(`${name}.corrupt`)).length, 0, '손상 보존본을 만들지 않았다');
      const r = await post(route, body);
      assert.equal(r.s, 409, `${route} 읽기 오류 중 저장 거절 — ${JSON.stringify(r.j)}`);
      assert.equal(r.j.code, 'settings-unreadable');
      assert.ok(fs.statSync(f).isDirectory(), '거절 뒤에도 그대로');
      const list = await fetch(`${base}/tools/pdu`).then((x) => x.json());
      assert.ok(list.loadErrors?.[name.includes('threshold') ? 'thresholds' : 'intervals'], JSON.stringify(list.loadErrors));
      // 고치면(디렉터리 제거 → 파일 없음 = 기본값) 다시 읽기 간격 뒤 풀리고 저장이 열린다
      fs.rmSync(f, { recursive: true, force: true });
      now += 60_000;
      assert.equal(loadErr(), null, `${name} 풀림`);
      const ok = await post(route, body);
      assert.equal(ok.s, 200, JSON.stringify(ok.j));
    }
    // 손상(형식 오류)은 예전처럼 보존본으로 옮기고, 관리자 저장이 푼다(엣지 배포 해제 규약 유지)
    const f = path.join(tmp, 'pdu-thresholds.json');
    fs.writeFileSync(f, '{ broken');
    now += 60_000;
    const e2 = th.pduThresholdsLoadError();
    assert.ok(e2 && !e2.readError, '손상');
    assert.ok(fs.readdirSync(tmp).some((x) => x.startsWith('pdu-thresholds.json.corrupt')), '손상 보존본');
    const saved = await post('/tools/pdu/thresholds', { tempWarnC: 29 });
    assert.equal(saved.s, 200, JSON.stringify(saved.j));
    assert.equal(th.pduThresholdsLoadError(), null);
  } finally { jl._setJsonFileLoadClockForTest(null); }
});

test('F7: 엣지 PDU 스냅샷의 최상위 판정 · 표시 필드 정제 — ok 는 불리언만 · authStopped 는 아는 모양만 · 버전 글자 상한', async () => {
  const { sanitizePduSnapshot } = await import('../src/central/pduEdge.js');
  const { snap } = sanitizePduSnapshot({
    id: 'p1', ok: 'false', error: '수집 실패', units: [], sensors: [],
    authStopped: { since: '1700000000000', at: 1700000001000, attempts: '3', reason: { x: 1 }, extra: 'y'.repeat(10_000) },
    aosVersion: { v: 1 }, appVersion: 'v'.repeat(5_000), cliSkipped: '4',
  });
  assert.equal(snap.ok, false, "'false' 글자가 참으로 읽히지 않는다");
  assert.deepEqual(snap.authStopped, { since: 1700000000000, at: 1700000001000, attempts: 3, reason: '' });
  assert.equal(snap.aosVersion, '');
  assert.equal(snap.appVersion.length, 128);
  assert.equal(snap.cliSkipped, 4);
  assert.equal(sanitizePduSnapshot({ id: 'p2', ok: true, authStopped: 'x' }).snap.authStopped, null);
  assert.equal(sanitizePduSnapshot({ id: 'p3', ok: true }).snap.ok, true);
  assert.equal(Object.hasOwn(sanitizePduSnapshot({ id: 'p4' }).snap, 'ok'), false, '없던 필드를 만들지 않는다');
});

test('F8: HAProxy 경로 점검 설정 — 읽기 오류는 원본을 두고 저장 409 · 손상은 사유와 함께 보존 · 둘 다 표지가 난다', async () => {
  const jl = await import('../src/util/jsonFileLoad.js');
  const st = await import('../src/relaycheck/settings.js');
  let now = Date.now();
  jl._setJsonFileLoadClockForTest(() => now);
  const f = path.join(tmp, 'relaycheck-settings.json');
  try {
    st._resetForTest();
    st.saveSettings({ enabled: false, hosts: [{ host: '10.78.1.1', label: 'site' }] });
    assert.equal(st.relayCheckSettingsLoadError(), null);
    // 읽기 오류(EISDIR) — 원본(여기서는 디렉터리)을 옮기지 않고 표지 · 저장 거절
    fs.rmSync(f, { force: true }); fs.mkdirSync(f);
    st._resetForTest(); now += 60_000;
    const e = st.relayCheckSettingsLoadError();
    assert.equal(e?.readError, true, JSON.stringify(e));
    assert.ok(fs.statSync(f).isDirectory(), '원본을 옮기지 않았다');
    assert.throws(() => st.saveSettings({ enabled: true }), (x) => x.status === 409 && x.code === 'settings-unreadable');
    assert.ok(fs.statSync(f).isDirectory());
    fs.rmSync(f, { recursive: true, force: true });
    // 손상 — 보존본(사유 포함)으로 옮기고 표지, 화면 저장이 푼다
    fs.writeFileSync(f, '{ not json');
    st._resetForTest(); now += 60_000;
    const c = st.relayCheckSettingsLoadError();
    assert.ok(c && !c.readError, JSON.stringify(c));
    assert.ok(fs.readdirSync(tmp).some((x) => x.startsWith('relaycheck-settings.json.corrupt')));
    assert.equal(st.loadSettings().enabled, true, '도는 값은 예전처럼 기본값');
    st.saveSettings({ enabled: false });
    assert.equal(st.relayCheckSettingsLoadError(), null);
    assert.equal(st.loadSettings().enabled, false);
    // 객체가 아닌 JSON(v2.601 TIM2601-03)도 손상 — 던지지 않는다
    fs.writeFileSync(f, 'null');
    st._resetForTest(); now += 60_000;
    assert.doesNotThrow(() => st.loadSettings());
    assert.ok(st.relayCheckSettingsLoadError());
  } finally { jl._setJsonFileLoadClockForTest(null); fs.rmSync(f, { recursive: true, force: true }); st._resetForTest(); }
});
