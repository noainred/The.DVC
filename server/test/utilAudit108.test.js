/**
 * utilAudit108.test.js — 전체 점검 108회차: 서버 공용 유틸(server/src/util/) 1차 점검 확정분.
 *
 *  A1 ssrfBlock — '://' 없이도 http(s) 로 읽히는 글자(`http:/169.254.169.254/x` · `https:\\127.0.0.1`)가 SSRF 검사를 지나갔다
 *  A2 ssrfBlock — 끝 점 붙은 루프백 이름('localhost.')
 *  A3 envRedact — CRLF · CR 줄 끝의 .env 는 한 줄도 가려지지 않았고(백업 번들 · 엣지 설정 사본에 서명 키 평문), 복원 · 호스트 고정도 빗나갔다
 *  A4 bigJsonGate — 7b 서버 등록 업로드(analyze · apply)는 큰 파서를 한 번도 타지 못했다(1MB 넘으면 413)
 *  A5 smtp — 주소 형식 정규식 O(n²)(4만 자 1.3초 동기)
 *  A6 sshKeyKdf — 사전 검사가 ssh2 와 다른 바이트를 읽어 KDF 반복 상한을 비켜 갔다(base64url 글자 · 64KB 초과 · 중간 END 표지)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// 실제 호출부(llm/config · security/credentialStore)를 함께 불러 본다 — 설정 폴더는 임시로(운영 경로를 건드리지 않게).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'util108-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/* ── A1 · A2 ─────────────────────────────────────────────────────────────── */
test('A1 ssrfBlockReason — 스킴 뒤 슬래시가 하나 · 없음 · 역슬래시 · 탭이 낀 글자도 fetch 가 실제로 갈 호스트로 판정한다', async () => {
  const { ssrfBlockReason, ssrfBlockReasonResolved } = await import('../src/util/ssrfBlock.js');
  const cases = [
    'http:/169.254.169.254/latest/meta-data', 'https:/169.254.169.254', 'http:\\\\169.254.169.254/x', 'http:\\/169.254.169.254',
    'http:/\t/169.254.169.254/', 'HTTP:/169.254.169.254', 'http:/[::ffff:169.254.169.254]/', 'http:/2852039166/', 'https:/0xA9FEA9FE/',
  ];
  for (const c of cases) {
    // 전제: fetch · new URL 은 이 글자를 그 IP 로 읽는다(이 전제가 깨지면 시험이 알려 준다)
    const real = new URL(c).hostname;
    assert.match(real, /^(169\.254\.169\.254|\[::ffff:a9fe:a9fe\])$/, `${JSON.stringify(c)} → ${real}`);
    assert.match(String(ssrfBlockReason(c)), /링크로컬|메타데이터/, `동기 검사가 막아야 한다: ${JSON.stringify(c)}`);
    assert.match(String(await ssrfBlockReasonResolved(c)), /링크로컬|메타데이터/, `해석형 검사도: ${JSON.stringify(c)}`);
  }
  const saved = process.env.SSRF_ALLOW_LOOPBACK;
  delete process.env.SSRF_ALLOW_LOOPBACK;
  try {
    for (const c of ['http:/127.0.0.1:8080/x', 'https:/[::1]/', 'http:\\\\127.1']) assert.match(String(ssrfBlockReason(c)), /루프백/, c);
  } finally { if (saved === undefined) delete process.env.SSRF_ALLOW_LOOPBACK; else process.env.SSRF_ALLOW_LOOPBACK = saved; }
  // 실제 호출부 하나 — LLM 주소 검증(new URL 로 형식만 보고 이 함수에 맡긴다)
  const { llmUrlIssue } = await import('../src/llm/config.js');
  assert.match(String(llmUrlIssue('http:/169.254.169.254/v1')), /링크로컬|메타데이터/);
});

