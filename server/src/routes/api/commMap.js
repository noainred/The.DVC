/**
 * routes/api/commMap.js — 특수기능 '통신 지도'(중앙 ↔ 엣지 통신 시각화) API(v2.584).
 *
 * 사용자 요청(2026-09-23): "이런 방식으로 메인과 edge 가 통신하는 것을 비주얼하게 보여주는 dashboard 추가해줘"
 * (라디얼 그래프 캡처 — 중앙 허브 → 안쪽 링 엣지 → 바깥 링 위임 자원).
 *
 * ── 권한: adminOnly + fullScopeOnly ─────────────────────────────────────────
 * 응답에 **엣지 출처(스킴·호스트·포트)·엣지 호스트명·위임 장비 이름**이 전 법인분으로 들어간다 —
 * v2.549(엣지 로그)·v2.552(통신 점검)·v2.560(토큰 점검)과 **같은 기준**이다. 엣지는 vCenter 귀속이
 * 아니라 범위 계정에 나눌 축이 없다 → 403(v2.525 규약).
 *
 * ── 비용 ────────────────────────────────────────────────────────────────────
 * 15초 폴링 화면이다. 장비·엣지 왕복은 **0** — 등록부(파일 캐시)·인메모리 통계·`link_latest` SELECT 1회뿐이다.
 * `memoJson`(스냅샷 세대 + URL 키, TTL 12초)이 동시 사용자·탭의 계산을 1회로 합류시킨다(v2.577 `/top` 규약).
 * ⚠ 이 응답은 스냅샷 밖의 값(수신 통계·pull 상태)도 담으므로 세대 키만으로는 12초 안의 변화가 안 보이지만,
 *   화면 폴링이 15초라 TTL 이 폴링보다 짧다 — 다음 폴에서는 새 값이다.
 */
import { requireRole } from '../../auth/auth.js';
import { config, currentVersion } from '../../config.js';
import { store, SITE_STALE_MS } from '../../store.js';
import { memoJson } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { listCollectors } from '../../collector/registry.js';
import { allCollectorStatus } from '../../collector/state.js';
import { getIngestStats } from '../../central/ingestStats.js';
import { rejectStats } from '../../central/ingestReject.js';
import { latestAll } from '../../linkcheck/db.js';
import { linkCheckEnabled } from '../../linkcheck/settings.js';
import { allEdgeLinkReports } from '../../central/linkCheckEdge.js';
import { listRegistry as listVcenters } from '../../vcenter/registry.js';
import { listDevices as listStorage } from '../../storage/registry.js';
import { listDevices as listSanSwitch } from '../../sanswitch/registry.js';
import { listDevices as listPdu } from '../../pdu/registry.js';
import { edgeStorageReports } from '../../central/storageEdge.js';
import { edgePduStatus } from '../../central/pduEdge.js';
import { edgeSanSwitchSnapshots } from '../../central/sanSwitchEdge.js';
import { buildCommMap, RES_MAX_PER_KIND, DIRECT_MAX_PER_KIND, PUSH_FRESH_FACTOR, REASON_SEVERITY } from '../../commmap/build.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('통신 지도는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다 — 전 법인의 엣지 주소·위임 장비 이름이 들어갑니다.');

/** 저장소 읽기 실패가 화면 전체를 죽이지 않게 — 빈 목록 + 사유(조용히 비우지 않는다). */
function safeList(fn, errors, name) {
  try { return fn(); } catch (e) { errors.push({ source: name, error: String(e?.message || e).slice(0, 160) }); return []; }
}

/** SAN 엣지 보고는 per-agent export 가 없어 스냅샷에서 접는다(`pushedAt` = 그 엣지의 마지막 push). */
function sanReportsOf(snaps) {
  const m = new Map();
  for (const s of snaps || []) {
    const ag = String(s.agent || '').trim(); if (!ag) continue;
    const cur = m.get(ag) || { agent: ag, at: 0, devices: 0 };
    cur.devices += 1; if ((s.pushedAt || 0) > cur.at) cur.at = s.pushedAt || 0;
    m.set(ag, cur);
  }
  return [...m.values()].map((r) => ({ ...r, at: r.at || null }));
}

export function registerCommMap(api) {
  api.get('/tools/comm-map', adminOnly, fullScopeOnly, async (req, res) => {
    await memoJson(req, res, 'comm-map', async (snap) => {
      const sourceErrors = [];
      // vCenter 별 호스트·VM 수(스냅샷 1회 순회 — O(N))
      const vcCounts = new Map();
      for (const h of snap.hosts || []) { const c = vcCounts.get(h.vcenterId) || { hosts: 0, vms: 0 }; c.hosts += 1; vcCounts.set(h.vcenterId, c); }
      for (const v of snap.vms || []) { const c = vcCounts.get(v.vcenterId) || { hosts: 0, vms: 0 }; c.vms += 1; vcCounts.set(v.vcenterId, c); }
      const map = buildCommMap({
        now: Date.now(),
        collectors: safeList(listCollectors, sourceErrors, 'collectors'),
        status: allCollectorStatus(),
        ingest: getIngestStats(),
        rejects: rejectStats(),
        latestLinks: await latestAll().catch(() => []),
        edgeReports: allEdgeLinkReports(),
        vcenters: safeList(listVcenters, sourceErrors, 'vcenters'),
        snapVcenters: snap.vcenters || [],
        vcCounts,
        storage: safeList(listStorage, sourceErrors, 'storage'),
        sanswitch: safeList(listSanSwitch, sourceErrors, 'sanswitch'),
        pdu: safeList(listPdu, sourceErrors, 'pdu'),
        storageReports: safeList(edgeStorageReports, sourceErrors, 'storage-edge'),
        pduReports: safeList(edgePduStatus, sourceErrors, 'pdu-edge'),
        sanReports: sanReportsOf(safeList(edgeSanSwitchSnapshots, sourceErrors, 'sanswitch-edge')),
        pullIntervalMs: config.collector.pullIntervalMs,
        siteStaleMs: SITE_STALE_MS,
        linkCheckEnabled: linkCheckEnabled(),
      });
      return {
        ok: true, ...map,
        central: { version: currentVersion(), agentName: config.agent?.name || '', centralTokenSet: !!config.central?.token, dataSource: snap.source || '', generatedAt: snap.generatedAt || null },
        limits: { resMaxPerKind: RES_MAX_PER_KIND, directMaxPerKind: DIRECT_MAX_PER_KIND, pushFreshFactor: PUSH_FRESH_FACTOR },
        reasonSeverity: REASON_SEVERITY,
        sourceErrors,
      };
    });
  });
}
