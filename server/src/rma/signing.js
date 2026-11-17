/**
 * RMA 잡 서명(순수) — 중앙과 엣지가 공유하는 RMA 비밀번호(HostMonitor RMA 의 'agent password' 에
 * 해당)로 잡 본문에 HMAC-SHA256 을 붙인다.
 *
 * 왜 필요한가: 엣지 RMA 는 중앙 URL 을 TLS 로 신뢰한다. 엣지에 **별도 비밀번호**(RMA_PASSWORD)를 두면
 * 중앙을 사칭하는 응답(가짜 중앙 · 선로 변조)은 서명을 만들 수 없어 실행되지 않고, 비밀번호는 선로에 실리지
 * 않는다(HMAC 만 전달). 비밀번호를 양쪽 다 비워 두면 서명 없이 동작한다(엣지가 `signed:false` 로 보고 — UI 가 경고).
 * ⚠ 64회차 정정: 예전 문구는 '중앙 관리자 세션이 탈취돼도 비밀번호를 아는 사람만 명령을 보낸다' 고 했지만 사실이 아니다 —
 *   중앙이 법인 비밀번호를 저장해 두고(`rma-agents.json`) 실행 요청마다 **자동으로** 서명한다(routes/api/rma.js · jobs.signForTake).
 *   그래서 이 서명은 관리자 세션 탈취 · 중앙 침해를 막지 않는다.
 * 결정(56~75 남긴 것) 64 F7: 점검 스케줄의 `script` · `ssh` 항목(셸 · 원격 셸을 실행하는 두 점검)에도 같은 비밀번호로 서명한다
 *   (signScheduleItem — 항목 id · 법인 · 점검 · 인수 · 주기 · 서명 시각). 비밀번호가 있는 엣지는 서명이 없거나 틀린 두 점검을 실행하지 않고
 *   unknown 으로 남긴다(rma/agent.js applySchedule · runOne). 다른 점검(프리셋)은 서명을 보지 않는다 — 옛 중앙 · 옛 엣지와 섞여도 그대로 돈다.
 *
 * 만료: issuedAt 이 현재와 ±SKEW_MS 를 벗어나면 거부(재전송 공격 창 축소). 사이트 간 시계 오차를
 * 감안해 10분.
 */
import crypto from 'node:crypto';

export const SKEW_MS = 10 * 60_000;

/** 서명 대상 정규화 — 키 순서 고정(JSON 직렬화 차이로 서명이 어긋나지 않게). */
export function canonical(job) {
  const args = job.args && typeof job.args === 'object' ? job.args : {};
  const sortedArgs = Object.keys(args).sort().map((k) => [k, args[k] == null ? '' : String(args[k])]);
  return JSON.stringify([String(job.reqId || ''), String(job.agent || '').toLowerCase(), String(job.cmd || ''), sortedArgs, Number(job.timeoutMs) || 0, Number(job.issuedAt) || 0]);
}

export function signJob(secret, job) {
  if (!secret) return '';
  return crypto.createHmac('sha256', String(secret)).update(canonical(job)).digest('hex');
}

/**
 * 검증 — { ok, reason? }. secret 이 비어 있으면 서명 요구 없음(ok).
 * now 주입은 테스트용.
 */
export function verifyJob(secret, job, now = Date.now()) {
  if (!secret) return { ok: true, signed: false };
  const sig = String(job?.sig || '');
  if (!sig) return { ok: false, reason: '서명 없는 잡 — 이 엣지는 RMA_PASSWORD 가 설정되어 서명된 명령만 실행합니다(중앙 설정 › 원격 명령에서 이 엣지의 비밀번호를 등록하세요).' };
  const issuedAt = Number(job?.issuedAt) || 0;
  if (Math.abs(now - issuedAt) > SKEW_MS) return { ok: false, reason: '잡 발급 시각이 허용 오차(±10분)를 벗어났습니다 — 중앙/엣지 시계를 확인하세요.' };
  const want = signJob(secret, job);
  const a = Buffer.from(sig, 'utf8'), b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: '서명 불일치 — 중앙에 등록된 RMA 비밀번호와 이 엣지의 RMA_PASSWORD 가 다릅니다.' };
  return { ok: true, signed: true };
}

