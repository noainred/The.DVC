// v2.733 점검 3회차 그룹 j — C6-02: IP 스캔 '상태'·'설정' 화면이 **2초마다** 부르는 scanInfo() 가 lastSeen 최댓값 하나를 위해
//   스캔 결과 전량(상한 262,144)을 Object.values 로 훑었다(20만 p50 약 200ms — 화면 하나가 열려 있으면 이벤트 루프의 약 10%).
//   이제 최댓값을 적재·정리 시점에 유지한다(로드 정제 · merge · 부분 결과 merge · prune). ⚠ 성능 수정이므로 값이 예전 훑기와 같아야 한다 —
//   각 단계마다 옛 구현(전량 훑기)을 이 파일에서 다시 계산해 대조한다. scanRev() 로 기억하면 lastSeen 만 전진한 보고에서 틀린다(②).
//  ⚠ CONFIG_DIR·결과 파일은 import 전에 고정한다(scanStore 가 모듈 로드 때 읽는다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733j-scaninfo-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000'; // 이 테스트 동안 큰 결과 맵을 디스크에 다시 쓰지 않게

const N = 150_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000; // 정시 -30분(경계에서 떨어뜨린 고정 기준 — v2.517 규약)
const DAY = 86_400_000;
const ipOf = (i) => `10.${60 + ((i >> 16) & 15)}.${(i >> 8) & 255}.${i & 255}`;
const PEAK_IP = ipOf(77_777);
const PEAK_TS = NOW - 2 * DAY;          // 로드 시점의 최댓값(모두 40일 이상 지난 값 사이에 하나만 2일 전)
const MANAGED_IP = ipOf(12_345);        // 관리 IP — 오래돼도 prune 에서 남는다
const MANAGED_TS = NOW - 90 * DAY;

(function seed() {
  const results = {};
  for (let i = 0; i < N; i++) {
    const ip = ipOf(i);
    // 대부분 40~100일 전 · 일부는 lastSeen 이 없거나(0) 음수·문자열(정제가 숫자로 좁힌다)
    let lastSeen = NOW - (40 + (i % 60)) * DAY - (i % 997) * 1000;
    if (i % 5003 === 0) lastSeen = undefined;
    if (i % 7001 === 0) lastSeen = -5;
    if (i % 9001 === 0) lastSeen = String(NOW - 50 * DAY);
    results[ip] = { ip, openPorts: [22], services: ['ssh'], hostname: '', lastSeen, agent: `edge-${i % 7}` };
  }
  results[PEAK_IP].lastSeen = PEAK_TS;
  results[MANAGED_IP].lastSeen = MANAGED_TS;
  fs.writeFileSync(path.join(tmp, 'ipam-scan-results.json'), JSON.stringify(results));
})();

