/**
 * linkCheckText.js — 통신 점검 화면의 **판정과 문구**(순수, v2.552).
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다 — 판정·문구는 여기서
 * vitest 로 회귀 고정한다(`accessDeniedText.js`·`loadState.js`·`bmUsageText.js` 와 같은 관례).
 *
 * ⚠⚠ 이 화면이 만들 수 있는 **최악의 거짓은 '빈 칸을 정상이라 말하는 것'** 이다. 엣지가 재는
 *   링크(엣지→중앙 push·설정 pull·엣지→vCenter·엣지↔엣지)는 그 엣지가 v2.552 로 올라가기 전까지
 *   값이 없다. 그것을 초록으로 칠하면 "모든 통신이 정상" 이라는 화면이 거짓이 된다 —
 *   `rowState()` 가 **`no-data` 를 별도 상태**로 두고 이유 후보를 함께 말한다(v2.548 규약).
 */
const t = (v) => String(v ?? '').trim();

export const STATE_LABEL = Object.freeze({
  ok: '정상',
  fail: '실패',
  'no-data': '측정 없음',
  disabled: '점검 안 함',
});

/** 상태 → 색. ⚠ **`no-data` 는 초록도 빨강도 아니다**(회색) — '확인 불가' 는 이상이 아니다. */
export function stateTone(state) {
  if (state === 'ok') return 'var(--ok, #35c46a)';
  if (state === 'fail') return 'var(--bad, #ef5a5a)';
  return 'var(--muted)';
}

/**
 * 행 상태 판정.
 *
 * ⚠⚠ **행에는 짧은 표지(`whyShort`)만 두고 긴 설명·조치는 표 아래 각주 1회**다(v2.509 규약).
 *   v2.552 초판은 `why` 를 행에 그대로 넣었고, 위임 엣지가 많은 화면에서 **같은 문단이 6줄
 *   반복돼 화면을 덮었다**(Chromium 스크린샷 판독으로 발견 — 가로 넘침 수치로는 안 잡혔다).
 *   `reason`(사유 종류)이 각주를 묶는 키다.
 *
 * @param {object} row  `/tools/link-check` 의 links[] 항목
 * @param {object} p    `{ enabled, minEdgeVersion }`
 * @returns {{state:string, reason:string, whyShort:string, why:string, fix:string}}
 */
