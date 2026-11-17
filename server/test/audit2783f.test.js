// v2.783 — 새 항목 id 를 시각만으로 만들면 같은 밀리초의 두 생성이 겹쳐, 새 항목이 기존 항목의 '수정' 이 되어 이전 값을 물려받았다
//   (CI 빠른 러너에서 audit2600e LO2600-03 이 새 모니터에 [1440, 30, 5000] 을 받은 원인). Date.now 를 고정해 같은 밀리초를 재현한다.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const TMP = tmpDir('audit2783f-');
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;

test('캡처 모니터 — 같은 밀리초에 만든 두 새 항목은 id 가 다르고 둘째는 기본값', async () => {
  const { saveMonitor } = await import('../src/net/monitor.js');
  const t = mock.method(Date, 'now', () => 1_800_000_000_000);
  try {
    const a = saveMonitor({ name: 'm', enabled: false, intervalMin: 1440, seconds: 30, maxPackets: 5000 });
    const c = saveMonitor({ name: 'n', enabled: false, intervalMin: '', seconds: '', maxPackets: '' });
    assert.notEqual(a.id, c.id);
    assert.deepEqual([c.intervalMin, c.seconds, c.maxPackets], [10, 10, 1000]);
  } finally { t.mock.restore(); }
});

test('게스트 로그인 스캔 — 같은 밀리초에 만든 두 새 항목은 id 가 다르고 둘째는 기본값', async () => {
  const { saveGuestScan } = await import('../src/security/guestScanScheduler.js');
  const t = mock.method(Date, 'now', () => 1_800_000_000_000);
  try {
    const a = saveGuestScan({ name: 'g', vcenterId: 'vc1', intervalMin: 1440, days: 30, maxVms: 500, enabled: false });
    const c = saveGuestScan({ name: 'new', vcenterId: 'vc1', intervalMin: '', days: '', maxVms: '', enabled: false });
    assert.notEqual(a.id, c.id);
    assert.deepEqual([c.intervalMin, c.days, c.maxVms], [60, 7, 100]);
  } finally { t.mock.restore(); }
});
