/**
 * agent/centralReply.js — 엣지 push 가 중앙 응답의 '일부만 받음' 요약을 읽는 공용 헬퍼(v2.606 EDGE2606-03).
 *
 * 왜: 중앙은 200 이어도 일부를 뺄 수 있다 — curuser `rejected:[vcenterId]` · gpu-guest-data `unregistered`·
 *   `omitted:{hosts,vms}`·`unverifiedAgent` · fleet `omitted`·`vcenterBlanked` · inventory `rejected`·`dropped`·`held` ·
 *   agent-config `omitted`·`rejectedFiles`. 예전에는 이 다섯 push 가 `res.ok` 만 보고 '보냈다(N건)' 로 상태·콘솔에
 *   남겼다 — 중앙 화면에는 없는데 엣지 로그 화면은 성공이다(storage·SAN·PDU 는 v2.600~2.601 에 readDropSummary 로
 *   이미 읽는다 — 이것은 그 형제 누락). 순수 판정 + 조절된 콘솔 경고만 둔다(전송 로직은 각 push 가 갖는다).
 */
import { createChangeLogger } from '../util/logThrottle.js';

const numOf = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') return Object.values(v).reduce((a, x) => a + numOf(x), 0);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 응답 본문을 JSON 으로 읽는다(실패·비 JSON 이면 null). 본문은 한 번만 읽을 수 있으므로 이 함수만 부를 것. */
export async function readCentralReply(res) {
  try {
    const j = await res.json();
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

/**
 * 응답 JSON → 거절 요약. 뺀 것이 없으면 null. 순수 — 테스트가 고정.
 * @returns {null|{rejected:number, rejectedIds?:string[], unregistered:number, omitted:number, vcenterBlanked:number,
 *   held:boolean, rejectedFiles:number, unverifiedAgent:boolean, text:string}}
 */
export function dropSummaryOf(j) {
  if (!j || typeof j !== 'object') return null;
  const rejected = numOf(j.rejected) || (j.dropped && typeof j.dropped === 'object' ? numOf(j.dropped) : 0);
  return finalize({
    rejected,
    rejectedIds: Array.isArray(j.rejected) ? j.rejected.slice(0, 20).map((x) => String(x).slice(0, 128)) : [],
    unregistered: numOf(j.unregistered),
    omitted: numOf(j.omitted),
    vcenterBlanked: numOf(j.vcenterBlanked),
    held: j.held === true,
    rejectedFiles: Number.isFinite(Number(j.rejectedFileCount)) && Number(j.rejectedFileCount) > 0 ? Number(j.rejectedFileCount) : numOf(j.rejectedFiles),
    unverifiedAgent: j.unverifiedAgent === true,
  });
}

function finalize(out) {
  const parts = [];
  if (out.rejected) parts.push(`거부 ${out.rejected}${out.rejectedIds.length ? `(${out.rejectedIds.join(', ')})` : ''}`);
  if (out.unregistered) parts.push(`중앙 미등록 ${out.unregistered}`);
  if (out.omitted) parts.push(`상한 초과로 제외 ${out.omitted}`);
  if (out.vcenterBlanked) parts.push(`vCenter 귀속 비움 ${out.vcenterBlanked}`);
  if (out.held) parts.push('중앙이 직전 목록을 유지(held)');
  if (out.rejectedFiles) parts.push(`파일 거부 ${out.rejectedFiles}`);
  if (out.unverifiedAgent) parts.push('엣지 이름 미검증');
  if (!parts.length) return null;
  return { ...out, text: parts.join(' · ') };
}

/** 두 요약을 합친다(청크 여러 개). null 허용. */
export function mergeDrop(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const n = (k) => (a[k] || 0) + (b[k] || 0);
  return finalize({
    rejected: n('rejected'),
    rejectedIds: [...new Set([...(a.rejectedIds || []), ...(b.rejectedIds || [])])].slice(0, 20),
    unregistered: n('unregistered'), omitted: n('omitted'), vcenterBlanked: n('vcenterBlanked'),
    held: Boolean(a.held || b.held), rejectedFiles: n('rejectedFiles'), unverifiedAgent: Boolean(a.unverifiedAgent || b.unverifiedAgent),
  });
}

const warnLog = createChangeLogger({ windowMs: 10 * 60_000, maxKeys: 64 });

/** 뺀 것이 있으면 콘솔에 남긴다(같은 사유는 10분에 1줄). 반환: 찍었는지. */
export function warnDrop(tag, summary, now = Date.now()) {
  if (!summary) return false;
  if (!warnLog(tag, summary.text, now)) return false;
  console.warn(`[${tag}] 중앙이 일부를 받지 않았습니다 — ${summary.text} (전송은 성공했지만 중앙 화면에는 이만큼 없습니다)`);
  return true;
}
