/**
 * cvp/push.js — 엣지 → 중앙 CloudVision(CVP) 수집 결과 push(v2.608).
 *
 * 사용자 선택: "엣지 수집 → 엣지 DB → 변경분 gzip·청크 push → 중앙 DB". 보내는 것:
 *  ① 청크 0: CVP 별 상태(servers) + CVP 별 장비 키 목록(deviceKeys — 중앙이 그 엣지의 사라진 장비를 지운다)
 *  ② 장비 최신 레코드(부품·BGP·포트 구성과 마지막 처리량) — 엣지 DB 의 device_latest/port_latest 에서 읽는다
 *     (재시작해도 DB 는 남으므로 '재기동 직후 빈 목록으로 중앙을 덮는' 사고가 구조적으로 없다 — v2.581 BUG-D).
 *  ③ 커서(rowid) 뒤의 원시 표본(port_sample) — 성공했을 때만 커서를 전진한다(v2.423 perfPush 와 같은 방식).
 * 규약: gzip · 청크(요청당 ~700KB — 중앙 BIG_JSON 16MB 아래지만 고RTT 회선에서 요청 하나를 작게) · 재진입 가드(진행 중
 *   요청은 끝난 뒤 한 번 더) · **0건이어도 상태 push**(v2.517 sendStatusOnly — 위임 0대면 빈 목록으로 중앙을 비운다) ·
 *   중앙 응답의 거절 요약(rejected·dropped)을 상태·콘솔에 남긴다(agent/centralReply.js) · 413 은 로그로 드러낸다.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, clampIntervalMs } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { readCentralReply, dropSummaryOf, mergeDrop, warnDrop } from '../agent/centralReply.js';
import { serversForThisNode } from './registry.js';
import { getStatus } from './store.js';
import * as db from './db.js';

const gzipAsync = promisify(zlib.gzip);
const CURSOR_FILE = () => path.join(config.configDir, 'cvp-push.json');
export const CHUNK_BYTES = Math.max(64 * 1024, Number(process.env.CVP_PUSH_CHUNK_BYTES) || 700 * 1024);
const MAX_ROWS = Math.max(1000, Number(process.env.CVP_PUSH_ROWS) || 20_000);
const PUSH_GZIP = process.env.CVP_PUSH_GZIP !== 'false';
export const pushMs = () => clampIntervalMs(Number(process.env.CVP_PUSH_MS) || 5 * 60_000, 5 * 60_000, 60_000);
const failLog = createChangeLogger({ windowMs: 10 * 60_000 });

let _timer = null;
let _busy = null;
let _again = false;
let _last = null;

function loadCursor() { try { return Number(JSON.parse(fs.readFileSync(CURSOR_FILE(), 'utf8')).lastRowid) || 0; } catch { return 0; } }
function saveCursor(rowid) {
  try { atomicWriteFileSync(CURSOR_FILE(), JSON.stringify({ lastRowid: rowid, at: Date.now() }), { mode: 0o600 }); }
  catch (e) { console.warn(`[cvp-push] 커서 저장 실패: ${e.message}`); }
}

/** 항목을 JSON 크기 기준으로 청크(순수). items: [{t:'d'|'r', v}] → [[...], ...]. 한 항목이 상한을 넘어도 단독 청크로 보낸다. */
export function chunkItems(items, maxBytes = CHUNK_BYTES, firstReserve = 0) {
  const chunks = []; let cur = []; let size = firstReserve;
  for (const it of items) {
    const n = Buffer.byteLength(JSON.stringify(it.v)) + 1;
    if (cur.length && size + n > maxBytes) { chunks.push(cur); cur = []; size = 0; }
    cur.push(it); size += n;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks;
}

/** 서버 상태(스토어) → push 모양. 이번 기동에서 아직 수집 전이면 pending. */
function statusFor(srv) {
  const st = getStatus(srv.id);
  if (!st) return { cvpId: srv.id, name: srv.name || '', pending: true, ok: false, collectedAt: null, deviceCount: null, error: null };
  return { ...st, cvpId: srv.id, name: srv.name || st.name || '' };
}

async function pushInner() {
  const servers = serversForThisNode();
  const statuses = servers.map(statusFor);
  const deviceItems = []; const deviceKeys = {};
  let devicesUnavailable = !(await db.available());
  if (!devicesUnavailable) {
    for (const srv of servers) {
      const recs = await db.deviceRecordsFor(db.LOCAL_AGENT, srv.id);
      if (recs == null) { devicesUnavailable = true; break; }
      // 장비 키 목록은 '온전히 읽은 적이 있을 때만' 싣는다 — 이번 기동에서 아직 수집 전이고 DB 도 비면 중앙 행을 지우지 않는다.
      const st = getStatus(srv.id);
      if (recs.length || (st?.ok && st.deviceCount === 0)) deviceKeys[srv.id] = recs.map((d) => d.key);
      for (const d of recs) deviceItems.push({ t: 'd', v: { cvpId: srv.id, ...d } });
    }
  }
  const cursor0 = loadCursor();
  let rows = []; let maxRowid = cursor0;
  if (!devicesUnavailable) {
    const mx = await db.maxRowid();
    const cursor = mx != null && cursor0 > mx ? 0 : cursor0; // DB 재생성 뒤 낡은 커서 — 처음부터(중앙이 중복을 거른다)
    const r = await db.samplesAfter(cursor, MAX_ROWS);
    rows = r.rows; maxRowid = r.maxRowid;
  }
  const head = { agent: config.agent.name, servers: statuses, deviceKeys: devicesUnavailable ? null : deviceKeys, devicesUnavailable };
  const items = [...deviceItems, ...rows.map((v) => ({ t: 'r', v }))];
  const chunks = chunkItems(items, CHUNK_BYTES, Buffer.byteLength(JSON.stringify(head)));
  const hdrs = { 'Content-Type': 'application/json', 'X-Agent-Name': config.agent.name, 'X-Central-Token': config.agent.centralToken };
  let bytes = 0; let gz = 0; let drop = null;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const body = {
      ...(i === 0 ? head : { agent: config.agent.name }), chunk: i, chunks: chunks.length,
      devices: c.filter((x) => x.t === 'd').map((x) => x.v), rows: c.filter((x) => x.t === 'r').map((x) => x.v),
    };
    const json = Buffer.from(JSON.stringify(body));
    let payload = json; const h = { ...hdrs };
    if (PUSH_GZIP) { try { payload = await gzipAsync(json); h['Content-Encoding'] = 'gzip'; } catch { payload = json; } }
    bytes += json.length; gz += payload.length;
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/cvp-data?agent=${encodeURIComponent(config.agent.name || '')}`, { method: 'POST', headers: h, body: payload, timeoutMs: 60_000, retries: 2 });
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* */ }
      const why = res.status === 413 ? '본문이 중앙 수신 한도를 넘었습니다(413) — CVP_PUSH_CHUNK_BYTES 를 줄이세요' : `HTTP ${res.status}`;
      throw new Error(`cvp-data ← ${why} (청크 ${i + 1}/${chunks.length})`);
    }
    drop = mergeDrop(drop, dropSummaryOf(await readCentralReply(res)));
  }
  if (rows.length) saveCursor(maxRowid);
  warnDrop('cvp-push', drop);
  _last = { at: Date.now(), ok: true, servers: statuses.length, devices: deviceItems.length, samples: rows.length, chunks: chunks.length, bytes, gzBytes: gz,
    ...(devicesUnavailable ? { devicesUnavailable: true, note: '엣지 DB 를 쓸 수 없어 상태만 보냈습니다(중앙의 장비 목록은 그대로)' } : {}),
    ...(servers.length ? {} : { cleared: true, note: '위임 CVP 0대 — 중앙의 이 엣지 목록을 비웠습니다' }),
    ...(drop ? { rejected: drop.rejected, dropText: drop.text } : {}) };
  return { ok: true, sent: rows.length, devices: deviceItems.length, servers: statuses.length, chunks: chunks.length, ...(drop ? { rejected: drop.rejected } : {}) };
}

/** 한 번 보낸다. 진행 중이면 끝난 뒤 한 번 더 보내고 그 결과를 돌려준다. */
export async function pushCvpNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) { _again = true; return _busy; }
  const run = async () => {
    try { return await pushInner(); }
    catch (e) {
      _last = { at: Date.now(), ok: false, error: e.message };
      if (failLog('push', e.message)) console.warn(`[cvp-push] 실패: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  };
  _busy = (async () => {
    let r = await run();
    while (_again) { _again = false; r = await run(); }
    return r;
  })().finally(() => { _busy = null; });
  return _busy;
}

export function startCvpPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(pushMs, () => pushCvpNow(), { firstDelayMs: 70_000, name: 'CVP push' });
}
export function cvpPushStatus() { return { ...(_last || {}), intervalMs: pushMs(), cursor: loadCursor() }; }
export function _resetForTest() { _busy = null; _again = false; _last = null; try { fs.rmSync(CURSOR_FILE()); } catch { /* */ } }
