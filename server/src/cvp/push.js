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
import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, clampIntervalMs } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js'; // v2.613 PERSIST2613-01
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { readCentralReply, dropSummaryOf, mergeDrop, warnDrop } from '../agent/centralReply.js';
import { classifyCentral404Body } from '../agent/central404.js';
import { readJsonCapped } from '../util/readCapped.js';
import { serversForThisNode, registryLoadError } from './registry.js';
import { summarizeRegistryError } from '../util/registryCore.js'; // v2.744(최종 검토 FB): 등록부 로드 오류는 원문이 아니라 요약
import { getStatus } from './store.js';
import * as db from './db.js';
import { agentNameHeader } from '../util/agentNameHeader.js';
import { postNo503Retry } from '../util/postNo503Retry.js'; // v2.743(감사 LEFT-03): 503 은 호출 안에서 다시 보내지 않는다 · v2.744(감사 LEFT-09): 엣지 워커가 아니라 util/ 에서 가져온다

const gzipAsync = promisify(zlib.gzip);
// v2.613 PERSIST2613-01(재현): 이 커서는 표본이 있는 push 마다 다시 쓴다 — 상태 파일로 등록하지 않으면 백업 변경 감시·엣지 설정 push 가
//   5분마다 반응한다(형제 sanswitch-perf-push.json 은 v2.590 에 목록으로 등록됐는데 CVP 는 빠졌다). 등록부 + backup 목록 이중.
const CURSOR_NAME = registerStateFile('cvp-push.json');
const CURSOR_FILE = () => path.join(config.configDir, CURSOR_NAME);
export const CHUNK_BYTES = Math.max(64 * 1024, Number(process.env.CVP_PUSH_CHUNK_BYTES) || 700 * 1024);
const MAX_ROWS = Math.max(1000, Number(process.env.CVP_PUSH_ROWS) || 20_000);
const PUSH_GZIP = process.env.CVP_PUSH_GZIP !== 'false';
export const pushMs = () => clampIntervalMs(Number(process.env.CVP_PUSH_MS) || 5 * 60_000, 5 * 60_000, 60_000);
const failLog = createChangeLogger({ windowMs: 10 * 60_000 });
const l2Log = createChangeLogger({ windowMs: 60 * 60_000 });
const warnL2 = (sig) => l2Log('l2', sig);   // v2.924(B-②): 같은 L2 경고는 한 시간에 한 번

/**
 * 장비 레코드는 **구성이 바뀌었을 때만** 통째로 보낸다(그 밖에는 `touch` — [cvpId, key, ts] 로 수집 시각만).
 * 포트의 처리량·사용률은 매 주기 바뀌지만 그것은 원시 표본(rows)이 싣고 중앙이 표본으로 port_latest 를 갱신한다.
 * 실측(합성 200대 × 64포트): 레코드 전량 gzip 약 318KB/회 → 바뀐 것만이면 대부분 0 — docs/CVP.md '전송량'.
 * 해시에는 처리량 값 대신 '값이 있는가' 만 넣는다 — 값이 null 로 바뀌면(카운터 리셋·링크 다운) 레코드가 다시 가서 중앙의 낡은 값을 지운다.
 * 한 시간에 한 번은 전량을 다시 보낸다(중앙 재시작·유실 대비).
 */
import { EDGE_FULL_REFRESH_MS as FULL_REFRESH_MS } from './faults.js'; // v2.681: 중앙 부품 신선도 경계와 한 벌
const _sent = new Map(); // `${cvpId}|${key}` → { h, at }
/**
 * v2.924(SAN·CVP 설계 B-②): LLDP·MAC 테이블은 장비 레코드와 따로 보낸다(행이 많다 — 장비 레코드 해시에 섞으면 매 주기 전량이 간다).
 *   보낸 내용 해시를 기억하고 바뀐 장비만(또는 전량 갱신 주기마다) 보낸다. **중앙이 받았다고 답할 때만**(saved.l2 가 수) 보낸 것으로 친다 —
 *   구버전 중앙은 필드를 버리므로, 그 답이 없으면 L2_UNSUPPORTED_HOLD_MS 동안 L2 를 싣지 않는다(매 주기 같은 큰 본문을 헛보내지 않게).
 */
