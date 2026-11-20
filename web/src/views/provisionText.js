/**
 * VM 생성(프로비저닝) 화면 문구 — 순수 함수(provisionText.test.js).
 *
 * 74회차 F5 · F6: 서버(provision/vsphere.js cloneOne)는 배치 항목 중 **호스트 · 데이터스토어만** 적용한다. 폴더 · 리소스 풀 · 스토리지 프로파일은
 *   이름을 vCenter 개체로 바꾸는 해석이 없어 원본 VM 의 폴더 · 리소스 풀 · 데이터스토어 기본 정책으로 만들고, 클러스터는 호스트 목록을 좁히는 칸이다.
 *   어느 항목이 적용되지 않았는지는 서버 작업의 placementNotApplied(server/src/provision/placement.js placementNotApplied)가 정한다 — 화면은 다시 판정하지 않는다.
 * 74회차 F8: (예전) LIVE 작업의 VM 'done' 은 vCenter 가 복제 작업(task)을 받았다는 뜻이었다.
 * 결정(56~75 남긴 것) 74 ②: 이제 서버(provision/jobs.js cloneAndTrack)가 vCenter 작업 결과를 기다린다 — LIVE 의 VM 상태는
 *   running(제출 중) → submitted(vCenter 작업 중) → done(복제 작업 성공) · error(실패) · unknown(시간 초과 · 결과 조회 실패 · 재기동 — vCenter 에서 계속될 수 있음).
 *   제출은 결과를 기다리지 않고(서버 provision/taskTracker.js), 결과는 분리된 추적기가 묶어 조회한다.
 *   'done' 은 복제 작업 성공이다 — 게스트 안의 hostname · IP 적용은 첫 부팅 때 게스트가 하므로 화면이 그 사실을 함께 밝힌다.
 * 결정 74 ①: 폴더 · 리소스 풀 · 스토리지 프로파일 칸은 잠근다(생성에 쓰지 않는다) — 저장된 작업에 값이 있으면 보여 주되 쓰지 않음을 밝힌다.
 */

export const PLACEMENT_LABEL = Object.freeze({
  cluster: '클러스터', host: '호스트', datastore: '데이터스토어', folder: '폴더', resourcePool: '리소스 풀', storageProfile: '스토리지 프로파일',
});

/** 배치 칸 아래 안내 — 어떤 항목이 실제로 적용되는가. */
export const PLACEMENT_HINT = '호스트 · 데이터스토어만 적용됩니다(비워 두면 원본 VM 과 같은 위치). 클러스터는 호스트 목록을 좁히는 칸이고, '
  + '폴더 · 리소스 풀 · 스토리지 프로파일은 아직 적용되지 않습니다 — 원본 VM 의 폴더 · 리소스 풀과 데이터스토어 기본 정책으로 만듭니다.';

/** 결정 74 ①: 잠근 배치 칸(입력 불가 — 생성에 쓰지 않는다). */
export const LOCKED_PLACEMENT = Object.freeze(['folder', 'resourcePool', 'storageProfile']);
/** 잠근 칸 아래 한 줄. */
export const LOCKED_PLACEMENT_NOTE = '아직 적용되지 않음(원본 VM 위치 · 데이터스토어 기본 정책)';
/** 잠근 칸에 저장된 작업의 값이 있으면 '생성에 쓰지 않음' 안내(없으면 null). */
export function lockedPlacementText(placement = {}) {
  const items = LOCKED_PLACEMENT
    .filter((k) => placement && typeof placement[k] === 'string' && placement[k].trim())
    .map((k) => `${PLACEMENT_LABEL[k]} ‘${placement[k].trim()}’`);
  return items.length ? `불러온 작업의 ${items.join(' · ')} 은(는) 보여 주기만 합니다 — 생성에는 쓰지 않습니다(원본 VM 위치 · 데이터스토어 기본 정책).` : null;
}

/** 작업의 placementNotApplied → 안내 한 줄(없으면 null). 모르는 키는 그대로 보인다. */
export function notAppliedText(keys, placement = {}) {
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k) : [];
  if (!list.length) return null;
  const items = list.map((k) => {
    const v = placement && typeof placement[k] === 'string' && placement[k] ? ` ‘${placement[k]}’` : '';
    return `${PLACEMENT_LABEL[k] || k}${v}`;
  });
  return `적용 안 됨 — ${items.join(' · ')} (이 항목은 원본 VM 기준으로 만듭니다 — 스토리지는 데이터스토어 기본 정책)`;
}

const JOB_LABEL = { running: '진행 중', completed: '완료', completed_with_errors: '일부 실패', completed_with_unknown: '일부 결과 모름', error: '실패' };
const VM_LABEL = { queued: '대기', running: '생성 중', submitted: 'vCenter 작업 중', done: '완료', error: '실패', unknown: '결과 모름' };

/** 작업 상태 글자 — 74 ②: LIVE 도 vCenter 작업 결과를 기다리므로 completed 는 '완료'. */
export function jobStatusLabel(status) {
  return JOB_LABEL[status] || status || '—';
}
/** VM 상태 글자 — LIVE 의 running 은 '제출 중'(복제 작업을 보내는 중), submitted 는 vCenter 에서 작업이 도는 중. */
export function vmStatusLabel(status, live) {
  if (live && status === 'running') return '제출 중';
  return VM_LABEL[status] || status || '—';
}
/** 작업 진행 줄의 개수 이름 — 74 ②: LIVE 도 결과를 기다리므로 '완료'. */
export const doneCountLabel = () => '완료';
/** LIVE 작업 아래 안내(MOCK 은 null). */
export const liveSubmitNote = (live) => (live
  ? '완료 = vCenter 복제 작업 성공입니다. 게스트 hostname · IP 는 첫 부팅 때 게스트가 적용합니다(vCenter 이벤트에서 확인). '
    + '결과 모름 = 대기 시간을 넘겼거나 결과를 읽지 못했거나 포탈 재기동으로 추적이 끊긴 것 — vCenter 에서 계속될 수 있으니 vCenter 최근 작업에서 확인하세요.'
  : null);
/** 진행률(%) — 끝난 VM(완료 · 실패 · 결과 모름) 비율. */
export function jobProgressPct(job) {
  const total = Number(job?.total) || 0;
  if (!total) return 0;
  const end = (Number(job?.done) || 0) + (Number(job?.failed) || 0) + (Number(job?.unknown) || 0);
  return Math.round((end / total) * 100);
}

/**
 * 75회차(74회차 F3 반증 — 재현): 시작 번호 칸 → 요청 본문 값. 서버는 0 을 0 으로 받게 고쳤지만 화면이 `Number(x) || 1` 로 0 을 1 로 바꿔
 *   보냈다(미리보기 · 생성 모두 1 부터 — 서버 수정이 화면에서 닿지 않았다). 저장된 작업을 열 때도 `sp.startIndex || 1` 이 0 을 1 로 바꿨다.
 *   0 은 0 그대로, 비었거나 숫자가 아니면 null(서버 기본 1). 음수는 그대로 보내 서버가 사유를 돌려준다.
 */
export function startIndexOut(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
