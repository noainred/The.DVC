// v2.602 감사 수정 — 그룹 f(엣지 워커). 엣지 push·워커를 목 HTTP 중앙에 **실제로** 보내 요청 수·상태 객체를 본다
//   (v2.566 규약 — 순수 헬퍼만 고정하는 테스트는 push 함수가 통째로 틀리는 종류를 못 잡는다).
//   EDGE2602-01(설정 push 의 상태 파일 반응) · EDGE2602-02(404 'central 비활성화' 를 구버전으로 읽던 것)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2602f-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
fs.writeFileSync(path.join(CFG, 'daily-report.json'), JSON.stringify({ enabled: true, hour: 8, lastRunTs: 1 }));

// 목 중앙 — 경로별 응답을 테스트가 바꾼다. 요청 수를 경로별로 센다.
const hits = new Map();
const plan = new Map(); // path → { status, body(JSON 객체) | html(string) }
let srv; let base;
before(async () => {
  srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    hits.set(p, (hits.get(p) || 0) + 1);
    req.resume();
    req.on('end', () => {
      const r = plan.get(p) || { status: 200, body: { ok: true } };
      if (r.html != null) { res.writeHead(r.status, { 'Content-Type': 'text/html' }); res.end(r.html); return; }
      res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const { config } = await import('../src/config.js');
  config.agent.centralUrl = base;
  config.agent.centralToken = 'tok-2602f';
  config.agent.name = 'edge-2602f';
});
after(() => { srv?.close(); });

const DISABLED = { status: 404, body: { ok: false, reason: 'central 비활성화' } };
const OLD = { status: 404, html: '<!DOCTYPE html><pre>Cannot POST</pre>' };
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

// ── EDGE2602-01 ────────────────────────────────────────────────────────────────
test('EDGE2602-01 — 변경 감시는 상태·캐시 파일(*-activity.json 등)에 반응하지 않는다(backup 과 같은 기준)', async () => {
  const { configWatchRelevant } = await import('../src/agent/configPush.js');
  for (const n of ['storage-activity.json', 'sanswitch-activity.json', 'central-inventory.json', 'ipam-scan-history.json', 'bmusage-alert-state.json']) {
    assert.equal(configWatchRelevant(n), false, n);
  }
  for (const n of ['vcenters.json', 'portal.env', 'svcmon-log.json', 'daily-report.json']) assert.equal(configWatchRelevant(n), true, n);
  assert.equal(configWatchRelevant('notes.txt'), false);
  assert.equal(configWatchRelevant(''), false);
});

test('EDGE2602-01 — 변경 감시 push 는 설정 지문이 같으면(상태 파일·last* 만 바뀜) 보내지 않고, 설정이 바뀌면 보낸다', async () => {
  const cp = await import('../src/agent/configPush.js');
  cp._resetConfigPush();
  const P = '/api/central/agent-config';
  hits.set(P, 0);
  assert.equal(await quiet(() => cp.pushConfigNow()), true);                   // 첫 push(주기) — 지문 기록
  assert.equal(hits.get(P), 1);
  // 수집기의 작업 로그 쓰기 + 일일 보고의 실행 필드(lastRunTs)만 바뀐 쓰기 — 설정 변경이 아니다.
  fs.writeFileSync(path.join(CFG, 'storage-activity.json'), JSON.stringify({ events: [{ at: 2 }] }));
  fs.writeFileSync(path.join(CFG, 'daily-report.json'), JSON.stringify({ enabled: true, hour: 8, lastRunTs: 999 }));
  assert.equal(await quiet(() => cp.pushConfigNow({ onlyIfChanged: true })), null);
  assert.equal(hits.get(P), 1, '상태 파일 쓰기가 push 를 만들었다');
  assert.ok(cp.configPushStatus().lastUnchangedSkipAt, '생략 사실을 상태에 남긴다');
  // 실제 설정 변경 → push
  fs.writeFileSync(path.join(CFG, 'daily-report.json'), JSON.stringify({ enabled: true, hour: 9, lastRunTs: 999 }));
  assert.equal(await quiet(() => cp.pushConfigNow({ onlyIfChanged: true })), true);
  assert.equal(hits.get(P), 2);
  // 주기 push 는 지문과 무관하게 보낸다(중앙 사본 신선도)
  assert.equal(await quiet(() => cp.pushConfigNow()), true);
  assert.equal(hits.get(P), 3);
});

// ── EDGE2602-02 ────────────────────────────────────────────────────────────────
test('EDGE2602-02 — central404 본문 판정: 비활성화 / 거절 / 엔드포인트 없음', async () => {
  const { classifyCentral404Body } = await import('../src/agent/central404.js');
  assert.equal(classifyCentral404Body({ ok: false, reason: 'central 비활성화' }).kind, 'disabled');
  assert.equal(classifyCentral404Body({ ok: false, reason: '다른 사유' }).kind, 'refused');
  assert.equal(classifyCentral404Body(null).kind, 'no-endpoint');
});

test('EDGE2602-02 — capacityPush: central 꺼짐 404 는 last 에 실패로 남기고 백오프하지 않는다 · 구버전 404 만 백오프', async () => {
  const { config } = await import('../src/config.js');
  config.capacity.enabled = true; config.capacity.push = true;
  const cap = await import('../src/agent/capacityPush.js');
  const P = '/api/central/capacity-report';
  plan.set(P, DISABLED); hits.set(P, 0);
  const r1 = await quiet(() => cap.pushCapacityNow());
  assert.equal(r1.ok, false);
  assert.equal(cap.capacityPushStatus().last?.kind, 'disabled');
  assert.match(cap.capacityPushStatus().last?.reason, /꺼져/);
  assert.equal(cap.capacityPushStatus().unsupportedUntil, null, '꺼짐은 백오프하지 않는다(켜는 즉시 풀려야 한다)');
  await quiet(() => cap.pushCapacityNow());
  assert.equal(hits.get(P), 2, '다음 주기에도 다시 시도한다');
  plan.set(P, OLD);
  const r3 = await quiet(() => cap.pushCapacityNow());
  assert.equal(r3.ok, false);
  assert.equal(cap.capacityPushStatus().last?.kind, 'no-endpoint');
  assert.ok(cap.capacityPushStatus().unsupportedUntil > 0, '구버전 중앙은 1시간 백오프');
  plan.delete(P);
});

test('EDGE2602-02 — svcmonPush: central 꺼짐 404 는 last 에 실패로 남기고 백오프하지 않는다', async () => {
  const sv = await import('../src/agent/svcmonPush.js');
  const P = '/api/central/svcmon-report';
  plan.set(P, DISABLED); hits.set(P, 0);
  const r = await quiet(() => sv.pushSvcmonNow());
  assert.equal(r.ok, false);
  const st = sv.svcmonPushStatus();
  assert.equal(st.last?.kind, 'disabled');
  assert.match(String(st.last?.errors?.[0] || ''), /꺼져/);
  assert.equal(st.unsupportedUntil, null);
  plan.set(P, OLD);
  await quiet(() => sv.pushSvcmonNow());
  assert.equal(sv.svcmonPushStatus().last?.kind, 'no-endpoint');
  assert.ok(sv.svcmonPushStatus().unsupportedUntil > 0);
  plan.delete(P);
});

test('EDGE2602-02 — edgeLogWorker: central 꺼짐 404 는 ok:false(구버전이라 말하지 않는다) · 구버전 404 는 예전대로 ok', async () => {
  const w = await import('../src/agent/edgeLogWorker.js');
  const P = '/api/central/edge-log-jobs';
  plan.set(P, DISABLED);
  const r = await quiet(() => w.runEdgeLogWorkerOnce());
  assert.equal(r.ok, false);
  const last = w.edgeLogWorkerStatus().last;
  assert.equal(last.ok, false); assert.equal(last.kind, 'disabled');
  assert.doesNotMatch(String(last.error), /구버전/);
  plan.set(P, OLD);
  const r2 = await quiet(() => w.runEdgeLogWorkerOnce());
  assert.equal(r2.ok, true);
  assert.equal(w.edgeLogWorkerStatus().last.kind, 'no-endpoint');
  plan.delete(P);
});

test('EDGE2602-02 — linkCheckWorker: central 꺼짐 404 는 ok:false · 구버전 404 는 예전대로 ok', async () => {
  const w = await import('../src/agent/linkCheckWorker.js');
  const P = '/api/central/link-check-config';
  plan.set(P, DISABLED);
  const r = await quiet(() => w.runLinkCheckWorkerOnce());
  assert.equal(r.ok, false);
  const last = w.linkCheckWorkerStatus().last;
  assert.equal(last.ok, false); assert.equal(last.kind, 'disabled');
  plan.set(P, OLD);
  const r2 = await quiet(() => w.runLinkCheckWorkerOnce());
  assert.equal(r2.ok, true);
  assert.equal(w.linkCheckWorkerStatus().last.kind, 'no-endpoint');
  plan.delete(P);
});
