/**
 * central/knownAgents.js — 중앙이 알고 있는 엣지(agent) 이름 목록(v2.312).
 *
 * 배경(보안 점검 2026-08-16): 스토리지 모니터링 등록 폼의 '수집 주체' 드롭다운이 엣지 목록을
 * `listAgentTokens()`(발급된 per-agent 토큰) **하나만**으로 채워, per-agent 토큰을 발급하지
 * 않고 공유 CENTRAL_TOKEN 으로 운영하는 환경에서는 목록이 비어 '중앙에서 직접'만 보였다 —
 * 법인 Isilon 을 엣지에 위임할 방법이 UI 에 없었다. iDRAC 위임(`/idrac/scan-agents`)은 실제로
 * 중앙과 통신 중인 엣지를 여러 소스에서 병합해 보여준다. 그 소스 병합을 공용화해 스토리지도
 * 동일하게 쓰도록 한다(위임 축이 다르다고 목록 소스가 달라선 안 됨 — 회귀 방지).
 *
 * "알려진 엣지" = 어떤 기능으로든 이미 중앙과 통신한 적이 있는 agent. 아래 소스를 대소문자
 * 무시로 합집합한다(각 소스는 방어적 try/catch — 한 모듈 미초기화가 목록 전체를 죽이지 않게):
 *  - 발급된 per-agent 토큰(명시 등록)
 *  - config 를 pull 한 agent(agentConfig)
 *  - vCenter 인벤토리를 보고한 site collector 엣지(inventory)
 *  - 원격 수집 서버(collector registry)
 *  - GPU guest 진단 보고 엣지 · Horizon 할당/결과 agent
 * 반환은 표시명 원형(첫 등장) 기준 정렬 목록. 폼에서 직접 타이핑 대신 이 목록에서 고른다.
 */

import { listAgentTokens } from './agentTokens.js';
import { getAllAgentConfigs } from './agentConfig.js';
import { listInventory } from './inventory.js';
import { getAllGpuGuestDiag } from './gpuGuestDiag.js';
import { listAssignments, getResults } from './assignments.js';
import { listCollectors } from '../collector/registry.js';

export function knownAgentNames() {
  const names = new Set();   // 표시용 원형(첫 등장)
  const lower = new Set();   // 대소문자 무시 중복 제거 키
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (!lower.has(k)) { lower.add(k); names.add(s); }
  };
  const safe = (fn) => { try { fn(); } catch { /* 소스 미초기화 — 건너뜀 */ } };

  safe(() => { for (const t of listAgentTokens()) add(t.agent); });
  safe(() => { for (const k of Object.keys(getAllAgentConfigs() || {})) add(k); });
  safe(() => { for (const x of listInventory()) add(x.agent); });
  safe(() => { for (const c of listCollectors()) { add(c.id); add(c.name); } });
  safe(() => { for (const x of getAllGpuGuestDiag()) add(x.agent); });
  safe(() => { for (const a of listAssignments()) add(a.agent); });
  safe(() => { for (const k of Object.keys(getResults() || {})) add(k); });

  return [...names].sort((a, b) => a.localeCompare(b));
}
