/**
 * upgradeHedge2740_1.test.js — v2.740.1: 업그레이드 메타데이터(versions.json · 서명 manifest) 받기 '함께 보내기'(upgrade/hedgedFetch.js).
 *
 * 사용자 신고(v2.740 · 사내 저장소): '새 버전 확인' 을 누르면 화면이 20초 가까이 멈췄다(캡처 `upgrade › check · 19초` · 서버 처리 중).
 * 원인(재현): v2.736.3 이 시도마다 20초를 기다리게 해서, 첫 응답이 늦고 재시도는 곧바로 답하는 저장소에서 확인이 20.5초 걸렸다
 *   (첫 응답 25초 가짜 저장소). 모든 요청이 25초인 저장소에서는 60초를 기다린 뒤 실패했다.
 * 고친 것: 앞 시도가 3초(UPGRADE_CHECK_HEDGE_MS) 안에 응답하지 않으면 **끊지 않고** 다음 시도를 함께 보낸다 — 첫 응답 25초 저장소 3.1초,
 *   모든 요청 25초 저장소 25초에 성공(앞 시도가 이긴다). 먼저 온 응답을 쓰고 나머지는 끊는다. 큰 파일 다운로드에는 쓰지 않는다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'upgHedge-'));
process.env.CONFIG_DIR = CFG;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.UPGRADE_CHECK_TIMEOUT_MS;
delete process.env.UPGRADE_CHECK_HEDGE_MS;

const upg = await import('../src/upgrade/upgrade.js');
const vd = await import('../src/upgrade/versionsDoc.js');
const hf = await import('../src/upgrade/hedgedFetch.js');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const servers = [];
after(() => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ }
});
async function serve(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
const DOC = JSON.stringify({ latest: '9.9.9', versions: [{ version: '9.9.9', tar_gz: 'vmware-portal-9.9.9.tar.gz', size_bytes: 10, sha256: 'a'.repeat(64) }] });

/** 요청마다 delayOf(i) 뒤에 답한다(끊기면 답하지 않는다). 동시에 열린 요청 수를 잰다. */
function repo(delayOf, body = DOC) {
  let n = 0; let open = 0; let maxOpen = 0;
  const handler = (req, res) => {
    const i = ++n; open += 1; maxOpen = Math.max(maxOpen, open);
    const t = setTimeout(() => { if (!res.destroyed) { res.setHeader('content-type', 'application/json'); res.end(typeof body === 'function' ? body(i) : body); } }, delayOf(i));
    req.on('close', () => { open -= 1; clearTimeout(t); });
  };
  return { handler, count: () => n, open: () => open, maxOpen: () => maxOpen };
}
const settle = () => new Promise((r) => setTimeout(r, 200));

test('① UPGRADE_CHECK_HEDGE_MS — 빈 값·비숫자 = 기본 3초 · 0 이하 = 끔 · [1초, 30초]', () => {
  assert.equal(hf.hedgeMsOf(undefined), 3000);
  assert.equal(hf.hedgeMsOf(''), 3000);
  assert.equal(hf.hedgeMsOf('abc'), 3000);
  assert.equal(hf.hedgeMsOf('0'), 0);
  assert.equal(hf.hedgeMsOf('-5'), 0);
  assert.equal(hf.hedgeMsOf('500'), 1000);
  assert.equal(hf.hedgeMsOf('5000'), 5000);
  assert.equal(hf.hedgeMsOf('999999'), 30_000);
  const read = (v) => Number(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import(process.argv[1]); process.stdout.write(String(m.META_HEDGE_MS));",
    path.join(SRC, 'upgrade/hedgedFetch.js')], { env: { ...process.env, UPGRADE_CHECK_HEDGE_MS: v } }).toString());
  assert.equal(read(''), 3000, 'portal.env 의 빈 줄(KEY=)은 미지정');
  assert.equal(read('0'), 0);
});

test('② 사용자 신고 재현 — 첫 응답 25초 · 재시도는 곧바로 답하는 저장소: 확인이 6초 안에 끝난다(예전 20.5초)', { timeout: 40_000 }, async () => {
  const r = repo((i) => (i === 1 ? 25_000 : 50));
  const base = await serve(r.handler);
  const t0 = Date.now();
  const info = await upg.checkRemote(base, '1.0.0');
  const ms = Date.now() - t0;
  assert.equal(info.ok, true, info.error);
  assert.equal(info.latest, '9.9.9');
  assert.ok(ms < 6_000, `함께 보낸 둘째 시도로 받아야 한다(${ms}ms)`);
  assert.equal(r.count(), 2);
  await settle();
  assert.equal(r.open(), 0, '이긴 응답 뒤 앞 시도는 끊는다(연결을 남기지 않는다)');
});

