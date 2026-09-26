/**
 * 엣지 포탈(에이전트) 설정 push 워커 — CENTRAL_URL 설정 시 동작. 자기 CONFIG_DIR의 설정을
 * 중앙으로 보내 중앙의 통합 백업에 합쳐지게 한다. 시작 시 + 주기적 + 설정 변경 시 push.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, clampIntervalMs } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { numOrNull } from '../util/numOrNull.js';
import { readCentralReply, dropSummaryOf, warnDrop } from './centralReply.js'; // v2.606 EDGE2606-03
import { collectConfigDir, REDACTED_META, SKIPPED_META, isRuntimeStateFile, settingsFingerprint } from '../backup/service.js';

const gzipAsync = promisify(zlib.gzip);
/** v2.620(EDGE2620-04): 413 이면 큰 파일부터 몇 개를 빼고 한 번 다시 보낸다 — 그 상한(개수). */
export const RETRY_DROP_MAX = 8;

let timer = null;
let changeTimer = null;
const PUSH_MS = clampIntervalMs(Number(process.env.AGENT_CONFIG_PUSH_MS) || 1_800_000, 1_800_000, 60_000); // 30분 · v2.600 EDGE2600-05: 음수·2^31 초과 → 1ms 루프 차단

// 재진입 가드(single-flight) — CLAUDE.md 성능 불변조건: setInterval(()=>asyncFn()) 폴러는
// 이전 주기가 간격을 넘기면(고RTT·중앙 지연) 다음 틱이 겹쳐 돌아 연결·CPU 가 누적된다.
// 수동 실행 API 도 같은 exported 함수를 부르므로 가드를 공유한다(inventoryPush 와 동일 패턴).
let running = false;

