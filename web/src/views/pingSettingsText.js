/**
 * pingSettingsText.js — 네트워크 › Ping 모니터링 '측정 설정'(v2.963 · 사용자 요청 "화면에서 주기 설정할 수 있게 · ping 은 중단없이 계속 ping").
 * 순수(React 없음 — vitest 로 고정). 서버 `ping/settings.js` 와 범위·부하 산수가 같다(서버 테스트 ⑩ 이 대조한다).
 *  · 측정 간격: 대상마다 쉬지 않고 재는 간격 · 요약(저장) 주기: 그 사이 잰 것을 한 줄로 저장하는 주기 · 시한: 한 번 잴 때 기다리는 최대 시간.
 *  · 화면 입력은 초 단위(소수 허용) → 서버는 정수 ms. 범위 밖·숫자 아님은 보내지 않고 이유를 보인다(서버도 같은 검사를 한다).
 *  · 문구에 백틱을 쓰지 않는다(BoldText).
 */
import { numOrNull } from '../numOrNull.js';

export const PING_SETTING_RANGES = Object.freeze({
  probeIntervalMs: Object.freeze({ min: 1_000, max: 60_000 }),
  summaryIntervalMs: Object.freeze({ min: 10_000, max: 3_600_000 }),
  timeoutMs: Object.freeze({ min: 200, max: 10_000 }),
});
export const PING_SETTING_FIELDS = Object.freeze([
  { key: 'probeIntervalMs', form: 'probeSec', label: '측정 간격', hint: '대상마다 쉬지 않고 이 간격으로 잽니다' },
  { key: 'summaryIntervalMs', form: 'summarySec', label: '요약(저장) 주기', hint: '그동안 잰 것을 평균·최저·최고·손실 한 줄로 저장합니다' },
  { key: 'timeoutMs', form: 'timeoutSec', label: '시한', hint: '이 시간 안에 응답이 없으면 손실로 셉니다' },
]);
export const SOURCE_TEXT = Object.freeze({ ui: '화면 설정', env: '환경 변수', default: '기본값' });

/** ms → '1초' · '2.5초' · '1분' · '1분 30초' · '1시간'. 값이 없으면 '—'. */
export function durText(ms) {
  const n = numOrNull(ms);
  if (n == null || n < 0) return '—';
  if (n < 1_000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${Math.round(n / 100) / 10}초`;
  if (n < 3_600_000) {
    const m = Math.floor(n / 60_000); const sec = Math.round((n % 60_000) / 1_000);
    return sec ? `${m}분 ${sec}초` : `${m}분`;
  }
  const h = Math.floor(n / 3_600_000); const m = Math.round((n % 3_600_000) / 60_000);
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

/** 한 줄 요약 — '1초마다 측정 · 1분마다 요약 저장 · 시한 2.5초'. */
export function settingsLine(s) {
  if (!s) return '';
  return `${durText(s.probeIntervalMs)}마다 측정 · ${durText(s.summaryIntervalMs)}마다 요약 저장 · 시한 ${durText(s.timeoutMs)}`;
}

/** 값의 출처 — 화면 값이 하나라도 있으면 '화면 설정', 아니면 환경 변수·기본값. */
export function sourceLine(s) {
  const src = s?.source || {};
  const vals = Object.values(src);
  if (!vals.length) return '';
  if (vals.some((v) => v === 'ui')) {
    const who = s?.updatedBy ? ` · ${s.updatedBy}` : '';
    return `화면 설정${who}`;
  }
  return vals.some((v) => v === 'env') ? '환경 변수(포탈 시작 값)' : '기본값';
}

/** 모니터 상태 한 줄. */
export function monitorText(m) {
  if (!m) return '';
  if (m.mode === 'continuous') return m.running ? `연속 측정 중 · 대상 ${m.targets ?? 0}개` : '연속 측정 멈춤';
  if (m.mode === 'mock') return '데모 — 실제로 재지 않고 합성 값을 저장합니다';
  if (m.mode === 'off') return 'Ping 모니터가 꺼져 있습니다(이 포탈은 재지 않습니다)';
  return '모니터가 아직 시작되지 않았습니다';
}

const secOf = (ms) => { const n = numOrNull(ms); return n == null ? '' : String(Math.round(n / 100) / 10); };
/** 서버 값 → 폼(초 단위 문자열). */
export function formOf(s) {
  return { probeSec: secOf(s?.probeIntervalMs), summarySec: secOf(s?.summaryIntervalMs), timeoutSec: secOf(s?.timeoutMs) };
}

const NUM_RE = /^\d+(?:\.\d+)?$/;
/**
 * 폼 → 저장 본문 + 문제 목록. 문제가 있으면 body 는 null(보내지 않는다).
 * @returns {{ body: object|null, issues: {field:string, reason:string}[] }}
 */
export function payloadOf(form) {
  const issues = []; const body = {};
  for (const f of PING_SETTING_FIELDS) {
    const raw = String(form?.[f.form] ?? '').trim();
    if (!NUM_RE.test(raw)) { issues.push({ field: f.key, reason: `${f.label}: 숫자(초)만 입력하세요(입력 ‘${raw}’)` }); continue; }
    const ms = Math.round(Number(raw) * 1_000);
    const r = PING_SETTING_RANGES[f.key];
    if (ms < r.min || ms > r.max) { issues.push({ field: f.key, reason: `${f.label}: ${durText(r.min)}~${durText(r.max)} 사이여야 합니다(입력 ${durText(ms)})` }); continue; }
    body[f.key] = ms;
  }
  if (body.probeIntervalMs != null && body.summaryIntervalMs != null && body.summaryIntervalMs < body.probeIntervalMs) {
    issues.push({ field: 'summaryIntervalMs', reason: '요약(저장) 주기는 측정 간격 이상이어야 합니다' });
  }
  return { body: issues.length ? null : body, issues };
}

/** 부하·저장 산수 — 서버 `pingLoadOf` 와 같은 식(저장 전 미리보기). */
export function pingLoadOf(s, targetCount) {
  const n = Math.max(0, Math.floor(numOrNull(targetCount) ?? 0));
  const probe = numOrNull(s?.probeIntervalMs) ?? 1_000;
  const summary = numOrNull(s?.summaryIntervalMs) ?? 60_000;
  return {
    targets: n,
    probesPerSec: Math.round((n * 1_000 / probe) * 100) / 100,
    probesPerSummary: Math.max(1, Math.floor(summary / probe)),
    rowsPerDay: Math.round(n * 86_400_000 / summary),
  };
}
export function loadText(load) {
  if (!load) return '';
  return `대상 ${load.targets}개 · 초당 약 ${load.probesPerSec.toLocaleString()}회 측정 · 한 줄에 ${load.probesPerSummary.toLocaleString()}회 · 하루 ${load.rowsPerDay.toLocaleString()}줄 저장`;
}