let ss, ov;
before(async () => {
  ss = await import('../src/ipam/scanStore.js');
  ov = await import('../src/ipam/overrides.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/** 옛 구현(v2.732 scanInfo 본문 그대로) — 결과 전량을 훑어 lastSeen 최댓값. */
function oldLastSeen() {
  let lastSeen = 0;
  for (const r of Object.values(ss.getScanResults())) if ((r.lastSeen || 0) > lastSeen) lastSeen = r.lastSeen || 0;
  return lastSeen || null;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

test('① 로드 직후 — 마지막 관측이 옛 훑기와 같다(결측·음수·문자열 정제 포함)', () => {
  assert.equal(Object.keys(ss.getScanResults()).length, N);
  const info = ss.scanInfo();
  assert.equal(info.lastSeen, oldLastSeen());
  assert.equal(info.lastSeen, PEAK_TS);
  assert.equal(info.count, N);
});

test('② 2초 폴링 비용 — scanInfo 는 결과 수에 비례하지 않는다(옛 훑기 대비)', () => {
  const tOld = []; const tNew = [];
  for (let k = 0; k < 7; k++) {
    let t = performance.now(); oldLastSeen(); tOld.push(performance.now() - t);
    t = performance.now(); ss.scanInfo(); tNew.push(performance.now() - t);
  }
  const o = median(tOld); const n = median(tNew);
  assert.ok(o > 3, `비교 기준(전량 훑기 ${o.toFixed(2)}ms)이 너무 작다 — 표본을 키울 것`);
  assert.ok(n < o / 10, `scanInfo ${n.toFixed(2)}ms 가 전량 훑기 ${o.toFixed(2)}ms 의 1/10 이상이다 — 요청마다 결과를 훑는다`);
});

test('③ merge — 새 IP · 덮어쓰기 · 더 오래된 보고(무시) · 부분 결과(마지막 확인만 전진, scanRev 불변)마다 옛 훑기와 같다', () => {
  const t1 = NOW - DAY;
  ss.mergeScanResults([{ ip: '10.90.0.1', openPorts: [22] }], t1, 'edge-x');
  assert.equal(ss.scanInfo().lastSeen, t1);
  assert.equal(ss.scanInfo().lastSeen, oldLastSeen());
  // 더 오래된 보고는 최댓값을 내리지 않는다
  ss.mergeScanResults([{ ip: '10.90.0.1', openPorts: [22] }, { ip: '10.90.0.2', openPorts: [80] }], NOW - 3 * DAY, 'edge-y');
  assert.equal(ss.scanInfo().lastSeen, oldLastSeen());
  assert.equal(ss.scanInfo().lastSeen, t1);
  // 부분 결과 — 이미 있는 IP 의 마지막 확인만 전진한다(내용 변화 없음 → scanRev 가 오르지 않는다: scanRev 로 기억하면 여기서 틀린다)
  const rev = ss.scanRev();
  const t2 = NOW - 60_000;
  ss.mergeScanResults([{ ip: '10.90.0.1', openPorts: [22] }], t2, 'edge-x', { seenOnly: true });
  assert.equal(ss.scanRev(), rev, '테스트 전제 — lastSeen 만 전진한 보고는 scanRev 를 올리지 않는다');
  assert.equal(ss.scanInfo().lastSeen, t2, 'lastSeen 만 전진한 보고가 마지막 관측에 반영되지 않았다');
  assert.equal(ss.scanInfo().lastSeen, oldLastSeen());
  // 같은 내용의 일반 보고(내용 변화 없음 · lastSeen 만 전진)
  const t3 = NOW - 30_000;
  ss.mergeScanResults([{ ip: '10.90.0.2', openPorts: [80] }], t3, 'edge-y');
  assert.equal(ss.scanInfo().lastSeen, t3);
  assert.equal(ss.scanInfo().lastSeen, oldLastSeen());
});

test('④ prune — 남은 항목으로 다시 계산한다(관리 IP 는 오래돼도 남는다 · 전부 지워지면 null)', () => {
  // 최근 항목(10.90.0.x)을 지우기 위해 그 둘을 아주 오래된 값으로 덮을 수는 없으므로(merge 는 되돌리지 않는다) 보존일을 0.0001일로 둔다:
  //   cut = 지금 - 8.64초 → 지금 이전 값은 전부 지워지고 관리 IP 만 남는다.
  assert.equal(ov.setOverride(MANAGED_IP, { owner: '관리' }, { username: 't' }).ok, true);
  ss.pruneScanResults(0.0001);
  const left = Object.keys(ss.getScanResults());
  assert.deepEqual(left, [MANAGED_IP], `관리 IP 만 남아야 한다(${left.length}개)`);
  assert.equal(ss.scanInfo().lastSeen, MANAGED_TS, '지워진 최댓값이 남았거나 0 이 됐다 — 남은 관리 IP 의 마지막 관측이어야 한다');
  assert.equal(ss.scanInfo().lastSeen, oldLastSeen());
  assert.equal(ss.scanInfo().count, 1);
  // 관리 해제 후 다시 정리하면 0건 → null
  ov.clearOverride(MANAGED_IP);
  ss.pruneScanResults(0.0001);
  assert.equal(Object.keys(ss.getScanResults()).length, 0);
  assert.equal(ss.scanInfo().lastSeen, null);
  assert.equal(oldLastSeen(), null);
  // 비운 뒤 새 보고
  ss.mergeScanResults([{ ip: '10.91.0.1', openPorts: [22] }], NOW, 'edge-z');
  assert.equal(ss.scanInfo().lastSeen, NOW);
  assert.equal(ss.scanInfo().lastSeen, oldLastSeen());
});
