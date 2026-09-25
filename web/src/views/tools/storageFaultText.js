/**
 * views/tools/storageFaultText.js — 스토리지 '장애 장비' 판정·문구(v2.615, 순수 모듈 — React import 없음).
 *
 * 사용자 요청: "'미해결 정보' 를 '장애 장비' 로 변경하고, 장애가 발생한 장비의 숫자를 표시하고, 장애 숫자를
 * 클릭하면 장애 발생한 장비들만 모아서 보여주는 화면을 만들어줘".
 *
 * ── 왜 '미해결 경보' 를 뺐나 ────────────────────────────────────────────────────
 * 그 카드는 `snap.alerts.unresolved` 의 **전 장비 합**이었다(이 현장 수천 건). 정보성 이벤트가 섞여
 * 숫자가 커도 조치로 이어지지 않았고, **장비 몇 대가 문제인가** 에는 답하지 못했다.
 *
 * ── ⚠⚠ v2.567 → v2.568 철회의 교훈 — 판정 신호는 하나뿐이다 ────────────────────
 * v2.567 은 같은 카드를 만들면서 장비가 보고한 **헬스 문자열**(`extra.healthState`·`extra.clusterHealth`)을
 * 배지 색 함수(`healthBadge`)에 넣어 빨강이면 장애로 셌다. Isilon 의 `ATTN` 은 **클러스터 레벨 플래그**라
 * 경미한 이벤트에도 켜지므로 실제 3대가 **27대**로 보고됐고 v2.568 에 철회됐다(CLAUDE.md).
 * 그래서 이 모듈의 장애 판정은 **노드 표의 ⚠ 표지와 글자 그대로 같은 조건** 하나다 —
 * `snap.nodes.unhealthy`(수집기가 노드 단위로 센 비정상 대수) > 0.
 *   · 헬스 문자열·경보 개수·`extra.inventory.hardware` 는 **판정에 넣지 않는다**(표시용이다).
 *   · 표지와 이 함수가 다른 조건을 쓰면 '카드는 3대, 표에서 ⚠ 는 5대' 같은 모순이 생긴다 —
 *     그래서 표지도 이 모듈의 `hasNodeFault` 를 쓴다(StorageMonTool.jsx — 소스 스윕 테스트가 고정).
 *
 * ── 세 칸 · 항등식 ─────────────────────────────────────────────────────────────
 * `합계 = 장애 + 정상 + 판정 불가`. **판정 불가를 정상에도 장애에도 넣지 않는다**(v2.519·v2.523·v2.526 규약).
 *   · 정상은 '노드 상태를 실제로 읽었고 비정상이 0' 일 때만이다 — 노드 목록이 있고 그중 상태를 못 읽은
 *     노드가 하나도 없어야 한다. 개수만 주는 수집기(PowerStore 목록의 health 'unknown')·노드 수를 모르는
 *     수집기(Unity SSH 의 count null)·노드 개념이 없는 타입(VMAX)·수집 실패·수집 전은 전부 판정 불가다.
 *   · ⚠ 목록이 상한(64)으로 잘린 것만으로는 판정 불가가 아니다 — 서버 요약 `unhealthy` 는 **전 노드**를
 *     센 값이다(Isilon 66대 중 64대 목록). 판정 불가로 만들면 대형 클러스터가 영원히 '정상' 이 될 수 없다.
 *   · 목록에는 '이상' 노드가 있는데 요약이 0 이면 **정상이라 말하지 않는다**(판정 불가) — 두 값이 어긋난
 *     것이고, 장애로 세면 ⚠ 표지(요약 기준)와 어긋난다.
 *   · ⚠ v2.615 검토(SF-R1-01): **비활성 장비와 낡은 보고**도 판정 불가다 — 스냅샷은 비활성으로 바꾸거나 엣지가 조용해져도
 *     무기한 남는다. 그 마지막 값을 '지금 정상' 으로 세면 KPI 가 초록 'N대 모두 노드 정상' 을 띄운다(거짓 초록).
 *     낡음의 경계는 **서버가 주는 수집 주기 × STALE_FACTOR (+ 엣지 push 주기)** 다(숫자를 박지 않는다).
 *     ⚠ 장애 칸에는 이 조건을 걸지 않는다 — 장애 == ⚠ 표지 계약을 지키고, 그 장애가 오래된 값이면 화면이 밝힌다.
 *   · ⚠ v2.615 검토(SF-R1-02): 서버가 **전 노드 기준** 상태 미확인 수(`nodes.unknown`)를 주면 그것이 0 보다 클 때
 *     판정 불가다(목록 상한 밖 노드도 센다). 구버전 수집기(필드 없음)는 예전 규칙을 따르되 표지 title 이 밝힌다.
 * ⚠ 수집 실패 대수는 옆 KPI '수집 실패/대기' 가 센다. 회선 장애가 장비 장애로 둔갑하지 않게.
 *   (부분 실패여도 노드를 읽었고 비정상이 있으면 장애로도 센다 — 두 카드는 겹칠 수 있다.)
 *
 * ⚠ 문구 규칙: 백틱 금지(BoldText 는 `**강조**` 만 해석한다 — 값 인용은 ‘ ’). 숫자는 지어내지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { nodeRows, nodeFaultSummary } from './storageNodeText.js';

/** 낡음 경계 = 수집 주기 × 이 배수(+ 엣지 push 주기). 주기 자체는 서버 값만 쓴다. */
export const STALE_FACTOR = 3;

