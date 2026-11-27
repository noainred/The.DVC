/**
 * 2026-11-26 — 설정 폴더에 쓰던 시험 12개는 **파일 자체로도** 실제 설정 폴더(`server/config`)에 쓰지 않는다(목록 고정).
 *
 * `npm test` 는 미리 불러오기(`test/_isolateConfig.js` — isolateConfig.test.js 가 고정)로 시험 파일마다 임시 설정 폴더를 준다. 그러나 그것은
 * `--import` 를 붙였을 때만이다 — `node --test test/x.test.js` 로 직접 돌리면 설정이 기본 폴더(실제 `server/config`)로 풀린다. 전량 실행 뒤 남던
 * 시험 데이터 12종을 실제로 쓰던 시험을 귀속해(fs · node:sqlite 쓰기를 가로채 시험 파일 이름과 함께 적는 preload 로 전량 1회 → 파일별 단독 실행으로 확정)
 * 파일 맨 위에서 CONFIG_DIR 을 임시 폴더로 잡도록 고쳤다. 이 시험은 그 12개가 되돌아가지 않게 고정한다:
 *  · 최상위에서 `process.env.CONFIG_DIR = …` 로 잡는다(물려받는 `process.env.CONFIG_DIR || …` 꼴이 아니다 — 셸의 실제 설치본 폴더를 이어받는다).
 *  · `../src/` 를 **정적 import 하지 않는다** — 정적 import 는 호이스팅돼 본문의 대입보다 먼저 돈다(gpuGuestIpOverride 가 그렇게 샜다).
 *  · 첫 `../src/` 동적 import 가 그 대입보다 뒤다 · 임시 폴더는 after 에서 지운다(tmpCleanup3188 꼴).
 * 상세 · 찾는 법: docs/rules/common.md '설정에 쓰는 시험은 파일 자체도 …'. ⚠ 소스 검사는 주석을 먼저 제거한다(test/_stripComments.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 괄호 안은 그 파일이 실제 `server/config` 에 쓰던 것(2026-11-26 실측).
const FIXED = `
arch2583.test.js
bmUsage2550.test.js
datacenterStore.test.js
edgeLog2549.test.js
fleetStores.test.js
gpuGuestIpOverride.test.js
hangClear2560.test.js
hwExport2967.test.js
pingMonitor.test.js
rebut71.test.js
roomTempCycle2634.test.js
storageAuthGuard2528.test.js
`.split(/\s+/).filter(Boolean);
// arch2583(auth-secret) · bmUsage2550(auth-secret · bm-usage.db) · datacenterStore(datacenters.json) · edgeLog2549(auth-secret · vcenter-logs.db) ·
// fleetStores(fleet-assign.json · fleet-tags.json) · gpuGuestIpOverride(gpu-guest.json — 정적 import 가 대입보다 먼저 돌았다) ·
// hangClear2560(perf-hangs.ndjson 을 쓰고 지움) · hwExport2967(auth-secret · audit.ndjson · idrac-power.db) · pingMonitor(ping-targets.json · ping-monitor.db) ·
// rebut71(vcenter-logs.db — R3 의 대입이 앞 R2 가 굳힌 config.js 에 닿지 않았다) · roomTempCycle2634(part-faults.db · vcenter-logs.db) ·
// storageAuthGuard2528(storage-auth-stops.json 을 쓰고 지움).

test('목록이 비지 않았고 전부 실제 시험 파일이다', () => {
  assert.equal(FIXED.length, 12);
  assert.equal(new Set(FIXED).size, FIXED.length, '목록에 중복이 있다');
  const missing = FIXED.filter((f) => !fs.existsSync(path.join(HERE, f)));
  assert.deepEqual(missing, [], `없는 파일(지웠거나 이름이 바뀌었다면 목록도 고칠 것): ${missing.join(', ')}`);
});

test('고친 파일은 프로젝트 모듈을 부르기 전에 CONFIG_DIR 을 임시 폴더로 잡고, 끝나면 지운다', () => {
  const bad = [];
  for (const f of FIXED) {
    const s = stripComments(fs.readFileSync(path.join(HERE, f), 'utf8'));
    const set = s.search(/^process\.env\.CONFIG_DIR = (?!process\.env\.CONFIG_DIR)/m);
    const firstSrc = s.search(/from '\.\.\/src\/|import\(\s*['`]\.\.\/src\/|import\(\s*f\)|import\(\s*path\.|import\(\s*pathToFileURL/);
    if (set < 0) { bad.push(`${f}(CONFIG_DIR 을 최상위에서 잡지 않는다)`); continue; }
    if (/^(?:import [^\n]*|\} )from '\.\.\/src\//m.test(s)) { bad.push(`${f}(src 정적 import — 호이스팅돼 CONFIG_DIR 보다 먼저 돈다)`); continue; }
    if (firstSrc >= 0 && firstSrc < set) bad.push(`${f}(src import 가 ${firstSrc} < CONFIG_DIR ${set})`);
    if (!/^(?:test\.)?after\(\(\) => \{ rmTmpDirs\(\);/m.test(s)) bad.push(`${f}(임시 폴더를 after 에서 지우지 않는다 — tmpCleanup3188 꼴)`);
  }
  assert.deepEqual(bad, [], bad.join(', '));
});
