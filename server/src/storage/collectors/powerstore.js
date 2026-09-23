/**
 * storage/collectors/powerstore.js — Dell PowerStore 수집기(v2.309, 사용자 요구).
 * PowerStore REST(https://<mgmt>/api/rest/*, Basic 인증)를 섹션별 best-effort 로 조회해
 * 공통 스키마(NormalizedSnapshot)로 정규화한다 — 화면·집계·위임 경로는 타입 무관(types.js 계약).
 * ⚠ 실장비 검증 전: 경로·필드는 PowerStore REST 문서 지식 기반 — 섹션별 오류 문구로 드러남.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter, makeRawGetter, makePoster, tryAny } from './restCommon.js';
import { numOrNull } from '../../util/numOrNull.js';

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

/**
 * 알람 1건이 '미해결' 인가(순수, v2.513).
 * 폴백 경로(장비가 `state=eq.ACTIVE` 를 못 받는 버전)에서만 쓴다 — 전체를 받아 코드에서 거른다.
 * PowerStore 는 `state` 를 ACTIVE/CLEARED 로 주는데, 버전에 따라 이 필드가 없고
 * `is_acknowledged` 만 있는 응답도 있다. **필드가 없다고 해서 미해결이라고 단정하지 않는다** —
 * 확인(acknowledged)된 것만 제외하고 나머지는 남긴다(건수를 줄여 '조용한 축소' 를 만들지 않기 위함).
 */