const _l2Sent = new Map(); // `${cvpId}|${key}` → { h, at }
// v2.929(C-③): EndpointLocation — CVP 마다 중앙이 받았다고 답한 마지막 '물어본 시각'. 그 뒤에 물은 MAC 만 보낸다(L2 와 같은 ack 규약 · 구버전 중앙 보류).
const _epSentAt = new Map(); // cvpId → 마지막으로 중앙이 받은 ep_meta 순번(seq — v2.929 반증 L-5: 예전에는 at)
let _epUnsupported = 0;
export const EP_PUSH_PER_CVP = 500;
/** 중앙 답 → EndpointLocation 수신 여부(순수) — 'acked' = saved.ep 가 수 · 'old-central' = saved 는 있는데 ep 칸이 없다 · 'unknown'. */
export function epAckOf(reply) {
  const sv = reply && typeof reply === 'object' ? reply.saved : null;
  if (!sv || typeof sv !== 'object') return 'unknown';
  return typeof sv.ep === 'number' ? 'acked' : 'old-central';
}
let _l2Unsupported = 0;
export const L2_UNSUPPORTED_HOLD_MS = 6 * 3600_000;
/**
 * v2.924(반증 L-7): 중앙 답 → L2 수신 여부(순수). 'acked' = saved.l2 가 수(새 중앙) · 'old-central' = saved 는 있는데 l2 칸이 없다(구버전 중앙) ·
 *   'unknown' = saved 자체가 없다(noDelegation 등 — 구버전으로 단정하지 않는다: 보류하지 않고 보낸 것으로도 치지 않는다).
 */
export function l2AckOf(reply) {
  const sv = reply && typeof reply === 'object' ? reply.saved : null;
  if (!sv || typeof sv !== 'object') return 'unknown';
  return typeof sv.l2 === 'number' ? 'acked' : 'old-central';
}
/** L2 를 실을지(순수) — 바뀐 장비 · 전량 갱신 주기 · 구버전 중앙 보류. */
export function l2Due(prev, h, nowMs, { refreshMs = FULL_REFRESH_MS, unsupportedAt = 0, holdMs = L2_UNSUPPORTED_HOLD_MS } = {}) {
  if (!h) return false;
  if (unsupportedAt && nowMs - unsupportedAt < holdMs) return false;
  return !(prev && prev.h === h && nowMs - prev.at < refreshMs);
}
const _evSent = new Map(); // v2.641: cvpId → 보낸 이벤트의 최대 (updatedAt|ts) — 재기동하면 비어 최근 7일분을 다시 보낸다(중앙 upsert)
export const EVENT_PUSH_MAX = 2000;
/** v2.680(감사 F-04): push 한 번에 싣는 이벤트 원문 바이트 상한(CVP 전체 합) — 중앙 본문 한도(해제 후 16MB)보다 충분히 작게. */
export const EVENT_PUSH_BYTES = 4 * 1024 * 1024;
export const eventTimeOf = (e) => Math.max(e?.updatedAt || 0, e?.ts || 0);
/**
 * v2.680(감사 F-04): 워터마크 뒤 이벤트를 오래된 것부터 바이트 예산 안에서 고른다(순수). 이벤트는 청크 0 한 본문에 실리므로
 *   상한이 없으면 재기동 직후 7일치가 중앙 한도(해제 후 16MB)를 넘어 매 주기 같은 413 으로 CVP push 전체가 멈춘다.
 *   같은 시각 묶음은 쪼개지 않는다(워터마크가 시각이라 묶음 중간에서 자르면 나머지가 영영 가지 않는다). 첫 묶음은 예산을 넘어도 넣는다
 *   (그것마저 미루면 영원히 못 간다). 남은 개수는 held — 다음 주기에 간다.
 */
