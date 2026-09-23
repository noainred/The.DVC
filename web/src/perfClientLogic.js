/**
 * perfClientLogic.js — 브라우저 성능 보고의 **순수 로직**(v2.498): 경로 정규화·장기 로딩 문구·
 * 쿨다운/상한 판정. 웹 테스트는 node 환경(DOM 없음)이라 판정·문구는 여기서 회귀로 고정한다.
 *
 * 배경(사용자 신고): "'불러오는 중…' 이 3분 이상 지속될 때가 있다." 웹 GET 은 20초에 스스로 끊고
 * 최대 3회 재시도(≈61초)라, 서버 지연만으로 3분은 구조적으로 나오지 않는다 — 상당수는 **뷰가
 * 스피너에 갇힌 경우**다. 그래서 (a) 화면에 '몇 초째·무엇을 기다리는지' 를 정직하게 보이고,
 * (b) 기다리는 요청이 하나도 없으면 그 사실을 자백하고, (c) 서버에 1회 보고해 근거를 남긴다.
 */

import { taskRows, secText } from './components/taskLabel.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const NUM_RE = /^\d+$/;

/** 경로 정규화 — 쿼리 제거(검색어·id 유출 방지) + 식별자 세그먼트 마스킹. 서버 집계 키와 같은 규칙. */
export function normPath(p) {
  const raw = String(p || '').split('?')[0].split('#')[0];
  const parts = raw.split('/').map((seg) => {
    if (!seg) return seg;
    if (NUM_RE.test(seg) || UUID_RE.test(seg) || HEX_RE.test(seg) || seg.includes(':')) return ':id';
    return seg;
  });
  return (parts.join('/') || '/').slice(0, 200);
}

/** 화면 해시 정규화(`#/insights/finops?x=1` → `#/insights/finops`). */
export const normView = (hash) => String(hash || '').split('?')[0].slice(0, 120);

/**
 * '불러오는 중' 표시 문구.
 *
 * v2.501(사용자 요구: "대기가 3초 이상이면 구체적으로 어떤 작업을 하는지 진행상태를 보여줄 것"):
 * 문턱을 **3초**(서버 설정값 `clientDetailMs`)로 낮추고, 경과 초와 함께 **무엇을 기다리는지**
 * 작업 이름·건수·각 대기 시간을 보여준다. 예전에는 15초까지 아무 정보가 없고 30초가 지나야
 * 경로 하나를 보여줬다 — 사용자는 그 사이 '멈췄나?' 를 알 수 없었다.
 *
 * 단계:
 *  · 3초 미만 — '불러오는 중…' 만(짧은 대기에 잡음을 더하지 않는다).
 *  · 3초 이상 — 경과 초 + 진행 중 작업 목록(`tasks`). 설계상 오래 걸리는 작업은 그 사실을 알린다.
 *  · 3초 이상인데 대기 요청이 없음 — '요청은 끝났고 화면을 그리는 중' 이라고만 말한다.
 *    **이때 새로고침을 권하지 않는다** — 렌더 중인 정상 상태와 구분할 수 없고, 3초에 새로고침을
 *    권하면 정상 동작을 고장으로 오인하게 만든다.
 *  · stuckSec(서버 설정 `clientStuckMs`, 기본 60초) 이상 + 대기 요청 없음 — 그때 자백하고 새로고침 제공.
 *
 * `tasks` 는 화면이 줄 단위로 그린다. `detail` 은 한 줄 요약으로 남겨 기존 호출부 호환을 지킨다.
 * @returns {{text:string, detail:string, tasks:Array, suggestReload:boolean}}
 */
export function loadingText({
  elapsedSec = 0, inflight = [], detailSec = 3, stuckSec = 60, taskLimit = 3, label = '',
} = {}) {
  const s = Math.max(0, Math.round(elapsedSec));
  const head = label ? `${label}…` : '불러오는 중…';
  if (s < detailSec) return { text: head, detail: '', tasks: [], suggestReload: false };
  const text = label ? `${label}… (${s}초째)` : `불러오는 중… (${s}초째)`;
  const rows = (inflight || []).filter((x) => x && x.path);
  if (!rows.length) {
    // 오래 걸리면 자백한다. 그 전까지는 사실만: 서버 응답은 끝났고 화면을 그리는 중이다.
    if (s >= stuckSec) {
      return {
        text,
        detail: '대기 중인 요청이 없습니다 — 서버 응답은 끝났는데 화면이 갱신되지 않은 상태일 수 있습니다.',
        tasks: [],
        suggestReload: true,
      };
    }
    return { text, detail: '서버 응답은 모두 받았고 화면을 그리는 중입니다.', tasks: [], suggestReload: false };
  }
  const tasks = taskRows(rows, { limit: taskLimit, normalize: normPath });
  const top = tasks[0];
  const more = rows.length > 1 ? ` 외 ${rows.length - 1}건` : '';
  return {
    text,
    detail: `${top.label} 응답 대기 ${secText(top.ms)}${more}`,
    tasks,
    suggestReload: false,
  };
}

