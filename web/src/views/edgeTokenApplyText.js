/**
 * views/edgeTokenApplyText.js — 엣지 개별 토큰 자동 적용의 진행·기록 문구(v2.776). 서버 작업 기록(central/tokenApplyJob.js)을 그대로 그린다.
 */
export const JOB_STATE = {
  running: { text: '진행 중', tone: 'muted' },
  ok: { text: '완료', tone: 'ok' },
  warn: { text: '완료(확인 필요)', tone: 'warn' },
  failed: { text: '실패', tone: 'bad' },
};
export const STEP_STATE_ICON = { running: '⏳', ok: '✅', warn: '⚠️', bad: '❌', skip: '·' };
export const STEP_TONE = { running: 'muted', ok: 'ok', warn: 'warn', bad: 'bad', skip: 'muted' };

const p2 = (x) => String(x).padStart(2, '0');
/** 'HH:MM:SS' — 못 읽은 값이면 ''. */
export function hms(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
/** 'MM-DD HH:MM:SS'. */
export function dhms(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms(n)}`;
}

/** 단계 시각 — '12:01:03~12:01:05 (2초)' · 진행 중이면 '12:01:03~ (진행 중)'. */
export function stepTimeText(s) {
  const a = hms(s?.at);
  if (!a) return '';
  if (s.state === 'running' || !Number.isFinite(Number(s.endAt)) || !(Number(s.endAt) > 0)) return `${a}~ (진행 중)`;
  const sec = Math.max(0, Math.round((Number(s.endAt) - Number(s.at)) / 1000));
  return `${a}~${hms(s.endAt)} (${sec}초)`;
}

/** 작업 한 줄 요약 — '10-24 14:50:02 · noainred · 완료 · 수집 토큰 통로 · 지문 ab12cd34'. */
export function jobLine(j) {
  if (!j || typeof j !== 'object') return '';
  const st = JOB_STATE[j.state]?.text || j.state || '';
  const path = j.path === 'ssh' ? 'SSH 통로' : j.path === 'edge-api' ? '수집 토큰 통로' : '';
  // v2.777: 엣지가 pull 로 보고한 호스트 이름(작업 시작 때 기록 — 토큰을 받은 장비와 대조한 기준)
  const host = typeof j.edgeHost === 'string' && j.edgeHost ? `호스트 ${j.edgeHost}` : '';
  // v2.826: 사전 점검 때(다시 당긴) 엣지 판 · 업그레이드 뒤 적용 옵션
  const ver = typeof j.edgeVersion === 'string' && j.edgeVersion ? `판 ${j.edgeVersion}` : '';
  const up = j.upgradeFirst === true ? '업그레이드 뒤' : '';
  return [dhms(j.startedAt), j.by, st, up, path, host, ver, j.fp ? `지문 ${j.fp}` : ''].filter(Boolean).join(' · ');
}

/** 실행 전 확인 문구(window.confirm). upgradeFirst 면 엣지 재시작을 먼저 말한다(v2.826). */
export function confirmText(agent, { upgradeFirst = false } = {}) {
  const head = upgradeFirst
    ? `엣지 '${agent}' 를 먼저 중앙 판으로 업그레이드한 뒤 개별 central 토큰을 발급하고 적용합니다.\n\n`
      + '0) 엣지 판이 2.776.0 미만이면 중앙의 업그레이드 번들을 그 엣지에 보냅니다 — 엣지 포탈이 설치·재시작되는 동안(보통 1~2분) 그 사이트 화면과 수집이 잠시 멈춥니다. 새 판으로 올라온 것을 확인한 뒤에만 토큰을 발급합니다(최대 5분 대기). 판이 이미 충분하면 건너뜁니다.\n'
    : `엣지 '${agent}' 에 개별 central 토큰을 발급하고 적용합니다.\n\n`;
  return head
    + '1) 중앙에서 개별 토큰 발급\n2) 수집 토큰 통로로 엣지에 전달 — 엣지가 portal.env(AGENT_CENTRAL_TOKEN)에 쓰고 새 토큰으로 중앙을 확인(실패하면 엣지가 되돌림)\n'
    + '3) 안 되면 배포 기록의 SSH 계정으로 portal.env 수정·재시작(접속한 장비의 포탈 이름·호스트 이름이 그 엣지인지 먼저 확인 · 사본을 남기고 실패하면 되돌림)\n4) 중앙에서 사용 확인 · 배포 기록 토큰 맞춤\n\n'
    + '실패해도 공유 토큰은 그대로 받으므로 수집은 끊기지 않습니다. 진행할까요?';
}

/**
 * v2.826: 마지막 작업이 '엣지 판이 낮아 전달할 통로가 없음' 으로 끝났으면(서버 기록 hint 'upgrade') 화면이 '엣지 업그레이드 뒤 자동 적용' 버튼을 단다(순수).
 *   진행 중인 작업이 있으면 달지 않는다. 기록이 없거나 다른 이유의 실패면 달지 않는다(업그레이드가 답이 아닌 실패에 재시작을 권하지 않게).
 * @param {object|null} latest 지금 보는 작업(없으면 기록의 첫 항목)
 */
export function upgradeOffered(latest) {
  return !!(latest && typeof latest === 'object' && latest.state !== 'running' && latest.hint === 'upgrade');
}
export const UPGRADE_BUTTON_TEXT = '엣지 업그레이드 뒤 자동 적용';
export const UPGRADE_HELP_TEXT = '엣지 판이 2.776.0 미만이면 수집 토큰 통로가 없습니다(옛 판은 HTTP 401). 이 버튼은 중앙 번들로 엣지를 먼저 업그레이드하고(엣지 포탈 재시작) 새 판을 확인한 뒤 적용합니다.';

/**
 * v2.785(GE A-B2): '개별 토큰 자동 적용' 시작 응답 해석(순수). postJson 은 409 를 던지지 않고 본문 `{ok:false, reason, jobId}` 를 돌려준다
 *   (이미 진행 중 — 서버 routes/admin/centralTokens.js). 예전에는 `r.job.id` 를 바로 읽어 영어 TypeError 가 화면에 떴고 진행 중인 작업도
 *   따라가지 않았다. 거부면 서버 사유를 보이고, 진행 중인 작업 id 가 있으면 그것을 따라간다.
 * @returns {{job:object|null, pollId:string|null, error:string}}
 */
export function applyStartOutcome(r) {
  if (r && r.ok === true && r.job && typeof r.job === 'object' && r.job.id) return { job: r.job, pollId: String(r.job.id), error: '' };
  const jobId = r && typeof r.jobId === 'string' && r.jobId ? r.jobId : null;
  if (r && r.ok === true) return { job: null, pollId: jobId, error: '적용을 시작했지만 서버 응답에 작업 정보가 없습니다 — 아래 작업 기록을 확인하세요.' };
  const reason = r && typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : '적용을 시작하지 못했습니다.';
  return { job: null, pollId: jobId, error: jobId ? `${reason} 진행 중인 작업을 이어서 보여 줍니다.` : reason };
}
