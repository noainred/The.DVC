/**
 * storage/collectors/unity.js — Dell Unity(480 등) 수집기(v2.309, 사용자 요구).
 * Unisphere REST(https://<mgmt>/api/*, Basic + X-EMC-REST-CLIENT 헤더 필수)를 섹션별
 * best-effort 조회해 공통 스키마로 정규화. GET 은 CSRF 토큰 불필요(쓰기 없음 — 조회 전용).
 * ⚠ 실장비 검증 전: 경로·필드는 Unisphere REST 문서 지식 기반 — 섹션별 오류 문구로 드러남.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter } from './restCommon.js';

const entries = (v) => (v?.entries || []).map((e) => e.content || {});

/** 원시 응답 → 정규화(순수). raw: {system,sw,cap,pools,sps,users,alerts} */
export function normalizeUnity(device, raw) {
  const snap = emptySnapshot(device);
  const sys = entries(raw.system)[0];
  if (sys) {
    snap.name = sys.name || device.name;
    snap.serial = sys.serialNumber || '';
    snap.extra.model = sys.model || '';
    snap.sections.config = 'ok';
  }
  const sw = entries(raw.sw)[0];
  if (sw) snap.version = sw.version || '';
  const cap = entries(raw.cap)[0];
  if (cap) {
    const total = Number(cap.sizeTotal) || 0;
    const used = Number(cap.sizeUsed) || 0;
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
  }
  const pools = entries(raw.pools);
  if (pools.length) {
    snap.pools = pools.slice(0, 32).map((p) => {
      const t = Number(p.sizeTotal) || 0, u = Number(p.sizeUsed) || 0;
      return { name: p.name || '', totalBytes: t, usedBytes: u, pct: t ? Math.round((u / t) * 1000) / 10 : null };
    });
  }
  const sps = entries(raw.sps);
  if (sps.length) {
    // health.value: 5=OK 계열(Unisphere HealthEnum) — 문서 기반, 모르면 unknown 으로 정직 표기.
    const healthOf = (h) => (h?.value === 5 || h?.value === 7 ? 'ok' : h?.value != null ? `health:${h.value}` : 'unknown');
    snap.nodes = { count: sps.length, unhealthy: sps.filter((s) => healthOf(s.health) !== 'ok' && healthOf(s.health) !== 'unknown').length,
      list: sps.slice(0, 64).map((s, i) => ({ id: i + 1, ip: '', health: healthOf(s.health), inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0, name: s.name || s.id || '' })) };
    snap.sections.nodes = 'ok';
  }
  const users = entries(raw.users);
  if (users.length) { snap.accounts = users.slice(0, 200).map((u) => ({ name: u.name || u.id || '', enabled: true })); snap.sections.accounts = 'ok'; }
  if (raw.alerts) { snap.alerts.unresolved = entries(raw.alerts).length; snap.sections.alerts = 'ok'; }
  snap.extra.collectMethod = 'api';
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

export async function collect(device) {
  const get = makeGetter(device, { port: Number(process.env.STORAGE_UNITY_PORT) || 443, headers: { 'X-EMC-REST-CLIENT': 'true' } });
  const raw = {};
  const snap = emptySnapshot(device);
  const sect = { system: 'config', cap: 'capacity', sps: 'nodes', users: 'accounts', alerts: 'alerts' };
  const step = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { if (sect[key]) snap.sections[sect[key]] = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
  };
  try {
    await step('system', () => get('/api/types/system/instances?fields=name,model,serialNumber'));
    await step('sw', () => get('/api/types/installedSoftwareVersion/instances?fields=version'));
    await step('cap', () => get('/api/types/systemCapacity/instances?fields=sizeTotal,sizeUsed,sizeFree'));
    await step('pools', () => get('/api/types/pool/instances?fields=name,sizeTotal,sizeUsed'));
    await step('sps', () => get('/api/types/storageProcessor/instances?fields=name,health'));
    await step('users', () => get('/api/types/user/instances?fields=name'));
    await step('alerts', () => get('/api/types/alert/instances?fields=id&filter=state ne 2&per_page=100'));
  } catch (e) {
    const out = normalizeUnity(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
    return out;
  }
  const out = normalizeUnity(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
  return out;
}
