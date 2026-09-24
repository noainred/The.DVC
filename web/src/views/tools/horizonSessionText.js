/**
 * views/tools/horizonSessionText.js — Horizon 실시간 사용자 화면의 **판정·문구**(v2.525, 순수 모듈).
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다 — 그래서 판정·문구는
 * 여기서 회귀로 고정한다(`accessDeniedText.js`·`version_4/loadState.js`·`sanPerfDiagText.js` 와 같은 관례).
 *
 * ── 이 모듈이 지켜야 하는 정직성 규칙 ───────────────────────────────────────────
 * 1. **'실시간 사용자' 는 접속 중(CONNECTED) 세션의 고유 계정이다.** 상태를 읽지 못한 서버가
 *    있으면(`stateBlind`) 그 수를 말하지 않는다 — '—' 로 두고 이유를 적는다.
 * 2. **비어 있는 이유를 한 문구로 덮지 않는다**(v2.517 규약): 꺼짐 / 첫 주기 / 등록 0 / DB 불가 /
 *    인증 거부 / 경로 없음(404) / 형식 미인식 / 시한 초과 — **조치가 다르므로 문구가 다르다.**
 * 3. **주기·상한 숫자를 문구에 박지 말 것** — 서버가 주는 값(`intervalMs` 등)만 쓴다.
 * 4. **상한으로 자른 것은 개수를 밝힌다.**
 */

import { agoText as _ago, elapsedText as _elapsed } from './relTime.js';

/** 서버별 상태 배지 색조. `unparsed`·`no-endpoint` 는 '실패' 가 아니라 '확인 불가' 계열이다. */
export const KIND_TONE = Object.freeze({
  ok: 'green',
  mock: 'gray',
  disabled: 'gray',
  unparsed: 'amber',
  'no-endpoint': 'amber',
  auth: 'red',
  'auth-stopped': 'red',
  http: 'red',
  timeout: 'amber',
  error: 'red',
});

export const kindTone = (k) => KIND_TONE[String(k)] || 'gray';

/** 서버별 '무엇을 하면 되는가'. 원인마다 조치가 다르다 — 합치지 말 것. */
export const KIND_ADVICE = Object.freeze({
  ok: '',
  mock: '데모(mock) 모드입니다 — 실제 Horizon 에 접속하지 않습니다.',
  disabled: '이 서버는 수집 대상에서 꺼져 있습니다(설정에서 켜세요).',
  auth: '계정·도메인·권한을 확인하세요. Horizon REST 세션 조회에는 세션을 볼 수 있는 역할이 필요합니다. 비밀번호를 반복 시도하면 AD 계정이 잠길 수 있어 포탈은 자동 재시도하지 않습니다.',
  'auth-stopped': '인증 실패가 이어져 **주기 수집을 멈췄습니다** — 같은 자격증명으로 계속 로그인하면 AD 계정이 잠깁니다. 설정 › Horizon 등록에서 비밀번호를 고치면 **자동으로 재개**합니다. ‘지금 수집’ 버튼은 막히지 않으니 고친 뒤 눌러 확인하세요.',
  'no-endpoint': '이 Horizon 버전이 세션 목록 경로를 노출하지 않습니다(404). Connection Server 버전을 확인하세요 — 포탈이 쓰는 경로는 화면 아래 **조회 경로**에 적혀 있습니다.',
  unparsed: '응답을 받았지만 계정 필드를 알아보지 못했습니다. 상세의 **응답 필드** 목록을 개발자에게 알려주면 필드 이름을 맞출 수 있습니다.',
  timeout: '시한 내에 응답이 없었습니다. 고지연 회선이면 설정에서 시한을 늘리세요.',
  http: '조회가 HTTP 오류로 끝났습니다 — 아래 원문 사유를 확인하세요.',
  error: '조회 중 오류가 발생했습니다 — 아래 원문 사유를 확인하세요.',
});

export const kindAdvice = (k) => KIND_ADVICE[String(k)] ?? '';

const m = (ms) => Math.max(1, Math.round(Number(ms) / 60_000));

