/**
 * views/tools/storageNodeText.js — 스토리지 **노드 장애 표지** 판정·문구(v2.523, 순수 모듈).
 *
 * 사용자 요청(2026-09-16): "장애표지 클릭하면 어떤 장애인지 확인하는 팝업 만들어줘"
 * (스크린샷: Isilon `OC2-A` 의 노드 열이 `24 ⚠1` — 24대 중 1대가 비정상인데 **어느 노드인지
 * 알 방법이 없었다**. 표지는 클릭되지 않는 `<b>` 였다).
 *
 * ★ 이 모듈이 지켜야 하는 정직성
 *  · **`unknown` 을 비정상으로 세지 않는다.** 수집기들이 이미 그렇게 세고 있다
 *    (`isilon.js:92` · `unity.js:42` 등 — `st !== 'unknown' && !/ok|healthy/`). 화면도 같은
 *    기준을 쓰고, '상태를 읽지 못한 노드' 수는 **따로** 밝힌다.
 *  · **노드 목록이 없으면 '어느 노드인지 모른다' 고 말한다.** 일부 수집기는 개수만 준다
 *    (`powerstore.js:92` 는 `unhealthy: 0` + health 'unknown' 목록). 목록이 비어 있는데
 *    '비정상 0대' 라고 말하면 거짓이고, 지어낸 노드를 보여주는 것도 거짓이다.
 *  · **목록 상한(64)으로 잘렸으면 밝힌다** — `count > list.length` 면 조용한 절단이다.
 */

import { numOrNull } from '../../numOrNull.js';

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 노드 상태 문자열 → 'ok' | 'bad' | 'unknown' — **서버 `storage/healthWord.js` 와 같은 규칙**(v2.586, 서버 테스트가
 * 두 구현을 같은 입력으로 대조한다). 예전 판정은 앵커 없는 `/healthy|online|up\b/` 라 'unhealthy'·'backup' 이 정상이었다.
 */
const H_UNKNOWN = new Set(['', 'unknown', 'n/a', 'na', '-', '?', 'none']);
const H_NEG_OK = /\b(not|no|non)[\s_-]*(ok|healthy|normal|online|connected|up|good)\b/;
const H_BAD = /\b(unhealthy|disconnected|offline|down|degraded|fail\w*|error\w*|critical|fault\w*|broken|major-failure|minor-failure|smartfail\w*)\b/;
const H_GOOD = /\b(ok|healthy|normal|up|green|online|connected|good|attention_none)\b/;
export function nodeHealthKind(health) {
  const s = String(health ?? '').trim().toLowerCase();
  if (H_UNKNOWN.has(s)) return 'unknown';
  if (H_NEG_OK.test(s) || H_BAD.test(s)) return 'bad';
  if (H_GOOD.test(s)) return 'ok';
  return 'bad';
}
export const NODE_KIND = Object.freeze({
  ok: { label: '정상', color: 'green' },
  bad: { label: '이상', color: 'red' },
  unknown: { label: '상태 미확인', color: 'muted' },
});
export const nodeKindLabel = (k) => NODE_KIND[k] || NODE_KIND.unknown;

const pctOf = (x) => (x ? numOrNull(x.pct) : null);

/** 노드 목록 원소 중 객체만(v2.615 SF-R1-03) — null·문자열·배열 원소는 읽을 수 없는 항목이다. */
const isNodeObj = (n) => !!n && typeof n === 'object' && !Array.isArray(n);

/**
 * 표에 그릴 노드 행(순수). 이름이 없으면 id·ip 로 대체하고 **지어내지 않는다**.
 * ⚠ v2.615(SF-R1-03): 엣지가 올린 `nodes.list` 에 null 원소가 섞이면 예전에는 `n.health` 에서 TypeError 를 던져
 *   스토리지 모니터링 화면 **전체**가 죽었다(장애 장비 KPI 가 매 렌더에 이 함수를 부른다). 객체 원소만 읽고,
 *   뺀 개수는 `nodeFaultSummary().dropped` 가 밝힌다.
 */
export function nodeRows(snap) {
  const list = Array.isArray(snap?.nodes?.list) ? snap.nodes.list.filter(isNodeObj) : [];
  return list.map((n, i) => {
    const kind = nodeHealthKind(n.health);
    return {
      key: String(n.id ?? n.name ?? n.ip ?? i),
      label: String(n.name || (n.id != null ? `노드 ${n.id}` : '') || n.ip || `#${i + 1}`),
      ip: String(n.ip || ''),
      health: String(n.health ?? ''),
      kind,
      hddPct: pctOf(n.hdd),
      ssdPct: pctOf(n.ssd),
      // v2.575: `Number(null)===0` 함정. Unity·VPLEX·PowerStore 수집기는 이 값을 재지 않아
      // **명시적으로 `null`** 을 보내는데, 예전 형태는 그것을 0 으로 바꿔 화면이
      // `0 bps`(= '트래픽 없음')라고 **거짓말**했다(`bpsText(null)` 은 '—' 다).
      inBps: numOrNull(n.inBps),
      outBps: numOrNull(n.outBps),
    };
  });
}