/**
 * 판정 불가 사유 코드 → 짧은 문구(KPI title·화면 머리말이 같은 표를 쓴다).
 * ⚠ 순서가 곧 문구 나열 순서다. 코드를 더하면 `deviceFaultJudge` 와 테스트를 함께 고칠 것.
 */
export const UNKNOWN_REASON_TEXT = Object.freeze({
  'no-snap': '수집 전',
  'disabled': '비활성 장비',
  'collect-failed': '수집 실패(부분 실패 포함)',
  'stale': '보고가 낡은 장비',
  'no-nodes': '노드 정보가 없는 장비(노드 수를 모르거나 노드 개념이 없는 타입)',
  'no-summary': '비정상 노드 요약이 없는 장비',
  'count-only': '노드 개수만 주는 수집기',
  'node-unknown': '일부 노드의 상태를 읽지 못한 장비',
  'mismatch': '노드 목록과 요약이 어긋난 장비',
});

const hasOwn = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** 수집 시각(epoch ms 숫자·숫자 문자열·ISO 문자열) → ms. ⚠ `Number(null) === 0` 이라 null·빈 값을 먼저 거른다. */
function tsMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d+$/.test(t)) return Number(t);
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

/**
 * 화면 응답(`GET /tools/storage`)에서 신선도 판정 입력을 만든다(순수 — `now` 를 받는다).
 *  · `centralPollMs` = 중앙 폴러 주기(`poller.intervalMs`)
 *  · `pollMsByAgent` = 담당 노드별 배포 주기(서버 `pollMsByAgent` — '' 는 중앙 직접)
 *  · `pushMs` = 엣지 push 주기(`edgeIntervals.push.ms`)
 */
export function faultJudgeOpts(d, now = Date.now()) {
  return {
    now,
    centralPollMs: numOrNull(d?.poller?.intervalMs),
    pollMsByAgent: d?.pollMsByAgent && typeof d.pollMsByAgent === 'object' ? d.pollMsByAgent : null,
    pushMs: numOrNull(d?.edgeIntervals?.push?.ms),
  };
}

/** 이 장비 스냅샷의 낡음 경계(ms). 수집 주기를 모르면 null(판정하지 않는다 — 지어내지 않는다). */
export function staleLimitMs(row, opts) {
  if (!opts) return null;
  const agent = String(row?.agent || '');
  const own = hasOwn(opts.pollMsByAgent, agent) ? numOrNull(opts.pollMsByAgent[agent]) : null;
  const poll = own ?? numOrNull(opts.centralPollMs);
  if (poll == null || poll <= 0) return null;
  const push = agent ? (numOrNull(opts.pushMs) ?? 0) : 0;
  return STALE_FACTOR * poll + Math.max(0, push);
}

/** 스냅샷 나이(ms) — 수집 시각과 엣지 보고 나이(`staleMs`) 중 큰 값. 둘 다 모르면 null. */
export function snapAgeMs(snap, now) {
  if (!snap || now == null) return null;
  const at = tsMs(snap.collectedAt);
  const a = at == null ? null : now - at;
  const b = numOrNull(snap.staleMs);
  if (a == null && b == null) return null;
  return Math.max(a ?? -Infinity, b ?? -Infinity);
}

/**
 * 보고가 낡았는가. `opts.now` 가 없으면 판정하지 않는다(false). 경계를 모르면 false, 나이를 모르면 **true**
 * (수집 시각이 없는 값을 '지금 정상' 이라 말하지 않는다).
 */
export function isStaleSnap(row, opts) {
  if (!opts || opts.now == null || !row?.snap) return false;
  const limit = staleLimitMs(row, opts);
  if (limit == null) return false;
  const age = snapAgeMs(row.snap, opts.now);
  if (age == null) return true;
  return age > limit;
}