/** 주기 문구 — **서버가 준 값만** 쓴다(숫자 하드코딩 금지). */
export function intervalText(intervalMs) {
  if (!Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0) return '주기를 알 수 없습니다';
  return `${m(intervalMs)}분 주기`;
}

/**
 * ⚠ v2.574 IMP-03 — 문구는 **공용 코어 `relTime.js`** 가 소유한다. 아래는 호출부 호환을 위한
 *   위임 껍데기다. v2.573 까지 9벌이 각자 구현이었고 **실제로 갈라져 있었다**
 *   (90초 → `2분 전` 7벌 vs `1분 전` 2벌 · 결측 `—` 6벌 / `null` 2벌 / `없음` 1벌).
 *   ⚠ 새 상대시각 문구를 만들지 말 것 — `agoText`(타임스탬프)·`elapsedText`(경과 ms) 를 쓴다.
 */
export const agoText = (ts, now = Date.now()) => _ago(ts, now, { subMinute: 'seconds' });

/**
 * 인증 실패로 **주기 수집을 멈춘** 상태의 사실 관계(v2.535).
 *
 * 왜 따로 있나: 조치 문구(`KIND_ADVICE['auth-stopped']`)는 '무엇을 하라' 만 말한다.
 * CLAUDE.md v2.528 규약은 **정지 사실·시점·시도 횟수**를 화면이 말하도록 요구한다 —
 * '언제부터 안 받고 있었나' 를 모르면 사용자가 그동안의 수치를 현재값으로 읽는다.
 * (v2.535 에 Chromium 스크린샷을 읽고 발견해 추가했다 — 배지·문구만으로는 빠진 것이 안 보였다.)
 *
 * @param {null|object} stop `authStopped` = `{since, at, attempts, reason}`
 * @returns {null | {text:string, since:string, last:string, attempts:number|null, reason:string}}
 */
export function authStopNote(stop, now = Date.now()) {
  if (!stop || typeof stop !== 'object') return null;
  const since = agoText(stop.since, now);
  const last = agoText(stop.at, now);
  // ⚠ `Number(null) === 0` — `== null` 을 먼저 본다(v2.525 규약). 0 회는 '없다' 가 아니다.
  const attempts = stop.attempts == null || !Number.isFinite(Number(stop.attempts)) ? null : Number(stop.attempts);
  const reason = String(stop.reason || '').trim();
  const bits = [`${since}부터 정지`];
  if (attempts != null) bits.push(`실패 ${attempts}회`);
  if (last !== '—') bits.push(`마지막 시도 ${last}`);
  if (reason) bits.push(`사유: ${reason}`);
  return { text: bits.join(' · '), since, last, attempts, reason };
}

/**
 * 화면 상단 배너 — **비어 있는 이유를 판정한다**.
 *
 * @returns {{kind:string, tone:'info'|'warn'|'error'|'none', waiting:boolean, text:string, short:string}}
 *   `waiting` 은 '기다리면 채워지는가' 다 — **대충 true 로 두지 말 것**(화면이 "기다리세요" 라고
 *   말해 놓고 영원히 안 채워진다. v2.517 에서 확정된 유형).
 */
