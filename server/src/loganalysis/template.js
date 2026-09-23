/**
 * loganalysis/template.js — 메시지 → 태그·템플릿(v2.583, 순수).
 *
 * 같은 문장이 VM 이름·IP·숫자만 바뀌어 수천 번 찍힌다. 그것을 한 줄로 묶어야 '무엇이 반복되는가'
 * (= 개선 후보)가 보인다. 규칙은 보수적으로: 값처럼 보이는 것만 `<*>` 로 바꾸고 문장 뼈대는 남긴다.
 * 태그는 줄 맨 앞의 `[이름]` 이다(이 저장소의 로그 관례 — `[gpu-guest]`·`[collector]`·`[central]`).
 * HTTP 요청 줄(`GET /api/… 200 12ms #ID`)은 따로 해석한다 — 경로의 식별자를 가려 라우트 단위로 센다.
 */

const TAG_RE = /^\[([^\]\s]{1,40})\]/;
const HTTP_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S*) (\d{3}) (\d+)ms(?: #(\S+))?$/;

export function tagOf(msg) {
  const s = String(msg || '');
  const m = TAG_RE.exec(s);
  if (m) return m[1].toLowerCase();
  if (HTTP_RE.test(s)) return 'http';
  if (/^(?:uncaughtException|unhandledRejection)\b/.test(s)) return 'fatal';
  return '';
}

/** 경로의 식별자 세그먼트 마스킹(perf/stats.routeKeyOf 와 같은 뜻 — 숫자·UUID·긴 hex·콜론 포함). */
export function maskPath(p) {
  return String(p || '').split('?')[0].split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^[0-9a-f]{12,}$/i.test(seg) || seg.includes(':') || seg.includes('%')) return ':id';
    return seg;
  }).join('/').slice(0, 120);
}

/** HTTP 요청 줄 → `{ method, route, status, ms, rid }` | null. */
export function parseHttp(msg) {
  const m = HTTP_RE.exec(String(msg || ''));
  if (!m) return null;
  return { method: m[1], route: maskPath(m[2]), status: Number(m[3]), ms: Number(m[4]), rid: m[5] || '' };
}

/** 메시지 → 템플릿(값을 `<*>` 로). 길이 상한 160. */
export function templateOf(msg) {
  let s = String(msg || '').replace(TAG_RE, '').trim();
  s = s
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/'[^'\n]{0,200}'/g, "'<*>'")
    .replace(/"[^"\n]{0,200}"/g, '"<*>"')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(vm|host|datastore|domain-c|group-v|network|dvportgroup|resgroup)-\d+\b/g, '<moref>')
    .replace(/([^\s=,()[\]]{1,40})=[^\s,)\]]+/g, '$1=<*>')          // key=value(한글 키 포함)
    .replace(/([→✗✓])\s*[^\s:(]+/g, '$1 <*>')                     // → VM이름 / ✗ VM이름:
    .replace(/\b(?=[\w.-]*\d)(?=[\w.-]*[A-Za-z])[A-Za-z0-9][\w.-]{2,}\b/g, '<id>') // 숫자+문자 섞인 식별자(호스트명 등)
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/-?\d+(?:[.,]\d+)*/g, '<n>')
    .replace(/(?:<\*>|<n>|<id>)(?:[\s,/]*(?:<\*>|<n>|<id>))+/g, '<*>') // 연속 자리표시 하나로
    .replace(/\s+/g, ' ');
  return s.slice(0, 160);
}
