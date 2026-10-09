/**
 * OneFS(Isilon) API 영역 수집 배지·안내의 판정(v2.730 검토 I-03 — 순수 모듈, 문구 포함).
 *
 * ⚠⚠ 왜 있나: 장비 상세의 영역 배지는 인라인 판정 `a.failed === 0 ? 'green'` 이었다. 그런데 수집이 시한·인증 실패(401)·
 *   연속 전송 오류로 **영역 중간에서** 멈추면 그 영역은 남은 엔드포인트가 있는데도 `failed === 0` 이라 **초록 '정상'** 으로
 *   칠해졌다(재현: cluster 3개 중 첫째만 성공 → `{ok:1, failed:0}`). 첫 요청 전에 끊긴 영역(`{ok:0, failed:0}`)도 초록이었다.
 *   서버(storage/onefsAreaSummary.js)가 이제 영역마다 `expectedEndpoints`·`attempted`·`notTriedEndpoints`·`partial`·`stopReason`
 *   을 싣고, 판정·문구는 이 모듈 하나가 소유한다(인라인으로 되돌리지 말 것 — 테스트가 소스를 검사한다).
 *
 * 규칙(테스트가 하나씩 고정한다 — rvC_onefsAreaState.test.js):
 *  - **초록은 '예정 엔드포인트를 전부 시도했고 실패 0' 일 때만**이다.
 *  - 첫 성공 뒤 멈춤 = 호박색 '부분'(읽은 값은 저장됐지만 이 영역을 정상으로 보지 않는다).
 *    시도한 것이 전부 실패한 채 멈춤 = 빨강 '중단'. 한 엔드포인트도 시도 못함 = '미시도'(카탈로그 '비활성' 과 다르다).
 *  - **구버전 수집기(새 필드 없음)**: 예전 판정을 따르되, 수집이 멈춘(`areasStopped`) 요약에서 **마지막으로 시도한 영역**은
 *    끝까지 갔는지 알 수 없다 → 초록 대신 호박색 '완료 여부 미상'. 그 앞 영역은 구버전 수집기가 순서대로 끝까지 돈 뒤에야
 *    다음 영역으로 넘어가므로(멈춤은 한 번뿐) 예전 판정이 맞다. `{ok:0, failed:0}`(시도 0)은 버전과 무관하게 미시도다.
 *  - 문구에 백틱 금지(BoldText 는 `**강조**` 만 해석한다). 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';
import { areasStopNote } from './areasStopText.js';

export const AREA_KIND = Object.freeze({
  OK: 'ok', SOME_FAILED: 'some-failed', FAILED: 'failed', PARTIAL: 'partial', STOPPED_FAILED: 'stopped-failed',
  NOT_TRIED: 'not-tried', DISABLED: 'disabled', UNKNOWN: 'unknown',
});

export const AREA_TONE = Object.freeze({
  ok: 'green', 'some-failed': 'amber', failed: 'red', partial: 'amber', 'stopped-failed': 'red',
  'not-tried': 'amber', disabled: 'gray', unknown: 'amber',
});

/** 멈춘 사유 → '…로/…아' 원인 구절. 서버 onefsAreaSummary.AREA_STOP_REASONS 와 키 1:1. */
export const STOP_CAUSE = Object.freeze({
  auth: '인증 실패로',
  deadline: '영역 수집 시한을 넘겨',
  transport: '장비가 연속으로 응답하지 않아',
});
const causeOf = (k) => (k ? (STOP_CAUSE[k] || `수집이 멈춰(사유 코드 ‘${k}’)`) : '수집이 멈춰');

const cnt = (v) => { const n = numOrNull(v); return n == null || n < 0 ? 0 : n; };

/** 이 항목에 부분 수집 판정용 새 필드가 하나라도 있는가(없으면 구버전 수집기). */
export function hasEndpointCounts(a) {
  return numOrNull(a?.expectedEndpoints) != null || numOrNull(a?.notTriedEndpoints) != null || typeof a?.partial === 'boolean';
}

/** 구버전 요약에서 '완료 여부 미상' 이 될 수 있는 위치 — 수집이 멈췄을 때 마지막으로 시도한(비활성·미시도 아닌) 영역. */
function legacyStopIndex(areas, extra) {
  if (!extra?.areasStopped) return -1;
  let idx = -1;
  areas.forEach((a, i) => { if (a && !a.skipped && !a.notTried) idx = i; });
  return idx;
}

/**
 * 영역 한 줄 → 판정.
 * @param {object} a  extra.areas 원소
 * @param {{ legacyStop?: boolean, stopReason?: string|null }} [ctx]  legacyStop = 구버전 요약의 '마지막으로 시도한 영역' 인가
 * @returns {{ area:string, kind:string, tone:string, suffix:string, title:string, clickable:boolean }}
 */
