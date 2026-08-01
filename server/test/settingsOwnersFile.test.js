import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// securitySettings.js 는 import 시점의 CONFIG_DIR 을 사용 → 격리 후 로드.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'owners-test-'));
process.env.CONFIG_DIR = TMP;
process.env.SETTINGS_OWNERS = ' envowner , bad name! , envowner ';
fs.writeFileSync(path.join(TMP, 'settings-owners.txt'), [
  '# 설정 접근 계정',
  'fileowner1',
  '  fileowner2   # 뒤 주석',
  '',
  '# 주석만 있는 줄',
].join('\n'));

const sec = await import('../src/security/securitySettings.js');

test('파일/환경변수 소유자: 주석·공백 제거, 형식 위반·중복 배제', () => {
  const owners = sec.fileSettingsOwners();
  assert.ok(owners.includes('fileowner1'));
  assert.ok(owners.includes('fileowner2'), '줄 뒤 # 주석은 잘라내야 함');
  assert.ok(owners.includes('envowner'), 'SETTINGS_OWNERS 환경변수도 합산');
  assert.ok(!owners.includes('bad name!'), '형식 위반 계정명은 배제');
  assert.equal(owners.filter((o) => o === 'envowner').length, 1, '중복 제거');
});

test('loadSessionSecurity: UI 저장분 + 파일/환경변수 + 수퍼관리자 합산', () => {
  sec.saveSessionSecurity({ settingsOwners: ['uiowner'] });
  const eff = sec.loadSessionSecurity().settingsOwners;
  for (const who of ['uiowner', 'fileowner1', 'fileowner2', 'envowner', 'noainred']) {
    assert.ok(eff.includes(who), `${who} 가 유효 소유자에 포함되어야 함`);
  }
});

test('UI 저장은 파일/환경변수 지정분을 지우지 못한다(잠금 복구 보장)', () => {
  // UI 에서 전혀 다른 계정만 저장해도 서버 파일 지정분은 살아 있어야 한다.
  sec.saveSessionSecurity({ settingsOwners: ['someoneelse'] });
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'security-session.json'), 'utf8'));
  assert.deepEqual(saved.settingsOwners, ['someoneelse'], '파일에는 UI 저장분만 남는다');
  const eff = sec.loadSessionSecurity().settingsOwners;
  assert.ok(eff.includes('fileowner1'));
  assert.ok(eff.includes('envowner'));
  assert.ok(eff.includes('noainred'));
});

test('빈 소유자 저장은 거부(소유자 전멸 방지)', () => {
  assert.throws(() => sec.saveSessionSecurity({ settingsOwners: [] }));
});
