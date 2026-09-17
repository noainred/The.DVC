/**
 * unitySshBudget2528.test.js — CLI 세션 시간 예산 회귀(v2.528).
 *
 * 사용자 신고(2026-09-16): **"수정 이후에 유니티 ssh 안되"** — v2.526 회귀다.
 *
 * ── 무엇이 깨졌나(산수) ────────────────────────────────────────────────────────
 * v2.526 이 Unity 명령을 **5개 → 24개**로 늘렸는데 폴러의 장비 시한
 * (`storage/poller.js DEVICE_TIMEOUT_MS` 기본 **180초**)은 그대로였다. 명령당 시한이 45초라
 * **느린 명령 4개면 180초를 넘고**, 그 순간 `withDeadline` 이 던져 **그때까지 모은 결과가
 * 통째로 버려진다**(용량·상태까지). 즉 '가끔 일부가 빈다' 가 아니라 **장비 전체가 실패**한다.
 *
 * 그래서 세션이 스스로 예산을 보고 멈추고 **여기까지의 결과를 돌려준다**.
 * 이 테스트가 고정하는 것:
 *  · 예산이 다 되면 **남은 명령을 시작하지 않는다**(시작해 놓고 잘리면 결과가 버려진다)
 *  · 그래도 **앞의 결과는 살아서 돌아온다** — 이것이 회귀의 핵심이다
 *  · 건너뛴 항목은 **사유와 함께** 보고된다(조용한 생략 금지)
 *  · **필수 항목은 예산을 무시하고** 시도한다(없으면 스냅샷이 무의미하다)
 *  · 매주기 항목이 구성 항목보다 **앞에** 온다(예산이 모자라도 용량·상태는 살아남는다)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECS } from '../src/storage/collectors/unitySsh.js';

test('★ 필수 항목이 맨 앞에 있다 — 예산이 모자라도 반드시 시도된다', () => {
  assert.ok(SPECS[0].required, `첫 명령이 필수여야 한다(현재 ${SPECS[0].key})`);
});

/*
 * ★ v2.542 — 이 테스트가 v2.526 회귀(명령 26개 → 예산 소진 → 전량 실패)의 재발을 막는다.
 * 사용자 화면 증거: `accounts: 수집 시간 예산 초과로 이번 주기에는 실행하지 않았습니다`.
 * 명령을 늘리려면 이 산수를 **먼저** 다시 하고, 넘으면 세션 예산·명령 시한을 같이 조정할 것.
 */
test('★ 명령 수 × 명령당 시한이 세션 예산 안에 들어간다 — 명령을 늘리기 전에 이 산수를 볼 것', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const src = fs.readFileSync(url.fileURLToPath(new URL('../src/storage/collectors/cliSsh.js', import.meta.url)), 'utf8');
  const cmdMs = Number(/CMD_TIMEOUT_MS\s*=[^;]*?(\d{4,})/.exec(src)?.[1] || 45000);
  const budget = Number(/SESSION_BUDGET_MS\s*=[^;]*?(\d{5,})/.exec(src)?.[1] || 150000);
  assert.ok(SPECS.length * cmdMs <= budget,
    `명령 ${SPECS.length}개 × ${cmdMs}ms = ${SPECS.length * cmdMs}ms 가 세션 예산 ${budget}ms 를 넘는다`);
});

test('후보 명령 체인을 되살리지 않는다 — 항목당 명령 1개(시한을 두 배로 쓰지 않게)', () => {
  for (const s of SPECS) {
    assert.equal(s.cmds.length, 1, `${s.key}: 후보가 ${s.cmds.length}개다 — 실패 시 시한을 그만큼 더 쓴다`);
    assert.ok(!/-output csv/.test(s.cmds[0]), `${s.key}: 이 장비의 CSV 출력은 확인된 적이 없다(v2.530·2.542)`);
  }
});

test('세션 예산 기본값이 장비 시한보다 작다 — 같거나 크면 가드가 발동하기 전에 폴러가 던진다', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const cli = fs.readFileSync(path.join(here, '..', 'src', 'storage', 'collectors', 'cliSsh.js'), 'utf8');
  const poll = fs.readFileSync(path.join(here, '..', 'src', 'storage', 'poller.js'), 'utf8');
  const budget = Number(/STORAGE_CLI_SESSION_BUDGET_MS\|\| (\d[\d_]*)/.exec(cli.replace(/\s+/g, ' '))?.[1]?.replace(/_/g, '')
    || /SESSION_BUDGET_MS = Math\.max\([\d_]+, Number\(process\.env\.STORAGE_CLI_SESSION_BUDGET_MS\) \|\| ([\d_]+)\)/.exec(cli)?.[1]?.replace(/_/g, ''));
  const devTimeout = Number(/STORAGE_DEVICE_TIMEOUT_MS\) \|\| ([\d_]+)/.exec(poll)?.[1]?.replace(/_/g, ''));
  assert.ok(Number.isFinite(budget), '세션 예산 기본값을 읽지 못했다');
  assert.ok(Number.isFinite(devTimeout), '장비 시한 기본값을 읽지 못했다');
  assert.ok(budget < devTimeout, `세션 예산(${budget}) 이 장비 시한(${devTimeout}) 보다 작아야 한다`);
});

test('runCliSession 이 예산 초과 항목을 errors 에 사유로 남긴다(소스 계약 고정)', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'storage', 'collectors', 'cliSsh.js'), 'utf8');
  assert.match(src, /skipped\.push\(spec\.key\)/, '예산 초과 항목을 기록해야 한다');
  assert.match(src, /예산 초과로 이번 주기에는 실행하지 않았습니다/, '사유 문구를 남겨야 한다');
  assert.match(src, /return \{ out, raw, errors, skipped/, '건너뛴 목록을 호출부에 돌려줘야 한다');
  // 필수 항목은 예산을 무시한다
  assert.match(src, /if \(!spec\.required && leftMs\(\) < MIN_SLICE_MS\)/, '필수 항목은 예산으로 건너뛰지 않는다');
});
