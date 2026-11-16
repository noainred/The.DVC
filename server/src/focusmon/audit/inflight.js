/**
 * 전체 점검 50회차 R3: 집중 모니터링 root 작업(디스크 점검 · 자동 설치 · 접속 준비 — 중앙 실행기와 엣지 워커)의 '실행 중' 목록 — 자동 업그레이드가 기다린다.
 *   재시작하면 결과를 잃고 다시 배달될 때 처음부터 다시 돈다(Veeam 2회차 V-3 · 대량 배포 v2.742 와 같은 판단). 의존이 없는 작은 모듈이라
 *   upgrade/manager.js 가 무거운 실행기(ssh)를 끌어오지 않는다.
 */
const live = new Set();

/** createAuditRunner 가 만든 실행기를 등록한다(list() 가 실행 중 · 대기 작업을 준다). */
export function trackAuditRunner(runner) { if (runner && typeof runner.list === 'function') live.add(runner); return runner; }

/** @returns {{ kind:'focusmon', key:string, label:string, since:number|null, resumable:false }[]} 실행 중인 작업만(대기는 중앙이 다시 배달한다) */
export function runningAuditWork() {
  const out = [];
  for (const r of live) {
    let list = [];
    try { list = r.list() || []; } catch { list = []; }
    for (const j of list) {
      if (j?.state !== 'running') continue;
      // 51회차 #8: 실행기 종류(kind)로 — submit 이 mode 를 'run' 으로 접어 설치 · 준비가 '디스크 점검' 으로 보였다
      const what = j.kind === 'install' ? '자동 설치' : j.kind === 'prep' ? '접속 준비' : '디스크 점검';
      out.push({ kind: 'focusmon', key: `focusmon:${j.runId}`, label: `집중 모니터링 ${what}(대상 ${j.id})`.slice(0, 120), since: Number.isFinite(j.startedAt) ? j.startedAt : null, resumable: false });
    }
  }
  return out;
}

/** 시험 전용 */
export function _resetAuditRunnersForTest() { live.clear(); }
