/**
 * dataFlowText.js — '데이터 흐름 지도' 의 문구·색(v2.587, 순수).
 *
 * 판정은 서버(`server/src/dataflow/build.js`)가 `state`·`kind`·`cat` 코드로 주고, 이 모듈은 **문장만** 만든다
 * (v2.553 규약). 코드 키 집합은 테스트가 서버와 대조한다 — 한쪽만 늘면 화면이 코드를 그대로 보여준다.
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다).
 */
import { ageText, spanText, bytesText } from './commMapText.js';

export { ageText, spanText, bytesText };

export const STATE_LABEL = Object.freeze({ ok: '정상', stale: '낡음', fail: '실패·거부', none: '기록 없음' });
export const STATE_COLOR = Object.freeze({ ok: '#d7dbe3', stale: '#e0a43a', fail: '#e5484d', none: '#5b6272' });
export const STATE_DOT = Object.freeze({ ok: '#3fb6a8', stale: '#e0a43a', fail: '#e5484d', none: '#5b6272' });

/** 방향(서버 KINDS 와 1:1). */
export const KIND_LABEL = Object.freeze({
  push: '엣지 → 중앙 · 자료 올림',
  reply: '엣지 → 중앙 · 작업 결과 회신',
  pull: '엣지 ← 중앙 · 설정·자료 가져감',
  job: '엣지 ← 중앙 · 작업 인출',
  cpull: '중앙 → 엣지 · 중앙이 가져옴',
  cpush: '중앙 → 엣지 · 중앙이 보냄(명령·번들)',
});
export const KIND_SHORT = Object.freeze({ push: '↑ push', reply: '↑ 회신', pull: '↓ pull', job: '↓ 작업', cpull: '⇠ 중앙 pull', cpush: '⇢ 중앙 push' });

/** 데이터 종류 머리띠 색(서버 CATS 와 1:1 + other). */
export const CAT_COLOR = Object.freeze({
  inv: '#2f7a4f', idrac: '#2c5f9e', gpu: '#6a4bb0', power: '#a8742a', storage: '#a05a2c',
  san: '#8a6d1f', watch: '#9b3a3a', users: '#2e7f86', ops: '#55606f', reg: '#4c5b86', other: '#6b3f6b',
});

/** 경로 표시 이름 — 중앙 수신은 /api/central, 중앙→엣지는 /api/collector 접두. */
export function routePath(r = {}) {
  return `${r.side === 'collector' ? '/api/collector' : '/api/central'}${r.path || ''}`;
}

/** 상단 한 줄 — 기록이 언제부터인지 밝힌다(인메모리 계측이라 중앙 재시작 뒤만 있다). */
export function sinceNote(data = {}, now = Date.now()) {
  const since = Number(data.since) || 0;
  const head = since ? `기록은 중앙이 시작된 뒤(${ageText(since, now)})부터만 있습니다` : '아직 기록이 없습니다';
  const parts = [`${head} — 그 전의 통신은 알 수 없고, 기록이 없는 경로는 **회색**이며 정상으로 칠하지 않습니다.`];
  if (Number(data.rejectsWithoutTime) > 0) parts.push(`거부 ${data.rejectsWithoutTime}건은 원문이 밀려나 시각을 몰라 선에 넣지 않았습니다(개수만 압니다).`);
  if (data.unmapped?.length) parts.push(`**분류되지 않은 경로 ${data.unmapped.length}개**가 있습니다 — ‘분류 안 됨’ 종류에 모았습니다.`);
  if (data.undeclared?.length) parts.push(`지금 라우터에 없는 경로로 온 기록 ${data.undeclared.length}개(구버전 엣지일 수 있습니다)도 함께 그렸습니다.`);
  const un = unauthNote(data, now);
  if (un) parts.push(un);
  const sh = sharedUrlNote(data);
  if (sh) parts.push(sh);
  return parts.join(' ');
}