function headers(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra, ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

/**
 * v2.620(EDGE2620-04): 설정 push 는 **설정 파일만** 보낸다(순수). `collectConfigDir` 은 백업용이라 폴러·push 가 스스로 쓰는
 * 상태·캐시 파일(`*-inventory.json`·`*-latest.json`·`*-activity.json`·`cvp-push.json` … — `isRuntimeStateFile` 판정, util/stateFiles.js
 * 등록부 포함)까지 싣는데, 그것을 30분마다 비압축으로 고RTT 회선에 올렸고 합이 16MB 를 넘으면 요청 **전체가 413** 이었다.
 * 중앙은 엣지별 사본을 상주 보관하므로 v2.617 의 '엣지 설정 사본' 메모리 몫도 여기서 나왔다. 상태 파일은 재생성되는 값이라
 * 중앙 백업의 엣지 복원에 필요 없다. 뺀 이름은 돌려준다(개수를 상태·콘솔에 밝힌다 — 조용히 빼지 않는다).
 * ⚠ MIXED_STATE_FILES(설정 + last* 실행 필드)는 **설정이다** — isRuntimeStateFile 이 false 라 그대로 보낸다.
 */
export function splitStateFiles(files) {
  const settings = {};
  const stateNames = [];
  for (const [name, content] of Object.entries(files || {})) {
    if (isRuntimeStateFile(name)) stateNames.push(name);
    else settings[name] = content;
  }
  return { settings, stateNames: stateNames.sort() };
}

/** v2.620(EDGE2620-04): 413 재전송용 — 큰 파일부터 `max` 개를 뺀다(순수). 뺀 목록은 [{name,size}]. */
export function dropLargestFiles(files, max = RETRY_DROP_MAX) {
  const sized = Object.entries(files || {}).map(([name, c]) => ({ name, size: Buffer.byteLength(String(c ?? ''), 'utf8') }))
    .sort((a, b) => (b.size - a.size) || a.name.localeCompare(b.name));
  const dropped = sized.slice(0, Math.max(0, Math.min(max, sized.length - 1)));   // 최소 1개는 남긴다(빈 push 는 중앙 사본을 비운다)
  const keep = { ...files };
  for (const d of dropped) delete keep[d.name];
  return { files: keep, dropped };
}

/** v2.620(EDGE2620-04): gzip 본문(중앙 express.json 이 Content-Encoding: gzip 을 자동 해제 — BIG_JSON 등록 경로). 실패하면 원문. */
async function encodeBody(obj) {
  const json = JSON.stringify(obj);
  try { return { body: await gzipAsync(Buffer.from(json)), hdrs: headers({ 'Content-Encoding': 'gzip' }), rawBytes: Buffer.byteLength(json) }; } catch {
    return { body: json, hdrs: headers(), rawBytes: Buffer.byteLength(json) };
  }
}

// v2.605(감사 EDGE2605-04): 진행 중에 들어온 요청을 버리지 않는다 — 예전에는 `if (running) return false;` 라 주기 push 가 고RTT 로
//   도는 사이 설정 변경 감시가 부른 push 가 조용히 사라지고(진행 중 push 는 변경 전 파일을 이미 읽었다) 변경분이 최대 30분 늦게
//   중앙 백업에 반영됐다. 형제 push(pdu/storage — v2.597 L2597-04)와 같은 '끝난 뒤 한 번 더' 규약이다. 추가 push 는
//   onlyIfChanged 라 내용이 같으면 보내지 않는다(v2.602 EDGE2602-01 지문 생략과 충돌하지 않는다).
let _busy = null;
let _again = false;
let _lastDeferredAt = null;
export async function pushConfigNow(...args) {
  if (running) { _again = true; _lastDeferredAt = Date.now(); return _busy; }
  running = true;
  _busy = (async () => {
    try {
      let r = await _pushConfigNow(...args);
      while (_again) { _again = false; r = await _pushConfigNow({ onlyIfChanged: true }); }
      return r;
    } catch (e) {
      // 무음 실패 금지(v2.549) — 안쪽이 이미 상태를 남기지만, 예상 밖 throw 도 콘솔에 남기고 null 로 끝낸다.
      console.warn(`[config-push] 실패: ${e?.message || e}`);
      return null;
    } finally { running = false; }
  })();
  return _busy;
}

// v2.602(감사 EDGE2602-01): 마지막으로 **성공한** push 의 설정 지문(상태·캐시 파일·last* 실행 필드 제외 — backup 과 같은 기준).
let _lastPushedFp = null;

async function _pushConfigNow({ onlyIfChanged = false } = {}) {
  if (!config.agent.centralUrl) return null;
  try {
    // v2.538: .env 의 키·토큰은 collectConfigDir 가 이미 가렸다(util/envRedact.js). 가린 목록 메타는
    // 파일이 아니므로 중앙에 보내지 않는다(중앙 수신부는 문자열만 받지만 여기서 명시적으로 뺀다).
    // v2.599(감사 EDGE2599-04): 크기 상한(8MB)으로 **뺀 파일 목록**(SKIPPED_META)도 메타다 — 예전에는 그것을 files 에
    //   남겨 '설정 파일' 로 셌고(개수 +1), 뺀 사실은 어디에도 남지 않았다. 이름·크기를 상태·콘솔에 남기고 본문에도
    //   `skipped` 로 실어 중앙이 밝힐 수 있게 한다(v2.590 D5 와 같은 규약 — 조용히 빼지 않는다).
    const { files: collected, redactedMeta, skipped } = splitConfigMeta(collectConfigDir()); // 자기 설정(*.json/*.env), 대용량 데이터 제외
    // v2.620(EDGE2620-04): 상태·캐시 파일은 보내지 않는다(설정 비교·복원 목적이 아니다). 제외 개수는 상태·콘솔에.
    const { settings: files, stateNames } = splitStateFiles(collected);
    if (redactedMeta) console.log(`[config-push] .env 키·토큰 ${Object.values(redactedMeta).reduce((n, k) => n + k.length, 0)}개는 중앙에 보내지 않습니다`);
    // v2.602(감사 EDGE2602-01): 변경 감시가 부른 push 는 설정 지문이 마지막 성공 push 와 같으면 보내지 않는다 — 감시 필터를
    //   통과한 쓰기라도 내용이 같거나 실행 필드(last*·useCount)만 바뀐 것이면 '설정 변경' 이 아니다. 주기 push 는 그대로 보낸다.
    const fp = settingsFingerprint(files);
    if (onlyIfChanged && _lastPushedFp && fp === _lastPushedFp) {
      _lastSkippedAt = Date.now();
      return null;
    }
    if (skipped.length) console.warn(`[config-push] 크기 상한을 넘은 설정 파일 ${skipped.length}개는 보내지 않습니다: ${skipped.map((f) => (f.size == null ? f.name : `${f.name}(${Math.round(f.size / 1048576)}MB)`)).join(', ')}`);
    const send = async (fileMap) => {
      const enc = await encodeBody({ agent: config.agent.name, files: fileMap, ...(skipped.length ? { skipped } : {}) });
      const r = await resilientFetch(`${config.agent.centralUrl}/api/central/agent-config`, {
        method: 'POST', headers: enc.hdrs, body: enc.body, timeoutMs: 20_000, retries: 2,
      });
      return { res: r, bytes: Buffer.isBuffer(enc.body) ? enc.body.length : Buffer.byteLength(enc.body), rawBytes: enc.rawBytes };
    };
    let sent = files;
    let { res, bytes, rawBytes } = await send(sent);
    // v2.620(EDGE2620-04): 413(본문 한도) 이면 큰 파일부터 빼고 **한 번만** 다시 보낸다 — 예전에는 파일 하나 때문에 그 엣지의
    //   설정 사본 전체가 갱신되지 않았다. 뺀 파일은 이름·크기를 상태·콘솔에 남긴다(조용한 제외 금지).
    let retryDropped = [];
    if (res.status === 413 && Object.keys(files).length > 1) {
      const d = dropLargestFiles(files);
      retryDropped = d.dropped;
      console.warn(`[config-push] 중앙 본문 한도 초과(413) — 큰 설정 파일 ${retryDropped.length}개를 빼고 한 번 다시 보냅니다: ${retryDropped.map((f) => `${f.name}(${Math.round(f.size / 1024)}KB)`).join(', ')}`);
      sent = d.files;
      ({ res, bytes, rawBytes } = await send(sent));
    }
    const skippedInfo = {
      ...(skipped.length ? { skipped } : {}),
      ...(stateNames.length ? { stateExcluded: stateNames.length, stateExcludedNames: stateNames.slice(0, 50) } : {}),
      ...(retryDropped.length ? { retryDropped } : {}),
      bytes, rawBytes,
    };
    if (stateNames.length) console.log(`[config-push] 상태·캐시 파일 ${stateNames.length}개는 설정이 아니라 보내지 않습니다`);
    if (res.ok) {
      // v2.606 EDGE2606-03: 200 이어도 중앙이 파일을 거부(rejectedFiles — 길이 상한)·상한(omitted)으로 뺄 수 있다 — 상태·콘솔에.
      const reply = await readCentralReply(res);
      const drop = dropSummaryOf(reply);
      const rejectedNames = Array.isArray(reply?.rejectedFiles) ? reply.rejectedFiles.slice(0, 50).map((x) => (x && typeof x === 'object' ? `${String(x.name ?? '').slice(0, 160)}:${String(x.reason ?? '').slice(0, 30)}` : String(x).slice(0, 200))) : [];
      console.log(`[config-push] sent → ${config.agent.centralUrl} (${Object.keys(sent).length}개 설정 · gzip ${Math.round(bytes / 1024)}KB${skipped.length ? ` · 크기 초과 ${skipped.length}개 제외` : ''}${retryDropped.length ? ` · 413 으로 ${retryDropped.length}개 제외` : ''})`);
      _last = { at: Date.now(), ok: true, files: Object.keys(sent).length, status: res.status, ...skippedInfo, ...(drop ? { centralDropped: { ...drop, ...(rejectedNames.length ? { rejectedFileNames: rejectedNames } : {}) } } : {}) };
      warnDrop('config-push', drop);
      // 413 으로 파일을 뺀 push 는 '설정 전체가 올라갔다' 가 아니다 — 지문을 기억하지 않아 다음 변경 감시가 다시 보낸다.
      if (!retryDropped.length) _lastPushedFp = fp;
    } else {
      // v2.583 감사 #34: 403(토큰)·413(본문 한도)을 조용히 false 로 넘기지 않는다 — 상태·콘솔에 남긴다.
      const hint = res.status === 413 ? ' — 중앙 본문 한도 초과(설정 파일이 너무 큼)' : res.status === 403 ? ' — 중앙이 토큰·에이전트 이름을 거부' : '';
      _last = { at: Date.now(), ok: false, status: res.status, error: `HTTP ${res.status}${hint}`, ...skippedInfo };
      console.warn(`[config-push] 실패: HTTP ${res.status}${hint}`);
    }
    return res.ok;
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: String(e?.message || e) };
    console.warn(`[config-push] 실패: ${e.message}`); return false;
  }
}

