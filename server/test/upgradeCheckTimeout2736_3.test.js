/**
 * upgradeCheckTimeout2736_3.test.js — v2.736.3: 업그레이드 메타데이터(versions.json·서명 manifest) 받기 시한.
 *
 * 사용자 신고(v2.735.3 · 사내 미러 http://…:8081/repository/…): '새 버전 확인' 이
 *   "versions.json 을 전체 시한(10초) 안에 다 받지 못해 중단했습니다" 로 실패하고 자동 업그레이드가 멈췄다.
 * 원인(재현): v2.730(I-08)이 전체 시한 10초를 **시도 시한으로도** 써서, 첫 응답이 10초를 넘기면 재시도 없이 실패했다.
 *   v2.729 까지는 시도마다 10초 × 3번이라 두 번째 시도에서 받았다(첫 응답 12초 서버: 새 코드 10.0초 실패·요청 1번 /
 *   옛 방식 10.7초 성공·요청 2번).
 * 고친 것: 전체 시한 기본 60초(UPGRADE_CHECK_TIMEOUT_MS · [5초, 120초]) 안에서 시도마다 그 1/3(하한 5초)로 재시도 ·
 *   실패 사유가 '헤더를 기다리다' 와 '본문을 받다가' 를 나누고 시도 횟수를 말한다 · 설치 경로의 확인(예전 15초 상한)도 같은 시한.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'upgTimeout-'));
process.env.CONFIG_DIR = CFG;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.UPGRADE_CHECK_TIMEOUT_MS;

const upg = await import('../src/upgrade/upgrade.js');
const vd = await import('../src/upgrade/versionsDoc.js');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const servers = [];
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } } });
async function serve(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
const DOC = JSON.stringify({ latest: '9.9.9', versions: [{ version: '9.9.9', tar_gz: 'vmware-portal-9.9.9.tar.gz', size_bytes: 10, sha256: 'a'.repeat(64) }] });

/** 첫 요청은 `firstDelay` 뒤에 답하고(그 전에 끊기면 답하지 않는다), 이후 요청은 곧바로 답한다 — 원본을 받아 오는 사내 미러 흉내. */
function slowFirst(firstDelay, body = DOC) {
  let n = 0;
  const handler = (req, res) => {
    const i = ++n;
    const t = setTimeout(() => { if (!res.destroyed) { res.setHeader('content-type', 'application/json'); res.end(body); } }, i === 1 ? firstDelay : 50);
    req.on('close', () => { if (i === 1) clearTimeout(t); });
  };
  return { handler, count: () => n };
}

test('① 기본 시한 60초 · 시도 시한은 그 1/3(하한 5초) · 시도 3번이 전체 시한을 채운다', () => {
  assert.equal(vd.META_FETCH_TIMEOUT_MS, 60_000);
  assert.equal(vd.attemptTimeoutMs(60_000), 20_000);
  assert.equal(vd.attemptTimeoutMs(120_000), 40_000);
  assert.equal(vd.attemptTimeoutMs(12_000), 5_000, '하한 5초');
  for (const t of [15_000, 30_000, 60_000, 90_000, 120_000]) {
    const a = vd.attemptTimeoutMs(t);
    assert.ok(a < t, `재시도할 여지가 있어야 한다(${t} → ${a})`);
    assert.ok(a * vd.META_FETCH_ATTEMPTS >= t, `시도 3번이 전체 시한을 채워야 한다(${t} → ${a})`);
  }
});

test('② env UPGRADE_CHECK_TIMEOUT_MS — 빈 값·비숫자 = 기본 · [5초, 120초] 로 가둔다', () => {
  const read = (v) => Number(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import(process.argv[1]); process.stdout.write(String(m.META_FETCH_TIMEOUT_MS));",
    path.join(SRC, 'upgrade/versionsDoc.js')], { env: { ...process.env, UPGRADE_CHECK_TIMEOUT_MS: v } }).toString());
  assert.equal(read(''), 60_000);
  assert.equal(read('abc'), 60_000);
  assert.equal(read('0'), 60_000);
  assert.equal(read('1000'), 5_000);
  assert.equal(read('90000'), 90_000);
  assert.equal(read('999999'), 120_000);
});