/**
 * v2.600 WEB2600-04: 인증에 실패한 요청 집계 칸의 안내(없으면 ''). 이 칸은 엣지가 아니라 이름을 버리고 모은
 * 것이라 노드로 그리지 않는다 — 누가 보냈는지는 알 수 없고, 조치는 토큰 대조다.
 */
export function unauthNote(data = {}, now = Date.now()) {
  const u = data?.unauth;
  const cnt = Number(u?.count) || 0;
  if (!u || cnt <= 0) return '';
  const when = u.lastAt ? ` · 마지막 ${ageText(u.lastAt, now)}` : '';
  const routes = Array.isArray(u.routes) ? u.routes.length : 0;
  return `**인증에 실패한 요청 ${cnt}건**(경로 ${routes}개${when})은 엣지로 그리지 않았습니다 — 토큰이 맞지 않아 보낸 쪽을 알 수 없습니다. 포탈 점검 › 토큰 점검에서 각 엣지의 토큰을 대조하세요.`;
}

/**
 * v2.601(감사 WEB2601-02): 같은 주소(origin + 경로 접두)를 쓰는 수집 서버가 둘 이상이면 중앙 → 엣지 기록을 주소로는
 * 가를 수 없다. 서버는 호출부가 수집 서버를 아는 호출(태그)만 엣지별로 나누고, 나머지는 선에 넣지 않은 채
 * `sharedUrl` 로 밝힌다. 긴 설명은 여기 한 번(머리말), 카드에는 `sharedMark` 짧은 표지만.
 */
export function sharedUrlNote(data = {}) {
  const shared = (data.edges || []).filter((e) => Array.isArray(e.sharedUrlWith) && e.sharedUrlWith.length);
  if (!shared.length) return '';
  const labels = shortEdgeLabels(shared.map((e) => String(e.name || e.id)), 16);
  const names = labels.slice(0, 6).join(', ') + (labels.length > 6 ? ` 외 ${labels.length - 6}곳` : '');
  const rows = Array.isArray(data.sharedUrl) ? data.sharedUrl : [];
  const cnt = rows.reduce((a, r) => a + (Number(r.count) || 0), 0);
  const routes = new Set(rows.flatMap((r) => r.routes || [])).size;
  const tail = rows.length
    ? `그 밖의 중앙 → 엣지 호출 ${cnt}회(경로 ${routes}개)는 어느 엣지의 것인지 몰라 선에 넣지 않았습니다.`
    : '어느 엣지의 것인지 모르는 기록은 지금 없습니다.';
  return `**같은 주소를 쓰는 엣지 ${shared.length}곳**(${names}) — 중앙이 수집 서버를 알고 부르는 호출(인벤토리 pull 등)은 엣지별로 나눴고, ${tail} 설정 › 수집 서버에서 주소가 맞는지 확인하세요.`;
}

/** 엣지 카드의 짧은 표지('주소 공유') — 없으면 ''. */
export function sharedMark(e = {}) {
  return Array.isArray(e.sharedUrlWith) && e.sharedUrlWith.length ? '주소 공유' : '';
}

/** 연결 한 줄의 설명. */
export function linkText(l = {}, now = Date.now()) {
  const st = STATE_LABEL[l.state] || l.state;
  const bits = [`${st} · 마지막 ${ageText(l.lastAt, now)}`];
  if (l.intervalMs) bits.push(`간격 약 ${spanText(l.intervalMs)}`);
  if (l.count) bits.push(`${l.count}회`);
  if (l.state === 'fail' && l.reason) bits.push(`사유 ${l.reason}`);
  if (l.unverified) bits.push('이름 미검증');
  return bits.join(' · ');
}

/** 엣지 카드 배지. */
export function edgeBadge(e = {}) {
  if (!e.registered) return { text: '등록부에 없음', tone: 'bad' };
  if (e.enabled === false) return { text: '비활성', tone: 'muted' };
  if (!e.used) return { text: '기록 없음', tone: 'muted' };
  if (e.fail) return { text: `실패 ${e.fail}`, tone: 'bad' };
  if (e.stale) return { text: `낡음 ${e.stale}`, tone: 'warn' };
  return { text: '정상', tone: 'ok' };
}
export const TONE_HEAD = Object.freeze({ bad: '#8f2f33', warn: '#7c5a1c', ok: '#23484a', muted: '#3a4150' });

