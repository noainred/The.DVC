/**
 * v2.501 — '대기 3초 이상이면 무슨 작업인지 보여준다' 의 서버측 설정 회귀 고정.
 *
 * 문턱을 **화면에 하드코딩하지 않는다**(루트 CLAUDE.md 프론트 회귀 방지). 서버가 값을 주고
 * 브라우저가 그것을 쓰므로, 저장·클램프·빈 값 처리가 깨지면 화면 문구가 사실과 달라진다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-progress2501-'));

let SET;
before(async () => { SET = await import('../src/perf/settings.js'); });

test('기본값은 3초 — 사용자가 요구한 문턱', () => {
  assert.equal(SET.DEFAULTS.clientDetailMs, 3_000);
  assert.equal(SET.LIMITS.clientDetailMs.min, 1_000);
  assert.equal(SET.LIMITS.clientDetailMs.max, 60_000);
});

test('저장은 범위로 클램프하고, 빈 값은 미지정으로 버린다(최소값 승격 금지)', () => {
  const a = SET.savePerfSettings({ ...SET.DEFAULTS, clientDetailMs: 10 });
  assert.equal(a.clientDetailMs, 1_000, '하한으로 클램프');
  const b = SET.savePerfSettings({ ...SET.DEFAULTS, clientDetailMs: 999_999 });
  assert.equal(b.clientDetailMs, 60_000, '상한으로 클램프');
  const c = SET.savePerfSettings({ clientDetailMs: 5_000 });
  assert.equal(c.clientDetailMs, 5_000);
  // 빈 문자열은 '미지정' 이다 — 최소값으로 굳으면 모든 요청에 진행 표시가 뜬다.
  const d = SET.savePerfSettings({ clientDetailMs: '' });
  assert.equal(d.clientDetailMs, 5_000, '빈 값은 직전 값을 유지해야 한다');
});

test('저장한 값이 다시 로드된다(파일 왕복)', () => {
  SET.savePerfSettings({ clientDetailMs: 7_000 });
  assert.equal(SET.loadPerfSettings().clientDetailMs, 7_000);
});