test('③ 첫 응답이 전체 시한보다 늦어도 — 시도 시한으로 끊고 두 번째 시도로 받는다(v2.735.3 신고 재현)', { timeout: 30_000 }, async () => {
  const sv = slowFirst(13_000);
  const base = await serve(sv.handler);
  const t0 = Date.now();
  const [doc, err] = await upg.fetchRemoteVersions(base, { timeout: 12_000 });
  const ms = Date.now() - t0;
  assert.equal(err, null, String(err));
  assert.equal(doc.latest, '9.9.9');
  assert.equal(sv.count(), 2, '두 번째 시도에서 받는다');
  assert.ok(ms < 9_000, `시도 시한(5초) 뒤 곧바로 받아야 한다(${ms}ms)`);
});

test('④ checkRemote 기본값(화면 \'새 버전 확인\')도 재시도한다 — 25초 늦는 첫 응답에서 성공', { timeout: 40_000 }, async () => {
  const sv = slowFirst(25_000);
  const base = await serve(sv.handler);
  const info = await upg.checkRemote(base, '1.0.0');
  assert.equal(info.ok, true, info.error);
  assert.equal(info.available, true);
  assert.equal(sv.count(), 2);
});

test('⑤ 끝내 응답이 없으면 — 앞머리는 그대로, 헤더 대기·시도 횟수·조치를 말한다', { timeout: 30_000 }, async () => {
  let n = 0;
  const base = await serve(() => { n += 1; /* 답하지 않는다 */ });
  const [doc, err] = await upg.fetchRemoteVersions(base, { timeout: 6_000 });
  assert.equal(doc, null);
  assert.match(err, /^versions\.json 을 전체 시한\(6초\) 안에 다 받지 못해 중단했습니다/, '기존 화면·로그가 찾는 앞머리');
  assert.match(err, /응답\(헤더\)을 시작하지 않았습니다/);
  assert.match(err, /시도 [12]번/);
  assert.match(err, /UPGRADE_CHECK_TIMEOUT_MS/);
  assert.ok(n >= 1);
});

test('⑥ 헤더 뒤 본문이 멈추면 — \'본문\' 단계로 말한다(헤더 대기와 조치가 다르다)', { timeout: 20_000 }, async () => {
  const base = await serve((_q, r) => { r.setHeader('content-type', 'application/json'); r.write('{"latest":"9.9.9","versions":['); });
  const [doc, err] = await upg.fetchRemoteVersions(base, { timeout: 1_500 });
  assert.equal(doc, null);
  assert.match(err, /본문을 끝까지 받지 못했습니다/, err);
  assert.doesNotMatch(err, /헤더\)을 시작하지/);
});

test('⑦ 서명 manifest 도 같은 규칙 — 첫 응답이 늦으면 재시도로 받는다', { timeout: 30_000 }, async () => {
  const sv = slowFirst(13_000, '{"m":1}');
  const base = await serve(sv.handler);
  const m = await upg.fetchManifestText(`${base}/x.manifest.json`, { timeout: 12_000 });
  assert.equal(m.text, '{"m":1}', JSON.stringify(m));
  assert.equal(sv.count(), 2);
});

test('⑧ 설치·번들·패키지 경로가 예전 짧은 고정 시한(10·15·20·30초)으로 확인을 자르지 않는다(소스)', () => {
  const up = stripComments(fs.readFileSync(path.join(SRC, 'upgrade/upgrade.js'), 'utf8'));
  const bs = stripComments(fs.readFileSync(path.join(SRC, 'upgrade/bundleSource.js'), 'utf8'));
  const fp = stripComments(fs.readFileSync(path.join(SRC, 'upgrade/fetchPackage.js'), 'utf8'));
  assert.doesNotMatch(up, /checkRemote\([^)]*15_000/, 'upgradeFromRemote 의 15초 상한');
  assert.doesNotMatch(up, /fetchManifestText\([^)]*30_000/);
  assert.doesNotMatch(up, /timeout = 10_000/, '확인 기본값 10초');
  assert.doesNotMatch(bs, /timeout: 1[05]_000|timeout: 30_000/);
  assert.doesNotMatch(fp, /deadlineSignal\((20000|30000)\)/);
  // 시도 시한 = 전체 시한이면 재시도할 여지가 없다(v2.730 결함의 모양).
  assert.doesNotMatch(up, /timeoutMs: totalMs/);
  assert.doesNotMatch(fp, /timeoutMs: 20000|timeoutMs: 30000/);
});
