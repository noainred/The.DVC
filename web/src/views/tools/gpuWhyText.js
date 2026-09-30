/**
 * GPU 호스트 표의 '값이 없는 이유' 문구 · 할당 VM 한 줄 칩 · 동작 막대(v2.653 — 시안 A). 순수 함수 — vitest 가 고정한다.
 * 판정은 서버(gpu/guestWhy.js)가 코드로 주고 이 모듈은 문장만 만든다. 코드 ↔ 문구 1:1(테스트가 서버 목록과 대조한다).
 */
import { numOrNull } from '../../numOrNull.js';

export const WHY_TEXT = Object.freeze({
  'edge-no-report': { short: '엣지 보고 없음', fix: '이 법인을 수집하는 엣지가 게스트 GPU 를 한 번도 보고하지 않았습니다 — 엣지의 GPU 게스트 수집 설정·버전·중앙 토큰을 확인하세요(설정 › GPU 게스트 수집 › 수집 진단).' },
  'edge-stale': { short: '엣지 보고 멈춤', fix: '엣지의 게스트 GPU 보고가 오래됐습니다 — 엣지 로그(특수 기능 › 엣지 로그)에서 gpu-guest-push 줄을 확인하세요.' },
  'edge-no-config': { short: '엣지에 계정 미배포', fix: '엣지는 보고하지만 이 vCenter 를 수집 대상으로 갖고 있지 않습니다 — 설정 › GPU 게스트 수집 › 엣지 배포에서 그 엣지에 이 vCenter 계정을 지정하세요.' },
  'not-enabled': { short: '게스트 수집 꺼짐', fix: '이 vCenter 의 GPU 게스트 수집이 꺼져 있습니다 — 설정 › GPU 게스트 수집에서 켜고 계정을 입력하세요.' },
  'no-creds': { short: '계정 없음', fix: '수집 대상 VM 에 게스트 계정이 없습니다 — 공용 계정 또는 VM 별 계정을 입력하세요.' },
  'collect-failed': { short: '수집 실패', fix: '게스트 수집이 실패했습니다 — 수집 진단의 실패 사유(로그인·VMware Tools·SSH·nvidia-smi)를 확인하세요.' },
  'edge-old': { short: '엣지 구버전', fix: '엣지가 2.650 미만이라 온도·GPU 메모리 절대량을 보내지 않습니다 — 엣지를 업그레이드하세요.' },
  partial: { short: '일부만 수집', fix: '켜진 GPU VM 중 일부만 게스트 값을 읽었습니다 — 값은 읽은 VM 기준입니다.' },
  unknown: { short: '원인 미상', fix: '게스트 값이 없는 이유를 확정할 근거가 없습니다 — 수집 진단을 확인하세요.' },
});
export const WHY_CODES = Object.keys(WHY_TEXT);

/** 칩 짧은 글자 + title(조치 + 근거). null 이면 칩을 그리지 않는다. */
export function whyChip(why) {
  if (!why || !why.code) return null;
  const t = WHY_TEXT[why.code] || WHY_TEXT.unknown;
  let short = t.short;
  if (why.code === 'edge-old' && why.detail) short = `엣지 ${why.detail} — 구버전`;
  if (why.code === 'partial' && why.detail) short = `일부만 수집 ${why.detail}`;
  if (why.code === 'edge-stale' && why.detail) short = `엣지 보고 ${why.detail}분 전`;
  const bits = [t.fix];
  if (why.agent) bits.push(`담당 엣지: ${why.agent}`);
  if (why.detail && (why.code === 'collect-failed' || why.code === 'unknown')) bits.push(`근거: ${why.detail}`);
  return { short, title: bits.join('\n') };
}

/**
 * v2.657: 배너 한 줄의 '무엇을 못 읽었나' — 서버 missing(호스트 대수)에서 만든다. 없으면(구버전 서버) null.
 * 사용률·메모리 사용·온도는 게스트 또는 ESXi 에서 오고, 메모리 할당은 vCenter 의 vGPU 프로파일에서 온다(게스트와 무관).
 */