/**
 * ⚠ 표지(⚠N 버튼)와 **글자 그대로 같은 조건**. 문자열 수치('2')도 받고, 빈 값·null·'0' 은 장애가 아니다.
 * @param {object|null} snap 장비 스냅샷
 */
export function hasNodeFault(snap) {
  const n = numOrNull(snap?.nodes?.unhealthy);
  return n != null && n > 0;
}

/**
 * 한 장비의 판정 + 근거.
 * @param {object} row 목록 행 `{ id, snap, enabled, agent, ... }`
 * @param {object} [opts] `faultJudgeOpts(d, now)` — 주면 신선도까지 본다
 * @returns {{kind:'fault'|'ok'|'unknown', reason:string, notCurrent:boolean}}
 *   reason 은 unknown 일 때 `UNKNOWN_REASON_TEXT` 의 키. notCurrent 는 장애인데 비활성·낡은 보고인 경우.
 */
export function deviceFaultJudge(row, opts) {
  const s = row?.snap || null;
  const disabled = row?.enabled === false;
  if (hasNodeFault(s)) {
    // 장애 == ⚠ 표지(계약). 다만 비활성·낡은 보고면 '지금' 의 장애인지 모른다 — 화면이 밝히게 표시만 한다.
    return { kind: 'fault', reason: '', notCurrent: disabled || isStaleSnap(row, opts) };
  }
  const u = (reason) => ({ kind: 'unknown', reason, notCurrent: false });
  // 여기부터는 '정상' 을 말할 근거가 있는지 본다 — 하나라도 없으면 판정 불가.
  if (!s) return u('no-snap');
  if (disabled) return u('disabled');
  if (s.ok === false) return u('collect-failed');
  if (isStaleSnap(row, opts)) return u('stale');
  const count = numOrNull(s.nodes?.count);
  if (count == null || count <= 0) return u('no-nodes');
  const unhealthy = numOrNull(s.nodes?.unhealthy);
  if (unhealthy !== 0) return u('no-summary');
  const unknownAll = numOrNull(s.nodes?.unknown);
  if (unknownAll != null && unknownAll > 0) return u('node-unknown'); // 목록 밖 노드까지 센 서버 값
  const rawLen = Array.isArray(s.nodes?.list) ? s.nodes.list.length : 0;
  const list = nodeRows(s);
  if (!rawLen) return u('count-only');                                  // 개수만 알고 노드별 상태를 모른다
  if (list.length < rawLen) return u('node-unknown');                   // 읽을 수 없는 목록 원소가 있다
  if (list.some((r) => r.kind === 'unknown')) return u('node-unknown'); // 상태를 못 읽은 노드가 있다
  if (list.some((r) => r.kind === 'bad')) return u('mismatch');         // 목록은 이상이라는데 요약은 0 — 어긋남
  return { kind: 'ok', reason: '', notCurrent: false };
}

/** 한 장비의 판정. @returns {'fault'|'ok'|'unknown'} */
export function deviceFaultKind(row, opts) {
  return deviceFaultJudge(row, opts).kind;
}

/** 장애로 판정된 장비만(목록 순서 유지). */
export function faultRows(rows = [], opts) {
  return (Array.isArray(rows) ? rows : []).filter((r) => deviceFaultKind(r, opts) === 'fault');
}

/**
 * KPI 값. ⚠ **항등식 `total = fault + ok + unknown`** 을 테스트가 고정한다.
 * `unknownBy` 는 판정 불가 사유별 대수(합 = unknown), `faultNotCurrent` 는 장애 중 비활성·낡은 보고 대수.
 * @returns {{total:number, fault:number, ok:number, unknown:number, unknownBy:object, faultNotCurrent:number}}
 */
export function faultKpi(rows = [], opts) {
  const list = Array.isArray(rows) ? rows : [];
  let fault = 0; let ok = 0; let unknown = 0; let faultNotCurrent = 0;
  const unknownBy = {};
  for (const r of list) {
    const j = deviceFaultJudge(r, opts);
    if (j.kind === 'fault') { fault += 1; if (j.notCurrent) faultNotCurrent += 1; }
    else if (j.kind === 'ok') ok += 1;
    else { unknown += 1; unknownBy[j.reason] = (unknownBy[j.reason] || 0) + 1; }
  }
  return { total: list.length, fault, ok, unknown, unknownBy, faultNotCurrent };
}

