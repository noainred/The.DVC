import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.296 회귀 방지 — 자격증명 저장 방식(평문/암호화) 중앙 모듈(secretVault).
// 고정하는 의미론: ① 레벨 1/2/3·알고리즘별 봉인/복호 라운드트립 ② 자기서술 포맷(정책과 무관하게
// 복호·평문/암호문 혼재 허용) ③ AEAD 변조 거부(빈 값 폴백, throw 금지) ④ 깊은 봉인은 정확 일치
// 필드만(passwordHash 오봉인 금지)·원본 불변 ⑤ 이중 봉인 방지 ⑥ 모드 전환 마이그레이션 양방향.
// 격리 CONFIG_DIR — secretVault 는 import 시점 CONFIG_DIR 로 키/정책 경로를 정한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-vault-test-'));
process.env.CONFIG_DIR = TMP;
delete process.env.SECRETS_KEY;

const v = await import('../src/security/secretVault.js');

test('정책 저장/정규화 — 기본 평문(하위호환)·레벨/알고리즘 검증', () => {
  assert.deepEqual(v.loadSecretsPolicy(), { mode: 'plain', level: 2, algorithm: '' });
  const p = v.saveSecretsPolicy({ mode: 'encrypted', level: 3, algorithm: 'chacha20-poly1305' });
  assert.deepEqual(p, { mode: 'encrypted', level: 3, algorithm: 'chacha20-poly1305' });
  // 무효값은 안전한 값으로 정규화(무효 모드=plain, 무효 레벨=2, 무효 알고리즘=자동)
  const bad = v.saveSecretsPolicy({ mode: 'rot13', level: 9, algorithm: 'aes-256-cbc' });
  assert.deepEqual(bad, { mode: 'plain', level: 2, algorithm: '' });
});

test('레벨 1/2/3 + 알고리즘 선택 라운드트립(한글·특수문자·공백 비번 보존)', () => {
  const SECRETS = ['p@ss word!', '한글비번#2026', ' 앞뒤공백 '];
  for (const [level, algorithm] of [[1, ''], [2, ''], [3, ''], [2, 'aes-192-gcm'], [2, 'chacha20-poly1305']]) {
    const pol = { mode: 'encrypted', level, algorithm };
    for (const s of SECRETS) {
      const sealed = v.sealSecret(s, pol);
      assert.ok(v.isSealed(sealed), `봉인 포맷이어야 함(L${level}/${algorithm || 'auto'})`);
      assert.notEqual(sealed, s);
      assert.equal(v.openSecret(sealed), s, '라운드트립 보존');
    }
  }
  // 자기서술: L3 로 봉인한 값은 정책이 L1 로 바뀌어도 복호된다(혼재 허용의 근거)
  const sealedL3 = v.sealSecret('mixed-ok', { mode: 'encrypted', level: 3, algorithm: '' });
  v.saveSecretsPolicy({ mode: 'encrypted', level: 1, algorithm: '' });
  assert.equal(v.openSecret(sealedL3), 'mixed-ok');
});

test('평문 모드/빈 값/이미 봉인된 값 — sealSecret 무변, openSecret 은 평문 통과', () => {
  assert.equal(v.sealSecret('plain-keeps', { mode: 'plain', level: 2, algorithm: '' }), 'plain-keeps');
  assert.equal(v.sealSecret('', { mode: 'encrypted', level: 2, algorithm: '' }), '');
  const once = v.sealSecret('no-double', { mode: 'encrypted', level: 1, algorithm: '' });
  assert.equal(v.sealSecret(once, { mode: 'encrypted', level: 1, algorithm: '' }), once, '이중 봉인 방지');
  assert.equal(v.openSecret('그냥 평문'), '그냥 평문');
});

test('AEAD 변조 거부 — 복호 실패는 throw 가 아니라 빈 문자열(폴링 루프 보호)', () => {
  const sealed = v.sealSecret('tamper-me', { mode: 'encrypted', level: 1, algorithm: '' });
  const parts = sealed.split('$');
  parts[parts.length - 1] = parts[parts.length - 1].slice(0, -2) + 'AA'; // 암호문 꼬리 변조
  assert.equal(v.openSecret(parts.join('$')), '', '변조된 값은 빈 문자열');
});

