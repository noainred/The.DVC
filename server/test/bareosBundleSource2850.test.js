/**
 * test/bareosBundleSource2850.test.js — v2.850 Bareos 완전 설치 번들의 받는 주소 지정 · 서버 디렉터리(사용자 요청
 *   '번들을 받는 별도의 url 을 지정하는 기능, 서버의 특정 디렉터리에 받아두면 적용하는 기능').
 *  ① 받는 주소 판정 — http/https 만 · 계정 정보 · ?# 금지 · 차단 대역(링크로컬 · 루프백) 거부 · 사내 RFC1918 허용 · 끝 / 제거
 *  ② 서버 디렉터리 판정 — 절대 경로 · .. 금지 · 루트 금지 · 저장 · 부분 저장 · 손상 파일은 기본값 + 보존
 *  ③ 출처 우선순위 — 화면 > env > 업그레이드 패키지 주소에서 유도
 *  ④ 서버 디렉터리의 번들 — 같은 서명 검증을 지나면 목록 · 설치(pickBundle)에 쓰인다 · 막 바뀐 파일은 '확인 중' · 심링크 거부 · 포탈이 지우지 않음
 *  ⑤ 받기 — 서버 디렉터리에 같은 판이 검증돼 있으면 받지 않는다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundlesrc2850-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
delete process.env.BAREOS_BUNDLE_BASE_URL;

const { signBundle } = await import('../../scripts/bareos-bundle-sign.mjs');
const { keyIdOf, spkiBase64Of, parseKeysDoc, mergeTrust } = await import('../src/upgrade/signatureCore.js');
const BD = await import('../src/bareos/install/bundleDoc.js');
const SRC = await import('../src/bareos/install/bundleSource.js');
const B = await import('../src/bareos/install/bundle.js');
const W = await import('../../web/src/views/tools/bareosInstallText.js');
after(() => { B._setTrustForTest(null); B._setNowForTest(null); B._setFetchForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

function signed(v) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const doc = { format: 'vmware-portal-release-keys', schema: 1, keys: [{ keyId: keyIdOf(publicKey), publicKey: spkiBase64Of(publicKey), addedAt: '2026-11-01', revoked: false }] };
  const dir = fs.mkdtempSync(path.join(tmp, 'import-'));
  const keysFile = path.join(tmp, `keys-${v}.json`);
  fs.writeFileSync(keysFile, JSON.stringify(doc));
  fs.writeFileSync(path.join(dir, BD.tarName(v)), crypto.randomBytes(4096));
  fs.writeFileSync(path.join(dir, BD.contentsName(v)), JSON.stringify({ format: 'portal-bareos-bundle', v: 1, version: v, el: '9', arch: 'x86_64', bareosVersion: '25.1.2', postgresqlVersion: '13.23',
    install: ['bareos-director', 'postgresql-server'], packages: [], keys: ['K'], pyvmomi: { versions: ['8.0.3.0.1'], default: '8.0.3.0.1' }, vddk: [] }));
  signBundle({ version: v, dist: dir, keysFile, env: { RELEASE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) } });
  return { dir, v, trust: mergeTrust([parseKeysDoc(doc, 'test')]) };
}

test('① 받는 주소 판정', () => {
  assert.equal(SRC.normBundleUrl(''), '');
  assert.equal(SRC.normBundleUrl(' http://192.168.21.177:8081/repository/manager-upgrade/The.DVC/releases/download/bareos-bundle/ '), 'http://192.168.21.177:8081/repository/manager-upgrade/The.DVC/releases/download/bareos-bundle', '사내 미러(RFC1918) 허용 · 끝 / 제거');
  for (const [bad, re] of [
    ['ftp://mirror/x', /http\/https/], ['https://user:pw@mirror.corp/x', /계정 정보/], ['https://mirror.corp/x?token=1', /\?/],
    ['http://169.254.169.254/latest', /받지 않습니다/], ['http://127.0.0.1:8081/x', /받지 않습니다/], ['mirror.corp/x', /형식/], [`https://m/${'a'.repeat(600)}`, /길거나/],
  ]) assert.throws(() => SRC.normBundleUrl(bad), (e) => e.code === 'invalid' && re.test(e.message), bad);
});

test('② 서버 디렉터리 판정 · 저장 · 부분 저장 · 손상 파일', () => {
  assert.equal(SRC.normImportDir(''), '');
  assert.equal(SRC.normImportDir('/data/bareos-bundle/'), '/data/bareos-bundle');
  for (const bad of ['data/x', '/data/../etc', '/', '/x\0y']) assert.throws(() => SRC.normImportDir(bad), (e) => e.code === 'invalid', bad);
  SRC._resetBundleSourceForTest();
  assert.deepEqual(SRC.saveBundleSource({ baseUrl: 'https://mirror.corp/b', importDir: '/data/b' }), { baseUrl: 'https://mirror.corp/b', importDir: '/data/b' });
  assert.deepEqual(SRC.saveBundleSource({ importDir: '' }), { baseUrl: 'https://mirror.corp/b', importDir: '' }, '보낸 칸만 바꾼다');
  assert.throws(() => SRC.saveBundleSource({ baseUrl: 'http://127.0.0.1/x', importDir: '/z' }), /받지 않습니다/);
  assert.equal(SRC.getBundleSource().importDir, '', '판정이 틀리면 아무것도 바꾸지 않는다');
  fs.writeFileSync(path.join(tmp, 'bareos-bundle-source.json'), '{ 손상');
  SRC._resetBundleSourceForTest();
  const g = SRC.getBundleSource();
  assert.deepEqual([g.baseUrl, g.importDir], ['', '']);
  assert.match(g.loadError, /읽지 못해/);
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('bareos-bundle-source.json.corrupt')), '손상본 보존');
  SRC._resetBundleSourceForTest(); fs.rmSync(path.join(tmp, 'bareos-bundle-source.json'), { force: true });
});

test('③ 받는 주소 출처 — 화면 > env > 업그레이드 패키지 주소', () => {
  const pkg = 'https://github.com/noainred/The.DVC/releases/download/downloads';
  assert.deepEqual(B.bundleSourceInfo({}, pkg, ''), { url: 'https://github.com/noainred/The.DVC/releases/download/bareos-bundle', from: 'package' });
  assert.deepEqual(B.bundleSourceInfo({ BAREOS_BUNDLE_BASE_URL: 'https://env.corp/b/' }, pkg, ''), { url: 'https://env.corp/b', from: 'env' });
  assert.deepEqual(B.bundleSourceInfo({ BAREOS_BUNDLE_BASE_URL: 'https://env.corp/b' }, pkg, 'https://ui.corp/b'), { url: 'https://ui.corp/b', from: 'ui' });
  assert.equal(W.bundleFromText('ui'), '화면에서 정한 주소');
});

test('④ 서버 디렉터리의 번들 — 검증되면 목록 · 설치에 쓰이고 · 막 바뀐 파일은 확인 중 · 심링크 거부 · 지우지 않음', async () => {
  const s = signed('25.20261102.1');
  B._setTrustForTest(s.trust);
  SRC.saveBundleSource({ importDir: s.dir });
  assert.equal(B.importDirState(s.dir), 'ok');
  assert.equal(B.importDirState(path.join(tmp, 'nope')), 'missing');
  // 방금 쓴 파일 — 복사 중일 수 있어 해시하지 않는다
  B._setNowForTest(() => Date.now());
  let all = await B.listAllBundles({ verify: true });
  let row = all.find((x) => x.where === 'import');
  assert.equal(row.ok, null); assert.match(row.reason, /막 바뀌었습니다/);
  assert.equal(W.bundleStateView(row).cls, 'amber');
  assert.equal(await B.pickBundle(), null, '확인 중인 번들은 설치에 쓰지 않는다');
  // 잠시 뒤 — 서명 · 해시가 맞으면 사용 가능 · 설치는 그 디렉터리의 파일을 쓴다
  B._setNowForTest(() => Date.now() + B.SETTLE_MS + 1_000);
  all = await B.listAllBundles({ verify: true });
  row = all.find((x) => x.where === 'import');
  assert.equal(row.ok, true, row.reason);
  assert.equal(W.bundleWhereText(row.where), '서버 디렉터리');
  const pick = await B.pickBundle();
  assert.equal(pick.version, s.v);
  assert.equal(path.dirname(pick.tarPath), s.dir, '복사하지 않고 그 자리에서 쓴다');
  // 포탈의 지우기는 받은 번들 폴더만 — 서버 디렉터리 파일은 그대로
  B.deleteBundle(s.v);
  assert.ok(fs.existsSync(path.join(s.dir, BD.tarName(s.v))));
  // 변조되면 쓰지 않는다
  const s2 = signed('25.20261102.2');
  fs.appendFileSync(path.join(s2.dir, BD.tarName(s2.v)), 'x');
  B._setTrustForTest(s2.trust);
  SRC.saveBundleSource({ importDir: s2.dir });
  all = await B.listAllBundles({ verify: true });
  assert.equal(all.find((x) => x.where === 'import').ok, false);
  // 심링크는 쓰지 않는다
  const s3 = signed('25.20261102.3');
  const linkDir = fs.mkdtempSync(path.join(tmp, 'link-'));
  for (const n of [BD.tarName(s3.v), BD.contentsName(s3.v), BD.manifestName(s3.v)]) fs.symlinkSync(path.join(s3.dir, n), path.join(linkDir, n));
  B._setTrustForTest(s3.trust);
  SRC.saveBundleSource({ importDir: linkDir });
  all = await B.listAllBundles({ verify: true });
  row = all.find((x) => x.where === 'import');
  assert.equal(row.ok, false); assert.match(row.reason, /심링크/);
  SRC.saveBundleSource({ importDir: '' });
});

test('⑤ 받기 — 서버 디렉터리에 같은 판이 검증돼 있으면 받지 않는다', async () => {
  const s = signed('25.20261102.4');
  B._setTrustForTest(s.trust);
  B._setNowForTest(() => Date.now() + B.SETTLE_MS + 1_000);
  SRC.saveBundleSource({ importDir: s.dir });
  const pointer = fs.readFileSync(path.join(s.dir, BD.POINTER_NAME));
  const urls = [];
  B._setFetchForTest(async (url) => { urls.push(url); return url.endsWith(BD.POINTER_NAME) ? { ok: true, status: 200, body: Readable.from([pointer]) } : { ok: false, status: 404, body: Readable.from([]) }; });
  const r = await B.fetchLatestBundle({ baseUrl: 'https://mirror.corp/b' });
  assert.equal(r.ok, true, r.reason); assert.equal(r.already, true); assert.equal(r.where, 'import');
  assert.deepEqual(urls, ['https://mirror.corp/b/bareos-bundle.json'], '본체를 받지 않았다');
  SRC.saveBundleSource({ importDir: '' });
});

test('⑥ 라우트 — 저장은 관리자 · 전체 범위 · 쓰기 범위 · installGate(데모 계정 403 · OTP 등록 계정만) · 판정 오류는 400', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/bareosInstall.js', import.meta.url), 'utf8');
  assert.match(src, /api\.put\(`\$\{P\}\/bundle\/source`, adminOnly, fullScopeOnly, fullWriteOnly, \(req, res\) => \{\n\s+if \(!installGate\(req, res\)\) return;/);
  assert.match(src, /if \(e\?\.code === 'invalid'\) return res\.status\(400\)/);
  assert.match(src, /bundles: await listAllBundles\(\{ verify: true \}\), fetch: bundleFetchStatus\(\)/, '화면을 열 때(개요) 두 폴더를 검증한다(받아 두면 적용)');
});
