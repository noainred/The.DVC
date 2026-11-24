/**
 * dbg3231(2회차) — vm-track 시계열 기억(_seriesMemo · _changeLogMemo)의 범위 서명 scopeKeyOf 가 단사가 아니었다(재현).
 *   예전 `s:${[...scopeIds].sort().join(',')}` — 등록부(vcenter/registry.js normalize)는 id 에 쉼표를 허용하므로
 *   범위 ['KR,Seoul'] 과 ['KR','Seoul'] 이 같은 기억을 받았다 → /api/tools/vm-track · Overview 추이가 범위 밖 vCenter 의 합계와 id 를 내보냈다.
 *   고침: routes/api/shared.js scopeKey 와 같은 꼴 — 's:' + JSON(정렬 배열) · 무제한 '*'.
 * 기준 시각은 Date.now() 가 아니라 자정 경계에서 떨어뜨린 값(CLAUDE.md 테스트 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmtrackKey3231-'));
const rmTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더 */ } };
test.after(() => { rmTmp(); process.once('exit', () => { try { rmTmp(); } catch { /* 종료 중 */ } }); });
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.DATA_SOURCE = 'mock';
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vm-track.db');

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const DAY = 86_400_000;
const BASE = Math.floor(Date.now() / DAY) * DAY - 2 * DAY; // 이틀 전 UTC 자정

const vm = (i, vc) => ({ id: `${vc}:vm-${i}`, name: `vm${i}`, vcenterId: vc, powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, storageGB: 10, host: 'h1', cluster: 'c1' });
const mk = (vc, n) => Array.from({ length: n }, (_, i) => vm(i, vc));

test('vmtrackSeries — 범위 [\'KR,Seoul\'] 이 먼저 채운 기억을 범위 [\'KR\',\'Seoul\'] 이 받지 않는다', async () => {
  const svc = await import('../src/vmtrack/service.js');
  const r = await svc.takeVmSnapshot({
    vcenters: [{ id: 'KR,Seoul', status: 'connected' }, { id: 'KR', status: 'connected' }, { id: 'Seoul', status: 'connected' }],
    vms: [...mk('KR,Seoul', 50), ...mk('KR', 3), ...mk('Seoul', 2)], datastores: [],
  }, { now: new Date(BASE + 1 * 3600_000) });
  assert.ok(r.ok, '스냅샷 적재');
  const A = await svc.vmtrackSeries({ days: 10, scopeIds: new Set(['KR,Seoul']) });
  const B = await svc.vmtrackSeries({ days: 10, scopeIds: new Set(['KR', 'Seoul']) });
  assert.notEqual(B, A, 'B 가 A 의 기억을 그대로 받았다');
  assert.equal(A.points.at(-1)?.total, 50);
  assert.equal(B.points.at(-1)?.total, 5, 'B 에 범위 밖 KR,Seoul 의 합계가 실렸다');
  const ids = JSON.stringify(B);
  assert.ok(!ids.includes('KR,Seoul'), 'B 응답에 범위 밖 vCenter id 가 실렸다');
  // 같은 집합은 순서와 무관하게 같은 기억(쓸데없이 갈라지지 않게)
  const B2 = await svc.vmtrackSeries({ days: 10, scopeIds: new Set(['Seoul', 'KR']) });
  assert.equal(B2, B);
});

test('scopeKeyOf 는 공용 범위 서명(util/scopeSig.js) · series 와 changeLog 기억 둘 다 이 서명을 쓴다(소스)', () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'vmtrack/service.js'), 'utf8'));
  const def = s.match(/const scopeKeyOf = \(scopeIds\) => ([^\n]+)/);
  assert.ok(def, 'scopeKeyOf 정의');
  // v3.23.2: 규칙은 util/scopeSig.js 하나(판정 코어 하나 — 사본을 두지 않는다)
  assert.match(def[1], /^scopeSig\(scopeIds\)/);
  assert.match(s, /import \{ scopeSig \} from '\.\.\/util\/scopeSig\.js'/);
  assert.doesNotMatch(def[1], /\.join\(/);
  assert.match(s, /_seriesMemo\(gen, `[^`]*\$\{scopeKeyOf\(scopeIds\)\}`/);
  assert.match(s, /_changeLogMemo\(gen, `[^`]*\$\{scopeKeyOf\(scopeIds\)\}`/);
});
