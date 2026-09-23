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
import { config, currentVersion } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { samplesAfter, metaFor, maxRowid } from './perfDb.js';
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
const _hbLog = createChangeLogger({ windowMs: 10 * 60_000 });
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

/** meta 행을 크기 기준으로 청크(순수, v2.425) — 청크 0 에 전량을 얹어 1MB 를 넘기던 결함(리뷰 #2) 수정. */
export function chunkMeta(meta, maxBytes = CHUNK_BYTES) {
  const chunks = []; let cur = []; let size = 2;
  for (const m of meta) {
    const n = JSON.stringify([m.d, m.p, m.ts, m.name, m.wwn, m.speed, m.type]).length + 1;
    if (cur.length && size + n > maxBytes) { chunks.push(cur); cur = []; size = 2; }
    cur.push(m); size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * 커서 정합(순수, v2.425): port_perf 는 rowid 테이블이라 전량 prune/DB 재생성 뒤 rowid 가 1 부터 다시 시작한다.
 * 커서가 현재 MAX(rowid) 보다 크면 낡은 커서 — 0 으로 되돌린다(중앙이 (device,ts,port) 중복을 건너뛰므로 재전송 안전).
 */
export function reconcileCursor(cursor, max) {
  const c = Number(cursor) || 0;
  if (max == null) return c; // DB 비활성 → 판단 불가, 유지
  const m = Number(max);
  if (!Number.isFinite(m)) return c;
  return c > m ? 0 : c;
}

/**
 * 이 엣지의 perf 수집 상태(v2.517). perfPoller 를 **동적 import** 로 읽는다 — perfPoller 가
 * 이 모듈의 `pushPerfNow` 를 정적으로 import 하므로 정적 순환이 되고, 순환은 로드 순서에 따라
 * 한쪽이 undefined 로 보이는 부류의 사고를 만든다. 이미 로드된 모듈의 동적 import 는 캐시 조회다.
 */
async function statusPayload() {
  try {
    const { perfStatusForCentral } = await import('./perfPoller.js');
    /*
     * ⚠ `pushError` 를 빼지 말 것(v2.566) — 이 값이 없어서 v2.427 의 중계 정지가 10일 동안
     * 중앙에 전달되지 않았다. 엣지에서만 아는 실패 사유를 화면이 말할 수 있는 유일한 통로다.
     */
    return { ...perfStatusForCentral(), pushAt: _last?.at || null, pushError: _last?.error || null, version: currentVersion() };
  } catch (e) {
    // 상태를 못 만들어도 push 를 막지 않는다 — '모른다' 를 그대로 보낸다(지어내지 않는다).
    return { enabled: loadPerfSettings().enabled, at: null, devices: [], statusError: String(e.message).slice(0, 200), version: currentVersion() };
  }
}

/** 표본 없이 상태만 올리는 하트비트. 중앙이 v2.517 미만이면 status 를 그냥 무시한다(호환). */
async function sendStatusOnly(status) {
  try {
    const json = Buffer.from(JSON.stringify({ agent: config.agent.name, chunk: 0, chunks: 1, rows: [], meta: [], status }));
    let body = json;
    const hdrs = { 'Content-Type': 'application/json', 'X-Agent-Name': config.agent.name, 'X-Central-Token': config.agent.centralToken };
    if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/sanswitch-perf`, { method: 'POST', headers: hdrs, body, timeoutMs: 20_000, retries: 1 });
    if (!res.ok) return { ok: false, reason: `sanswitch-perf <- ${res.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export async function pushPerfNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) return { ok: false, reason: '이전 push 진행 중' };
  _busy = true;
  try {
    let from = loadCursor();
    const max = await maxRowid();
    const rec = reconcileCursor(from, max);
    if (rec !== from) { console.warn(`[sanswitch-perf-push] 커서(${from})가 현재 최대 rowid(${max})보다 큼 — 표가 비워졌다 재적재된 것으로 보고 0 으로 되돌립니다.`); from = rec; saveCursor(0); }
    /*
     * ⚠⚠ **`maxRowid` 로 구조분해하지 말 것 — 위의 `await maxRowid()` 가 TDZ 로 던진다.**
     * v2.427 이 커서 정합을 넣으며 실제로 그렇게 썼고, `const maxRowid` 가 이 블록 전체를
     * TDZ 로 만들어 `pushPerfNow()` 가 **매 호출 첫 줄에서** ReferenceError 로 죽었다
     * (실측: `Cannot access 'maxRowid' before initialization`). 호출부가 전부
     * `.catch(() => {})` 라 **10일 동안 조용히** 엣지 사용량이 한 건도 중앙에 오지 않았다.
     * 회귀는 `test/sanPerfPush2566.test.js` 가 실제로 이 함수를 호출해 고정한다.
     */
    const { rows, maxRowid: lastRowid, unavailable } = await samplesAfter(from, MAX_ROWS);
    const status = await statusPayload();
    if (unavailable) {
      // DB 를 못 열면 표본은 영원히 0건이다 — 그 사실도 중앙이 알아야 한다(아래 하트비트로 보고).
      await sendStatusOnly(status).catch(() => {});
      _last = { at: Date.now(), sent: 0, reason: 'DB 비활성', statusSent: true };
      return { ok: false, reason: 'DB 비활성' };
    }
    if (!rows.length) {
      /**
       * ⚠ **표본이 0건이어도 상태는 올린다**(v2.517). 예전에는 여기서 그냥 반환해, 엣지가 수집에
       * 실패하거나 꺼져 있으면 중앙으로 **아무것도** 가지 않았다 — 그리고 그게 바로 사용자가
       * 신고한 상태다("데이터 수집이 안되"). 중앙은 엣지가 켜졌는지·돌았는지·왜 실패하는지
       * 알 방법이 없었고, 화면은 '설정에서 켜세요' 라는 한 문구로 그 전부를 덮었다.
       * 상태 전용 요청은 수백 바이트라 push 주기(기본 5분)마다 보내도 회선 부담이 없다.
       */
      const r = await sendStatusOnly(status);
      _last = { at: Date.now(), sent: 0, cursor: from, statusSent: r.ok, statusError: r.ok ? null : r.reason };
      // v2.591(PR-7): 하트비트 실패도 콘솔에(예전엔 statusError 에만 — 저널에서 안 보였다). 같은 사유는 10분에 한 번.
      if (!r.ok && _hbLog('status', r.reason)) console.warn(`[sanswitch-perf-push] 상태 보고 실패: ${r.reason}`);
      return { ok: true, sent: 0, statusSent: r.ok };
    }
    const meta = await metaFor(rows.map((r) => r.d));
    // meta 는 별도 청크로 먼저(각 청크가 예산 안), 그 뒤 표본 청크 — 어느 요청도 700KB 예산을 넘지 않는다.
    const payloads = [
      ...chunkMeta(meta).map((m) => ({ rows: [], meta: m })),
      ...chunkRows(rows).map((r) => ({ rows: r, meta: [] })),
    ];
    const chunks = payloads;
    let sent = 0, bytes = 0, gzBytes = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i].rows;
      const json = Buffer.from(JSON.stringify({
        agent: config.agent.name, chunk: i, chunks: chunks.length,
        rows: c.map((r) => [r.d, r.ts, r.p, r.b]),
        meta: chunks[i].meta.map((m) => [m.d, m.p, m.ts, m.name, m.wwn, m.speed, m.type]),
        // 상태는 **청크 0 에만** 싣는다(v2.517) — 매 청크에 실으면 중앙이 같은 상태를 청크 수만큼
        // 다시 기록하고, 청크마다 수백 바이트가 늘어난다.
        ...(i === 0 ? { status } : {}),
      }));
      let body = json;
      const hdrs = { 'Content-Type': 'application/json', 'X-Agent-Name': config.agent.name, 'X-Central-Token': config.agent.centralToken };
      if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
      bytes += json.length; gzBytes += body.length;
      const res = await resilientFetch(`${config.agent.centralUrl}/api/central/sanswitch-perf`, { method: 'POST', headers: hdrs, body, timeoutMs: 30_000, retries: 2 });
      if (res.status === 404) throw new Error('중앙에 sanswitch-perf 엔드포인트 없음(중앙이 v2.423 미만)');
      if (!res.ok) throw new Error(`sanswitch-perf <- ${res.status} (청크 ${i + 1}/${chunks.length})`);
      sent += c.length;
      if (c.length) saveCursor(Number(c[c.length - 1].rowid)); // 청크마다 커서 전진 — 다음 청크가 실패해도 성공분은 재전송하지 않는다
    }
    _last = { at: Date.now(), sent, chunks: chunks.length, bytes, gzBytes, cursor: lastRowid, more: rows.length >= MAX_ROWS };
    // 상한만큼 읽었으면 밀린 표본이 더 있을 수 있다 — 다음 틱을 기다리지 않고 이어서 한 번 더.
    if (rows.length >= MAX_ROWS) setImmediate(() => pushPerfNow().catch(() => {}));
    return { ok: true, sent, chunks: chunks.length };
  } catch (e) {
    /*
     * ⚠ **여기를 조용히 두지 말 것**(v2.549·v2.561 규약). 호출부는 전부
     * `pushPerfNow().catch(() => {})` 라 이 catch 가 유일한 기록 지점이고, v2.427~v2.565 는
     * `_last.error` 에만 적어 **어디에도 드러나지 않았다** — 그것이 이 결함이 10일을 간 이유다.
     * 상태 객체와 콘솔 **둘 다** 남긴다(엣지 로그 화면이 콘솔 링버퍼를 읽는다).
     */
    _last = { at: Date.now(), error: e.message };
    console.warn(`[sanswitch-perf-push] 중계 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  } finally { _busy = false; }
}

export function startSanSwitchPerfPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(perfPushMs, () => pushPerfNow(), { firstDelayMs: 95_000, name: 'SAN 포트 사용량 push' });
}
export function sanSwitchPerfPushStatus() { return { ..._last, intervalMs: perfPushMs(), cursor: loadCursor() }; }
