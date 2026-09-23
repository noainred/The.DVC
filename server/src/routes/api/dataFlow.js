/**
 * routes/api/dataFlow.js — 특수기능 '데이터 흐름 지도' API(v2.587).
 *
 * 포탈 사이를 오가는 모든 경로(중앙 수신 `/api/central/*` + 중앙→엣지 `/api/collector/*`)를 **실제 라우터
 * 선언에서** 읽고, 경로 × 엣지마다 마지막 성공·실패를 인메모리 계측기 4개에서 조합한다
 * (`ingestStats` POST · `pullStats` GET · `ingestReject` 거부 · `outboundStats` 중앙→엣지 호출).
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 전 법인 엣지 이름·주소·거부 사유가 들어간다 — 통신 지도(v2.584)·엣지 로그(v2.549)와 같은 기준. 엣지는
 * vCenter 귀속이 아니라 범위 계정에 나눌 축이 없다 → 403(v2.525 규약).
 *
 * ── 비용 ────────────────────────────────────────────────────────────────────
 * 장비·엣지 왕복 **0**(인메모리 통계 + 등록부 캐시). 15초 폴링이라 `memoJson`(TTL 12초)으로 합류시킨다.
 * 엣지 **안의** 수집 상태는 여기 싣지 않는다 — 화면이 누를 때만 `/tools/edge-log/fetch` 로 당긴다(사용자 선택).
 * 응답에 **토큰·URL 경로를 싣지 않는다** — 엣지는 origin 만(v2.584 규약).
 */
import { requireRole } from '../../auth/auth.js';
import { memoJson } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { listCollectors } from '../../collector/registry.js';
import { getIngestStats } from '../../central/ingestStats.js';
import { pullStats } from '../../central/pullStats.js';
import { rejectStats } from '../../central/ingestReject.js';
import { outboundStats } from '../../util/outboundStats.js';
import { centralRouter } from '../central.js';
import { collectorRouter } from '../collector.js';
import { buildDataFlow, KINDS } from '../../dataflow/build.js';
import { GROUP_LABEL } from '../../edgelog/spec.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('데이터 흐름 지도는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다 — 전 법인 엣지의 이름·주소·거부 사유가 들어갑니다.');

/** 실제 라우터에서 선언을 읽는다 — 손으로 적은 목록을 두지 않는다(새 경로가 자동으로 잡힌다). */
export function declaredRoutes() {
  const out = [];
  for (const [side, router] of [['central', centralRouter], ['collector', collectorRouter]]) {
    for (const layer of router.stack || []) {
      const r = layer.route; if (!r || typeof r.path !== 'string') continue;
      for (const m of Object.keys(r.methods || {})) if (r.methods[m]) out.push({ side, method: m.toUpperCase(), path: r.path });
    }
  }
  return out;
}

/** 데이터 흐름 입력 — 3단 지도(v2.588)가 재사용한다. 왕복 0(인메모리 계측기 + 등록부 캐시). */
export function gatherFlowInputs(sourceErrors) {
  let collectors = [];
  try { collectors = listCollectors(); } catch (e) { sourceErrors.push({ source: 'collectors', error: String(e?.message || e).slice(0, 160) }); }
  const ingest = getIngestStats();
  return {
    now: Date.now(),
    routes: declaredRoutes(),
    collectors,
    ingest, ingestSince: ingest.since,
    pulls: pullStats(),
    rejects: rejectStats(),
    outbound: outboundStats(),
  };
}

export function registerDataFlow(api) {
  api.get('/tools/data-flow', adminOnly, fullScopeOnly, async (req, res) => {
    await memoJson(req, res, 'data-flow', async () => {
      const sourceErrors = [];
      const flow = buildDataFlow(gatherFlowInputs(sourceErrors));
      // 엣지 주소는 origin 만(경로·쿼리에 토큰이 실릴 수 있다) — build 가 이미 origin 만 담는다.
      return { ok: true, ...flow, kinds: KINDS, innerGroupLabel: GROUP_LABEL, sourceErrors, generatedAt: Date.now() };
    });
  });
}
