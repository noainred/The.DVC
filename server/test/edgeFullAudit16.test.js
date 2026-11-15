/**
 * edgeFullAudit16.test.js — 전체 소스 점검 16회차(엣지 통신 ③ 점검 · 지도 · 전송 도구) 확정분.
 *  ① T-1: HAProxy 경로 점검은 수집 토큰을 **등록 URL 의 스킴**으로만 보낸다(https 로 등록된 엣지에 평문 http 로 토큰이 나가던 것)
 *  ② T-2: 통신 점검은 수집 서버를 id 로 찾는다(같은 표시 이름의 다른 수집 서버 토큰을 엉뚱한 URL 로 보내던 것) · 링크 id 도 가른다
 *  ③ T-3: 엣지 로그 가림 정규식 반복 상한 · 먼저 자르고 가림
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'edgefa16-'));
process.env.DATA_SOURCE = 'mock';
test.after(() => { try { fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true }); } catch { /* */ } });

test('① T-1 — https 로 등록된 엣지에 토큰을 평문 http 로 보내지 않는다(첫 바이트가 TLS)', async () => {
  const { buildTargets } = await import('../src/relaycheck/poller.js');
  const { runCheck } = await import('../src/relaycheck/checks.js');
  let first = null;
  const srv = net.createServer((s) => { s.once('data', (b) => { first = b; s.destroy(); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const targets = buildTargets({ autoHosts: true, enabled: true, profile: [{ port, kind: 'edge-portal' }] }, [{ id: 'edge1', url: `https://127.0.0.1:${port}`, token: 'SECRET-COLLECTOR-TOKEN', enabled: true }]);
    const t = targets.find((x) => x.port === port);
    assert.equal(t.scheme, 'https'); assert.equal(t.token, 'SECRET-COLLECTOR-TOKEN');
    await runCheck(t, { timeoutMs: 2_000 });
    assert.ok(first, '연결이 왔다');
    assert.ok(!first.toString('latin1').includes('SECRET-COLLECTOR-TOKEN'), '토큰이 평문으로 나가지 않는다');
    assert.equal(first[0], 0x16, 'TLS ClientHello(0x16)로 시작');
    // http 로 등록된 항목(등록부가 허용한 저장 http URL)은 예전 그대로 http
    const t2 = buildTargets({ autoHosts: true, enabled: true, profile: [{ port, kind: 'edge-portal' }] }, [{ id: 'edge2', url: `http://127.0.0.1:${port}`, token: 'T2', enabled: true }]).find((x) => x.port === port);
    assert.equal(t2.scheme, 'http');
  } finally { srv.close(); }
});

test('② T-2 — 같은 표시 이름의 수집 서버 둘: 토큰 · URL 은 같은 항목에서 · 링크 id 는 갈린다', async () => {
  const { buildLinks } = await import('../src/linkcheck/links.js');
  const { specFor } = await import('../src/linkcheck/run.js');
  const collectors = [
    { id: 'seoul-old', name: 'Seoul', url: 'https://10.1.1.1:3001', token: 'TOKEN-OLD', enabled: true },
    { id: 'seoul', name: 'Seoul', url: 'https://10.2.2.2:3001', token: 'TOKEN-NEW', enabled: true },
  ];
  const { links, problems } = buildLinks({ collectors, settings: {} });
  const ce = links.filter((l) => l.kind === 'central->edge');
  assert.equal(ce.length, 2); assert.notEqual(ce[0].id, ce[1].id, '링크 id 가 갈린다');
  assert.ok(problems.some((p) => /같은 표시 이름/.test(p.reason)));
  const nameCount = new Map(); for (const c of collectors) nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);
  const ctx = { collectors: new Map(collectors.map((c) => [c.id, c])), collectorsByName: new Map(collectors.filter((c) => nameCount.get(c.name) === 1).map((c) => [c.name, c])), collectorIds: collectors.map((c) => c.id) };
  for (const l of ce) {
    const sp = specFor(l, ctx);
    const own = collectors.find((c) => c.id === l.collectorId);
    assert.ok(sp.url.startsWith(own.url), `${l.collectorId} — 자기 URL`);
    assert.equal(sp.headers['X-Collector-Token'], own.token, `${l.collectorId} — 자기 토큰(예전: 이름 Map 의 마지막 항목 토큰)`);
  }
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/linkcheck/poller.js'), 'utf8');
  assert.match(src, /collectors: new Map\(collectors\.map\(\(c\) => \[String\(c\.id \|\| ''\), c\]\)\)/);
});

test('③ T-3 — 엣지 로그 가림 정규식은 선형 · 먼저 자른다', async () => {
  const { redactLogLine } = await import('../src/edgelog/redact.js');
  const line = 'X-'.repeat(4096);
  const t0 = performance.now(); redactLogLine(line); const ms = performance.now() - t0;
  const base = 'ab'.repeat(4096); const t1 = performance.now(); redactLogLine(base); const ms0 = performance.now() - t1;
  assert.ok(ms < Math.max(5, ms0 * 20), `X- 반복 줄 ${ms.toFixed(2)}ms(기준 ${ms0.toFixed(2)}ms)`);
  assert.equal(redactLogLine('X-Collector-Token: abc'), 'X-Collector-Token: ********'.replace('********', redactLogLine('X-Collector-Token: abc').split(': ')[1]));
  assert.ok(!redactLogLine('X-Collector-Token: SECRETVALUE').includes('SECRETVALUE'), '가림은 그대로');
  const c = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/edgelog/collect.js'), 'utf8');
  // 18회차 반증 A-1: 원문을 다 가린 뒤 화면 길이로 자른다(먼저 자르면 경계에 걸친 비밀 앞부분이 남았다)
  assert.match(c, /redactLogLine\(String\(e\.msg \?\? ''\)\.slice\(0, SCAN_MAX\)\)\.slice\(0, LINE_MAX\)/);
});

test('③ A-1 — 2,000자 경계에 걸친 비밀도 가린다(URL 사용자정보 · 따옴표 값)', async () => {
  const { collectEdgeLog } = await import('../src/edgelog/collect.js');
  const { pushLog } = await import('../src/logbuffer.js');
  const pad = (n) => 'p'.repeat(n);
  const lines = [
    `${pad(1_975)} https://admin:S3cr3tXYZLONGSECRET@corp.example/x`,   // 비밀 앞부분은 2,000자 안 · '@' 는 뒤
    `${pad(1_965)} {"password":"alpha bravoSECRET2 charlie"}`,     // 'bravoSECRET2' 는 2,000자 안 · 닫는 따옴표는 뒤
  ];
  for (const l of lines) pushLog('info', l);
  const r = await collectEdgeLog({ withStatus: false, limit: 50 });
  const its = r.logs.items; const txt = its.map((x) => x.msg).join('\n');
  assert.ok(!txt.includes('S3cr3t'), 'URL 비밀번호 앞부분이 남지 않는다');
  assert.ok(!txt.includes('bravoSECRET2'), '따옴표 값의 뒷 단어가 남지 않는다');
  for (const it of its) assert.ok(it.msg.length <= 2_000);
});

test('② A-2 — 통신 지도는 이름이 겹친 엣지의 \'중앙 → 엣지\' 점검 실패를 찾는다(링크 id 판정 하나)', async () => {
  const { buildLinks } = await import('../src/linkcheck/links.js');
  const { buildCommMap } = await import('../src/commmap/build.js');
  const NOW = Date.now();
  const cols = [
    { id: 'seoul-old', name: 'Seoul', url: 'https://10.1.1.1:3001', enabled: true },
    { id: 'seoul', name: 'Seoul', url: 'https://10.2.2.2:3001', enabled: true },
    { id: 'busan', name: 'Busan', url: 'https://10.3.3.3:3001', enabled: true },
  ];
  const ce = buildLinks({ collectors: cols, settings: {} }).links.filter((l) => l.kind === 'central->edge');
  const latestLinks = ce.map((l) => ({ link_id: l.id, ok: 0, ts: NOW - 1_000, phase: 'tcp', fail_kind: 'timeout', streak: 3 }));
  const r = buildCommMap({ now: NOW, collectors: cols, latestLinks, linkCheckEnabled: true });
  for (const id of ['seoul-old', 'seoul', 'busan']) {
    const e = r.edges.find((x) => x.id === id);
    assert.ok(e, id);
    assert.equal(e.linkCheck['central->edge']?.ok, false, `${id} — 실패 최신값을 찾는다(예전: 이름이 겹치면 null)`);
    assert.ok(e.reasons.includes('link-fail'), `${id} — 장애 사유`);
  }
});

test('① A-3 — https 점검의 인증서 · 프로토콜 실패는 \'cert\'(HTTP 무응답으로 오진하지 않는다)', async () => {
  const http = await import('node:http');
  const { runCheck } = await import('../src/relaycheck/checks.js');
  const { remedyFor } = await import('../src/relaycheck/remedy.js');
  const srv = http.createServer((_q, r) => r.end('{}'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const t = { host: '127.0.0.1', port: srv.address().port, kind: 'edge-portal', token: 'T', scheme: 'https', expectAgent: 'e1' };
    const r = await runCheck(t, { timeoutMs: 3_000 });
    assert.equal(r.ok, false); assert.equal(r.phase, 'cert', JSON.stringify(r));
    const rem = remedyFor({ kind: t.kind, host: t.host, port: t.port, phase: r.phase, error: r.error });
    assert.match(rem.title, /인증서/); assert.match(rem.steps.join(' '), /WAN_TLS_CA_FILE/);
  } finally { srv.close(); }
  const web = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src/views/tools/RelayCheckTool.jsx'), 'utf8');
  assert.match(web, /cert: 'TLS 인증서'/, '화면 단계 이름');
});
