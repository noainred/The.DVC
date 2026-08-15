/**
 * storage/collectors/powerstore.js — Dell PowerStore 수집기(v2.309, 사용자 요구).
 * PowerStore REST(https://<mgmt>/api/rest/*, Basic 인증)를 섹션별 best-effort 로 조회해
 * 공통 스키마(NormalizedSnapshot)로 정규화한다 — 화면·집계·위임 경로는 타입 무관(types.js 계약).
 * ⚠ 실장비 검증 전: 경로·필드는 PowerStore REST 문서 지식 기반 — 섹션별 오류 문구로 드러남.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter, tryAny } from './restCommon.js';

/** 원시 응답 → 정규화(순수 — storageMon.test.js 픽스처 고정). raw: {cluster,sw,appliances,metrics,nodes,users,alerts} */
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
  // 용량 — space_metrics_by_cluster 최신 1점(physical_total/physical_used 바이트).
  const m = first(raw.metrics);
  if (m) {
    const total = Number(m.physical_total) || 0;
    const used = Number(m.physical_used) || 0;
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
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
  if (Array.isArray(raw.alerts)) { snap.alerts.unresolved = raw.alerts.length; snap.sections.alerts = 'ok'; }
  snap.extra.collectMethod = 'api';
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

export async function collect(device) {
  const get = makeGetter(device, { port: Number(process.env.STORAGE_POWERSTORE_PORT) || 443 });
  const raw = {};
  const snap = emptySnapshot(device);
  const sect = { cluster: 'config', metrics: 'capacity', nodes: 'nodes', users: 'accounts', alerts: 'alerts' };
  const step = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { if (sect[key]) snap.sections[sect[key]] = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
  };
  try {
    await step('cluster', () => get('/api/rest/cluster?select=*')); // 401 이면 여기서 전체 중단(잠금 예방)
    await step('sw', () => get('/api/rest/software_installed?select=release_version,build_version&limit=1'));
    await step('appliances', () => get('/api/rest/appliance?select=id,name,model,service_tag'));
    await step('metrics', () => tryAny(get, ['/api/rest/space_metrics_by_cluster?select=*&order=timestamp.desc&limit=1', '/api/rest/space_metrics_by_appliance?select=*&order=timestamp.desc&limit=1']));
    await step('nodes', () => get('/api/rest/node?select=id,slot'));
    await step('users', () => get('/api/rest/local_user?select=id,name,is_locked'));
    await step('alerts', () => get('/api/rest/alert?select=id&filter=state.eq.ACTIVE&limit=100'));
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
