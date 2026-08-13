/**
 * 성능점검 라우트 공용 헬퍼 — routes/svcmon.js(구 1,053줄) 분할(v2.291.0). 본문은 원본 그대로 이동.
 *
 * ⚠️ dryRunTargets 는 transfer.js(/targets/import)와 generate.js(/targets/generate)가 공유하는
 * 유일한 교차 함수다 — 각 모듈로 복사하면 용량 판정(judgeCapacity·suggestIntervalSec)·표본 절단
 * (앞20+뒤5+건너뜀10) 로직이 갈라진다. 반드시 여기 1곳만 유지할 것(CLAUDE.md 의
 * 'ipam/record.js 컬럼 정의 복제 금지' 교훈과 동일 패턴).
 *
 * 컴팩트 후 이어받기 메모: 이 디렉터리는 routes/api/(v2.283)·routes/admin/(v2.285) 분할과 같은
 * 규약이다 — 원 경로(routes/svcmon.js)가 셸로 남아 register*(router) 를 원본 정의 순서대로 호출한다.
 */

import { requireRole } from '../../auth/auth.js';
import { listTargets, planBulkTargets } from '../../svcmon/store.js';
import { judgeCapacity, suggestIntervalSec } from '../../svcmon/capacity.js';

// 조회는 로그인 사용자, 변경은 admin/operator(CLAUDE.md RBAC 불변조건). 전 모듈이 이 두 게이트를 공유.
export const canEdit = requireRole('admin', 'operator');
export const adminOnly = requireRole('admin');

// XLSX 가져오기 디코딩 크기 상한(압축폭탄 완화). 정상 2,000행 xlsx 는 1MB 미만.
export const XLSX_MAX_BYTES = Number(process.env.SVCMON_XLSX_MAX_BYTES) || 8_000_000;

/**
 * 커밋 없이 판정만 — 미리보기와 실제 등록이 **같은 검증 코드**(planBulkTargets)를 쓴다.
 * 표본은 앞 20 + 뒤 5 + 건너뜀 10 만 내려보낸다(2,000행 전량을 보내면 응답이 수 MB 이고
 * 화면 표는 전 행을 DOM 에 렌더한다).
 */
export function dryRunTargets(list) {
  const plan = planBulkTargets(list);
  // 저장소는 입력 순번(1..N)으로 행을 세지만, CSV 가져오기에서는 그 순번이 **원본 행 번호와
  // 다르다**(한 대상이 여러 행에서 묶이므로). csvio 가 붙여 둔 _row 로 되돌린다 —
  // 섞인 채로 내보내면 사용자가 오류 줄을 파일에서 찾을 수 없다.
  const srcRow = (n) => (n && list[n - 1] && list[n - 1]._row) || n;
  const addedTests = [];
  for (const { target } of plan.prepared) for (const x of target.tests) addedTests.push(x);
  const current = [];
  for (const t of listTargets()) {
    if (t.enabled === false) continue;
    for (const x of t.tests) current.push(x);
  }
  const capacity = judgeCapacity({ tests: current, addedTests });
  if (capacity.verdict !== 'ok') {
    capacity.suggestIntervalSec = suggestIntervalSec(plan.after.tests, capacity.workers);
  }
  const row = (p, verdict) => ({
    verdict,
    row: srcRow(p.row),
    kind: p.target.kind,
    path: p.target.path,
    name: p.target.name,
    host: p.target.host,
    enabled: p.target.enabled !== false,
    tests: p.target.tests.length,
    testSummary: p.target.tests.slice(0, 4).map((x) => `${x.type}${x.port ? `:${x.port}` : ''}`).join(', ')
      + (p.target.tests.length > 4 ? ` +${p.target.tests.length - 4}` : ''),
    newFolders: p.folders.length,
  });
  const head = plan.prepared.slice(0, 20).map((p) => row(p, 'create'));
  const tail = plan.prepared.length > 25 ? plan.prepared.slice(-5).map((p) => row(p, 'create')) : [];
  const skips = plan.skipped.slice(0, 10).map((s) => ({ verdict: 'skip', ...s, row: srcRow(s.row) }));
  return {
    create: plan.prepared.length,
    skip: plan.skipped.length,
    errors: [
      ...plan.errors.map((e) => ({ ...e, row: srcRow(e.row) })),
      ...plan.over.map((reason) => ({ row: 0, name: '', reason })),
    ],
    newFolders: plan.newFolders,
    newTests: plan.newTests,
    before: plan.before,
    after: plan.after,
    capacity,
    sample: [...head, ...tail, ...skips],
    truncatedSample: plan.prepared.length > 25 || plan.skipped.length > 10,
  };
}
