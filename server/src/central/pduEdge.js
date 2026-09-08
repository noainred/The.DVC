/**
 * central/pduEdge.js — 엣지가 push 한 PDU 스냅샷의 중앙 보관소(v2.424).
 *
 * 사용자 요구 '스토리지처럼 원격지의 센서를 수집' — 중앙은 원격 법인의 PDU 관리망에 직접 닿지
 * 못하므로, 그 사이트의 엣지 포탈이 수집해 중앙으로 올린다(아웃바운드 push 축 재사용).
 *
 * central/storageEdge.js 와 같은 구조. 메모리 + 디스크(CONFIG_DIR/central-pdu.json) 보관이며,
 * 자격증명은 담기지 않는다(스냅샷은 측정값만 — 엣지가 이미 로그인해서 읽은 결과).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'central-pdu.json');
// 엣지가 오래 조용하면 낡은 값을 '현재'처럼 보여주지 않도록 만료시킨다(정직 표기).
const TTL_MS = Number(process.env.CENTRAL_PDU_TTL_MS) || 6 * 60 * 60_000; // 6시간

let _map = null; // agentLower → { agent, at, snapshots: [] }

function load() {
  if (_map) return _map;
  _map = new Map();
  if (!fs.existsSync(FILE)) return _map;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const e of (parsed?.edges || [])) if (e?.agent) _map.set(String(e.agent).toLowerCase(), e);
  } catch (e) { preserveCorrupt(FILE, e.message); _map = new Map(); }
  return _map;
}

function persist() {
  try { atomicWriteFileSync(FILE, JSON.stringify({ edges: [...load().values()] }, null, 2), { mode: 0o600 }); }
  catch (e) { console.error('[central-pdu] 저장 실패:', e.message); }
}

/**
 * 엣지 push 수신. agent 는 **개별 토큰에 바인딩된 이름**을 호출부가 넘겨야 한다
 * (body.agent 를 그대로 믿으면 다른 엣지 데이터를 덮어쓸 수 있다 — central 라우터 규약).
 */
export function saveEdgePdu(agent, snapshots) {
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return { ok: false, reason: 'agent 가 필요합니다.' };
  const list = (Array.isArray(snapshots) ? snapshots : []).slice(0, 500).map((s) => ({
    ...s,
    agent: String(agent),   // 표시용으로 실제 인증된 이름을 박아 둔다
  }));
  load().set(key, { agent: String(agent), at: Date.now(), snapshots: list });
  persist();
  return { ok: true, count: list.length };
}

/** 만료되지 않은 엣지 스냅샷 전체(중앙 화면이 자기 수집분과 합쳐 보여준다). */
export function edgePduSnapshots() {
  const cut = Date.now() - TTL_MS;
  const out = [];
  for (const e of load().values()) {
    if (!e || (e.at || 0) < cut) continue;
    for (const s of e.snapshots || []) out.push(s);
  }
  return out;
}

/** 엣지별 보고 상태(진단 화면 — '언제 마지막으로 올라왔나'). */
export function edgePduStatus() {
  const cut = Date.now() - TTL_MS;
  return [...load().values()].map((e) => ({
    agent: e.agent, at: e.at, devices: (e.snapshots || []).length, stale: (e.at || 0) < cut,
  }));
}

export function _resetForTest() { _map = null; }
