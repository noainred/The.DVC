/**
 * 엣지 로그 연합 조회 워커 — CENTRAL_URL 설정 시 동작. 중앙에서 자기 vCenter들의 대기 로그
 * 조회를 인출 → 로컬 로그 DB에서 조회 → 결과를 중앙으로 보고. 데이터는 엣지에 그대로 남고
 * 조회 결과(페이지)만 중계된다. 응답성을 위해 짧은 주기로 폴링한다.
 */

import { config, loadVcenterConfig } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { getLogsDb } from '../logs/db.js';

let timer = null;
let running = false; // 재진입 방지
const POLL_MS = Number(process.env.AGENT_LOGQ_POLL_MS) || 4_000;

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function runLogQueryWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  if (running) return null;
  running = true;
  try { return await runLogQueryWorkerInner(); } finally { running = false; }
}

async function runLogQueryWorkerInner() {
  const vcIds = (loadVcenterConfig().vcenters || []).map((v) => v.id).filter(Boolean);
  if (!vcIds.length) return null;
  try {
    const url = `${config.agent.centralUrl}/api/central/log-queries?vcenters=${encodeURIComponent(vcIds.join(','))}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return null;
    const { queries } = await r.json();
    if (!queries || !queries.length) return null;
    const db = await getLogsDb();
    for (const q of queries) {
      const f = q.filter || {};
      let total = 0, rows = [];
      try { total = db.count(f); rows = db.query(f, f.limit || 200, 0); } catch (e) { /* 빈 결과 보고 */ }
      await resilientFetch(`${config.agent.centralUrl}/api/central/log-query-result`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ reqId: q.reqId, vcenterId: q.vcenterId, total, rows, dbKind: db.kind }), timeoutMs: 15_000, retries: 2,
      }).catch(() => {});
      console.log(`[logq-agent] ${q.vcenterId}: ${rows.length}/${total}건 응답`);
    }
    return { at: Date.now() };
  } catch { return null; }
}

export function startLogQueryWorker() {
  if (!config.agent.centralUrl) return;
  timer = setInterval(() => runLogQueryWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[logq-agent] started (central=${config.agent.centralUrl})`);
}