export function pickEventsForPush(events, wm, budget) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && eventTimeOf(e) > wm).sort((a, b) => eventTimeOf(a) - eventTimeOf(b));
  const fresh = []; let bytes = 0; let held = 0;
  for (let k = 0; k < list.length;) {
    const tk = eventTimeOf(list[k]); let j = k; let sz = 0;
    while (j < list.length && eventTimeOf(list[j]) === tk) { sz += Buffer.byteLength(JSON.stringify(list[j])); j += 1; }
    if (fresh.length && bytes + sz > budget) { held = list.length - k; break; }
    for (let x = k; x < j; x++) fresh.push(list[x]);
    bytes += sz; k = j;
  }
  return { fresh, bytes, held };
}
const RATE_KEYS = ['inBps', 'outBps', 'inUtil', 'outUtil', 'inErr', 'outErr', 'inDrop', 'outDrop']; // v2.922: 드롭
export function recordHash(d) {
  // v2.641: CPU·메모리 값은 매 주기 바뀐다 — 해시에 넣으면 전 장비 레코드가 매번 다시 간다. 값은 devSamples 가 싣고 해시에는 '있는가' 만.
  const { ts, partsAt, sysAt, cpuPct, memPct, memTotal, ...rest } = d;
  rest.sysKnown = [cpuPct, memPct].map((v) => (v == null ? 0 : 1)).join('');
  const ports = Array.isArray(rest.ports) ? rest.ports.map((p) => {
    const o = { ...p };
    for (const k of RATE_KEYS) o[k] = p[k] == null ? 0 : 1;
    return o;
  }) : rest.ports;
  return crypto.createHash('sha1').update(JSON.stringify({ ...rest, ports, partsKnown: partsAt != null })).digest('hex');
}

let _timer = null;
let _busy = null;
let _again = false;
let _last = null;

function loadCursor() { try { return Number(JSON.parse(fs.readFileSync(CURSOR_FILE(), 'utf8')).lastRowid) || 0; } catch { return 0; } }
// v2.611(EDGE2611-05): 엣지 prune 이 커서 뒤(아직 안 보낸) 행을 지우면 그 개수를 센다 — push 가 켜진 노드에서만 커서가 뜻을 가진다.
db.setUnsentCursorProvider(() => (config.agent.centralUrl && config.agent.centralToken ? loadCursor() : null));

/** 한 push 호출이 꽉 찬 페이지를 이어 보내는 최대 횟수(남은 것은 다음 주기 — 백로그는 상태의 backlogRows 가 말한다). */
export const MAX_ROUNDS = Math.max(1, Math.min(50, Number(process.env.CVP_PUSH_MAX_ROUNDS) || 10));

/** 중앙의 비-2xx 응답 → 사람이 읽을 사유(본문 reason 을 읽는다 — EDGE2611-06). 순수 판정은 body 만 본다. */
export function centralFailText(status, body) {
  const reason = body && typeof body === 'object' && typeof body.reason === 'string' ? body.reason.slice(0, 300) : '';
  if (status === 413) return '본문이 중앙 수신 한도를 넘었습니다(413) — CVP_PUSH_CHUNK_BYTES 를 줄이세요';
  if (status === 404) return classifyCentral404Body(body).reason;
  // v2.620(EDGE2620-01): 중앙 등록부 손상 — 중앙이 소유 판정을 못 하므로 받지 않았다. 커서를 전진하지 않고 다음 주기에 다시 보낸다.
  if (status === 503 && body?.reason === 'registryUnreadable') return `중앙 CVP 등록부를 읽지 못해 받지 않았습니다(503)${typeof body.detail === 'string' ? ` — ${body.detail.slice(0, 300)}` : ''} · 커서를 전진하지 않고 다음 주기에 다시 보냅니다`;
  if (status === 503 && body?.dbUnavailable) return `중앙 CVP DB 를 쓸 수 없습니다(503)${reason ? ` — ${reason}` : ''} · 커서를 전진하지 않고 다음 주기에 다시 보냅니다`;
  return `HTTP ${status}${reason ? ` — ${reason}` : ''}`;
}
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

