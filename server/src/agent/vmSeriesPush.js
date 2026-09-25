/**
 * agent/vmSeriesPush.js — 위임(엣지) vCenter 의 스파이크 수집 결과를 중앙으로 push(v2.510).
 *
 * 중앙은 collectMode='site' vCenter 에 직접 SOAP 를 걸지 않으므로(고RTT 회피) 실시간 표본도 못 받는다.
 * 엣지의 vmseries 폴러가 로컬 vCenter 를 수집해 자기 DB 에 저장한 **같은 주기 결과**(스파이크 순간 패킹
 * + 시간별 표본 수 + 커서)를 그대로 중앙에 올린다. 중앙은 /api/central/vmseries 에서 받아 그 vCenter 의
 * 독립 DB 파일에 커밋한다 — 중앙 화면이 '위임 vCenter 는 빈 화면' 이 되지 않게(CLAUDE.md v2.493 규칙).
 *
 * 규약(guestDiskPush 와 동일): gzip(중앙 express.json 이 Content-Encoding 자동 해제) + 청크(요청당 압축 전
 * 700KB — 중앙 BIG_JSON 16MB 한도의 훨씬 아래지만 고RTT 회선에서 한 요청이 길어지지 않게) + 스파이크 행을 먼저
 * 보내고 **마지막 청크**가 커서·커버리지를 싣는다(v2.601 EDGE2601-02 — 예전에는 청크 0). 413 은 재시도 대상이 아니므로
 * 로그에 남긴다(조용한 전량 소실 방지 — guest-disk v2.466 사고).
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import os from 'node:os';
import { config } from '../config.js';
import { reqTimeoutMs } from './envTimeout.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readCentralReply } from '../util/centralReply.js'; // v2.613 CONTRACT2613-03
import { createChangeLogger } from '../util/logThrottle.js';

const gzipAsync = promisify(zlib.gzip);
const PUSH_GZIP = process.env.AGENT_PUSH_GZIP !== 'false';
const CHUNK_BYTES = Math.max(100_000, Number(process.env.AGENT_VMSERIES_CHUNK_BYTES) || 700_000);

let last = null; // { at, vcenterId, chunks, bytes, gzBytes, ms, error }

export function vmSeriesPushEnabled() {
  return !!(config.agent.pushVmSeries && config.agent.centralUrl);
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Agent-Hostname': os.hostname(),
    'X-Agent-Name': config.agent.name,
    ...extra,
    ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}),
  };
}

/*
 * ⚠⚠ v2.600 EDGE2600-01 — **청크 크기는 실제로 보낼 base64 길이로 잰다.** 예전에는 `r.buf?.length` 로 쟀는데
 * pushVmSeriesSlice 가 행을 `{…, data: base64}` 로 바꾼 **뒤에** 이 함수를 불러 buf 가 늘 없었다 — 행마다 120B 로
 * 계산돼 분할이 한 번도 일어나지 않았다(재현: 스파이크 4행 1.6MB 가 청크 1개). 중앙은 청크당 20,000행에서 자르므로
 * (routes/central.js /vmseries) 행 수 상한도 함께 지킨다 — 넘기면 뒷부분이 조용히 버려진다.
 */
export const CHUNK_MAX_ROWS = 20_000;
function rowBytes(r) {
  const b64 = typeof r?.data === 'string' ? r.data.length : Math.ceil(((r?.buf?.length || 0) * 4) / 3);
  const cols = Array.isArray(r?.cols) ? r.cols.reduce((a, c) => a + String(c).length + 3, 0) : 0;
  return 120 + b64 + cols + String(r?.ref ?? '').length;
}
/** 스파이크 행을 요청당 CHUNK_BYTES 이하·CHUNK_MAX_ROWS 행 이하로 나눈다(보낼 base64 길이 기준). */
export function chunkSpikeRows(rows, limitBytes = CHUNK_BYTES, maxRows = CHUNK_MAX_ROWS) {
  const chunks = [[]]; let cur = 0;
  for (const r of rows) {
    const est = rowBytes(r);
    const tail = chunks[chunks.length - 1];
    if (tail.length && (cur + est > limitBytes || tail.length >= maxRows)) { chunks.push([]); cur = 0; }
    chunks[chunks.length - 1].push(r); cur += est;
  }
  return chunks;
}

