/**
 * isidu/push.js — 엣지 → 중앙 아이실론 디렉터리 사용량 결과 push(v2.736).
 *
 * 엣지는 자기 DB 에 먼저 적고(진실의 원천), 커서(로컬 스캔 id) 뒤의 스캔을 보낸다. 성공했을 때만 커서를 전진한다 —
 * 중앙이 꺼져 있거나 DB 를 못 쓰면(503) 다음 주기에 같은 스캔을 다시 보내고 중앙은 (agent, 대상, 시각) 으로 중복을 거른다.
 * 규약: gzip · 요청당 폴더 행 상한(약 6만 — 해제 후 16MB 한도 아래) · 재진입 가드(진행 중이면 끝난 뒤 한 번 더) ·
 *   **보낼 스캔이 0건이어도 상태를 올린다**(v2.517 sendStatusOnly — 중앙 화면이 이 엣지의 키·폴러 상태를 알아야 한다) ·
 *   중앙 응답의 거절 요약을 상태·콘솔에 남긴다 · 실패는 `_last` + 콘솔(같은 사유는 10분에 1줄).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, clampIntervalMs } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { readJsonCapped } from '../util/readCapped.js';
import { classifyCentral404Body } from '../agent/central404.js';
import { agentNameHeader } from '../util/agentNameHeader.js';
import { publicKeyView } from './sshKey.js';
import { edgeTargets } from './settings.js';
import { isiduPollerStatus, onScanStored } from './poller.js';
import * as db from './db.js';

const gzipAsync = promisify(zlib.gzip);
registerStateFile('isidu-push.json');
const CURSOR_FILE = () => path.join(config.configDir, 'isidu-push.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const ROWS_PER_POST = Math.max(5_000, Number(process.env.ISIDU_PUSH_ROWS) || 60_000);
const MAX_ROUNDS = 10;
export const pushMs = () => clampIntervalMs(Number(process.env.ISIDU_PUSH_MS) || 600000, 600000, 60_000);
const failLog = createChangeLogger({ windowMs: 10 * 60_000 });

let _timer = null; let _busy = null; let _again = false; let _last = null; let _soon = null;

function loadCursor() { try { return Number(JSON.parse(fs.readFileSync(CURSOR_FILE(), 'utf8')).lastId) || 0; } catch { return 0; } }
function saveCursor(id) {
  try { atomicWriteFileSync(CURSOR_FILE(), JSON.stringify({ lastId: id, at: Date.now() }), { mode: 0o600 }); }
  catch (e) { console.warn(`[isidu-push] 커서 저장 실패: ${e.message}`); }
}

export function statusBody() {
  const p = isiduPollerStatus();
  return {
    key: publicKeyView(),
    poller: { lastTick: p.lastTick, concurrency: p.concurrency, running: p.running, lastError: p.lastError },
    targets: edgeTargets().targets.length,
    version: config.currentVersion?.() || null,
  };
}

/** 중앙 비-2xx → 사람이 읽을 사유. */
export function centralFailText(status, body) {
  const reason = body && typeof body === 'object' && typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
  if (status === 413) return '본문이 중앙 수신 한도를 넘었습니다(413) — ISIDU_PUSH_ROWS 를 줄이세요';
  if (status === 404) return classifyCentral404Body(body).reason;
  if (status === 503 && body?.dbUnavailable) return '중앙 디렉터리 사용량 DB 를 쓸 수 없습니다(503) · 커서를 전진하지 않고 다음 주기에 다시 보냅니다';
  if (status === 503) return `중앙이 지금 받을 수 없습니다(503${reason ? ` — ${reason}` : ''}) · 다음 주기에 다시 보냅니다`;
  return `HTTP ${status}${reason ? ` — ${reason}` : ''}`;
}

