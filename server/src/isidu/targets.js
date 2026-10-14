/**
 * isidu/targets.js — 중앙에서 '어느 노드가 어느 대상을 조사하는가' 를 정한다(v2.736).
 * 등록부 아이실론 대상은 그 장비의 담당 노드(storage registry `agent`)를 따르고, 직접 입력 대상은 설정의 실행 노드를 쓴다.
 * 판정은 이 모듈 하나 — 설정 pull(엣지에 내려줄 몫)·수신(받아도 되는 대상)·화면(누가 조사하는가)이 같은 함수를 쓴다.
 */
import { listDevices, registryLoadError } from '../storage/registry.js';
import { loadSettings, resolveTarget } from './settings.js';

/** 설정의 대상 전부 → 실행 정보(등록부 반영). */
export function resolvedTargets() {
  const devices = listDevices();
  return loadSettings().targets.map((t) => resolveTarget(t, { devices })).filter(Boolean);
}

const lo = (s) => String(s ?? '').trim().toLowerCase();

/** 이 엣지가 조사할 대상(문제 있는 대상 — 등록부에서 사라진 장비 등 — 은 빼고). */
export function targetsForAgent(agent, list = resolvedTargets()) {
  const a = lo(agent);
  if (!a) return [];
  return list.filter((r) => r && !r.issue && lo(r.agent) === a);
}

/** 그 엣지에 배정된 대상 id 집합(수신 소유 판정). 문제 있는 대상도 포함 — 결과는 받아 두고 화면이 사유를 말한다. */
export function ownedTargetIds(agent, list = resolvedTargets()) {
  const a = lo(agent);
  return new Set(list.filter((r) => r && lo(r.agent) === a).map((r) => r.id));
}

/**
 * 이력 키(DB agent 열) — 언제나 ''. 대상 id 는 중앙 설정이 발급해 하나뿐이고 담당 노드가 바뀌어도 추이가 이어져야 한다.
 * 누가 조사했는지는 scan.node(엣지 이름, '' = 중앙)로 남긴다.
 */
export const HISTORY_AGENT = '';

export { registryLoadError as storageRegistryLoadError };
