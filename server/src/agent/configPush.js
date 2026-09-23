/**
 * 엣지 포탈(에이전트) 설정 push 워커 — CENTRAL_URL 설정 시 동작. 자기 CONFIG_DIR의 설정을
 * 중앙으로 보내 중앙의 통합 백업에 합쳐지게 한다. 시작 시 + 주기적 + 설정 변경 시 push.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { collectConfigDir, REDACTED_META } from '../backup/service.js';

let timer = null;
let changeTimer = null;
const PUSH_MS = Number(process.env.AGENT_CONFIG_PUSH_MS) || 1_800_000; // 30분

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

async function _pushConfigNow() {
  if (!config.agent.centralUrl) return null;
  try {
    const files = collectConfigDir(); // 자기 설정(*.json/*.env), 대용량 데이터 제외
    // v2.538: .env 의 키·토큰은 collectConfigDir 가 이미 가렸다(util/envRedact.js). 가린 목록 메타는
    // 파일이 아니므로 중앙에 보내지 않는다(중앙 수신부는 문자열만 받지만 여기서 명시적으로 뺀다).
    const redactedMeta = files[REDACTED_META]; delete files[REDACTED_META];
    if (redactedMeta) console.log(`[config-push] .env 키·토큰 ${Object.values(redactedMeta).reduce((n, k) => n + k.length, 0)}개는 중앙에 보내지 않습니다`);
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/agent-config`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ agent: config.agent.name, files }), timeoutMs: 20_000, retries: 2,
    });
    if (res.ok) {
      console.log(`[config-push] sent → ${config.agent.centralUrl} (${Object.keys(files).length}개 설정)`);
      _last = { at: Date.now(), ok: true, files: Object.keys(files).length, status: res.status };
    } else {
      // v2.583 감사 #34: 403(토큰)·413(본문 한도)을 조용히 false 로 넘기지 않는다 — 상태·콘솔에 남긴다.
      const hint = res.status === 413 ? ' — 중앙 본문 한도 초과(설정 파일이 너무 큼)' : res.status === 403 ? ' — 중앙이 토큰·에이전트 이름을 거부' : '';
      _last = { at: Date.now(), ok: false, status: res.status, error: `HTTP ${res.status}${hint}` };
      console.warn(`[config-push] 실패: HTTP ${res.status}${hint}`);
    }
    return res.ok;
  } catch (e) {
    _last = { at: Date.now(), ok: false, error: String(e?.message || e) };
    console.warn(`[config-push] 실패: ${e.message}`); return false;
  }
}

let _last = null;
/** 엣지 로그 화면용 상태(edgelog/spec.js). 설정 내용·토큰은 담지 않는다(개수·상태코드뿐). */
export function configPushStatus() {
  return { enabled: !!config.agent.centralUrl, running, intervalMs: PUSH_MS, last: _last };
}

export function startConfigPush() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님
  setTimeout(() => pushConfigNow().catch(() => {}), 25_000).unref?.();
  timer = setInterval(() => pushConfigNow().catch(() => {}), PUSH_MS);
  timer.unref?.();
  // 설정 변경 감시 → 디바운스 후 push
  try {
    fs.watch(config.configDir, { persistent: false }, (_e, filename) => {
      if (!filename) return;
      const ext = path.extname(String(filename)).toLowerCase();
      if (ext !== '.json' && ext !== '.env') return;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => pushConfigNow().catch(() => {}), 15_000);
      changeTimer.unref?.();
    });
  } catch { /* 감시 불가 환경 무시 */ }
  console.log(`[config-push] started (central=${config.agent.centralUrl})`);
}