test('A1 ssrfBlockReasonResolved — `http:/이름/…` 은 fetch 가 실제로 갈 이름을 해석해 본다(예전에는 호스트 "http" 만 해석했다)', async () => {
  const dns = (await import('node:dns')).default;
  const { ssrfBlockReasonResolved } = await import('../src/util/ssrfBlock.js');
  const orig = dns.promises.lookup;
  const asked = [];
  dns.promises.lookup = async (host) => {
    asked.push(host);
    if (host === 'rebind.example') return [{ address: '169.254.169.254', family: 4 }];
    if (host === 'ok.example') return [{ address: '10.1.2.3', family: 4 }];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  };
  try {
    assert.match(String(await ssrfBlockReasonResolved('http:/rebind.example/hook')), /링크로컬.*DNS 해석: rebind\.example → 169\.254\.169\.254/);
    assert.ok(asked.includes('rebind.example'));
    assert.equal(await ssrfBlockReasonResolved('https:/ok.example/x'), null, '사내 대역으로 풀리는 이름은 통과');
    assert.match(String(await ssrfBlockReasonResolved('http://rebind.example/hook')), /DNS 해석/, '정상 표기는 예전 그대로');
    assert.equal(await ssrfBlockReasonResolved('nx.example:8443'), null, '해석 실패는 차단 사유가 아니다(예전 그대로)');
  } finally { dns.promises.lookup = orig; }
});

test('A1 ssrfBlockReason — 더 막기만 한다: 예전에 통과하던 정상 표기는 그대로 통과 · 예전에 막던 것은 그대로 막는다', async () => {
  const { ssrfBlockReason } = await import('../src/util/ssrfBlock.js');
  for (const ok of ['example.com:80', 'vc01:443', 'vc01.corp.local', '10.0.0.5:443', 'https://10.0.0.5/sdk', 'http://192.168.1.10:4000', 'http:/10.0.0.5/x', 'https:/vc01.corp.local/', '[fe00::1]:443', 'http://[2001:db8::10]/']) {
    assert.equal(ssrfBlockReason(ok), null, `정상 표기는 통과: ${ok}`);
  }
  assert.equal(ssrfBlockReason('http:example.com'), 'URL 형식이 올바르지 않습니다.', "'://' 없는 형식 오류는 예전 그대로 거절");
  assert.equal(ssrfBlockReason('ftp://example.com'), 'http/https URL만 허용됩니다.');
  assert.match(String(ssrfBlockReason('http://169.254.169.254/')), /링크로컬/);
  assert.match(String(ssrfBlockReason('169.254.169.254:80')), /링크로컬/);
});

test('A2 ipBlockReason — 끝 점 하나가 붙은 루프백 이름(localhost. · x.localhost.)도 막는다 · SSRF_ALLOW_LOOPBACK 이면 허용', async () => {
  const { ipBlockReason, ssrfBlockReason } = await import('../src/util/ssrfBlock.js');
  const saved = process.env.SSRF_ALLOW_LOOPBACK;
  delete process.env.SSRF_ALLOW_LOOPBACK;
  try {
    for (const h of ['localhost.', 'LOCALHOST.', 'app.localhost.', 'localhost', 'a.localhost']) assert.match(String(ipBlockReason(h)), /루프백 이름/, h);
    assert.match(String(ssrfBlockReason('http://localhost./x')), /루프백 이름/);
    assert.match(String(ssrfBlockReason('localhost.:4000')), /루프백 이름/);
    for (const h of ['notlocalhost.', 'localhost.example.com', 'localhostx', 'mylocalhost']) assert.equal(ipBlockReason(h), null, `다른 이름은 그대로: ${h}`);
    process.env.SSRF_ALLOW_LOOPBACK = 'true';
    assert.equal(ipBlockReason('localhost.'), null);
  } finally { if (saved === undefined) delete process.env.SSRF_ALLOW_LOOPBACK; else process.env.SSRF_ALLOW_LOOPBACK = saved; }
});