export function rowState(row = {}, { enabled = true, minEdgeVersion = '2.552.0', runningSinceTs = null, intervalMs = 0, now = Date.now() } = {}) {
  if (row.enabled === false) {
    return { state: 'disabled', reason: 'disabled', whyShort: '비활성', why: '이 대상이 비활성입니다(등록부에서 껐습니다).', fix: '' };
  }
  const L = row.latest || null;
  // 측정된 행의 사유는 **그 행마다 다르다**(한 줄 요약) — 반복 문단이 아니므로 그대로 보여준다.
  if (L) return { state: L.ok ? 'ok' : 'fail', reason: '', whyShort: t(L.summary), why: t(L.summary), fix: '' };

  // 값이 없다 — **왜 없는지**를 말한다. 순서가 계약이다(먼저 맞는 것이 원인일 가능성이 높다).
  if (!enabled) {
    return { state: 'no-data', reason: 'off', whyShort: '점검 꺼짐', why: '통신 점검이 꺼져 있습니다.', fix: '설정에서 점검을 켜면 다음 주기부터 쌓입니다.' };
  }
  if (row.by === 'edge') {
    const rep = row.edgeReport || null;
    const ver = t(row.edgeVersion);
    if (!rep) {
      if (!ver) {
        return {
          state: 'no-data', reason: 'edge-unknown-version', whyShort: '보고 없음 · 버전 미상',
          why: '이 엣지가 중앙에 측정 결과를 올린 적이 없고, 엣지 버전도 확인되지 않았습니다(한 번도 export 를 주지 않았습니다).',
          fix: '수집 서버 연결을 먼저 확인하세요 — 중앙이 그 엣지에 닿지 못하면 버전도 모릅니다.',
        };
      }
      if (cmpVersion(ver, minEdgeVersion) !== null && cmpVersion(ver, minEdgeVersion) < 0) {
        return { state: 'no-data', reason: 'edge-old', whyShort: `구버전 ${ver}`, why: `이 엣지가 구버전입니다(${ver} · 필요 ${minEdgeVersion}).`, fix: '그 엣지를 업그레이드하면 자동으로 측정이 시작됩니다.' };
      }
      /*
       * ⚠⚠ **'기다리면 된다' 를 영원히 말하지 않는다**(v2.554 — 사용자 실화면으로 확정한 v2.552 결함).
       *   엣지가 v2.553 으로 전부 올라가고 중앙 점검이 10분·3회를 돌았는데도 전 엣지가
       *   '첫 보고 대기' 였다. 원인은 셋인데(중앙이 개별 토큰이 아니라 403 / 그 엣지가 잴 링크가
       *   0개 / 워커 미동작) **셋 다 기다려서 되는 것이 아니다**. 점검이 주기의 3배를 넘게 돌았는데도
       *   보고가 없으면 문구를 바꾼다 — 조치가 정반대이기 때문이다(v2.517 규약).
       * ⚠ `runningSinceTs` 가 없으면(첫 주기 전) escalate 하지 않는다 — 없는 문제를 만들지 않는다.
       */
      const ranMs = (runningSinceTs && intervalMs) ? (now - runningSinceTs) : 0;
      if (ranMs > intervalMs * 3) {
        return {
          state: 'no-data', reason: 'edge-silent', whyShort: '보고 없음(대기 초과)',
          why: '중앙 점검은 여러 주기를 돌았는데 이 엣지의 보고가 한 번도 오지 않았습니다 — 기다려서 될 상태가 아닙니다.',
          fix: '원인은 셋입니다 — ① 이 엣지가 **개별 토큰**을 쓰지 않아 중앙이 거부(403)하고 있다(설정 › 수집 서버 › 엣지 토큰에서 발급) ② 중앙이 계산한 이 엣지의 링크가 **0개**다(이름 불일치·담당 vCenter 없음) ③ 엣지 워커가 돌지 않는다. **특수기능 › 엣지 로그**에서 그 엣지를 가져와 linkcheck-worker 줄을 보면 바로 갈립니다.',
        };
      }
      return { state: 'no-data', reason: 'edge-waiting', whyShort: '첫 보고 대기', why: '이 엣지가 아직 첫 보고를 올리지 않았습니다.', fix: '엣지 워커의 첫 주기를 기다리세요(버전은 충분합니다).' };
    }
    if (rep.stale) return { state: 'no-data', reason: 'edge-stale', whyShort: '보고 오래됨', why: '이 엣지의 마지막 보고가 오래됐습니다 — 지금 값이 맞는지 알 수 없습니다.', fix: '엣지→중앙 통신을 먼저 확인하세요.' };
    /*
     * ⚠ v2.554 — 엣지가 **왜 0건인지** 말해 주면 그것을 그대로 쓴다(추측하지 않는다).
     *   구버전 엣지는 `note` 가 없으므로 예전 문구로 떨어진다 — 그 차이도 문구가 드러낸다.
     */
    if (t(rep.note)) {
      return {
        state: 'no-data', reason: 'edge-no-link', whyShort: '엣지가 잴 링크 없음',
        why: `이 엣지가 보고했지만 잴 링크가 없다고 답했습니다 — ${t(rep.note)}`,
        fix: '중앙이 이 엣지에 내려주는 링크가 0개입니다 — 점검 종류 설정과 이 엣지의 이름(수집 서버 등록부 name ↔ 엣지 AGENT_NAME)이 맞는지 보세요.',
      };
    }
    return { state: 'no-data', reason: 'edge-no-link', whyShort: '이 링크만 없음', why: '이 엣지는 보고했지만 이 링크의 결과가 없습니다(점검하지 않았거나 중앙이 버렸습니다).', fix: '엣지 로그의 linkcheck-worker 줄을 보세요.' };
  }
  return { state: 'no-data', reason: 'first', whyShort: '첫 주기 대기', why: '아직 이 링크를 점검한 기록이 없습니다.', fix: '첫 주기를 기다리거나 \'지금 점검\' 을 누르세요.' };
}

