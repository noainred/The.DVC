// ICMP ping 병행 스캔(v2.359) — 인자 생성(플랫폼별)과 설정 기본값을 고정한다.
// pingHost 자체는 시스템 ping 바이너리·네트워크 의존이라 단위테스트하지 않는다(환경 비결정).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pingArgs, pingHost } from '../src/ipam/scan.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-ping-'));
process.env.CONFIG_DIR = tmp;
process.env.IPAM_WRITE_DEBOUNCE_MS = '20';

let ss;
before(async () => { ss = await import('../src/ipam/scanStore.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('pingArgs: 플랫폼별 1회 송신 + 타임아웃 인자', () => {
  // Windows: -w 는 ms.
  assert.deepEqual(pingArgs('10.0.0.1', 700, 'win32'), ['-n', '1', '-w', '700', '10.0.0.1']);
  assert.deepEqual(pingArgs('10.0.0.1', 50, 'win32'), ['-n', '1', '-w', '100', '10.0.0.1']); // 하한 100ms
  // Linux: -W 는 초(정수, 올림, 최소 1).
  assert.deepEqual(pingArgs('10.0.0.1', 700, 'linux'), ['-c', '1', '-W', '1', '10.0.0.1']);
  assert.deepEqual(pingArgs('10.0.0.1', 2500, 'linux'), ['-c', '1', '-W', '3', '10.0.0.1']);
});

test('pingHost: 잘못된 IP 형식은 실행 없이 false(인자 오염 차단)', async () => {
  assert.equal(await pingHost('bad; rm -rf /', 100), false);
  assert.equal(await pingHost('__proto__', 100), false);
  assert.equal(await pingHost('999.1.1.1', 100), false);
});

test('스캔 설정: ping 기본 켜짐 · false 저장 시 유지', () => {
  assert.equal(ss.loadScanSettings().ping, true); // 기존 설정 파일(ping 키 없음)도 기본 켜짐
  ss.saveScanSettings(ss.LOCAL, { ping: false });
  assert.equal(ss.loadScanSettings().ping, false);
  ss.saveScanSettings(ss.LOCAL, { ping: true });
  assert.equal(ss.loadScanSettings().ping, true);
});