/** 엣지 한 곳에서 마지막 push / pull / 중앙 호출 시각. */
export function edgeLasts(edgeId, links = [], routesById = new Map()) {
  const out = { up: 0, down: 0, central: 0 };
  for (const l of links) {
    if (l.edge !== edgeId) continue;
    const k = routesById.get(l.route)?.kind;
    const slot = k === 'push' || k === 'reply' ? 'up' : k === 'pull' || k === 'job' ? 'down' : 'central';
    if (l.okAt > out[slot]) out[slot] = l.okAt;
  }
  return out;
}

/**
 * 엣지 내부 수집 항목 한 줄 요약(엣지 로그 pull 의 status 항목 — 값은 모듈마다 모양이 다르다).
 * ⚠ 값에서 **시각·오류가 명시된 것만** 꺼낸다. 없으면 '실행 기록 없음' 이라 말하고 정상이라 단정하지 않는다.
 */
export function innerItemText(it = {}, now = Date.now()) {
  if (it.ok === false) return { tone: 'bad', text: `확인하지 못함 — ${it.error || '사유 미상'}` };
  const v = it.value && typeof it.value === 'object' ? it.value : {};
  // 모듈마다 '마지막 실행' 을 담는 자리가 다르다(v2.587 실측: last · lastRun · lastResult · at · lastRunTs …).
  const rec = [v.last, v.lastRun, v.lastResult].find((x) => x && typeof x === 'object') || {};
  // ⚠ 시각은 숫자이거나 숫자 문자열일 때만 — '' 를 0 시각으로 읽지 않는다(Number('') === 0).
  //   v2.591 C1: ISO 문자열(`generatedAt` — 인벤토리 폴러)도 받는다. 단 **숫자 문자열은 Date.parse 에 넘기지
  //   않는다**(`Date.parse('12345')` 는 연도 12345 — v2.562 규약). ISO 날짜 꼴일 때만 해석한다.
  const tsOf = (x) => {
    if (typeof x === 'number') return x > 1e12 ? x : 0;
    if (typeof x !== 'string' || x.trim() === '') return 0;
    if (/^\d+$/.test(x.trim())) return Number(x) > 1e12 ? Number(x) : 0;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(x.trim())) return 0;
    const t = Date.parse(x);
    return Number.isFinite(t) && t > 1e12 ? t : 0;
  };
  const at = [rec.at, v.at, v.lastAt, v.lastRunTs, v.lastRunAt, v.lastTickAt, v.lastTick, v.lastPollAt, v.finishedAt, v.generatedAt].map(tsOf).find((x) => x) || 0;
  const str = (x) => (typeof x === 'string' ? x : '');
  const failText = (o) => str(o.reason) || str(o.error) || (o.status ? `HTTP ${o.status}` : '실패');
  // v2.591 C1: 최상위 `{at, ok:false, reason}` 모양(selfRegister·pdu push·pdu 설정 pull)도 실패다 — 예전에는
  //   rec(last/lastRun/lastResult) 의 ok 만 봐서 실패한 push 가 초록 '마지막 N분 전' 으로 보였다.
  const err = str(v.lastPollError?.detail) || str(v.lastError?.detail) || str(v.lastError) || str(v.lastErr) || str(v.error) ||
    str(rec.error) || (Array.isArray(rec.errors) && rec.errors.length ? `오류 ${rec.errors.length}건` : '') ||
    (rec.ok === false ? failText(rec) : '') || (v.ok === false ? failText(v) : '') || str(v.pushError);
  const bits = [];
  if (v.running === true || v.inFlight === true || v.busy === true) bits.push('실행 중');
  if (at) bits.push(`마지막 ${ageText(at, now)}`);
  if (Number(rec.failed) > 0 || Number(v.failed) > 0) bits.push(`실패 ${Number(rec.failed) || Number(v.failed)}`);
  if (err) return { tone: 'bad', text: [...bits, String(err).slice(0, 160)].join(' · ') };
  const skipped = str(rec.skipped);
  if (skipped) return { tone: 'muted', text: [...bits, `건너뜀(${skipped})`].join(' · ') };
  if (v.enabled === false) return { tone: 'muted', text: [...bits, '꺼짐'].join(' · ') };
  if (!at && !bits.length) return { tone: 'muted', text: '실행 기록 없음(또는 시각을 싣지 않는 항목)' };
  const note = str(rec.reason) || str(rec.note);
  return { tone: 'ok', text: [...bits, ...(note ? [note.slice(0, 80)] : [])].join(' · ') };
}

