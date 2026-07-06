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
    cache = { targets: Array.isArray(p.targets) ? p.targets : [] };
  } catch { cache = { targets: [] }; }
  cacheTok = t;
  return cache;
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
  try { save({ targets: [...cur.targets, entry] }); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
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
  try { save({ targets: cur.targets.map((t, i) => (i === idx ? entry : t)) }); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, target: clean(entry) };
}

export function removeTarget(id) {
  const cur = loadRaw();
  const tid = idOf(id);
  if (!cur.targets.some((t) => t.id === tid)) return { ok: false, reason: `없는 대상: ${id}` };
  try { save({ targets: cur.targets.filter((t) => t.id !== tid) }); } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  return { ok: true, id: tid };
}

/** 테스트/관리용 초기화. */
export function resetTargets() {
  cache = null; cacheTok = '';
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