const _dropLog = createChangeLogger({ windowMs: 10 * 60_000 });
async function post(body) {
  const json = Buffer.from(JSON.stringify(body));
  let payload = json; let hdrs = headers();
  if (PUSH_GZIP) {
    try { payload = await gzipAsync(json); hdrs = headers({ 'Content-Encoding': 'gzip' }); } catch { /* 원본 전송 */ }
  }
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/vmseries`, {
    method: 'POST', headers: hdrs, body: payload,
    timeoutMs: reqTimeoutMs(process.env.AGENT_VMSERIES_PUSH_TIMEOUT_MS, 120_000), retries: 1,
  });
  if (res.status === 413) throw new Error('vmseries -> 413 (중앙 본문 한도 초과 — 청크 크기를 줄이세요)');
  if (!res.ok) throw new Error(`vmseries -> ${res.status}`);
  // v2.613(감사 CONTRACT2613-03): 중앙 `sanitizeVmSeriesBody` 는 레이아웃이 맞지 않는 행을 **조용히** 버린다 — 응답의 `spikes`(받아들인 행 수)를
  //   보낸 행 수와 대조해 모자라면 상태·콘솔에 남긴다(예전에는 `res.ok` 만 봐 알 길이 없었다). 응답을 못 읽으면 판정하지 않는다(null).
  const j = await readCentralReply(res);
  const sentRows = Array.isArray(body.spikes) ? body.spikes.length : 0;
  const accepted = j && Number.isFinite(Number(j.spikes)) ? Number(j.spikes) : null;
  const dropped = accepted != null && accepted < sentRows ? sentRows - accepted : 0;
  return { bytes: json.length, gzBytes: payload.length, sentRows, accepted, dropped };
}

/**
 * 한 vCenter 의 한 주기 결과를 push. res = collectVcenterSpikes 반환값.
 * 마지막 청크 = { cover, cursors, stats, historicalInterval, spikes[..] } · 그 앞 = { spikes } 만(v2.601).
 */
export async function pushVmSeriesSlice(vc, res) {
  const started = Date.now();
  // v2.600 EDGE2600-02: mxcpu·mxmem(행 단위 최대 — 전 VM 순위가 BLOB 을 풀지 않고 쓴다)도 싣는다. 예전에는 버려져
  //   중앙이 -1 로 저장했고 위임 vCenter 의 최대 CPU/MEM 이 언제나 '—' 였다(수신측은 이미 받게 되어 있다).
  const rows = (res.spikes || []).map((s) => ({ kind: s.kind, ref: s.ref, t0: s.t0, t1: s.t1, n: s.n, cols: s.cols, data: s.buf.toString('base64'), mxcpu: s.mxcpu, mxmem: s.mxmem }));
  const chunks = chunkSpikeRows(rows);
  let bytes = 0; let gzBytes = 0; let sentRows = 0; let dropped = 0; let unverified = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const body = {
        agent: config.agent.name, source: vc?.mock === true ? 'mock' : config.dataSource,
        vcenterId: vc.id, vcenterName: vc.name || vc.id, generatedAt: Date.now(),
        chunk: i, chunks: chunks.length,
        spikes: chunks[i],
        // ⚠ v2.601(감사 EDGE2601-02): 커버리지(cover)·커서·통계는 **마지막 청크**에 싣는다. 예전에는 청크 0 에 실어 중앙이 그 즉시
        //   '이 시간대를 측정했다' 를 커밋했는데, 뒤 청크가 실패하면(재시도 없음 — 엣지 커서는 이미 전진) 잃은 스파이크가
        //   중앙 화면에서 **'측정됨 · 스파이크 없음'** 으로 보였다. 마지막 청크까지 도달했을 때만 측정 사실을 올리면 실패는
        //   정직하게 '미측정' 으로 남는다. 청크가 1개면 예전과 같다(0 = 마지막).
        ...(i === chunks.length - 1 ? { cover: res.cover || [], cursors: res.cursors || [], stats: res.stats || null, historicalInterval: res.historicalInterval || null } : {}),
      };
      const r = await post(body);
      bytes += r.bytes; gzBytes += r.gzBytes; sentRows += r.sentRows; dropped += r.dropped; if (r.accepted == null) unverified += 1;
    }
    // v2.613 CONTRACT2613-03: 중앙이 받아들인 행 수가 보낸 행 수보다 적으면 그 차이를 밝힌다(형식 불일치 행 — 중앙 화면에 그만큼 없다).
    const dropNote = dropped ? { dropped: { rows: dropped, sentRows, text: `중앙이 스파이크 행 ${dropped}/${sentRows}개를 받아들이지 않았습니다(형식 불일치 — 그만큼 중앙 화면에 없습니다)` } } : {};
    if (dropped && _dropLog(vc.id, String(dropped))) console.warn(`[vmseries-push] ${vc.id}: ${dropNote.dropped.text}`);
    last = { at: Date.now(), vcenterId: vc.id, chunks: chunks.length, bytes, gzBytes, ms: Date.now() - started, error: null, ...dropNote, ...(unverified ? { replyUnread: unverified } : {}) };
    return { ok: true, chunks: chunks.length, bytes, gzBytes, ...dropNote };
  } catch (e) {
    last = { at: Date.now(), vcenterId: vc.id, chunks: chunks.length, bytes, gzBytes, ms: Date.now() - started, error: e?.message || String(e) };
    console.warn(`[vmseries-push] ${vc.id} 실패: ${e?.message || e}`);
    throw e;
  }
}

export function vmSeriesPushStatus() {
  return { enabled: vmSeriesPushEnabled(), centralUrl: config.agent.centralUrl, gzip: PUSH_GZIP, chunkBytes: CHUNK_BYTES, last };
}