/**
 * 엣지 ↔ MAIN 두 가닥(v2.591) — **데이터가 가는 방향**이다(사용자 선택). 누가 요청했는지가 아니다:
 * 메인이 엣지에서 가져온 자료(cpull)는 엣지 → 메인, 엣지가 메인에서 가져간 설정(pull)은 메인 → 엣지다.
 * 방향별 종류 집합은 `dataFlowLayout.js UP_KINDS·DOWN_KINDS` 가 소유한다.
 */
export const DIR_LABEL = Object.freeze({ up: '엣지 → 메인', down: '메인 → 엣지' });
export const DIR_ARROW = Object.freeze({ up: '↑', down: '↓' });
export const DIR_KINDS_TEXT = Object.freeze({
  up: 'push · 결과 회신 · 메인이 가져옴',
  down: '설정·자료 가져감 · 작업 인출 · 메인이 보냄',
});

/**
 * MAIN 카드·상세 표의 방향 칸 — `edgeDirections()` 결과 하나를 짧은 글자와 긴 설명으로.
 * ⚠ 기록이 없으면 '—' 이고 정상이라 말하지 않는다. 실패는 '실패' 와 사유(설명)로 — 시각만 보여주면 초록처럼 읽힌다.
 */
export function dirCellText(d = {}, now = Date.now()) {
  const state = d.state || 'none';
  const counts = `정상 ${d.ok || 0} · 낡음 ${d.stale || 0} · 실패 ${d.fail || 0}`;
  if (state === 'none' || !d.links) return { text: '—', short: '—', title: '이 방향으로 오간 기록이 없습니다(정상이라는 뜻이 아닙니다).', state: 'none' };
  const recent = d.okAt ? `가장 최근 성공 ${ageText(d.okAt, now)}` : '성공 기록 없음';
  const unv = d.worstUnverified ? ` · 그중 ${d.worstUnverified}개는 이름 미검증(요청이 주장한 이름)` : '';
  if (state === 'fail') {
    const rs = Array.isArray(d.reasons) && d.reasons.length ? d.reasons : (d.reason ? [d.reason] : []);
    const why = rs.length ? ` · 사유 ${rs.slice(0, 3).join(' / ')}${rs.length > 3 ? ` 외 ${rs.length - 3}가지` : ''}` : '';
    return { text: '실패', short: '실패', title: `실패 ${d.fail || 0}개(마지막 ${ageText(d.failAt || d.lastAt, now)})${why}${unv} · ${recent} · 연결 ${d.links}개(${counts})`, state };
  }
  if (state === 'stale') {
    // 낡음 칸의 시각은 **낡은 연결의 마지막 성공**이다 — 다른 연결의 최근 성공을 보이면 주황 점 옆에 '30초' 가 뜬다.
    const at = d.worstOkAt || 0;
    const text = at ? ageText(at, now) : '—';
    return { text, short: text.replace(/\s*전$/, ''), title: `낡음 ${d.stale || 0}개 · 낡은 연결의 마지막 성공 ${at ? ageText(at, now) : '없음'}${unv} · ${recent} · 연결 ${d.links}개(${counts})`, state };
  }
  const at = d.okAt || d.lastAt;
  const text = at ? ageText(at, now) : '—';
  // short — MAIN 카드의 좁은 칸용(열 머리가 '경과' 라 '전' 을 뺀다: '12초 전' → '12초').
  return { text, short: text.replace(/\s*전$/, ''), title: `${STATE_LABEL[state] || state} · ${recent} · 연결 ${d.links}개(${counts})`, state };
}