/* ── A3 ──────────────────────────────────────────────────────────────────── */
test('A3 envRedact — CRLF · CR 줄 끝에서도 비밀을 가리고 줄 끝은 그대로 둔다 · LF 결과는 예전 글자와 같다', async () => {
  const { redactEnvSecrets, REDACTED } = await import('../src/util/envRedact.js');
  const lf = 'PORT=4000\n# 주석\nAUTH_SECRET=abc123\nexport SECRETS_KEY = k1\nCENTRAL_TOKEN=tok\nPROXY_SSH_PASS=pw\nEMPTY_TOKEN=\n';
  const want = `PORT=4000\n# 주석\nAUTH_SECRET=${REDACTED}\nexport SECRETS_KEY = ${REDACTED}\nCENTRAL_TOKEN=${REDACTED}\nPROXY_SSH_PASS=${REDACTED}\nEMPTY_TOKEN=\n`;
  const keys = ['AUTH_SECRET', 'SECRETS_KEY', 'CENTRAL_TOKEN', 'PROXY_SSH_PASS'];
  const a = redactEnvSecrets(lf);
  assert.equal(a.text, want); assert.deepEqual(a.keys, keys);
  for (const [name, eol] of [['CRLF', '\r\n'], ['CR', '\r']]) {
    const r = redactEnvSecrets(lf.replaceAll('\n', eol));
    assert.equal(r.text, want.replaceAll('\n', eol), `${name}: 값만 가리고 줄 끝은 그대로`);
    assert.deepEqual(r.keys, keys, `${name}: 가린 키`);
    for (const secret of ['abc123', 'k1', 'tok', 'pw']) assert.ok(!r.text.includes(`=${secret}`) && !r.text.includes(`= ${secret}`), `${name}: 평문 ${secret} 이 남으면 안 된다`);
  }
  // 줄 끝이 섞인 파일 · 마지막 줄에 줄 끝이 없는 파일
  assert.equal(redactEnvSecrets('A=1\r\nAUTH_SECRET=x\nB_TOKEN=y').text, `A=1\r\nAUTH_SECRET=${REDACTED}\nB_TOKEN=${REDACTED}`);
  // 값 안의 U+2028(`.` 가 건너지 못하던 글자) — 그 줄도 가린다
  assert.equal(redactEnvSecrets('AUTH_SECRET=ab cd\n').text, `AUTH_SECRET=${REDACTED}\n`);
  assert.equal(redactEnvSecrets('').text, ''); assert.equal(redactEnvSecrets(null).redacted, 0);
});