/**
 * 표지 요약 — 팝업 머리말. **무엇을 알고 무엇을 모르는지** 분리해서 말한다.
 * @returns {{count,unhealthy,unknown,listed,missing,badRows,tone,title,body}}
 */
export function nodeFaultSummary(snap) {
  const count = n0(snap?.nodes?.count);
  const unhealthy = n0(snap?.nodes?.unhealthy);
  const rows = nodeRows(snap);
  const badRows = rows.filter((r) => r.kind === 'bad');
  const unknown = rows.filter((r) => r.kind === 'unknown').length;
  const listed = rows.length;
  const missing = Math.max(0, count - listed);
  const section = String(snap?.sections?.nodes || '');
  // v2.615(SF-R1-03): 읽을 수 없는(객체가 아닌) 목록 원소 수 — 조용히 버리지 않고 밝힌다.
  const rawList = Array.isArray(snap?.nodes?.list) ? snap.nodes.list : [];
  const dropped = rawList.length - rawList.filter(isNodeObj).length;
  // v2.615(SF-R1-02): 서버가 **전 노드** 기준으로 센 '상태를 못 읽은 노드' 수(목록 상한 밖 포함). 구버전 수집기는 없다(null).
  const unknownAll = numOrNull(snap?.nodes?.unknown);

  let tone = unhealthy ? 'red' : 'green';
  let title = unhealthy ? `노드 ${count}대 중 ${unhealthy}대가 비정상입니다` : `노드 ${count}대 · 비정상 없음`;
  const bits = [];
  if (!listed) {
    // 개수만 알고 목록이 없다 — 어느 노드인지 **모른다**(지어내지 않는다).
    tone = unhealthy ? 'amber' : 'muted';
    bits.push('이 수집기는 **노드 개수만** 알려주고 노드별 상태 목록을 주지 않습니다 — **어느 노드인지 알 수 없습니다**.');
    if (section && section !== 'ok') bits.push(`노드 수집 상태: ${section}`);
  } else {
    if (badRows.length !== unhealthy) {
      // 요약 수치와 목록이 어긋나면 **숨기지 않고 밝힌다**.
      // ⚠ v2.615(SF-R1-04): 예전 문구는 '수집 시점 차이일 수 있습니다' 였지만 수집기는 요약과 목록을 **같은 배열에서
      //   동기로** 계산한다 — 시점 차이는 생길 수 없다. 실제 원인은 목록 상한(64) 또는 수집기와 화면의 판정 규칙 차이다.
      const why = missing > 0
        ? '목록 상한(64) 밖의 노드일 수 있습니다'
        : unknown > 0
          ? `수집기와 화면의 상태 판정 규칙이 다릅니다 — 화면이 상태 미확인으로 본 노드 ${unknown}대가 후보입니다`
          : '수집기와 화면의 상태 판정 규칙이 다릅니다';
      bits.push(`요약은 ${unhealthy}대라고 하는데 목록에서 이상으로 보이는 노드는 ${badRows.length}대입니다 — ${why}.`);
    }
    if (missing) bits.push(`노드 목록은 ${listed}대만 올라왔습니다(전체 ${count}대) — **나머지 ${missing}대는 상태를 알 수 없습니다**.`);
    if (unknown) bits.push(`상태를 읽지 못한 노드 ${unknown}대는 **비정상으로 세지 않았습니다**(정상이라는 뜻도 아닙니다).`);
    if (unknownAll != null && unknownAll > unknown) bits.push(`목록 밖 노드를 포함하면 상태를 읽지 못한 노드는 ${unknownAll}대입니다.`);
  }
  if (dropped > 0) bits.push(`형식이 올바르지 않은 노드 항목 ${dropped}개는 표시하지 않았습니다.`);
  return { count, unhealthy, unknown, unknownAll, listed, missing, dropped, badRows, tone, title, body: bits.join(' ') };
}

/** bps 를 사람 단위로(노드 표의 처리량 열). 값이 없으면 '—'. */
export function bpsText(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n < 1000) return `${n} bps`;
  const u = ['Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let x = n / 1000; let i = 0;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
}

/** 표지에 붙일 접근성 문구(버튼 title). */
export function faultBadgeTitle(snap) {
  const s = nodeFaultSummary(snap);
  const base = s.unhealthy ? `${s.title} — 클릭하면 어느 노드인지 봅니다` : `${s.title} — 클릭하면 노드별 상태를 봅니다`;
  // v2.615(SF-R1-02): 목록이 상한으로 잘렸으면 목록 밖 노드의 판정 근거가 **요약 수치**라는 사실을 밝힌다.
  //   서버가 전 노드 기준 '상태 미확인 수' 를 주지 않는 구버전 수집기면 그 사실도 함께 적는다.
  if (!s.listed || !s.missing) return base;
  const tail = s.unknownAll == null ? ' — 이 수집 버전은 상태를 읽지 못한 노드 수를 알려 주지 않습니다' : '';
  return `${base} · 목록 밖 ${s.missing}대는 요약 수치(비정상 ${s.unhealthy}대) 기준입니다${tail}`;
}

