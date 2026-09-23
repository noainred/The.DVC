/**
 * v2.583 보안(감사 확정 — 반증 에이전트 재현 + 직접 재현).
 *  ① 통신 점검(linkcheck stepHttp)이 `rejectUnauthorized:false` 고정 + 리다이렉트 추종이라, 중앙↔엣지 토큰
 *     (X-Collector-Token·X-Central-Token)이 **검증 안 된 TLS 로 나가고 302 로 제3 출처에 재전송**됐다.
 *  ② Ollama 오프라인 설치가 `binaryPath` 의 **존재만** 확인해 임의 로컬 파일(portal.env 등)을 요청자가 고른
 *     호스트로 SFTP 업로드했다(v2.447 S1 의 형제 누락).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secout-'));
process.env.CONFIG_DIR = tmp;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.WAN_TLS_INSECURE;

function selfSigned() {
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) };
  } catch { return null; }
}

test('① 토큰을 싣는 점검은 자체서명 TLS 에 토큰을 보내지 않는다(WAN 검증 기본 ON)', async (t) => {
  const pem = selfSigned();
  if (!pem) { t.skip('openssl 없음'); return; }
  const got = [];
  const srv = https.createServer(pem, (req, res) => { got.push(req.headers['x-collector-token'] || ''); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); });
  const { stepHttp } = await import('../src/linkcheck/checks.js');
  const url = `https://localhost:${srv.address().port}/api/collector/ping`;
  const withTok = await stepHttp({ url, ip: '127.0.0.1', headers: { 'X-Collector-Token': 'SECRET-A' }, timeoutMs: 5000 });
  assert.equal(withTok.http.ok, false, '검증 실패로 끊겨야 한다');
  const noTok = await stepHttp({ url, ip: '127.0.0.1', headers: {}, timeoutMs: 5000 });
  assert.equal(noTok.http.ok, true, '비밀이 없는 정체 확인은 자체서명이어도 진행(보낼 비밀이 없다)');
  assert.deepEqual(got, [''], '토큰은 한 번도 도착하지 않았다');
});

test('① 점검은 리다이렉트를 따라가지 않는다 — 제3 출처에 토큰이 가지 않는다', async (t) => {
  const stolen = [];
  const thief = http.createServer((req, res) => { stolen.push(req.headers['x-central-token'] || ''); res.end('{}'); });
  await new Promise((r) => thief.listen(0, '127.0.0.1', r));
  const redir = http.createServer((req, res) => { res.statusCode = 302; res.setHeader('Location', `http://127.0.0.1:${thief.address().port}/steal`); res.end(); });
  await new Promise((r) => redir.listen(0, '127.0.0.1', r));
  t.after(async () => {
    redir.closeAllConnections?.(); thief.closeAllConnections?.();
    await new Promise((res) => redir.close(res)); await new Promise((res) => thief.close(res));
  });
  const { stepHttp } = await import('../src/linkcheck/checks.js');
  const r = await stepHttp({ url: `http://127.0.0.1:${redir.address().port}/api/central/health-probe`, ip: '127.0.0.1', headers: { 'X-Central-Token': 'SECRET-B' }, timeoutMs: 5000 });
  assert.equal(r.http.ok, false);
  assert.equal(r.http.status, 302);
  assert.match(r.http.error, /리다이렉트는 따라가지 않습니다/);
  assert.deepEqual(stolen, [], '리다이렉트 목적지에 아무것도 가지 않았다');
});

test('② Ollama 오프라인 설치 — 실경로 파일명 규격 + 압축 서명이 아니면 거부(업로드 전에)', async () => {
  const { checkOllamaArchive, installOllama } = await import('../src/llm/ollamaDeploy.js');
  const secret = path.join(tmp, 'portal.env');
  fs.writeFileSync(secret, 'AUTH_SECRET=x\n');
  assert.equal(checkOllamaArchive(secret).ok, false, '설정 파일은 파일명 규격에서 거부');
  const link = path.join(tmp, 'ollama-linux-amd64.tgz');
  fs.symlinkSync(secret, link);
  assert.equal(checkOllamaArchive(link).ok, false, '규격 이름의 심볼릭 링크도 실경로로 거부');
  const fake = path.join(tmp, 'ollama-linux-arm64.tgz');
  fs.writeFileSync(fake, 'plain text renamed');
  assert.match(checkOllamaArchive(fake).reason, /압축 파일/, '이름만 바꾼 평문은 서명으로 거부');
  const good = path.join(tmp, 'ollama-linux-amd64.tar.zst');
  fs.writeFileSync(good, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]));
  const ok = checkOllamaArchive(good);
  assert.equal(ok.ok, true);
  assert.equal(ok.real, fs.realpathSync(good));
  // 설치 함수가 SSH 접속 전에 거부한다(연결 시도가 없다 — 포트 1 은 닫혀 있어도 거부 사유가 파일이어야 한다)
  const r = await installOllama({ host: '127.0.0.1', port: 1, username: 'root', password: 'x' }, { mode: 'offline', binaryPath: secret });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Ollama 릴리스 파일/);
});

test('② 라우트는 설정 소유자 게이트를 거친다(자격증명 내보내기와 같은 등급)', () => {
  const src = fs.readFileSync(new URL('../src/routes/admin/deployLlm.js', import.meta.url), 'utf8');
  assert.match(src, /adminRouter\.post\('\/ollama-deploy', adminOnly, requireSettingsOwner,/);
});

test('#17 리다이렉트 코어 — IP 리터럴 차단 대역 hop 거부 · 교차 출처 307 본문 재전송 거부 · 호출자 manual 존중', async (t) => {
  const got = [];
  const sink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push(b); res.end('{}'); }); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  let mode = '307';
  const redir = http.createServer((req, res) => {
    res.statusCode = mode === '307' ? 307 : 302;
    res.setHeader('Location', mode === 'meta' ? 'http://169.254.169.254/latest/meta-data' : `http://localhost:${sink.address().port}/collect`);
    res.end();
  });
  await new Promise((r) => redir.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const s of [sink, redir]) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); } });
  const { resilientFetch } = await import('../src/util/resilientFetch.js');
  const base = `http://127.0.0.1:${redir.address().port}/x`;
  const r1 = await resilientFetch(base, { method: 'POST', body: JSON.stringify({ password: 'IDRAC-PW' }), headers: { 'Content-Type': 'application/json' }, retries: 0 });
  assert.equal(r1.status, 307, '교차 출처(127.0.0.1 → localhost) 307 + 본문은 따라가지 않는다');
  assert.match(r1.__redirectRefused, /본문을 다시 보내지 않습니다/);
  assert.deepEqual(got, [], '비밀번호 본문이 제3 출처에 가지 않았다');
  mode = 'meta';
  await assert.rejects(resilientFetch(base, { retries: 0 }), /차단 대역/, '메타데이터 IP 리터럴로 끌려가지 않는다');
  mode = '302';
  const r3 = await resilientFetch(base, { retries: 0, redirect: 'manual' });
  assert.equal(r3.status, 302, '호출자가 manual 을 주면 따라가지 않는다');
});

test('#19 엣지 번들 push 두 곳은 리다이렉트를 따라가지 않는다', () => {
  const a = fs.readFileSync(new URL('../src/collector/upgradePush.js', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../src/upgrade/upgrade.js', import.meta.url), 'utf8');
  assert.match(a, /dispatcher: _rf\.wanAgent,[\s\S]{0,400}redirect: 'manual'/);
  assert.match(b.slice(b.indexOf('export async function pushBundleToEdge')), /dispatcher: upgradeAgent,[\s\S]{0,300}redirect: 'manual'/);
});

test('#18 엣지 응답은 해제 후 크기 상한까지만 읽는다(gzip 폭탄)', async (t) => {
  const zlib = await import('node:zlib');
  const bomb = zlib.gzipSync(Buffer.alloc(40 * 1048576, 0x20));   // 전송 ~40KB → 해제 40MB
  const srv = http.createServer((req, res) => { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Content-Type', 'application/json'); res.end(bomb); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); });
  const { resilientFetch } = await import('../src/util/resilientFetch.js');
  const { readJsonCapped } = await import('../src/util/readCapped.js');
  const res = await resilientFetch(`http://127.0.0.1:${srv.address().port}/x`, { retries: 0 });
  await assert.rejects(readJsonCapped(res, 4 * 1048576, '엣지 응답'), /상한\(4MB\)을 넘어 읽기를 멈췄습니다/);
  const ok = http.createServer((req, res) => { res.setHeader('Content-Encoding', 'gzip'); res.end(zlib.gzipSync(Buffer.from('{"a":1}'))); });
  await new Promise((r) => ok.listen(0, '127.0.0.1', r));
  t.after(async () => { ok.closeAllConnections?.(); await new Promise((r) => ok.close(r)); });
  const r2 = await resilientFetch(`http://127.0.0.1:${ok.address().port}/x`, { retries: 0 });
  assert.deepEqual(await readJsonCapped(r2, 4 * 1048576), { a: 1 });
  for (const f of ['collector/puller.js', 'central/edgeLogPull.js', 'central/bmUsageEdgePull.js', 'central/tokenCheckPull.js']) {
    const s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(/readJsonCapped\(res,/.test(s) && !/await res\.json\(\)/.test(s), `${f}: 엣지 응답은 readJsonCapped 로 읽는다`);
  }
});

test('리다이렉트 신뢰 판정 — 같은 출처 · 같은 호스트의 http→https 업그레이드만 믿는다(검증 에이전트 권고)', async () => {
  const { trustedRedirect } = await import('../src/util/resilientFetch.js');
  assert.equal(trustedRedirect('https://edge.synth:3001/a', 'https://edge.synth:3001/b'), true);
  assert.equal(trustedRedirect('http://edge.synth/api/x', 'https://edge.synth/api/x'), true, '리버스 프록시의 308 업그레이드');
  assert.equal(trustedRedirect('http://edge.synth:3001/x', 'https://EDGE.synth:3443/x'), true);
  assert.equal(trustedRedirect('https://edge.synth/x', 'http://edge.synth/x'), false, '하향은 믿지 않는다');
  assert.equal(trustedRedirect('http://edge.synth/x', 'https://evil.synth/x'), false, '호스트가 바뀌면 믿지 않는다');
  assert.equal(trustedRedirect('bad', 'https://x'), false);
});

test('통신 점검 — 인증서 검증 실패 코드는 TLS 실패로 분류된다(unknown 이 아니라)', async () => {
  const { failKindOfCode } = await import('../src/linkcheck/phases.js');
  for (const c of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    assert.equal(failKindOfCode(c, 'fetch failed'), 'tls-fail', c);
  }
  assert.equal(failKindOfCode('', 'fetch failed — self-signed certificate'), 'tls-fail');
  assert.equal(failKindOfCode('CERT_HAS_EXPIRED', ''), 'tls-expired', '만료는 따로');
  assert.equal(failKindOfCode('ECONNREFUSED', ''), 'refused');
});
