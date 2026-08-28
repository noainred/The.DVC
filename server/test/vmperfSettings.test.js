// VM 성능 트래킹 설정 검증(v2.376) — 기본값·클램프·대상 판정·저장 왕복.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmperf-cfg-'));
process.env.CONFIG_DIR = tmp;
const m = await import('../src/metrics/vmperfSettings.js');

test('기본값 — 수집 on, 보존 90일, 전체 대상', () => {
  const s = m.loadVmperfSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.retentionDays, 90, '기본 90일(1년=30GB 라 기본으로 두지 않음)');
  assert.deepEqual(s.vcenterIds, [], '빈 배열 = 전체 대상');
  assert.equal(s.trackTotal, true);
});

test('보존기간 클램프 — 음수/초과/문자 방어', () => {
  assert.equal(m.saveVmperfSettings({ retentionDays: -5 }).retentionDays, 0, '음수 → 0(무제한)');
  assert.equal(m.saveVmperfSettings({ retentionDays: 99999 }).retentionDays, 1830, '상한 5년');
  assert.equal(m.saveVmperfSettings({ retentionDays: 'abc' }).retentionDays, 0, '문자 → 0');
  assert.equal(m.saveVmperfSettings({ retentionDays: 45.9 }).retentionDays, 45, '소수 내림');
});

test('vcenterIds — 중복/공백 제거, 비배열 방어', () => {
  const s = m.saveVmperfSettings({ vcenterIds: ['vc-a', 'vc-a', ' vc-b ', '', null] });
  assert.deepEqual(s.vcenterIds, ['vc-a', 'vc-b']);
  assert.deepEqual(m.saveVmperfSettings({ vcenterIds: 'nope' }).vcenterIds, [], '비배열 → 빈 배열');
});

test('vmperfTracks — 대상 판정', () => {
  m.saveVmperfSettings({ enabled: true, vcenterIds: [] });
  assert.equal(m.vmperfTracks('anything'), true, '빈 목록이면 전체 대상');
  m.saveVmperfSettings({ vcenterIds: ['vc-a'] });
  assert.equal(m.vmperfTracks('vc-a'), true);
  assert.equal(m.vmperfTracks('vc-b'), false, '선택 밖은 수집 안 함');
  m.saveVmperfSettings({ enabled: false });
  assert.equal(m.vmperfTracks('vc-a'), false, '비활성이면 전부 false');
});

test('저장 파일이 0600 으로 생성된다', () => {
  m.saveVmperfSettings({ enabled: true });
  const f = path.join(tmp, 'vmperf.json');
  assert.ok(fs.existsSync(f));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  }
});
