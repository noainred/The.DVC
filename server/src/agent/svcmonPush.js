/**
 * 성능점검 엣지 위임 — 엣지(원격 법인) 측 push 워커 (RMA Active 방식).
 *
 * 이 서버가 자기 로컬에서 실행한 성능점검 결과를 중앙(OC2)의
 * `POST /api/central/svcmon-report` 로 주기적으로 밀어 올린다. 중앙은 그 대상을 직접 찌르지
 * 않으므로 고RTT(폴란드·미국동부 800ms+)가 응답시간 판정을 오염시키지 않는다.
 *
 * ## 왜 전량 스냅샷인가 (델타가 아닌)
 * 엣지 내부에서도 항목이 밀릴 수 있다. 델타(변경분)만 보내면 중앙은 '여전히 ok' 와
 * '안 돌았다'를 구별할 수 없다 — 둘 다 '보고 없음'이 된다. 전량을 보내면 중앙이 행별
 * 신선도로 그 차이를 표현할 수 있다.
 *
 * ## 왜 청크인가
 * **gzip 은 본문 한도를 완화하지 않는다.** 한도는 압축을 해제한 뒤 크기에 걸리고(실측:
 * gzip 66KB 본문이 2.63MB 로 해제되어 413), 게다가 413 은 재시도 대상이 아니라
 * (`util/resilientFetch.js` RETRYABLE_STATUS) 초과분이 조용히 버려진다. 그래서 엣지가
 * **행 수 기준으로** 청크를 나누고, 413 을 받으면 청크를 절반으로 줄인다.
 *
 * ## 시각
 * 절대 시각을 보내지 않는다. 행마다 **구간값**(직렬화 시점 − 측정 시점)만 실어 보내고
 * 중앙이 `수신시각 − 구간값` 으로 환산한다 → 엣지 시계 오차에 둔감하다.
 *
 * ## 메타(경로·이름·호스트)
 * 상시 보내지 않는다. 중앙이 `needMeta:true` 로 요청한 다음 push 에만 동봉한다(추가
 * 엔드포인트 0개). `url`·`keyword`·`send`·`body`·`payload`·`soapAction` 은 **절대 싣지
 * 않는다** — 내부 API 경로·SOAP 본문·연결 후 보낼 명령이라 WAN 에 태울 이유가 없다.
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { snapshotResults, pollerStats } from '../svcmon/poller.js';
import { logStats } from '../svcmon/csvlog.js';

const gzipAsync = promisify(zlib.gzip);

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? Math.round(n) : d; };

/** push 주기(ms). 기본 60초 — 중앙의 무보고 판정(3배)과 맞물린다. */
const INTERVAL_MS = Math.max(15_000, envNum('SVCMON_PUSH_INTERVAL_MS', 60_000));
/** 청크당 행 수. 행당 약 65B 실측 → 2,000행 ≈ 130KB(기본 1MB 한도에 여유). */
const CHUNK_START = Math.max(100, envNum('SVCMON_PUSH_CHUNK', 2000));
const CHUNK_MIN = 250;
const PUSH_GZIP = process.env.SVCMON_PUSH_GZIP !== 'false';
const ENABLED = process.env.SVCMON_PUSH !== 'false';

let timer = null;
let running = false;      // single-flight — 고RTT 에서 주기보다 오래 걸리면 겹쳐 누적된다
let chunkRows = CHUNK_START;
let needMeta = true;      // 첫 push 는 메타를 함께 보낸다(중앙에 아무 것도 없으므로)
let sentMetaSig = '';
let snapSeq = 0;
let unsupportedUntil = 0; // 중앙이 404 면 구버전이다 — 1시간 백오프
let last = null;

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    // 이름을 헤더로 붙이면 중앙 미들웨어가 '개별 토큰 ↔ agent' 일치까지 검사한다(이중 방어).
    ...(config.agent.name ? { 'X-Agent-Name': config.agent.name } : {}),
    ...extra,
    ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}),
  };
}

