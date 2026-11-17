/**
 * guestDiskAudit68.test.js — 전체 점검 68회차(게스트 디스크 계열 1차: diskbad · guestdisk · guestpart · dirusage · storpath) 확정분 회귀 고정.
 *
 * 변이 검증: 각 테스트는 수정 전 코드로 되돌리면 실패하는 것을 보고 썼다(68회차 기록 참고).
 * 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gdaudit68-'));
process.env.CONFIG_DIR = TMP;
process.env.GUESTDISK_DB_PATH = path.join(TMP, 'gd.db');
process.env.SVCMON_WORKERS = '0';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

// ── F1(낮음): 시각을 모르는 경로 표본은 이력에 넣지 않는다 ─────────────────────────────
test('★ F1: 엣지 정제가 at:null 로 둔 ESXi 경로 표본은 1970년 표본으로 이력에 들어가지 않는다', async () => {
  const { sanitizeHostSpath } = await import('../src/storpath/parse.js');
  const { recordHosts, weightsFor, _resetStorPathHistory } = await import('../src/storpath/history.js');
  _resetStorPathHistory();
  const target = { wwn: '50:00:00:00:00:00:00:01', adapter: 'vmhba1', readKB: 1000, writeKB: 0 };
  const sp = sanitizeHostSpath({ samples: 15, targets: [target] }, NOW);   // at 이 없다(구버전 · 이상한 엣지)
  assert.equal(sp.at, null, '전제: 정제는 못 읽은 시각을 null 로 둔다');
  assert.equal(recordHosts([{ id: 'h1', spath: sp }]), 0, 'Number(null) === 0 이라 1970년 표본으로 넣었다');
  assert.equal(weightsFor('h1'), null, '기간을 모를 때(since 없음) 시각 모르는 표본이 가중치에 섞였다');
  // 시각이 있는 표본은 그대로 들어간다.
  assert.equal(recordHosts([{ id: 'h1', spath: sanitizeHostSpath({ at: NOW - HOUR, samples: 15, targets: [target] }, NOW) }]), 1);
  const w = weightsFor('h1');
  assert.equal(w.samples, 1);
  assert.equal(w.firstAt, NOW - HOUR);
  // 0 · 음수 · 글자도 시각이 아니다.
  for (const at of [0, -5, '', 'x', [], {}]) assert.equal(recordHosts([{ id: 'h2', spath: { at, samples: 1, targets: [target] } }]), 0, `at=${JSON.stringify(at)}`);
  _resetStorPathHistory();
});

// ── F2(중간): 최근 수집에서 여유를 보고하지 않은 파티션을 '축소 후보(사용량 평탄)' 로 권하지 않는다 ────────
test('★ F2: 여유 미보고 파티션(part_latest unknown)은 끝점을 잇지 않고 회수 판단을 하지 않는다 — 값을 읽은 파티션은 그대로', async () => {
  const gd = await import('../src/guestdisk/db.js');
  const svc = await import('../src/guestdisk/service.js');
  const { sanitizeGuestDiskVms } = await import('../src/guestdisk/analyze.js');
  const vm = (parts) => sanitizeGuestDiskVms([{ vmId: 'vc68:vm-1', vmName: 'app01', allocGB: 0, usedGB: 0, parts }])
    .map((v) => ({ ...v, allocGB: v.parts.reduce((a, p) => a + p.capGB, 0), usedGB: v.parts.reduce((a, p) => a + p.usedGB, 0) }));
  const c1 = await gd.commitCollection('vc68', 'VC68', vm([{ path: 'C:\\', capGB: 60, usedGB: 30 }, { path: 'D:\\', capGB: 100, usedGB: 10 }]), { ts: NOW - 20 * DAY });
  if (c1?.ok === false && /sqlite/i.test(String(c1.reason))) return;   // node:sqlite 없는 환경
  assert.equal(c1.ok, true);
  // 보류 시한(수집 주기 × 3) 밖의 다음 수집: D: 가 여유를 보고하지 않았다 → 부분 합 표시(partialShown) — vm_latest 시각이 이번 수집
  const c2 = await gd.commitCollection('vc68', 'VC68', vm([{ path: 'C:\\', capGB: 60, usedGB: 30 }, { path: 'D:\\', capGB: 100, usedGB: null }]), { ts: NOW - DAY });
  assert.equal(c2.partialShown, 1, '전제: 부분 합 행이 이번 시각으로 들어갔다');
  const det = await svc.vmDetail('vc68:vm-1', { days: 30 });
  const d = det.partitions.find((p) => p.path === 'D:\\');
  assert.ok(d, 'D: 는 현재 파티션이다(제거가 아니다)');
  assert.notEqual(d.removed, true);
  assert.notEqual(d.advice?.safe, true, "최근 수집에서 값을 모르는 파티션을 '축소 후보' 로 권했다");
  assert.equal(d.unknownNow, true);
  assert.equal(d.freeGB, null, '값을 모르는 파티션의 여유를 지난 값으로 계산했다');
  assert.equal(d.trend.trend, null, '마지막으로 읽은 값을 최근 수집 시각까지 평탄선으로 이었다');
  assert.equal(d.lastSeenTs, NOW - 20 * DAY);
  // 값을 읽은 C: 는 예전처럼 최근 수집까지 잇는다(안 바뀐 동안 diff 행이 없다 — v2.590 P3).
  const c = det.partitions.find((p) => p.path === 'C:\\');
  assert.equal(c.trend.trend, 'flat');
  assert.equal(c.advice.safe, true);
  // VM 합계도 최근 행이 부분 합이면 잇지 않는다(부분 합은 추이에 넣지 않는다).
  assert.equal(det.partial, true);
  assert.ok(det.vmTrendSeries.every((p) => !p.carried || p.ts !== det.ts), '부분 합 행의 시각까지 VM 합계 추이를 이었다');
});

test('★ F2: 이름 없이 개수만 온 부분 합(구버전 엣지)이면 어느 파티션도 끝점을 잇지 않는다(어느 것이 모르는 값인지 모른다)', async () => {
  const gd = await import('../src/guestdisk/db.js');
  const svc = await import('../src/guestdisk/service.js');
  const whole = [{ vmId: 'vc68b:vm-2', vmName: 'db02', allocGB: 160, usedGB: 40, partCount: 2, parts: [{ path: 'C:\\', capGB: 60, usedGB: 30 }, { path: 'E:\\', capGB: 100, usedGB: 10 }] }];
  const c1 = await gd.commitCollection('vc68b', 'VC68B', whole, { ts: NOW - 20 * DAY });
  if (c1?.ok === false && /sqlite/i.test(String(c1.reason))) return;
  // 구버전 엣지: partsUnknown 만 있고 unknownPaths 가 없다(E: 가 빠졌다).
  const old = [{ vmId: 'vc68b:vm-2', vmName: 'db02', allocGB: 60, usedGB: 30, partCount: 1, partsUnknown: 1, parts: [{ path: 'C:\\', capGB: 60, usedGB: 30 }] }];
  const c2 = await gd.commitCollection('vc68b', 'VC68B', old, { ts: NOW - DAY });
  assert.equal(c2.partialShown, 1);
  const det = await svc.vmDetail('vc68b:vm-2', { days: 30 });
  for (const p of det.partitions) assert.notEqual(p.advice?.safe, true, `${p.path}: 어느 파티션이 값을 모르는지 모르는데 끝점을 이어 '축소 후보' 로 권했다`);
});

// ── F3(낮음): du 출력의 빈 바이트 칸을 0 바이트로 읽지 않는다 ──────────────────────────
test('★ F3: du 바이트 칸이 비었거나 십진 정수가 아니면 0 이 아니라 건너뜀 — 빈 루트 행이 exit 1 의 \'루트 합계 있음\' 으로 통과하지 않는다', async () => {
  const { parseDuOutput, judgeDuResult } = await import('../src/dirusage/scan.js');
  const p = parseDuOutput(' \t/mnt/share/hong\n100\t/mnt/share/kim\n  \t/mnt/share\n', '/mnt/share');
  assert.deepEqual(p.entries, [{ name: 'kim', bytes: 100 }], "빈 바이트 칸을 '0 바이트 폴더' 로 넣었다");
  assert.equal(p.totalBytes, null, '빈 루트 행을 합계 0 으로 읽었다');
  assert.equal(p.skipped, 2, '버린 줄은 조용히 사라지지 않고 센다');
  const odd = parseDuOutput('1e3\t/mnt/share/a\n0x10\t/mnt/share/b\n12.5\t/mnt/share/c\n500\t/mnt/share\n', '/mnt/share');
  assert.equal(odd.entries.length, 0, 'du -b 는 십진 정수만 쓴다 — 지수 · 16진 · 소수를 바이트로 받았다');
  assert.equal(odd.totalBytes, 500);
  const j = judgeDuResult({ ok: false, exitCode: 1, stdout: '100\t/mnt/share/kim\n \t/mnt/share\n' }, '/mnt/share');
  assert.equal(j.ok, false, '루트 합계를 못 읽은 exit 1 결과를 성공으로 받았다');
  // 정상 출력은 그대로.
  const ok = judgeDuResult({ ok: false, exitCode: 1, stdout: '100\t/mnt/share/kim\n0\t/mnt/share/empty\n300\t/mnt/share\n', stderr: 'du: cannot read directory \'/mnt/share/x\': Permission denied\n' }, '/mnt/share');
  assert.equal(ok.ok, true);
  assert.equal(ok.parsed.totalBytes, 300);
  assert.deepEqual(ok.parsed.entries, [{ name: 'kim', bytes: 100 }, { name: 'empty', bytes: 0 }], '진짜 0 바이트 폴더는 0 이다');
  assert.equal(ok.warnings, 1);
});
