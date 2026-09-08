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
const REJECT_MS = 30 * 60_000;       // 중앙이 설정 오류로 거부(400) — 60초마다 두들기지 않는다(v2.428, 구성도 미스매치 #5)
let _last = null;                    // 마지막 결과(설정 화면·로그 진단용)
export function selfRegisterStatus() { return _last; }

/** 다음 시도까지 대기(순수) — ok/404/403 → 6h, 400(설정 오류) → 30분, 그 외(연결 실패) → 60초. */
export function backoffFor(r) {
  if (r && r.ok) return REANNOUNCE_MS;
  if (r && (r.status === 404 || r.status === 403)) return REANNOUNCE_MS;
  if (r && r.status === 400) return REJECT_MS;
  return RETRY_MS;
}

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
      console.log(`[self-register] 중앙 등록 완료: ${config.agent.name} → ${config.agent.centralUrl}${j.unverified ? ` (⚠ 광고 URL 미검증: ${j.unverified})` : ''}`);
      _last = { at: Date.now(), ok: true, unverified: j.unverified || null };
      return { ok: true };
    }
    // 404 = 구버전 중앙(미지원), 400 = 중앙이 설정 오류로 거부(예: NAT 뒤라 EDGE_ADVERTISE_URL 필요) — 장기 백오프.
    console.warn(`[self-register] 중앙 등록 실패(${r.status}): ${j.reason || ''} — ${r.status === 400 ? `${Math.round(REJECT_MS / 60000)}분 뒤 재시도(설정을 고치면 재시작으로 즉시)` : '다음 주기에 재시도'}`);
    _last = { at: Date.now(), ok: false, status: r.status, reason: j.reason || '' };
    return { ok: false, status: r.status, reason: j.reason };
  } catch (e) {
    console.warn(`[self-register] 중앙 연결 실패: ${e.message} — ${Math.round(RETRY_MS / 1000)}s 후 재시도`);
    _last = { at: Date.now(), ok: false, reason: e.message };
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
    arm(backoffFor(r));
  };
  arm(3_000); // 부팅 직후 살짝 늦게(라우터/리스너 준비 후)
  console.log(`[self-register] started (central=${config.agent.centralUrl}, agent=${config.agent.name})`);
}
