/**
 * rvK_versionsMeta.test.js — 검토 I-08: 업그레이드 메타데이터(versions.json)는 크기·개수·문자열·형식 상한 안에서만 읽는다.
 *
 * 예전 `upgrade.js fetchRemoteVersions` 는 `res.json()` 으로 본문을 통째로 읽었다(같은 파일의 번들 다운로드는
 * readBytesCapped — 경로별 보호가 비대칭). 가짜 HTTP 서버로 실제 함수를 돌려 본다:
 *   정상 · chunked 초과 · 거짓 Content-Length(큰 값 / 작은 값) · 형식 오류 · 과다 versions 배열 · 읽기 시한 ·
 *   사유에 인증정보 없음 · 초과 시 설치 진행 없음 · 패키지 저장소(fetchPackage) 경로도 같은 형식 검사.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rvK-vmeta-'));
process.env.CONFIG_DIR = CFG;
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // fetchPackage 의 사전 SSRF 검사가 127.0.0.1 목 서버를 허용하도록

const upg = await import('../src/upgrade/upgrade.js');

const servers = [];
after(() => { for (const s of servers) { try { s.close(); } catch { /* */ } } });
async function serve(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
async function rawServe(onConn) {
  const s = net.createServer((sock) => { sock.on('error', () => {}); onConn(sock); });
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}
const goodDoc = (n = 3) => ({
  latest: '9.9.9',
  versions: Array.from({ length: n }, (_, i) => ({ version: `9.9.${9 - i}`, tar_gz: `vmware-portal-9.9.${9 - i}.tar.gz`, size_bytes: 1000 + i, sha256: 'a'.repeat(64) })),
});

test('I-08 ① 정상 메타데이터는 그대로 읽고, 알 수 없는 필드는 버린다', async () => {
  const doc = goodDoc();
  doc.versions[0].weird = { deep: 'x'.repeat(10) };
  const base = await serve((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(doc)); });
  const [data, err] = await upg.fetchRemoteVersions(base, { timeout: 5000 });
  assert.equal(err, null, String(err));
  assert.equal(data.latest, '9.9.9');
  assert.equal(data.versions.length, 3);
  assert.equal(data.versions[0].tar_gz, 'vmware-portal-9.9.9.tar.gz');
  assert.equal('weird' in data.versions[0], false, '선언하지 않은 필드는 싣지 않는다');
  const info = await upg.checkRemote(base, '9.9.0', { timeout: 5000 });
  assert.equal(info.ok, true);
  assert.equal(info.available, true);
  assert.equal(info.sha256, 'a'.repeat(64));
});

test('I-08 ② chunked(Content-Length 없음) 초과 본문은 상한에서 읽기를 멈춘다', async () => {
  let sent = 0;
  let closed = false;
  const base = await serve((_q, r) => {
    r.setHeader('content-type', 'application/json');
    // 유효한 JSON 이지만 상한(기본 1MiB)을 넘는 공백 패딩 — 예전 res.json() 은 끝까지 받아 파싱했다.
    r.write('{"latest":"9.9.9","versions":[], "pad":"');
    const chunk = 'x'.repeat(64 * 1024);
    const pump = () => {
      while (!closed && sent < 8 * 1048576) { sent += chunk.length; if (!r.write(chunk)) { r.once('drain', pump); return; } }
      if (!closed) r.end('"}');
    };
    r.on('close', () => { closed = true; });
    pump();
  });
  const t0 = Date.now();
  const [data, err] = await upg.fetchRemoteVersions(base, { timeout: 10_000 });
  assert.equal(data, null, '상한을 넘는 본문을 받아들이면 안 된다');
  assert.match(String(err), /상한/);
  assert.ok(Date.now() - t0 < 8_000, `상한에서 바로 멈춘다(${Date.now() - t0}ms)`);
  assert.ok(sent < 8 * 1048576, `서버가 끝까지 보내기 전에 끊는다(보낸 양 ${sent})`);
});

