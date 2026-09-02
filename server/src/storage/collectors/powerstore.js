/**
 * storage/collectors/powerstore.js — Dell PowerStore 수집기(v2.309, 사용자 요구).
 * PowerStore REST(https://<mgmt>/api/rest/*, Basic 인증)를 섹션별 best-effort 로 조회해
 * 공통 스키마(NormalizedSnapshot)로 정규화한다 — 화면·집계·위임 경로는 타입 무관(types.js 계약).
 * ⚠ 실장비 검증 전: 경로·필드는 PowerStore REST 문서 지식 기반 — 섹션별 오류 문구로 드러남.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter, makeRawGetter, makePoster, tryAny } from './restCommon.js';

/**
 * 공간 시계열 응답에서 쓸 점 하나 고르기(순수).
 * PowerStore 는 응답을 배열로 주는데 정렬 방향이 경로마다 다르고(오름/내림), 최신 점이 아직
 * 집계 전이라 physical_total 이 비어 있는 경우도 있다. 그래서 '물리 총량이 있는 점' 중
 * timestamp 가 가장 큰 것을 고르고, timestamp 가 없으면 배열 뒤쪽(대개 최신)을 우선한다.
 */
export function pickLatestSpacePoint(metrics) {
  const list = (Array.isArray(metrics) ? metrics : [metrics]).filter(Boolean);
  const withTotal = list.filter((p) => Number(p.physical_total) > 0);
  const pool = withTotal.length ? withTotal : list;
  if (!pool.length) return null;
  const ts = (p) => Date.parse(p.timestamp || '') || 0;
  if (pool.some((p) => ts(p))) return pool.reduce((a, b) => (ts(b) >= ts(a) ? b : a));
  return pool[pool.length - 1];
}

