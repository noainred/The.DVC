/**
 * 엣지 자기등록 워커 — EDGE_MODE=all(또는 CENTRAL_URL+COLLECTOR_TOKEN 동시 설정) 엣지가
 * 부팅 시 중앙의 /api/central/register-collector 로 자기 이름/포트/수집토큰/DC를 알려
 * 중앙 수집 서버 목록에 자동 등록된다 — 관리자의 '수집 서버 추가' 수동 절차 제거.
 *
 * 성공해도 6시간마다 재알림(IP 변경/중앙 재설치 자가치유), 실패 시 60초 후 재시도.
 * EDGE_ADVERTISE_URL 로 NAT/프록시 뒤의 실제 접근 URL을 명시할 수 있다.
 */

import { config, currentVersion } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';

const RETRY_MS = 60_000;           // 실패(중앙 미기동 등) 재시도
const REANNOUNCE_MS = 6 * 3_600_000; // 성공 후 재알림

let timer = null;
let running = false; // 재진입 방지

export async function registerOnce() {
  if (!config.agent.centralUrl || !config.collector.token) return null;
  if (running) return null;
  running = true;
  try {
    const body = {
      name: config.agent.name,
      port: config.port,
      collectorToken: config.collector.token,
      datacenter: config.collector.datacenter || '',
      urlHint: (process.env.EDGE_ADVERTISE_URL || '').trim(),
      version: currentVersion(),
    };
    const r = await resilientFetch(`${config.agent.centralUrl}/api/central/register-collector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) },
      body: JSON.stringify(body), timeoutMs: 15_000, retries: 1,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      console.log(`[self-register] 중앙 등록 완료: ${config.agent.name} → ${config.agent.centralUrl}`);
      return { ok: true };
    }
    // 404 = 구버전 중앙(미지원) — 시끄럽지 않게 한 번만 안내하고 재알림 주기로 물러남.
    console.warn(`[self-register] 중앙 등록 실패(${r.status}): ${j.reason || ''} — 다음 주기에 재시도`);
    return { ok: false, status: r.status, reason: j.reason };
  } catch (e) {
    console.warn(`[self-register] 중앙 연결 실패: ${e.message} — ${Math.round(RETRY_MS / 1000)}s 후 재시도`);
    return { ok: false, reason: e.message };
  } finally {
    running = false;
  }
}

export function startSelfRegister() {
  if (!config.agent.centralUrl || !config.collector.token) return; // 등록할 것이 없음
  const arm = (ms) => { timer = setTimeout(tick, ms); timer.unref?.(); };
  const tick = async () => {
    const r = await registerOnce().catch(() => null);
    // 성공(ok) 또는 구버전/권한거부(404/403)면 긴 주기로 물러남 — 미지원 중앙에 60초마다
    // 재시도하며 양쪽 로그를 스팸하지 않는다. 연결 실패 등 일시 오류만 60초 재시도.
    const backoff = (r && r.ok) || (r && (r.status === 404 || r.status === 403)) ? REANNOUNCE_MS : RETRY_MS;
    arm(backoff);
  };
  arm(3_000); // 부팅 직후 살짝 늦게(라우터/리스너 준비 후)
  console.log(`[self-register] started (central=${config.agent.centralUrl}, agent=${config.agent.name})`);
}