test('깊은 봉인 — 정확 일치 필드만·passwordHash 미봉인·원본 불변·깊은 복호는 키 무관', () => {
  const pol = { mode: 'encrypted', level: 1, algorithm: '' };
  const src = {
    vcenters: [{ name: 'A', password: 'pw-a', passwordHash: 'HASH-유지' }],
    nested: { vms: { 'vm-1': { username: 'root', password: 'pw-vm' } } },
    collectors: [{ id: 'e1', token: 'tok-1' }],
    empty: { password: '' },
  };
  const sealed = v.sealSecretsDeep(src, pol);
  assert.equal(src.vcenters[0].password, 'pw-a', '원본 불변(깊은 복제) — 메모리 오염 금지');
  assert.ok(v.isSealed(sealed.vcenters[0].password));
  assert.ok(v.isSealed(sealed.nested.vms['vm-1'].password));
  assert.ok(v.isSealed(sealed.collectors[0].token), 'token(엣지 접속)도 봉인');
  assert.equal(sealed.vcenters[0].passwordHash, 'HASH-유지', 'passwordHash 는 정확 일치가 아니라 미봉인');
  assert.equal(sealed.empty.password, '', '빈 비번은 그대로');
  // openSecretsDeep 은 키 이름 무관 — 봉인 포맷이면 어디서든 복호
  const opened = v.openSecretsDeep(structuredClone(sealed));
  assert.equal(opened.vcenters[0].password, 'pw-a');
  assert.equal(opened.nested.vms['vm-1'].password, 'pw-vm');
  assert.equal(opened.collectors[0].token, 'tok-1');
});

test('마이그레이션 양방향 — 평문→암호화→평문(파일 실측) + 미존재 파일 무해', () => {
  // 대표 파일 2개를 평문으로 시드
  const vc = path.join(TMP, 'vcenters.json');
  const gg = path.join(TMP, 'gpu-guest.json');
  fs.writeFileSync(vc, JSON.stringify({ vcenters: [{ name: 'A', password: 'pw-vc' }] }));
  fs.writeFileSync(gg, JSON.stringify({ vcenters: { OC2: { username: 'root', password: 'pw-shared', vms: { v1: { password: 'pw-vm' } } } } }));

  // 평문 → 암호화
  const enc = v.migrateSecretFiles({ mode: 'encrypted', level: 2, algorithm: '' });
  assert.equal(enc.errors.length, 0, JSON.stringify(enc.errors));
  const rawEnc = fs.readFileSync(vc, 'utf8');
  assert.ok(!rawEnc.includes('pw-vc'), '파일에서 평문이 사라져야 함');
  assert.ok(rawEnc.includes('enc$1$'), '봉인 포맷으로 저장');
  const ggEnc = JSON.parse(fs.readFileSync(gg, 'utf8'));
  assert.ok(v.isSealed(ggEnc.vcenters.OC2.password) && v.isSealed(ggEnc.vcenters.OC2.vms.v1.password), '중첩 VM별 계정도 봉인');
  // 존재하지 않는 대상 파일은 changed=false 로 무해하게 보고
  const missing = enc.files.find((f) => f.file === 'horizon.json');
  assert.deepEqual(missing, { file: 'horizon.json', changed: false, secrets: 0 });

  // 암호화 → 평문(복원)
  const dec = v.migrateSecretFiles({ mode: 'plain', level: 2, algorithm: '' });
  assert.equal(dec.errors.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(vc, 'utf8')), { vcenters: [{ name: 'A', password: 'pw-vc' }] }, '평문 완전 복원');
  assert.equal(JSON.parse(fs.readFileSync(gg, 'utf8')).vcenters.OC2.vms.v1.password, 'pw-vm');
});

test('레벨/알고리즘 변경 재봉인 — 기존 암호문이 새 정책으로 다시 봉인된다', () => {
  const vc = path.join(TMP, 'vcenters.json');
  v.migrateSecretFiles({ mode: 'encrypted', level: 1, algorithm: '' });
  const a = JSON.parse(fs.readFileSync(vc, 'utf8')).vcenters[0].password;
  assert.ok(a.includes('aes-128-gcm'), 'L1 = aes-128-gcm');
  v.migrateSecretFiles({ mode: 'encrypted', level: 2, algorithm: 'chacha20-poly1305' });
  const b = JSON.parse(fs.readFileSync(vc, 'utf8')).vcenters[0].password;
  assert.ok(b.includes('chacha20-poly1305'), '명시 알고리즘으로 재봉인');
  assert.equal(v.openSecret(b), 'pw-vc', '값은 보존');
});
