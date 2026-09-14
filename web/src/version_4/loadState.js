/**
 * loadState.js — V4 화면이 '비어 있는 이유' 를 정직하게 말하게 하는 판정(v2.509, 순수 모듈).
 *
 * 배경(2026-09-14 사용자 질문): 운영 포탈이 v2.508.0 으로 업그레이드돼 재시작된 직후, 전사 현황의
 * KPI 6장이 전부 '수집 대기' · 패널이 전부 '불러오는 중…' 으로 남았다. 사용자가 물었다 —
 * **"기다리면 나오는거야?"** 화면이 그 답을 갖고 있지 않았다는 것이 결함이다.
 *
 * `수집 대기` 라는 한 문구가 **행동이 완전히 다른 상황들**을 덮고 있었다:
 *   · 기동 직후 첫 수집 진행 중      → 기다리면 채워진다(새로고침 불필요)
 *   · vCenter 연결 실패              → **기다려도 채워지지 않는다**(설정에서 조치해야 한다)
 *   · 서버 응답 지연/타임아웃        → 재시도 중. 원인은 알 수 없다
 *   · 등록된 vCenter 가 0개          → 등록부터 해야 한다
 * 이건 CLAUDE.md '값이 없는 이유를 단정하지 말 것'(v2.493, sensorText.js) 과 같은 계열이다.
 *
 * 서버는 이미 필요한 것을 다 내려준다 — `/health` 의 `vcentersPending`(첫 수집 전/수집 중) ·
 * `vcentersUnreachable`(연결 실패) · `vcentersMaintenance` · `uptimeSec` · `generatedAt`
 * (`routes/api/overviewNsx.js`). 그 응답의 주석이 직접 "'pending' 을 'unreachable' 과 구분해
 * 헤더가 잘못 표시하지 않게" 라고 적고 있는데, V4 가 그 필드를 쓰지 않고 있었다.
 *
 * 판정·문구를 컴포넌트 밖 순수 함수로 두는 이유: 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트
 * 렌더 테스트가 불가하다(이 저장소 관례 — accessDeniedText.js · sensorText.js).
 *
 * ⚠ 수집 주기·동시성·데드라인 같은 **숫자를 문구에 박지 않는다**(CLAUDE.md). `/health` 가 주는
 *   값만 쓰고, 서버가 주지 않는 것은 '몇 분' 처럼 범위로만 말한다.
 */

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * 타임아웃/중단 계열 오류인가 — 브라우저·폴리필이 문구를 제각각 쓰므로 넓게 본다.
 * 실제 문구 예: Chrome `signal timed out` · `AbortError: The operation was aborted` ·
 * 폴백 폴리필(api.js timeoutSignal) `TimeoutError: timeout` · Firefox `The operation was aborted.`
 * 'timeout' 만 보면 Chrome 의 **'timed out'** 을 놓친다(이 테스트에서 실제로 걸렸다).
 */
export function isTimeoutError(message) {
  return /time(?:d\s*)?out|TimeoutError|AbortError|abort(?:ed)?/i.test(String(message || ''));
}

/**
 * 서버에 **닿지 못한** 오류인가 — 타임아웃이 아니라 네트워크 단절이다.
 * 브라우저 문구: Chrome `Failed to fetch` · Firefox `NetworkError when attempting to fetch` ·
 * Safari `Load failed`. `api.js:141` 의 `isTransientFront` 와 같은 계열을 본다.
 * 사용자 입장에서 타임아웃과 함께 '재시도 중' 으로 묶되, **문구는 구분한다**(원인이 다르다).
 */
export function isNetworkError(message) {
  return /failed to fetch|networkerror|load failed|ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|network error/i
    .test(String(message || ''));
}

/**
 * 지금 화면이 비어 있는 이유. **확인된 것만** 돌려주고 모르면 'error' 로 떨어뜨린다.
 *
 *   ready         데이터가 있다(호출자가 보통 먼저 걸러낸다)
 *   no-health     포탈 서버 자체가 응답하지 않는다
 *   empty         등록된 vCenter 가 0개다
 *   first-collect 첫 수집이 진행 중이다 — 기다리면 채워진다
 *   unreachable   연결 실패한 vCenter 가 있고 대기 중인 것은 없다 — 기다려도 안 채워진다
 *   retrying      서버 응답 시한 초과 또는 연결 실패 — 자동 재시도 중(장애로 단정하지 않는다)
 *   error         그 밖의 오류 — 원인을 지어내지 않는다
 */
export function loadPhase({ health, healthError, poll } = {}) {
  if (poll?.data) return 'ready';
  if (!health) return healthError ? 'no-health' : 'loading';

  const total = num(health.vcenters);
  if (total === 0) return 'empty';

  const pending = num(health.vcentersPending) || 0;
  const unreachable = num(health.vcentersUnreachable) || 0;

  // 대기 중인 vCenter 가 하나라도 있으면 '수집이 아직 돌고 있다' 는 뜻이다 — 서버가 pending 과
  // unreachable 을 따로 세어 주므로 둘을 섞지 않는다(섞으면 '기다리면 됨' 과 '조치 필요' 가 뭉개진다).
  if (pending > 0) return 'first-collect';
  // 타임아웃·네트워크 단절은 **장애가 아니라 재시도 중**이다 — 화면 전체를 오류로 갈아치우지 않는다.
  if (poll?.error) return (isTimeoutError(poll.error) || isNetworkError(poll.error)) ? 'retrying' : 'error';
  if (unreachable > 0) return 'unreachable';
  // 스냅샷이 아직 만들어지지 않았다(generatedAt 없음)면 수집 중으로 본다.
  if (!health.generatedAt) return 'first-collect';
  return 'error';
}

