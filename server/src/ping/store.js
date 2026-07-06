/**
 * Ping 모니터링 대상 레지스트리 — CONFIG_DIR/ping-targets.json.
 * 대상: { id, name, host, port, kind('icmp'|'tcp'), enabled, baselineMs(선택,수동 기준), note }.
 *  - kind='icmp': OS ping으로 도달성/RTT(무 CLI 환경은 util/ping이 TCP 폴백)
 *  - kind='tcp' : host:port TCP 연결 지연(제어플레인 443 등 방화벽으로 ICMP 막힌 대상에 적합)
 * baselineMs를 지정하면 그 값을 경보 기준으로, 없으면 최근 OK 샘플의 중앙값을 자동 기준으로 쓴다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'ping-targets.json');
const norm = (s) => String(s || '').trim();
const idOf = (s) => norm(s).toLowerCase();
const SAFE_HOST = /^[a-zA-Z0-9._:-]+$/; // 명령/주소 인젝션 방지

let cache = null;
let cacheTok = '';
function fileTok() { try { const st = fs.statSync(FILE); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } }

function loadRaw() {
  const t = fileTok();
  if (cache && t === cacheTok) return cache;
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {
      targets: Array.isArray(p.targets) ? p.targets : [],
      // 이미 자동 시드한 vCenter id 목록(tombstone). 사용자가 자동 대상을 삭제해도
      // 재시드로 되살아나지 않게 한다(수동 삭제 의사 존중).
      seededVc: Array.isArray(p.seededVc) ? p.seededVc.map(String) : [],
      // 자동 시드한 엣지 노드 id(tombstone) — 네트워크 체크(서버 Ping)용.
      seededEdge: Array.isArray(p.seededEdge) ? p.seededEdge.map(String) : [],
      // vCenter 포트 응답속도에서 측정할 포트 목록(모든 vCenter에 공통 적용).
      vcPorts: Array.isArray(p.vcPorts) ? p.vcPorts.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535) : [],
    };
  } catch { cache = { targets: [], seededVc: [], seededEdge: [], vcPorts: [] }; }
  cacheTok = t;
  return cache;
}

/** URL/호스트에서 호스트명(또는 IP)만 추출 — 'https://vc.corp:443/path' → 'vc.corp'. */
function hostFromUrl(h) {
  const s = String(h || '').trim();
  if (!s) return '';
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname; }
  catch { return s.replace(/^https?:\/\//i, '').replace(/[/:].*$/, ''); }
}

function save(next) {
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  cacheTok = fileTok();
}

function clean(t) {
  return {
    id: t.id, name: t.name, host: t.host, port: t.port, kind: t.kind,
    enabled: t.enabled !== false, baselineMs: t.baselineMs || null, note: t.note || '',
    // source: 대상 출처. 'manual'(수동)|'vcenter'(vCenter 시드)|'edge'(엣지 노드)|'vcport'(vCenter 포트).
    // 메뉴별로 이 값으로 필터링해 서로 섞이지 않게 한다.
    source: t.source || 'manual',
    datacenterId: t.datacenterId || '',  // 네트워크 체크(서버 Ping) DataCenter 그룹핑용
    vcenterId: t.vcenterId || '',        // vCenter 포트 응답속도 그룹핑용
  };
}

/** 등록된 대상 목록(사본). source 지정 시 해당 출처만. */
export function listTargets(source = null) {
  const all = loadRaw().targets.map(clean);
  return source ? all.filter((t) => t.source === source) : all;
}

/** 활성 대상만(폴러용) — 모든 출처 포함. */
export function enabledTargets() { return loadRaw().targets.filter((t) => t.enabled !== false).map(clean); }

export function getTarget(id) { const t = loadRaw().targets.find((x) => x.id === idOf(id)); return t ? clean(t) : null; }

function normalize(body = {}, prev = null) {
  const kind = body.kind === 'tcp' ? 'tcp' : (body.kind === 'icmp' ? 'icmp' : (prev?.kind || 'icmp'));
  const host = norm(body.host != null ? body.host : prev?.host);
  const name = norm(body.name != null ? body.name : prev?.name) || host;
  let port = Number(body.port != null ? body.port : prev?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = kind === 'tcp' ? 443 : 0;
  let baselineMs = body.baselineMs != null ? Number(body.baselineMs) : (prev?.baselineMs || null);
  if (!Number.isFinite(baselineMs) || baselineMs <= 0) baselineMs = null;
  return {
    name: name.slice(0, 80), host, port, kind,
    enabled: body.enabled != null ? body.enabled !== false : (prev ? prev.enabled !== false : true),
    baselineMs, note: norm(body.note != null ? body.note : prev?.note).slice(0, 200),
    source: body.source || prev?.source || 'manual',
    datacenterId: idOf(body.datacenterId != null ? body.datacenterId : prev?.datacenterId),
    vcenterId: norm(body.vcenterId != null ? body.vcenterId : prev?.vcenterId),
  };
}

export function addTarget(body = {}) {
  const cur = loadRaw();
  let id = idOf(body.id);
  const n = normalize(body);
  if (!n.host) return { ok: false, reason: 'host(대상 주소)가 필요합니다.' };
  if (!SAFE_HOST.test(n.host)) return { ok: false, reason: 'host 형식이 올바르지 않습니다(영문/숫자/.:-_ 만 허용).' };
  if (n.kind === 'tcp' && !n.port) return { ok: false, reason: 'TCP 대상은 port가 필요합니다.' };
  if (!id) id = `t_${Date.now().toString(36)}_${cur.targets.length}`;
  if (cur.targets.some((t) => t.id === id)) return { ok: false, reason: `이미 존재하는 대상 id: ${id}` };
  const entry = { id, ...n };
  try { save({ ...cur, targets: [...cur.targets, entry] }); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, target: clean(entry) };
}

export function updateTarget(id, body = {}) {
  const cur = loadRaw();
  const idx = cur.targets.findIndex((t) => t.id === idOf(id));
  if (idx === -1) return { ok: false, reason: `없는 대상: ${id}` };
  const n = normalize(body, cur.targets[idx]);
  if (!n.host) return { ok: false, reason: 'host(대상 주소)가 필요합니다.' };
  if (!SAFE_HOST.test(n.host)) return { ok: false, reason: 'host 형식이 올바르지 않습니다.' };
  if (n.kind === 'tcp' && !n.port) return { ok: false, reason: 'TCP 대상은 port가 필요합니다.' };
  const entry = { id: cur.targets[idx].id, ...n };
  try { save({ ...cur, targets: cur.targets.map((t, i) => (i === idx ? entry : t)) }); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, target: clean(entry) };
}

export function removeTarget(id) {
  const cur = loadRaw();
  const tid = idOf(id);
  if (!cur.targets.some((t) => t.id === tid)) return { ok: false, reason: `없는 대상: ${id}` };
  try { save({ ...cur, targets: cur.targets.filter((t) => t.id !== tid) }); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, id: tid };
}

/**
 * vCenter 목록을 Ping 대상으로 자동 시드. vCenter는 제어플레인(HTTPS 443) 지연이 가장
 * 신뢰성 있는 신호이므로 TCP 443으로 등록한다(ICMP가 방화벽에 막힌 사이트에서도 동작).
 * 이미 시드한 vCenter(seededVc)나 같은 id의 대상이 있으면 건너뛴다 — 재시작마다 중복/부활 없음.
 * @param {Array<{id,host,name}>} vcenters loadVcenterConfig().vcenters
 */
export function seedVcenterTargets(vcenters = []) {
  const cur = loadRaw();
  const seeded = new Set(cur.seededVc);
  const existing = new Set(cur.targets.map((t) => t.id));
  const added = [];
  for (const vc of (Array.isArray(vcenters) ? vcenters : [])) {
    const vcId = idOf(vc && vc.id);
    if (!vcId || seeded.has(vcId)) continue;   // 이미 처리한 vCenter는 건너뜀(삭제해도 부활 방지)
    seeded.add(vcId);                          // 성공/실패와 무관하게 시드 완료로 기록(매번 재시도 방지)
    const host = hostFromUrl(vc.host);
    if (!host || !SAFE_HOST.test(host)) continue; // 잘못된 호스트는 대상 생성 생략(시드 기록만)
    const id = `vc_${vcId}`;
    if (existing.has(id)) continue;
    added.push({ id, name: (norm(vc.name) || host).slice(0, 80), host, port: 443, kind: 'tcp', enabled: true, baselineMs: null, note: 'vCenter 자동 등록', source: 'vcenter' });
  }
  // 변경 없음(추가도 없고 seededVc도 그대로)이면 쓰기 생략.
  if (!added.length && seeded.size === cur.seededVc.length) return { ok: true, added: 0 };
  try { save({ ...cur, targets: [...cur.targets, ...added], seededVc: [...seeded] }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}`, added: 0 }; }
  return { ok: true, added: added.length };
}

/**
 * 엣지 노드(수집 서버)를 '네트워크 체크(서버 Ping)' 대상으로 자동 시드. 각 엣지 노드의
 * URL에서 호스트/포트를 추출해 TCP 연결 지연을 측정하고, 소속 DataCenter로 그룹핑한다.
 * source='edge'. seededEdge tombstone으로 삭제 후 부활 방지.
 * @param {Array<{id,name,url,datacenter}>} collectors listCollectors()
 */
export function seedEdgeTargets(collectors = []) {
  const cur = loadRaw();
  const seeded = new Set(cur.seededEdge);
  const existing = new Set(cur.targets.map((t) => t.id));
  const added = [];
  for (const c of (Array.isArray(collectors) ? collectors : [])) {
    const cid = idOf(c && (c.id || c.name));
    if (!cid || seeded.has(cid)) continue;
    seeded.add(cid);
    const host = hostFromUrl(c.url);
    if (!host || !SAFE_HOST.test(host)) continue;
    let port = 443;
    try { const u = new URL(/^https?:\/\//i.test(c.url) ? c.url : `http://${c.url}`); port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { /* 기본 443 */ }
    const id = `edge_${cid}`;
    if (existing.has(id)) continue;
    added.push({ id, name: (norm(c.name) || host).slice(0, 80), host, port, kind: 'tcp', enabled: true, baselineMs: null, note: '엣지 노드 자동 등록', source: 'edge', datacenterId: idOf(c.datacenter) });
  }
  if (!added.length && seeded.size === cur.seededEdge.length) return { ok: true, added: 0 };
  try { save({ ...cur, targets: [...cur.targets, ...added], seededEdge: [...seeded] }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}`, added: 0 }; }
  return { ok: true, added: added.length };
}

/** vCenter 포트 응답속도에서 측정할 공통 포트 목록. */
export function getVcPorts() { return [...loadRaw().vcPorts]; }

/** 측정 포트 목록 저장 + 대상 재구성. ports 변경 시 vcport 대상을 vCenter×포트로 재동기화. */
export function setVcPorts(ports, vcenters = []) {
  const cur = loadRaw();
  const clean = [...new Set((Array.isArray(ports) ? ports : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535))].sort((a, b) => a - b);
  const next = { ...cur, vcPorts: clean };
  const rebuilt = rebuildVcPortTargets(next, vcenters);
  try { save(rebuilt); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, ports: clean, targets: rebuilt.targets.filter((t) => t.source === 'vcport').length };
}

/** vCenter×포트 조합으로 vcport 대상을 재구성(현재 vcPorts·vcenters 기준). 순수 함수(저장 안 함). */
function rebuildVcPortTargets(state, vcenters = []) {
  const ports = state.vcPorts || [];
  const vcs = (Array.isArray(vcenters) ? vcenters : []).map((v) => ({ id: norm(v.id), name: norm(v.name), host: hostFromUrl(v.host) })).filter((v) => v.id && v.host && SAFE_HOST.test(v.host));
  // 기존 vcport 대상의 baseline/enabled 등 사용자 편집값 보존(id로 매칭).
  const prev = new Map(state.targets.filter((t) => t.source === 'vcport').map((t) => [t.id, t]));
  const nonVcport = state.targets.filter((t) => t.source !== 'vcport');
  const vcportTargets = [];
  for (const vc of vcs) {
    for (const port of ports) {
      const id = `vcport_${idOf(vc.id)}_${port}`;
      const old = prev.get(id);
      vcportTargets.push({
        id, name: `${vc.name || vc.host}:${port}`, host: vc.host, port, kind: 'tcp',
        enabled: old ? old.enabled !== false : true, baselineMs: old?.baselineMs || null,
        note: 'vCenter 포트', source: 'vcport', vcenterId: vc.id,
      });
    }
  }
  return { ...state, targets: [...nonVcport, ...vcportTargets] };
}

/** vCenter 목록 변경(추가/삭제) 반영 — 현재 vcPorts로 vcport 대상 재동기화. */
export function syncVcPortTargets(vcenters = []) {
  const cur = loadRaw();
  if (!(cur.vcPorts || []).length) return { ok: true, targets: 0 };
  const rebuilt = rebuildVcPortTargets(cur, vcenters);
  // 변경 없으면 쓰기 생략(대상 id 집합 비교).
  const before = cur.targets.filter((t) => t.source === 'vcport').map((t) => t.id).sort().join(',');
  const after = rebuilt.targets.filter((t) => t.source === 'vcport').map((t) => t.id).sort().join(',');
  if (before === after) return { ok: true, targets: rebuilt.targets.filter((t) => t.source === 'vcport').length };
  try { save(rebuilt); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, targets: rebuilt.targets.filter((t) => t.source === 'vcport').length };
}

/** 테스트/관리용 초기화. */
export function resetTargets() {
  cache = null; cacheTok = '';
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
