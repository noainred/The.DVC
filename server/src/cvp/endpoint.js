/**
 * cvp/endpoint.js — CVP EndpointLocation(v2.929 SAN·CVP 설계 C-③ — docs/design/san-cvp-traffic/README.md §9). 파서 · 조회 · 대상 고르기.
 *
 * 무엇: CVP Resource API `GET /api/resources/endpointlocation/v1/EndpointLocation?key.searchTerm=<MAC|IP>` 는 '이 MAC 을 지금 어느 장비 ·
 *   어느 인터페이스에서 배웠나' 를 CVP 가 MAC · ARP · LLDP 표를 모아 답한다(CVP 2021.1+ · GetAll 없음 — MAC 하나에 요청 1회).
 *   B-② 의 LLDP · MAC 테이블과 근거가 겹치지만 **단건 조회가 빠르고** VLAN · 학습 유형 · 시각을 같이 준다(vMotion 직후 위치 확인 — B-② 반증 L-5).
 *
 * ⚠ 정직: 경로 · 응답 필드 이름은 공개 문서(aristanetworks.github.io cloudvision-apis) 기준이고 **실장비로 확인하지 못했다**.
 *   그래서 파서는 응답 모양에 관용적이다 — 어느 깊이든 `interface` 글자와 장비 식별자(deviceId · device_id · serialNumber)를 가진 객체를 위치로 본다.
 *   404 · 501 은 '이 CVP 가 이 API 를 모른다'(2021.1 미만) — 그 CVP 는 미지원으로 적고 그 주기의 나머지를 묻지 않는다.
 */
import { normMac } from './parse.js';

export const EP_PATH = '/api/resources/endpointlocation/v1/EndpointLocation';
export const EP_LOC_MAX = 16;
const TEXT_MAX = 1_048_576;

/** 조회 경로(MAC 은 콜론 표기 — CVP 문서 예제 형식). */
export function epQueryPath(mac12) {
  const m = String(mac12 || '').toLowerCase();
  const term = /^[0-9a-f]{12}$/.test(m) ? m.replace(/(..)(?=.)/g, '$1:') : m;
  return `${EP_PATH}?key.searchTerm=${encodeURIComponent(term)}`;
}

const str = (v, n = 64) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const intOr = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v.trim()) ? Number(v) : NaN; return Number.isInteger(n) && n >= 0 && n <= 4095 ? n : null; };

/**
 * 응답 본문(한 JSON 또는 줄마다 JSON — Resource API 스트림) → { locations:[{device, port, vlan, learnedAt, macType, likelihood}], parsed }.
 *   parsed=false 는 JSON 이 아니었다(형식 미인식 — '위치 없음' 이 아니다).
 */
