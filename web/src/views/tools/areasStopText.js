/**
 * OneFS 영역 수집이 도중에 멈춘 사실의 문구(v2.598 T2598-01).
 *
 * 서버(storage/areasCollector.js)는 응답 없는 장비·시한 초과·인증 실패에서 나머지 영역을 시도하지 않고
 * `extra.areasStopped`('auth'|'deadline'|'transport') · `extra.areasNotTried` 를 싣는다. 시도하지 않은 영역은
 * 요약에 `skipped + notTried` 로 온다 — 카탈로그에서 꺼 둔 영역(`skipped` 만)과 **다르다**. 둘을 같은 '비활성'
 * 배지로 그리면 이번에 못 본 영역을 '원래 수집하지 않는 영역' 이라 말하게 된다.
 */
const STOP = {
  auth: { tone: 'red', text: '인증 실패로 나머지 영역을 시도하지 않았습니다', fix: '계정·비밀번호를 확인하세요(같은 계정으로 계속 시도하면 잠길 수 있습니다).' },
  deadline: { tone: 'amber', text: '영역 수집 시한을 넘겨 나머지 영역을 이번 주기에 시도하지 않았습니다', fix: '다음 주기에 다시 시도합니다. 반복되면 장비 응답 속도나 회선을 확인하세요.' },
  transport: { tone: 'amber', text: '장비가 연속으로 응답하지 않아 나머지 영역을 이번 주기에 시도하지 않았습니다', fix: '장비의 API 포트(8080) 도달성을 확인하세요. 다음 주기에 다시 시도합니다.' },
};

/** extra → 안내 한 건 또는 null(멈추지 않았음). 모르는 사유도 숨기지 않는다. */
export function areasStopNote(extra) {
  const k = extra?.areasStopped;
  if (!k) return null;
  const n = Number.isFinite(extra?.areasNotTried) ? extra.areasNotTried : null;
  const base = STOP[k] || { tone: 'amber', text: `영역 수집이 도중에 멈췄습니다(사유 코드 ‘${k}’)`, fix: '' };
  return { tone: base.tone, text: n == null ? `${base.text}.` : `${base.text} — 시도하지 않은 영역 **${n}개**.`, fix: base.fix };
}

/** 영역 배지 꼬리 글자 — 비활성(카탈로그)과 미시도(이번 주기)를 구분한다. */
export function areaBadgeSuffix(a) {
  if (a?.notTried) return ' (미시도)';
  if (a?.skipped) return ' (비활성)';
  return a?.failed ? ` ${a.ok}/${a.ok + a.failed}` : '';
}