export function collectStateNote(d) {
  const s = d?.settings || {};
  const iv = intervalText(s.intervalMs);
  if (d?.db && d.db.available === false) {
    return { kind: 'db', tone: 'error', waiting: false,
      text: `추이 DB 를 쓸 수 없어 수집이 멈춰 있습니다 — ${d.db.error || 'node:sqlite 를 쓸 수 없습니다'}.`,
      short: 'DB 사용 불가' };
  }
  if (d?.mock) {
    return { kind: 'mock', tone: 'info', waiting: false,
      text: '데모(mock) 모드입니다 — 실제 Horizon 에 접속하지 않으며 없는 세션을 지어내지도 않습니다.',
      short: '데모 모드' };
  }
  if (!Number(d?.registered)) {
    return { kind: 'no-server', tone: 'warn', waiting: false,
      text: 'Horizon Connection Server 가 등록되어 있지 않습니다 — 설정 › Horizon 등록에서 추가하세요(CSV·자유텍스트로 한꺼번에 등록할 수도 있습니다).',
      short: '등록된 서버 없음' };
  }
  if (!s.enabled) {
    return { kind: 'off', tone: 'warn', waiting: false,
      text: `실시간 사용자 수집이 꺼져 있습니다 — 설정에서 켜면 ${iv}로 수집을 시작합니다. 켜기 전에는 값이 채워지지 않습니다.`,
      short: '수집 꺼짐' };
  }
  if (!Number(d?.targets)) {
    return { kind: 'no-target', tone: 'warn', waiting: false,
      text: '수집이 켜져 있지만 대상 서버가 없습니다 — 설정에서 서버를 하나 이상 켜세요.',
      short: '대상 서버 없음' };
  }
  if (!d?.lastReadAt) {
    return { kind: 'first', tone: 'info', waiting: true,
      text: `첫 수집을 기다리고 있습니다(${iv}). 잠시 뒤 값이 채워집니다 — 지금 바로 보려면 '지금 수집' 을 누르세요.`,
      short: '첫 수집 대기' };
  }
  const failed = Number(d?.total?.serversFailed) || 0;
  if (failed > 0 && !Number(d?.total?.serversOk)) {
    return { kind: 'all-failed', tone: 'error', waiting: false,
      text: `등록된 ${failed}대 모두에서 세션을 읽지 못했습니다 — 아래 서버 표의 사유와 조치를 확인하세요. 이 값은 '사용자 0명' 이 아니라 '확인 불가' 입니다.`,
      short: '전 서버 조회 실패' };
  }
  if (failed > 0) {
    return { kind: 'partial', tone: 'warn', waiting: false,
      text: `${failed}대에서 세션을 읽지 못했습니다 — 아래 수치는 읽어낸 서버만 합친 값이라 **하한**입니다(실제 사용자는 이보다 많을 수 있습니다).`,
      short: `${failed}대 조회 실패` };
  }
  // v2.606 COL2606-04: 한 서버라도 페이지 상한에 걸려 **일부 세션만** 읽었으면 합계는 하한이다(추이에는 적재하지 않는다).
  if (Number(d?.total?.serversTruncated) > 0) {
    return { kind: 'truncated', tone: 'warn', waiting: false,
      text: `${Number(d.total.serversTruncated)}대에서 페이지 상한에 걸려 세션을 **일부만** 읽었습니다 — 아래 수치는 **최소값**이고 이 주기는 추이에 적재하지 않았습니다(설정에서 페이지 상한을 올리세요).`,
      short: '일부만 읽음(최소값)' };
  }
  if (d?.total?.stateBlind) {
    return { kind: 'state-blind', tone: 'warn', waiting: false,
      text: '세션 상태(접속 중/연결 끊김) 필드를 알아보지 못해 **접속 중 인원을 셀 수 없습니다** — 전체 세션 수와 고유 계정 수만 표시합니다.',
      short: '상태 확인 불가' };
  }
  return { kind: 'ok', tone: 'none', waiting: false, text: '', short: '' };
}

/**
 * v2.606 COL2606-04·WEB2606-09: 값 앞에 붙일 '최소 ' — 합계(total) 또는 서버 한 대(record)가 하한이면.
 * field: 'connected'(접속 중 — 세션 절단·상태 미확인 세션도 하한 사유) | 'users'(고유 사용자) | 'sessions'.
 */
export function lowerBoundPrefix(t, field = 'users') {
  if (!t) return '';
  const cut = !!(t.truncated || t.sessionsLowerBound);
  if (field === 'sessions') return cut ? '최소 ' : '';
  if (field === 'connected') {
    if (t.usersConnected == null) return '';
    return (t.usersLowerBound || t.connectedLowerBound || cut || Number(t.stateUnknown) > 0) ? '최소 ' : '';
  }
  if (t.users == null) return '';
  return (t.usersLowerBound || cut) ? '최소 ' : '';
}