async function postOnce(scans) {
  const body = { agent: config.agent.name, status: statusBody(), scans: scans.map((s) => ({ ...s, id: s.id, entries: s.entries.map((e) => [e.name, e.bytes, e.res]) })) };
  const json = Buffer.from(JSON.stringify(body));
  const payload = await gzipAsync(json);
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/isidu-data?agent=${encodeURIComponent(config.agent.name || '')}`, {
    method: 'POST', timeoutMs: 120_000, retries: 2, body: payload,
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Central-Token': config.agent.centralToken, ...agentNameHeader(config.agent.name) },
  });
  let reply = null;
  try { reply = await readJsonCapped(res, 256 * 1024, '중앙 응답'); } catch { try { await res.body?.cancel?.(); } catch { /* */ } }
  if (!res.ok) { const e = new Error(`isidu-data ← ${centralFailText(res.status, reply)}`); e.status = res.status; throw e; }
  return { reply, bytes: json.length, gz: payload.length };
}

async function pushInner() {
  if (!(await db.available())) {
    await postOnce([]);   // 상태만 — DB 를 못 써도 키·폴러 상태는 중앙이 알아야 한다
    _last = { at: Date.now(), ok: true, scans: 0, note: '엣지 DB 를 쓸 수 없어 상태만 보냈습니다' };
    return { ok: true, sent: 0, more: false };
  }
  let cursor = loadCursor();
  const mx = await db.maxLocalScanId();
  if (mx != null && cursor > mx) cursor = 0; // DB 재생성 — 처음부터(중앙이 중복을 거른다)
  const list = await db.localScansAfter(cursor, 20);
  const scans = []; let rows = 0;
  for (const s of list || []) {
    const ents = s.ok ? [...(await db.entriesOf(s.id)).entries()].map(([name, v]) => ({ name, bytes: v.bytes, res: v.res })) : [];
    if (scans.length && rows + ents.length > ROWS_PER_POST) break;
    scans.push({ ...s, entries: ents }); rows += ents.length;
  }
  const r = await postOnce(scans);
  const lastId = scans.length ? scans[scans.length - 1].id : cursor;
  if (scans.length) saveCursor(lastId);
  const rejected = Number(r.reply?.rejected) || 0;
  const notOwned = Number(r.reply?.dropped?.notOwned) || 0;
  if (rejected) console.warn(`[isidu-push] 중앙이 일부를 받지 않았습니다(${JSON.stringify(r.reply?.dropped || {}).slice(0, 200)})${notOwned ? ` — 대상 ${notOwned}건은 이 엣지에 배정되지 않았습니다(배정이 바뀐 직후일 수 있습니다)` : ''}`);
  const more = mx != null && lastId < mx;
  _last = { at: Date.now(), ok: true, scans: scans.length, rows, bytes: r.bytes, gzBytes: r.gz, more, ...(rejected ? { rejected, dropped: r.reply?.dropped || null } : {}) };
  return { ok: true, sent: scans.length, more };
}

/** 한 번 보낸다(진행 중이면 끝난 뒤 한 번 더). */
export async function pushIsiduNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) { _again = true; return _busy; }
  const run = async () => {
    try { return await pushInner(); }
    catch (e) {
      _last = { at: Date.now(), ok: false, error: e.message };
      if (failLog('push', e.message)) console.warn(`[isidu-push] 실패: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  };
  _busy = (async () => {
    let r; let rounds = 0;
    do { _again = false; r = await run(); rounds++; } while ((_again || (r?.ok && r.more)) && rounds < MAX_ROUNDS);
    _again = false;
    return r;
  })().finally(() => { _busy = null; });
  return _busy;
}

/** 적재 직후 곧 보내기(5초 묶음). */
function pushSoon() {
  if (_soon) return;
  _soon = setTimeout(() => { _soon = null; pushIsiduNow().catch(() => {}); }, 5_000);
  _soon.unref?.();
}

export function startIsiduPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  onScanStored(pushSoon);
  _timer = startAdaptiveTimer(pushMs, () => pushIsiduNow(), { firstDelayMs: 80_000, name: '아이실론 디렉터리 사용량 push' });
}
export function isiduPushStatus() { return { ...(_last || {}), intervalMs: pushMs(), cursor: loadCursor() }; }
export function _resetForTest() { _busy = null; _again = false; _last = null; try { fs.rmSync(CURSOR_FILE()); } catch { /* */ } }
