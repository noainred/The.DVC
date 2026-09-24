/**
 * 엣지 포탈(에이전트) 설정 push 워커 — CENTRAL_URL 설정 시 동작. 자기 CONFIG_DIR의 설정을
 * 중앙으로 보내 중앙의 통합 백업에 합쳐지게 한다. 시작 시 + 주기적 + 설정 변경 시 push.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, clampIntervalMs } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { numOrNull } from '../util/numOrNull.js';
import { collectConfigDir, REDACTED_META, SKIPPED_META, isRuntimeStateFile, settingsFingerprint } from '../backup/service.js';

let timer = null;
let changeTimer = null;
const PUSH_MS = clampIntervalMs(Number(process.env.AGENT_CONFIG_PUSH_MS) || 1_800_000, 1_800_000, 60_000); // 30분 · v2.600 EDGE2600-05: 음수·2^31 초과 → 1ms 루프 차단

// 재진입 가드(single-flight) — CLAUDE.md 성능 불변조건: setInterval(()=>asyncFn()) 폴러는
// 이전 주기가 간격을 넘기면(고RTT·중앙 지연) 다음 틱이 겹쳐 돌아 연결·CPU 가 누적된다.
// 수동 실행 API 도 같은 exported 함수를 부르므로 가드를 공유한다(inventoryPush 와 동일 패턴).
let running = false;

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pushConfigNow(...args) {
  if (running) return false;
  running = true;
  try { return await _pushConfigNow(...args); } finally { running = false; }
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
    const { files, redactedMeta, skipped } = splitConfigMeta(collectConfigDir()); // 자기 설정(*.json/*.env), 대용량 데이터 제외
    if (redactedMeta) console.log(`[config-push] .env 키·토큰 ${Object.values(redactedMeta).reduce((n, k) => n + k.length, 0)}개는 중앙에 보내지 않습니다`);
    // v2.602(감사 EDGE2602-01): 변경 감시가 부른 push 는 설정 지문이 마지막 성공 push 와 같으면 보내지 않는다 — 감시 필터를
    //   통과한 쓰기라도 내용이 같거나 실행 필드(last*·useCount)만 바뀐 것이면 '설정 변경' 이 아니다. 주기 push 는 그대로 보낸다.
    const fp = settingsFingerprint(files);
    if (onlyIfChanged && _lastPushedFp && fp === _lastPushedFp) {
      _lastSkippedAt = Date.now();
      return null;
    }
    if (skipped.length) console.warn(`[config-push] 크기 상한을 넘은 설정 파일 ${skipped.length}개는 보내지 않습니다: ${skipped.map((f) => (f.size == null ? f.name : `${f.name}(${Math.round(f.size / 1048576)}MB)`)).join(', ')}`);
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/agent-config`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ agent: config.agent.name, files, ...(skipped.length ? { skipped } : {}) }), timeoutMs: 20_000, retries: 2,
    });
    const skippedInfo = skipped.length ? { skipped } : {};
    if (res.ok) {
      console.log(`[config-push] sent → ${config.agent.centralUrl} (${Object.keys(files).length}개 설정${skipped.length ? ` · 크기 초과 ${skipped.length}개 제외` : ''})`);
      _last = { at: Date.now(), ok: true, files: Object.keys(files).length, status: res.status, ...skippedInfo };
      _lastPushedFp = fp;
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
  return { enabled: !!config.agent.centralUrl, running, intervalMs: PUSH_MS, last: _last, lastUnchangedSkipAt: _lastSkippedAt };
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
export function _resetConfigPush() { _last = null; _lastSkippedAt = null; _lastPushedFp = null; }

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