/** 판정 불가 사유를 '수집 실패 2 · 비활성 1' 모양으로(있는 사유만, 표의 순서대로). 사유 표가 없으면 ''. */
export function unknownReasonText(k) {
  const by = k?.unknownBy;
  if (!by || typeof by !== 'object') return '';
  const parts = [];
  for (const [code, label] of Object.entries(UNKNOWN_REASON_TEXT)) {
    const n = Number(by[code]) || 0;
    if (n > 0) parts.push(`${label} ${n}`);
  }
  return parts.join(' · ');
}

/** 카드 숫자 아래 한 줄 — '경보 미확인 N대 제외' 와 같은 모양. 판정 불가가 있으면 그것이 먼저다. */
export function faultKpiMeta(k) {
  if (!k || !k.total) return '등록된 장비 없음';
  if (k.unknown > 0) return `노드 상태 판정 불가 ${k.unknown}대 제외`;
  if (k.fault > 0) return '클릭하면 장애 장비만 봅니다';
  return `${k.total}대 모두 노드 정상`;
}

/**
 * 카드 색. 장애가 있으면 빨강, **전부 판정했고** 장애 0 이면 초록, 그 밖은 중립(undefined).
 * ⚠ 판정 불가가 섞였는데 초록으로 칠하면 '전부 정상' 이라는 거짓이다. 0 을 경고색으로 칠하지도 않는다.
 */
export function faultKpiAccent(k) {
  if (!k) return undefined;
  if (k.fault > 0) return 'var(--red)';
  if (k.fault === 0 && k.unknown === 0 && k.total > 0) return 'var(--green)';
  return undefined;
}

/** 근거 문구 — 노드 열 이름이 타입마다 다르다(Unity 'SP' · XtremIO 'SC' · VPLEX '디렉터'). SF2-03. */
const BASIS = '노드(SP·SC·디렉터) 열에 ⚠ 표지가 붙은 장비(노드 상태가 비정상인 장비)';

/** 카드 접근성 문구(title — 평문. BoldText 를 거치지 않으므로 별표를 쓰지 않는다). */
export function faultKpiTitle(k) {
  if (!k || !k.total) return '등록된 스토리지 장비가 없습니다.';
  const bits = [
    `장애 장비 = ${BASIS}입니다. 장비 ${k.total}대 중 장애 ${k.fault} · 정상 ${k.ok} · 판정 불가 ${k.unknown}.`,
  ];
  if (k.unknown > 0) {
    const why = unknownReasonText(k);
    bits.push(why
      ? `판정 불가 사유: ${why} — 정상이라는 뜻이 아닙니다.`
      : '판정 불가는 수집 전·수집 실패·비활성·낡은 보고이거나, 노드 정보가 없거나 개수만 주거나, 일부 노드 상태를 읽지 못했거나, 노드 목록과 요약이 어긋난 장비입니다 — 정상이라는 뜻이 아닙니다.');
  }
  if (k.faultNotCurrent > 0) bits.push(`장애 ${k.fault}대 중 ${k.faultNotCurrent}대는 비활성이거나 보고가 낡은 장비입니다 — 마지막 수집 시각을 보세요.`);
  bits.push('정상은 노드 상태를 실제로 읽었고 보고가 최근인 장비만 셉니다(비활성·낡은 보고는 판정 불가).');
  bits.push('장비가 보고한 헬스 문구와 미해결 경보 개수는 판정에 쓰지 않습니다.');
  bits.push('수집 실패 대수는 옆의 ‘수집 실패/대기’ 카드가 셉니다(부분 실패여도 노드를 읽었고 비정상이 있으면 장애로도 셉니다).');
  if (k.fault > 0) bits.push('클릭하면 장애 장비만 봅니다.');
  return bits.join(' ');
}

/**
 * 장애 장비 화면 머리말(BoldText 로 렌더 — `**강조**` 허용, 백틱 금지).
 * @param {{total,fault,ok,unknown}} k 전체 장비 기준 KPI
 * @param {number} shownFaultCount 법인·종류 필터·찾기를 적용한 뒤 보이는 장애 장비 수
 */
