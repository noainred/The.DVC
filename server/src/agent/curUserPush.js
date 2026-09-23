/**
 * agent/curUserPush.js — 위임(엣지) vCenter 의 '현재 사용자' 결과를 중앙으로 push(v2.520).
 *
 * 중앙은 `collectMode='site'` vCenter 에 직접 SOAP 를 걸지 않으므로(고RTT 회피) 그 법인의
 * `config.extraConfig` 도 읽을 수 없다. 엣지의 curuser 폴러가 읽은 **같은 주기 결과**를 그대로
 * 올린다 — 중앙 화면이 '위임 법인은 빈 화면' 이 되지 않게(CLAUDE.md v2.493).
 *
 * 규약(v2.503 새 push 경로 체크리스트를 모두 지킨다):
 *  ① **gzip** — 중앙 express.json 이 Content-Encoding 을 자동 해제한다.
 *  ② 중앙 **BIG_JSON 등록**(`index.js` `/api/central/curuser`). `express.json` 기본 1MB 는
 *     **해제 후 길이**라 대상이 많은 법인 1곳이 단독으로 413 이 될 수 있다.
 *  ③ **413 로그** — 413 은 `resilientFetch` 재시도 대상이 **아니라서** 그 법인 데이터가 조용히
 *     전량 소실된다(guest-disk v2.466 사고). 그래서 명시적으로 오류를 던지고 로그에 남긴다.
 *  ④ 청크 — 요청당 레코드 수로 나눈다. 레코드는 계정명 목록을 포함해 크기가 변동하므로
 *     **직렬화 길이로 다시 확인**한다(개수만 보면 세션이 많은 RDS 호스트에서 넘칠 수 있다).
 *
 * ⚠ 원문(`raw` — quser 출력 전체)은 **push 하지 않는다**. 진단용이고 중앙에서 다시 파싱할 일이
 *   없으며, 그대로 올리면 전송량이 수십 배가 된다(400대 × 최대 8KB).
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import os from 'node:os';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';

const gzipAsync = promisify(zlib.gzip);
const PUSH_GZIP = process.env.AGENT_PUSH_GZIP !== 'false';
const CHUNK_BYTES = Math.max(100_000, Number(process.env.AGENT_CURUSER_CHUNK_BYTES) || 700_000);
const CHUNK_MAX_RECORDS = 300;

let last = null;    // { at, chunks, records, bytes, gzBytes, ms, error }

export function curUserPushEnabled() {
  return !!(config.agent.pushCurUser && config.agent.centralUrl);
}
export function curUserPushStatus() { return { enabled: curUserPushEnabled(), last }; }

/** push 에 실을 최소 필드만 남긴다(원문·내부 필드 제외). 순수 — 테스트가 고정. */
export function slimRecord(r) {
  return {
    vmId: String(r.vmId || ''), vcenterId: String(r.vcenterId || ''),
    name: String(r.name || '').slice(0, 200), folder: String(r.folder || '').slice(0, 400),
    at: r.at == null ? null : Number(r.at), kind: String(r.kind || 'unknown'), ok: !!r.ok,
    active: r.active == null ? null : Number(r.active),
    disc: r.disc == null ? null : Number(r.disc),
    other: r.other == null ? null : Number(r.other),
    sessions: r.sessions == null ? null : Number(r.sessions),
    users: (r.users || []).slice(0, 200).map((u) => ({ name: String(u.name || '').slice(0, 128), kind: String(u.kind || 'other') })),
    error: String(r.error || '').slice(0, 300), guestHost: String(r.guestHost || '').slice(0, 120),
  };
}

/** 레코드를 요청당 한도 이하로 나눈다(개수 + 직렬화 길이 **둘 다**). 순수. */
export function chunkRecords(records, limitBytes = CHUNK_BYTES, maxRecords = CHUNK_MAX_RECORDS) {
  const chunks = [[]]; let cur = 0;
  for (const r of records || []) {
    const est = JSON.stringify(r).length + 2;
    const tail = chunks[chunks.length - 1];
    if (tail.length && (cur + est > limitBytes || tail.length >= maxRecords)) { chunks.push([]); cur = 0; }
    chunks[chunks.length - 1].push(r); cur += est;
  }
  return chunks;
}

async function post(body) {
  const json = Buffer.from(JSON.stringify(body));
  const headers = {
    'Content-Type': 'application/json',
    'X-Agent-Hostname': os.hostname(),
    'X-Agent-Name': config.agent.name,
    ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}),
  };
  let payload = json;
  if (PUSH_GZIP) {
    try { payload = await gzipAsync(json); headers['Content-Encoding'] = 'gzip'; } catch { payload = json; }
  }
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/curuser`, {
    method: 'POST', headers, body: payload,
    timeoutMs: Number(process.env.AGENT_CURUSER_PUSH_TIMEOUT_MS) || 60_000, retries: 1,
  });
  if (res.status === 413) throw new Error('curuser -> 413 (중앙 본문 한도 초과 — 청크 크기를 줄이세요. 이 요청은 재시도되지 않으므로 그만큼 소실됩니다)');
  if (!res.ok) throw new Error(`curuser -> ${res.status}`);
  return { bytes: json.length, gzBytes: payload.length };
}

/**
 * 한 주기 결과 push. 청크 0 이 **그 엣지가 담당한 vCenter 목록**을 함께 실어 중앙이 해당
 * 법인의 latest 를 교체할 수 있게 한다(대상에서 빠진 VM 의 낡은 값이 남지 않게).
 */
export async function pushCurUserRecords(records, { generatedAt = Date.now() } = {}) {
  if (!curUserPushEnabled()) return { ok: false, reason: 'push 비활성' };
  const slim = (records || []).map(slimRecord).filter((r) => r.vmId && r.vcenterId);
  const vcenterIds = [...new Set(slim.map((r) => r.vcenterId))];
  const chunks = chunkRecords(slim);
  const t0 = Date.now();
  let bytes = 0; let gzBytes = 0; let sent = 0;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const r = await post({
        agent: config.agent.name, generatedAt, chunk: i, chunks: chunks.length,
        ...(i === 0 ? { vcenterIds } : {}),
        records: chunks[i],
      });
      bytes += r.bytes; gzBytes += r.gzBytes; sent++;
    }
  } catch (e) {
    // v2.583 감사 #33: 실패도 상태에 남긴다 — 예전에는 `last` 가 **직전 성공**에 머물러 엣지 로그의 push.curUser
    //   항목이 실패 중에도 '정상' 으로 보였다(v2.566 '새 엣지 push 경로는 실패 사유를 상태에 싣는다' — 형제
    //   vmSeriesPush 는 이미 그랬다).
    last = { at: Date.now(), chunks: chunks.length, sentChunks: sent, records: slim.length, bytes, gzBytes, ms: Date.now() - t0, error: e?.message || String(e) };
    console.warn(`[curuser-push] 실패(${sent}/${chunks.length} 청크 전송 후): ${e?.message || e}`);
    throw e;
  }
  last = { at: Date.now(), chunks: chunks.length, records: slim.length, bytes, gzBytes, ms: Date.now() - t0, error: null };
  return { ok: true, ...last };
}
