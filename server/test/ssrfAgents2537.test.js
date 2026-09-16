/**
 * ssrfAgents2537.test.js — 외부 입력 → 장비 접속 경로 감사(v2.537) 회귀 고정.
 *
 * ── 고정하는 결함 ────────────────────────────────────────────────────────────
 * ① v2.506 은 DNS 리바인딩(TOCTOU) 차단용 `lookup: ssrfLookup` 훅을 **11곳**에 배선했는데,
 *    그 테스트(`audit2506.test.js`)는 **그 11곳만** 검사했다. `new Agent(` 전수를 뽑으니 훅이
 *    없는 dispatcher 가 **9개** 더 있었다 — vCenter(SOAP·REST 공용)·NSX·iDRAC Redfish·OME·
 *    스토리지 REST 3종·svcmon·RMA 테스트 러너. (손 grep 은 8개를 셌고 **9번째는 이 스윕이 잡았다** —
 *    목록 방식이 왜 안 되는지의 증거다.) 전부 사용자가 등록한 host 로 **자격증명을 싣고** 접속하는 경로다.
 *    → 여기서는 목록이 아니라 **전수 스윕**으로 고정한다: src 아래 `new Agent(`/`new UndiciAgent(`
 *    는 예외 없이 lookup 이 있어야 한다. 새 dispatcher 를 만들면 이 테스트가 먼저 잡는다.
 * ② iDRAC·NSX 등록부는 host 를 **형식만** 보고 받았다(storage/sanswitch/pdu 는 v2.313 부터
 *    ssrfBlockReason). bmstor·proxyHost 도 같은 유형.
 * ③ iDRAC 스캐너는 IP 리터럴을 그대로 찔렀다 — lookup 훅은 IP 리터럴에 불리지 않는다
 *    (v2.506 문서의 한계). 정적으로 걸러야 하고, **걸렀으면 개수를 말해야** 한다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssrf2537-'));
delete process.env.SSRF_ALLOW_LOOPBACK; // 기본(차단) 동작을 검사한다

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('★ src 의 모든 undici Agent 생성부에 lookup: ssrfLookup 이 있다(전수 스윕 — 목록이 아니다)', () => {
  const offenders = [];
  let total = 0;
  for (const f of walk(SRC)) {
    const code = strip(fs.readFileSync(f, 'utf8'));
    // 생성부마다 그 호출의 끝(`});`)까지를 한 덩어리로 본다 — 파일 어딘가에 lookup 이 있다고 통과시키면
    // dispatcher 두 개 중 하나만 붙인 파일이 통과한다.
    const re = /new (?:Undici)?Agent\(\{([\s\S]*?)\}\);/g;
    let m;
    while ((m = re.exec(code))) {
      total++;
      const body = m[1];
      let hooked = /lookup: ssrfLookup|withSsrfLookup\(/.test(body);
      // `connect: vcConnect` 처럼 변수를 참조하면 그 변수의 정의가 withSsrfLookup( 으로 감싸져 있어야 한다.
      const ref = /connect:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(body);
      if (!hooked && ref) hooked = new RegExp(`const ${ref[1]} = withSsrfLookup\\(`).test(code);
      if (!hooked) offenders.push(`${path.relative(SRC, f)}: ${body.replace(/\s+/g, ' ').trim().slice(0, 70)}`);
    }
  }
  assert.ok(total >= 12, `Agent 생성부가 너무 적게 잡혔다(${total}) — 정규식이 깨졌을 수 있다`);
  assert.deepEqual(offenders, [], `lookup 훅이 없는 dispatcher:\n  ${offenders.join('\n  ')}`);
});

test('★ v2.537 에 추가한 8개 dispatcher 파일이 실제로 훅을 가진다(스윕과 이중 고정)', () => {
  for (const f of ['vcenter/restClient.js', 'nsx/client.js', 'idrac/redfish.js', 'idrac/ome.js',
    'storage/collectors/restCommon.js', 'storage/collectors/isilon.js', 'sanswitch/collectors/fosRest.js', 'svcmon/checker.js']) {
    assert.match(strip(read(f)), /lookup: ssrfLookup|withSsrfLookup\(/, `${f} 에 lookup 훅이 없다`);
  }
  // 삼항으로 갈리는 두 파일은 **양쪽**이 감싸져야 한다 — withSsrfLookup( 이 삼항 바깥에 있어야 한다.
  assert.match(strip(read('nsx/client.js')), /connect: withSsrfLookup\(nsxVerify \?/, 'nsx: 삼항 바깥에서 감싸야 검증 ON 배포도 덮인다');
  assert.match(strip(read('vcenter/restClient.js')), /const vcConnect = withSsrfLookup\(config\.rejectUnauthorized/, 'vcenter: 삼항 바깥에서 감싸야 한다');
});

let IDRAC; let NSX; let BM; let PROXY; let SCAN;
before(async () => {
  IDRAC = await import('../src/idrac/registry.js');
  NSX = await import('../src/nsx/registry.js');
  BM = await import('../src/bmstor/registry.js');
  PROXY = await import('../src/proxy/registry.js');
  SCAN = await import('../src/idrac/scan.js');
});

test('★ iDRAC 등록부는 루프백·링크로컬 host 를 거부한다 — 단건·일괄(bulk-add)·스캔 등록 전부', () => {
  const r1 = IDRAC.addServer({ id: 'lo', name: 'lo', host: '127.0.0.1', username: 'u', password: 'p' });
  assert.equal(r1.ok, false); assert.match(r1.reason, /루프백/);
  const r2 = IDRAC.addServer({ id: 'll', name: 'll', host: 'https://169.254.169.254', username: 'u', password: 'p' });
  assert.equal(r2.ok, false); assert.match(r2.reason, /링크로컬|사용할 수 없/);
  // 정상(RFC1918)은 통과 — 과차단 금지
  const ok = IDRAC.addServer({ id: 'ok', name: 'ok', host: '10.10.10.10', username: 'u', password: 'p' });
  assert.equal(ok.ok, true, ok.reason);
  // bulk-add 는 importServers → normalize 를 지난다 — 우회 경로가 아니어야 한다
  const b = IDRAC.bulkAddByIps({ ips: '127.0.0.1, 10.10.10.11', username: 'u', password: 'p' });
  assert.equal(b.added, 1, JSON.stringify(b));
  assert.equal(b.skipped.length, 1);
  assert.match(b.skipped[0].reason, /루프백/);
  // 스캔 등록도 같은 경로
  const s = IDRAC.registerScanned([{ ip: '127.0.0.2', hostName: 'x' }, { ip: '10.10.10.12' }], 'u', 'p');
  assert.equal(s.added, 1, JSON.stringify(s));
  assert.match(s.skipped[0].reason, /루프백/);
  // IPv6 리터럴은 괄호 없이 `https://::1` 이 되어 URL 파서가 먼저 거부한다 — 사유는 '형식' 이지만
  // **거부된다는 사실**이 계약이다(정직 기록: 루프백이라고 말해 주지는 않는다. 스캐너는 IPv4 만 낸다).
  const v6 = IDRAC.addServer({ id: 'v6', name: 'v6', host: '::1', username: 'u', password: 'p' });
  assert.equal(v6.ok, false);
});

test('★ NSX 등록부는 루프백 host 를 거부한다(형식만 보던 것)', () => {
  const r = NSX.upsertManager ? NSX.upsertManager({ id: 'n1', name: 'n1', host: 'https://127.0.0.1', username: 'admin', password: 'p' })
    : NSX.addManager({ id: 'n1', name: 'n1', host: 'https://127.0.0.1', username: 'admin', password: 'p' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.reason || r.error), /루프백/);
});

test('bmstor(SSH)·proxyHost 도 같은 규칙', () => {
  assert.match(String(BM.bmServerInputIssue({ host: '127.0.0.1', username: 'root', mounts: ['/'] })), /루프백/);
  assert.equal(BM.bmServerInputIssue({ host: '10.0.0.5', username: 'root', mounts: ['/'] }), null);
  assert.match(String(PROXY.proxyHostIssue('127.0.0.1')), /루프백/);
  assert.equal(PROXY.proxyHostIssue(''), null, '미설정은 허용');
  assert.equal(PROXY.proxyHostIssue('relay.corp.local'), null, '이름은 통과(접속 시 lookup 훅이 본다)');
  const p = PROXY.saveProxy({ name: 'bad', proxyHost: '::1' });
  assert.equal(p.ok, false); assert.match(p.reason, /루프백/);
});

test('★ iDRAC 스캐너는 차단 대역을 찌르지 않고 개수를 말한다(조용한 제외 금지)', async () => {
  // 127.0.0.1-3 은 전부 차단 → probe 가 한 번도 불리지 않아야 한다(불리면 실제 :443 접속을 3초씩 기다린다).
  const t0 = Date.now();
  const r = await SCAN.scanForIdracs({ ips: '127.0.0.1-3', username: 'u', password: 'p', perHostTimeout: 500 });
  assert.equal(r.blocked, 3);
  assert.deepEqual(r.blockedIps, ['127.0.0.1', '127.0.0.2', '127.0.0.3']);
  assert.equal(r.blockedTruncated, false);
  assert.equal(r.scanned, 0, '차단분은 scanned 에 세지 않는다');
  assert.ok(Date.now() - t0 < 400, `probe 가 실행된 것으로 보인다(${Date.now() - t0}ms)`);
});

test('스캔 결과의 blocked 가 기록·이벤트·화면 문구까지 이어진다(소스 계약)', () => {
  assert.match(strip(read('idrac/scanPoller.js')), /blocked: r\.blocked \?\? null/);
  const jobs = strip(read('central/idracScanJobs.js'));
  assert.match(jobs, /blocked: data\.blocked \?\? null/);
  assert.match(jobs, /blocked: Number\(data\.blocked\) \|\| 0/);
  const web = fs.readFileSync(path.resolve(SRC, '../../web/src/views/idrac/scanRunText.js'), 'utf8');
  assert.match(web, /r\.blocked/);
});
