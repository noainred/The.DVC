/**
 * routes/api/perfClient.js — 브라우저의 '화면이 오래 불러오는 중' 보고 수신(v2.498).
 *
 * 왜 필요한가: 사용자 신고는 "'불러오는 중…' 이 3분 이상 지속된다" 였다. 서버 요청 계측만으로는
 * 이것을 설명할 수 없다 — 웹 GET 은 20초에 스스로 끊고 최대 3회 재시도(≈61초)라, 서버가 느린 것만
 * 으로는 3분이 구조적으로 나오지 않는다. 즉 상당수는 **뷰 로직이 스피너에 갇힌 경우**다. 그래서
 * 브라우저가 '그때 내가 무엇을 기다리고 있었는지' 를 보내고, 서버는 **그 시각의 서버 사실**
 * (진행 중 요청·이벤트 루프 창·활성 작업·RSS)을 붙여 hang 로그에 남긴다. 둘을 맞춰야 귀속이 된다.
 *
 * 권한·안전:
 *  - 인증된 사용자면 누구나 보고할 수 있다(조회 권한만 있는 계정도 hang 을 겪는다). api 라우터가
 *    이미 authMiddleware + requireEnrolled 를 거치므로 익명 접근은 없다.
 *  - 상태변경 RBAC(admin/operator) 대상이 아니다 — 인벤토리·설정을 바꾸지 않는 **유계 텔레메트리**다
 *    (읽기성 POST 와 같은 취급: /vms/usage 선례). 대신 아래 유량 방어를 둔다.
 *  - 사용자·IP 는 **본문에서 받지 않고 서버가 채운다**(위조 차단).
 *  - 사용자별 쿨다운(기본 60초) + hangLog 의 분당 상한(기본 60) + 파일 줄 수 상한 → 디스크 유계.
 *  - 본문은 경로·화면 해시·숫자만 받는다. 쿼리스트링·본문 데이터는 받지 않는다(검색어·id 유출 방지).
 */
import { recordClientStall, requestStatus } from '../../perf/monitor.js';
import { loadPerfSettings } from '../../perf/settings.js';
import { routeKeyOf } from '../../perf/stats.js';
import { clientIp } from '../../util/rateLimit.js';

const COOLDOWN_MS = Math.max(5_000, Math.min(600_000, Number(process.env.PERF_CLIENT_COOLDOWN_MS) || 60_000));
// 사용자당 시간당 상한 — 쿨다운만 두면 **계정 수·IP 축으로 분산해 우회**할 수 있다(쿨다운 키가
// user|ip 였다). 사용자 단독 키로 시간당 상한을 따로 걸어, 저권한 계정이 hang 기록을 자기 이벤트로
// 채워 서버 정체 기록을 밀어내지 못하게 한다(hangLog 의 종류별 분당 쿼터와 이중 방어).
const MAX_PER_USER_HOUR = Math.max(1, Math.min(200, Number(process.env.PERF_CLIENT_MAX_PER_HOUR) || 10));
const MAX_KEYS = 2_000;
const seen = new Map();     // `${user}|${ip}` -> lastTs (쿨다운)
const perUser = new Map();  // user -> { hour, n }

function throttled(user, ip, now) {
  const hour = Math.floor(now / 3_600_000);
  const u = perUser.get(user) || { hour, n: 0 };
  if (u.hour !== hour) { u.hour = hour; u.n = 0; }
  if (u.n >= MAX_PER_USER_HOUR) { perUser.set(user, u); return true; }
  const key = `${user}|${ip}`;
  const last = seen.get(key) || 0;
  if (now - last < COOLDOWN_MS) return true;
  if (seen.size >= MAX_KEYS) {
    // 가장 오래된 키를 정리(무한 증가 방지). Map 은 삽입 순서라 앞에서 지운다.
    for (const k of seen.keys()) { seen.delete(k); if (seen.size < MAX_KEYS) break; }
  }
  if (perUser.size >= MAX_KEYS) { const first = perUser.keys().next().value; if (first !== undefined) perUser.delete(first); }
  seen.set(key, now);
  u.n += 1; perUser.set(user, u);
  return false;
}

