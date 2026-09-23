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
import { withSsrfLookup } from '../../util/ssrfLookup.js';
import { emptySnapshot } from '../types.js';
// v2.513: 전송 계층 실패(`fetch failed`·`aborted`)를 행동 가능한 사유로 — restCommon 과 같은 규약.
import { describeFetchError, isTransportError } from './netError.js';
import { healthWord } from '../healthWord.js'; // v2.586 — 노드 상태 판정 단일 소스
import { numOrNull } from '../../util/numOrNull.js';

// Isilon 전용 로컬 TLS 디스패처 — 사내 자체서명 장비 한정(다른 fetch 에 주입 금지).
// 보안(M-4): STORAGE_TLS_VERIFY=true 면 인증서 검증을 켠다(기본은 기존대로 해제).
// v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. v2.506 배선(11곳)에서 빠져 있던 dispatcher.
const isilonDispatcher = new Agent({ connect: withSsrfLookup({ rejectUnauthorized: process.env.STORAGE_TLS_VERIFY === 'true' }) });
const PORT = Number(process.env.STORAGE_ISILON_PORT) || 8080;
const TIMEOUT_MS = Number(process.env.STORAGE_HTTP_TIMEOUT_MS) || 15_000;

export async function get(device, apiPath) { // v2.308: 영역 수집기(areasCollector)가 재사용
  const url = `https://${device.host}:${PORT}${apiPath}`;
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      dispatcher: isilonDispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (!isTransportError(e)) throw e;
    throw new Error(describeFetchError(e, { host: device.host, port: PORT, timeoutMs: TIMEOUT_MS }), { cause: e });
  }
  if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 주 경로 실패 시 대체 경로 순차 시도(버전별 경로 차이 흡수). 전부 실패면 마지막 오류 throw. */
