/**
 * Unity 버전 열(v2.585) — 사용자 신고 "스토리지 모니터링에서 Unity 버전명 안나오는거 개선"(2.583 캡처: 18대 전부 `—`).
 *  ① 후보 이미지(Candidate) 버전을 현재 버전이라 말하지 않는다  ② 시도 결과를 열이 말할 수 있게 요약한다
 *  ③ 후보는 셋이고 확인한 명령(svc_diag)이 먼저다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { versionFromUemcli, versionFromSvcDiag, mergeVersionInfo } from '../src/storage/collectors/unityVersion.js';
import { parseUemcli } from '../src/storage/collectors/uemcliParse.js';
import { SPECS, versionAttemptsOf, buildSnapshot } from '../src/storage/collectors/unitySsh.js';

const SOFT_VER = `Storage system address: 127.0.0.1
Storage system port: 443
HTTPS connection

1:    ID           = CAND_1
      Type         = Candidate
      Version      = 5.5.0.0.5.120
      Release date = 2026-01-10

2:    ID           = INST_1
      Type         = Installed
      Version      = 5.4.0.0.5.094
      Release date = 2025-06-01
`;

test('① /sys/soft/ver show — Candidate 가 앞에 와도 Installed 의 버전을 읽는다', () => {
  const v = versionFromUemcli(parseUemcli(SOFT_VER));
  assert.equal(v.version, '5.4.0.0.5.094');
  assert.equal(v.usedKey, 'Version');
  assert.equal(v.source, 'uemcli');
  // Type 이 없는 레코드(예: /sys/general show -detail)는 예전처럼 첫 레코드다
  const g = versionFromUemcli([{ 'System name': 'x', 'Software version': '5.3.0.0.5.001' }]);
  assert.equal(g.version, '5.3.0.0.5.001'); assert.equal(g.usedKey, 'Software version');
  // Candidate 만 있으면 버전을 지어내지 않는다
  const c = versionFromUemcli([{ ID: 'CAND_1', Type: 'Candidate', Version: '9.9.9.9' }]);
  assert.equal(c.version, ''); assert.equal(c.source, null);
});

test('② versionAttemptsOf — 후보별 성공/실패·소요·끊김·앞 160자만(전체 원문은 cliRaw)', () => {
  const raw = [
    { key: 'poolDetail', cmd: 'uemcli /stor/config/pool show -detail', ok: true, sample: 'x', ms: 4000 },
    { key: 'version', cmd: 'svc_diag', ok: false, sample: 'svc_diag: must be run from a terminal\n'.repeat(20), ms: 17_001, timedOut: true },
    { key: 'version', cmd: 'uemcli /sys/general show -detail', ok: false, sample: '1:    System name = U', ms: 3800 },
    { key: 'version', cmd: 'uemcli /sys/soft/ver show', ok: true, sample: SOFT_VER, ms: 4100, answers: { certAccept: 1 } },
  ];
  const a = versionAttemptsOf(raw);
  assert.equal(a.length, 3);
  assert.deepEqual(a.map((x) => [x.cmd, x.ok]), [['svc_diag', false], ['uemcli /sys/general show -detail', false], ['uemcli /sys/soft/ver show', true]]);
  assert.equal(a[0].timedOut, true); assert.equal(a[0].ms, 17_001);
  assert.ok(a[0].head.length <= 160);
  assert.equal(versionAttemptsOf(null).length, 0);
});

test('③ 후보는 셋, svc_diag 가 먼저, 항목별 시한은 기본(45초)보다 짧다', () => {
  const v = SPECS.find((s) => s.key === 'version');
  assert.deepEqual(v.cmds, ['svc_diag', 'uemcli /sys/general show -detail', 'uemcli /sys/soft/ver show']);
  assert.ok(v.timeoutMs < 45_000 && v.timeoutMs >= 15_000);
  assert.ok(!v.required);
  assert.equal(v.accept(SOFT_VER), true, '/sys/soft/ver show 출력을 accept 가 인정한다');
  assert.equal(v.accept('1:    Health state = OK (5)\n'), false, '버전이 없는 출력은 다음 후보로');
});

test('스냅샷 — 세 출처 어느 것이든 version·versionSource 가 채워지고, 못 읽으면 빈 문자열 + 사유', () => {
  const dev = { id: 'st-1', name: 'U', type: 'unity480', host: '10.0.0.1' };
  const s1 = buildSnapshot(dev, { version: SOFT_VER });
  assert.equal(s1.version, '5.4.0.0.5.094'); assert.equal(s1.extra.versionSource, 'uemcli'); assert.equal(s1.extra.versionKey, 'Version');
  const s2 = buildSnapshot(dev, {}, { errors: { version: 'svc_diag: 실행은 됐지만 원하는 값이 없습니다(다음 후보로 넘어감).' } });
  assert.equal(s2.version, ''); assert.match(s2.extra.missingCmds.version, /원하는 값이 없습니다/);
  const merged = mergeVersionInfo(versionFromSvcDiag('* Current Software version: c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL'), versionFromUemcli([]));
  assert.equal(merged.version, '5.4.0.0.5.094');
});