/**
 * 서버측 정규화 — '쿼리스트링·본문 데이터는 받지 않는다' 는 이 라우트의 계약을 **서버가 강제한다**.
 * 정규화가 브라우저에만 있으면 인증된 사용자가 curl 로 `?q=<검색어>&token=<값>` 이 붙은 문자열을
 * 보내 관리자 화면·NDJSON 에 영구 저장할 수 있다(적대적 리뷰 지적). 라우트 키와 같은 마스킹을 쓴다.
 */
const normPath = (v) => routeKeyOf({ path: String(v || '').split('?')[0].split('#')[0] }).slice(0, 200);
const normView = (v) => String(v || '').split('?')[0].slice(0, 120);

export function registerPerfClient(api) {
  /**
   * POST /perf/client-stall
   *   body { view, path, ms, inflight:[{path, ms}] }
   *   → 204(기록했거나, 계측이 꺼져 있거나, 쿨다운으로 버렸음 — 클라이언트는 구분할 필요가 없다)
   * 응답 본문이 없는 이유: 보고는 실패해도 화면 동작에 영향이 없어야 하고, 클라이언트가 결과에
   * 따라 분기할 것이 없다. 구버전 서버는 404 를 주므로 클라이언트가 그 세션 동안 보고를 멈춘다.
   */
  api.post('/perf/client-stall', (req, res) => {
    try {
      const st = loadPerfSettings();
      if (!st.enabled) return res.status(204).end();
      const user = req.user?.username || '';
      const ip = clientIp(req);
      if (throttled(user, ip, Date.now())) return res.status(204).end();
      const b = req.body || {};
      recordClientStall({
        user, ip,
        view: normView(b.view), path: normPath(b.path), ms: b.ms,
        inflight: (Array.isArray(b.inflight) ? b.inflight : []).slice(0, 10)
          .map((x) => ({ path: normPath(x?.path), ms: x?.ms, rid: x?.rid })),
        userAgent: req.get('user-agent') || '',
      });
    } catch { /* 보고 처리 실패는 조용히 — 화면에 영향 없음 */ }
    return res.status(204).end();
  });

  /**
   * GET /perf/client-config — 브라우저가 '몇 초부터 보고할지' 를 서버 설정에서 받는다.
   * 화면에 주기·임계를 하드코딩하지 않는다는 규칙(CLAUDE.md 프론트 회귀 방지)의 적용.
   */
  /**
   * GET /perf/req-status?ids=a,b,c — 로딩 화면이 오래 기다리는 요청의 서버 쪽 상태(v2.583).
   * 사용자 요청: "'불러오는 중…' 이 나올 때 누가 이 지연을 발생시켰는지 ID 도 같이 보여줘."
   * 응답 { at, items: { <id>: {state:'processing'|'done'|'unknown', serverMs?, status?, method?, route?} } }.
   * 소유자만 본다(관리자는 전부) — 판정은 monitor.requestStatus 하나가 갖는다. 최대 20개.
   * 인증된 사용자 누구나 부른다(자기 요청만 보인다 — 조회 권한만 있는 계정도 '불러오는 중' 을 겪는다).
   */
  api.get('/perf/req-status', (req, res) => {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
    const items = requestStatus(ids, { user: req.user?.username || '', isAdmin: req.user?.role === 'admin' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, at: Date.now(), items });
  });

  api.get('/perf/client-config', (_req, res) => {
    const st = loadPerfSettings();
    // clientDetailMs(v2.501): 화면이 '무슨 작업을 기다리는지' 를 보이기 시작하는 문턱. 3초를 뷰에
    // 하드코딩하면 설정에서 바꿔도 문구가 사실과 달라진다(루트 CLAUDE.md 프론트 회귀 방지).
    res.json({ enabled: st.enabled, clientStuckMs: st.clientStuckMs, clientDetailMs: st.clientDetailMs });
  });
}
