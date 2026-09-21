/**
 * views/tools/curUserText.js — '현재 사용자'(v2.520) 화면 문구·판정 **순수 모듈**.
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트를 못 한다 — 그래서 판정·문구는
 * 여기 두고 vitest 로 회귀를 고정한다(`accessDeniedText.js`·`loadState.js`·`sanPerfDiagText.js`
 * 와 같은 관례).
 *
 * ★ 이 모듈이 지켜야 하는 정직성
 *  · **'수집 대기' 한 문구로 덮지 말 것**(v2.509 규칙). 값이 비는 이유는 행동이 정반대다 —
 *    꺼짐(켜면 된다) / 폴더 미지정(지정하면 된다) / 첫 주기(기다리면 된다) / 발행기 미설치
 *    (각 서버에 스크립트를 등록해야 한다 — **기다려도 안 된다**) / DB 불가(node:sqlite).
 *  · **`no-agent` 의 원인을 단정하지 말 것.** 게스트가 `info-set` 한 값이 **재부팅 전에도**
 *    vCenter `config.extraConfig` 에 나타나는지 우리는 실장비로 확인하지 못했다. 그래서
 *    "발행기 미설치 **또는** 이 환경이 게스트 발행값을 노출하지 않음" 두 가지를 함께 말한다.
 *  · **숫자를 문구에 박지 말 것** — 주기·신선도 기준은 API 가 주는 값(`intervalMs`·
 *    `guestPublishMs`·`staleAfterMs`)만 쓴다.
 *  · **이 값은 게스트가 스스로 쓴 것**이라 게스트 사용자가 위조할 수 있다 — 모니터링용이지
 *    감사 증적이 아니다. 화면이 그 사실을 적는다.
 */

import { agoText as _ago, elapsedText as _elapsed } from './relTime.js';

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 경과 시간 — '방금 · N분 전 · N시간 전 · N일 전'. 미래는 '곧'(시계 오차). */
/**
 * ⚠ v2.574 IMP-03 — 문구는 **공용 코어 `relTime.js`** 가 소유한다. 아래는 호출부 호환을 위한
 *   위임 껍데기다. v2.573 까지 9벌이 각자 구현이었고 **실제로 갈라져 있었다**
 *   (90초 → `2분 전` 7벌 vs `1분 전` 2벌 · 결측 `—` 6벌 / `null` 2벌 / `없음` 1벌).
 *   ⚠ 새 상대시각 문구를 만들지 말 것 — `agoText`(타임스탬프)·`elapsedText`(경과 ms) 를 쓴다.
 */
export const agoText = (ms) => _elapsed(ms, { subMinute: '방금', future: '미래(시계 오차)' });

/** 절대 시각 + 경과. `now` 를 주면 '(N분 전)' 이 붙는다. */
export function whenText(ts, now = null) {
  if (!ts || !Number.isFinite(Number(ts))) return '—';
  const d = new Date(Number(ts));
  const p = (x) => String(x).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return now ? `${s} (${agoText(now - Number(ts))})` : s;
}

/** 주기 문구 — 값이 없으면 '설정값' 이라 쓰고 숫자를 지어내지 않는다. */
export function intervalText(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '설정값';
  if (v < 60_000) return `${Math.round(v / 1000)}초`;
  if (v < 3_600_000) return `${Math.round(v / 60_000)}분`;
  return `${(v / 3_600_000).toFixed(v % 3_600_000 ? 1 : 0)}시간`;
}