/**
 * 장비 헬스 배지 색 판정(v2.526 — Chromium 판독으로 발견한 실제 결함).
 *
 * v2.525 까지는 `healthState.toLowerCase() === 'healthy'` 만 초록이었다. Unity 수집기는
 * `'OK'` 를 싣기 때문에(`storage/collectors/unitySsh.js:199`) 화면이 **빨간 `Health: OK`** 를
 * 그렸다 — 배지 색과 글자가 서로 반대말을 하는 것이다. 사용자는 색을 먼저 읽는다.
 *
 * 규칙:
 *  · 정상 계열(`ok`/`healthy`/`normal`/`good`)만 초록.
 *  · **`unknown`·빈 값은 빨강이 아니라 회색**이다 — 상태를 읽지 못한 것을 '이상' 이라 말하지
 *    않는다(v2.523 스토리지 노드 규약과 같은 기준).
 *  · 그 밖은 빨강(원문을 그대로 보여 준다).
 *
 * @returns {{tone:'green'|'red'|'gray', text:string, title:string}}
 */
export function healthBadge(raw) {
  const s = String(raw ?? '').trim();
  const l = s.toLowerCase();
  if (!s || l === 'unknown' || l === 'n/a' || l === '?') {
    return { tone: 'gray', text: `Health: ${s || '확인 불가'}`, title: '장비가 상태를 주지 않았습니다 — 정상이라는 뜻이 아닙니다' };
  }
  // 'OK (5)' · 'Healthy' 처럼 뒤에 코드가 붙는 형태도 정상으로 읽는다(장비마다 표기가 다르다).
  if (/^(ok|healthy|normal|good)\b/.test(l)) {
    return { tone: 'green', text: `Health: ${s}`, title: '장비가 보고한 상태' };
  }
  return { tone: 'red', text: `Health: ${s}`, title: '장비가 보고한 상태(원문 그대로)' };
}

/**
 * 섹션별 수집 상태 배지(v2.542) — `snap.sections[k]` 하나를 색·글자로 옮긴다.
 *
 * ⚠ 왜 순수 모듈로 올렸나: v2.541 까지 이 판정이 `StorageMonTool.jsx` 에 인라인으로 있었고
 * **`ok`/`skip` 이 아니면 전부 빨간 '오류'** 였다. v2.542 에 Unity 수집기를 명령 3개로 줄이면서
 * '이 수집 방식으로는 조회하지 않는다'(`미수집…`) 는 상태가 생겼는데, 그것이 빨간 '오류' 로
 * 그려졌다 — **색과 글자가 반대말을 하는** v2.526 `healthBadge` 와 같은 결함이다(사람은 색을
 * 먼저 읽는다). 조회하지 않은 것은 실패가 아니다.
 *
 * ⚠ `미수집` 을 `오류` 로 되돌리지 말 것. 반대로 **오류를 회색으로 덮지도 말 것** —
 * 부분 실패를 숨기지 않는 것이 이 배지 줄의 존재 이유다.
 * @param {string} v 섹션 값(`'ok'` · `'skip'` · `'미수집…'` · `'오류: …'`)
 * @returns {{tone:'green'|'gray'|'red', text:string, title:string}}
 */
/**
 * CLI 명령 한 줄의 **왜 끊겼나** 꼬리 문구(v2.543).
 *
 * ⚠⚠ **중단(abort)을 '응답 상한' 이라 말하지 말 것 — 조치가 정반대다.**
 * 응답 상한은 상한을 늘리면 되고 시한 초과는 시한을 늘리면 되지만, `[sudo] password for root:`
 * 처럼 **우리가 답할 수 없는 프롬프트**는 늘려도 영원히 안 된다(포탈은 root 비밀번호를 갖고
 * 있지 않고, 틀린 값을 반복하면 계정이 잠긴다). v2.542 까지 갈래가 둘뿐이라 sudo 중단이
 * `· 응답 상한으로 끊김` 으로 표시됐다 — 사용자가 상한을 늘리러 간다.
 */
export function cliCutText(x) {
  if (!x) return '';
  if (x.aborted) return ' · 중단됨(답할 수 없는 프롬프트)';
  if (x.timedOut) return ' · 시한 초과';
  if (x.truncated) return ' · 응답 상한으로 끊김';
  return '';
}

export function sectionBadge(v) {
  const s = String(v ?? '').trim();
  if (s === 'ok') return { tone: 'green', text: 'OK', title: '수집 성공' };
  if (s === 'skip') return { tone: 'gray', text: '건너뜀', title: '이 장비/버전에서는 해당 없음' };
  if (/^미수집/.test(s)) return { tone: 'gray', text: '미수집', title: s };
  return { tone: 'red', text: '오류', title: s || '사유 없음' };
}
