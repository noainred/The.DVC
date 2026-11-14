/**
 * diskbad/agentKey.js — 엣지를 부르는 키 하나(v3.8.0 · 반증 #3).
 *
 * 작업 조각 · 화면 결합은 **수집 서버 등록부의 id** 를 쓴다(원격 서버의 `collectorId` — puller 가 등록부 id 로 싣는다).
 * 엣지는 **인증 이름**(AGENT_NAME)으로 온다. 배포 자동 등록은 id 를 법인 이름 슬러그로 만들 수 있어(agent/autoRegister.js
 * collectorIdFor) 둘이 다를 수 있다 — 그대로 쓰면 그 엣지는 맞는 조각을 영영 못 가져가 '시작 못 함' 이 되고, 저장한 결과도
 * 화면의 서버와 맞지 않는다. 그래서 중앙 수신(가져가기 · 보고)에서 인증 이름을 등록부 id 로 푼다:
 *  · 등록부 id 와 같으면 그대로.
 *  · 아니면 이름(name)이 **하나만** 맞을 때 그 항목의 id. 둘 이상이면 풀지 않는다(어느 쪽인지 지어내지 않는다).
 *  · 등록부를 못 읽으면 그대로(소문자).
 * 판정 순서는 bmusage/targets.js canonicalAgentRef(id 먼저, 그다음 name)와 같다.
 */
import { listCollectors } from '../collector/registry.js';

const t = (v) => String(v ?? '').trim();

/**
 * @param {string} agent 인증된 엣지 이름
 * @param {Array<{id:string, name?:string}>|null} [list] 테스트 주입(없으면 등록부)
 * @returns {string} 소문자 키
 */
export function agentKeyOf(agent, list = null) {
  const k = t(agent).toLowerCase();
  if (!k) return '';
  let rows = list;
  if (!Array.isArray(rows)) { try { rows = listCollectors() || []; } catch { rows = []; } }
  if (rows.some((c) => t(c?.id).toLowerCase() === k)) return k;
  const byName = rows.filter((c) => t(c?.name).toLowerCase() === k && t(c?.id));
  return byName.length === 1 ? t(byName[0].id).toLowerCase() : k;
}
