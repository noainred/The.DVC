/**
 * routes/api/compareMatrix.js — 비교 매트릭스 API(v2.499).
 *
 * 사용자 요구: "비교하기 누르면 vCenter 별·클러스터별·스토리지별 비교로, 가로축은 vCenter·세로축은
 * 클러스터인 매트릭스로 상태를 보여주는 기능".
 *
 * · 데이터는 **스냅샷만** 읽는다(vCenter 추가 왕복 0) — 집계는 순수 모듈 tools/compareMatrix.js.
 * · scope: scopeSlice 로 허용 vCenter 만 남긴 뒤 집계한다 — 열(vCenter)·행(클러스터/DS) 어느 쪽으로도
 *   범위 밖 자원 이름이 새지 않는다. memoJson 캐시 키에 scopeKey 를 섞는다(스코프 간 캐시 공유 금지).
 * · vCenter 축은 서버가 따로 계산하지 않는다 — `/vcenters` 의 metrics 를 화면이 전치해 쓰면 충분하고,
 *   같은 수치를 두 경로로 계산하면 어긋난다(단일 출처 원칙).
 */
import { store } from '../../store.js';
import { memoJson, scopeSlice, scopeKey } from './shared.js';
import { clusterMatrix, datastoreMatrix, CLUSTER_METRICS, DATASTORE_METRICS } from '../../tools/compareMatrix.js';

const MAX_ROWS = {
  cluster: Math.max(10, Math.min(2_000, Number(process.env.COMPARE_MATRIX_MAX_CLUSTERS) || 200)),
  datastore: Math.max(10, Math.min(5_000, Number(process.env.COMPARE_MATRIX_MAX_DATASTORES) || 300)),
};

export function registerCompareMatrix(api) {
  /**
   * GET /compare/matrix?axis=cluster|datastore
   *   → { axis, metrics, vcenters:[{id,name}], rows:[{name, cells:{vcId:{…}}, total, vcenters}], colTotals, rowCount, truncated }
   * 셀은 **희소**하다(그 vCenter 에 그 이름이 없으면 키가 없다) — 화면은 '—' 로 그리고 0 으로 채우지 않는다.
   */
  api.get('/compare/matrix', (req, res) => memoJson(req, res, `compare-matrix-${req.query.axis === 'datastore' ? 'ds' : 'cl'}${['1', 'true', 'yes'].includes(String(req.query.normalize || '').toLowerCase()) ? '-n' : ''}`, (snap) => {
    const axis = req.query.axis === 'datastore' ? 'datastore' : 'cluster';
    // normalize=1: 이름의 사이트 접두(첫 '-' 앞)를 떼어 역할끼리 묶는다(휴리스틱 — 화면이 명시).
    const normalize = ['1', 'true', 'yes'].includes(String(req.query.normalize || '').toLowerCase());
    const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
    const built = axis === 'datastore'
      ? datastoreMatrix(scoped, { maxRows: MAX_ROWS.datastore, normalize })
      : clusterMatrix(scoped, { maxRows: MAX_ROWS.cluster, normalize });
    return {
      axis,
      normalize,
      metrics: axis === 'datastore' ? DATASTORE_METRICS : CLUSTER_METRICS,
      maxRows: MAX_ROWS[axis],
      generatedAt: snap.generatedAt || null,
      source: snap.source || null,
      ...built,
    };
  }, { ttlMs: 12_000, extraKey: scopeKey(req.user, store.get()) }));
}
