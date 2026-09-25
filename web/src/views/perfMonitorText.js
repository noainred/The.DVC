/**
 * perfMonitorText.js — 설정 › 서버 성능 측정 화면의 **판정·문구**(순수, v2.498).
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가 — 판정과 문구는 여기서 고정한다.
 *
 * 핵심 판정: '느린 요청' 의 사유를 **기다림(wall)** 과 **막힘(stall)** 으로 나눠 말한다.
 * 고RTT vCenter 를 8초 기다린 요청은 정상이고, 동기 CPU 로 이벤트 루프를 막은 800ms 요청이
 * 진짜 튜닝 대상이다. 이 구분이 없으면 목록을 보고도 무엇을 고쳐야 할지 알 수 없다.
 */

import { unitText } from './unitText.js';
import { agoText } from './tools/relTime.js';

export const ms = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : (Number(v) >= 1000 ? `${(Number(v) / 1000).toFixed(Number(v) >= 10_000 ? 0 : 1)}초` : `${Math.round(Number(v))}ms`));
export const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v)}%`);
export const when = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '—');

/** 경과 시간(사람 말). */
// v2.613 DEPS2613-11: 상대시각은 공용 코어 relTime.agoText 하나다 — 호출부 이름(ago)만 남긴다.
export { agoText as ago };

/**
 * 느린 요청의 사유 라벨 — reason 은 서버가 붙인다('wall'|'stall'|'wall+stall').
 * 정직한 표현: 루프 정체는 **30초 창 단위**로만 관측되므로 '이 요청이 그만큼 막혔다' 가 아니라
 * '이 요청이 정체가 관측된 구간과 겹쳤다' 가 사실이다. 라벨과 도움말을 그 수준으로 맞춘다.
 */
export function reasonLabel(reason) {
  if (reason === 'stall') return { label: '루프 정체 겹침', color: 'red', help: '이 요청 구간이 이벤트 루프 정체가 관측된 30초 창과 겹쳤습니다 — 동기 CPU 작업(파싱·집계·대량 쓰기)이 후보입니다. 창 단위 관측이라 이 요청이 실제로 그만큼 막혔다는 증명은 아니며, 귀속 값은 요청 길이로 상한을 둡니다.' };
  if (reason === 'wall+stall') return { label: '오래 걸림 + 정체 겹침', color: 'red', help: '오래 걸렸고 그 구간이 루프 정체 창과도 겹쳤습니다 — 같은 요청 안의 동기 작업이 원인일 가능성이 큽니다(창 단위 관측).' };
  return { label: '오래 걸림', color: 'amber', help: '월타임만 길었습니다 — vCenter·SSH·DB 응답을 기다린 경우가 대부분이고(고RTT 사이트는 정상) 겹친 정체 창은 없었습니다.' };
}

/** 상태 배지 — 루프 최근 창 기준. */
export function loopBadge(last, hangLagMs = 1000) {
  if (!last) return { label: '데이터 없음', color: 'gray' };
  const m = Number(last.maxMs) || 0;
  if (m >= hangLagMs) return { label: '정체 관측', color: 'red' };
  if (m >= Math.max(100, hangLagMs / 2)) return { label: '주의', color: 'amber' };
  return { label: '정상', color: 'green' };
}

/**
 * 루프 계측이 꺼져 있거나 표본이 없을 때의 안내 — 원인을 단정하지 않는다(CLAUDE.md).
 * 반환 null 이면 정상(표시할 안내 없음).
 */
export function loopNote({ monitorEnabled = true, windowCount = 0, windowMs = 30_000 } = {}) {
  if (!monitorEnabled) return 'LOOP_LAG_MONITOR=0 으로 이벤트 루프 계측이 꺼져 있습니다 — 켜면(기본값) 30초마다 창 요약이 쌓입니다. 요청 지연 집계는 그와 무관하게 동작합니다.';
  if (!windowCount) return `아직 창 요약이 없습니다 — 계측은 ${Math.round(windowMs / 1000)}초마다 1건 쌓이므로 기동 직후에는 비어 있습니다. '지금 측정' 으로 현재 값을 바로 볼 수 있습니다.`;
  return null;
}

/** hang 이벤트 한 줄 요약 — kind 에 따라 무엇이 관측됐는지. */
export function hangSummary(ev) {
  if (!ev) return '';
  if (ev.kind === 'client') {
    const top = (ev.clientInflight || [])[0];
    const waited = top ? `대기 ${top.path} ${ms(top.ms)}${top.rid ? ` (요청 ID ${top.rid})` : ''}` : '대기 중인 요청 없음(화면 상태 문제 가능)';
    return `화면 ${ev.view || '—'} 에서 ${ms(ev.ms)} 동안 로딩 · ${waited} · 그때 서버 진행 중 요청 ${ev.serverInflightN ?? 0}건`;
  }
  const jobs = (ev.jobs || []).length ? ` · 진행 작업 ${(ev.jobs || []).join(', ')}` : ' · 계측된 작업 없음(수집·집계 밖의 코드일 수 있음)';
  return `이벤트 루프 최대 ${ms(ev.maxMs)} 멈춤(p99 ${ms(ev.p99Ms)})${jobs} · 진행 중 요청 ${ev.inflightN ?? 0}건 · RSS ${unitText(ev.rssMb, 'MB')}`;
}

/**
 * 요청 ID 검색(v2.583, 순수) — 로딩 화면에 보인 ID 로 느린 요청·hang·진행 중 목록을 거른다.
 * hang 이벤트는 ID 가 여러 곳에 있다(브라우저가 기다린 목록 · 그때 서버 진행 중 목록 · 루프 창의 진행 중).
 * 빈 검색어는 전부 통과. 대소문자는 구분하지 않고 부분 일치다(ID 뒤쪽만 옮겨 적어도 찾게).
 */
export function ridMatches(row, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  if (!row || typeof row !== 'object') return false;
  const hit = (v) => typeof v === 'string' && v.toLowerCase().includes(needle);
  if (hit(row.rid)) return true;
  for (const k of ['clientInflight', 'serverInflight', 'inflight']) {
    for (const x of Array.isArray(row[k]) ? row[k] : []) if (x && hit(x.rid)) return true;
  }
  return false;
}

/**
 * 서버의 요청 ID 조회 결과 한 줄(v2.583). 느린 요청 목록에는 임계를 넘은 것만 남으므로, 빠르게 끝난
 * 요청은 '최근 완료 기록' 으로만 확인된다. 기록이 없으면 원인을 단정하지 않는다.
 */
export function ridLookupText(rid, item) {
  if (!item || !item.state) return '';
  if (item.state === 'processing') return `${rid} — 지금 서버가 처리 중입니다(${ms(item.serverMs)}째 · ${item.method || ''} ${item.route || ''}).`;
  if (item.state === 'done') return `${rid} — 서버가 ${ms(item.serverMs)} 만에 응답을 끝냈습니다(상태 ${item.status || '—'} · ${item.method || ''} ${item.route || ''}).`;
  return `${rid} — 서버에 기록이 없습니다. 서버에 도달하지 않았거나, 서버가 재시작됐거나, 최근 완료 기록에서 밀려났습니다.`;
}

/** hang 종류 라벨. */
export const hangKindLabel = (k) => (k === 'client' ? '화면 로딩' : k === 'loop' ? '루프 정체' : String(k || '—'));

/**
 * '지금 측정' 결과 판정 — setImmediate 왕복이 곧 '내 요청이 얼마나 기다렸다 처리되는가' 다.
 * 기준은 관행적 값이며(문서화된 SLA 가 아니다) 화면에 그대로 밝힌다.
 */
export function measureVerdict(r) {
  if (!r || !r.ok) return { label: '측정 실패', color: 'gray', text: r?.reason || '알 수 없음' };
  const p95 = Number(r.immediate?.p95Ms);
  if (!Number.isFinite(p95)) return { label: '판정 불가', color: 'gray', text: '표본이 없습니다.' };
  if (p95 >= 100) return { label: '지연 큼', color: 'red', text: `setImmediate 왕복 p95 ${ms(p95)} — 이벤트 루프가 다른 동기 작업으로 붐비고 있습니다. 진행 작업 목록을 확인하세요.` };
  if (p95 >= 20) return { label: '주의', color: 'amber', text: `setImmediate 왕복 p95 ${ms(p95)} — 어느 정도 붐빕니다. 수집 주기와 겹쳤을 수 있습니다.` };
  return { label: '여유', color: 'green', text: `setImmediate 왕복 p95 ${ms(p95)} — 이벤트 루프는 한가합니다. 지금 느린 화면은 서버 루프 문제가 아닙니다.` };
}

/** 라우트 표의 '느림 비율'(%) — 건수 0 이면 null(0% 로 단정하지 않는다). */
export const slowRate = (r) => (r && r.n ? Math.round((r.slowN / r.n) * 1000) / 10 : null);

/** 라우트가 '기다리는 쪽' 인지 '막는 쪽' 인지 힌트(느린 요청 사유 분포로 판단). */
export function routeHint(route, slowRows = []) {
  const rows = (slowRows || []).filter((x) => x.route === route);
  if (!rows.length) return '';
  const stall = rows.filter((x) => String(x.reason || '').includes('stall')).length;
  if (stall === 0) return '대기형(외부 응답 기다림)';
  if (stall === rows.length) return '정체 겹침형(동기 작업 의심)';
  return `혼합(정체 겹침 ${stall}/${rows.length})`;
}