test('③ 모든 요청이 느린 저장소 — 앞 시도를 끊지 않으므로 그 시도가 이긴다(예전: 시도마다 끊어 시한까지 실패)', { timeout: 30_000 }, async () => {
  const r = repo(() => 7_000);
  const base = await serve(r.handler);
  const t0 = Date.now();
  const [doc, err] = await upg.fetchRemoteVersions(base, { timeout: 12_000 });   // 시도 시한(1/3)이면 4초 → 예전 방식은 실패
  const ms = Date.now() - t0;
  assert.equal(err, null, String(err));
  assert.equal(doc.latest, '9.9.9');
  assert.ok(ms >= 6_900 && ms < 9_000, `첫 시도가 7초에 이긴다(${ms}ms)`);
  assert.equal(r.count(), 3, '3초마다 함께 보낸다(최대 3번)');
  assert.equal(r.maxOpen(), 3);
  await settle();
  assert.equal(r.open(), 0);
});

test('④ 빠른 저장소는 요청 1번 그대로', { timeout: 10_000 }, async () => {
  const r = repo(() => 30);
  const base = await serve(r.handler);
  const [doc, err] = await upg.fetchRemoteVersions(base);
  assert.equal(err, null);
  assert.equal(doc.latest, '9.9.9');
  assert.equal(r.count(), 1);
});

test('⑤ 재시도 대상 상태(503) — 다음 시도를 곧 보내고, 끝까지 503 이면 상태로 말한다', { timeout: 15_000 }, async () => {
  let n = 0;
  const base = await serve((_q, res) => { n += 1; if (n === 1) { res.statusCode = 503; res.end('busy'); return; } res.setHeader('content-type', 'application/json'); res.end(DOC); });
  const t0 = Date.now();
  const [doc, err] = await upg.fetchRemoteVersions(base);
  assert.equal(err, null, String(err));
  assert.equal(doc.latest, '9.9.9');
  assert.equal(n, 2);
  assert.ok(Date.now() - t0 < 2_000, '함께 보내기 3초를 기다리지 않고 짧은 대기 뒤 다음 시도');

  let m = 0;
  const base2 = await serve((_q, res) => { m += 1; res.statusCode = 503; res.end('busy'); });
  const [doc2, err2] = await upg.fetchRemoteVersions(base2);
  assert.equal(doc2, null);
  assert.equal(err2, 'versions.json HTTP 503');
  assert.equal(m, 3, '예전 재시도와 같은 상한(3번)');
});

test('⑥ 연결 거부(닫힌 포트) — 3번 시도 뒤 곧바로 실패하고 접속 실패로 말한다', { timeout: 15_000 }, async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  let attempts = 0;
  const t0 = Date.now();
  const p = hf.hedgedFetch(`http://127.0.0.1:${port}/versions.json`, { totalMs: 10_000, hedgeMs: 3000, onAttempt: (k) => { attempts = k; } });
  await assert.rejects(p, (e) => /ECONNREFUSED|fetch failed/i.test(`${e?.message} ${e?.cause?.code}`));
  assert.equal(attempts, 3);
  assert.ok(Date.now() - t0 < 3_000, `짧은 대기(400·800ms)로 끝난다(${Date.now() - t0}ms)`);
  const [, err] = await upg.fetchRemoteVersions(`http://127.0.0.1:${port}`);
  assert.match(err, /접속 실패/);
});

test('⑦ 일시 오류가 아닌 실패(인증서·차단·리다이렉트 거부)는 다시 보내지 않는다', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unable to verify the first certificate'); };
  await assert.rejects(hf.hedgedFetch('https://repo.example/versions.json', { totalMs: 10_000, hedgeMs: 3000, fetchImpl }), /certificate/);
  assert.equal(calls, 1);
});

