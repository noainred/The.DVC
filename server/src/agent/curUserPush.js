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
import { reqTimeoutMs } from './envTimeout.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readCentralReply, dropSummaryOf, mergeDrop, warnDrop } from './centralReply.js'; // v2.606 EDGE2606-03

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
    // v2.607(감사 RECENT2607-02): 발행기가 원문을 잘랐다(인원은 하한) — 예전에는 이 화이트리스트에 없어 push 직전에 버려졌고,
    //   중앙 sanitizeCurUserRecords 의 'truncated === true' 가 늘 거짓이라 위임 법인만 부분 인원을 '정확한 N명' 으로 보였다.
    truncated: r.truncated === true || r.usersLowerBound === true,
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
    timeoutMs: reqTimeoutMs(process.env.AGENT_CURUSER_PUSH_TIMEOUT_MS, 60_000), retries: 1,
  });
  if (res.status === 413) throw new Error('curuser -> 413 (중앙 본문 한도 초과 — 청크 크기를 줄이세요. 이 요청은 재시도되지 않으므로 그만큼 소실됩니다)');
  if (!res.ok) throw new Error(`curuser -> ${res.status}`);
  // v2.606 EDGE2606-03: 200 이어도 중앙이 vCenter 단위로 거부할 수 있다(rejected:[vcenterId] — site 미등록·소유권).
  return { bytes: json.length, gzBytes: payload.length, drop: dropSummaryOf(await readCentralReply(res)) };
}

/**
 * 한 주기 결과 push. 청크 0 이 **그 엣지가 담당한 vCenter 목록**을 함께 실어 중앙이 해당
 * 법인의 latest 를 교체할 수 있게 한다(대상에서 빠진 VM 의 낡은 값이 남지 않게).
 */
export async function pushCurUserRecords(records, { generatedAt = Date.now(), clearVcenterIds = [] } = {}) {
  if (!curUserPushEnabled()) return { ok: false, reason: 'push 비활성' };
  const slim = (records || []).map(slimRecord).filter((r) => r.vmId && r.vcenterId);
  // v2.603(감사 EDGE2603-04): `clearVcenterIds` — 이번 주기에 대상이 **0이 된** vCenter. 레코드 없이 목록에만 실어 중앙이
  //   그 법인의 latest 를 비우게 한다(예전엔 레코드에서만 목록을 뽑아, 대상이 빠진 법인의 옛 행이 중앙에 무기한 남았다).
  const vcenterIds = [...new Set([...slim.map((r) => r.vcenterId), ...(Array.isArray(clearVcenterIds) ? clearVcenterIds : []).map(String).filter(Boolean)])];
  const chunks = chunkRecords(slim);
  const t0 = Date.now();
  let bytes = 0; let gzBytes = 0; let sent = 0; let drop = null;
  // v2.607(감사 LEFT2607-09): 청크 0 은 중앙의 그 법인 latest 를 **즉시 교체**한다(vcenterIds). 뒤 청크가 실패하면 다음 주기(기본 10분)까지
  //   앞 청크분만 '전체' 인 것처럼 남는다. sanswitch/push.js(v2.606 EDGE2606-04)와 같이 앞 청크가 이미 반영된 실패면 **한 번 전체를 다시**
  //   보내고, 그래도 실패하면 '중앙 목록이 부분 상태' 임을 상태·콘솔에 밝힌다. 교체/병합 프로토콜 자체는 바꾸지 않는다(구버전 중앙 호환).
  const sendAll = async () => {
    bytes = 0; gzBytes = 0; sent = 0; drop = null;
    let receivedRecords = 0;
    for (let i = 0; i < chunks.length; i++) {
      let r;
      try {
        r = await post({
          agent: config.agent.name, generatedAt, chunk: i, chunks: chunks.length,
          ...(i === 0 ? { vcenterIds } : {}),
          records: chunks[i],
        });
      } catch (e) { return { ok: false, error: e, received: sent, receivedRecords }; }
      bytes += r.bytes; gzBytes += r.gzBytes; sent++; receivedRecords += chunks[i].length; drop = mergeDrop(drop, r.drop);
    }
    return { ok: true, received: sent, receivedRecords };
  };
  let sr = await sendAll();
  let resent = false;
  let firstTry = null;
  if (!sr.ok && sr.received > 0) {
    firstTry = sr;
    console.warn(`[curuser-push] ${sr.error?.message || sr.error} (청크 ${sr.received + 1}/${chunks.length}) — 앞 청크 ${sr.received}개가 이미 중앙 목록을 교체했으므로 전체를 한 번 다시 보냅니다`);
    resent = true;
    sr = await sendAll();
  }
  if (!sr.ok) {
    const e = sr.error;
    // 재전송의 청크 0 이 실패했으면 중앙에는 **첫 시도의 부분 목록**이 남아 있다 — '직전 push 그대로' 라고 말하면 거짓이다.
    const ps = sr.received > 0 ? sr : (firstTry || sr);
    const partial = ps.received > 0;
    const note = partial
      ? `중앙 목록이 부분 상태입니다 — 청크 ${ps.received}/${chunks.length}(서버 ${ps.receivedRecords}/${slim.length}대)만 반영됐고 나머지는 다음 성공 push 까지 중앙 화면에 나오지 않습니다`
      : '첫 청크가 실패해 중앙 목록은 직전 push 그대로입니다';
    // v2.583 감사 #33: 실패도 상태에 남긴다 — 예전에는 `last` 가 **직전 성공**에 머물러 엣지 로그의 push.curUser
    //   항목이 실패 중에도 '정상' 으로 보였다(v2.566 '새 엣지 push 경로는 실패 사유를 상태에 싣는다' — 형제
    //   vmSeriesPush 는 이미 그랬다).
    last = {
      at: Date.now(), chunks: chunks.length, sentChunks: sent, records: slim.length, bytes, gzBytes, ms: Date.now() - t0,
      error: `${e?.message || String(e)}${resent ? ' · 전체 재전송도 실패' : ''} — ${note}`, resent,
      ...(partial ? { centralPartial: { receivedChunks: ps.received, chunks: chunks.length, receivedRecords: ps.receivedRecords, records: slim.length } } : {}),
      ...(drop ? { centralDropped: drop } : {}),
    };
    console.warn(`[curuser-push] 실패(${sent}/${chunks.length} 청크 전송 후): ${last.error}`);
    throw e;
  }
  last = { at: Date.now(), chunks: chunks.length, records: slim.length, ...(clearVcenterIds?.length ? { cleared: clearVcenterIds.length } : {}), bytes, gzBytes, ms: Date.now() - t0, error: null, ...(resent ? { resent: true } : {}), ...(drop ? { centralDropped: drop } : {}) };
  warnDrop('curuser-push', drop);
  return { ok: true, ...last };
}