test('I-08 ③ 거짓 Content-Length — 큰 값은 읽지 않고 거부, 작은 값(본문이 더 김)은 형식 오류로 거부', async () => {
  const bigCl = await rawServe((sock) => {
    sock.on('data', () => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 3221225472\r\n\r\n{"latest":"9.9.9"');
      setTimeout(() => sock.destroy(), 300);
    });
  });
  const [d1, e1] = await upg.fetchRemoteVersions(bigCl, { timeout: 5000 });
  assert.equal(d1, null);
  assert.match(String(e1), /상한|versions\.json/);

  const smallCl = await rawServe((sock) => {
    sock.on('data', () => {
      const body = JSON.stringify(goodDoc(2000));
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n${body}`);
      sock.end();
    });
  });
  const [d2, e2] = await upg.fetchRemoteVersions(smallCl, { timeout: 5000 });
  assert.equal(d2, null, 'Content-Length 만큼(20바이트)만 읽혀 형식이 깨진다 — 받아들이면 안 된다');
  assert.ok(e2);
});

test('I-08 ④ 형식 오류(JSON 아님·필드 타입 오류)는 거부한다', async () => {
  const bad = await serve((_q, r) => { r.end('{"latest": "9.9.9", "versions": ['); });
  const [d1, e1] = await upg.fetchRemoteVersions(bad, { timeout: 5000 });
  assert.equal(d1, null);
  assert.match(String(e1), /versions\.json/);
  for (const doc of [
    [1, 2, 3],
    { latest: 123, versions: [] },
    { latest: '9.9.9', versions: 'nope' },
    { latest: '9.9.9', versions: [null] },
    { latest: '9.9.9', versions: [{ version: '9.9.9', tar_gz: '../../etc/passwd' }] },
    { latest: '9.9.9', versions: [{ version: '9.9.9', sha256: 'zz' }] },
    { latest: '9.9.9', versions: [{ version: 'x'.repeat(5000) }] },
    { latest: '9.9.9', versions: [{ version: '9.9.9', size_bytes: -1 }] },
  ]) {
    const base = await serve((_q, r) => { r.end(JSON.stringify(doc)); });
    const [d, e] = await upg.fetchRemoteVersions(base, { timeout: 5000 });
    assert.equal(d, null, `거부해야 한다: ${JSON.stringify(doc).slice(0, 80)}`);
    assert.match(String(e), /versions\.json/);
  }
});

test('I-08 ⑤ versions 배열이 과다하면(상한 초과) 바이트 상한 안이어도 거부한다', async () => {
  const doc = goodDoc(1);
  doc.versions = Array.from({ length: 5000 }, (_, i) => ({ version: `1.0.${i}` }));
  const base = await serve((_q, r) => { r.end(JSON.stringify(doc)); });
  const [data, err] = await upg.fetchRemoteVersions(base, { timeout: 5000 });
  assert.equal(data, null);
  assert.match(String(err), /항목|versions/);
});

test('I-08 ⑥ 읽기 시한 — 헤더 뒤 본문이 멈추면 전체 시한 안에 끊고 소켓을 닫는다', async () => {
  let socketClosed = false;
  const base = await serve((q, r) => {
    r.setHeader('content-type', 'application/json');
    r.write('{"latest":"9.9.9","versions":[');
    q.socket.on('close', () => { socketClosed = true; });
    // 이후 아무것도 보내지 않는다
  });
  const t0 = Date.now();
  const [data, err] = await upg.fetchRemoteVersions(base, { timeout: 1500 });
  const ms = Date.now() - t0;
  assert.equal(data, null);
  assert.ok(err);
  assert.ok(ms < 6_000, `시한(1.5초) 근처에서 끝나야 한다(${ms}ms)`);
  for (let i = 0; i < 40 && !socketClosed; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(socketClosed, true, '시한에 걸린 연결은 닫힌다');
});

test('I-08 ⑦ 오류 사유·확인 결과에 인증정보(계정·비밀번호·쿼리 토큰)를 싣지 않는다', async () => {
  const port = (await serve((_q, r) => { r.statusCode = 500; r.end('x'); })).split(':').pop();
  const base = `http://bob:pa55w0rd@127.0.0.1:${port}/dl?token=SEKRET-TOK`;
  const info = await upg.checkRemote(base, '1.0.0', { timeout: 3000 });
  assert.equal(info.ok, false);
  const text = JSON.stringify(info);
  assert.doesNotMatch(text, /pa55w0rd|SEKRET-TOK|bob:/, text);
  // 연결 실패 경로(닫힌 포트)
  const info2 = await upg.checkRemote('http://bob:pa55w0rd@127.0.0.1:1/dl?token=SEKRET-TOK', '1.0.0', { timeout: 3000 });
  assert.equal(info2.ok, false);
  assert.doesNotMatch(JSON.stringify(info2), /pa55w0rd|SEKRET-TOK|bob:/);
});

test('I-08 ⑧ 메타데이터가 상한을 넘으면 설치를 진행하지 않는다(설치 경로 그대로)', async () => {
  // 최신 항목은 정상(번들 이름·sha 포함)이고 뒤에 항목이 과다하다 — 예전 코드는 번들을 받으러 갔다.
  const doc = { latest: '9.9.9', versions: [{ version: '9.9.9', tar_gz: 'vmware-portal-9.9.9.tar.gz', size_bytes: 10, sha256: 'a'.repeat(64) }] };
  for (let i = 0; i < 5000; i++) doc.versions.push({ version: `1.0.${i}` });
  let bundleRequested = false;
  const base = await serve((q, r) => {
    if (q.url.endsWith('versions.json')) return r.end(JSON.stringify(doc));
    bundleRequested = true; r.statusCode = 404; r.end();
  });
  const installDir = path.join(CFG, 'app-untouched');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'package.json'), '{"version":"1.0.0"}');
  const res = await upg.upgradeFromRemote(base, installDir, '1.0.0', path.join(CFG, 'dl'), { timeout: 5000, pkgName: 'vmware-portal' });
  assert.equal(res.ok, false);
  assert.equal(bundleRequested, false, '메타데이터를 거부했으면 번들을 받지 않는다');
  assert.equal(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'), '{"version":"1.0.0"}');
});

test('I-08 ⑨ 패키지 저장소(fetchPackage.fetchRemoteVersions)도 같은 형식 검사를 거친다', async () => {
  const { fetchRemoteVersions } = await import('../src/upgrade/fetchPackage.js');
  const ok = await serve((_q, r) => { r.end(JSON.stringify(goodDoc())); });
  const d = await fetchRemoteVersions(ok);
  assert.equal(d.latest, '9.9.9');
  const doc = goodDoc(1);
  doc.versions = Array.from({ length: 5000 }, (_, i) => ({ version: `1.0.${i}` }));
  const bad = await serve((_q, r) => { r.end(JSON.stringify(doc)); });
  await assert.rejects(fetchRemoteVersions(bad), /항목|versions/);
  const typo = await serve((_q, r) => { r.end(JSON.stringify({ latest: '9.9.9', versions: [{ version: '9.9.9', installer: '../x.tar.gz' }] })); });
  await assert.rejects(fetchRemoteVersions(typo), /versions\.json/);
});

test('I-08 ⑩ 직전 정상 확인 결과 유지 계약 — 실패한 확인은 직전 정상값을 참고로만 싣고 설치 판단에 쓰지 않는다', async () => {
  let fail = false;
  const base = await serve((_q, r) => { if (fail) { r.statusCode = 503; return r.end('down'); } r.end(JSON.stringify(goodDoc())); });
  const { rememberRemoteCheck } = await import('../src/upgrade/versionsDoc.js');
  const st = {};
  const ok = rememberRemoteCheck(st, await upg.checkRemote(base, '9.9.0', { timeout: 3000 }));
  assert.equal(ok.ok, true);
  fail = true;
  const bad = rememberRemoteCheck(st, await upg.checkRemote(base, '9.9.0', { timeout: 3000 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.available, false, '실패한 확인은 업그레이드 가능으로 보지 않는다');
  assert.equal(bad.lastGood?.latest, '9.9.9', '직전 정상값을 참고로 싣는다');
  assert.equal(bad.lastGood?.available, true);
  assert.ok(Number.isFinite(bad.lastGood?.checkedAt));
  // 계약: 실패한 확인은 어떤 경우에도 '업그레이드 가능' 이 아니다(실패 결과가 available 을 들고 와도)
  const forged = rememberRemoteCheck(st, { ok: false, available: true, latest: '99.0.0', error: 'x' });
  assert.equal(forged.available, false);
  assert.equal(forged.lastGood?.latest, '9.9.9', '직전 정상값은 바뀌지 않는다');
});

test('I-08 ⑪ 전체 시한은 재시도·Retry-After 대기까지 묶는다(건별 시한만으로는 3배 이상 늘어난다)', async () => {
  let hits = 0;
  const base = await serve((_q, r) => { hits += 1; r.statusCode = 503; r.setHeader('retry-after', '5'); r.end('busy'); });
  const t0 = Date.now();
  const [data, err] = await upg.fetchRemoteVersions(base, { timeout: 1000 });
  const ms = Date.now() - t0;
  assert.equal(data, null);
  assert.match(String(err), /전체 시한/, String(err));
  assert.ok(ms < 4_000, `전체 시한(1초) 근처에서 끝나야 한다(${ms}ms, 요청 ${hits}회)`);
});
