/**
 * test/perf2899.test.js — v2.899 전체 점검 성능 · 정리 확정분(하).
 *  P2 엣지 자동 업그레이드 동기화 — 번들 sha256 은 한 번(서명 판정 · push 헤더가 같은 캐시) · 주기 경로는 비동기 읽기
 *  P4 첨부 보관(tar) 목록 — present.includes(제곱) 대신 Set
 *  P5 필터 주간 메일 — 재진입 가드(겹쳐 두 번 보내지 않게) + 가드 시한
 *  P6 첨부 올리기 — 쓰기 · 이름 바꾸기가 실패하면 임시 파일을 지운다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf2899-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('P2 번들 sha256 — 같은 Buffer 는 한 번만 · 서명 판정과 push 헤더가 같은 캐시 · 주기 경로는 비동기 읽기', async () => {
  const { bundleSha } = await import('../src/util/bundleSha.js');
  const buf = Buffer.from('bundle-bytes');
  const want = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(bundleSha(buf), want);
  assert.equal(bundleSha(buf), want, '캐시');
  assert.equal(bundleSha(Buffer.from('bundle-bytes')), want, '다른 Buffer 도 같은 값(내용으로 계산)');
  const bs = src('../src/upgrade/bundleSource.js');
  assert.match(bs, /sha256: bundleSha\(bytes\), size: bytes\.length/, '서명 판정에 바이트 대신 계산한 sha 를 넘긴다(해시 1회)');
  assert.doesNotMatch(bs, /decideSignature\(\{[^}]*\bbytes,/, '바이트를 넘겨 서명 판정이 다시 해시하지 않는다');
  assert.match(bs, /await fromArchiveAsync\(p, exact, 'package'\)/);
  assert.match(bs, /await fromArchiveAsync\(found\.path/);
  assert.match(bs, /await fs\.promises\.readFile\(archivePath\)/);
  const up = src('../src/collector/upgradePush.js');
  assert.match(up, /import \{ bundleSha \} from '\.\.\/util\/bundleSha\.js'/, 'push 헤더도 같은 캐시');
  assert.doesNotMatch(up, /createHash/);
});

test('P2 resolveBundleBytes — 패키지 폴더 번들을 비동기로 읽어 돌려준다(서명 판정 결과 그대로)', async () => {
  const pkgDir = fs.mkdtempSync(path.join(tmp, 'pkg-'));
  const { currentVersion } = await import('../src/config.js');
  const v = String(currentVersion());
  fs.writeFileSync(path.join(pkgDir, `vmware-portal-${v}.tar.gz`), Buffer.from('not-a-real-bundle'));
  const { resolveBundleBytes, lastBundleReject } = await import('../src/upgrade/bundleSource.js');
  const b = await resolveBundleBytes({}, { exactVersion: v, localDirs: [pkgDir], remote: false });
  // 신뢰 키가 없는 설치본은 warn(통과) · 있으면 서명 없음으로 거부 — 어느 쪽이든 던지지 않고, 통과면 읽은 바이트를 돌려준다
  if (b) { assert.equal(b.bytes.toString(), 'not-a-real-bundle'); assert.equal(b.source, 'package'); }
  else assert.ok(lastBundleReject(), '거부면 사유가 남는다');
});

test('P4 첨부 보관 목록 — Set 으로 본체 유무(소스)', () => {
  const s = src('../src/attach/store.js');
  assert.doesNotMatch(s, /present\.includes\(/);
  assert.match(s, /missing: !has\.has\(x\)/);
});

test('P5 필터 주간 메일 — 겹쳐 부르면 둘째는 돌지 않는다 · 가드에는 시한', async () => {
  const nt = await import('../src/issues/notify.js');
  nt._resetWeeklyBusyForTest();
  const SUN = Date.UTC(2026, 10, 1, 3);   // 일요일 — 본문은 곧바로 끝난다(가드만 본다)
  const p1 = nt.scanWeeklyFilters(SUN);
  const r2 = await nt.scanWeeklyFilters(SUN);
  assert.equal(r2.busy, true, '앞 실행이 끝나기 전에는 돌지 않는다');
  const r1 = await p1;
  assert.equal(r1.busy, undefined);
  assert.equal((await nt.scanWeeklyFilters(SUN)).busy, undefined, '끝나면 가드가 풀린다');
  nt._resetWeeklyBusyForTest(Date.now() - 60_000);
  assert.equal((await nt.scanWeeklyFilters(SUN)).busy, true, '시한 안이면 붙잡는다');
  nt._resetWeeklyBusyForTest(Date.now() - nt.WEEKLY_BUSY_MAX_MS - 1);
  assert.equal((await nt.scanWeeklyFilters(SUN)).busy, undefined, '시한이 지난 가드는 풀고 돈다(끝나지 않는 한 번이 영원히 붙잡지 않게)');
  nt._resetWeeklyBusyForTest();
});

test('P6 첨부 올리기 — 이름 바꾸기가 실패하면 임시 파일을 남기지 않는다', async () => {
  const st = await import('../src/attach/store.js');
  st._resetAttachCache();
  const orig = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  try {
    assert.throws(() => st.addAttachment('wiki', 'W1', 'a.txt', Buffer.from('hello'), 'adm'), /ENOSPC/);
  } finally { fs.renameSync = orig; }
  const left = fs.readdirSync(st.attachDir());
  assert.deepEqual(left.filter((n) => n.includes('.tmp-')), [], '임시 파일이 남지 않는다');
  assert.equal(st.listFor('wiki', 'W1').length, 0, '목록에도 없다');
  // 정상 경로는 그대로
  const v = st.addAttachment('wiki', 'W1', 'b.txt', Buffer.from('world'), 'adm');
  assert.ok(v?.id);
  assert.ok(fs.existsSync(st.blobOf(v.id)));
});