export async function getAny(device, paths) {
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
    // v2.593(감사 DATA-01): 사용량을 못 읽으면 0 이 아니라 null — 0 은 '비었다' 는 거짓이고 증가량에 거짓 급변을 만든다(v2.561 규약).
    const usedRaw = (raw.stats.stats || []).find((s) => s.key === 'ifs.bytes.used');
    const availRaw = (raw.stats.stats || []).find((s) => s.key === 'ifs.bytes.avail');
    const usedN = numOrNull(usedRaw?.value), availN = numOrNull(availRaw?.value);
    const used = usedN != null ? usedN : (total && availN != null ? total - availN : null);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total && used != null ? Math.round((used / total) * 1000) / 10 : null };
    // 미디어(디스크 풀) 분리(v2.303, 사용자 요구 — isi status 의 HDD/SSD 컬럼): OneFS 통계 키
    // ifs.ssd.bytes.* 가 SSD 풀 전용 카운터이고, ifs.bytes.* 는 클러스터 전체(HDD+SSD 스토리지)
    // 합이다 — HDD = 전체 − SSD 로 산출한다. ⚠ SSD 가 메타데이터 전용(L3/VHS)인 구성에서는
    // ifs.ssd.bytes.* 가 0 또는 부재일 수 있어 그 경우 media.ssd 는 0 으로, HDD=전체가 된다
    // (실장비 검증 전 가정 — 값이 이상하면 섹션 상태/실측으로 보정할 것, 은폐하지 않음).
    const ssdTotal = byKey['ifs.ssd.bytes.total'] || 0;
    const ssdUsed = byKey['ifs.ssd.bytes.used'] || (ssdTotal && byKey['ifs.ssd.bytes.avail'] ? ssdTotal - byKey['ifs.ssd.bytes.avail'] : 0);
    // total 0 인 미디어는 null — '풀 없음'(SSD 메타 전용/무SSD 구성)을 0TB 로 오표시하지 않는다.
    // v2.594(감사 R2594-03): 사용량을 못 읽었으면(used null) HDD 사용량·% 도 null — max(0, null − x) 는 0 이 되어
    // '비었다' 는 거짓이 DB hdd_used 에 적재됐다.
    const mk = (t, u) => (t > 0 ? { totalBytes: t, usedBytes: u, pct: u == null ? null : Math.round((u / t) * 1000) / 10 } : null);
    snap.media = {
      hdd: mk(Math.max(0, total - ssdTotal), used == null ? null : Math.max(0, used - ssdUsed)),
      ssd: mk(ssdTotal, ssdUsed),
    };
    snap.sections.capacity = 'ok';
  }
  if (raw.nodes) {
    const list = raw.nodes.nodes || [];
    snap.nodes.count = list.length;
    // OneFS 노드 상태 필드는 버전별 상이(status/health) — 명시적으로 정상 아닌 것만 센다(모르면 0).
    const healthOf = (n) => String(n.status?.health ?? n.status ?? n.health ?? '').toLowerCase() || 'unknown';
    // v2.586 — 판정은 `storage/healthWord.js` 하나(앵커 없는 부분 일치가 'unhealthy'·'broken' 을 정상으로 셌다).
    snap.nodes.unhealthy = list.filter((n) => healthWord(healthOf(n)) === 'bad').length;
    // 노드별 상세(v2.303) — devid(lnn) 기준으로 노드별 통계를 조인. IP 필드는 버전별 상이라
    // 흔한 후보(ip/ip_address/ip_addresses[0]/ext_ip)를 순서대로 취하고 없으면 ''(정직 표기 — 위조 금지).
    const perNode = new Map(); // devid → { key → value }
    for (const r of (raw.nodeStats?.stats || [])) {
      if (r.devid == null) continue;
      if (!perNode.has(r.devid)) perNode.set(r.devid, {});
      perNode.get(r.devid)[r.key] = Number(r.value) || 0;
    }
    const mkPool = (t, u) => (t > 0 ? { totalBytes: t, usedBytes: u, pct: u == null ? null : Math.round((u / t) * 1000) / 10 } : null); // total 0 = 무디스크(No Storage HDDs)
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    snap.nodes.list = list.slice(0, 64).map((n) => {
      const lnn = n.lnn ?? n.id;
      const st = perNode.get(lnn) || {};
      return {
        id: lnn,
        ip: String(n.ip || n.ip_address || (Array.isArray(n.ip_addresses) ? n.ip_addresses[0] : '') || n.ext_ip || ''),
        health: healthOf(n),
        inBps: st['node.net.ext.bytes.in.rate'] ?? null,
        outBps: st['node.net.ext.bytes.out.rate'] ?? null,
        hdd: mkPool(Math.max(0, (st['node.ifs.bytes.total'] || 0) - (st['node.ifs.ssd.bytes.total'] || 0)),
                    has(st, 'node.ifs.bytes.used') ? Math.max(0, st['node.ifs.bytes.used'] - (st['node.ifs.ssd.bytes.used'] || 0)) : null),
        ssd: mkPool(st['node.ifs.ssd.bytes.total'] || 0, has(st, 'node.ifs.ssd.bytes.used') ? st['node.ifs.ssd.bytes.used'] : null),
      };
    });
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
      const used = numOrNull(u.used_bytes);
      return { name: p.name || '', totalBytes: total, usedBytes: used, pct: total && used != null ? Math.round((used / total) * 1000) / 10 : null };
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
  // 수집 방식 분기(v2.304): 기본 ssh(isi status 파싱 — isilonSsh.js), 'api' 선택 시 아래 REST 경로.
  if (device.collectMethod !== 'api') {
    const { collectViaSsh } = await import('./isilonSsh.js');
    return collectViaSsh(device);
  }
  const raw = { config: null, stats: null, nodes: null, nodeStats: null, users: null, pools: null, events: null };
  const snap = emptySnapshot(device);
  const trySection = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { if (key === 'nodeStats') { snap.sections.nodeStats = `오류: ${e.message}`; return; } snap.sections[key === 'stats' ? 'capacity' : key === 'events' ? 'alerts' : key === 'users' ? 'accounts' : key] = `오류: ${e.message}`; }
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
  await trySection('stats', () => get(device, '/platform/1/statistics/current?key=ifs.bytes.total&key=ifs.bytes.used&key=ifs.bytes.avail&key=ifs.ssd.bytes.total&key=ifs.ssd.bytes.used&key=ifs.ssd.bytes.avail&devid=0'));
  await trySection('nodes', () => getAny(device, ['/platform/3/cluster/nodes', '/platform/1/cluster/nodes']));
  // 노드별 통계(v2.303, 사용자 요구 — isi status 노드 표): devid=all 이면 stats[] 각 행에
  // devid(=노드 lnn)가 붙어 노드 단위 값이 온다. node.ifs.bytes.* = 노드 로컬 디스크 풀,
  // node.net.ext.bytes.{in,out}.rate = 외부망 처리량(B/s). 실패해도 노드 수/상태(nodes 섹션)는 유지.
  await trySection('nodeStats', () => get(device, '/platform/1/statistics/current?devid=all'
    + '&key=node.ifs.bytes.total&key=node.ifs.bytes.used&key=node.ifs.ssd.bytes.total&key=node.ifs.ssd.bytes.used'
    + '&key=node.net.ext.bytes.in.rate&key=node.net.ext.bytes.out.rate'));
  await trySection('users', () => get(device, '/platform/1/auth/users?limit=200'));
  await trySection('pools', () => getAny(device, ['/platform/1/storagepool/storagepools', '/platform/1/storagepool/nodepools']));
  await trySection('events', () => getAny(device, ['/platform/3/event/eventgroup-occurrences?resolved=false&limit=1', '/platform/1/event/events?resolved=false&limit=1']));
  const out = normalizeIsilon(device, raw);
  // normalize 가 만든 sections 위에, 시도 단계에서 기록한 오류 문구를 보존(덮어쓰기 방지).
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
  if (!out.ok && !out.error) out.error = out.sections.config !== 'ok' ? String(out.sections.config) : '수집 실패(섹션 오류 참조)';
  return out;
}
