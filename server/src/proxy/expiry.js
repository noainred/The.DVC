/**
 * Ephemeral remote-access mappings (created on-demand via /remote/quick-connect)
 * are removed 1 day after they were last used — the proxy frontend is torn down
 * and the registry entry deleted, so HAProxy doesn't accumulate stale ports.
 */

import { listMappings, getMapping, removeMapping, listProxies, deployConfigRefusal } from './registry.js';
import { deprovision, TEARDOWN_PENDING } from './provision.js';
import { envPositive } from '../util/envNumber.js';   // 55회차: 양수 env 는 하나로

const DAY_MS = envPositive(process.env.REMOTE_MAPPING_TTL_MS, 86_400_000);   // 1일 · 55회차 #10: 음수 · Infinity 를 통과시키지 않는다

export async function pruneExpiredMappings(now = Date.now()) {
  let removed = 0;
  const heldNow = [];
  for (const m of [...listMappings()]) {
    // 보안 잔여 11-27 M1: 철거 보류(삭제 · 만료했지만 배포 명령 거절로 HAProxy 포트를 닫지 못한 매핑)는 시각과 무관하게 매 주기 다시 철거한다
    const held = m.status === TEARDOWN_PENDING;
    if (!m.ephemeral && !held) continue; // admin-created persistent mappings are kept
    const last = Date.parse(m.lastUsedAt || m.createdAt) || 0;
    if (!held && now - last < DAY_MS) continue;
    if (!getMapping(m.id)) { removed++; continue; }   // 이번 주기의 앞 철거(같은 중계의 성공 배포 — finishSshDeploy)가 이미 닫고 지웠다
    let r = null;
    try { r = await deprovision(getMapping(m.id)); } catch { /* best effort */ }
    if (r?.held) { heldNow.push(m); continue; }   // 철거가 거절됐다 — 등록부에서 지우면 열린 공개 포트가 화면에서 사라진다(fail-open). 남겨 두고 다음 주기에 다시 본다.
    if (getMapping(m.id)) removeMapping(m.id);   // 철거 성공 · 일시 실패(예전처럼 지운다 — 다음 성공 배포가 등록부로 블록을 다시 만들어 닫는다)
    removed++;
    console.log(`[remote] 임시 매핑 만료 삭제: ${m.name} (${m.targetHost}:${m.targetPort}, owner=${m.owner || '-'})`);
  }
  // 반증 1회차 N-2: 매핑마다 한 줄씩이던 보류 경고를 주기당 한 줄로(이름 · 포트는 10건까지)
  if (heldNow.length) {
    const shown = heldNow.slice(0, 10).map((x) => `${x.name}(${x.publicPort})`).join(', ');
    console.warn(`[remote] 매핑 철거 보류 ${heldNow.length}건: ${shown}${heldNow.length > 10 ? ' …' : ''} — 중계 서버 자동 배포 설정(명령 · 설정 파일 경로)이 허용 형식 밖입니다(설정 › 중계 서버).`);
  }
  return removed;
}

/** 보안 잔여 11-27 M1(반증 S-3): 기동 때 한 번 — SSH 자동 배포를 켠 중계 서버 중 명령(반증 1회차 S-1: 설정 파일 경로 포함)이 허용 형식 밖이라 배포가 멈춘 곳을 알린다(값은 싣지 않는다). */
export function warnBadDeployCmds() {
  let bad = [];
  try { bad = listProxies().filter((p) => p.deploy?.enabled && deployConfigRefusal(p.deploy)); } catch { return 0; }
  if (bad.length) console.warn(`[remote] SSH 자동 배포 설정(명령 · 설정 파일 경로)이 허용 형식 밖이라 중계 서버 ${bad.length}곳(${bad.map((p) => p.name).slice(0, 10).join(', ')})의 HAProxy 배포가 멈춥니다 — 설정 › 중계 서버에서 고치거나 비워 기본값을 쓰세요.`);
  return bad.length;
}

export function startMappingExpiry() {
  warnBadDeployCmds();
  const timer = setInterval(() => { pruneExpiredMappings().catch(() => {}); }, 60 * 60 * 1000); // hourly
  timer.unref?.();
  pruneExpiredMappings().catch(() => {}); // run once at startup
}
