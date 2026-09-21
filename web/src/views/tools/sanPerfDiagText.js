/**
 * views/tools/sanPerfDiagText.js — '사용량 데이터가 없습니다' 의 **문구**(v2.517, 순수 모듈).
 *
 * 판정은 서버(`server/src/sanswitch/perfDiag.js`)가 `kind` 로 내려준다 — 판정 한 곳, 문구 한 곳
 * (`components/accessDeniedText.js`·`version_4/loadState.js` 와 같은 관례. 웹 테스트가 node 환경
 * 이라 컴포넌트 렌더 테스트가 불가하므로 문구는 여기서 회귀로 고정한다).
 *
 * ⚠ 핵심 규칙 — **'기다리면 되는지' 를 반드시 말한다**(v2.509 규칙과 같은 이유). v2.516 까지는
 *   원인이 무엇이든 "설정 › 수집 서버 › SAN 스위치 포트 사용량 에서 수집을 켜면 쌓기 시작합니다"
 *   한 문구였다. 그런데 REST 장비·제한 셸 계정은 **켜도 기다려도 영원히 안 쌓인다** — 그 상태에서
 *   '켜세요' 라고 말하면 사용자가 멀쩡한 설정을 의심하며 헤맨다.
 * ⚠ 수집 주기·상한 **숫자를 문구에 박지 말 것** — 서버가 주는 값(`facts.intervalMs`)만 쓰고
 *   없으면 '몇 분' 처럼 범위로 말한다(CLAUDE.md).
 */

import { agoText as _ago, elapsedText as _elapsed } from './relTime.js';

/** 상대 시각('3분 전'). 미래·비정상 값은 null 을 돌려 문구에서 빠진다(지어내지 않는다). */
/**
 * ⚠ v2.574 IMP-03 — 문구는 **공용 코어 `relTime.js`** 가 소유한다. 아래는 호출부 호환을 위한
 *   위임 껍데기다. v2.573 까지 9벌이 각자 구현이었고 **실제로 갈라져 있었다**
 *   (90초 → `2분 전` 7벌 vs `1분 전` 2벌 · 결측 `—` 6벌 / `null` 2벌 / `없음` 1벌).
 *   ⚠ 새 상대시각 문구를 만들지 말 것 — `agoText`(타임스탬프)·`elapsedText`(경과 ms) 를 쓴다.
 */
export const agoText = (ts, now = Date.now()) => _ago(ts, now, { dash: null, subMinute: '방금', future: 'null' });

/** 절대 시각(로컬). 없으면 null. */
export function whenText(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  try { return new Date(t).toLocaleString(); } catch { return null; }
}

/** 주기 문구 — 서버가 준 값만 쓴다. 없으면 '설정된 주기'(숫자를 지어내지 않는다). */
export function intervalText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '설정된 주기';
  if (n < 60_000) return `${Math.round(n / 1000)}초 주기`;
  return `${Math.round(n / 60_000)}분 주기`;
}

/**
 * 진단 문구.
 * @returns {{ title, body, waiting, tone, action, error }}
 *   tone: 'wait'(기다리면 됨) | 'fix'(조치 필요) | 'info'
 *   action: 사용자가 할 일 한 줄(없으면 null)
 *   error:  장비가 준 원문(있으면 화면이 <pre> 로 선택·복사 가능하게 보여준다)
 */
