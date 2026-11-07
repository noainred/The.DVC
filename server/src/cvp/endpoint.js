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
 * 404 본문 판정(v2.929 반증 H-2 — 실장비 표본 전 추정). gRPC-gateway 오류 JSON 의 message 가 'Not Found' 보다 구체적(…not found)이면
 *   '그 MAC 의 위치 없음' 이다. 'Not Found' 한 마디 · HTML · 빈 본문은 경로 없음(미지원)과 키 없음을 가를 수 없다 → 'ambiguous'.
 */
export function notFoundKind(head) {
  const s = String(head || '').slice(0, 2000);
  const m = /"(?:message|error)"\s*:\s*"([^"]{0,300})"/.exec(s);
  const msg = m ? m[1].trim() : '';
  if (msg && /not\s*found|no\s+such|does\s+not\s+exist/i.test(msg) && !/^not\s*found$/i.test(msg)) return 'none';
  return 'ambiguous';
}
/** 본문 앞부분 표본(진단 — 첫 실캡처를 남긴다). 제어문자 제거 · 120자. */
const headSample = (h) => String(h || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120); // eslint-disable-line no-control-regex

/**
 * 세션(openSession 결과)으로 MAC 들을 묻는다 — 차례로(동시 2) · 시간 예산.
 *   · 501 → 미지원으로 멈춘다. 404 는 본문으로 가른다(notFoundKind): 구체적 not found = 위치 없음. 가를 수 없는 404 는
 *     이 조회에서 답한 MAC(200)이 하나라도 있으면 위치 없음, 답한 MAC 없이 AMBIG_STOP 번 이어지면 미지원으로 멈춘다(pNIC MAC 몇 개가
 *     안 배워졌다고 CVP 전체를 미지원으로 적지 않게 — v2.929 반증 H-2). 끝까지 못 가르면 오류(사유와 본문 표본)로 남긴다.
 *   · 연결 실패 · 401 · 403 이 FAIL_STOP 번 이어지면 그 CVP 는 이번에 그만 묻는다(v2.929 반증 L-6 — 틀린 자격증명으로 MAC 마다 로그인 금지).
 * @returns {Promise<{ results: Array<{mac, at, status, reason?, locations}>, unsupported: boolean, cut: number, stopped: string|null }>}
 */
export const AMBIG_STOP = 8;
export const FAIL_STOP = 3;
export async function lookupEndpoints(session, macs = [], { budgetMs = 20_000, now = Date.now, signal = null, concurrency = 2 } = {}) {
  const list = [...new Set((Array.isArray(macs) ? macs : []).map((m) => normMac(m)).filter((m) => m && m.length === 12))];
  const results = []; let unsupported = false; let cut = 0; let stopped = null;
  let seenOk = false; let ambigRun = 0; let failRun = 0;
  const pending = [];   // 가를 수 없는 404 — 답한 MAC 이 나오면 none, 미지원으로 판정되면 unsupported
  const end = Date.now() + budgetMs;
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      if (unsupported || stopped || signal?.aborted || Date.now() >= end) return;
      const mac = list[i++];
      const r = await session.get(epQueryPath(mac));
      const at = now();
      if (r.ok) {
        failRun = 0; ambigRun = 0;
        const p = parseEndpointLocation(r.text);
        if (!p.parsed) { results.push({ mac, at, status: 'error', reason: '응답 형식을 알아보지 못했습니다(JSON 아님)', locations: [] }); continue; }
        seenOk = true;
        results.push({ mac, at, status: p.locations.length ? 'ok' : 'none', locations: p.locations });
        continue;
      }
      if (r.status === 501) { unsupported = true; results.push({ mac, at, status: 'unsupported', reason: 'HTTP 501 — 이 CVP 에 EndpointLocation API 가 없습니다(2021.1 이상 필요)', locations: [] }); return; }
      if (r.status === 404) {
        failRun = 0;
        if (notFoundKind(r.head) === 'none' || seenOk) { results.push({ mac, at, status: 'none', locations: [] }); continue; }
        ambigRun += 1;
        pending.push({ mac, at, sample: headSample(r.head) });
        if (ambigRun >= AMBIG_STOP) { unsupported = true; return; }
        continue;
      }
      ambigRun = 0;
      results.push({ mac, at, status: 'error', reason: String(r.reason || `HTTP ${r.status}`).slice(0, 200), locations: [] });
      if (r.status === 0 || r.status === 401 || r.status === 403) {
        failRun += 1;
        if (failRun >= FAIL_STOP) stopped = r.status === 0 ? 'conn' : 'auth';
      } else failRun = 0;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, worker));
  for (const p of pending) {
    if (seenOk) results.push({ mac: p.mac, at: p.at, status: 'none', locations: [] });
    else if (unsupported) results.push({ mac: p.mac, at: p.at, status: 'unsupported', reason: `HTTP 404 이 ${AMBIG_STOP}번 이어졌고 답한 MAC 이 없습니다 — EndpointLocation API 가 없는 것으로 봅니다(2021.1 이상 필요)${p.sample ? ` · 본문: ${p.sample}` : ''}`, locations: [] });
    else results.push({ mac: p.mac, at: p.at, status: 'error', reason: `HTTP 404 — 위치 없음인지 API 미지원인지 가르지 못했습니다(이번 조회에서 답한 MAC 없음)${p.sample ? ` · 본문: ${p.sample}` : ''}`, locations: [] });
  }
  cut = Math.max(0, list.length - results.length);
  return { results, unsupported, cut, stopped };
}

/**
 * 주기 수집 대상 고르기(순수) — ① 호스트 물리 NIC MAC ② 최근에 호스트가 바뀐 VM(vMotion) ③ 나머지 VM. 셋 다 **가장 오래전에 물어본 것부터**.
 *   이미 이번 창(staleMs) 안에 물어본 MAC 은 건너뛴다. max 개까지. 호스트 몫은 max 의 절반까지(VM 이 있을 때) —
 *   v2.929 반증 M-1: 예전에는 호스트 MAC 을 스냅샷 순서로 골라, 호스트 MAC 이 상한보다 많으면 매 주기 같은 앞부분만 묻고 VM 은 한 번도 묻지 않았다.
 * @param {{ hostMacs:string[], movedVmMacs:string[], vmMacs:string[], askedAt:Map<string,number> }} input
 */
export function pickEndpointMacs({ hostMacs = [], movedVmMacs = [], vmMacs = [], askedAt = new Map() } = {}, { now = Date.now(), max = 200, staleMs = 30 * 60_000 } = {}) {
  const out = []; const used = new Set();
  const fresh = (m) => now - (askedAt.get(m) || 0) < staleMs;
  const oldest = (arr) => [...new Set(arr)].filter((m) => m && !fresh(m)).sort((a, b) => (askedAt.get(a) || 0) - (askedAt.get(b) || 0));
  const take = (arr, cap) => { let n = 0; for (const m of arr) { if (out.length >= max || n >= cap) return; if (used.has(m)) continue; used.add(m); out.push(m); n += 1; } };
  const vmsWaiting = movedVmMacs.length + vmMacs.length > 0;
  take(oldest(hostMacs), vmsWaiting ? Math.ceil(max / 2) : max);
  take(oldest(movedVmMacs), max);
  take(oldest(vmMacs), max);
  if (out.length < max) take(oldest(hostMacs), max);   // VM 몫이 남으면 호스트를 더
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
