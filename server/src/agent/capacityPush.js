/**
 * Capacity Advisor 엣지 push — 엣지가 자기 호스트 리소스 스냅샷을 중앙으로 밀어 올린다.
 *
 * svcmonPush 와 같은 규약: 엣지→중앙 단방향 아웃바운드(NAT/폐쇄망 커버), single-flight,
 * 이름 해시 지터(전 엣지가 같은 초에 중앙을 때리지 않게), 404 백오프(구버전 중앙),
 * X-Agent-Name 헤더(중앙의 개별 토큰↔agent 바인딩 이중 방어).
 *
 * 본문은 스냅샷 1회분({metric,v} 수십 행 + 호스트 메타)이라 1KB 미만 — 청크 불필요.
 * 절대 시각을 보내지 않는다: 중앙이 수신 시각으로 적재한다(엣지 시계 오차에 둔감).
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { collectSnapshot, hostMeta } from '../capacity/sampler.js';

let timer = null;
let running = false;
let unsupportedUntil = 0;
let last = null;

export async function pushCapacityNow() {
  if (!config.capacity.enabled || !config.capacity.push) return { ok: false, reason: '비활성(CAPACITY_MON_ENABLED/CAPACITY_PUSH)' };
  if (!config.agent.centralUrl) return { ok: false, reason: 'CENTRAL_URL 미설정' };
  if (!config.agent.centralToken) return { ok: false, reason: '중앙 토큰 미설정' };
  if (running) return { ok: false, reason: '이전 push 진행 중(겹침 방지)' };
  if (Date.now() < unsupportedUntil) return { ok: false, reason: '중앙이 이 기능을 지원하지 않습니다(백오프 중)' };

  running = true;
  const startedAt = Date.now();
  try {
    const snap = collectSnapshot();
    // 첫 주기는 델타 기준선만 잡혀 비어 있을 수 있다 — 빈 봉투도 보낸다(하트비트: '살아 있음' 신호).
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/capacity-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.agent.name ? { 'X-Agent-Name': config.agent.name } : {}),
        ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}),
      },
      body: JSON.stringify({ v: 1, rows: snap.rows, meta: hostMeta() }),
      timeoutMs: 15_000, retries: 1,
    });
    if (res.status === 404) {
      unsupportedUntil = Date.now() + 3_600_000;
      return { ok: false, reason: '중앙이 /api/central/capacity-report 를 지원하지 않습니다(1시간 후 재시도).' };
    }
    let data = null;
    try { data = await res.json(); } catch { /* 본문 없는 응답 허용 */ }
    last = { at: Date.now(), ms: Date.now() - startedAt, status: res.status, ok: res.ok, rows: snap.rows.length, reason: data?.reason || '' };
    return { ok: res.ok, ...last };
  } catch (e) {
    last = { at: Date.now(), ms: Date.now() - startedAt, status: 0, ok: false, rows: 0, reason: e?.message || String(e) };
    return { ok: false, ...last };
  } finally {
    running = false;
  }
}

export function capacityPushStatus() {
  return {
    enabled: config.capacity.enabled && config.capacity.push && !!config.agent.centralUrl && !!config.agent.centralToken,
    centralUrl: config.agent.centralUrl || '',
    agent: config.agent.name || '',
    intervalMs: config.capacity.pushIntervalMs,
    unsupportedUntil: unsupportedUntil || null,
    last,
  };
}

export function startCapacityPush() {
  if (timer) return;
  if (!config.capacity.enabled || !config.capacity.push || !config.agent.centralUrl || !config.agent.centralToken) return;
  const jitter = config.agent.name
    ? crypto.createHash('sha1').update(String(config.agent.name)).digest()[0] % 20_000
    : Math.floor(Math.random() * 20_000);
  setTimeout(() => {
    pushCapacityNow().catch(() => {});
    timer = setInterval(() => { pushCapacityNow().catch(() => {}); }, config.capacity.pushIntervalMs);
    timer.unref?.();
  }, 20_000 + jitter).unref?.();
  console.log(`[capacity-push] 호스트 리소스 보고 시작 → ${config.agent.centralUrl} (${Math.round(config.capacity.pushIntervalMs / 1000)}초 주기 · 지터 ${Math.round(jitter / 1000)}초)`);
}