export function perfDiagText(diag, now = Date.now()) {
  if (!diag || !diag.kind) {
    return {
      title: '아직 수집된 사용량 데이터가 없습니다.',
      body: '원인을 판정할 정보를 받지 못했습니다(서버 버전이 낮을 수 있습니다).',
      waiting: false, tone: 'info', action: null, error: null,
    };
  }
  const f = diag.facts || {};
  const err = f.error || null;
  const errWhen = agoText(f.errorAt, now);
  const agent = f.agent || '엣지';
  const iv = intervalText(f.intervalMs);

  switch (diag.kind) {
    case 'db-unavailable':
      return {
        title: '이 서버는 사용량 이력을 저장할 수 없습니다.',
        body: '시계열 DB(node:sqlite)를 열 수 없어, 수집을 켜도 표본이 쌓이지 않습니다.',
        waiting: false, tone: 'fix', action: '서버 로그의 sanswitch-perf DB 오류를 확인하세요.', error: null,
      };
    case 'out-of-range': {
      const w = whenText(f.lastSampleAt);
      const a = agoText(f.lastSampleAt, now);
      return {
        title: '이 기간에는 표본이 없습니다 — 수집은 되고 있습니다.',
        body: `마지막 표본은 ${w || '확인된 시각'}${a ? ` (${a})` : ''} 입니다. 조회 기간을 넓히면 보입니다.`,
        waiting: false, tone: 'info', action: '위에서 더 긴 기간(7일·30일)을 눌러 보세요.', error: null,
      };
    }
    /*
     * ⚠⚠ **`out-of-range` 와 한 문구로 덮지 말 것**(v2.566). 사용자 현장은 마지막 표본이
     * **10일 전**인데 화면이 "수집은 되고 있습니다 · 기간을 넓히면 보입니다" 라고 말했다 —
     * 기간을 넓혀도 나오는 것은 **10일 전 값**이고 수집은 멈춰 있었다(엣지 중계가 죽어 있었다).
     * 조치가 정반대이므로(기간을 넓힌다 / 수집 경로를 고친다) 문장도 반대로 말한다.
     * ⚠ '예전 값은 더 긴 기간에서 보인다' 는 사실은 **지우지 말 것** — 그것도 참이다.
     */
    case 'stale': {
      const w = whenText(f.lastSampleAt);
      const a = agoText(f.lastSampleAt, now);
      return {
        title: '수집이 멈춘 것으로 보입니다 — 기간 문제가 아닙니다.',
        body: `마지막 표본이 ${w || '확인된 시각'}${a ? ` (${a})` : ''} 이고 그 뒤로 새 표본이 없습니다(${intervalText(f.intervalMs)} 기준). `
          + '더 긴 기간을 누르면 예전 값은 보이지만, 그 시점 이후로는 쌓이지 않았습니다.',
        waiting: false, tone: 'bad',
        action: f.agent
          ? `아래 수집 작업 로그에서 이 엣지(${f.agent})의 최근 결과를 확인하세요 — 엣지가 중앙으로 올리지 못하고 있을 수 있습니다.`
          : '아래 수집 작업 로그에서 이 스위치의 최근 실패 사유를 확인하세요.',
        error: null,
      };
    }
    case 'rest-method':
      return {
        title: 'REST 방식으로 수집하는 장비입니다 — 이 화면의 사용량은 쌓이지 않습니다.',
        body: '포트 사용량은 CLI 명령(portperfshow)으로만 수집합니다. REST 장비는 포트 통계 카운터의 차이로 처리량을 계산하므로, 설정을 켜도·기다려도 이 시계열은 채워지지 않습니다.',
        waiting: false, tone: 'info',
        action: '이 스위치의 처리량은 포트 목록 탭에서 보세요. 시계열이 필요하면 수집 방식을 SSH 로 등록해야 합니다.',
        error: null,
      };
    case 'edge-no-report':
      return {
        title: `엣지 '${agent}' 가 수집 상태를 보고하지 않았습니다.`,
        body: '이 스위치는 엣지가 현지에서 수집해 중앙으로 올립니다. 그런데 그 엣지에서 상태 보고가 한 번도 오지 않았습니다 — 엣지 포탈 버전이 낮거나, 엣지가 중앙 설정을 받아가지 못하는 상태입니다.',
        waiting: false, tone: 'fix',
        action: `엣지 '${agent}' 의 포탈 버전을 확인하고(상태 보고는 v2.517 부터), 설정 › 수집 서버에서 그 엣지의 마지막 연결 시각을 확인하세요.`,
        error: null,
      };
    case 'edge-disabled':
      return {
        title: `엣지 '${agent}' 에서 포트 사용량 수집이 꺼져 있습니다.`,
        body: '중앙 설정은 설정 pull 로 엣지에 내려갑니다. 엣지가 아직 그 값을 받지 못했거나, 그 엣지가 현장 설정(SANSW_PERF_LOCAL=1)으로 중앙 값을 무시하고 있습니다.',
        waiting: false, tone: 'fix',
        action: '설정 › 수집 서버 › SAN 스위치 포트 사용량 에서 수집을 켜고, 엣지의 다음 설정 pull(몇 분)을 기다리세요. 그래도 꺼짐이면 그 엣지의 portal.env 에서 SANSW_PERF_LOCAL 을 확인하세요.',
        error: null,
      };
    case 'edge-device-failed':
      return {
        title: `엣지 '${agent}' 가 이 스위치에서 수집에 실패했습니다${errWhen ? ` (${errWhen})` : ''}.`,
        body: '설정은 켜져 있고 엣지도 돌았지만 이 장비에서 실패했습니다 — 기다려도 채워지지 않습니다. 아래 원문이 그 사유입니다.',
        waiting: false, tone: 'fix',
        action: '사유가 명령 부재(command not found)면 그 계정·펌웨어가 portperfshow 를 제공하지 않는 것입니다. 권한이 있는 계정으로 바꾸거나, 이 스위치는 사용량 수집 대상에서 빼세요.',
        error: err,
      };
    case 'edge-first-cycle':
      return {
        title: `엣지 '${agent}' 가 수집을 시작했고 첫 결과를 기다리는 중입니다.`,
        body: `설정은 켜져 있습니다(${iv}). 첫 표본이 중앙에 반영되면 여기에 채워집니다.`,
        waiting: true, tone: 'wait', action: null, error: null,
      };
    /*
     * ⚠ '기다리면 온다' 가 아니다 — 엣지가 **올리지 못하고 있다**고 스스로 보고했다(v2.566).
     * 이 통로가 없어서 v2.427 의 중계 정지가 10일 동안 중앙에 전달되지 않았다.
     */
    case 'edge-push-failed': {
      const a = agoText(f.edgeAt, now);
      return {
        title: '엣지가 수집은 했지만 중앙으로 올리지 못하고 있습니다.',
        body: `엣지(${f.agent || '이 법인'})는 ${a ? `${a}에 ` : ''}수집을 마쳤는데 중계가 실패하고 있습니다. `
          + '기다려도 채워지지 않습니다 — 엣지 포탈을 확인해야 합니다.',
        waiting: false, tone: 'bad',
        action: '엣지 로그에서 sanswitch-perf-push 줄을 확인하고, 엣지가 최신 버전인지 보세요.',
        error: f.error || f.edgePushError || null,
      };
    }
    case 'edge-pending-push': {
      const a = agoText(f.edgeAt, now);
      return {
        title: '엣지가 수집했고 중앙 반영을 기다리는 중입니다.',
        body: `엣지 '${agent}' 의 마지막 수집은 ${a || '최근'} 입니다(${iv}). 엣지는 수집 직후 중앙으로 올리므로 잠시 뒤 채워집니다.`,
        waiting: true, tone: 'wait', action: null, error: null,
      };
    }
    case 'disabled':
      return {
        title: '포트 사용량 수집이 꺼져 있습니다.',
        body: '기본은 꺼짐입니다 — 운영 스위치에 주기 접속을 임의로 만들지 않기 위해서입니다. 켜면 portperfshow 를 주기적으로 실행해 쌓기 시작합니다.',
        waiting: false, tone: 'fix',
        action: '설정 › 수집 서버 › SAN 스위치 포트 사용량 에서 수집을 켜세요.', error: null,
      };
    case 'device-failed':
      return {
        title: `이 스위치에서 사용량 수집이 실패했습니다${errWhen ? ` (${errWhen})` : ''}.`,
        body: '설정은 켜져 있고 수집도 돌았지만 이 장비에서 실패했습니다 — 기다려도 채워지지 않습니다. 아래 원문이 그 사유입니다.',
        waiting: false, tone: 'fix',
        action: '사유가 명령 부재(command not found)면 그 계정·펌웨어가 portperfshow 를 제공하지 않는 것입니다. 권한이 있는 계정으로 바꾸거나, 이 스위치는 사용량 수집 대상에서 빼세요.',
        error: err,
      };
    case 'first-cycle':
      return {
        title: '수집이 켜졌고 첫 주기를 기다리는 중입니다.',
        body: `설정은 켜져 있습니다(${iv}). 첫 표본이 들어오면 여기에 채워집니다.`,
        waiting: true, tone: 'wait', action: null, error: null,
      };
    case 'collected-empty':
    default:
      return {
        title: '수집은 돌았지만 이 스위치의 표본이 없습니다.',
        body: '설정은 켜져 있고 실패 기록도 없습니다 — 원인을 특정할 수 없습니다(아래 수집 작업 로그에서 이 스위치의 최근 결과를 확인하세요).',
        waiting: false, tone: 'info',
        action: "'지금 수집' 을 눌러 한 번 시험해 보고, 작업 로그의 결과를 확인하세요.", error: null,
      };
  }
}