export function parseEndpointLocation(text) {
  const s = String(text ?? '').slice(0, TEXT_MAX);
  const docs = [];
  try { docs.push(JSON.parse(s)); } catch {
    for (const line of s.split('\n')) { const t = line.trim(); if (!t) continue; try { docs.push(JSON.parse(t)); } catch { /* 다음 줄 */ } }
  }
  if (!docs.length) return { locations: [], parsed: false };
  const out = []; const seen = new Set();
  const visit = (o, depth, parentDevice) => {
    if (!o || typeof o !== 'object' || depth > 12 || out.length >= EP_LOC_MAX) return;
    if (Array.isArray(o)) { for (const x of o.slice(0, 256)) visit(x, depth + 1, parentDevice); return; }
    const dev = str(o.deviceId) || str(o.device_id) || str(o.serialNumber) || str(o.deviceSerial) || parentDevice;
    const port = str(o.interface) || str(o.interfaceName) || str(o.intf);
    if (port && dev) {
      const k = `${dev}|${port}|${intOr(o.vlanId ?? o.vlan_id ?? o.vlan) ?? ''}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ device: dev, port, vlan: intOr(o.vlanId ?? o.vlan_id ?? o.vlan), learnedAt: str(o.learnedTime ?? o.learned_time, 40),
          macType: str(o.macType ?? o.mac_type, 40), likelihood: str(o.likelihood, 40) });
      }
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') visit(v, depth + 1, k === 'values' || k === 'deviceMap' ? parentDevice : dev);
  };
  for (const d of docs) visit(d, 0, null);
  return { locations: out, parsed: true };
}

/**
 * 세션(openSession 결과)으로 MAC 들을 묻는다 — 차례로(동시 2) · 시간 예산 · 404/501 이면 미지원으로 멈춘다.
 * @returns {Promise<{ results: Array<{mac, at, status, reason?, locations}>, unsupported: boolean, cut: number }>}
 */
export async function lookupEndpoints(session, macs = [], { budgetMs = 20_000, now = Date.now, signal = null, concurrency = 2 } = {}) {
  const list = [...new Set((Array.isArray(macs) ? macs : []).map((m) => normMac(m)).filter((m) => m && m.length === 12))];
  const results = []; let unsupported = false; let cut = 0;
  const end = Date.now() + budgetMs;
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      if (unsupported || signal?.aborted || Date.now() >= end) return;
      const mac = list[i++];
      const r = await session.get(epQueryPath(mac));
      const at = now();
      if (!r.ok) {
        if (r.status === 404 || r.status === 501) { unsupported = true; results.push({ mac, at, status: 'unsupported', reason: `HTTP ${r.status} — 이 CVP 에 EndpointLocation API 가 없습니다(2021.1 이상 필요)`, locations: [] }); return; }
        results.push({ mac, at, status: 'error', reason: String(r.reason || `HTTP ${r.status}`).slice(0, 200), locations: [] });
        continue;
      }
      const p = parseEndpointLocation(r.text);
      if (!p.parsed) { results.push({ mac, at, status: 'error', reason: '응답 형식을 알아보지 못했습니다(JSON 아님)', locations: [] }); continue; }
      results.push({ mac, at, status: p.locations.length ? 'ok' : 'none', locations: p.locations });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, worker));
  cut = Math.max(0, list.length - results.length);
  return { results, unsupported, cut };
}

/**
 * 주기 수집 대상 고르기(순수) — ① 호스트 물리 NIC MAC 전부 ② 최근에 호스트가 바뀐 VM(vMotion) ③ 나머지 VM 은 가장 오래전에 물어본 것부터.
 *   이미 이번 창(staleMs) 안에 물어본 MAC 은 ①·② 라도 건너뛴다. max 개까지.
 * @param {{ hostMacs:string[], movedVmMacs:string[], vmMacs:string[], askedAt:Map<string,number> }} input
 */
export function pickEndpointMacs({ hostMacs = [], movedVmMacs = [], vmMacs = [], askedAt = new Map() } = {}, { now = Date.now(), max = 200, staleMs = 30 * 60_000 } = {}) {
  const out = []; const used = new Set();
  const fresh = (m) => now - (askedAt.get(m) || 0) < staleMs;
  const take = (arr) => { for (const m of arr) { if (out.length >= max) return; if (!m || used.has(m) || fresh(m)) continue; used.add(m); out.push(m); } };
  take([...new Set(hostMacs)]);
  take([...new Set(movedVmMacs)]);
  const rest = [...new Set(vmMacs)].filter((m) => !used.has(m)).sort((a, b) => (askedAt.get(a) || 0) - (askedAt.get(b) || 0));
  take(rest);
  return out;
}

const _vmHost = new Map();   // vmId → { host, movedAt }
/** VM 이 호스트를 바꿨는지 기억한다(인메모리) — 바뀐 지 windowMs 안이면 '최근 이동'. 첫 관측은 이동으로 보지 않는다. */
export function noteVmHosts(vms = [], { now = Date.now(), windowMs = 24 * 3600_000 } = {}) {
  const moved = new Set(); const live = new Set();
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v?.id) continue;
    live.add(v.id);
    const prev = _vmHost.get(v.id);
    if (prev && prev.host !== v.host) _vmHost.set(v.id, { host: v.host, movedAt: now });
    else if (!prev) _vmHost.set(v.id, { host: v.host, movedAt: 0 });
    const cur = _vmHost.get(v.id);
    if (cur.movedAt && now - cur.movedAt < windowMs) moved.add(v.id);
  }
  for (const k of [..._vmHost.keys()]) if (!live.has(k)) _vmHost.delete(k);
  return moved;
}
export function _resetVmHosts() { _vmHost.clear(); }
