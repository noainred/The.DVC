/**
 * 성능점검 상태/진단/새로고침/flush — routes/svcmon.js(구 1,053줄) 분할(v2.291.0). 본문은 원본 그대로,
 * 등록 순서는 셸(routes/svcmon.js)의 register 호출 순서가 보존한다.
 *
 * 고부하 대응(원본 헤더에서 이관):
 * - `/state` 는 10만 항목까지 커질 수 있으므로 **트리 경로 기준 페이징**을 지원한다
 *   (`?path=&limit=`). 요약 카운트는 전체 기준으로 따로 계산해 내려준다.
 * - 응답은 res.json 래퍼가 ETag/304 를 처리하므로 무변동 폴링은 본문 0바이트다.
 *
 * ⚠️ /flush 위치 메모(순수 이동의 유일한 순서 변화 — 증명된 무해):
 * 원본에서 POST /flush 는 파일 맨 끝(1053행)에 등록됐지만, 도메인상 store 운영 기능이라 이
 * 모듈로 옮겼다(등록 순서가 뒤→앞으로 당겨짐). 이 라우터에는 최상위 1세그먼트 param 라우트가
 * 하나도 없어(전부 리터럴: /state /diag /refresh /folders /targets /templates /assign /edges
 * /log /flush …) 리터럴끼리는 겹칠 수 없으므로 등록 순서 변화가 매칭 결과를 바꾸지 않는다.
 * (순서가 실제로 의미 있는 쌍은 /targets/export.csv → /targets/export.:format 하나뿐이며
 * transfer.js 안에서 원본 순서를 유지한다 — svcmonRouteOrder.test.js 가 회귀를 잡는다.)
 */

import {
  listTargetsCopy, listFolders, getSort, totalTests, flushStore, TEST_TYPES, KINDS,
} from '../../svcmon/store.js';
import { testState, emptySummary } from '../../svcmon/status.js';
import { edgeSummary, edgeTotals } from '../../central/svcmonEdge.js';
import { silenceStatus } from '../../central/svcmonSilence.js';
import { svcmonPushStatus } from '../../agent/svcmonPush.js';
import { getResults, getLastSweep, runNow, pollerStats } from '../../svcmon/poller.js';
import { ROTATE_UNITS, ROTATE_LABEL } from '../../svcmon/logsettings.js';
import { logStats } from '../../svcmon/csvlog.js';
import { canEdit, adminOnly } from './shared.js';

// 상태 판정·요약 키는 svcmon/status.js 하나에서만 정의한다(라우트·화면·테스트 공용).
const statusOf = (t, x, results, now) => testState(t, x, results, now);

export function registerOverview(svcmonRouter) {

/** 트리 + 대상 + 점검 + 최근 결과 + 요약. path/limit 으로 범위를 좁힐 수 있다. */
svcmonRouter.get('/state', (req, res) => {
  const results = getResults();
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const scope = typeof req.query.path === 'string' ? req.query.path : '';
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 300));

  const all = listTargetsCopy();
  const now = Date.now();
  // 요약은 항상 전체(또는 kind 전체) 기준 — 화면 상단 KPI 가 페이징에 흔들리지 않게.
  // pending/stale 을 disabled 와 **합치지 않는다**(감시 공백이 의도적 중지로 위장된다).
  const summary = emptySummary();
  for (const t of all) {
    if (kind && t.kind !== kind) continue;
    for (const x of t.tests) {
      summary.total += 1;
      const st = statusOf(t, x, results, now);
      if (summary[st] !== undefined) summary[st] += 1;
      else summary.pending += 1;
    }
  }

  const inScope = all.filter((t) => (!kind || t.kind === kind)
    && (!scope || t.path === scope || t.path.startsWith(`${scope}\\`)));
  const targets = inScope.slice(0, limit).map((t) => ({
    ...t,
    tests: t.tests.map((x) => {
      const r = results.get(x.id) || null;
      // 화면이 나이를 직접 계산하지 않게 서버가 실어 보낸다(클라이언트 시계는 틀릴 수 있다).
      const ageMs = r?.ts ? now - r.ts : null;
      return { ...x, result: r ? { ...r, ageMs } : null, state: statusOf(t, x, results, now) };
    }),
  }));

  res.json({
    targets,
    folders: listFolders(),
    sort: getSort(),
    summary,
    truncated: inScope.length > targets.length,
    scopeCount: inScope.length,
    targetCount: all.length,
    // 엣지 위임 요약 — 이 포탈이 직접 실행한 것 외에, 원격 법인 엣지가 보고한 현황.
    edges: edgeSummary(now),
    edgeTotals: edgeTotals(now),
    testTypes: TEST_TYPES,
    rotateUnits: ROTATE_UNITS,
    rotateLabels: ROTATE_LABEL,
    lastSweep: getLastSweep(),
  });
});

/** 운영 진단 — 워커/폴러/로그 라이터 상태(부하 점검용). */
svcmonRouter.get('/diag', canEdit, (req, res) => {
  res.json({
    poller: pollerStats(), log: logStats(),
    targets: listTargetsCopy().length, tests: totalTests(),
    // 엣지 위임 진단 — 이 서버가 받는 쪽(edges)인지 보내는 쪽(push)인지 함께 보인다.
    edges: edgeSummary(), push: svcmonPushStatus(), silence: silenceStatus(),
  });
});

svcmonRouter.post('/refresh', canEdit, async (req, res) => {
  const ran = await runNow();
  res.status(ran ? 200 : 202).json({ ok: true, ran });
});

/** 종료 전 저장 flush(운영자 수동 호출·업그레이드 스크립트용). 위치 이동 근거는 파일 헤더 주석. */
svcmonRouter.post('/flush', adminOnly, (req, res) => { flushStore(); res.json({ ok: true }); });

}
