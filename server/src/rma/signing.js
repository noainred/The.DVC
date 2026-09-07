/**
 * RMA 잡 서명(순수) — 중앙과 엣지가 공유하는 RMA 비밀번호(HostMonitor RMA 의 'agent password' 에
 * 해당)로 잡 본문에 HMAC-SHA256 을 붙인다.
 *
 * 왜 필요한가: 엣지 RMA 는 중앙 URL 을 TLS 로 신뢰하지만, 중앙 포탈의 관리자 세션이 탈취되거나
 * 중앙 자체가 침해되면 그 신뢰만으로 모든 엣지에서 명령이 실행된다. 엣지에 **별도 비밀번호**를
 * 두면(RMA_PASSWORD) 중앙 관리자 중 그 비밀번호를 아는(등록한) 사람만 그 엣지에 명령을 보낼 수
 * 있고, 비밀번호는 선로에 실리지 않는다(HMAC 만 전달). 비밀번호를 양쪽 다 비워 두면 서명 없이
 * 동작한다(엣지가 `signed:false` 로 보고 — UI 가 경고).
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
