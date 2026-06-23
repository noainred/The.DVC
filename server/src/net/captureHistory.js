/**
 * 네트워크 캡처 이력 저장소 — 캡처 결과의 메타·요약·진단을 CONFIG_DIR/capture-history.json에
 * 보관(자격증명/원본 pcap 제외). 최근 N건만 유지. 재조회/연속 모니터링 기록용.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'capture-history.json');
const MAX = 300;

let list = null;
function load() {
  if (list) return list;
  list = [];
  try { if (fs.existsSync(FILE)) list = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch { list = []; }
  return list;
}
function persist() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list), { mode: 0o600 }); } catch { /* */ } }

const worstSev = (issues = []) => (issues.some((i) => i.sev === 'error') ? 'error' : issues.some((i) => i.sev === 'warning') ? 'warning' : 'ok');

/** 캡처 결과(단일/dual)에서 이력 레코드 생성·저장. source: 'manual'|'monitor'. */
export function recordCapture(result, meta = {}) {
  load();
  const id = `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
  let rec;
  if (result?.dual) {
    const cmp = result.comparison || {};
    rec = {
      id, at: Date.now(), source: meta.source || 'manual', mode: 'dual', via: meta.via || 'central',
      monitorName: meta.monitorName || '', hostA: result.hostA, hostB: result.hostB,
      worst: worstSev(cmp.issues), issues: cmp.issues || [],
      summary: { lossAB: cmp.lossAB ?? null, lossBA: cmp.lossBA ?? null, aPackets: result.a?.captured ?? null, bPackets: result.b?.captured ?? null },
      detail: { a: result.a?.analysis?.stat || null, b: result.b?.analysis?.stat || null },
    };
  } else {
    const st = result?.analysis?.stat || {};
    rec = {
      id, at: Date.now(), source: meta.source || 'manual', mode: 'single', via: meta.via || 'central',
      monitorName: meta.monitorName || '', hostA: meta.hostA || '', hostB: result?.peer || meta.peer || '',
      worst: worstSev(result?.analysis?.issues), issues: result?.analysis?.issues || [],
      summary: { packets: st.packets ?? result?.captured ?? 0, rst: st.rst ?? 0, retransPct: st.retransPct ?? 0, rttMs: st.rttMs ?? null },
      detail: { stat: st },
    };
  }
  list.unshift(rec);
  if (list.length > MAX) list.length = MAX;
  persist();
  return rec;
}

export function listCaptures({ limit = 100 } = {}) {
  return load().slice(0, limit).map(({ detail, ...m }) => m);
}
export function getCapture(id) { return load().find((r) => r.id === id) || null; }
export function deleteCapture(id) { load(); const before = list.length; list = list.filter((r) => r.id !== id); if (list.length !== before) persist(); return before !== list.length; }
