/**
 * central/svcmonAssignSync.js — 담당 엣지 배정 동기화(byAgent) 한 곳.
 *
 * v2.960(쉬운 등록): 설정 연동 적용(routes/svcmon/settingsSync.js) · 사용/중지 일괄 전환 · 시험 점검(svcmon/trial.js)이 같은 규칙으로
 *   엣지 배정을 다시 굳혀야 해서 라우트 파일 안의 함수를 이리로 옮겼다(사본 금지 — 판정이 갈라진다).
 *
 * 규칙(svcmon/CLAUDE.md '배정 동기화'): **byAgent 배정이거나 배정이 없는 엣지만** 다시 굳힌다. 경로 기준 배정을 byAgent 로 바꾸면
 *   그 엣지가 맡던 경로 대상이 통째로 빠진다(파괴적) — 그런 엣지는 '건너뜀' 으로 보고하고 엣지 배정 탭에서 사람이 고른다.
 *   배정은 대상 정의의 **스냅샷**이다(사용 여부 포함) — 중앙에서 대상을 켜고 꺼도 다시 굳히기 전에는 엣지가 모른다.
 */
import { listTargets } from '../svcmon/store.js';
import { capStr } from '../util/capStr.js';
import { listAssignments, setAssignment, svcmonAssignLoadError, DEFAULT_EXCEPT_TYPES } from './svcmonAssign.js';

const t = (v) => String(v ?? '').trim();

/**
 * @param {string[]} agents
 * @param {string} user
 * @param {{note?:string}} [o]
 * @returns {{agent:string, ok:boolean, skipped?:boolean, reason?:string, targets?:number}[]}
 */
export function syncByAgentAssignments(agents, user = '', { note = '설정 연동 동기화' } = {}) {
  const out = [];
  // v2.960(반증 H1 — 재현): 배정 파일이 손상돼 못 읽은 동안(load 는 원본을 보존하고 **빈 목록**을 준다 — 던지지 않는다) 굳히면
  //   그 엣지 하나분으로 파일을 덮고(관리자 저장이 로드 오류를 해제) 다른 엣지는 assigned:false 를 받아 central:* 배포분을 전부 지운다(EDGE2632-01 사고).
  //   못 읽었으면 아무것도 쓰지 않는다 — 사람이 엣지 배정 탭에서 확인한다(v2.915 설정 연동 적용 경로도 같이 막힌다).
  const loadErr = svcmonAssignLoadError();
  if (loadErr) return [...new Set((agents || []).map(t).filter(Boolean))].map((agent) => ({ agent, ok: false, reason: '엣지 배정 파일을 읽지 못했습니다(손상본을 보존했습니다) — 엣지 배정 탭에서 확인하기 전에는 배정을 다시 굳히지 않습니다.' }));
  let cur = [];
  try { cur = listAssignments(); } catch (e) { return agents.map((agent) => ({ agent, ok: false, reason: `배정 파일을 읽지 못했습니다: ${capStr(t(e?.message), 120)}` })); }
  const byName = new Map(cur.map((a) => [a.agent, a]));
  for (const agent of [...new Set((agents || []).map(t).filter(Boolean))]) {
    const a = byName.get(agent);
    if (a && a.scope?.byAgent !== true) { out.push({ agent, ok: false, skipped: true, reason: '이 엣지는 경로 기준 배정입니다 — 엣지 배정 탭에서 범위를 확인하세요(자동으로 바꾸지 않습니다).' }); continue; }
    try {
      const picked = listTargets().filter((x) => t(x.agent) === agent).map((x) => ({ ...x, tests: x.tests.map((y) => ({ ...y })) }));
      const r = setAssignment(agent, { byAgent: true, exceptTypes: a?.exceptTypes || DEFAULT_EXCEPT_TYPES, note }, picked, { user });
      out.push({ agent, ok: true, targets: r?.counts?.targets ?? picked.length, sig: r?.sig || '' });
    } catch (e) { out.push({ agent, ok: false, reason: capStr(t(e?.message), 200) }); }
  }
  return out;
}

/**
 * 대상 하나를 어느 엣지가 점검하는가 — 배정 기록으로 판정한다(엣지 배정 PUT 의 고르기 규칙과 같은 뜻 — routes/svcmon/edge.js).
 *   대상에 agent 가 있으면 그 엣지 전용: 그 엣지 배정이 byAgent 이거나 없으면 'byAgent'(다시 굳힐 수 있다), 경로 기준이면 'path'.
 *   agent 가 없으면 경로 기준 배정 중 그 경로를 덮는 엣지(다른 엣지 소유가 아님)를 찾는다 — 있으면 'path'.
 * @returns {{agent:string, mode:'byAgent'|'path'|''}}
 */
export function edgeOfTarget(target, assignments = null) {
  let list = assignments;
  if (!list) { try { list = listAssignments(); } catch { list = []; } }
  const owner = t(target?.agent);
  if (owner) {
    const a = list.find((x) => x.agent === owner);
    return { agent: owner, mode: !a || a.scope?.byAgent === true ? 'byAgent' : 'path' };
  }
  for (const a of list) {
    const sc = a.scope || {};
    if (sc.byAgent === true) continue;
    if (sc.kind && t(target?.kind || 'infra') !== sc.kind) continue;
    const p = t(target?.path);
    const sp = t(sc.path);
    const hit = !sp || (sc.includeSub !== false ? (p === sp || p.startsWith(`${sp}\\`)) : p === sp);
    if (hit) return { agent: a.agent, mode: 'path' };
  }
  return { agent: '', mode: '' };
}