async function postChunk(payload) {
  const json = Buffer.from(JSON.stringify(payload));
  let body = json;
  let hdrs = headers();
  if (PUSH_GZIP) {
    try { body = await gzipAsync(json); hdrs = headers({ 'Content-Encoding': 'gzip' }); }
    catch { body = json; hdrs = headers(); }     // 압축 실패는 원본 전송
  }
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/svcmon-report`, {
    method: 'POST', headers: hdrs, body,
    timeoutMs: envNum('SVCMON_PUSH_TIMEOUT_MS', 30_000), retries: 1,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없는 응답 허용 */ }
  return { status: res.status, ok: res.ok, data, bytes: json.length, wire: body.length };
}

/** 엣지의 실행 능력·환경 — 중앙이 '이 엣지의 판정 의미'를 알아야 한다. */
function capabilities(p) {
  return {
    platform: process.platform,
    // ping 은 CLI 가 없으면 TCP 연결 폴백으로 **판정 의미가 바뀐 채** 계속 동작한다.
    pingMode: p?.pool?.pingMode || 'unknown',
    svcmonEnabled: !!p?.enabled,
    // 중앙의 통신 진단(probe)이 이 포트로 TCP RTT 를 잰다.
    portalPort: Number(config.port) || 0,
    workers: p?.pool?.workers ?? null,
    inlineFallbacks: p?.pool?.inlineFallbacks ?? 0,
    version: config.version || '',
  };
}

export async function pushSvcmonNow() {
  if (!ENABLED) return { ok: false, reason: 'SVCMON_PUSH=false' };
  if (!config.agent.centralUrl) return { ok: false, reason: 'CENTRAL_URL 미설정' };
  if (!config.agent.centralToken) return { ok: false, reason: '중앙 토큰 미설정' };
  if (running) return { ok: false, reason: '이전 push 진행 중(겹침 방지)' };
  if (Date.now() < unsupportedUntil) {
    return { ok: false, reason: '중앙이 이 기능을 지원하지 않습니다(백오프 중)' };
  }

  running = true;
  const startedAt = Date.now();
  try {
    const p = pollerStats();
    const snap = snapshotResults({ withMeta: needMeta });
    snapSeq += 1;
    // snapId 는 엣지가 발급하는 단조 증가 값 — 한 스냅샷의 청크들이 이것으로 묶인다.
    const snapId = startedAt * 1000 + (snapSeq % 1000);

    // rows 를 청크로 나눈다. 행이 0개(항목 0개·아직 미실행)여도 **봉투 1개는 보낸다** —
    // 그래야 중앙이 '항목 없음'과 '엣지 죽음'을 구별할 수 있다(하트비트).
    const chunks = [];
    if (snap.rows.length === 0) chunks.push([]);
    else for (let i = 0; i < snap.rows.length; i += chunkRows) chunks.push(snap.rows.slice(i, i + chunkRows));
    // 메타는 첫 청크에만 싣는다(중복 전송 방지).
    const metaSig = snap.metaSig;

    let accepted = 0;
    let dropped = 0;
    let wire = 0;
    let bytes = 0;
    let nextNeedMeta = false;
    const errors = [];

    for (let idx = 0; idx < chunks.length; idx += 1) {
      const envelope = {
        v: 1,
        snapId,
        seq: idx + 1,
        total: chunks.length,
        sentAt: Date.now(),
        expectMs: INTERVAL_MS,
        items: snap.items,
        reported: snap.reported,
        poller: {
          tickMs: p.tickMs, maxPerTick: p.maxPerTick, lastSweepMs: p.lastSweepMs,
          lastCount: p.lastCount, overdueSkipped: p.overdueSkipped, maxLagMs: p.maxLagMs,
        },
        caps: capabilities(p),
        log: logStats(),
        metaSig,
        meta: idx === 0 && needMeta ? snap.meta : null,
        rows: chunks[idx],
      };
      let r = await postChunk(envelope);
      // 413 은 재시도 대상이 아니다 — 청크를 줄여 즉시 1회 재시도한다.
      if (r.status === 413 && chunkRows > CHUNK_MIN) {
        chunkRows = Math.max(CHUNK_MIN, Math.floor(chunkRows / 2));
        console.warn(`[svcmon-push] 413 — 청크를 ${chunkRows}행으로 줄여 재시도합니다.`);
        envelope.rows = envelope.rows.slice(0, chunkRows);
        r = await postChunk(envelope);
      }
      if (r.status === 404) {
        unsupportedUntil = Date.now() + 3_600_000;
        return { ok: false, reason: '중앙이 /api/central/svcmon-report 를 지원하지 않습니다(1시간 후 재시도).' };
      }
      bytes += r.bytes; wire += r.wire;
      if (!r.ok) { errors.push(`청크 ${idx + 1}/${chunks.length} → ${r.status}${r.data?.reason ? ` (${r.data.reason})` : ''}`); continue; }
      accepted += Number(r.data?.accepted) || 0;
      dropped += Number(r.data?.dropped) || 0;
      if (r.data?.needMeta) nextNeedMeta = true;
    }

    if (needMeta && !errors.length) sentMetaSig = metaSig;
    needMeta = nextNeedMeta;         // 중앙이 요청하면 다음 주기에 메타 동봉

    last = {
      at: Date.now(), ms: Date.now() - startedAt, snapId, chunks: chunks.length,
      rows: snap.rows.length, items: snap.items, accepted, dropped, bytes, wire,
      gzip: PUSH_GZIP, chunkRows, errors, metaSig: sentMetaSig,
    };
    if (errors.length) console.warn(`[svcmon-push] 일부 실패: ${errors.join(' · ')}`);
    return { ok: errors.length === 0, ...last };
  } finally {
    running = false;
  }
}

export function svcmonPushStatus() {
  return {
    enabled: ENABLED && !!config.agent.centralUrl && !!config.agent.centralToken,
    centralUrl: config.agent.centralUrl || '',
    agent: config.agent.name || '',
    intervalMs: INTERVAL_MS,
    chunkRows,
    gzip: PUSH_GZIP,
    needMeta,
    unsupportedUntil: unsupportedUntil || null,
    last,
  };
}

export function startSvcmonPush() {
  if (timer) return;
  if (!ENABLED || !config.agent.centralUrl || !config.agent.centralToken) return;
  // 엣지 이름 해시로 0~20초 지터 — 28개 엣지가 같은 초에 중앙을 때리지 않게 한다.
  const jitter = config.agent.name
    ? crypto.createHash('sha1').update(String(config.agent.name)).digest()[0] % 20_000
    : Math.floor(Math.random() * 20_000);
  setTimeout(() => {
    pushSvcmonNow().catch((e) => console.error('[svcmon-push] 실패:', e?.message || e));
    timer = setInterval(() => { pushSvcmonNow().catch(() => {}); }, INTERVAL_MS);
    timer.unref?.();
  }, 15_000 + jitter).unref?.();
  console.log(`[svcmon-push] 성능점검 결과 보고 시작 → ${config.agent.centralUrl} (${Math.round(INTERVAL_MS / 1000)}초 주기 · 청크 ${chunkRows}행 · 지터 ${Math.round(jitter / 1000)}초)`);
}