/**
 * MAIN 카드 엣지 목록의 짧은 이름(v2.591 검토). 칸이 좁아 앞부분만 쓰면 'LGES-HG01'·'LGES-HG02' 가 둘 다 'LGES-HG…' 로
 * 보여 어느 엣지가 실패인지 알 수 없다(v2.511 WWN labelMap 과 같은 유형). 앞부분이 겹치는 것만 **뒷부분**으로 바꾸고,
 * 그래도 겹치면 원래 이름(말줄임은 화면이 한다)을 쓴다. 전체 이름은 title 로 남긴다.
 */
export function shortEdgeLabels(names = [], max = 10) {
  const head = (n) => (n.length <= max ? n : `${n.slice(0, max - 1)}…`);
  const tail = (n) => (n.length <= max ? n : `…${n.slice(-(max - 1))}`);
  const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const h = names.map(head); const hc = count(h);
  const t = names.map((n, i) => (hc.get(h[i]) > 1 ? tail(n) : h[i]));
  const tc = count(t);
  return names.map((n, i) => (tc.get(t[i]) > 1 ? n : t[i]));
}

/** MAIN 카드 합계 한 줄(엣지 수 기준). */
export function dirSumText(s = {}) {
  return `정상 ${s.ok || 0} · 낡음 ${s.stale || 0} · 실패 ${s.fail || 0} · 없음 ${s.none || 0}`;
}

export const LEGEND = Object.freeze([
  '선은 **기록이 있는 연결만** 그립니다. 굵은 빨간 선은 마지막 실패가 마지막 성공보다 뒤인 연결, 주황은 관측 간격의 {factor}배(하한 {min})를 넘겨 새 기록이 없는 연결입니다.',
  '가운데 버스의 눈금 하나가 경로 하나입니다. 회색 눈금은 중앙이 기록을 한 번도 받지 못한 경로입니다 — 쓰지 않는 기능일 수도, 막혀 있을 수도 있습니다.',
  '거부된 요청의 엣지 이름은 요청이 주장한 값이라 **검증되지 않았습니다**. 공유 토큰으로 가져간 pull 도 같습니다.',
  '엣지 **안의** 수집 상태는 엣지 카드의 ‘내부 수집’ 버튼을 누를 때만 그 엣지에서 가져옵니다.',
  '엣지와 **MAIN** 사이 두 가닥은 **데이터가 가는 방향**입니다 — 메인을 향하는 화살표는 push·결과 회신·메인이 가져간 자료, 엣지를 향하는 화살표는 엣지가 가져간 설정·자료·작업과 메인이 보낸 명령입니다. 선 색은 그 방향 연결 중 가장 나쁜 상태이고, 기록이 없으면 회색 점선입니다.',
  '엣지 카드의 ‘↑ 올림 · ↓ 가져감 · ⇄ 중앙 호출’ 은 **요청한 쪽** 기준이라 MAIN 선의 방향과 축이 다릅니다 — 메인이 엣지에서 가져온 자료는 카드에서는 ‘중앙 호출’, 선에서는 메인을 향합니다.',
]);

/**
 * 범례 — 낡음 경계는 서버가 주는 값(`rules.staleFactor`·`staleMinMs`)으로 채운다(v2.589: 숫자를 박아 두면
 * 서버 상수를 바꾼 날 화면이 거짓말을 한다). 값이 없으면 숫자를 지어내지 않고 '서버 설정' 이라 말한다.
 */
export function legendLines(rules = {}) {
  const factor = Number.isFinite(rules?.staleFactor) ? String(rules.staleFactor) : '(서버 설정)';
  const min = Number.isFinite(rules?.staleMinMs) ? spanText(rules.staleMinMs) : '서버 설정';
  return LEGEND.map((s) => s.replace('{factor}', factor).replace('{min}', min));
}