/** semver 비교(`partFaults`·`edgeLogText` 와 같은 규칙 — 형식이 아니면 null). */
export function cmpVersion(a, b) {
  const pa = t(a).replace(/^v/, '').split('.').map(Number);
  const pb = t(b).replace(/^v/, '').split('.').map(Number);
  if (pa.length < 3 || pb.length < 3 || pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * ms → 사람이 읽는 값.
 * ⚠⚠ **`null`·빈 문자열을 먼저 본다** — `Number('') === 0` 이고 `Number.isFinite(0)` 이 참이라
 *   그냥 두면 '모름' 이 **`0ms`(즉시 응답)** 으로 둔갑한다(v2.525·v2.550 규약. v2.552 초판이
 *   실제로 그랬고 자체 테스트가 잡았다).
 */
export function msText(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n < 1_000) return `${Math.round(n)}ms`;
  return `${(n / 1_000).toFixed(n < 10_000 ? 2 : 1)}초`;
}

/** 경과 시간. `null` 은 '없음' 이다. */
export function ageText(at, now = Date.now()) {
  if (at == null) return '없음';
  const d = Math.max(0, now - Number(at));
  if (d < 60_000) return `${Math.round(d / 1_000)}초 전`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}시간 전`;
  return `${Math.round(d / 86_400_000)}일 전`;
}

/**
 * 인증서 표시. ⚠ **만료일을 모르면 '유효' 라고 말하지 않는다**(HTTP 링크·TLS 단계 미도달).
 * 30일 이내는 경고 — 이 값은 점검이 잡을 수 있는 가장 흔한 '예고된 장애' 다.
 */
export function certText(daysLeft) {
  // ⚠ 빈 문자열을 먼저 걸러낸다 — 그냥 두면 `0일 남음`(오늘 만료)이라는 **오류 없이 틀린 값**이 된다.
  if (daysLeft == null || daysLeft === '') return { text: '—', tone: 'var(--muted)' };
  const n = Number(daysLeft);
  if (!Number.isFinite(n)) return { text: '—', tone: 'var(--muted)' };
  if (n < 0) return { text: `만료 ${Math.abs(Math.round(n))}일 지남`, tone: 'var(--bad, #ef5a5a)' };
  if (n <= 30) return { text: `${Math.round(n)}일 남음`, tone: 'var(--warn, #e8b23a)' };
  return { text: `${Math.round(n)}일 남음`, tone: 'var(--muted)' };
}

/**
 * KPI 재료. ⚠ **`no-data` 를 정상에도 실패에도 넣지 않는다**(v2.523·v2.548 규약).
 * '정상률' 은 **측정된 링크만** 분모로 쓰고, 측정이 0 이면 `null`(0% 가 아니다).
 */
export function kpisOf(rows = [], opt = {}) {
  let ok = 0; let fail = 0; let nodata = 0; let disabled = 0;
  for (const r of rows) {
    const st = rowState(r, opt).state;
    if (st === 'ok') ok += 1;
    else if (st === 'fail') fail += 1;
    else if (st === 'disabled') disabled += 1;
    else nodata += 1;
  }
  const measured = ok + fail;
  return {
    total: rows.length, ok, fail, nodata, disabled, measured,
    okPct: measured > 0 ? Math.round((ok / measured) * 1000) / 10 : null,
  };
}

/**
 * 맨 위 배너 — '지금 보이는 것이 무엇인가'.
 * ⚠ **긴 설명은 여기 한 번만** 한다(행·패널마다 반복하면 같은 말이 화면을 덮는다 — v2.509 규약).
 */
export function headerNote(data = {}) {
  const out = [];
  if (!data.enabled) {
    out.push('통신 점검이 **꺼져 있습니다** — 아래 목록은 설정에서 계산한 점검 대상이고, 상태는 켜야 쌓입니다.');
  }
  const k = kpisOf(data.links || [], { enabled: data.enabled });
  if (data.enabled && k.nodata > 0) {
    out.push(`측정값이 없는 링크가 **${k.nodata}개** 있습니다 — 정상이라는 뜻이 아닙니다. 행의 사유를 보세요.`);
  }
  if ((data.problems || []).length) {
    out.push(`설정 자체에 문제가 있는 대상이 **${data.problems.length}개** 있습니다(아래 '설정 문제' 표) — 점검조차 하지 못합니다.`);
  }
  const p = data.poller || null;
  if (data.enabled && p && !p.last) out.push('아직 첫 주기가 돌지 않았습니다 — 기다리면 채워집니다.');
  if (p?.last?.error) out.push(`마지막 주기가 오류로 끝났습니다: ${p.last.error}`);
  if (p?.last?.dbOk === false) out.push(`점검은 했지만 **기록에 실패**했습니다(${p.last.dbError || '사유 미상'}) — 이력이 남지 않습니다.`);
  return out;
}

/**
 * '지금 점검' 결과 문구. ⚠ 중앙 측정분과 엣지 측정분을 **나눠** 말한다 —
 * 뭉치면 '전부 지금 점검했다' 는 거짓이 된다(v2.516 `collect-all` 규약).
 */
export function runResultText(r = {}) {
  if (r.ok === false && r.skipped === 'already-running') return '이미 점검이 진행 중입니다 — 끝나면 갱신됩니다.';
  if (r.ok === false && r.skipped === 'disabled') return '통신 점검이 꺼져 있습니다.';
  if (r.ok === false) return `점검 실패: ${r.error || r.reason || '사유 미상'}`;
  const parts = [`중앙에서 **${r.checked ?? 0}개** 점검(실패 ${r.failed ?? 0})`];
  if (r.skippedLinks) parts.push(`건너뜀 ${r.skippedLinks}개`);
  if (r.edgePending) parts.push(`엣지가 재는 **${r.edgePending}개** 는 그 엣지의 다음 주기에 갱신됩니다`);
  return parts.join(' · ');
}

/** 로그 이벤트 라벨. `first` 를 '복구' 라 말하지 않는다(처음은 복구가 아니다 — 서버 규약과 짝). */
export const EVENT_LABEL = Object.freeze({
  first: '첫 점검',
  'fail-start': '실패 시작',
  fail: '실패 지속',
  recovered: '복구',
});

export function eventTone(ev, ok) {
  if (ok) return ev === 'recovered' ? 'var(--ok, #35c46a)' : 'var(--muted)';
  return ev === 'fail-start' ? 'var(--bad, #ef5a5a)' : 'var(--warn, #e8b23a)';
}

/**
 * 표 아래 각주 — **그 종류가 실제로 있을 때만** 만든다(v2.509 규약).
 * 행에는 짧은 표지만 두고 조치는 여기 한 번.
 */
export function tableFootnotes(rows = [], opt = {}) {
  const states = rows.map((r) => rowState(r, opt));
  const kinds = new Set(states.map((s) => s.state));
  const out = [];
  /*
   * ⚠ 사유별 긴 설명은 **여기서 한 번만**(행에는 `whyShort` 짧은 표지만 — v2.509 규약).
   *   등장 순서를 유지해 표와 각주를 눈으로 잇게 한다.
   */
  const seen = new Set();
  for (const s of states) {
    if (!s.reason || seen.has(s.reason)) continue;
    seen.add(s.reason);
    out.push(`**${s.whyShort}** — ${s.why}${s.fix ? ` ${s.fix}` : ''}`);
  }
  if (kinds.has('no-data')) {
    out.push('**측정 없음**: 아직 값이 없는 링크입니다. 정상도 장애도 아닙니다 — 행의 사유가 '
      + '‘기다리면 되는가’ 를 말합니다(첫 주기 / 엣지 구버전 / 엣지 보고 없음).');
  }
  if (kinds.has('disabled')) out.push('**점검 안 함**: 등록부에서 비활성으로 둔 대상입니다.');
  if (rows.some((r) => r.by === 'edge')) {
    out.push('**엣지가 재는 링크**(엣지→중앙 push·설정 pull·엣지→vCenter·엣지↔엣지)는 중앙에서 잴 수 없어 '
      + '그 엣지가 재서 올립니다 — 값이 늦거나 없을 수 있고, 그 사실을 행이 말합니다.');
  }
  if (rows.some((r) => r.unassigned)) out.push('**담당 엣지 미지정**: collectMode=site 인데 remoteAgent 가 비어 있어 누가 점검하는지 알 수 없습니다.');
  if (rows.some((r) => r.unknownFrom || r.unknownTo)) out.push('**등록부에 없는 엣지 이름**: 짝에 적은 이름이 바뀌었거나 등록이 삭제됐습니다.');
  return out;
}

/** 엣지↔엣지 짝 안내 — **자동 전량 생성을 하지 않는 이유**를 화면이 말한다. */
export function pairNote(agents = [], pairs = []) {
  const n = agents.length;
  const full = n > 1 ? n * (n - 1) : 0;
  return `엣지 ${n}곳이면 가능한 방향은 ${full}개입니다 — 주기마다 그만큼 나가면 그 자체가 부하이므로 `
    + `**고른 짝만** 점검합니다(현재 ${pairs.length}개).`;
}

/** 단계 순서 표시(어디까지 갔는지). 미도달 단계를 '실패' 라 말하지 않는다. */
export function phaseTrail(steps = {}, phases = ['dns', 'tcp', 'tls', 'http', 'auth', 'identity']) {
  return phases.map((ph) => {
    const s = steps?.[ph];
    if (!s) return { phase: ph, state: 'untried' };
    return { phase: ph, state: s.ok ? 'ok' : 'fail', ms: s.ms ?? null, error: t(s.error) };
  });
}

/**
 * 최신 요약 행(`latest`)에서 단계 표지를 되돌린다.
 *
 * ⚠⚠ **표본 테이블에는 단계별 ok 플래그가 없다** — 단계마다 ms 열과, 판정의 `phase`·`reached` 만
 *   있다(상세 원문은 실패·상태변화 때만 남는 3단 구조 때문이다). 그래서:
 *     · `reached` 까지의 단계는 **도달**했다
 *     · 실패했으면 `phase` 가 실패 단계이고 **그 뒤는 미시도**다
 *     · `reached` 를 모르면(구버전 행) ms 가 있는 단계만 도달로 본다
 *   ⚠ 미도달을 '실패' 로 칠하지 않는다 — 시도하지 않은 것을 실패라 말하면 원인을 거꾸로 말한다.
 */
export function trailFromLatest(latest, phases = ['dns', 'tcp', 'tls', 'http', 'auth', 'identity']) {
  if (!latest) return phases.map((ph) => ({ phase: ph, state: 'untried' }));
  const msOf = { dns: latest.dnsMs, tcp: latest.tcpMs, tls: latest.tlsMs, http: latest.httpMs };
  const HAS_MS_COL = new Set(['dns', 'tcp', 'tls', 'http']);   // auth·identity 는 ms 열이 없다
  const reachedIdx = latest.reached ? phases.indexOf(latest.reached) : -1;
  const failIdx = latest.ok ? -1 : phases.indexOf(latest.phase);
  return phases.map((ph, i) => {
    const ms = msOf[ph] == null ? null : Number(msOf[ph]);
    const reached = reachedIdx >= 0 ? i <= reachedIdx : ms != null;
    if (!reached) return { phase: ph, state: 'untried' };
    if (failIdx >= 0 && i === failIdx) return { phase: ph, state: 'fail', ms, error: t(latest.failKind) };
    if (failIdx >= 0 && i > failIdx) return { phase: ph, state: 'untried' };
    /*
     * ⚠⚠ **하지 않은 단계를 '정상' 이라 칠하지 않는다**(v2.552 Chromium 판독에서 잡은 결함):
     *   `http://` 링크는 TLS 단계가 **아예 없다**(스킴에 TLS 가 없다). 그런데 `reached` 가 'auth'
     *   이면 인덱스만으로 tls 까지 ok 로 칠해져 화면이 **`●›●›●›●›✕`** 로 'TLS 정상' 이라고
     *   말했다 — 재지도 않은 것을 정상이라 말하는 거짓이다. ms 열이 있는 단계는 **ms 가 있어야만**
     *   ok 이고, 없으면 `skip`(해당 없음)이다. auth·identity 는 ms 열이 없으므로 reached 로 본다.
     */
    if (HAS_MS_COL.has(ph) && ms == null) return { phase: ph, state: 'skip' };
    return { phase: ph, state: 'ok', ms };
  });
}
