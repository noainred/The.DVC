/**
 * central/unsupportedServers.js — iDRAC 스캔이 발견한 **비-Dell(미지원) 서버**의 중앙 보관소(v2.495).
 *
 * 사용자 요구: 스캔 대역에 HPE 등 Dell 이 아닌 서버가 있으면 특수 기능에 '미지원 서버' 로 보인다.
 *
 * 왜 별도 영속 스토어인가: 위임(엣지) 스캔 잡은 인메모리이고 완료 10분 뒤 gc 된다
 * (central/idracScanJobs.js TTL). 기본 6시간 주기 스캔에서 잡 결과만 믿으면 화면이 하루의 99% 를
 * 빈 채로 있게 된다 — v2.493 에서 고친 '위임 환경에서 빈 화면' 사고의 재생산이다(루트 CLAUDE.md 규칙).
 * central/pduEdge.js 와 같은 구조: 메모리 + 디스크(CONFIG_DIR/central-unsupported-servers.json),
 * atomicWrite + preserveCorrupt, 스캔 **성공 시에만** 해당 키를 교체하고 실패·중단 시 직전 스냅샷 보존.
 *
 * 보안 규약(routes/central.js 3규약): 저장키·귀속(agent/datacenterId/service)은 **본문이 아니라 중앙이
 * 만든 잡 레코드**에서만 취한다 — 호출부가 j.agent/j.datacenterId 를 넘긴다. 또 잡의 대상 IP 범위 밖
 * 항목은 호출부가 드롭한다(침해된 엣지가 다른 법인 관리망 주소를 '미지원 서버' 로 심는 것 차단 —
 * ip-scan-result 선례). 자격증명은 담기지 않는다(IP·벤더·제품·근거만).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { capStr, capTrim } from '../util/capStr.js';

const FILE = path.join(config.configDir, 'central-unsupported-servers.json');
const MAX_PER_KEY = 200;   // 스캔 결과 상한과 동일(중앙 회신 본문 1MB 안)
const MAX_KEYS = 500;      // (agent, 법인, 서비스) 조합 상한 — 무한 증가 방지

let _map = null; // key -> { key, agent, datacenterId, service, at, trigger, count, truncated, servers: [] }

const keyOf = (agent, datacenterId, service) => [
  String(agent || '').trim().toLowerCase(), String(datacenterId || '').trim(), String(service || '').trim(),
].join('|');

function load() {
  if (_map) return _map;
  _map = new Map();
  if (!fs.existsSync(FILE)) return _map;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const e of (parsed?.entries || [])) if (e && e.key) _map.set(e.key, e);
  } catch (e) { preserveCorrupt(FILE, e.message); _map = new Map(); }
  return _map;
}
function persist() {
  try { atomicWriteFileSync(FILE, JSON.stringify({ entries: [...load().values()] }, null, 2), { mode: 0o600 }); }
  catch (e) { console.error('[central-unsupported] 저장 실패:', e.message); }
}

const clean = (x) => ({
  ip: capTrim(x?.ip || '', 64), // v2.607(TIM2607-01): 평탄화 + 길이 상한(예전엔 상한도 없었다)
  // v2.500(감사 L-5): 형제 필드는 모두 절단되는데 이 둘만 무제한이었다(엣지가 보고하는 값이다).
  vendor: capStr(x?.vendor, 60) || 'unknown',
  vendorLabel: capStr(x?.vendorLabel || '', 60),
  evidence: capStr(x?.evidence || '', 200),
  product: capStr(x?.product || '', 120),
  model: capStr(x?.model || '', 120),
  manufacturer: capStr(x?.manufacturer || '', 120),
  hostName: capStr(x?.hostName || '', 120),
  authFailed: !!x?.authFailed,
  at: Number(x?.at) || Date.now(),
});

/**
 * 스캔 1회의 미지원 목록을 그 (agent, 법인, 서비스) 키로 **교체** 저장한다.
 * 호출 전제: 스캔이 성공적으로 끝났다(실패·중단 시에는 부르지 않는다 → 직전 스냅샷 보존).
 * agent '' = 중앙 직접 스캔.
 */
export function saveUnsupportedServers({ agent = '', datacenterId = '', service = '', trigger = '' } = {}, list = [], { count = null, truncated = false } = {}) {
  const key = keyOf(agent, datacenterId, service);
  const src = Array.isArray(list) ? list : [];
  const servers = src.map(clean).filter((x) => x.ip).slice(0, MAX_PER_KEY);
  const m = load();
  if (!m.has(key) && m.size >= MAX_KEYS) {
    let oldest = null; // 가장 오래된 키 제거
    for (const e of m.values()) if (!oldest || (e.at || 0) < (oldest.at || 0)) oldest = e;
    if (oldest) m.delete(oldest.key);
  }
  m.set(key, {
    key, agent: String(agent || ''), datacenterId: String(datacenterId || ''), service: String(service || ''),
    at: Date.now(), trigger: String(trigger || ''),
    count: count != null && Number.isFinite(Number(count)) ? Number(count) : servers.length,
    truncated: !!truncated || servers.length < src.length,
    servers,
  });
  persist();
  return { ok: true, key, saved: servers.length };
}

/** 전체(모든 키) 평탄화 — 화면 표용. 각 행에 귀속(agent/법인/서비스/발견 시각) 포함. */
export function listUnsupportedServers({ datacenterId = '' } = {}) {
  const dc = String(datacenterId || '').trim();
  const rows = [];
  const groups = [];
  for (const e of load().values()) {
    if (dc && String(e.datacenterId || '') !== dc) continue;
    groups.push({ agent: e.agent, datacenterId: e.datacenterId, service: e.service, at: e.at, count: e.count, truncated: e.truncated, trigger: e.trigger });
    for (const s of e.servers || []) rows.push({ ...s, agent: e.agent, datacenterId: e.datacenterId, service: e.service, scannedAt: e.at, source: e.agent ? 'edge' : 'central' });
  }
  rows.sort((a, b) => (b.scannedAt - a.scannedAt) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return { rows, groups, total: rows.length, truncatedGroups: groups.filter((g) => g.truncated).length };
}

/** 테스트용 초기화(파일은 건드리지 않고 메모리만 비운다). */
export function _resetUnsupportedForTest() { _map = null; }
