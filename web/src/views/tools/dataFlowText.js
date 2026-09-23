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
  return parts.join(' ');
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
  const tsOf = (x) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) && Number(x) > 1e12 ? Number(x) : 0;
  const at = [rec.at, v.at, v.lastAt, v.lastRunTs, v.lastRunAt, v.lastTickAt, v.lastTick, v.lastPollAt, v.finishedAt].map(tsOf).find((x) => x) || 0;
  const str = (x) => (typeof x === 'string' ? x : '');
  const err = str(v.lastPollError?.detail) || str(v.lastError?.detail) || str(v.lastError) || str(v.lastErr) || str(v.error) ||
    str(rec.error) || (Array.isArray(rec.errors) && rec.errors.length ? `오류 ${rec.errors.length}건` : '') ||
    (rec.ok === false ? (str(rec.reason) || (rec.status ? `HTTP ${rec.status}` : '실패')) : '') || str(v.pushError);
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

export const LEGEND = Object.freeze([
  '선은 **기록이 있는 연결만** 그립니다. 굵은 빨간 선은 마지막 실패가 마지막 성공보다 뒤인 연결, 주황은 관측 간격의 3배(하한 10분)를 넘겨 새 기록이 없는 연결입니다.',
  '가운데 버스의 눈금 하나가 경로 하나입니다. 회색 눈금은 중앙이 기록을 한 번도 받지 못한 경로입니다 — 쓰지 않는 기능일 수도, 막혀 있을 수도 있습니다.',
  '거부된 요청의 엣지 이름은 요청이 주장한 값이라 **검증되지 않았습니다**. 공유 토큰으로 가져간 pull 도 같습니다.',
  '엣지 **안의** 수집 상태는 엣지 카드의 ‘내부 수집’ 버튼을 누를 때만 그 엣지에서 가져옵니다.',
]);