/**
 * collectConfigDir 결과에서 메타 키를 떼어 낸다(순수, v2.599 EDGE2599-04) — 남는 것은 **파일만**이다.
 * skipped 는 [{name, size}] (크기 상한으로 뺀 파일). 원본 객체는 건드리지 않는다.
 */
export function splitConfigMeta(collected) {
  const files = { ...(collected || {}) };
  const redactedMeta = files[REDACTED_META] || null; delete files[REDACTED_META];
  const rawSkipped = files[SKIPPED_META]; delete files[SKIPPED_META];
  const skipped = (Array.isArray(rawSkipped) ? rawSkipped : [])
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({ name: String(f.name || ''), size: numOrNull(f.size) }));
  return { files, redactedMeta, skipped };
}

let _last = null;
let _lastSkippedAt = null;
/** 엣지 로그 화면용 상태(edgelog/spec.js). 설정 내용·토큰은 담지 않는다(개수·상태코드뿐). */
export function configPushStatus() {
  return { enabled: !!config.agent.centralUrl, running, intervalMs: PUSH_MS, last: _last, lastUnchangedSkipAt: _lastSkippedAt, lastDeferredAt: _lastDeferredAt };
}

/**
 * 변경 감시가 push 를 걸어야 하는 파일인가(순수, v2.602 감사 EDGE2602-01).
 * 설정 파일(*.json·*.env)만 — 폴러·엣지 push 가 스스로 다시 쓰는 상태·캐시 파일(`*-activity.json` 등)은 제외한다.
 * 기준은 중앙 백업 감시와 **같은 하나**(`backup/service.js isRuntimeStateFile`, v2.590 P1)다. 예전에는 확장자만 봐서
 * 수집기의 작업 로그 쓰기(20초 주기 등)마다 15초 디바운스가 재무장돼 '30분 주기' push 가 사실상 20초마다 나갔다.
 */
export function configWatchRelevant(filename) {
  if (!filename) return false;
  const ext = path.extname(String(filename)).toLowerCase();
  if (ext !== '.json' && ext !== '.env') return false;
  return !isRuntimeStateFile(String(filename));
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function _resetConfigPush() { _last = null; _lastSkippedAt = null; _lastPushedFp = null; _lastDeferredAt = null; }

export function startConfigPush() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님
  setTimeout(() => pushConfigNow().catch(() => {}), 25_000).unref?.();
  timer = setInterval(() => pushConfigNow().catch(() => {}), PUSH_MS);
  timer.unref?.();
  // 설정 변경 감시 → 디바운스 후 push
  try {
    fs.watch(config.configDir, { persistent: false }, (_e, filename) => {
      if (!configWatchRelevant(filename)) return;   // v2.602 EDGE2602-01: 상태·캐시 파일 쓰기는 설정 변경이 아니다
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => pushConfigNow({ onlyIfChanged: true }).catch(() => {}), 15_000);
      changeTimer.unref?.();
    });
  } catch { /* 감시 불가 환경 무시 */ }
  console.log(`[config-push] started (central=${config.agent.centralUrl})`);
}
