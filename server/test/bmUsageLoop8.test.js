/**
 * 베어메탈 사용률 점검 반복 8회차 — 회귀 고정.
 *  F1: 로그 보안 패널 상위 목록이 모든 종류를 한 문장(LIMIT 400)으로 잘라, 많은 종류(스캐너의 fail_user)가 다 채우면 sudo · 계정 변경 실행자 목록이 비었다
 *      (합은 4 · 1 인데 화면 '4 · —') → 종류마다 상위 secTop.
 *  F2: 데모 계정에 '진단 스냅샷 실행' · '집중 모니터링 시작' 이 열리고 누르면 403(denyDemoGuest) → GET 이 bmGate 표지(actions.run · actions.start)를 싣는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop8-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

test('F1 — 보안 상위 목록은 종류마다(스캐너 fail_user 가 400행을 넘게 채워도 sudo · 계정 변경 실행자가 보인다) · 합은 그대로', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const S = await import('../src/bmusage/logs/store.js');
  const { config } = await import('../src/config.js');
  const AG = config.agent?.name || '';
  const h0 = Math.floor(NOW / HOUR) * HOUR;
  const sec = [];
  for (let i = 0; i < 24; i += 1) {
    const hour = h0 - i * HOUR;
    for (let j = 0; j < 20; j += 1) sec.push({ hour, kind: 'fail_user', item: `scan${i}-${j}`, count: 2 });   // 시간마다 20(상한) → 24시간 480행
    if (i % 6 === 0) sec.push({ hour, kind: 'sudo', item: 'opsadmin', count: 1 });                           // 4행 · 합 4
  }
  sec.push({ hour: h0, kind: 'acct_change', item: 'useradd:tmpuser', count: 1 });
  const w = await S.logWriteBatch({ agent: AG, items: [{ key: 'KF1', readRev: null, at: NOW, state: { pos: {} }, status: {}, patterns: [], hours: [], sec }] });
  assert.equal(w.ok, true, JSON.stringify(w));
  const q = await S.logServerQuery({ agent: AG, key: 'KF1', from: h0 - 24 * HOUR, to: h0 + HOUR });
  assert.equal(q.secTotals.sudo, 4); assert.equal(q.secTotals.acct_change, 1);
  assert.deepEqual(q.sec.sudo, [{ item: 'opsadmin', count: 4 }], `재현 r8 F1 — 예전 sudo 목록 없음(합 4 · 화면 '4 · —') · ${JSON.stringify(Object.keys(q.sec))}`);
  assert.deepEqual(q.sec.acct_change, [{ item: 'useradd:tmpuser', count: 1 }]);
  assert.equal(q.sec.fail_user.length, 15, '많은 종류도 상위 secTop 까지만');
  assert.ok(q.sec.fail_user.every((x, i, a) => i === 0 || a[i - 1].count >= x.count), '많은 것부터');
  const q3 = await S.logServerQuery({ agent: AG, key: 'KF1', from: h0 - 24 * HOUR, to: h0 + HOUR, secTop: 3 });
  assert.equal(q3.sec.fail_user.length, 3);
});

test('F2 — 서버 상세 실행 표지(데모 · 역할): 스냅샷 실행 · 집중 시작은 실행 라우트 앞의 판정과 같다', async () => {
  const G = await import('../src/routes/api/bmWriteGate.js');
  const { demoGuestDenial } = await import('../src/auth/demoGuest.js');
  const demo = { user: { username: 'thedvcdemp', role: 'admin', demoGuest: true } };
  const adm = { user: { username: 'adm', role: 'admin', scope: null } };
  const op = { user: { username: 'op', role: 'operator', scope: null } };
  const vw = { user: { username: 'vw', role: 'viewer', scope: null } };
  for (const nm of ['snapshotRun', 'focusStart']) {
    const a = G.BM_ACTIONS[nm];
    assert.ok(demoGuestDenial(a.method, `/api${a.path}`), `${nm}: 데모 미들웨어가 거부하는 동작`);
    assert.deepEqual(G.bmGate(demo, nm), { ok: false, why: 'demo' }, `재현 r8 F2 — 예전 데모에 열림(${nm})`);
    assert.equal(G.bmGate(adm, nm).ok, true); assert.equal(G.bmGate(op, nm).ok, true);
    assert.deepEqual(G.bmGate(vw, nm), { ok: false, why: 'role-operator' });
  }
  // GET 응답에 표지가 실린다(스냅샷 · 집중 읽기 — 소스)
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bu = strip(fs.readFileSync(new URL('../src/routes/api/bmUsage.js', import.meta.url), 'utf8'));
  assert.match(bu, /actions:\s*\{\s*run:\s*bmGate\(req,\s*'snapshotRun'/);
  const po = strip(fs.readFileSync(new URL('../src/routes/api/bmPerfOps.js', import.meta.url), 'utf8'));
  assert.match(po, /actions:\s*\{\s*start:\s*bmGate\(req,\s*'focusStart'/);
  // 웹은 표지로 연다(역할만 보지 않는다)
  const snapTab = strip(fs.readFileSync(new URL('../../web/src/views/tools/BmSnapshotTab.jsx', import.meta.url), 'utf8'));
  assert.match(snapTab, /roleOk:\s*runG \? gateOk\(runG\)/);
  const focusTab = strip(fs.readFileSync(new URL('../../web/src/views/tools/BmFocusTab.jsx', import.meta.url), 'utf8'));
  assert.match(focusTab, /const roleOk = startG \? gateOk\(startG\)/);
});