test('A3 mergeRedactedEnv · pinHostSecurityEnv — CRLF 번들 · CRLF 현재 파일에서도 표식을 되살리고 호스트 보안 키를 고정한다', async () => {
  const { mergeRedactedEnv, pinHostSecurityEnv, REDACTED } = await import('../src/util/envRedact.js');
  // 번들이 CRLF: 표식 줄이 그대로 지나가 키 값이 표식 글자가 되면 안 된다
  const m1 = mergeRedactedEnv(`AUTH_SECRET=${REDACTED}\r\nPORT=4000\r\nGONE_TOKEN=${REDACTED}\r\n`, 'AUTH_SECRET=live\n');
  assert.equal(m1.text, 'AUTH_SECRET=live\r\nPORT=4000\r\n'); assert.equal(m1.restored, 1); assert.deepEqual(m1.dropped, ['GONE_TOKEN']);
  assert.ok(!m1.text.includes(REDACTED));
  // 현재 파일이 CRLF: 살아 있는 키를 '없음' 으로 보고 버리면 안 된다(값에 '\r' 이 묻어도 안 된다)
  const m2 = mergeRedactedEnv(`AUTH_SECRET=${REDACTED}\nPORT=1\n`, 'AUTH_SECRET=live\r\nX=1\r\n');
  assert.equal(m2.text, 'AUTH_SECRET=live\nPORT=1\n'); assert.deepEqual(m2.dropped, []);
  // LF ↔ LF 는 예전 글자 그대로
  assert.equal(mergeRedactedEnv(`A=1\nB_KEY=${REDACTED}\nC=3`, 'B_KEY=zz\n').text, 'A=1\nB_KEY=zz\nC=3');
  assert.equal(mergeRedactedEnv(`A=1\nB_KEY=${REDACTED}\n`, '').text, 'A=1\n');

  // 호스트 고정: CRLF 번들의 보안 스위치가 그대로 지나가면 안 된다(현재 파일에 그 키가 없으면 번들 줄을 버린다)
  const p1 = pinHostSecurityEnv('AUTH_ENABLED=false\r\nUPGRADE_ALLOW_UNVERIFIED=true\r\nPORT=1\r\n', 'AUTH_ENABLED=true\n');
  assert.equal(p1.text, 'AUTH_ENABLED=true\r\nPORT=1\r\n');
  assert.deepEqual(p1.pinned, ['AUTH_ENABLED', 'UPGRADE_ALLOW_UNVERIFIED']);
  assert.ok(!/UPGRADE_ALLOW_UNVERIFIED/.test(p1.text) && !/AUTH_ENABLED=false/.test(p1.text));
  // 현재 파일이 CRLF: 호스트 값을 읽어 쓴다 · 현재 파일에만 있는 보안 키도 이어 붙인다
  const p2 = pinHostSecurityEnv('AUTH_ENABLED=false\nPORT=1\n', 'AUTH_ENABLED=true\r\nWAN_TLS_INSECURE=false\r\n');
  assert.equal(p2.text, 'AUTH_ENABLED=true\nPORT=1\n\nWAN_TLS_INSECURE=false'); assert.deepEqual(p2.pinned, ['AUTH_ENABLED']);
  // 줄 끝이 섞인 번들: 고정한 줄은 **그 줄이 갖고 있던** 줄 끝을 그대로 쓴다
  assert.equal(pinHostSecurityEnv('X=1\r\nAUTH_ENABLED=false\nPORT=1\n', 'AUTH_ENABLED=true\n').text, 'X=1\r\nAUTH_ENABLED=true\nPORT=1\n');
  // 줄 끝만 다른 같은 값은 '고정했다' 로 세지 않는다
  assert.deepEqual(pinHostSecurityEnv('AUTH_ENABLED=true\r\n', 'AUTH_ENABLED=true\n').pinned, []);
  // LF ↔ LF 는 예전 글자 그대로
  const p3 = pinHostSecurityEnv('AUTH_ENABLED=false\nUPGRADE_SIGNATURE_POLICY=warn\nPORT=1\n', 'AUTH_ENABLED=true\nUPGRADE_SIGNATURE_POLICY=require\nOTP_ROLE_ENFORCE=true\n');
  assert.equal(p3.text, 'AUTH_ENABLED=true\nUPGRADE_SIGNATURE_POLICY=require\nPORT=1\n\nOTP_ROLE_ENFORCE=true');
});

