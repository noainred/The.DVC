/**
 * sanswitch/perfPush.js — 엣지 → 중앙 포트 사용량(portperfshow) 시계열 중계(v2.423, 사용자 요구 '연결은 됐는데 데이터
 * 수집이 안 됨' — 엣지 위임 스위치의 사용량 분석이 중앙에서 비어 있었다).
 *
 * 왜 필요한가: portperfshow 표본은 수집한 노드의 로컬 DB(sanswitch-perf.db)에만 쌓인다. 위임 스위치는 엣지가 수집하므로
 * 중앙의 '스토리지 사용량 분석'은 그 법인이 비어 보였다(v2.422 까지 안내 배너만). 이제 엣지가 **마지막으로 올린 rowid
 * 뒤의 표본만**(커서) 주기적으로 중앙 `/api/central/sanswitch-perf` 로 올리고, 중앙이 같은 DB 스키마에 적재한다.
 *
 * 고RTT 규약(CLAUDE.md): 커서 방식(전량 재전송 금지) · gzip · 청크(요청당 ~700KB, 중앙 express.json 1MB 아래) ·
 * 재진입 가드 · startAdaptiveTimer(주기는 매 틱 조회) · 수집 직후 즉시 1회 push(대기 시간 단축).
 * 커서는 파일(sanswitch-perf-push.json)에 보관해 재시작 뒤에도 이어 올린다. 부분 성공 후 재전송은 중앙이 (device,ts,port)
 * 중복을 건너뛴다(perfDb.importSamples).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { samplesAfter, metaFor } from './perfDb.js';
import { loadPerfSettings } from './perfSettings.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const gzipAsync = promisify(zlib.gzip);
const FILE = () => path.join(config.configDir, 'sanswitch-perf-push.json');
const CHUNK_BYTES = Math.max(64 * 1024, Number(process.env.SANSW_PERF_PUSH_CHUNK_BYTES) || 700 * 1024);
const MAX_ROWS = Math.max(1000, Number(process.env.SANSW_PERF_PUSH_ROWS) || 20_000);
const PUSH_GZIP = process.env.SANSW_PUSH_GZIP !== 'false';
/** push 주기 — 기본은 수집 주기와 같다(수집 직후 즉시 push 하므로 타이머는 안전망). 하한 60초. */
export const perfPushMs = () => Math.max(60_000, Number(process.env.SANSW_PERF_PUSH_MS) || loadPerfSettings().intervalMs);

let _timer = null;
let _busy = false;
let _last = null;

function loadCursor() {
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Number(j.lastRowid) || 0; } catch { return 0; }
}
function saveCursor(rowid) {
  try { atomicWriteFileSync(FILE(), JSON.stringify({ lastRowid: rowid, at: Date.now() }), { mode: 0o600 }); } catch (e) { console.warn(`[sanswitch-perf-push] 커서 저장 실패: ${e.message}`); }
}

/** 행을 JSON 크기 기준으로 청크(순수 — 테스트 고정). 행은 [d,ts,p,b] 압축 배열로 보낸다. */
export function chunkRows(rows, maxBytes = CHUNK_BYTES) {
  const chunks = []; let cur = []; let size = 2;
  for (const r of rows) {
    const n = JSON.stringify([r.d, r.ts, r.p, r.b]).length + 1;
    if (cur.length && size + n > maxBytes) { chunks.push(cur); cur = []; size = 2; }
    cur.push(r); size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export async function pushPerfNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) return { ok: false, reason: '이전 push 진행 중' };
  _busy = true;
  try {
    const from = loadCursor();
    const { rows, maxRowid, unavailable } = await samplesAfter(from, MAX_ROWS);
    if (unavailable) { _last = { at: Date.now(), sent: 0, reason: 'DB 비활성' }; return { ok: false, reason: 'DB 비활성' }; }
    if (!rows.length) { _last = { at: Date.now(), sent: 0, cursor: from }; return { ok: true, sent: 0 }; }
    const meta = await metaFor(rows.map((r) => r.d));
    const chunks = chunkRows(rows);
    let sent = 0, bytes = 0, gzBytes = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const json = Buffer.from(JSON.stringify({
        agent: config.agent.name, chunk: i, chunks: chunks.length,
        rows: c.map((r) => [r.d, r.ts, r.p, r.b]),
        meta: i === 0 ? meta.map((m) => [m.d, m.p, m.ts, m.name, m.wwn, m.speed, m.type]) : [],
      }));
      let body = json;
      const hdrs = { 'Content-Type': 'application/json', 'X-Agent-Name': config.agent.name, 'X-Central-Token': config.agent.centralToken };
      if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
      bytes += json.length; gzBytes += body.length;
      const res = await resilientFetch(`${config.agent.centralUrl}/api/central/sanswitch-perf`, { method: 'POST', headers: hdrs, body, timeoutMs: 30_000, retries: 2 });
      if (res.status === 404) throw new Error('중앙에 sanswitch-perf 엔드포인트 없음(중앙이 v2.423 미만)');
      if (!res.ok) throw new Error(`sanswitch-perf <- ${res.status} (청크 ${i + 1}/${chunks.length})`);
      sent += c.length;
      saveCursor(Number(c[c.length - 1].rowid)); // 청크마다 커서 전진 — 다음 청크가 실패해도 성공분은 재전송하지 않는다
    }
    _last = { at: Date.now(), sent, chunks: chunks.length, bytes, gzBytes, cursor: maxRowid, more: rows.length >= MAX_ROWS };
    // 상한만큼 읽었으면 밀린 표본이 더 있을 수 있다 — 다음 틱을 기다리지 않고 이어서 한 번 더.
    if (rows.length >= MAX_ROWS) setImmediate(() => pushPerfNow().catch(() => {}));
    return { ok: true, sent, chunks: chunks.length };
  } catch (e) { _last = { at: Date.now(), error: e.message }; return { ok: false, reason: e.message }; }
  finally { _busy = false; }
}

export function startSanSwitchPerfPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(perfPushMs, () => pushPerfNow(), { firstDelayMs: 95_000, name: 'SAN 포트 사용량 push' });
}
export function sanSwitchPerfPushStatus() { return { ..._last, intervalMs: perfPushMs(), cursor: loadCursor() }; }