/** 배너 색 — tone 을 CSS 변수로. 'fix' 만 경고색을 쓴다(정상 대기를 장애로 보이게 하지 않는다). */
export function diagBorder(tone) {
  if (tone === 'fix') return 'var(--amber)';
  return undefined;
}

/**
 * 엣지별 수집 상태 한 줄(설정 화면 표). `enabled` 를 모르는 경우(보고 없음)를 '꺼짐' 이라 말하지
 * 않는다 — '모른다' 와 '꺼짐' 은 다르다(v2.493 규칙).
 */
export function edgePerfLine(e, now = Date.now()) {
  if (!e) return '보고 없음';
  const parts = [e.enabled === true ? '수집 켜짐' : '수집 꺼짐'];
  const a = agoText(e.at, now);
  parts.push(a ? `마지막 수집 ${a}` : '수집 기록 없음');
  const p = agoText(e.pushAt ?? e.receivedAt, now);
  if (p) parts.push(`보고 ${p}`);
  const failed = Number(e.failed);
  if (Number.isFinite(failed) && failed > 0) parts.push(`실패 ${failed}대`);
  if (e.version) parts.push(`v${e.version}`);
  return parts.join(' · ');
}

/** '지금 수집' 응답 문구 — 즉시/요청을 뭉치지 않는다(v2.516 규약). */
export function perfCollectSummary(r) {
  if (!r) return '';
  if (r.ok === false) return `수집 실패: ${r.reason || '알 수 없는 오류'}`;
  const res = r.result || {};
  const bits = [];
  if (res.ok === false) bits.push(`중앙 직접: 건너뜀(${res.reason || '이유 미상'})`);
  else bits.push(`중앙 직접 ${res.collected ?? 0}대 수집${res.failed ? ` · 실패 ${res.failed}대` : ''}`);
  const req = (r.requested || []).length;
  const dup = (r.alreadyQueued || []).length;
  if (req) bits.push(`엣지 ${req}곳에 재수집 요청`);
  if (dup) bits.push(`엣지 ${dup}곳은 이미 요청 대기 중`);
  return `수집 결과: ${bits.join(' · ')}`;
}
