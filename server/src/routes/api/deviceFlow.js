/**
 * routes/api/deviceFlow.js — 특수기능 '3단 지도(장비 → 엣지 → 메인)' API(v2.588).
 *
 * 통신 지도(v2.584)와 데이터 흐름 지도(v2.587)의 입력을 **그대로** 모아 두 조립기를 돌리고,
 * 그 결과를 `devflow/build.js` 가 3단으로 묶는다(판정 복제 없음). 새 입력은 iDRAC 등록부·엣지 export 뿐.
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 전 법인 엣지 이름·주소·위임 장비 이름·iDRAC 서비스태그가 들어간다 — 통신 지도와 같은 기준(v2.525 규약).
 *
 * ── 비용 ────────────────────────────────────────────────────────────────────
 * 장비·엣지 왕복 **0**. 등록부(파일 캐시)·인메모리 통계·link_latest SELECT 1회. 15초 폴링이라 memoJson(12초).
 */
import { requireRole } from '../../auth/auth.js';
import { config, currentVersion } from '../../config.js';
import { memoJson } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { buildCommMap } from '../../commmap/build.js';
import { buildDataFlow } from '../../dataflow/build.js';
import { buildDeviceFlow, ITEM_MAX } from '../../devflow/build.js';
import { gatherCommInputs } from './commMap.js';
import { gatherFlowInputs } from './dataFlow.js';
import { loadRegistry as loadIdrac } from '../../idrac/registry.js';
import { allRemoteServers } from '../../collector/remoteInventory.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('3단 지도는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다 — 전 법인의 엣지 주소·위임 장비 이름이 들어갑니다.');

export function registerDeviceFlow(api) {
  api.get('/tools/device-flow', adminOnly, fullScopeOnly, async (req, res) => {
    await memoJson(req, res, 'device-flow', async (snap) => {
      const sourceErrors = [];
      const comm = buildCommMap({ ...(await gatherCommInputs(snap, sourceErrors)), resMax: Infinity, directMax: Infinity });
      const flow = buildDataFlow(gatherFlowInputs(sourceErrors));
      let idracLocal = [];
      try { idracLocal = loadIdrac(); } catch (e) { sourceErrors.push({ source: 'idrac', error: String(e?.message || e).slice(0, 160) }); }
      let idracRemote = [];
      try { idracRemote = allRemoteServers(); } catch (e) { sourceErrors.push({ source: 'idrac-edge', error: String(e?.message || e).slice(0, 160) }); }
      const out = buildDeviceFlow({
        now: Date.now(), comm, flow, idracLocal, idracRemote,
        central: { version: currentVersion(), agentName: config.agent?.name || '' },
      });
      // 비밀 필드(password)는 idracItem 이 애초에 옮기지 않는다 — 여기서 추가로 싣지 말 것.
      return { ok: true, ...out, cats: flow.cats || [], itemMax: ITEM_MAX, sourceErrors, generatedAt: Date.now() };
    });
  });
}