export function areaState(a, { legacyStop = false, stopReason = null } = {}) {
  const area = typeof a?.area === 'string' ? a.area : '?';
  const ok = cnt(a?.ok); const failed = cnt(a?.failed);
  const attempted = numOrNull(a?.attempted) ?? (ok + failed);
  const exp = numOrNull(a?.expectedEndpoints);
  const err = typeof a?.error === 'string' && a.error ? a.error : '';
  const reason = (typeof a?.stopReason === 'string' && a.stopReason) || stopReason || null;
  const mk = (kind, suffix, title) => ({ area, kind, tone: AREA_TONE[kind], suffix, title, clickable: kind !== AREA_KIND.NOT_TRIED && kind !== AREA_KIND.DISABLED });

  if (a?.notTried) {
    return mk(AREA_KIND.NOT_TRIED, ' (미시도)', `${err || `${causeOf(reason)} 이번 주기에 이 영역을 시도하지 않았습니다`}${exp != null ? ` · 엔드포인트 ${exp}개` : ''}`);
  }
  if (a?.skipped) return mk(AREA_KIND.DISABLED, ' (비활성)', err || '수집하지 않는 영역입니다(카탈로그에서 꺼 둠)');
  if (attempted === 0) {
    // 시도 0 — 구버전 요약의 '첫 요청 전에 끊긴 영역' 이 이 모양이다(예전엔 failed===0 이라 초록이었다).
    return mk(AREA_KIND.NOT_TRIED, ' (미시도)', `${causeOf(reason)} 이번 주기에 이 영역을 시도하지 않았습니다${exp != null ? ` · 엔드포인트 ${exp}개` : ''}`);
  }
  const leftRaw = numOrNull(a?.notTriedEndpoints);
  const left = leftRaw != null ? leftRaw : (exp != null ? Math.max(0, exp - attempted) : null);
  const counts = `성공 ${ok} · 실패 ${failed}${exp != null ? ` · 예정 ${exp}개` : ''}`;
  if (a?.partial === true || (left != null && left > 0)) {
    const leftTxt = left != null && left > 0 ? `엔드포인트 ${left}개를` : '나머지 엔드포인트를';
    const errTxt = err ? ` · 첫 오류: ${err}` : '';
    if (ok > 0) {
      return mk(AREA_KIND.PARTIAL, exp != null ? ` 부분 ${ok}/${exp}` : ' 부분',
        `${causeOf(reason)} 이 영역의 ${leftTxt} 시도하지 않았습니다 — 부분 수집(읽은 값은 저장했지만 이 영역을 정상으로 보지 않습니다) · ${counts}${errTxt}`);
    }
    return mk(AREA_KIND.STOPPED_FAILED, exp != null ? ` 중단 ${ok}/${exp}` : ' 중단',
      `${causeOf(reason)} 이 영역의 ${leftTxt} 시도하지 않았습니다 — 시도한 ${attempted}개는 모두 실패 · ${counts}${errTxt}`);
  }
  if (legacyStop && !hasEndpointCounts(a)) {
    if (ok === 0 && failed > 0) return mk(AREA_KIND.FAILED, ` ${ok}/${ok + failed}`, `${err ? `${err} · ` : ''}성공 ${ok} · 실패 ${failed}`);
    return mk(AREA_KIND.UNKNOWN, ' (완료 여부 미상)',
      `${causeOf(reason)} 수집이 멈췄는데, 이 요약은 구버전 수집기가 만들어 이 영역을 끝까지 수집했는지 알 수 없습니다(엣지 업그레이드 전이거나 업그레이드 뒤 아직 다시 수집하지 않음) · 성공 ${ok} · 실패 ${failed}`);
  }
  if (failed === 0) return mk(AREA_KIND.OK, '', exp != null ? `성공 ${ok} · 실패 0 · 예정 엔드포인트 ${exp}개 모두 시도` : `성공 ${ok} · 실패 0`);
  return mk(ok > 0 ? AREA_KIND.SOME_FAILED : AREA_KIND.FAILED, ` ${ok}/${ok + failed}`, `${err ? `${err} · ` : ''}성공 ${ok} · 실패 ${failed}`);
}

/** extra → 배지 목록(순서 그대로). 배열이 아니면 빈 목록. 객체 아닌 원소는 건너뛴다. */
export function areaStates(extra) {
  const areas = Array.isArray(extra?.areas) ? extra.areas.filter((a) => a && typeof a === 'object') : [];
  const li = legacyStopIndex(areas, extra);
  const stopReason = typeof extra?.areasStopped === 'string' ? extra.areasStopped : null;
  return areas.map((a, i) => areaState(a, { legacyStop: i === li, stopReason }));
}

/**
 * 멈춤 안내 — areasStopText.areasStopNote(영역 개수)에 부분 수집 영역·미시도 엔드포인트 수를 덧붙인다.
 * 구버전 요약이면 '완료 여부 미상' 의 뜻을 한 번만 말한다(배지마다 반복하지 않는다 — v2.509 규약).
 * @returns {{tone:string, text:string, fix:string} | null}
 */
export function areasStopNoteFull(extra) {
  const base = areasStopNote(extra);
  if (!base) return null;
  const partial = numOrNull(extra?.areasPartial);
  const epLeft = numOrNull(extra?.areasNotTriedEndpoints);
  const parts = [];
  if (partial != null && partial > 0) parts.push(`도중에 멈춘 영역 **${partial}개**는 부분 수집입니다(읽은 값은 저장했지만 정상으로 보지 않습니다)`);
  if (epLeft != null) parts.push(`시도하지 않은 엔드포인트는 모두 **${epLeft}개**입니다`);
  let text = base.text;
  if (parts.length) text = `${text} ${parts.join(' · ')}.`;
  else if (areaStates(extra).some((s) => s.kind === AREA_KIND.UNKNOWN)) {
    text = `${text} 이 요약은 구버전 수집기가 만들어 멈춘 영역이 끝까지 수집됐는지 알 수 없습니다(‘완료 여부 미상’ 배지).`;
  }
  return { tone: base.tone, text, fix: base.fix };
}

/** 머리글의 엔드포인트 표기 — 예정 수를 알면 ‘시도/예정’, 모르면 시도 수만(값이 없으면 단위 없이 —). */
export function areasEndpointText(extra) {
  const done = numOrNull(extra?.areasEndpoints);
  const exp = numOrNull(extra?.areasExpectedEndpoints);
  const base = exp != null && done != null ? `${done}/${exp}개` : unitText(done, '개');
  const dropped = numOrNull(extra?.areasDropped);
  return dropped ? `${base} · 형식이 맞지 않아 받지 않은 영역 요약 ${dropped}건` : base;
}