/**
 * 쿨다운·상한 판정(폭주 방지). state 는 { keys: Map<key, ts>, hourBucket, hourCount, dropped }.
 * 반환 true 면 보고해도 된다. 부수효과는 state 갱신뿐(순수하게 테스트 가능).
 */
export function allowReport(state, key, now, { cooldownMs = 300_000, maxPerHour = 50, maxKeys = 300 } = {}) {
  const s = state;
  const bucket = Math.floor(now / 3_600_000);
  if (s.hourBucket !== bucket) { s.hourBucket = bucket; s.hourCount = 0; }
  if (s.hourCount >= maxPerHour) { s.dropped = (s.dropped || 0) + 1; return false; }
  const last = s.keys.get(key) || 0;
  if (now - last < cooldownMs) return false;
  if (s.keys.size >= maxKeys) { const first = s.keys.keys().next().value; if (first !== undefined) s.keys.delete(first); }
  s.keys.set(key, now);
  s.hourCount += 1;
  return true;
}

/** 새 보고 상태. */
export const newReportState = () => ({ keys: new Map(), hourBucket: 0, hourCount: 0, dropped: 0 });

/** 보고 본문 — 사용자·IP 는 넣지 않는다(서버가 채운다). 경로는 정규화, 목록은 10건까지. */
export function stallPayload({ view = '', path = '', ms = 0, inflight = [] } = {}) {
  return {
    view: normView(view),
    path: normPath(path),
    ms: Math.max(0, Math.round(Number(ms) || 0)),
    inflight: (inflight || []).filter((x) => x && x.path).slice(0, 10)
      .map((x) => ({ path: normPath(x.path), ms: Math.max(0, Math.round(Number(x.ms) || 0)), ...(x.rid ? { rid: String(x.rid).slice(0, 40) } : {}) })),
  };
}

/**
 * 서버 상태를 물어볼 요청 ID 고르기(v2.583, 순수) — 문턱(detailMs)을 넘긴 것 중 오래된 순 최대 limit 개.
 * 빠른 요청은 묻지 않는다(묻는 요청이 부하가 되지 않게).
 */
export function statusPollTargets(inflight = [], { detailMs = 3_000, limit = 5 } = {}) {
  return (inflight || [])
    .filter((x) => x && x.rid && (Number(x.ms) || 0) >= detailMs)
    .sort((a, b) => (Number(b.ms) || 0) - (Number(a.ms) || 0))
    .slice(0, Math.max(1, limit))
    .map((x) => x.rid);
}

/**
 * 요청 한 건의 '누가 지연시키는가' 문구(v2.583, 순수). 사용자 요청: "불러오는 중… 이 나올 때
 * 누가 이 지연을 발생시켰는지 ID 도 같이 보여줘."
 *
 * 서버 상태(GET /perf/req-status)에 따라 **지연의 주체를 나눠** 말한다 — 조치가 다르기 때문이다.
 *  · processing — 서버가 이 요청을 아직 처리 중이다(그 라우트·외부 왕복이 지연 주체).
 *  · done       — 서버는 이미 응답했다(전송·브라우저 처리가 지연 주체 — 서버를 의심할 이유가 없다).
 *  · unknown    — 서버에 기록이 없다. 원인이 셋(미도달·서버 재시작·완료 기록 밀림)이라 **단정하지 않는다**.
 *  · 상태 없음  — 아직 묻지 않았다('확인 중').
 * 숫자가 없으면 단위를 붙이지 않는다(v2.575 규약).
 * @returns {{tone:'busy'|'done'|'unknown'|'pending', text:string}}
 */
export function serverStateText(server) {
  const s = server && typeof server === 'object' ? server : null;
  const sec = (ms) => {
    if (ms == null || ms === '' || !Number.isFinite(Number(ms))) return '';
    const n = Number(ms);
    return n < 1000 ? '1초 미만' : `${Math.round(n / 1000)}초`;
  };
  if (!s || !s.state) return { tone: 'pending', text: '서버 상태 확인 중' };
  if (s.state === 'processing') {
    const t = sec(s.serverMs);
    return { tone: 'busy', text: `서버가 처리 중${t ? ` (${t}째)` : ''} — 지연 주체는 서버의 이 작업입니다` };
  }
  if (s.state === 'done') {
    const t = sec(s.serverMs);
    const st = Number.isFinite(Number(s.status)) && Number(s.status) > 0 ? ` · ${Number(s.status)}` : '';
    return { tone: 'done', text: `서버는 이미 응답했습니다${t ? ` (${t}${st})` : st ? ` (${st.slice(3)})` : ''} — 전송이나 브라우저 처리를 기다리는 중입니다` };
  }
  return { tone: 'unknown', text: '서버에 이 요청 기록이 없습니다 — 서버에 도달하지 않았거나, 서버가 재시작됐거나, 완료 기록에서 밀려났습니다' };
}