export function faultViewNote(k, shownFaultCount) {
  if (!k || !k.total) return '등록된 장비가 없습니다.';
  const why = unknownReasonText(k);
  const unknownText = k.unknown > 0
    ? ` 노드 상태를 판정하지 못한 장비 ${k.unknown}대${why ? `(${why})` : '(비활성·낡은 보고 포함)'}는 여기에 넣지 않았습니다(정상이라는 뜻이 아닙니다).`
    : '';
  if (!k.fault) {
    return k.unknown > 0
      ? `장애로 판정된 장비가 없습니다 — 다만 **노드 상태 판정 불가 ${k.unknown}대**가 있어 ‘장애 없음’ 이라고 단정할 수 없습니다${why ? `(${why})` : ''}.`
      : '장애로 판정된 장비가 없습니다 — 모든 장비의 노드 상태가 정상입니다.';
  }
  const shown = Math.max(0, Math.min(k.fault, Number(shownFaultCount) || 0));
  const hidden = k.fault - shown;
  let s = `**장애 장비 ${k.fault}대** — ${BASIS}만 모았습니다.`;
  if (hidden > 0) s += ` 법인·종류 필터나 찾기 때문에 **${hidden}대가 가려져 있습니다**(보이는 것 ${shown}대).`;
  if (k.faultNotCurrent > 0) s += ` 이 중 **${k.faultNotCurrent}대는 비활성이거나 보고가 낡은 장비**입니다 — 상태 열의 마지막 수집 시각을 보세요.`;
  s += unknownText;
  s += ' 장비가 보고한 헬스 문구(ATTN 등)와 미해결 경보 개수는 판정에 쓰지 않습니다.';
  return s;
}

/**
 * 장애 장비의 **비정상 노드** 행(두 번째 표). 노드 이름을 지어내지 않는다.
 *  · 목록에서 이상으로 보이는 노드 → 노드 하나당 한 행(kind 'bad').
 *  · 요약 대수가 목록의 이상 노드보다 많으면 **장비당 한 행**으로 '어느 노드인지 알 수 없음 N대'(kind 'unidentified').
 *    사유는 실제 원인을 가른다 — 목록 없음(개수만 주는 수집기) / 목록 상한(64) / 목록에 상태 미확인 노드가 있음 /
 *    판정 규칙 차이. ⚠ '수집 시점 차이' 는 원인이 아니다(수집기는 요약과 목록을 같은 배열에서 동기로 계산한다 — SF-R1-04).
 *  · 목록이 전부 올라왔는데 어긋나고 목록에 '상태 미확인' 노드가 있으면, 그 노드들을 **후보**(kind 'candidate')로
 *    원문 상태와 함께 싣는다 — 수집기는 비정상으로 셌고 화면은 상태 미확인으로 본 노드일 가능성이 크다.
 * @returns {Array<{key,deviceId,deviceName,datacenterId,type,label,ip,health,kind:'bad'|'unidentified'|'candidate',count:number,reason:string}>}
 */
export function faultNodeRows(rows = [], opts) {
  const out = [];
  for (const r of faultRows(rows, opts)) {
    const s = r.snap || null;
    const sum = nodeFaultSummary(s);
    const deviceName = String(s?.name || r.name || r.host || r.id || '');
    const base = { deviceId: r.id, deviceName, datacenterId: r.datacenterId, type: r.type };
    for (const b of sum.badRows) {
      out.push({ ...base, key: `${r.id}:${b.key}`, label: b.label, ip: b.ip, health: b.health, kind: 'bad', count: 1, reason: '' });
    }
    const rest = sum.unhealthy - sum.badRows.length;
    if (rest <= 0) continue;
    let reason;
    let candidates = [];
    if (!sum.listed) reason = '이 수집기는 노드 개수만 알려 주고 노드별 상태 목록을 주지 않습니다.';
    else if (sum.missing > 0) reason = `노드 목록이 전체 ${sum.count}대 중 ${sum.listed}대만 올라왔습니다(목록 상한).`;
    else if (sum.unknown > 0) {
      reason = `목록에 상태를 읽지 못한 노드 ${sum.unknown}대가 있어 어느 노드인지 특정할 수 없습니다 — 수집기와 화면의 상태 판정 규칙이 달라 생긴 차이일 수 있습니다(후보를 함께 보입니다).`;
      candidates = nodeRows(s).filter((x) => x.kind === 'unknown');
    } else reason = '요약 대수와 목록이 어긋납니다 — 수집기와 화면의 상태 판정 규칙이 다릅니다.';
    out.push({
      ...base, key: `${r.id}:unidentified`, label: `어느 노드인지 알 수 없음 ${rest}대`,
      ip: '', health: '', kind: 'unidentified', count: rest, reason,
    });
    for (const c of candidates) {
      out.push({
        ...base, key: `${r.id}:cand:${c.key}`, label: c.label, ip: c.ip, health: c.health, kind: 'candidate', count: 1,
        reason: '후보 — 수집기는 비정상으로 셌을 수 있고 화면은 상태 미확인으로 봅니다(원문 상태를 보세요).',
      });
    }
  }
  return out;
}