/**
 * 수집 진행 상황. 서버가 상태별 개수를 주므로 계산할 수 있다.
 * 값이 부족하면 null — 없는 진행률을 만들지 않는다(가짜 막대 금지).
 */
export function collectProgress(health) {
  const total = num(health?.vcenters);
  if (!total) return null;
  const connected = num(health?.vcentersConnected) || 0;
  const pending = num(health?.vcentersPending) || 0;
  const unreachable = num(health?.vcentersUnreachable) || 0;
  const maintenance = num(health?.vcentersMaintenance) || 0;
  const done = Math.max(0, total - pending);
  return {
    total, connected, pending, unreachable, maintenance, done,
    pct: Math.round((done / total) * 100),
  };
}

/**
 * 화면 문구. `short` 는 KPI 메타처럼 한 줄이 짧아야 하는 자리, `long` 은 패널·배너용.
 * `waiting` 은 **기다리면 되는가** — 이 값이 사용자가 실제로 알고 싶은 것이다.
 */
export function loadText(phase, { health, pollError } = {}) {
  const p = collectProgress(health);
  switch (phase) {
    case 'loading':
      return { short: '불러오는 중…', long: '불러오는 중…', waiting: true };
    case 'no-health':
      return {
        short: '서버 응답 없음',
        long: '포탈 서버가 응답하지 않습니다. 업그레이드 직후라면 재시작이 끝날 때까지 잠시 이 상태일 수 있습니다.',
        waiting: null, // 재시작 중인지 장애인지 여기서는 알 수 없다 — 단정하지 않는다
      };
    case 'empty':
      return {
        short: '등록된 vCenter 없음',
        long: '등록된 vCenter 가 없습니다 — 설정 › vCenter 등록·관리에서 추가하세요.',
        waiting: false,
      };
    case 'first-collect':
      return {
        short: p?.pending ? `첫 수집 중 (${p.done}/${p.total})` : '첫 수집 중',
        long: p?.pending
          ? `첫 수집이 진행 중입니다 — ${p.total}개 중 ${p.pending}개가 아직 대기입니다. vCenter 를 동시에 몇 개씩만 받고 한 대씩 시한을 두므로 전부 끝나기까지 몇 분 걸릴 수 있습니다. 끝나면 새로고침 없이 채워집니다.`
          : '첫 수집이 진행 중입니다 — 끝나면 새로고침 없이 채워집니다.',
        waiting: true,
      };
    case 'unreachable':
      return {
        short: p?.unreachable ? `vCenter ${p.unreachable}개 연결 실패` : 'vCenter 연결 실패',
        long: p?.unreachable
          ? `vCenter ${p.unreachable}개가 연결되지 않습니다 — 기다려도 이 값은 채워지지 않습니다. 설정 › vCenter 등록·관리에서 주소·자격증명·방화벽을 확인하세요.`
          : 'vCenter 가 연결되지 않습니다 — 기다려도 채워지지 않습니다. 설정 › vCenter 등록·관리에서 확인하세요.',
        waiting: false,
      };
    case 'retrying': {
      // 시한 초과와 연결 실패를 같은 말로 덮지 않는다 — 확인할 곳이 다르다.
      const net = isNetworkError(pollError);
      return {
        short: net ? '서버에 닿지 못함 (재시도 중)' : '서버 응답 지연 (재시도 중)',
        long: net
          ? '서버에 연결하지 못했습니다 — 자동으로 다시 요청하고 있습니다. 네트워크 또는 포탈 서버 상태를 확인하세요.'
          : '서버가 응답 시한 안에 답하지 않았습니다 — 자동으로 다시 요청하고 있습니다. 원인은 이 화면에서 알 수 없습니다(설정 › 성능 점검의 진행 중 작업 기록을 보세요).',
        waiting: null, // 저절로 풀릴지 알 수 없다 — 단정하지 않는다
      };
    }
    default:
      return { short: '수집 대기', long: '아직 표시할 데이터가 없습니다.', waiting: null };
  }
}

/** 상단 배너로 알릴 만한 상황인가 — 행동이 갈리는 두 경우만 띄운다(배너 남발 금지). */
export const shouldBanner = (phase) => phase === 'first-collect' || phase === 'unreachable';

/**
 * LIVE 배지 문구. 기존 문구는 `28/28 vCenter OK` 뿐이라 **첫 수집 중에도 'OK' 라고 말했다**
 * (실제 화면에서 확인된 오해 요인). 대기·실패가 있으면 그것을 먼저 보여준다.
 */
export function liveText(health, updated) {
  if (!health) return '연결 중…';
  const p = collectProgress(health);
  if (!p) return `수집 대기 · ${updated}`;
  const parts = [`연결 ${p.connected}/${p.total}`];
  if (p.pending) parts.push(`대기 ${p.pending}`);
  if (p.unreachable) parts.push(`불가 ${p.unreachable}`);
  if (p.maintenance) parts.push(`점검 ${p.maintenance}`);
  const head = p.pending || p.unreachable || p.maintenance
    ? parts.join(' · ')
    : `${p.connected}/${p.total} vCenter OK`;
  return `${head} · ${updated}`;
}
