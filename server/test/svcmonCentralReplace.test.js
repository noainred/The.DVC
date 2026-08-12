import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// svcmon/store.js 는 import 시점 CONFIG_DIR 을 쓴다 → 격리 임시 디렉터리 지정 후 로드.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-central-replace-'));
process.env.CONFIG_DIR = TMP;

const store = await import('../src/svcmon/store.js');

const CENTRAL_PREFIX = 'central:';
// path 는 SAFE_PATH(빈 문자열 불가·'\' 구분)를 통과해야 한다 — 폴더 1단계('중앙')로 둔다.
const mkTargets = (names) => names.map((n) => ({ name: n, kind: 'infra', path: '중앙', host: '10.1.2.3', tests: [{ name: 'alive', type: 'ping', intervalSec: 60 }] }));

// v2.279 회귀 방지 — 엣지 정의 pull 의 '멱등 교체' 핵심 메커니즘을 store 레벨로 검증한다.
// 과거: 직전 태그만 삭제 → 재시작(전문 재수신)·세대 누락 시 현/구 세대가 남아 dedup 으로
// 전부 skip(added=0) → 중앙이 mismatch 로 영구 고착. 수정: central: 접두 배치를 전부 지우고
// 새로 등록 → added=전체 수(멱등).

test('직전 태그만 삭제(구식)하면 재시작 시 dedup 으로 added=0 (버그 재현)', () => {
  store._resetCache();
  // 1세대 배포.
  const a1 = store.bulkAddTargets(mkTargets(['svc-a', 'svc-b']), { batch: 'central:sig1', dedup: true });
  assert.equal(a1.added, 2);
  // '엣지 재시작 후 같은 세대 전문 재수신' — 구식 로직은 prevTag(없음)만 지우고 같은 태그로 재등록.
  const del = store.deleteTargetsByBatch('central:sig0'); // 직전(없는) 태그
  assert.equal(del.removed, 0);
  const a2 = store.bulkAddTargets(mkTargets(['svc-a', 'svc-b']), { batch: 'central:sig1', dedup: true });
  assert.equal(a2.added, 0, '이름 중복 dedup 으로 전부 skip → added=0 (과거 mismatch 고착의 원인)');
});

test('central: 접두 배치 전부 삭제 후 재등록 = added 전체 수(멱등) · 사용자 배치는 보존', () => {
  store._resetCache();
  // 사용자가 직접 만든 배치(다른 접두) + 중앙 1세대.
  store.bulkAddTargets(mkTargets(['user-x']), { batch: 'import:20260812', dedup: true });
  store.bulkAddTargets(mkTargets(['svc-a', 'svc-b']), { batch: 'central:sig1', dedup: true });

  // 멱등 교체(수정된 pull 로직과 동일): central: 접두 배치를 전부 지우고 새 세대 등록.
  const applyCentral = (targets, tag) => {
    let removed = 0;
    for (const b of [...store.batchCounts().keys()].filter((k) => k.startsWith(CENTRAL_PREFIX))) {
      removed += store.deleteTargetsByBatch(b).removed || 0;
    }
    const r = store.bulkAddTargets(targets, { batch: tag, dedup: true });
    return { removed, added: r.added, committed: r.committed };
  };

  // (1) 재시작: 같은 세대(sig1) 재적용 → 전부 지우고 다시 넣어 added=2 (과거엔 0).
  const r1 = applyCentral(mkTargets(['svc-a', 'svc-b']), 'central:sig1');
  assert.equal(r1.removed, 2);
  assert.equal(r1.added, 2, '멱등 재적용은 added=전체 수여야 중앙이 active 로 전이한다');

  // (2) 세대 2개 건너뛴 새 정의(sig3) — 남아있던 sig1 을 전부 지우고 새 목록 등록.
  const r2 = applyCentral(mkTargets(['svc-a', 'svc-c', 'svc-d']), 'central:sig3');
  assert.equal(r2.removed, 2);
  assert.equal(r2.added, 3);

  // 최종 상태: central 대상은 sig3 의 3개, 사용자 배치(user-x)는 그대로 보존.
  const all = store.listTargetsCopy();
  const centralNames = all.filter((t) => String(t.batch).startsWith(CENTRAL_PREFIX)).map((t) => t.name).sort();
  assert.deepEqual(centralNames, ['svc-a', 'svc-c', 'svc-d']);
  assert.ok(all.some((t) => t.name === 'user-x' && t.batch === 'import:20260812'), '사용자 배치는 건드리지 않는다');
});
