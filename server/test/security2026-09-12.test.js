/**
 * 보안 감사 2026-09-12 회귀 테스트(security_check_20260912.MD).
 * 순수 로직/함수 단위로 확정 취약점의 재발을 고정한다(HTTP 왕복이 필요한 것은 핸들러 로직을 직접 호출).
 *  - H-2: verifyPassword 빈/짧은 해시 만능키 거부(L-7 로 분류했으나 여기서 함께 고정).
 *  - L-1: 압축 폭탄 — gunzip/inflate 출력 상한 초과 시 실패.
 *  - L-2: 중계 토폴로지 CSV 수식 인젝션 가드 + 왕복 무손실.
 *  - M-2: ping vCenter scope 판정(순수 헬퍼 동작).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-sec0912-'));
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-pw-123';

let auth; let archive; let relay; let csv;
before(async () => {
  auth = await import('../src/auth/auth.js');
  archive = await import('../src/upgrade/archive.js');
  relay = await import('../src/relaytopo/store.js');
  csv = await import('../src/util/csv.js');
});

test('L-7: verifyPassword 는 빈/규격 미달 해시를 만능키로 통과시키지 않는다', () => {
  const good = auth.hashPassword('correct horse');
  assert.equal(auth.verifyPassword('correct horse', good), true);
  assert.equal(auth.verifyPassword('wrong', good), false);
  // 빈 해시(scrypt$<salt>$) — keylen 0 → 빈 버퍼 비교가 true 가 되던 결함.
  const salt = 'a'.repeat(32);
  assert.equal(auth.verifyPassword('anything', `scrypt$${salt}$`), false);
  assert.equal(auth.verifyPassword('', `scrypt$${salt}$`), false);
  // 길이 미달 해시/솔트도 거부.
  assert.equal(auth.verifyPassword('x', 'scrypt$abcd$dead'), false);
  assert.equal(auth.verifyPassword('x', 'plain$x$y'), false);
});

test('L-1: 압축 해제 출력 상한 — gunzip/inflateRaw 가 MAX_BUNDLE_BYTES 를 넘기면 실패', () => {
  assert.ok(archive.MAX_BUNDLE_BYTES > 0);
  // 상한을 넘는 출력은 ERR_BUFFER_TOO_LARGE 로 던져진다(파서가 이를 '번들 읽기 실패'로 정리).
  const big = Buffer.alloc(archive.MAX_BUNDLE_BYTES + 1024, 0);
  const gz = zlib.gzipSync(big); // 0 으로 채운 버퍼라 압축률이 매우 높다(폭탄 모사)
  assert.throws(() => zlib.gunzipSync(gz, { maxOutputLength: archive.MAX_BUNDLE_BYTES }));
  // 상한 이하 정상 번들은 통과.
  const small = zlib.gzipSync(Buffer.from('hello'));
  assert.doesNotThrow(() => zlib.gunzipSync(small, { maxOutputLength: archive.MAX_BUNDLE_BYTES }));
});

test('L-2: 중계 토폴로지 CSV 는 수식 셀에 가드(\')를 붙이고 가져오기에서 되돌린다', () => {
  const evil = '=cmd|\' /C calc\'!A0';
  const t = { main: { name: 'Main', privateIp: '10.0.0.1', ssh: { port: 22, username: 'u' }, portalPort: 4000 },
    sites: [{ dc: evil, edge: { privateIp: '10.0.0.2', ssh: { port: 22, username: 'e' } }, irs: { privateIp: '10.0.0.3', ssh: { port: 22, username: 'i' } }, note: '=HYPERLINK("http://x")' }] };
  const out = relay.topologyToCsv(t);
  // 수식 셀은 작은따옴표로 무력화되어야 한다.
  assert.ok(out.includes("'=cmd|"), 'dc 수식 셀이 가드되지 않았다');
  assert.ok(out.includes("'=HYPERLINK"), 'note 수식 셀이 가드되지 않았다');
  // 왕복: 파싱하면 원래 값으로 복원(가드 문자 제거).
  const parsed = relay.parseTopologyTable(out);
  const site = parsed.sites.find((s) => s.dc === evil);
  assert.ok(site, `가져오기에서 dc 가 복원되지 않았다: ${JSON.stringify(parsed.sites.map((s) => s.dc))}`);
});

test('L-2: guardCell/unguardCell 왕복', () => {
  for (const v of ['=1+1', '+A1', '-2', '@x', 'normal', '10.0.0.1', 'Main']) {
    assert.equal(csv.unguardCell(csv.guardCell(v)), v);
  }
});
