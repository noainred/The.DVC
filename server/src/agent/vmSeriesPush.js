/**
 * agent/vmSeriesPush.js — 위임(엣지) vCenter 의 스파이크 수집 결과를 중앙으로 push(v2.510).
 *
 * 중앙은 collectMode='site' vCenter 에 직접 SOAP 를 걸지 않으므로(고RTT 회피) 실시간 표본도 못 받는다.
 * 엣지의 vmseries 폴러가 로컬 vCenter 를 수집해 자기 DB 에 저장한 **같은 주기 결과**(스파이크 순간 패킹
 * + 시간별 표본 수 + 커서)를 그대로 중앙에 올린다. 중앙은 /api/central/vmseries 에서 받아 그 vCenter 의
 * 독립 DB 파일에 커밋한다 — 중앙 화면이 '위임 vCenter 는 빈 화면' 이 되지 않게(CLAUDE.md v2.493 규칙).
 *
 * 규약(guestDiskPush 와 동일): gzip(중앙 express.json 이 Content-Encoding 자동 해제) + 청크(요청당 압축 전
 * 700KB — 중앙 BIG_JSON 16MB 한도의 훨씬 아래지만 고RTT 회선에서 한 요청이 길어지지 않게) + 청크 0 이
 * 커서·커버리지를 실어 보내고 이후 청크는 스파이크 행만 추가 upsert. 413 은 재시도 대상이 아니므로
 * 로그에 남긴다(조용한 전량 소실 방지 — guest-disk v2.466 사고).
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import os from 'node:os';
import { config } from '../config.js';
import { reqTimeoutMs } from './envTimeout.js';
import { resilientFetch } from '../util/resilientFetch.js';

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
  return { bytes: json.length, gzBytes: payload.length };
}

/**
 * 한 vCenter 의 한 주기 결과를 push. res = collectVcenterSpikes 반환값.
 * 청크 0 = { cover, cursors, stats, historicalInterval, spikes[0..] } · 이후 = { spikes } 만.
 */
export async function pushVmSeriesSlice(vc, res) {
  const started = Date.now();
  // v2.600 EDGE2600-02: mxcpu·mxmem(행 단위 최대 — 전 VM 순위가 BLOB 을 풀지 않고 쓴다)도 싣는다. 예전에는 버려져
  //   중앙이 -1 로 저장했고 위임 vCenter 의 최대 CPU/MEM 이 언제나 '—' 였다(수신측은 이미 받게 되어 있다).
  const rows = (res.spikes || []).map((s) => ({ kind: s.kind, ref: s.ref, t0: s.t0, t1: s.t1, n: s.n, cols: s.cols, data: s.buf.toString('base64'), mxcpu: s.mxcpu, mxmem: s.mxmem }));
  const chunks = chunkSpikeRows(rows);
  let bytes = 0; let gzBytes = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const body = {
        agent: config.agent.name, source: vc?.mock === true ? 'mock' : config.dataSource,
        vcenterId: vc.id, vcenterName: vc.name || vc.id, generatedAt: Date.now(),
        chunk: i, chunks: chunks.length,
        spikes: chunks[i],
        ...(i === 0 ? { cover: res.cover || [], cursors: res.cursors || [], stats: res.stats || null, historicalInterval: res.historicalInterval || null } : {}),
      };
      const r = await post(body);
      bytes += r.bytes; gzBytes += r.gzBytes;
    }
    last = { at: Date.now(), vcenterId: vc.id, chunks: chunks.length, bytes, gzBytes, ms: Date.now() - started, error: null };
    return { ok: true, chunks: chunks.length, bytes, gzBytes };
  } catch (e) {
    last = { at: Date.now(), vcenterId: vc.id, chunks: chunks.length, bytes, gzBytes, ms: Date.now() - started, error: e?.message || String(e) };
    console.warn(`[vmseries-push] ${vc.id} 실패: ${e?.message || e}`);
    throw e;
  }
}

export function vmSeriesPushStatus() {
  return { enabled: vmSeriesPushEnabled(), centralUrl: config.agent.centralUrl, gzip: PUSH_GZIP, chunkBytes: CHUNK_BYTES, last };
}
