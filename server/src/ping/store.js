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
    };
  } catch { cache = { targets: [], seededVc: [] }; }
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
  };
}

/** 등록된 대상 목록(사본). */
export function listTargets() { return loadRaw().targets.map(clean); }

/** 활성 대상만(폴러용). */
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
    added.push({ id, name: (norm(vc.name) || host).slice(0, 80), host, port: 443, kind: 'tcp', enabled: true, baselineMs: null, note: 'vCenter 자동 등록' });
  }
  // 변경 없음(추가도 없고 seededVc도 그대로)이면 쓰기 생략.
  if (!added.length && seeded.size === cur.seededVc.length) return { ok: true, added: 0 };
  try { save({ ...cur, targets: [...cur.targets, ...added], seededVc: [...seeded] }); }
  catch (e) { return { ok: false, reason: `저장 실패: ${e.message}`, added: 0 }; }
  return { ok: true, added: added.length };
}

/** 테스트/관리용 초기화. */
export function resetTargets() {
  cache = null; cacheTok = '';
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