/** 원시 응답 → 정규화(순수 — storageMon.test.js 픽스처 고정). raw: {cluster,sw,appliances,metrics,appliancePools,nodes,users,alerts} */
export function normalizePowerstore(device, raw) {
  const snap = emptySnapshot(device);
  const first = (v) => (Array.isArray(v) ? v[0] : v) || null;
  const cl = first(raw.cluster);
  if (cl) {
    snap.name = cl.name || device.name;
    snap.serial = cl.global_id || cl.id || '';
    snap.extra.state = cl.state || '';
    snap.sections.config = 'ok';
  }
  const sw = first(raw.sw);
  if (sw) snap.version = sw.release_version || sw.build_version || '';
  // 용량(물리) — space_metrics_by_cluster 의 physical_total/physical_used(바이트).
  // ⚠ 응답은 '한 점'이 아니라 시계열 배열이다. POST /metrics/generate 는 오래된 것부터 오고,
  //   구버전 GET 폴백은 order=timestamp.desc 라 최신이 앞이다 — 어느 쪽이 와도 맞도록
  //   '물리 총량이 있는 점 중 timestamp 가 가장 큰 것'을 고른다. 예전에는 first()(=[0])만 봐서
  //   generate 응답에서는 가장 오래된 점(대개 값이 비어 있음)을 집어 용량이 '—' 로 남았다.
  const m = pickLatestSpacePoint(raw.metrics);
  if (m) {
    const total = Number(m.physical_total) || 0;
    const used = Number(m.physical_used) || 0;
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    // 물리 사용량의 맥락(논리 사용량·데이터 감축률·절감) — 상세 화면에서 '실제 디스크를 얼마나
    // 쓰는지'와 '논리적으로 얼마를 할당했는지'를 함께 보기 위해 extra 로 싣는다(스키마 확장 금지 규칙).
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    snap.extra.space = {
      physicalTotal: total, physicalUsed: used,
      logicalUsed: num(m.logical_used), logicalProvisioned: num(m.logical_provisioned),
      dataReduction: num(m.data_reduction), thinSavings: num(m.thin_savings),
      snapshotSavings: num(m.snapshot_savings), sharedLogicalUsed: num(m.shared_logical_used),
      at: m.timestamp || null,
    };
  }
  // 어플라이언스별 물리 사용량 → pools(v2.404). 클러스터 합계만으로는 어느 어플라이언스가
  // 찼는지 알 수 없다. 실패하면 조용히 건너뛴다(클러스터 용량은 이미 위에서 채워짐).
  if (Array.isArray(raw.appliancePools) && raw.appliancePools.length) {
    snap.pools = raw.appliancePools.slice(0, 32);
  }
  // 어플라이언스 목록은 extra 로만(모델·서비스태그) — pools 로 넣으면 용량 0 으로 오표시된다
  // (appliance 별 용량은 space_metrics_by_appliance 상세가 필요 — 실장비 확인 후 후속. 정직 표기).
  if (Array.isArray(raw.appliances)) {
    snap.extra.appliances = raw.appliances.slice(0, 8).map((a) => ({ name: a.name, model: a.model, serviceTag: a.service_tag }));
  }
  if (Array.isArray(raw.nodes)) {
    snap.nodes = { count: raw.nodes.length, unhealthy: 0, list: raw.nodes.slice(0, 64).map((n, i) => ({ id: i + 1, ip: '', health: 'unknown', inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0, name: n.slot != null ? `slot ${n.slot}` : (n.id || '') })) };
    snap.sections.nodes = 'ok';
  }
  if (Array.isArray(raw.users)) {
    snap.accounts = raw.users.slice(0, 200).map((u) => ({ name: u.name || u.id || '', enabled: u.is_locked !== true }));
    snap.sections.accounts = 'ok';
  }
  if (Array.isArray(raw.alerts)) {
    snap.alerts.unresolved = raw.alerts.length;
    // 심각도 분포도 함께(운영에서 '몇 건'보다 '치명 몇 건'이 판단 기준이다).
    const bySeverity = {};
    for (const a of raw.alerts) { const k = String(a.severity || 'Unknown'); bySeverity[k] = (bySeverity[k] || 0) + 1; }
    snap.extra.alertsBySeverity = bySeverity;
    snap.sections.alerts = 'ok';
  }

  // ── 인벤토리/성능 요약(v2.404, 사용자 요구 '수집할 수 있는 모든 데이터') ──────────────
  // ⚠ 원본 객체를 통째로 싣지 않는다 — 스냅샷은 10분마다 중앙으로 push 되고 그대로 저장된다.
  //   볼륨 수천 개를 그대로 넣으면 push 대역폭·중앙 저장이 터진다(types.js 'extra 는 작게' 규칙).
  //   그래서 **개수와 합계 같은 요약치**로 접어서 싣는다.
  const inv = {};
  if (Array.isArray(raw.hardware)) {
    const byType = {};
    let unhealthy = 0;
    for (const h of raw.hardware) {
      const t = String(h.type || 'Unknown');
      byType[t] = (byType[t] || 0) + 1;
      // lifecycle_state 가 Healthy 계열이 아니면 이상으로 센다(값을 모르면 세지 않는다 — 정직).
      const st = String(h.lifecycle_state || '');
      if (st && !/^(healthy|normal|ok)$/i.test(st)) unhealthy += 1;
    }
    inv.hardware = { total: raw.hardware.length, byType, unhealthy };
  }
  if (Array.isArray(raw.volumes)) {
    let provisioned = 0;
    const byState = {};
    for (const v of raw.volumes) {
      provisioned += Number(v.size) || 0;
      const k = String(v.state || 'Unknown'); byState[k] = (byState[k] || 0) + 1;
    }
    inv.volumes = { count: raw.volumes.length, provisionedBytes: provisioned, byState, truncated: !!raw.volumesTruncated };
  }
  if (Array.isArray(raw.hosts)) inv.hosts = { count: raw.hosts.length };
  if (Array.isArray(raw.hostGroups)) inv.hostGroups = { count: raw.hostGroups.length };
  if (Array.isArray(raw.fileSystems)) {
    let total = 0, used = 0;
    for (const f of raw.fileSystems) { total += Number(f.size_total) || 0; used += Number(f.size_used) || 0; }
    inv.fileSystems = { count: raw.fileSystems.length, totalBytes: total, usedBytes: used };
  }
  if (Array.isArray(raw.nasServers)) inv.nasServers = { count: raw.nasServers.length };
  if (Array.isArray(raw.storageContainers)) inv.storageContainers = { count: raw.storageContainers.length };
  if (Array.isArray(raw.replication)) {
    const byState = {};
    for (const r of raw.replication) { const k = String(r.state || 'Unknown'); byState[k] = (byState[k] || 0) + 1; }
    inv.replicationSessions = { count: raw.replication.length, byState };
  }
  if (Array.isArray(raw.appliances)) inv.appliances = { count: raw.appliances.length };
  if (Object.keys(inv).length) { snap.extra.inventory = inv; snap.sections.inventory = 'ok'; }

  // 성능(최신 1점) — IOPS/대역폭/지연. 용량과 달리 '지금 얼마나 일하는지'를 본다.
  const perf = pickLatestSpacePoint(raw.perf); // 같은 시계열 선택 규칙(최신 점) 재사용
  if (perf) {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    snap.extra.perf = {
      readIops: num(perf.read_iops), writeIops: num(perf.write_iops), totalIops: num(perf.total_iops),
      readBandwidth: num(perf.read_bandwidth), writeBandwidth: num(perf.write_bandwidth), totalBandwidth: num(perf.total_bandwidth),
      readLatencyUs: num(perf.avg_read_latency), writeLatencyUs: num(perf.avg_write_latency), latencyUs: num(perf.avg_latency),
      at: perf.timestamp || null,
    };
    snap.sections.performance = 'ok';
  }
  snap.extra.collectMethod = 'api';
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

const PORT = () => Number(process.env.STORAGE_POWERSTORE_PORT) || 443;
/** metrics/generate 의 집계 구간 — 짧을수록 최신이지만 아직 집계 전이라 빌 수 있어 하루가 무난. */
const METRICS_INTERVAL = process.env.STORAGE_POWERSTORE_METRICS_INTERVAL || 'One_Day';

/**
 * 공간(물리 사용량) 시계열 조회(v2.404, 사용자 요구 — '접속은 되는데 사용량이 안 보임').
 *
 * 원인: space_metrics_by_cluster 는 일반 컬렉션이 아니라 **POST /api/rest/metrics/generate**
 * 로 뽑는 리소스다. 예전 코드는 GET 컬렉션으로만 시도해 대부분의 장비에서 4xx 가 났고, 용량
 * 섹션이 비어 화면에 '—' 만 남았다(연결·버전·노드는 정상이라 더 헷갈렸다).
 *
 * PowerStore 는 POST 에 CSRF 토큰(DELL-EMC-TOKEN)을 요구할 수 있는데 그 값을 앞선 GET 의
 * 응답 헤더로 내려준다 — 토큰이 있으면 실어 보내고, 없으면 그냥 보낸다(요구하지 않는 버전 대응).
 * generate 가 실패하면 구버전용 GET 컬렉션으로 폴백한다(둘 다 실패해야 섹션 오류).
 */
async function fetchSpaceMetrics({ post, csrf, get, entity, entityId }) {
  try {
    return await post('/api/rest/metrics/generate',
      { entity, entity_id: String(entityId ?? ''), interval: METRICS_INTERVAL },
      csrf ? { 'DELL-EMC-TOKEN': csrf } : {});
  } catch (e) {
    // 구버전/변형 폴백 — 컬렉션 GET 이 되는 환경도 있다. 마지막 오류를 그대로 올린다.
    try {
      return await tryAny(get, [
        `/api/rest/${entity}?select=*&order=timestamp.desc&limit=1`,
        `/api/rest/${entity}?select=*&limit=1`,
      ]);
    } catch { throw e; }
  }
}

export async function collect(device) {
  const get = makeGetter(device, { port: PORT() });
  const rawGet = makeRawGetter(device, { port: PORT() });
  const post = makePoster(device, { port: PORT() });
  const raw = {};
  const snap = emptySnapshot(device);
  const sect = { cluster: 'config', metrics: 'capacity', nodes: 'nodes', users: 'accounts', alerts: 'alerts' };
  const step = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { if (sect[key]) snap.sections[sect[key]] = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
  };
  let csrf = null;
  try {
    // 401 이면 여기서 전체 중단(장비 계정 잠금 예방 — isilon 과 동일 규칙).
    // 응답 헤더에서 CSRF 토큰을 함께 챙긴다(아래 metrics/generate POST 용).
    await step('cluster', async () => {
      const r = await rawGet('/api/rest/cluster?select=*');
      csrf = r.headers.get('DELL-EMC-TOKEN') || r.headers.get('dell-emc-token') || null;
      return r.body;
    });
    await step('sw', () => get('/api/rest/software_installed?select=release_version,build_version&limit=1'));
    await step('appliances', () => get('/api/rest/appliance?select=id,name,model,service_tag'));
    const clusterId = (Array.isArray(raw.cluster) ? raw.cluster[0] : raw.cluster)?.id ?? 0;
    await step('metrics', () => fetchSpaceMetrics({ post, csrf, get, entity: 'space_metrics_by_cluster', entityId: clusterId }));
    // 어플라이언스별 물리 사용량 → pools. 부가 정보라 실패해도 섹션 오류로 만들지 않는다
    // (클러스터 합계가 이미 있으면 화면은 정상 — 여기서 실패를 키우면 '실패'로 오표시된다).
    if (Array.isArray(raw.appliances) && raw.appliances.length) {
      const pools = [];
      for (const a of raw.appliances.slice(0, 32)) {
        try {
          const pts = await fetchSpaceMetrics({ post, csrf, get, entity: 'space_metrics_by_appliance', entityId: a.id });
          const pt = pickLatestSpacePoint(pts);
          const t = Number(pt?.physical_total) || 0;
          const u = Number(pt?.physical_used) || 0;
          if (t) pools.push({ name: a.name || a.id || '', totalBytes: t, usedBytes: u, pct: Math.round((u / t) * 1000) / 10 });
        } catch { /* 어플라이언스 1대 실패가 전체 수집을 망치지 않게 */ }
      }
      if (pools.length) raw.appliancePools = pools;
    }
    await step('nodes', () => get('/api/rest/node?select=id,slot,appliance_id'));
    await step('users', () => get('/api/rest/local_user?select=id,name,is_locked'));
    await step('alerts', () => get('/api/rest/alert?select=id,severity&filter=state.eq.ACTIVE&limit=500'));

    // ── 인벤토리/성능(v2.404, 사용자 요구 '수집할 수 있는 모든 데이터') ────────────────
    // 전부 best-effort: 이 장비/버전에 없는 리소스(파일 서비스 미구성 등)는 4xx 가 나는 게
    // 정상이라 섹션 오류로 키우지 않고 조용히 건너뛴다(위 sect 맵에 없는 key 라 자동으로 그렇다).
    // ⚠ select 로 필요한 필드만, limit 으로 상한을 둔다 — 볼륨 수천 개의 전체 객체를 받으면
    //   파싱·push·중앙 저장이 모두 무거워진다(요약만 스냅샷에 남는다 — normalize 참고).
    const LIMIT = Math.max(100, Number(process.env.STORAGE_POWERSTORE_LIST_LIMIT) || 2000);
    await step('hardware', () => get('/api/rest/hardware?select=id,type,name,slot,lifecycle_state&limit=1000'));
    await step('volumes', () => get(`/api/rest/volume?select=id,size,state&limit=${LIMIT}`));
    raw.volumesTruncated = Array.isArray(raw.volumes) && raw.volumes.length >= LIMIT;
    await step('hosts', () => get('/api/rest/host?select=id&limit=1000'));
    await step('hostGroups', () => get('/api/rest/host_group?select=id&limit=1000'));
    await step('fileSystems', () => get('/api/rest/file_system?select=id,size_total,size_used&limit=1000'));
    await step('nasServers', () => get('/api/rest/nas_server?select=id&limit=500'));
    await step('storageContainers', () => get('/api/rest/storage_container?select=id&limit=500'));
    await step('replication', () => get('/api/rest/replication_session?select=id,state&limit=500'));
    await step('perf', () => fetchSpaceMetrics({ post, csrf, get, entity: 'performance_metrics_by_cluster', entityId: clusterId }));
  } catch (e) {
    const out = normalizePowerstore(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
    return out;
  }
  const out = normalizePowerstore(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
  return out;
}