/* ── A4 ──────────────────────────────────────────────────────────────────── */
function fakeReq(baseUrl, { len = 2_000_000 } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { baseUrl, path: '/', headers: { 'content-length': String(len) }, complete: true, ip: '10.0.0.9', get: (h) => req.headers[String(h).toLowerCase()] });
  return req;
}
function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, set() { return res; }, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } });
  return res;
}
test('A4 bigJsonGate — 서버 등록 업로드(analyze · apply)는 관리자에게 큰 파서를 준다(app.use 로 달리면 full 이 "/" 로 끝난다)', async () => {
  const { bigJsonGate, sessionBigBodyAllowed } = await import('../src/util/bigJsonGate.js');
  const mk = (user) => {
    const hits = { parser: 0, next: 0 };
    const gate = bigJsonGate((_req, _res, next) => { hits.parser += 1; next(); }, {
      central: () => false, session: () => user,
      sessionAllowed: (_req, u, full) => sessionBigBodyAllowed(u, full, { permsOf: () => new Set(['svcmon']), scoped: () => true }),
    });
    return { gate, hits };
  };
  const run = (user, baseUrl) => { const { gate, hits } = mk(user); const res = fakeRes(); gate(fakeReq(baseUrl), res, () => { hits.next += 1; }); res.emit('finish'); return hits; };
  const admin = { username: 'adm', role: 'admin' };
  for (const p of ['/api/tools/bm-usage/onboard/analyze', '/api/tools/bm-usage/onboard/apply']) {
    assert.deepEqual(run(admin, p), { parser: 1, next: 1 }, `관리자(범위 계정 포함)는 큰 파서를 탄다: ${p}`);
    assert.deepEqual(run({ username: 'op', role: 'operator' }, p), { parser: 0, next: 1 }, '운영자는 파싱하지 않는다(라우트가 403)');
    assert.deepEqual(run({ username: 'demo', role: 'admin', demoGuest: true }, p), { parser: 0, next: 1 }, '데모 계정 제외');
    assert.deepEqual(run({ username: 'boot', role: 'admin', mustEnrollOtp: true }, p), { parser: 0, next: 1 }, 'OTP 미등록 세션 제외');
    assert.deepEqual(run(false, p), { parser: 0, next: 1 }, '세션이 없으면 파싱하지 않는다');
    assert.equal(sessionBigBodyAllowed(admin, `${p}/`, {}), true, '끝 "/" 가 붙은 full 도 같은 경로다');
  }
  // 이웃 경로는 그대로 닫혀 있다
  for (const p of ['/api/tools/bm-usage/onboard/other', '/api/tools/bm-usage/onboard', '/api/tools/bm-usage/onboard/analyze/x', '/api/tools/bm-usage/keys']) {
    assert.deepEqual(run(admin, p), { parser: 0, next: 1 }, `모르는 경로는 파싱하지 않는다: ${p}`);
    assert.equal(sessionBigBodyAllowed(admin, p, {}), false);
  }
  // 기존 세션 경로는 예전 그대로(범위 관리자의 svcmon 가져오기 · 로그 분석은 닫힘 · hostmap 은 열림)
  assert.deepEqual(run(admin, '/api/svcmon/targets/import'), { parser: 0, next: 1 });
  assert.deepEqual(run(admin, '/api/admin/log-analysis/paste'), { parser: 0, next: 1 });
  assert.deepEqual(run(admin, '/api/svcmon/targets/hostmap/parse'), { parser: 1, next: 1 });
});

test('A4 bigJsonGate — 업로드 슬롯은 응답이 끝나면 풀린다(요청자당 1건 — 두 번째는 503, 끝난 뒤에는 다시 받는다)', async () => {
  const { bigJsonGate, sessionBigBodyAllowed, bigJsonStats } = await import('../src/util/bigJsonGate.js');
  const admin = { username: 'adm108', role: 'admin' };
  let parsed = 0;
  const gate = bigJsonGate(() => { parsed += 1; }, { central: () => false, session: () => admin, sessionAllowed: (_r, u, full) => sessionBigBodyAllowed(u, full, {}) });
  const before = bigJsonStats('session').inflight;
  const r1 = fakeRes(); gate(fakeReq('/api/tools/bm-usage/onboard/analyze'), r1, () => {});
  assert.equal(parsed, 1); assert.equal(bigJsonStats('session').inflight, before + 1);
  const r2 = fakeRes(); gate(fakeReq('/api/tools/bm-usage/onboard/apply'), r2, () => {});
  assert.equal(parsed, 1); assert.equal(r2.statusCode, 503, '같은 요청자의 두 번째 큰 본문은 503');
  r1.emit('finish');
  assert.equal(bigJsonStats('session').inflight, before);
  const r3 = fakeRes(); gate(fakeReq('/api/tools/bm-usage/onboard/apply'), r3, () => {});
  assert.equal(parsed, 2); r3.emit('close');
  assert.equal(bigJsonStats('session').inflight, before);
});