/** 상태를 못 읽은 세션이 있으면 한 줄로 밝힌다(없으면 ''). 접속 중 수는 그만큼 모자랄 수 있다. */
export function stateUnknownNote(t) {
  const n = Number(t?.stateUnknown);
  if (t?.stateUnknown == null || t?.stateUnknown === '' || !Number.isFinite(n) || n <= 0) return '';
  return `상태 미확인 ${n}세션 — 접속 중 수는 최소값입니다`;
}

/** 접속 중 사용자 수 — 못 셀 때 0 을 쓰지 않는다(규칙 1). */
export function connectedText(total) {
  if (!total) return '—';
  if (total.usersConnected == null) return '—';
  return String(total.usersConnected);
}

/** '합집합 vs 단순 합' 전제를 화면이 밝힌다 — 하나만 보여주면 그 전제가 감춰진다. */
export function unionNote(total) {
  // ⚠ `Number(null) === 0` 이다 — null 을 그대로 통과시키면 수치를 **모를 때** 두 값이 0===0 이 되어
  //   "겹치는 계정이 없습니다" 라고 단정한다(전 서버 조회 실패 시 실제로 그랬다. 이 파일의
  //   자체 테스트가 잡은 결함). 모르면 아무 말도 하지 않는다.
  const num = (v) => (v == null || v === '' ? NaN : Number(v));
  const u = num(total?.users);
  const sum = num(total?.usersByServerSum);
  if (!Number.isFinite(u) || !Number.isFinite(sum)) return '';
  // 사용자가 0명이면 '겹치는 계정이 없습니다' 는 **공허한 단정**이다(서버가 0대일 때 실제로 그렇게
  // 나왔다 — v2.525 Chromium 판독). 말할 것이 없으면 말하지 않는다.
  if (u === 0) return '';
  // v2.590 F8: 한 서버라도 이름 목록이 상한으로 잘렸으면 합집합은 **하한값**이다 — 정확한 인원이라 말하지 않는다.
  // v2.606 COL2606-04: 세션 자체를 일부만 읽은 경우(이름 목록 절단 아님)는 원인이 다르다 — 따로 말한다.
  if (total?.usersLowerBound && !(Number(total.usersOmitted) > 0)) return `일부 서버에서 세션을 페이지 상한까지만 읽어 전체 고유 계정은 **최소 ${u}명**입니다.`;
  if (total?.usersLowerBound) return `서버별 이름 목록이 상한으로 잘려(${Number(total.usersOmitted) || 0}명 생략) 전체 고유 계정은 **최소 ${u}명**입니다 — 정확한 합집합은 계산하지 못했습니다(서버별 고유의 합 ${sum}명이 상한).`;
  if (sum === u) return '서버가 1대이거나 서버 간에 겹치는 계정이 없습니다.';
  return `고유 계정 **${u}명**(합집합)인데 서버별 고유의 합은 **${sum}명** 입니다 — 차이 ${sum - u}명은 **여러 Connection Server 에 동시에 붙은 계정**입니다(같은 계정이면 1명으로 셉니다).`;
}

/** 두 출처 합집합(전체 탭) 문구. */
export function combinedNote(c) {
  // v2.598: 읽은 출처가 없으면 합집합은 null 이다 — '**null명**' 이나 '0명' 을 말하지 않는다.
  if (!c || c.union == null) return '';
  const parts = [`전체 고유 사용자 **${c.union}명** = Windows 서버 ∪ Horizon(VDI)`];
  if (c.both > 0) parts.push(`양쪽에 동시에 있는 사람 **${c.both}명**(단순 합 ${c.sum}명에서 중복을 뺐습니다)`);
  else if (c.sum !== c.union) parts.push(`단순 합 ${c.sum}명`);
  if (c.sidOnly > 0) parts.push(`⚠ SID 로만 식별된 계정 ${c.sidOnly}건은 이름이 없어 Windows 쪽과 **절대 겹치지 않습니다** — 실제로는 같은 사람일 수 있습니다`);
  return parts.join(' · ');
}

