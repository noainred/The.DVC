import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const tmp = tmpDir('ipam-scan-');
process.env.CONFIG_DIR = tmp;
process.env.IPAM_WRITE_DEBOUNCE_MS = '20'; // 테스트는 짧은 디바운스

let ss, ov;
before(async () => { ss = await import('../src/ipam/scanStore.js'); ov = await import('../src/ipam/overrides.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('mergeScanResults: 잘못된 IP는 무시(키 오염 차단)', () => {
  ss.mergeScanResults([{ ip: 'bad', openPorts: [80], services: ['HTTP'] }, { ip: '10.1.1.1', openPorts: [22], services: ['SSH'] }], Date.now(), 'a1');
  const map = ss.getScanResults();
  assert.ok(map['10.1.1.1']);
  assert.equal(map['bad'], undefined);
  // 오염 키(__proto__ 등)도 isIpv4 검증으로 진입 차단
  ss.mergeScanResults([{ ip: '__proto__', openPorts: [80], services: [] }], Date.now(), 'a1');
  assert.equal(Object.prototype.hasOwnProperty.call(ss.getScanResults(), '__proto__'), false);
});

test('mergeScanResults: 더 오래된 보고가 최신 관측을 덮지 않음(stale guard)', () => {
  const t1 = 10_000, t0 = 5_000;
  ss.mergeScanResults([{ ip: '10.2.2.2', openPorts: [443], services: ['HTTPS'], hostname: 'new' }], t1, 'a1');
  ss.mergeScanResults([{ ip: '10.2.2.2', openPorts: [80], services: ['HTTP'], hostname: 'old' }], t0, 'a2');
  const r = ss.getScanResults()['10.2.2.2'];
  assert.equal(r.hostname, 'new'); // 최신(t1) 유지
  assert.deepEqual(r.openPorts, [443]);
});

test('flushAllNow: 디바운스 중인 변경을 즉시 원자적으로 디스크에 기록', () => {
  ss.mergeScanResults([{ ip: '10.3.3.3', openPorts: [22], services: ['SSH'] }], Date.now(), 'a1');
  ss.flushAllNow();
  const file = path.join(tmp, 'ipam-scan-results.json');
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved['10.3.3.3']);
});

test('sweepReleases: 관리(override) IP의 이력은 보존기간 초과여도 보존, 비관리는 정리', () => {
  ss.mergeScanResults([{ ip: '10.6.6.1', openPorts: [22], services: ['SSH'] }, { ip: '10.6.6.2', openPorts: [22], services: ['SSH'] }], 0, 'a1');
  ov.setOverride('10.6.6.2', { status: 'reserved' }, { username: 'op' }); // 관리 대상
  const farFuture = 400 * 86400000; // 400일 후 → 두 IP 모두 보존기간(365일) 초과
  ss.sweepReleases(1000, { now: farFuture });
  assert.equal(ss.getIpHistory('10.6.6.1'), null, '비관리 IP 이력은 정리됨');
  assert.ok(ss.getIpHistory('10.6.6.2'), '관리 IP 이력은 보존됨');
  ov.clearOverride('10.6.6.2');
});

test('mergeScanResults: 내용 변화 없으면 scanRev 불변(불필요 재계산 방지)', () => {
  ss.mergeScanResults([{ ip: '10.4.4.4', openPorts: [22], services: ['SSH'], hostname: 'h' }], 1000, 'a1');
  const rev = ss.scanRev();
  // 동일 내용 재보고(시각만 증가) → 이력 전이 없음 → rev 불변
  ss.mergeScanResults([{ ip: '10.4.4.4', openPorts: [22], services: ['SSH'], hostname: 'h' }], 2000, 'a1');
  assert.equal(ss.scanRev(), rev);
  // 포트가 바뀌면 rev 증가
  ss.mergeScanResults([{ ip: '10.4.4.4', openPorts: [22, 443], services: ['SSH', 'HTTPS'], hostname: 'h' }], 3000, 'a1');
  assert.ok(ss.scanRev() > rev);
});
