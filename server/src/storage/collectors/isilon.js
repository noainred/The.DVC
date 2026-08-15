/**
 * storage/collectors/isilon.js — Isilon/PowerScale(OneFS Platform API) 수집기(v2.302).
 *
 * 공통 수집기 계약(types.js): collect(device) → NormalizedSnapshot.
 * OneFS REST 는 HTTPS(8080) + HTTP Basic 인증을 지원한다. 장비는 대개 자체서명 인증서라
 * **이 모듈 전용 로컬 디스패처**로만 검증을 완화한다(전역 TLS 디스패처 금지 — server/CLAUDE.md).
 *
 * 섹션별 best-effort(iDRAC redfish fetchInventory 와 같은 철학): 한 엔드포인트 실패가 전체
 * 수집을 죽이지 않고, sections{} 에 섹션별 결과('ok'|오류)를 정직하게 남긴다 — OneFS 버전에
 * 따라 경로/필드가 다를 수 있어(8.x/9.x) 주 경로 실패 시 대체 경로를 시도한다.
 * ⚠ 실장비 검증 전(2026-08-15): 엔드포인트는 OneFS Platform API 표준 경로 기준 구현이며,
 *   현장 버전별 차이는 sections 오류 문구로 드러난다 — 첫 실행 후 문구를 보고 보정할 것.
 */

import { Agent } from 'undici';
import { emptySnapshot } from '../types.js';

// Isilon 전용 로컬 TLS 디스패처 — 사내 자체서명 장비 한정(다른 fetch 에 주입 금지).
const isilonDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const PORT = Number(process.env.STORAGE_ISILON_PORT) || 8080;
const TIMEOUT_MS = Number(process.env.STORAGE_HTTP_TIMEOUT_MS) || 15_000;

async function get(device, apiPath) {
  const url = `https://${device.host}:${PORT}${apiPath}`;
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    dispatcher: isilonDispatcher,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 주 경로 실패 시 대체 경로 순차 시도(버전별 경로 차이 흡수). 전부 실패면 마지막 오류 throw. */
async function getAny(device, paths) {
  let err;
  for (const p of paths) {
    try { return await get(device, p); } catch (e) { err = e; }
  }
  throw err;
}

/**
 * OneFS 응답 → NormalizedSnapshot 정규화(순수 — storageMon.test.js 픽스처 고정).
 * raw 인자: { config, stats, nodes, users, pools, events } (섹션별 원본 또는 null).
 */
export function normalizeIsilon(device, raw) {
  const snap = emptySnapshot(device);
  if (raw.config) {
    snap.name = raw.config.name || device.name;
    snap.version = raw.config.onefs_version?.release || raw.config.onefs_version?.version || '';
    snap.serial = raw.config.guid || '';
    snap.sections.config = 'ok';
  }
  if (raw.stats) {
    // /statistics/current 응답: { stats: [{ key, value }] } — ifs.bytes.* 키가 클러스터 용량.
    const byKey = Object.fromEntries((raw.stats.stats || []).map((s) => [s.key, Number(s.value) || 0]));
    const total = byKey['ifs.bytes.total'] || 0;
    const used = byKey['ifs.bytes.used'] || (total && byKey['ifs.bytes.avail'] ? total - byKey['ifs.bytes.avail'] : 0);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
  }
  if (raw.nodes) {
    const list = raw.nodes.nodes || [];
    snap.nodes.count = list.length;
    // OneFS 노드 상태 필드는 버전별 상이(status/health) — 명시적으로 정상 아닌 것만 센다(모르면 0).
    snap.nodes.unhealthy = list.filter((n) => {
      const st = String(n.status || n.health || '').toLowerCase();
      return st && !/ok|healthy|up|green/.test(st);
    }).length;
    snap.sections.nodes = 'ok';
  }
  if (raw.users) {
    snap.accounts = (raw.users.users || []).slice(0, 200)
      .map((u) => ({ name: u.name || u.id || '', enabled: u.enabled !== false }));
    snap.sections.accounts = 'ok';
  }
  if (raw.pools) {
    snap.pools = (raw.pools.storagepools || raw.pools.nodepools || []).slice(0, 32).map((p) => {
      const u = p.usage || {};
      const total = Number(u.total_bytes ?? u.usable_bytes) || 0;
      const used = Number(u.used_bytes) || 0;
      return { name: p.name || '', totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    });
    snap.sections.pools = 'ok';
  }
  if (raw.events) {
    snap.alerts.unresolved = Number(raw.events.total ?? (raw.events.eventgroups || []).length) || 0;
    snap.sections.alerts = 'ok';
  }
  // 성공 판정: 최소한 config 또는 capacity 를 읽었으면 '수집됨'(부분 실패는 sections 가 설명).
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  return snap;
}

export async function collect(device) {
  const raw = { config: null, stats: null, nodes: null, users: null, pools: null, events: null };
  const snap = emptySnapshot(device);
  const trySection = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { snap.sections[key === 'stats' ? 'capacity' : key === 'events' ? 'alerts' : key === 'users' ? 'accounts' : key] = `오류: ${e.message}`; }
  };
  // config 를 먼저 — 인증 실패(401)면 나머지를 시도하지 않고 즉시 실패로 끝낸다(계정 잠금 방지:
  // 잘못된 비번으로 엔드포인트 6개 × 폴링마다 두드리면 장비 쪽 실패 잠금을 유발한다).
  try { raw.config = await get(device, '/platform/1/cluster/config'); }
  catch (e) {
    if (/401/.test(e.message) || /인증 실패/.test(e.message)) {
      const out = normalizeIsilon(device, raw);
      out.error = e.message; out.sections.config = `오류: ${e.message}`;
      return out;
    }
    snap.sections.config = `오류: ${e.message}`;
  }
  await trySection('stats', () => get(device, '/platform/1/statistics/current?key=ifs.bytes.total&key=ifs.bytes.used&key=ifs.bytes.avail&devid=0'));
  await trySection('nodes', () => getAny(device, ['/platform/3/cluster/nodes', '/platform/1/cluster/nodes']));
  await trySection('users', () => get(device, '/platform/1/auth/users?limit=200'));
  await trySection('pools', () => getAny(device, ['/platform/1/storagepool/storagepools', '/platform/1/storagepool/nodepools']));
  await trySection('events', () => getAny(device, ['/platform/3/event/eventgroup-occurrences?resolved=false&limit=1', '/platform/1/event/events?resolved=false&limit=1']));
  const out = normalizeIsilon(device, raw);
  // normalize 가 만든 sections 위에, 시도 단계에서 기록한 오류 문구를 보존(덮어쓰기 방지).
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
  if (!out.ok && !out.error) out.error = out.sections.config !== 'ok' ? String(out.sections.config) : '수집 실패(섹션 오류 참조)';
  return out;
}
