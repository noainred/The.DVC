/**
 * mail/kinds.js — 메일 발송 종류 카탈로그 (순수 모듈, v2.454).
 *
 * 포탈의 어떤 기능이 메일을 보낼 수 있는지 한곳에 모은다. 설정 화면은 이 목록으로 만들어지고,
 * 기능별로 **켜기/끄기 + 수신자 재정의**가 가능하다(비우면 기본 수신자로 간다).
 *
 * 새 기능에서 메일을 보내려면:
 *   1. 여기에 `{ id, label, desc }` 를 추가한다.
 *   2. 그 기능에서 `sendPortalMail({ kind: '<id>', subject, html, text })` 를 부른다.
 * 그러면 SMTP 설정·수신자·속도 제한·이력·감사로그가 전부 공용 경로를 탄다 —
 * 기능마다 SMTP 설정을 따로 두면 운영자가 같은 값을 여러 번 입력하고, 한쪽만 고쳐 놓고
 * "왜 이 알림만 안 오지" 를 겪게 된다(v2.454 초안이 실제로 그 구조였다).
 */

export const KINDS = Object.freeze([
  { id: 'alert', label: '알림(임계·장애)', desc: 'vCenter 다운·호스트 분리·데이터스토어 임계 등 알림 규칙과, 네트워크/PDU/HAProxy/RMA 점검이 올리는 이벤트.' },
  { id: 'daily', label: '일일 리포트', desc: '하루 1회 헬스체크 요약(설정 › 알림의 일일 리포트 시각).' },
  { id: 'dirusage', label: '폴더 사용량 Top-N', desc: '엣지 공유 폴더의 하위 폴더별 사용량 상위 목록(설정 › 폴더 사용량 리포트).' },
  { id: 'test', label: '테스트 발송', desc: '설정 화면의 메일 테스트 버튼.' },
]);

const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

export function isKind(id) { return BY_ID.has(String(id || '')); }
export function kindLabel(id) { return BY_ID.get(String(id || ''))?.label || String(id || ''); }

/**
 * 이 종류를 지금 보내야 하는가 + 받는 사람은 누구인가 (순수 — 테스트로 고정).
 *
 * 우선순위: 호출부가 명시한 수신자 > 종류별 수신자 > 기본 수신자.
 * `test` 는 설정 화면에서 수동으로 누르는 것이라 **전역 enabled 만** 보고 종류별 토글은 보지 않는다
 * (테스트를 하려고 종류 토글을 켰다 끄는 것은 번거롭고, 그 토글의 의미와도 다르다).
 *
 * @param {object} cfg  mail.json 설정
 * @param {string} kind
 * @param {string[]|string} [explicitTo] 호출부가 지정한 수신자
 * @returns {{ok:boolean, reason?:string, to:string[], cc:string[]}}
 */
export function resolveRecipients(cfg, kind, explicitTo = null) {
  const empty = { to: [], cc: [] };
  if (!cfg?.enabled) return { ok: false, reason: '메일 발송이 꺼져 있습니다(설정 › 메일 발송).', ...empty };
  if (!String(cfg?.smtp?.host || '').trim()) return { ok: false, reason: 'SMTP 서버가 설정되지 않았습니다.', ...empty };

  const per = (cfg.kinds || {})[kind] || {};
  if (kind !== 'test' && per.enabled === false) {
    return { ok: false, reason: `'${kindLabel(kind)}' 메일이 꺼져 있습니다.`, ...empty };
  }
  const list = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean);
  const explicit = explicitTo == null ? [] : list(Array.isArray(explicitTo) ? explicitTo : [explicitTo]);
  const to = explicit.length ? explicit : (list(per.to).length ? list(per.to) : list(cfg.defaultTo));
  const cc = explicit.length ? [] : list(per.cc);   // 명시 수신자를 준 호출부는 참조까지 스스로 정한다
  if (!to.length && !cc.length) {
    return { ok: false, reason: `'${kindLabel(kind)}' 의 받는 사람이 없습니다(종류별 수신자 또는 기본 수신자를 설정하세요).`, ...empty };
  }
  return { ok: true, to, cc };
}

/**
 * 속도 제한 판정 (순수). 최근 1시간 발송 시각 배열을 받아 지금 보내도 되는지 본다.
 * 알림 폭주(수십 대 동시 다운)가 메일 릴레이를 때리는 것을 막는다 — 릴레이가 우리를 차단하면
 * 정작 중요한 메일도 못 나간다.
 */
export function withinRateLimit(sentAtList, limitPerHour, now = Date.now()) {
  const lim = Number(limitPerHour);
  if (!Number.isFinite(lim) || lim <= 0) return true;      // 0/미설정 = 제한 없음
  const cut = now - 3600_000;
  return (sentAtList || []).filter((t) => t > cut).length < lim;
}