/**
 * v2.620(EDGE2620-05): 엣지 CVP 등록부를 못 읽으면(손상 → 보존) serversForThisNode() 가 [] 라 '위임 0대' 와 구분되지 않았다 —
 *   빈 servers 를 보내 중앙이 이 엣지의 CVP 상태를 비우고, 상태에는 '위임 CVP 0대 — 중앙 목록을 비웠습니다' 라는 틀린 문구가 남았다
 *   (스토리지 push v2.618 BUG-2 와 같은 구분의 CVP 누락). 이 경우 **보내지 않는다** — 표본은 커서 뒤에 남아 다음 주기에 간다.
 *   다음 cvp-config pull 이 등록부를 다시 쓰면 풀린다.
 */
function edgeRegistryError() {
  try { return registryLoadError(); } catch (e) { return { at: Date.now(), reason: e?.message || String(e) }; }
}

async function pushInner() {
  const regErr = edgeRegistryError();
  if (regErr) {
    // v2.744(최종 검토 FB — RD-R2·RG2744-01): 사유는 원문(JSON.parse 메시지의 파일 조각)이 아니라 요약이다 — 이 메시지는 _last.error(엣지 로그)·콘솔에 실린다.
    const e = new Error(`엣지 CVP 등록부를 읽지 못해 보내지 않았습니다(${summarizeRegistryError(regErr)?.text || '사유 미상'}) — '위임 0대' 가 아닙니다. 중앙 cvp-config pull 이 등록부를 다시 쓰면 풀립니다 · 표본은 커서 뒤에 남아 다음 주기에 갑니다`);
    e.kind = 'edge-registry-unreadable';
    throw e;
  }
  const servers = serversForThisNode();
  const statuses = servers.map(statusFor);
  const deviceItems = []; const deviceKeys = {}; const touch = []; const sentNow = []; const devSamples = []; const events = {}; const evMaxNow = new Map();
  const l2Items = []; const l2SentNow = []; let l2Acked = false; let l2OldCentral = false;   // v2.924(B-②)
  const epItems = []; const epMaxNow = new Map(); let epAcked = false; let epOldCentral = false;   // v2.929(C-③)
  const nowMs = Date.now();
  let evBytes = 0; let evHeld = 0;
  let devicesUnavailable = !(await db.available());
  if (!devicesUnavailable) {
    for (const srv of servers) {
      const recs = await db.deviceRecordsFor(db.LOCAL_AGENT, srv.id);
      if (recs == null) { devicesUnavailable = true; break; }
      // 장비 키 목록은 '온전히 읽은 적이 있을 때만' 싣는다 — 이번 기동에서 아직 수집 전이고 DB 도 비면 중앙 행을 지우지 않는다.
      const st = getStatus(srv.id);
      if (recs.length || (st?.ok && st.deviceCount === 0)) deviceKeys[srv.id] = recs.map((d) => d.key);
      // v2.641 ④: 이 CVP 의 이벤트 중 지난 push 뒤 새로 생기거나 바뀐 것(재기동 뒤에는 최근 7일 최대 EVENT_PUSH_MAX 건 — 중앙이 upsert 한다).
      try {
        const ev = await db.listEvents({ agent: db.LOCAL_AGENT, cvpId: srv.id, sinceMs: 7 * 86_400_000, limit: EVENT_PUSH_MAX });
        const wm = _evSent.get(srv.id) || 0;
        // v2.680(감사 F-04): 이벤트 바이트 상한 — pickEventsForPush 머리말.
        const pk = pickEventsForPush(ev.events || [], wm, EVENT_PUSH_BYTES - evBytes);
        const fresh = pk.fresh; evBytes += pk.bytes; evHeld += pk.held;
        if (fresh.length) {
          events[srv.id] = fresh.map(({ agent: _a, cvpId: _c, ...rest }) => rest);
          evMaxNow.set(srv.id, Math.max(...fresh.map((e) => Math.max(e.updatedAt || 0, e.ts || 0))));
        }
      } catch { /* 이벤트는 부가 정보 — 실패해도 장비 push 는 계속한다 */ }
      // v2.924(B-②): 바뀐 장비의 L2 레코드(메타 해시로 고르고, 고른 장비만 행을 읽는다).
      try {
        const metas = await db.l2MetaFor(db.LOCAL_AGENT, srv.id);
        for (const m of metas || []) {
          await new Promise((r) => setImmediate(r));   // 반증 L-1: 장비마다 양보(행을 읽고 JSON 을 만드는 동안 타이머를 막지 않게)
          const k = `${srv.id}|${m.key}`; const h = `${m.fdbHash}|${m.lldpHash}`;
          if (!l2Due(_l2Sent.get(k), m.fdbHash || m.lldpHash ? h : '', nowMs, { unsupportedAt: _l2Unsupported })) continue;
          const rec = await db.l2RecordFor(db.LOCAL_AGENT, srv.id, m.key);
          if (!rec) continue;
          l2Items.push({ t: 'l', v: { cvpId: srv.id, ...rec } });
          l2SentNow.push([k, h]);
        }
      } catch (e) { if (warnL2(e.message)) console.warn(`[cvp-push] L2(LLDP·MAC 테이블) 레코드를 읽지 못해 이번에는 싣지 않습니다: ${e.message}`); }
      // v2.929(C-③): 지난 ack 뒤 새로 물어본 EndpointLocation 결과(오래된 것부터 CVP 마다 500개). 구버전 중앙이면 보류.
      if (!(_epUnsupported && nowMs - _epUnsupported < L2_UNSUPPORTED_HOLD_MS)) {
        try {
          const eps = await db.endpointsSince(db.LOCAL_AGENT, srv.id, _epSentAt.get(srv.id) || 0, EP_PUSH_PER_CVP);
          for (const { seq, ...e } of eps || []) { epItems.push({ t: 'e', v: { cvpId: srv.id, ...e } }); epMaxNow.set(srv.id, Math.max(epMaxNow.get(srv.id) || 0, Number(seq) || 0)); }   // 커서 = 순번(반증 L-5)
        } catch (e) { if (warnL2(`ep:${e.message}`)) console.warn(`[cvp-push] EndpointLocation 결과를 읽지 못해 이번에는 싣지 않습니다: ${e.message}`); }
      }
      for (const d of recs) {
        if (d.sysAt != null && (d.cpuPct != null || d.memPct != null)) devSamples.push([srv.id, d.key, d.sysAt, d.cpuPct, d.memPct, d.memTotal ?? null]);
        const k = `${srv.id}|${d.key}`;
        const h = recordHash(d);
        const prev = _sent.get(k);
        if (prev && prev.h === h && nowMs - prev.at < FULL_REFRESH_MS) { touch.push([srv.id, d.key, d.ts]); continue; }
        deviceItems.push({ t: 'd', v: { cvpId: srv.id, ...d } });
        sentNow.push([k, h]);
      }
    }
  }
  const cursor0 = loadCursor();
  let rows = []; let maxRowid = cursor0; let dbMax = null;
  if (!devicesUnavailable) {
    const mx = await db.maxRowid();
    dbMax = mx;
    const cursor = mx != null && cursor0 > mx ? 0 : cursor0; // DB 재생성 뒤 낡은 커서 — 처음부터(중앙이 중복을 거른다)
    const r = await db.samplesAfter(cursor, MAX_ROWS);
    rows = r.rows; maxRowid = r.maxRowid;
  }
  const head = { agent: config.agent.name, servers: statuses, deviceKeys: devicesUnavailable ? null : deviceKeys, devicesUnavailable, touch, devSamples, events };
  const items = [...deviceItems, ...l2Items, ...epItems, ...rows.map((v) => ({ t: 'r', v }))];
  const chunks = chunkItems(items, CHUNK_BYTES, Buffer.byteLength(JSON.stringify(head)));
  // v2.620(RECENT2620-02): 한글 이름을 헤더에 원문으로 실으면 fetch 가 요청 자체를 던진다 — 안전할 때만 싣는다.
  const hdrs = { 'Content-Type': 'application/json', ...agentNameHeader(config.agent.name), 'X-Central-Token': config.agent.centralToken };
  let bytes = 0; let gz = 0; let drop = null; let touchedAt = null;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const body = {
      ...(i === 0 ? head : { agent: config.agent.name }), chunk: i, chunks: chunks.length,
      devices: c.filter((x) => x.t === 'd').map((x) => x.v), rows: c.filter((x) => x.t === 'r').map((x) => x.v),
      ...(c.some((x) => x.t === 'l') ? { l2: c.filter((x) => x.t === 'l').map((x) => x.v) } : {}),   // v2.924(B-②)
      ...(c.some((x) => x.t === 'e') ? { ep: c.filter((x) => x.t === 'e').map((x) => x.v) } : {}),   // v2.929(C-③)
    };
    const json = Buffer.from(JSON.stringify(body));
    let payload = json; const h = { ...hdrs };
    if (PUSH_GZIP) { try { payload = await gzipAsync(json); h['Content-Encoding'] = 'gzip'; } catch { payload = json; } }
    bytes += json.length; gz += payload.length;
    /*
     * v2.743(감사 LEFT-03): 503 은 호출 안에서 다시 보내지 않는다(postNo503Retry — isidu·edge-log-result 와 같은 규칙). 중앙의 503 은
     *   지속형(DB 불가·등록부 손상 — Retry-After 60초)이거나 큰 본문 해석 혼잡(일시)이고, 예전 retries:2 는 같은 gzip 청크를 30~45초
     *   간격으로 두 번 더 올렸다(지속형이면 결과도 같다). 커서·보낸 해시는 아래 throw 로 그대로 두므로 다음 주기에 다시 간다.
     *   그 밖의 일시 상태(408·429·500·502·504)·연결 오류는 예전처럼 재시도한다(retries:2).
     */
    const res = await postNo503Retry(`${config.agent.centralUrl}/api/central/cvp-data?agent=${encodeURIComponent(config.agent.name || '')}`, { method: 'POST', headers: h, body: payload, timeoutMs: 60_000 }, { retries: 2 });
    if (!res.ok) {
      // v2.611(EDGE2611-06): 본문의 reason 을 읽는다(상한 64KB) — 예전엔 'HTTP 429/500' 만 남아 원인을 알 수 없었다.
      let errBody = null;
      try { errBody = await readJsonCapped(res, 64 * 1024, '중앙 오류 응답'); } catch { try { await res.body?.cancel?.(); } catch { /* */ } }
      const e = new Error(`cvp-data ← ${centralFailText(res.status, errBody)} (청크 ${i + 1}/${chunks.length})`);
      if (res.status === 503 && errBody?.dbUnavailable) e.kind = 'central-db-unavailable';
      throw e;
    }
    const reply = await readCentralReply(res);
    // v2.611(CEN2611-03·EDGE2611-04): 구버전 중앙은 DB 를 못 열어도 200 + saved.unavailable 을 준다 — 받은 것으로 보면
    //   커서가 전진하고 _sent 가 기록돼 그 표본·레코드는 영원히 다시 가지 않는다. 실패로 다루고 다음 주기에 다시 보낸다.
    if (reply?.saved?.unavailable) {
      const e = new Error(`cvp-data ← 중앙 CVP DB 를 쓸 수 없어 적재하지 못했습니다(200 · saved.unavailable — 구버전 중앙) · 커서를 전진하지 않습니다 (청크 ${i + 1}/${chunks.length})`);
      e.kind = 'central-db-unavailable';
      throw e;
    }
    if (i === 0 && reply?.saved && typeof reply.saved.touched === 'number') touchedAt = reply.saved.touched;
    { const a = l2AckOf(reply); if (a === 'acked') l2Acked = true; else if (a === 'old-central') l2OldCentral = true; }   // v2.924(B-② · 반증 L-7)
    { const a = epAckOf(reply); if (a === 'acked') epAcked = true; else if (a === 'old-central') epOldCentral = true; }   // v2.929(C-③)
    drop = mergeDrop(drop, dropSummaryOf(reply));
  }
  if (rows.length) saveCursor(maxRowid);
  for (const [c, m] of evMaxNow) _evSent.set(c, Math.max(_evSent.get(c) || 0, m));
  for (const [k, h] of sentNow) _sent.set(k, { h, at: nowMs });
  // v2.924(B-②): 중앙이 L2 를 받았다고 답했을 때만 보낸 것으로 친다. 실었는데 답이 없으면 구버전 중앙 — 보류 시각을 적는다.
  if (l2SentNow.length) {
    if (l2Acked) { for (const [k, h] of l2SentNow) _l2Sent.set(k, { h, at: nowMs }); _l2Unsupported = 0; }
    else if (l2OldCentral) { _l2Unsupported = nowMs; if (warnL2('unsupported')) console.warn(`[cvp-push] 중앙이 LLDP·MAC 테이블을 받았다고 답하지 않았습니다(구버전 중앙으로 보입니다) — ${Math.round(L2_UNSUPPORTED_HOLD_MS / 3600_000)}시간 동안 싣지 않습니다`); }
  }
  // v2.929(C-③): EndpointLocation 도 중앙이 받았다고 답했을 때만 보낸 것으로 친다(실었는데 답이 없으면 구버전 중앙 — 보류).
  if (epItems.length) {
    if (epAcked) { for (const [c, at] of epMaxNow) _epSentAt.set(c, Math.max(_epSentAt.get(c) || 0, at)); _epUnsupported = 0; }
    else if (epOldCentral) { _epUnsupported = nowMs; if (warnL2('ep-unsupported')) console.warn(`[cvp-push] 중앙이 EndpointLocation 을 받았다고 답하지 않았습니다(구버전 중앙으로 보입니다) — ${Math.round(L2_UNSUPPORTED_HOLD_MS / 3600_000)}시간 동안 싣지 않습니다`); }
  }
  // v2.611(EDGE2611-04): 중앙에 그 장비 행이 없으면(중앙 DB 교체·정리) touch 는 아무것도 갱신하지 않는다 — 해시를 버려
  //   다음 push 에 레코드 전체를 다시 보낸다(한 시간 전량 갱신을 기다리지 않게).
  let touchMissing = 0;
  if (touchedAt != null && touchedAt < touch.length) {
    touchMissing = touch.length - touchedAt;
    for (const [c, key] of touch) _sent.delete(`${c}|${key}`);
  }
  // 등록부에서 빠진 CVP·장비의 해시는 버린다(누수 방지 — 다시 나타나면 전량을 보낸다).
  const liveKeys = new Set(Object.entries(deviceKeys).flatMap(([c, ks]) => ks.map((x) => `${c}|${x}`)));
  if (!devicesUnavailable) for (const k of [..._sent.keys()]) if (!liveKeys.has(k)) _sent.delete(k);
  if (!devicesUnavailable) for (const k of [..._l2Sent.keys()]) if (!liveKeys.has(k)) _l2Sent.delete(k);
  { const liveCvp = new Set(servers.map((x) => String(x.id))); for (const k of [..._evSent.keys()]) if (!liveCvp.has(k)) _evSent.delete(k); for (const k of [..._epSentAt.keys()]) if (!liveCvp.has(k)) _epSentAt.delete(k); }
  warnDrop('cvp-push', drop);
  const cursorNow = rows.length ? maxRowid : cursor0;
  const backlogRows = dbMax != null ? Math.max(0, dbMax - cursorNow) : null;
  const more = rows.length >= MAX_ROWS;
  const lost = db.lostUnsentStats();
  _last = { at: Date.now(), ok: true, servers: statuses.length, devices: deviceItems.length, touched: touch.length, samples: rows.length, chunks: chunks.length, bytes, gzBytes: gz,
    l2: l2Items.length, ep: epItems.length,
    ...(_epUnsupported && nowMs - _epUnsupported < L2_UNSUPPORTED_HOLD_MS ? { epHeldUntil: _epUnsupported + L2_UNSUPPORTED_HOLD_MS, epHeldNote: '중앙이 EndpointLocation 을 받지 않아(구버전 중앙) 보류 중입니다' } : {}),
    ...(_l2Unsupported && nowMs - _l2Unsupported < L2_UNSUPPORTED_HOLD_MS ? { l2HeldUntil: _l2Unsupported + L2_UNSUPPORTED_HOLD_MS, l2HeldNote: '중앙이 LLDP·MAC 테이블을 받지 않아(구버전 중앙) 보류 중입니다' } : {}),
    backlogRows, more, ...(evHeld ? { eventsHeld: evHeld, eventsHeldNote: '이벤트 바이트 상한으로 다음 주기에 보냅니다' } : {}), ...(touchMissing ? { touchMissing } : {}), ...(lost.total ? { lostUnsent: lost.total, lostUnsentAt: lost.at } : {}),
    ...(devicesUnavailable ? { devicesUnavailable: true, note: '엣지 DB 를 쓸 수 없어 상태만 보냈습니다(중앙의 장비 목록은 그대로)' } : {}),
    ...(servers.length ? {} : { cleared: true, note: '위임 CVP 0대 — 중앙의 이 엣지 목록을 비웠습니다' }),
    ...(drop ? { rejected: drop.rejected, dropText: drop.text } : {}) };
  return { ok: true, sent: rows.length, devices: deviceItems.length, touched: touch.length, servers: statuses.length, chunks: chunks.length, more, backlogRows, ...(drop ? { rejected: drop.rejected } : {}) };
}