export function isActiveAlert(a) {
  const s = String(a?.state ?? '').trim().toUpperCase();
  if (s) return s === 'ACTIVE';
  return a?.is_acknowledged !== true;
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
  // 진단(v2.422): 공간 지표를 어디서(generate/GET)·어떤 구간으로 받았고 점이 몇 개였는지 — 용량이 비면 이 정보가
  // 상세 창 '섹션별 수집 상태' 옆에 보여 원인을 좁힌다(예전에는 '정상 + 0.0 TB' 로만 보여 원인을 알 수 없었다).
  if (raw.metricsDebug) snap.extra.spaceDebug = raw.metricsDebug;
  const total = Number(m?.physical_total) || 0;
  if (m && !total) {
    // ⚠ 점은 있는데 physical_total 이 없거나 0 — 'ok + 0 TB' 로 위장하지 않는다(정직 표기).
    const keys = Object.keys(m).filter((k) => k !== 'entity' && k !== 'entity_id').slice(0, 12).join(',');
    snap.sections.capacity = `오류: 공간 지표 점 ${Array.isArray(raw.metrics) ? raw.metrics.length : 1}개 중 physical_total 이 있는 점이 없음(필드: ${keys || '없음'})`;
  } else if (m) {
    // v2.593(감사 DATA-01): 사용량을 못 읽으면 0 이 아니라 null — 0 은 '비었다' 는 거짓이고 증가량에 거짓 급변을 만든다(v2.561 규약).
    const used = numOrNull(m.physical_used);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total && used != null ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    // 물리 사용량의 맥락(논리 사용량·데이터 감축률·절감) — 상세 화면에서 '실제 디스크를 얼마나
    // 쓰는지'와 '논리적으로 얼마를 할당했는지'를 함께 보기 위해 extra 로 싣는다(스키마 확장 금지 규칙).
    const num = numOrNull;   // v2.561: 공용 판정(Number(null)===0 함정)
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
    // v2.513: 장비가 state 필터를 못 받아 '전체를 받아 코드에서 거른' 경우 그 사실을 밝힌다.
    // ⚠ sections 값에 섞지 말 것 — 화면 배지는 'ok'/'skip' 정확 일치가 아니면 **빨간 '오류'** 로
    //   그린다(StorageMonTool.jsx). 정상 수집을 오류로 표시하는 것은 이 수정의 목적과 반대다.
    if (raw.alertsNote) snap.extra.alertsNote = String(raw.alertsNote);
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
    const num = numOrNull;   // v2.561: 공용 판정(Number(null)===0 함정)
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
const SPACE_INTERVALS = (() => {
  const first = METRICS_INTERVAL;
  return [first, ...['One_Day', 'One_Hour', 'Five_Mins'].filter((x) => x !== first)];
})();
const hasTotal = (pts) => (Array.isArray(pts) ? pts : [pts]).some((p) => p && Number(p.physical_total) > 0);

/**
 * v2.422(사용자 요구 '접속은 되는데 데이터 수집이 안 됨'): 원인 후보를 전부 순서대로 시도하고 **무엇을 시도했는지**
 * debug 로 남긴다.
 *  ① generate 를 구간 One_Day → One_Hour → Five_Mins 순으로 — 어떤 구간은 최신 점이 아직 집계 전이라 physical_total
 *     이 비어 오고(그래서 '0 TB'), 다른 구간에는 값이 있다. physical_total>0 인 점이 나오면 멈춘다.
 *  ② CSRF 거부(4xx 본문에 token/CSRF)면 `GET /api/rest/login_session` 으로 DELL-EMC-TOKEN 을 새로 받아 1회 재시도
 *     — 앞선 GET 응답 헤더에 토큰이 없는 버전이 있다.
 *  ③ 전부 실패하면 구버전 GET 컬렉션 폴백. 마지막 오류에 시도 내역을 붙인다.
 * 반환: { points, debug:{ source, interval, tried:[...] } }
 */
export async function fetchSpaceMetrics({ post, csrf, get, rawGet = null, entity, entityId, intervals = SPACE_INTERVALS, accept = hasTotal }) {
  const tried = [];
  let token = csrf;
  let lastErr = null;
  let lastPts = null;
  for (const interval of intervals) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const pts = await post('/api/rest/metrics/generate', { entity, entity_id: String(entityId ?? ''), interval }, token ? { 'DELL-EMC-TOKEN': token } : {});
        const n = Array.isArray(pts) ? pts.length : (pts ? 1 : 0);
        const ok = accept(pts);
        tried.push(`generate ${interval}: ${n}점${ok ? '(값 있음)' : '(physical_total 없음)'}`);
        if (ok) return { points: pts, debug: { source: 'generate', interval, tried } };
        if (n) lastPts = pts;
        break; // 응답은 왔으나 값 없음 → 다음 구간
      } catch (e) {
        lastErr = e;
        tried.push(`generate ${interval}: ${e.message}`);
        // CSRF 토큰 거부 → login_session 에서 토큰을 받아 1회 재시도
        if (attempt === 0 && rawGet && /token|csrf|403|422/i.test(e.message)) {
          try {
            const r = await rawGet('/api/rest/login_session');
            const t = r.headers.get('DELL-EMC-TOKEN') || r.headers.get('dell-emc-token') || null;
            if (t && t !== token) { token = t; tried.push('login_session 에서 CSRF 토큰 재확보'); continue; }
          } catch (e2) { tried.push(`login_session: ${e2.message}`); }
        }
        break;
      }
    }
  }
  // 구버전/변형 폴백 — 컬렉션 GET 이 되는 환경도 있다.
  try {
    const pts = await tryAny(get, [
      `/api/rest/${entity}?select=*&order=timestamp.desc&limit=1`,
      `/api/rest/${entity}?select=*&limit=1`,
    ]);
    tried.push(`GET ${entity}: ${Array.isArray(pts) ? pts.length : 1}점`);
    if (accept(pts) || !lastPts) return { points: pts, debug: { source: 'get', interval: null, tried } };
  } catch (e) { tried.push(`GET ${entity}: ${e.message}`); if (!lastErr) lastErr = e; }
  if (lastPts) return { points: lastPts, debug: { source: 'generate', interval: null, tried } }; // 값 없는 점이라도 돌려 정직 표기(normalize 가 오류로 남김)
  throw new Error(`${lastErr ? lastErr.message : '공간 지표 없음'} [시도: ${tried.join(' · ')}]`);
}

