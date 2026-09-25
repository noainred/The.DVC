/**
 * 중앙→엣지 배포 사용자 — 엣지(agent) 측 pull 워커.
 *
 * 중앙에서 이 엣지 앞으로 지정한 사용자 목록(설정 열람 등 접근 계정)을 아웃바운드 GET으로 주기적
 * 으로 가져와 로컬 users.json에 managed 태그로 반영한다(applyManagedUsers). 폐쇄망/NAT 엣지도
 * 중앙이 직접 push하지 않고 엣지가 pull하므로 동작한다.
 *
 * 로컬(비managed) 계정은 절대 건드리지 않으며, 배포 목록에서 빠진 managed 계정만 제거한다
 * (마지막 admin은 보호). 내용이 바뀌지 않으면(서명 동일) 재적용하지 않는다.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from '../util/central404.js'; // v2.613 DEPS2613-06·EDGE2613-06: 404 사유(central 꺼짐/거절/엔드포인트 없음) 판정
import { resilientFetch } from '../util/resilientFetch.js';
import { applyManagedUsers } from '../auth/auth.js';

let timer = null;
let last = null;
// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
let lastSig = '';
// 재진입 가드(single-flight) — CLAUDE.md 성능 불변조건: setInterval(()=>asyncFn()) 폴러는
// 이전 주기가 간격을 넘기면(고RTT·중앙 지연) 다음 틱이 겹쳐 돌아 연결·CPU 가 누적된다.
// 수동 실행 API 도 같은 exported 함수를 부르므로 가드를 공유한다(inventoryPush 와 동일 패턴).
let running = false;

function headers() {
  return { ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pullUsersConfigNow(...args) {
  if (running) return { ok: false, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pullUsersConfigNow(...args); } finally { running = false; }
}

async function _pullUsersConfigNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  const url = `${config.agent.centralUrl}/api/central/users-config?agent=${encodeURIComponent(config.agent.name || '')}`;
  try {
    const res = await resilientFetch(url, { method: 'GET', headers: headers(), timeoutMs: 20_000, retries: 2 });
    // v2.613 DEPS2613-06·EDGE2613-06: 404 본문을 읽어 '중앙이 central 을 끔' / '거절' / '엔드포인트 없음(구버전·주소 오류)' 을 가르고
    //   상태·콘솔에 남긴다(curUser·sanSwitch 등 형제 5벌과 같은 규칙 — 예전에는 `<- 404` 만 남아 조치를 고를 수 없었다).
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      last = { at: Date.now(), applied: false, ok: false, kind: c.kind, error: c.reason };
      if (_logChange('404', `${c.kind}: ${c.reason}`)) console.warn(`[users-config] ${c.reason}`);
      return { ok: false, kind: c.kind, reason: c.reason, error: c.reason };
    }
    if (!res.ok) throw new Error(`users-config <- ${res.status}`);
    const body = await res.json();
    const users = Array.isArray(body?.users) ? body.users : [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(users)).digest('hex');
    if (sig === lastSig) { last = { at: Date.now(), applied: false, reason: '변경 없음' }; return { ok: true, applied: false, unchanged: true }; }
    const r = applyManagedUsers(users);
    lastSig = sig;
    last = { at: Date.now(), applied: true, ...r };
    if (r.created || r.updated || r.removed) console.log(`[users-config] 중앙 배포 사용자 적용: 생성 ${r.created}·갱신 ${r.updated}·삭제 ${r.removed}${r.skipped.length ? ` · 건너뜀 ${r.skipped.join(', ')}` : ''}`);
    return { ok: true, applied: true, ...r };
  } catch (e) {
    last = { at: Date.now(), applied: false, error: e.message };
    if (_logChange('pull', e.message)) console.warn(`[users-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function usersConfigPullStatus() {
  return { enabled: !!(config.agent.centralUrl && config.agent.centralToken), centralUrl: config.agent.centralUrl, last };
}

export function startUsersConfigPull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return;
  const intervalMs = Math.max(30_000, config.agent.inventoryIntervalMs || 60_000);
  setTimeout(() => pullUsersConfigNow().catch((e) => console.error('[users-config] pull 실패:', e.message)), 10_000).unref?.();
  timer = setInterval(() => pullUsersConfigNow().catch(() => {}), intervalMs);
  timer.unref?.();
  console.log(`[users-config] pull started <- ${config.agent.centralUrl} every ${Math.round(intervalMs / 1000)}s`);
}
