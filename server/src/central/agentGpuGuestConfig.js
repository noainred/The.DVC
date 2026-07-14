/**
 * 중앙에서 지정하는 'agent(엣지)별 GPU 게스트 수집 설정' 저장소.
 *
 * 목적: 원격 엣지는 폐쇄망/NAT 뒤에 있어 중앙이 직접 push하기 어렵다. 그래서 중앙은 각 엣지에
 * '배포할 설정'을 여기에 보관하고, 엣지가 아웃바운드로 주기적으로 pull(GET /api/central/
 * gpu-guest-config?agent=이름)해 자기 로컬 gpu-guest.json에 병합 적용한다.
 *
 * 저장: CONFIG_DIR/central-agent-gpu-guest.json (0600, 비밀번호 포함 — 엣지가 실제 SSH/게스트
 * 작업 인증에 써야 하므로 평문 보관·원자적 쓰기). 클라이언트로 내보낼 때는 비밀번호를 가린다.
 * 값은 gpu/settings.js와 동일한 설정 스키마(mergeGpuGuestSettings 규칙 공유).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { mergeGpuGuestSettings, redactGpuGuestSettings } from '../gpu/settings.js';

const FILE = path.join(config.configDir, 'central-agent-gpu-guest.json');

// null-proto: agent 이름을 키로 쓰므로 '__proto__' 등 프로토타입 오염 방지.
let byAgent = Object.create(null); // agent -> gpuGuestSettings(전체 병합 객체) + { _updatedAt }
try { if (fs.existsSync(FILE)) byAgent = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch { byAgent = Object.create(null); }

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(byAgent), { mode: 0o600 });
}

const cleanAgent = (a) => String(a || '').trim();

/** 지정된 배포 설정(비밀번호 포함) — 엣지 pull이 사용. 없으면 null. */
export function getAssignedGpuGuest(agent) {
  const a = cleanAgent(agent);
  return a && byAgent[a] ? byAgent[a] : null;
}

/** 관리자 저장: partial을 기존 배포 설정에 병합(로컬 저장과 동일 규칙). 반환 병합 결과. */
export function setAssignedGpuGuest(agent, partial) {
  const a = cleanAgent(agent);
  if (!a) return null;
  const cur = byAgent[a] || {};
  const next = mergeGpuGuestSettings(cur, partial || {});
  next._updatedAt = Date.now();
  byAgent[a] = next;
  persist();
  return next;
}

/** 배포 설정이 지정된 agent 목록(요약). */
export function listAssignedGpuGuestAgents() {
  return Object.keys(byAgent).map((agent) => {
    const s = byAgent[agent] || {};
    const vcs = Object.keys(s.vcenters || {});
    const vmCreds = vcs.reduce((n, id) => n + Object.keys(s.vcenters[id]?.vms || {}).length, 0);
    const vmIps = vcs.reduce((n, id) => n + Object.keys(s.vcenters[id]?.vmIps || {}).length, 0);
    return { agent, at: s._updatedAt || 0, vcenters: vcs.length, vmCreds, vmIps, enabled: !!s.enabled };
  }).sort((x, y) => (y.at || 0) - (x.at || 0));
}

/** 비밀번호를 가린 배포 설정(관리 UI용). 없으면 빈 기본 형태. */
export function redactAssignedGpuGuest(agent) {
  const s = getAssignedGpuGuest(agent);
  if (!s) return { assigned: false, settings: null };
  return { assigned: true, at: s._updatedAt || 0, settings: redactGpuGuestSettings(s) };
}