/** 한 번 보낸다. 진행 중이면 끝난 뒤 한 번 더 보내고 그 결과를 돌려준다. */
export async function pushCvpNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  if (_busy) { _again = true; return _busy; }
  const run = async () => {
    try { return await pushInner(); }
    catch (e) {
      const lost = db.lostUnsentStats();
      _last = { at: Date.now(), ok: false, error: e.message, ...(e.kind ? { kind: e.kind } : {}), ...(lost.total ? { lostUnsent: lost.total, lostUnsentAt: lost.at } : {}) };
      // 같은 사유는 10분에 1줄(중앙 DB 불가 래치면 매 주기 같은 실패다 — 로그만 줄이고 재전송은 계속한다).
      if (failLog('push', e.message.replace(/\(청크 \d+\/\d+\)/, ''))) console.warn(`[cvp-push] 실패: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  };
  _busy = (async () => {
    // v2.611(EDGE2611-05): 꽉 찬 페이지(MAX_ROWS)를 읽었으면 같은 호출 안에서 이어 보낸다(형제 sanswitch perfPush 의 more 반복).
    //   한 호출의 반복은 MAX_ROUNDS 로 묶고 남은 것은 상태의 backlogRows 가 말한다.
    let r; let rounds = 0;
    do { _again = false; r = await run(); rounds++; } while ((_again || (r?.ok && r.more)) && rounds < MAX_ROUNDS);
    if (r?.ok && r.more) console.warn(`[cvp-push] 한 번에 ${MAX_ROUNDS}회를 보냈습니다 — 남은 표본(약 ${r.backlogRows ?? '?'}행)은 다음 주기 push 에 실립니다`);
    _again = false;
    return r;
  })().finally(() => { _busy = null; });
  return _busy;
}

export function startCvpPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(pushMs, () => pushCvpNow(), { firstDelayMs: 70_000, name: 'CVP push' });
}
export function cvpPushStatus() { return { ...(_last || {}), intervalMs: pushMs(), cursor: loadCursor() }; }
export function _resetForTest() { _busy = null; _again = false; _last = null; _sent.clear(); _evSent.clear(); _epSentAt.clear(); _epUnsupported = 0; _l2Sent.clear(); _l2Unsupported = 0; try { fs.rmSync(CURSOR_FILE()); } catch { /* */ } }
