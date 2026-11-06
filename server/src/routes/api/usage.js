/**
 * routes/api/usage.js — 기능 사용 추적 수신(v2.913, 설계 docs/design/feature-usage §4.4).
 *
 * `POST /usage/track { k, hit?, ms? }` — 화면이 주소를 바꿀 때(hit:true) · 보고 있는 동안 30초마다(ms) 부른다.
 *
 * 권한: **로그인 사용자 전부**(viewer 포함). 서버 불변조건 '/api 상태변경은 requireRole(admin, operator)' 은 다른 사람 · 장비에 닿는 상태를
 *   말한다 — 이 신호는 `POST /tool-usage`(사용 횟수)와 같이 **자기 화면 사용 기록**이고 아무 권한도 넓히지 않는다. 그래서 감사 로그에서 빼고
 *   (audit.js AUDIT_SKIP — 데모 계정의 쓰기 차단도 이 목록을 보지만 데모 계정은 store 가 버린다) 결과를 그대로 200 으로 돌려준다(화면은 결과를 보지 않는다).
 * 계정은 `req.user` 로만 적는다 — 본문에 계정 칸이 없고, 있어도 읽지 않는다. 키 · 상한 · 제외 · 꺼짐 판정은 usage/store.js recordUsage 하나.
 * 조회 · 설정 · 지우기는 routes/admin/usage.js(설정 소유자 = 소유자 ∧ 전체 범위).
 */
import { recordUsage } from '../../usage/store.js';

export function registerUsage(api) {
  api.post('/usage/track', (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    res.json(recordUsage({ user: req.user, k: b.k, hit: b.hit, ms: b.ms }));
  });
}