/* ── A5 ──────────────────────────────────────────────────────────────────── */
test('A5 normalizeAddresses — 긴 주소는 길이로 먼저 거절한다(정규식 O(n²) 회귀는 비율로)', async () => {
  const { normalizeAddresses, ADDR_MAX_LEN } = await import('../src/util/smtp.js');
  const evil = (n) => `x@${'a.'.repeat(n)}@`;
  const time = (n) => { const a = evil(n); const t0 = performance.now(); const r = normalizeAddresses([a]); const ms = performance.now() - t0; assert.equal(r.ok.length, 0); assert.equal(r.bad.length, 1); assert.ok(r.bad[0].length <= 80); return ms; };
  time(1_000);   // 예열
  const t1 = time(10_000); const t4 = time(40_000);
  assert.ok(t4 < Math.max(50, t1 * 8), `입력 4배에 시간이 8배를 넘으면 2차 — 1만 ${t1.toFixed(1)}ms · 4만 ${t4.toFixed(1)}ms`);
  // 정상 주소는 그대로 · 상한 바로 아래는 받고 넘으면 거절
  assert.deepEqual(normalizeAddresses('ops@corp.example, a.b+tag@x.co.kr ; OPS@corp.example').ok, ['ops@corp.example', 'a.b+tag@x.co.kr']);
  const at = `${'l'.repeat(64)}@${'d'.repeat(ADDR_MAX_LEN - 64 - 1 - 4)}.com`;
  assert.equal(at.length, ADDR_MAX_LEN);
  assert.deepEqual(normalizeAddresses([at]).ok, [at]);
  assert.deepEqual(normalizeAddresses([`x${at}`]).ok, []);
  // 보내는 사람(From) 검사도 같은 정규식이다 — 접속 전에 길이로 거절한다
  const { sendMail } = await import('../src/util/smtp.js');
  const fromTime = async (n) => { const t0 = performance.now(); await assert.rejects(sendMail({ host: '127.0.0.1', port: 9, from: evil(n) }, { to: 'a@b.co' }), /보내는 사람\(From\)/); return performance.now() - t0; };
  const f1 = await fromTime(10_000); const f4 = await fromTime(40_000);
  assert.ok(f4 < Math.max(50, f1 * 8), `From 검사 — 1만 ${f1.toFixed(1)}ms · 4만 ${f4.toFixed(1)}ms`);
});

/* ── A6 ──────────────────────────────────────────────────────────────────── */
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const sstr = (b) => { const x = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(x.length), x]); };
/** openssh-key-v1 모양(aes256-ctr · bcrypt · rounds) — salt 는 base64 로 '++++' 가 나오게 잡는다(스트림 48~50바이트 = fb ef be). */
function craftKey(rounds, { salt = Buffer.from([0x11, 0xfb, 0xef, 0xbe, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), privLen = 160 } = {}) {
  const opts = Buffer.concat([sstr(salt), u32(rounds)]);
  return Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sstr('aes256-ctr'), sstr('bcrypt'), sstr(opts), u32(1), sstr(Buffer.alloc(51, 1)), sstr(Buffer.alloc(privLen, 2))]).toString('base64');
}
const pemOf = (b64) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64.match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
/** ssh2 가 실제로 푸는 방식(keyParser.js: Buffer.from(본문, 'base64'))으로 읽은 rounds — 사전 검사와 같은 값이어야 한다. */
function roundsAsSsh2(pem) {
  const m = /^-----BEGIN OPENSSH PRIVATE KEY-----(?:\r\n|\n)([\s\S]+)(?:\r\n|\n)-----END OPENSSH PRIVATE KEY-----$/.exec(pem.trim());
  const d = Buffer.from(m[1], 'base64');
  let off = 15; const rd = () => { const n = d.readUInt32BE(off); off += 4; const v = d.subarray(off, off + n); off += n; return v; };
  rd(); rd(); const o = rd();
  return o.readUInt32BE(4 + o.readUInt32BE(0));
}

