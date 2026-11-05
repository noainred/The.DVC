/**
 * VM 신호('조치 필요') 판정 — v2.909(가상화 서버 허브 · 시안 `docs/design/vm-screen` 시안 1). 순수 모듈(입출력 없음).
 *
 * 신호 4종. **새 기준을 만들지 않는다** — 이미 화면·리포트가 쓰는 판정을 그대로 부른다(판정 한 벌):
 *  · overload     — 전원 POWERED_ON 이고 CPU 또는 메모리 사용률 칸이 `OVERLOAD_BIN`(18 = 90%↑) 이상.
 *                   칸 판정은 분포 패널과 같은 `vmDist.usageBinOf` — 패널의 '90%↑' 를 누른 결과와 같은 집합이다.
 *  · usageUnknown — 전원 POWERED_ON 인데 CPU 또는 메모리 사용률을 못 읽음(`numOrNull` null — usageBinOf 가 null).
 *                   `/vms` totals.usageUnknown 이 평균에서 뺀 VM 과 같은 판정이다. **과부하로 세지 않는다**(못 읽은 값은 0 도 100 도 아니다).
 *  · toolsOld     — 템플릿이 아니고 toolsVersionStatus 가 `reports/compliance.js TOOLS_NEED_UPGRADE`(버전 준수 리포트·이전 준비도와 같은 집합).
 *                   전원과 무관하다(꺼진 VM 도 업그레이드 대상). 값이 비었으면(못 읽음) 신호가 아니다.
 *  · snapOld      — 'VM 구성 점검'(vm-hygiene) 의 `snap-age` 판정 그대로(`vmhygiene/analyze.js hygieneFindings`) —
 *                   기준 일수 `snapAgeDays`·예외 목록은 그 도구 설정을 따르고, 생성일을 모르면 판정하지 않는다.
 *
 * 꺼진 VM 의 사용률은 낡은 값이라 overload·usageUnknown 은 구동 VM 만 본다(분포 패널과 같은 규칙).
 * '유휴 후보' 는 신호가 아니다 — 1주 평균 CPU 는 vCenter 성능 조회가 필요해 'VM 정밀 검색' 도구가 따로 계산한다(여기서 부르지 않는다).
 */
import { usageBinOf, VM_DIST_BIN_PCT, facetShapeIssues } from './vmDist.js';
import { TOOLS_NEED_UPGRADE } from '../reports/compliance.js';
import { hygieneFindings } from '../vmhygiene/analyze.js';

export const SIGNAL_KEYS = Object.freeze(['overload', 'usageUnknown', 'toolsOld', 'snapOld']);
/** 과부하 칸 하한 — 90% / 5% = 18(분포 패널 '90%↑' 와 같은 칸). */
export const OVERLOAD_PCT = 90;
export const OVERLOAD_BIN = OVERLOAD_PCT / VM_DIST_BIN_PCT;
const TOOLS_OLD = new Set(TOOLS_NEED_UPGRADE);

/**
 * 판정 문맥. hygiene = vm-hygiene 설정(loadVmHygieneSettings — snapAgeDays·exceptions 등), now = 기준 시각(ms).
 * 설정이 없으면 snapOld 는 판정하지 않는다(지어내지 않는다).
 */
export function signalContext(hygiene, now) {
  return { hygiene: hygiene && typeof hygiene === 'object' ? hygiene : null, now: Number.isFinite(now) ? now : Date.now() };
}

/** VM 하나의 신호 목록(SIGNAL_KEYS 순서). 객체가 아니면 빈 배열. */
export function vmSignalsOf(v, ctx) {
  const out = [];
  if (!v || typeof v !== 'object') return out;
  if (v.powerState === 'POWERED_ON') {
    const cb = usageBinOf(v.cpuUsagePct);
    const mb = usageBinOf(v.memUsagePct);
    if ((cb != null && cb >= OVERLOAD_BIN) || (mb != null && mb >= OVERLOAD_BIN)) out.push('overload');
    if (cb == null || mb == null) out.push('usageUnknown');
  }
  if (v.template !== true && TOOLS_OLD.has(v.toolsVersionStatus)) out.push('toolsOld');
  if (ctx?.hygiene) {
    const { findings } = hygieneFindings(v, ctx.hygiene, ctx.now);
    if (findings.some((f) => f.code === 'snap-age')) out.push('snapOld');
  }
  return out;
}

/** 신호별 개수 + any(신호가 하나라도 있는 VM 수 — 중복 없이). */
export function signalCounts(vms, ctx) {
  const c = { overload: 0, usageUnknown: 0, toolsOld: 0, snapOld: 0, any: 0 };
  for (const v of vms || []) {
    const s = vmSignalsOf(v, ctx);
    if (!s.length) continue;
    c.any += 1;
    for (const k of s) c[k] += 1;
  }
  return c;
}

/** 신호로 거른다(입력 순서 그대로). signal 이 없으면 같은 배열. */
export function filterVmsBySignal(vms, signal, ctx) {
  if (!signal) return vms;
  const out = [];
  for (const v of vms) if (vmSignalsOf(v, ctx).includes(signal)) out.push(v);
  return out;
}

/**
 * 쿼리 `signal`(목록 거르기) · `signals=1`(개수·항목별 신호 싣기) 해석. 형식이 틀리면 { ok:false, field:'signal' } —
 * 라우트가 400 bad-facet 으로 돌려준다(패널 선택과 같은 규약). 원문 쿼리를 주면 같은 키 두 번·`signal[x]=` 모양도 거부한다
 * (운영 앱의 queryNormalize 는 배열을 마지막 값으로 바꾼다 — vmDist.facetShapeIssues 와 같은 이유).
 */
export function parseSignalQuery(q, { rawQuery } = {}) {
  const src = q || {};
  if (facetShapeIssues(rawQuery, ['signal']).has('signal')) return { ok: false, field: 'signal' };
  const raw = src.signal;
  let signal = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw !== 'string' || !SIGNAL_KEYS.includes(raw)) return { ok: false, field: 'signal' };
    signal = raw;
  }
  const want = src.signals === '1' || src.signals === 'true';
  return { ok: true, signal, want };
}
