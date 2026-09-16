/**
 * unityCsvOrder2529.test.js — uemcli 후보 순서 회귀(v2.529).
 *
 * 사용자 신고(2026-09-16, 화면 실측 OC2-41.237 · 중앙 SSH 수집):
 *   `capacity: 오류: 풀 출력에서 용량 필드를 인식하지 못했습니다`
 *   `config: 건너뜀` · `pools: 오류` · **`alerts: OK`**
 * 같은 세션에서 alerts 는 정상이었으므로 SSH·명령 실행은 멀쩡했고 **파싱만** 실패했다.
 *
 * ── 원인 ───────────────────────────────────────────────────────────────────────
 * v2.526 이 사용자 캡처(`pool -detail` 평문)를 보고 **평문 `-detail` 을 첫 후보로** 바꿨다.
 * v2.525 는 `-output csv` 가 첫 후보였고 잘 돌았다. `recordsFor` 는 CSV 를 훨씬 안정적으로
 * 읽는다 — 평문 `-detail` 은 `N:` 접두 + `Key = Value` 라 레코드 경계가 장비/버전마다 다르다.
 *
 * 이 테스트는 **첫 후보가 CSV 인지**를 고정한다. 평문을 앞에 두면 회귀가 그대로 재발한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { specsFor } from '../src/storage/collectors/unitySsh.js';

const uemcliSpecs = () => specsFor({ deep: true, configRound: true })
  .filter((s) => (s.cmds || []).some((c) => c.startsWith('uemcli ')));

test('★ 모든 uemcli 항목의 첫 후보는 `-output csv` 다(v2.526 회귀 방지)', () => {
  const bad = uemcliSpecs().filter((s) => !/^uemcli -output csv /.test(s.cmds[0]));
  assert.deepEqual(bad.map((s) => `${s.key}: ${s.cmds[0]}`), [],
    '평문 -detail 을 첫 후보로 두면 풀·시스템 파싱이 실패한다(현장 실측)');
});

test('평문 후보는 지우지 않고 뒤에 남긴다 — CSV 를 지원하지 않는 항목 대비', () => {
  for (const s of uemcliSpecs()) {
    assert.ok(s.cmds.length >= 2, `${s.key}: 후보가 하나뿐이면 폴백이 없다`);
    assert.ok(s.cmds.some((c) => !/-output csv/.test(c)), `${s.key}: 평문 폴백이 있어야 한다`);
  }
});

test('필수·매주기 항목이 앞에 오는 순서는 그대로다(v2.528 예산 계약)', () => {
  const all = specsFor({ deep: true, configRound: true });
  assert.equal(all[0].required, true, '필수(system)가 첫 명령');
  const lastAlways = all.map((s) => s.when).lastIndexOf('always');
  const firstConfig = all.findIndex((s) => s.when === 'config');
  assert.ok(firstConfig > lastAlways, 'always 가 전부 config 앞에 와야 한다');
});

test('svc_diag 는 uemcli 가 아니므로 CSV 규칙 대상이 아니다', () => {
  const sp = specsFor({ deep: true, configRound: true }).find((s) => s.key === 'spinfo');
  assert.equal(sp.bin, 'svc_diag');
  assert.deepEqual(sp.cmds, ['svc_diag -s spinfo']);
});