test('A6 sshKeyKdf — base64url 글자(- · _)가 든 키도 ssh2 가 읽는 그 바이트로 rounds 를 읽는다(상한 우회 없음)', async () => {
  const { opensshKdfRounds, sshKdfRoundsIssue, SSH_KDF_ROUNDS_MAX } = await import('../src/util/sshKeyKdf.js');
  for (const rounds of [256, 65_536, 16]) {
    const b64 = craftKey(rounds);
    assert.ok(b64.includes('++++'), '전제: salt 자리에 ++++');
    const plain = pemOf(b64); const url = pemOf(b64.replace('++++', '----'));
    assert.equal(roundsAsSsh2(url), rounds, '전제: ssh2 는 base64url 글자를 같은 값으로 읽는다');
    for (const pem of [plain, url]) {
      assert.equal(opensshKdfRounds(pem), rounds, `rounds ${rounds}`);
      assert.equal(!!sshKdfRoundsIssue(pem), rounds > SSH_KDF_ROUNDS_MAX, `rounds ${rounds} 판정`);
    }
  }
  // '/' ↔ '_' 도 같다
  const b = craftKey(4096, { salt: Buffer.from([0x11, 0xff, 0xff, 0xff, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) });
  assert.ok(b.includes('////'));
  assert.equal(opensshKdfRounds(pemOf(b.replace('////', '____'))), 4096);
});

test('A6 sshKeyKdf — 64KB 를 넘는 본문 · 중간 END 표지 · 읽을 수 없는 bcrypt 옵션은 통과시키지 않는다', async () => {
  const { opensshKdfRounds, sshKdfRoundsIssue } = await import('../src/util/sshKeyKdf.js');
  // ① 큰 본문(개인 구획 120KB) — 예전에는 '검사 대상 아님' 으로 통과
  const big = pemOf(craftKey(100_000, { privLen: 120_000 }));
  assert.ok(big.length > 64 * 1024);
  assert.equal(opensshKdfRounds(big), 100_000); assert.match(String(sshKdfRoundsIssue(big)), /상한/);
  // ② END 표지가 본문 중간에 하나 더 — ssh2 는 **마지막** END 까지를 본문으로 읽는다(중간 END 줄의 글자도 base64 기호로 풀린다).
  //    그 30글자 + 'AA' = 24바이트를 salt 안에 놓으면 ssh2 에게는 멀쩡한 키(rounds 100,000)인데, 첫 END 에서 멈추는 검사는
  //    옵션이 잘려 '읽을 수 없음 = 검사 대상 아님' 으로 통과시켰다.
  const head = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sstr('aes256-ctr'), sstr('bcrypt'), u32(4 + 32 + 4), u32(32), Buffer.from([9])]);
  assert.equal(head.length % 3, 0, '전제: 머리가 3바이트 경계에서 끝나야 base64 가 이어진다');
  const rest = Buffer.concat([Buffer.alloc(7, 3), u32(100_000), u32(1), sstr(Buffer.alloc(51, 1)), sstr(Buffer.alloc(160, 2))]);
  const mid = `-----BEGIN OPENSSH PRIVATE KEY-----\n${head.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\nAA${rest.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(roundsAsSsh2(mid), 100_000, '전제: ssh2 는 이 글자를 rounds 100,000 키로 읽는다');
  assert.equal(opensshKdfRounds(mid), 100_000, '사전 검사도 ssh2 와 같은 구간을 읽는다');
  assert.match(String(sshKdfRoundsIssue(mid)), /상한/);
  // ③ salt 가 머리 구간(64KB 글자)보다 긴 키 — rounds 를 읽을 수 없으면 거절(모르는 횟수로 돌리지 않는다)
  const longSalt = pemOf(craftKey(100_000, { salt: Buffer.alloc(60_000, 7) }));
  assert.equal(opensshKdfRounds(longSalt), null); assert.match(String(sshKdfRoundsIssue(longSalt)), /읽을 수 없습니다/);
  // ④ bcrypt 인데 옵션이 잘린 머리
  const trunc = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sstr('aes256-ctr'), sstr('bcrypt'), sstr(Buffer.alloc(4))]).toString('base64');
  assert.match(String(sshKdfRoundsIssue(pemOf(trunc))), /읽을 수 없습니다/);
  // 검사 대상이 아닌 것은 예전 그대로 null: 암호 없는 키(kdf none) · 옛 PEM · 빈 값
  const none = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sstr('none'), sstr('none'), sstr(''), u32(1), sstr(Buffer.alloc(51, 1)), sstr(Buffer.alloc(64, 2))]).toString('base64');
  assert.equal(sshKdfRoundsIssue(pemOf(none)), null); assert.equal(opensshKdfRounds(pemOf(none)), null);
  assert.equal(sshKdfRoundsIssue('-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n'), null);
  assert.equal(sshKdfRoundsIssue(''), null); assert.equal(sshKdfRoundsIssue(null), null);
  assert.equal(sshKdfRoundsIssue(pemOf(craftKey(16))), null, '정상 키(rounds 16)는 통과');
});

test('A6 sshKeyKdf — 실제 ssh2: 상한을 넘는 base64url 키는 bcrypt 를 돌리기 전에 거절된다(통합 계정 키 검사)', async () => {
  const { inspectPrivateKey } = await import('../src/security/credentialStore.js');
  // rounds 1,024(상한 128 의 8배 — 검사가 다시 뚫려도 시험이 10초대에 끝나 실패로 드러나는 크기. 65,536 이면 10분대다)
  const pem = pemOf(craftKey(1_024).replace('++++', '----'));
  const t0 = performance.now(); const r = inspectPrivateKey(pem, 'pw'); const ms = performance.now() - t0;
  assert.equal(r.ok, false); assert.match(r.reason, /상한/);
  assert.ok(ms < 1_000, `bcrypt 1,024회를 돌리지 않는다(${ms.toFixed(0)}ms)`);
});

/* ── A7 ──────────────────────────────────────────────────────────────────── */
test('A7 splitHostPort — 사용자 정보(user:pw@)를 호스트로 읽지 않는다(콜론 둘 = IPv6 오판) · 다른 표기는 예전 그대로', async () => {
  const { splitHostPort } = await import('../src/util/hostPort.js');
  assert.deepEqual(splitHostPort('https://user:pw@host:8443/sdk'), { host: 'host', port: 8443, hostPort: 'host:8443', ipv6: false });
  assert.deepEqual(splitHostPort('user:p:w@vc01'), { host: 'vc01', port: 443, hostPort: 'vc01:443', ipv6: false });
  assert.deepEqual(splitHostPort('https://u:p@[2001:db8::10]:9443'), { host: '2001:db8::10', port: 9443, hostPort: '[2001:db8::10]:9443', ipv6: true });
  for (const r of [splitHostPort('https://user:pw@host:8443/'), splitHostPort('a:pw@c:1')]) assert.ok(!/pw|@/.test(JSON.stringify(r)), '결과에 사용자 정보가 남지 않는다');
  assert.equal(splitHostPort('user:pw@'), null);
  // 예전 그대로
  assert.deepEqual(splitHostPort('user@host'), { host: 'host', port: 443, hostPort: 'host:443', ipv6: false });
  assert.deepEqual(splitHostPort('https://vc01:8443/sdk'), { host: 'vc01', port: 8443, hostPort: 'vc01:8443', ipv6: false });
  assert.deepEqual(splitHostPort('fd00::1'), { host: 'fd00::1', port: 443, hostPort: '[fd00::1]:443', ipv6: true });
  assert.deepEqual(splitHostPort('[2001:db8::10]'), { host: '2001:db8::10', port: 443, hostPort: '[2001:db8::10]:443', ipv6: true });
  assert.deepEqual(splitHostPort('http://host:80'), { host: 'host', port: 80, hostPort: 'host:80', ipv6: false });
  assert.equal(splitHostPort(''), null); assert.equal(splitHostPort('https://'), null);
});
