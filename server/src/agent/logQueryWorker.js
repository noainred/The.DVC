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

/*
 * ⚠⚠ **무음 실패 금지**(v2.561 — v2.549 가 `edgeLogWorker` 에만 적용한 규약을 여기에도).
 *
 * v2.560 까지 이 워커는 결과 POST 를 `.catch(() => {})` 로 삼키고 바깥도 `catch { return null; }`
 * 라, 상태 객체도 로그도 없이 **4초마다 조용히 실패**했다. 그런데 중앙의 `getLogQueryResult` 는
 * 결과가 없으면 **영원히 `{state:'pending'}`** 을 돌려준다(`central/logQueries.js:57` — 시한도
 * 사유도 없다). 즉 사용자가 '엣지 로그 조회' 를 누르면 화면이 **왜 안 되는지 모른 채 무한
 * 대기**한다. 실패 원인이 토큰 불일치(403)든 본문 크기(413)든 네트워크든 구분되지 않았다.
 *
 * ⚠ 413 은 `resilientFetch` 재시도 대상이 아니라 **그 조회 결과의 조용한 전량 소실**이다
 * (v2.517 규약). 실측 — 500행 × message 1,900자면 981KB 로 기본 1MB 에 닿는다(2,000자에서
 * 1,079KB 로 초과). 그래서 413 을 사유로 **구분해 남긴다**.
 *
 * 상태는 `logQueryWorkerStatus()` 로 나가고 `edgelog/spec.js` 표에 등재된다 — 새 엣지 워커를
 * 만들 때 그 표에 함께 넣을 것(v2.554 규약).
 */
let _last = null;

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
  const t0 = Date.now();
  const vcIds = (loadVcenterConfig().vcenters || []).map((v) => v.id).filter(Boolean);
  // ⚠ '잴 것이 0건' 도 상태로 남긴다 — 조기 return 이 상태를 비우면 '워커가 도는지' 를 알 수 없다.
  if (!vcIds.length) { _last = { at: Date.now(), ms: 0, ok: true, queries: 0, note: '이 엣지에 등록된 vCenter 가 없습니다.' }; return null; }
  try {
    const url = `${config.agent.centralUrl}/api/central/log-queries?vcenters=${encodeURIComponent(vcIds.join(','))}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) {
      _last = { at: Date.now(), ms: Date.now() - t0, ok: false, httpStatus: r.status, phase: 'poll',
        error: r.status === 403 ? '중앙이 토큰을 거부했습니다(403) — CENTRAL_TOKEN 을 확인하세요.' : `중앙 응답 HTTP ${r.status}` };
      console.warn(`[logq-agent] 인출 실패: ${_last.error}`);
      return null;
    }
    const { queries } = await r.json();
    if (!queries || !queries.length) { _last = { at: Date.now(), ms: Date.now() - t0, ok: true, queries: 0 }; return null; }
    const db = await getLogsDb();
    let sent = 0; const failures = [];
    for (const q of queries) {
      const f = q.filter || {};
      let total = 0, rows = [], readError = null;
      try { total = db.count(f); rows = db.query(f, f.limit || 200, 0); } catch (e) { readError = String(e?.message || e).slice(0, 200); }
      const body = JSON.stringify({ reqId: q.reqId, vcenterId: q.vcenterId, total, rows, dbKind: db.kind, ...(readError ? { readError } : {}) });
      try {
        const post = await resilientFetch(`${config.agent.centralUrl}/api/central/log-query-result`, {
          method: 'POST', headers: headers(), body, timeoutMs: 15_000, retries: 2,
        });
        if (post.status === 413) {
          // ⚠ 413 은 재시도 대상이 아니다 — 그 조회는 영구 소실되므로 사유를 분명히 남긴다.
          failures.push({ vcenterId: q.vcenterId, httpStatus: 413, bytes: Buffer.byteLength(body),
            error: `중앙이 본문 크기를 거부(413) — ${rows.length}줄 ${(Buffer.byteLength(body) / 1024).toFixed(0)}KB. 조회 줄 수를 줄이거나 중앙에 BIG_JSON 등록이 필요합니다.` });
        } else if (!post.ok) {
          failures.push({ vcenterId: q.vcenterId, httpStatus: post.status, error: `결과 보고 HTTP ${post.status}` });
        } else { sent += 1; }
      } catch (e) {
        failures.push({ vcenterId: q.vcenterId, httpStatus: null, error: String(e?.message || e).slice(0, 200) });
      }
      console.log(`[logq-agent] ${q.vcenterId}: ${rows.length}/${total}건 응답${readError ? ` (DB 오류: ${readError})` : ''}`);
    }
    for (const f of failures) console.warn(`[logq-agent] 결과 보고 실패 ${f.vcenterId}: ${f.error}`);   // 무음 실패 금지
    _last = { at: Date.now(), ms: Date.now() - t0, ok: failures.length === 0, queries: queries.length, sent,
      ...(failures.length ? { failures: failures.slice(0, 5), failed: failures.length } : {}) };
    return { at: Date.now() };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, ok: false, phase: 'run', error: String(e?.message || e).slice(0, 300) };
    console.warn(`[logq-agent] 실패: ${_last.error}`);   // 무음 실패 금지
    return null;
  }
}

/** 엣지 로그·진행상태 표(`edgelog/spec.js`)가 읽는 워커 상태 — 무음 실패를 드러낸다. */
export function logQueryWorkerStatus() {
  return { enabled: !!config.agent.centralUrl, intervalMs: POLL_MS, busy: running, last: _last };
}

export function startLogQueryWorker() {
  if (!config.agent.centralUrl) return;
  timer = setInterval(() => runLogQueryWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[logq-agent] started (central=${config.agent.centralUrl})`);
}
