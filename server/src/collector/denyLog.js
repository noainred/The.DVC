/**
 * 수집 토큰 거부 기록(링버퍼) — v2.579 에 `routes/collector.js` 에서 분리(ARCH-03).
 *
 * `collector/agent.js`(export 본문을 만드는 도메인 모듈)가 이 통계를 export 에 싣는데, 그것이
 * **라우트 파일에 살아 있어** `collector/agent.js → routes/collector.js → collector/agent.js` 순환이었다.
 * 상태(거부 통계·최근 20건·출처 12개)는 도메인 상태이므로 여기가 주인이고, 라우트는 기록 함수를
 * 부르기만 한다. 라우트 파일은 같은 이름을 재수출한다(테스트 하니스 `collectorDiag2437` 호환).
 * 불변조건은 그대로다 — 토큰 값은 어떤 경로로도 담지 않는다(길이·8자 지문만).
 */
import { config } from '../config.js';
import { tokenFingerprint } from '../util/tokenFingerprint.js'; // v2.560: 토큰 지문 표기는 한 곳이 소유한다

// 인증 거부(403/404) 진단 로그 — 요청이 이 엣지에 '도달했는지'와 '왜 거부됐는지'를 남긴다.
// (기존엔 403이 무로그라, 엣지에서 '요청이 안 옴'과 '토큰 틀림'을 구분할 수 없었다 — WA-IRS 사례.)
// 토큰 값은 절대 남기지 않는다(길이만). (endpoint, src IP)별 30초 스로틀로 스팸 방지.
// deny 통계(관측성): 엣지에서 무음으로 삼켜지던 인증 거부를 집계해 export에 실어 중앙 UI가
// '이 엣지에 최근 토큰 거부 N건'을 보여줄 수 있게 한다(토큰 값은 절대 포함하지 않음).
const denyStats = { count: 0, lastAt: null, lastWhy: '', lastEndpoint: '' };
// v2.437: 중앙 화면이 '거부 N' 배지만 보여 주고 원인을 못 보여 줬다(툴팁에 마지막 사유 한 줄뿐,
// 출처 IP 는 엣지 콘솔 로그에만 있어 SSH 로 들어가야 했다). 최근 거부를 **엣지 안에서** 링버퍼로
// 들고 있다가 export 에 실어 중앙에서 바로 열어 볼 수 있게 한다.
//   · 토큰 값은 절대 담지 않는다(길이·앞 4글자 지문만 — 지문은 '어느 토큰인지' 구분용).
//   · 크기 상한: 최근 20건 + 출처 12개(고RTT 회선에서 export 본문이 커지지 않게).
const DENY_KEEP = 20, DENY_SRC_KEEP = 12;
const denyRecent = [];              // [{ at, endpoint, ip, why, tokenLen, fp, ua }] — 최신이 앞
const denyBySrc = new Map();        // ip → { ip, count, firstAt, lastAt, lastWhy, lastEndpoint }
/**
 * 토큰 지문 — v2.560 에 `util/tokenFingerprint.js` 로 승격했다. **여기서 다시 구현하지 말 것** —
 * 중앙의 토큰 점검 화면이 같은 표기를 쓰므로 두 벌이 되면 '엣지 거부 기록의 지문' 과 '중앙 화면의
 * 지문' 을 눈으로 맞춰 볼 수 없다(v2.528 credFingerprint 규약과 같은 이유).
 */
const tokenFp = (t) => tokenFingerprint(t);
export function getCollectorDenyStats() {
  return {
    ...denyStats,
    recent: denyRecent.slice(0, DENY_KEEP),
    bySrc: [...denyBySrc.values()].sort((a, b) => b.count - a.count).slice(0, DENY_SRC_KEEP),
  };
}
export function _resetCollectorDenyStats() {
  denyStats.count = 0; denyStats.lastAt = null; denyStats.lastWhy = ''; denyStats.lastEndpoint = '';
  denyRecent.length = 0; denyBySrc.clear(); _denyLogAt.clear();
}
const _denyLogAt = new Map();
export function logCollectorDeny(req, endpoint) {
  const ip = req.ip || req.socket?.remoteAddress || '?';
  const provided = req.get('X-Collector-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  // 사유는 세 갈래 — 이 구분이 해결 방법을 가른다(엣지 설정 / 요청자 헤더 누락 / 토큰 값 불일치).
  // 화면(상세 카드)용 문구와 콘솔 로그 문구를 분리한다 — 로그 문구는 운영 grep·기존 테스트가 고정한 계약이다.
  const why = !config.collector.token ? 'COLLECTOR_TOKEN 미설정(이 엣지의 수집 기능이 꺼져 있음)'
    : !provided ? '요청에 X-Collector-Token 헤더 없음'
      : '토큰 불일치';
  const logWhy = !config.collector.token ? 'COLLECTOR_TOKEN 미설정(collector 비활성)'
    : !provided ? '요청에 X-Collector-Token 없음'
      : '토큰 불일치';
  // 통계는 스로틀과 무관하게 매 거부마다 집계(로그만 스로틀).
  denyStats.count++;
  denyStats.lastAt = Date.now();
  denyStats.lastEndpoint = endpoint;
  denyStats.lastWhy = !config.collector.token ? 'COLLECTOR_TOKEN 미설정' : (provided ? '토큰 불일치' : '토큰 헤더 없음');
  const now = Date.now();
  denyRecent.unshift({
    at: now, endpoint, ip, why,
    tokenLen: provided ? provided.length : 0,
    fp: tokenFp(provided),
    ua: String(req.get('User-Agent') || '').slice(0, 80),
  });
  if (denyRecent.length > DENY_KEEP) denyRecent.length = DENY_KEEP;
  let src = denyBySrc.get(ip);
  if (!src) {
    // 백스톱: 출처가 무한히 늘지 않게(스캐너 대비) 가장 오래된 항목을 밀어낸다.
    if (denyBySrc.size >= DENY_SRC_KEEP * 4) {
      let oldest = null;
      for (const [k, v] of denyBySrc) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
      if (oldest) denyBySrc.delete(oldest[0]);
    }
    src = { ip, count: 0, firstAt: now, lastAt: now, lastWhy: '', lastEndpoint: '' };
    denyBySrc.set(ip, src);
  }
  src.count++; src.lastAt = now; src.lastWhy = why; src.lastEndpoint = endpoint;
  const key = `${endpoint}:${ip}`;
  if (now - (_denyLogAt.get(key) || 0) < 30_000) return;
  _denyLogAt.set(key, now);
  console.warn(`[collector] 인증 거부(${endpoint}) — src=${ip} · ${logWhy} · 요청토큰=${provided ? `제공됨(len=${provided.length})` : '없음'}`);
}