export async function collect(device, { signal = null } = {}) {
  // 수집 방식 분기(v2.405) — 등록 시 고른 collectMethod 로 REST/SSH(pstcli) 를 가른다.
  // isilon.js 와 같은 패턴: 타입 파일이 자기 방식을 안다(poller 는 타입만 안다).
  if (device.collectMethod === 'ssh') {
    const { collectViaSsh } = await import('./powerstoreSsh.js');
    return collectViaSsh(device);
  }
  const get = makeGetter(device, { port: PORT(), signal });
  const rawGet = makeRawGetter(device, { port: PORT(), signal });
  const post = makePoster(device, { port: PORT(), signal });
  const raw = {};
  const snap = emptySnapshot(device);
  const sect = { cluster: 'config', metrics: 'capacity', nodes: 'nodes', users: 'accounts', alerts: 'alerts' };
  const step = async (key, fn) => {
    // 취소(signal)면 남은 단계를 시도하지 않는다 — 연결 테스트 타임아웃 뒤 20여 회의 요청이 이어지지 않게(v2.421).
    if (signal?.aborted) throw new Error('수집 취소(타임아웃)');
    try { raw[key] = await fn(); }
    catch (e) { if (sect[key]) snap.sections[sect[key]] = `오류: ${e.message}`; if (/401/.test(e.message) || signal?.aborted) throw e; }
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
    await step('metrics', async () => {
      const r = await fetchSpaceMetrics({ post, csrf, get, rawGet, entity: 'space_metrics_by_cluster', entityId: clusterId });
      raw.metricsDebug = r.debug;
      return r.points;
    });
    // 어플라이언스별 물리 사용량 → pools. 부가 정보라 실패해도 섹션 오류로 만들지 않는다
    // (클러스터 합계가 이미 있으면 화면은 정상 — 여기서 실패를 키우면 '실패'로 오표시된다).
    if (Array.isArray(raw.appliances) && raw.appliances.length) {
      const pools = [];
      for (const a of raw.appliances.slice(0, 32)) {
        if (signal?.aborted) break;
        try {
          const { points: pts } = await fetchSpaceMetrics({ post, csrf, get, rawGet, entity: 'space_metrics_by_appliance', entityId: a.id });
          const pt = pickLatestSpacePoint(pts);
          const t = numOrNull(pt?.physical_total) || 0;
          const u = numOrNull(pt?.physical_used); // v2.597(감사 C2597-05): 결측을 0 으로 두지 않는다(v2.593 DATA-01 누락 지점)
          if (t) pools.push({ name: a.name || a.id || '', totalBytes: t, usedBytes: u, pct: u == null ? null : Math.round((u / t) * 1000) / 10 });
        } catch { /* 어플라이언스 1대 실패가 전체 수집을 망치지 않게 */ }
      }
      if (pools.length) raw.appliancePools = pools;
    }
    await step('nodes', () => get('/api/rest/node?select=id,slot,appliance_id'));
    await step('users', () => get('/api/rest/local_user?select=id,name,is_locked'));
    /* alerts(v2.513 수정) — 예전 쿼리는 `filter=state.eq.ACTIVE` 였는데 PowerStore REST 는
     * **PostgREST 문법**이라 필드명 자체가 쿼리 파라미터다(`state=eq.ACTIVE`). `filter=` 라는
     * 파라미터는 없어서 장비가 `HTTP 400 — Unable to parse passed url.` 로 거부했다
     * (사용자 신고: 다른 섹션은 전부 OK 인데 alerts 만 오류). 다른 쿼리들이 전부 `select=`/`limit=`
     * 만 쓰고 있어 이 한 줄만 문법이 달랐다.
     * 폴백: 버전에 따라 alert 에 `state` 가 없을 수 있으므로, 400 이면 필터 없이 받아 코드에서
     * 거른다(필터 하나 때문에 알람 수집 전체를 잃지 않게). 어느 경로를 썼는지는 화면에 밝힌다. */
    await step('alerts', async () => {
      try {
        const r = await get('/api/rest/alert?select=id,severity&state=eq.ACTIVE&limit=500');
        raw.alertsNote = '';
        return r;
      } catch (e) {
        if (/401/.test(e.message) || signal?.aborted) throw e;
        const all = await get('/api/rest/alert?select=id,severity,state,is_acknowledged&limit=500');
        raw.alertsNote = `state 필터 미지원(${String(e.message).slice(0, 80)}) — 전체를 받아 미해결만 집계`;
        return Array.isArray(all) ? all.filter(isActiveAlert) : all;
      }
    });

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
    await step('perf', async () => (await fetchSpaceMetrics({ post, csrf, get, rawGet, entity: 'performance_metrics_by_cluster', entityId: clusterId, intervals: ['Five_Mins', 'One_Hour'], accept: (pts) => (Array.isArray(pts) ? pts.length > 0 : !!pts) })).points);
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