test('⑧ 전체 시한 — 모든 시도를 끊고 시한 사유는 앞머리 그대로 + 함께 보낸 사실을 말한다', { timeout: 20_000 }, async () => {
  const r = repo(() => 60_000);
  const base = await serve(r.handler);
  const [doc, err] = await upg.fetchRemoteVersions(base, { timeout: 5_000 });
  assert.equal(doc, null);
  assert.match(err, /^versions\.json 을 전체 시한\(5초\) 안에 다 받지 못해 중단했습니다/);
  assert.match(err, /응답\(헤더\)을 시작하지 않았습니다/);
  assert.match(err, /앞 시도가 3초 안에 응답하지 않으면 끊지 않고 다음 시도를 함께 보냄/);
  assert.match(err, /시도 2번/);
  await settle();
  assert.equal(r.open(), 0, '시한이 지나면 진행 중인 시도를 전부 끊는다');
});

test('⑨ 서명 manifest 도 같은 규칙 — 첫 응답이 늦어도 곧 받는다', { timeout: 30_000 }, async () => {
  const r = repo((i) => (i === 1 ? 20_000 : 30), '{"m":1}');
  const base = await serve(r.handler);
  const t0 = Date.now();
  const m = await upg.fetchManifestText(`${base}/x.manifest.json`);
  assert.equal(m.text, '{"m":1}', JSON.stringify(m));
  assert.ok(Date.now() - t0 < 6_000);
});

test('⑩ hedgeMs 0 = 예전처럼 순서대로(시도마다 시한) — 동시에 두 요청을 보내지 않는다', { timeout: 10_000 }, async () => {
  let inFlight = 0; let maxIn = 0; let calls = 0;
  const fetchImpl = (_u, o) => new Promise((resolve, reject) => {
    calls += 1; inFlight += 1; maxIn = Math.max(maxIn, inFlight);
    const timer = setTimeout(() => { inFlight -= 1; const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; reject(e); }, o.timeoutMs);
    o.signal?.addEventListener('abort', () => { clearTimeout(timer); inFlight -= 1; reject(new Error('aborted')); }, { once: true });
    if (calls === 3) { clearTimeout(timer); inFlight -= 1; resolve(new Response('{}', { status: 200 })); }
  });
  // 전체 시한 신호를 준다 — 실패 뒤 다음 시도를 보내지 않는 결함이면 영원히 멈추지 않고 시한에서 실패로 드러난다(변이 검증에서 겪었다).
  const { res, attempts } = await hf.hedgedFetch('https://repo.example/versions.json', { totalMs: 2_000, attemptMs: 200, hedgeMs: 0, fetchImpl, signal: AbortSignal.timeout(5_000) });
  assert.equal(res.status, 200);
  assert.equal(attempts, 3);
  assert.equal(maxIn, 1);
});

test('⑪ 메타데이터만 함께 보낸다 — 번들·패키지 다운로드(수백 MB)는 예전 재시도 그대로(소스)', () => {
  const up = stripComments(fs.readFileSync(path.join(SRC, 'upgrade/upgrade.js'), 'utf8'));
  const fp = stripComments(fs.readFileSync(path.join(SRC, 'upgrade/fetchPackage.js'), 'utf8'));
  const body = (src, name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); const j = src.indexOf('\nexport ', i + 10); return src.slice(i, j < 0 ? undefined : j); };
  assert.match(body(up, 'fetchRemoteVersions'), /hedgedFetch\(/);
  assert.match(body(up, 'fetchManifestText'), /hedgedFetch\(/);
  assert.match(body(fp, 'fetchRemoteVersions'), /hedgedFetch\(/);
  assert.doesNotMatch(body(up, 'downloadArchive'), /hedgedFetch\(/, '큰 번들을 두세 번 받지 않는다');
  assert.doesNotMatch(body(fp, 'downloadPackage'), /hedgedFetch\(/);
  // 메타데이터 받기가 다시 '시도마다 끊는' 재시도로 돌아가지 않게.
  assert.doesNotMatch(body(up, 'fetchRemoteVersions'), /resilientFetch\(/);
  assert.doesNotMatch(body(up, 'fetchManifestText'), /resilientFetch\(/);
  assert.doesNotMatch(body(fp, 'fetchRemoteVersions'), /resilientFetch\(/);
  // 사유 문구는 한 벌(metaTimeoutReason)이고 함께 보내기 사실을 싣는다.
  assert.match(vd.metaTimeoutReason('x', { totalMs: 60_000, attemptMs: 20_000, attempts: 2, phase: 'headers', hedgeMs: 3000 }), /끊지 않고 다음 시도를 함께 보냄/);
  assert.match(vd.metaTimeoutReason('x', { totalMs: 60_000, attemptMs: 20_000, attempts: 2, phase: 'headers' }), /시도당 최대 20초/);
});