/*
 * 결정(56~75 남긴 것) 64 F7 — 점검 스케줄 항목 서명.
 *   서명 대상: 항목 id · 법인(소문자) · 점검 id · 인수(키 정렬) · 주기 · 서명 시각(sigAt). 'rma-schedule' 접두로 잡 서명과 섞이지 않는다.
 *   시각 창: 엣지는 **중앙에서 막 받은** 항목만 sigAt 을 ±SKEW_MS 로 본다(재전송 차단). 받은 뒤 파일로 보관한 항목은 주기마다 돌아야 하므로
 *   창을 다시 보지 않고 HMAC 만 다시 본다(비밀번호가 바뀌면 걸린다) — 받을 때의 판정(sigIssue)은 보관본에 함께 남는다.
 */
export const SCHEDULE_SIGNED_TESTS = Object.freeze(['script', 'ssh']);
export const scheduleSignRequired = (test) => SCHEDULE_SIGNED_TESTS.includes(String(test || ''));

export function canonicalScheduleItem(agent, item) {
  const args = item?.args && typeof item.args === 'object' ? item.args : {};
  const sortedArgs = Object.keys(args).sort().map((k) => [k, args[k] == null ? '' : String(args[k])]);
  return JSON.stringify(['rma-schedule', String(item?.id || ''), String(agent || '').toLowerCase(), String(item?.test || ''), sortedArgs, Number(item?.intervalSec) || 0, Number(item?.sigAt) || 0]);
}

export function signScheduleItem(secret, agent, item) {
  if (!secret) return '';
  return crypto.createHmac('sha256', String(secret)).update(canonicalScheduleItem(agent, item)).digest('hex');
}

/**
 * 중앙 — 배포할 항목 목록에 서명을 붙인 **사본**을 돌려준다(script · ssh 만, 저장된 항목은 바꾸지 않는다). 비밀번호가 없으면 그대로.
 */
export function signScheduleTests(secret, agent, tests, now = Date.now()) {
  const list = Array.isArray(tests) ? tests : [];
  if (!secret) return list;
  return list.map((t) => {
    if (!t || !scheduleSignRequired(t.test)) return t;
    const item = { ...t, sigAt: now };
    return { ...item, sig: signScheduleItem(secret, agent, item) };
  });
}

/**
 * 중앙 — 배정 서명(assignKey)에 붙이는 비밀번호 지문. 비밀번호를 새로 등록 · 바꾸 · 지우면 assignKey 가 달라져 스케줄이 다시 내려간다
 *   (스케줄 버전만 보면 비밀번호를 고친 뒤에도 엣지가 예전 판정 — '서명 없음' — 을 계속 들고 있다). 없으면 ''.
 */
export function scheduleSignKey(secret) {
  if (!secret) return '';
  return crypto.createHmac('sha256', String(secret)).update('rma-schedule-key').digest('hex').slice(0, 12);
}

/**
 * 엣지 — 항목 하나의 서명 판정 { ok, code?, reason? }. 비밀번호가 없거나 서명이 필요 없는 점검이면 ok.
 * @param {{ now?:number, checkWindow?:boolean }} [o]  checkWindow — 중앙에서 막 받은 항목만 true(파일 보관본은 false)
 */
export function verifyScheduleItem(secret, agent, item, { now = Date.now(), checkWindow = true } = {}) {
  if (!secret || !scheduleSignRequired(item?.test)) return { ok: true, signed: false };
  const sig = String(item?.sig || '');
  if (!sig) return { ok: false, code: 'unsigned', reason: '서명 없음 — 이 엣지는 RMA_PASSWORD 가 있어 외부 스크립트 · SSH 점검은 중앙 서명이 있어야 실행합니다(중앙 설정 › 원격 명령에서 이 법인의 비밀번호를 등록하세요).' };
  if (checkWindow && Math.abs(now - (Number(item?.sigAt) || 0)) > SKEW_MS) return { ok: false, code: 'window', reason: '서명 시각이 허용 오차(±10분)를 벗어났습니다 — 중앙/엣지 시계를 맞추면 10분 안에 스케줄을 다시 받아 다시 판정합니다(RMA 를 재시작해도 됩니다).' };
  const want = signScheduleItem(secret, agent, item);
  const a = Buffer.from(sig, 'utf8'), b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'mismatch', reason: '서명 불일치 — 중앙에 등록된 RMA 비밀번호와 이 엣지의 RMA_PASSWORD 가 다릅니다.' };
  return { ok: true, signed: true };
}