/** 상태 코드 → 색. `ok` 만 초록이다(확인 불가를 정상색으로 칠하지 않는다 — v2.519 규칙). */
export function kindTone(kind) {
  switch (String(kind)) {
    case 'ok': return 'green';
    case 'stale': case 'incomplete': case 'clock-skew': return 'amber';
    case 'guest-error': case 'unparsed': case 'not-found': return 'red';
    case 'no-agent': return 'gray';
    default: return 'gray';
  }
}
export const TONE_COLOR = Object.freeze({ green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', gray: 'var(--text-faint)' });

export function kindLabelOf(kind, labels = {}) {
  return labels[String(kind)] || String(kind || '—');
}

/**
 * 상태 코드별 '무엇을 하면 되는가'. **행동이 다르면 문구도 다르다.**
 * `waiting:true` = 기다리면 해결된다. 아니면 사람이 조치해야 한다.
 */
export function kindAdvice(kind) {
  switch (String(kind)) {
    case 'ok': return { waiting: false, text: '' };
    case 'stale': return { waiting: false, text: '게스트 안의 발행 작업이 멈췄거나 VMware Tools 가 내려갔을 수 있습니다. 해당 서버에서 스케줄 작업(PortalCurrentUsers)이 도는지 확인하세요.' };
    case 'no-agent': return { waiting: false, text: '이 VM 에서 ‘guestinfo.curuser.*’ 값을 찾지 못했습니다. 발행기 스크립트가 아직 등록되지 않았거나, 이 환경이 게스트가 쓴 값을 vCenter 구성에 노출하지 않는 경우입니다 — **두 경우를 구분할 정보가 포탈에 없습니다.** 한 대에 먼저 등록해 값이 올라오는지 확인해 보세요.' };
    case 'guest-error': return { waiting: false, text: '게스트에서 ‘quser’ 를 실행하지 못했습니다(명령 부재·정책 차단). 아래 사유 원문을 확인하세요.' };
    case 'incomplete': return { waiting: true, text: '발행 도중에 읽은 것으로 보입니다 — 다음 주기에 정상화되는 것이 보통입니다.' };
    case 'unparsed': return { waiting: false, text: '값은 받았지만 ‘quser’ 출력 형식을 읽지 못했습니다. **사용자 0명이 아닙니다.** 원문을 보내주시면 파서를 고칩니다.' };
    case 'clock-skew': return { waiting: false, text: '게스트가 보고한 발행 시각이 미래입니다(게스트 시계 오차) — 신선도 판정을 신뢰할 수 없습니다. 게스트 시간 동기화를 확인하세요.' };
    case 'not-found': return { waiting: true, text: 'vCenter 응답에 그 VM 이 없었습니다(삭제·권한·조회 시점 차이). 다음 주기에 다시 확인합니다.' };
    default: return { waiting: false, text: '' };
  }
}

/**
 * 화면 상단 배너 — **한 번만** 길게 말한다(패널마다 긴 문장을 넣으면 화면이 같은 말로 덮인다,
 * v2.509 규칙). 반환 `{kind, tone, title, body, waiting}`.
 *
 * 판정 순서(행동이 급한 것부터): DB 불가 → 꺼짐 → 대상 없음 → 기록 없음(첫 주기) →
 * 전부 발행기 없음 → 일부 확인 불가 → 정상.
 */
export function collectStateNote(d, now = Date.now()) {
  const s = d?.settings || {};
  const kinds = d?.kinds || {};
  const recs = n0(d?.records?.length ?? Object.values(kinds).reduce((a, b) => a + n0(b), 0));
  const poller = d?.poller || {};
  if (d?.db && d.db.available === false) {
    return { kind: 'db-unavailable', tone: 'red', waiting: false, title: '사용자 이력을 저장할 수 없습니다', body: `이 포탈의 Node 런타임에서 내장 SQLite(node:sqlite)를 쓸 수 없습니다${d.db.error ? ` — ${d.db.error}` : ''}. 현재 값은 보이지만 추이는 쌓이지 않습니다.` };
  }
  if (s.enabled === false) {
    return { kind: 'disabled', tone: 'gray', waiting: false, title: '수집이 꺼져 있습니다', body: '설정에서 수집을 켜고 법인별로 대상 폴더를 지정하면 시작합니다. 기본이 꺼짐인 것은 의도된 동작입니다(운영 서버를 건드리는 기능이라 관리자가 명시적으로 켭니다).' };
  }
  if (n0(d?.targets) === 0) {
    return { kind: 'no-targets', tone: 'amber', waiting: false, title: '대상 VM 이 없습니다', body: '수집은 켜져 있지만 폴더가 지정되지 않았거나, 지정한 폴더에 전원이 켜진 Windows VM 이 없습니다. 폴더 범위가 비어 있으면 **전체 VM 으로 확대하지 않습니다**(의도된 동작).' };
  }
  if (!recs) {
    return { kind: 'first-cycle', tone: 'amber', waiting: true, title: '첫 수집을 기다리는 중입니다', body: `수집 주기는 ${intervalText(poller.intervalMs ?? s.intervalMs)}입니다. 지금 보고 싶으면 '지금 수집' 을 누르세요.` };
  }
  const noAgent = n0(kinds['no-agent']);
  if (noAgent >= recs) {
    return {
      kind: 'all-no-agent', tone: 'amber', waiting: false,
      title: `대상 ${recs}대 모두에서 발행 값을 찾지 못했습니다`,
      body: '각 Windows 서버에 발행기 스크립트를 등록해야 값이 올라옵니다(아래 안내). 또는 이 환경이 게스트가 쓴 ‘guestinfo.*’ 를 vCenter 구성에 노출하지 않는 경우일 수 있습니다 — **두 원인을 포탈이 구분할 수 없습니다.** 먼저 한 대에 등록해 값이 보이는지 확인하는 것이 가장 빠릅니다.',
    };
  }
  const unchecked = recs - n0(kinds.ok);
  if (unchecked > 0) {
    return {
      kind: 'partial', tone: 'amber', waiting: false,
      title: `확인한 ${n0(kinds.ok)}대는 정상 · ${unchecked}대는 확인하지 못했습니다`,
      body: '확인하지 못한 서버의 사용자는 **세지 않았습니다** — 지금 값이 맞는지 알 수 없기 때문입니다. 아래 표의 상태 열에서 사유를 확인하세요.',
    };
  }
  return { kind: 'ok', tone: 'green', waiting: false, title: `대상 ${recs}대를 모두 확인했습니다`, body: '' };
}

/**
 * 고유 사용자 수 설명 — 합집합과 법인별 합이 다른 것은 **정보**다(같은 계정이 여러 법인에 있음).
 * 사용자 규칙(2026-09-15): "aaa 라는 사용자가 1개의 vcenter 의 여러 서버에 로그인해 있으면 그건 1명".
 */
export function unionNote(total) {
  const u = n0(total?.usersUnion); const s = n0(total?.usersByVcSum);
  if (!u && !s) return '';
  if (u === s) return '같은 계정이 여러 법인에 걸쳐 있지는 않습니다(전체 = 법인별 합).';
  return `전체 고유 사용자 ${u}명 · 법인별 합계 ${s}명 — 차이 ${s - u}명은 **같은 계정이 여러 법인에 로그인**해 있어서입니다(전체는 중복을 한 번만 셉니다).`;
}

/**
 * 추이 시작점 안내 — `span.first` 는 '수집 시작' 이 아니라 **max(수집 시작, 보존 경계)** 다.
 * 두 원인을 구분할 정보가 서버에 없으므로 **단정하지 않는다**(`either`).
 */
export function sinceNote(span, retentionDays, now = Date.now()) {
  if (!span || !Number.isFinite(Number(span.first))) {
    return { kind: 'none', text: '아직 저장된 추이가 없습니다 — 첫 수집 이후부터 쌓입니다.' };
  }
  const first = Number(span.first);
  const days = Number(retentionDays) || 0;
  if (days > 0) {
    const edge = now - days * 86_400_000;
    if (Math.abs(first - edge) <= 86_400_000) {
      return { kind: 'either', text: `표시 시작 ${whenText(first)} — **수집 시작 시점이거나 보존 경계(${days}일)** 입니다. 보존 경계라면 더 긴 기간은 기다려도 채워지지 않습니다(보존일을 늘려야 합니다).` };
    }
  }
  return { kind: 'start', text: `표시 시작 ${whenText(first)} — 이 시점부터 저장돼 있습니다.` };
}

/**
 * 카드처럼 좁은 곳에 쓰는 **짧은** 사유 라벨.
 * ⚠ 스크린샷 판독으로 발견: 예전에는 KPI 카드에 코드(`not-windows`)가 그대로 찍혔다 —
 *   사용자는 그 코드를 모른다(수치만 보면 안 잡히는 종류의 결함).
 */
export const SHORT_SKIP = Object.freeze({
  'not-windows': 'Windows 아님',
  'powered-off': '전원 꺼짐',
  template: '템플릿',
  'no-tools': 'Tools 미실행',
  'over-limit': '상한 초과',
});
export const shortSkip = (reason) => SHORT_SKIP[String(reason)] || String(reason || '');

/** 대상 제외 사유 요약(‘사용자 0명’ 이 아니라 ‘대상 아님’ 임을 밝힌다). */
export function skippedSummary(skipped, reasons = {}) {
  const by = {};
  for (const s of skipped || []) by[s.reason] = (by[s.reason] || 0) + 1;
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => ({ reason, n, short: shortSkip(reason), text: reasons[reason] || reason }));
  return { total: (skipped || []).length, rows };
}

/** 발행기 배포 안내(화면이 그대로 보여 준다). `installCommand` 는 서버가 만든 것을 쓴다. */
export function agentGuide({ agentFile = 'curuser-agent.ps1', installCommand = '', guestPublishMs = 0 } = {}) {
  return [
    `1. 아래 '발행기 스크립트 내려받기' 로 \`${agentFile}\` 를 받아 Windows 서버에 둡니다(예: C:\\ProgramData\\Portal\\).`,
    `2. 관리자 PowerShell 에서 한 번 실행해 스케줄 작업을 등록합니다 — \`powershell -ExecutionPolicy Bypass -File .\\${agentFile} -Install\``,
    '   (또는 아래 schtasks 명령을 그대로 붙여넣습니다.)',
    `3. 발행 주기는 ${intervalText(guestPublishMs)}입니다. 포탈은 그 값을 vCenter 구성에서 읽기만 하므로 **게스트 계정도, 포탈로 나가는 방화벽 허용도 필요 없습니다.**`,
    installCommand ? `4. 등록 명령: ${installCommand}` : '',
  ].filter(Boolean);
}

/** 신뢰 고지 — 화면에 상시 노출한다(감사 증적으로 오해하지 않게). */
export const TRUST_NOTE = '이 수치는 **게스트가 스스로 보고한 값**입니다(VMware Tools 채널). 게스트에서 명령을 실행할 수 있는 사용자는 값을 바꿀 수 있으므로, 모니터링 용도이지 감사 증적이 아닙니다.';

/** '지금 수집' 응답 요약. */
export function collectSummary(r) {
  if (!r) return '';
  if (r.skipped) return r.reason || '이미 수집이 진행 중입니다.';
  if (r.ok === false && r.reason) return r.reason;
  const parts = [`대상 ${n0(r.targets)}대`, `읽음 ${n0(r.records)}건`];
  if (n0(r.users) || r.users === 0) parts.push(`고유 사용자 ${n0(r.users)}명`);
  if ((r.errors || []).length) parts.push(`실패 ${r.errors.length}곳`);
  if ((r.skippedVcenters || []).length) parts.push(`건너뜀 ${r.skippedVcenters.length}곳`);
  if (n0(r.overLimit)) parts.push(`상한 초과 ${n0(r.overLimit)}대 제외`);
  return parts.join(' · ');
}