/** 한 출처를 읽지 못했을 때 — '전체' 라고 단정하지 않게 한다(규칙 2). */
export const SOURCE_STATE_LABEL = Object.freeze({
  ok: '읽었습니다', off: '수집 꺼짐', failed: '읽지 못했습니다', unavailable: '사용할 수 없습니다',
});

export function partialNote(c) {
  if (!c?.partial) return '';
  const names = (c.missingSources || []).map((s) => `${s.label}(${SOURCE_STATE_LABEL[s.state] || s.state})`).join(' · ');
  return `⚠ 이 수는 **전체가 아닙니다** — ${names}. 빠진 출처가 있으므로 실제 사용자는 이보다 많을 수 있습니다.`;
}

/** 서버 행의 '무엇으로 읽었는가' — 필드명을 확인하지 못한 채로 만든 기능이라 근거를 표시한다. */
export function provenanceText(r) {
  if (!r?.ok) return '';
  const bits = [];
  // 백틱은 BoldText 가 해석하지 않아 화면에 그대로 샌다(v2.525 Chromium 판독) — 쓰지 않는다.
  if (r.usedUserKey) bits.push(`계정 필드 ${r.usedUserKey}${r.userIdOnly ? '(이름이 없어 SID 로 셉니다 — 이름은 표시할 수 없습니다)' : ''}`);
  if (r.usedStateKey) bits.push(`상태 필드 ${r.usedStateKey}`);
  else bits.push('상태 필드 **없음**(접속 중/연결 끊김을 구분할 수 없습니다)');
  if (r.pages) bits.push(`${r.pages}페이지 조회`);
  if (r.truncated) bits.push('⚠ 페이지 상한에 걸려 **일부만** 읽었습니다(설정에서 상한을 올리세요)');
  if (r.usersOmitted > 0) bits.push(`계정 목록 상한으로 ${r.usersOmitted}명은 목록에서 생략(수치에는 포함)`);
  if (r.poolsOmitted > 0) bits.push(`풀 목록 상한으로 ${r.poolsOmitted}개 생략`);
  return bits.join(' · ');
}

/** 추이 시작 시각 각주 — '수집 시작' 이라 단정하지 않는다(보존 경계일 수 있다). */
export function sinceNote({ span, retentionDays, now = Date.now() } = {}) {
  if (!span?.first) return { kind: 'none', text: '아직 저장된 추이가 없습니다.' };
  const days = Number(retentionDays) || 0;
  const edge = days > 0 ? now - days * 86_400_000 : null;
  const nearEdge = edge != null && Math.abs(Number(span.first) - edge) < 86_400_000;
  const when = new Date(Number(span.first)).toLocaleString('ko-KR');
  if (nearEdge) {
    return { kind: 'either', text: `${when} 부터의 자료입니다 — **수집 시작 시점이거나 보존 경계(${days}일)** 입니다. 보존 경계라면 더 긴 기간은 기다려도 채워지지 않습니다(보존일을 늘리세요).` };
  }
  return { kind: 'start', text: `${when} 부터 저장돼 있습니다(보존 ${days || '무제한'}일).` };
}

/** 계정명 가림 정책 문구 — 사용자 선택: 목록은 가리고 상세에서 본다. */
export const NAME_MASK_NOTE = '계정명은 개인정보라 목록에서는 가립니다 — 행을 눌러 상세에서 확인하세요(설정에서 항상 표시로 바꿀 수 있습니다).';

/** 값이 게스트/장비가 준 것임을 밝히는 신뢰 고지 — 지우지 말 것. */
export const TRUST_NOTE = 'Horizon Connection Server 가 보고한 세션 목록을 그대로 집계한 값입니다 — 포탈이 세션을 만들거나 바꾸지 않습니다. 세션은 로그오프 뒤에도 잠시 남을 수 있어 실제 사용 인원과 몇 분 차이가 날 수 있습니다.';

/** 조회 경로 표시 — 404('이 버전에 없는 경로') 를 사용자가 확인할 수 있게. */
export const SESSION_PATH_NOTE = '조회 경로: GET /rest/inventory/v1/sessions (page·size 페이징). 이 경로가 404 면 Connection Server 버전이 노출하지 않는 것입니다.';