export function missingText(x) {
  const m = x && x.missing && typeof x.missing === 'object' ? x.missing : null;
  const hosts = numOrNull(x && x.hosts) ?? 0;
  if (!m || hosts <= 0) return null;
  const n = (k) => Math.max(0, numOrNull(m[k]) ?? 0);
  let read;
  if (n('all') === hosts) read = '사용률·메모리 사용·온도 전부 못 읽음(이 호스트들의 GPU 동작 값을 하나도 모릅니다)';
  else {
    const parts = [['util', '사용률'], ['mem', '메모리 사용'], ['temp', '온도']].filter(([k]) => n(k) > 0).map(([k, l]) => `${l} ${n(k)}대`);
    read = parts.length
      ? `못 읽은 값 — ${parts.join(' · ')}${n('all') > 0 ? ` (셋 다 못 읽은 호스트 ${n('all')}대)` : ''} · 나머지는 ESXi 카운터로 채움`
      : '사용률·메모리 사용·온도는 ESXi 카운터로 채웠습니다(게스트 값만 없음)';
  }
  const alloc = n('alloc') > 0
    ? `메모리 할당: vGPU 프로파일을 해석하지 못한 호스트 ${n('alloc')}대`
    : '메모리 할당은 읽음(vCenter 의 vGPU 프로파일 — 게스트 수집과 무관)';
  return `${read} · ${alloc}`;
}

/** 표 위 배너: 켜진 GPU VM 을 한 대도 못 읽은 원인만 vCenter 단위로(일부만 수집은 배너에 올리지 않는다). */
export function whyBannerItems(list) {
  const rows = (Array.isArray(list) ? list : []).filter((x) => x && x.code && x.code !== 'partial');
  return rows.map((x) => ({
    key: `${x.vcenterId}|${x.code}`,
    vcenterId: x.vcenterId,
    text: `${x.vcenterId} — ${(WHY_TEXT[x.code] || WHY_TEXT.unknown).short}${x.agent ? `(엣지 ${x.agent})` : ''} · 호스트 ${x.hosts}대${numOrNull(x.vms) > 0 ? ` · 못 읽은 VM ${x.vms}대` : ''}`,
    detail: missingText(x),
    title: (WHY_TEXT[x.code] || WHY_TEXT.unknown).fix,
  }));
}

/**
 * 할당 VM 한 줄 칩 — 앞에서부터 maxChars(칩 글자 합) 안에 들어가는 만큼만, 나머지는 '+N'.
 * 켜진 VM 을 먼저 보여 준다(꺼진 VM 은 뒤로).
 */
export function vmChips(names, { maxChips = 3, maxChars = 36 } = {}) {
  const list = (Array.isArray(names) ? names : []).map((x) => (typeof x === 'string' ? { name: x, on: true } : { name: String(x?.name ?? ''), on: x?.on ?? true }))
    .filter((x) => x.name);
  const ordered = [...list.filter((x) => x.on), ...list.filter((x) => !x.on)];
  const chips = []; let used = 0;
  for (const x of ordered) {
    if (chips.length >= maxChips) break;
    if (chips.length && used + x.name.length > maxChars) break;
    chips.push(x); used += x.name.length;
  }
  return { chips, more: list.length - chips.length };
}

/** 동작 막대 비율(%) — 켜진 GPU VM 기준. 판정 불가는 회색 빗금 칸. 합이 0 이면 null. */
export function activityBar(a) {
  if (!a) return null;
  const n = (k) => Math.max(0, numOrNull(a[k]) ?? 0);
  const total = n('busy') + n('held') + n('idle') + n('unknown');
  if (!total) return null;
  const pct = (k) => Math.round((n(k) / total) * 1000) / 10;
  return { busy: pct('busy'), held: pct('held'), idle: pct('idle'), unknown: pct('unknown'), total };
}

/** 출처 표기 — 'ESXi' / '게스트' / ''. */
export const srcText = (s) => (s === 'esxi' ? 'ESXi' : s === 'guest' ? '게스트' : '');
