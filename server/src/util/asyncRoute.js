/**
 * `asyncRoute` / `wrapAsyncRouter` — express 4 에서 **async 핸들러의 throw 를 전역 에러
 * 핸들러로 보낸다**. (v2.574, 2026-09-21 감사 BUG-01·BUG-02·BUG-03)
 *
 * ⚠⚠ **express 4 는 async 핸들러의 rejection 을 잡지 않는다.** 동기 throw 는 express 가
 * try/catch 로 받아 `next(err)` 로 보내지만, `async (req,res) => { throw … }` 는 그냥
 * 거부된 프라미스가 되어 **아무도 응답하지 않는다** — 그 요청은 클라이언트가 끊을 때까지
 * 영원히 매달리고 소켓 fd 를 잡는다. `index.js` 의 `process.on('unhandledRejection')` 은
 * 로그만 남기고 계속 실행하므로 프로세스는 죽지 않는다(그래서 더 안 보인다).
 *
 * 실측(2026-09-21 감사, express 4.22.2 실제 기동):
 *   · 동기 throw            → 전역 핸들러 500 ✓
 *   · **async throw**       → **응답 없음**(curl `code=000`, 시한까지 대기) ✗
 *   · `GET /api/tools/pdu/series/power?ids=x&hours=1e400` → 무응답 · 요청 40개에 **fd 111→151**
 *   · `POST /api/svcmon/push-now`(중앙 불통) → 무응답 20초. 형제 `config-pull-now` 는 202/4ms
 *
 * 스윕 결과 `routes/` 의 async 라우트 **284건 중 138건**이 try/catch 없이 노출돼 있었다.
 * 138곳을 손으로 감싸면 다음에 추가되는 라우트가 또 빠지므로, **라우터 단위로 한 번** 감싼다.
 *
 * ⚠ **`next(err)` 로 보낸다 — 여기서 직접 응답하지 않는다.** `index.js` 의 전역 에러
 * 핸들러가 이미 ① 스택을 클라이언트에 노출하지 않고(finalhandler 의 development 기본값 우회)
 * ② `pushLog` 로 기록하며 ③ `res.headersSent` 를 본다. 그 판정을 두 곳이 갖게 하지 않는다
 * (CLAUDE.md '코어는 하나다').
 *
 * ⚠ **`wrapAsyncRouter` 는 HTTP 메서드(get/post/…)만 감싸고 `use` 는 건드리지 않는다.**
 * `use` 로는 **하위 라우터**(그 자체가 `(req,res,next)` 함수다)가 마운트되는데, 그것을 감싸면
 * 라우터 객체의 속성이 사라진 평범한 함수가 되어 마운트가 깨진다. 하위 라우터는 **그 라우터를
 * 만든 곳에서 각자** `wrapAsyncRouter` 를 부른다.
 *
 * ⚠ 4-인자 에러 핸들러(`(err,req,res,next)`)는 감싸지 않는다 — 감싸면 인자 개수가 3 이 되어
 * express 가 **에러 핸들러로 인식하지 못하고** 일반 미들웨어로 취급한다.
 */

/** 한 핸들러를 감싼다. 동기 throw 와 async reject 를 **둘 다** `next(err)` 로 보낸다. */
export function asyncRoute(handler) {
  if (typeof handler !== 'function') return handler;
  if (handler.length >= 4) return handler;            // 에러 핸들러는 그대로
  if (handler.__asyncWrapped) return handler;         // 이중 래핑 방지(멱등)
  const wrapped = (req, res, next) => {
    /*
     * ⚠⚠ **핸들러를 동기로 호출한다** — `Promise.resolve().then(() => handler(...))` 로 감싸면
     * 동기 핸들러의 실행이 마이크로태스크로 밀려 **호출 시점이 바뀐다**. 이 저장소에는 라우터
     * 스택에서 핸들러를 꺼내 **동기로 부르고 바로 단언하는** 테스트 하니스가 있다
     * (`test/collectorDiag2437.test.js:23`) — v2.574 초판이 실제로 그것을 깨뜨렸다(6통과 → 3실패).
     * 동기 throw 는 express 가 이미 잡으므로 여기서 미룰 이유도 없다.
     *
     * 그래서 ① 동기로 부르고 ② 던지면 그대로 `next(err)` ③ **thenable 을 돌려주면** 거기에만
     * `.catch` 를 건다. async 함수든 프라미스를 반환하는 동기 함수든 둘 다 덮인다.
     */
    let out;
    try {
      out = handler(req, res, next);
    } catch (err) {
      try { next(err); } catch { /* next 가 던지면 더 할 수 있는 것이 없다 */ }
      return undefined;
    }
    if (out && typeof out.then === 'function') {
      // 이미 응답이 나갔으면 전역 핸들러가 소켓을 파기한다 — 그쪽에 맡긴다.
      out.then(undefined, (err) => { try { next(err); } catch { /* 위와 같다 */ } });
    }
    return out;
  };
  wrapped.__asyncWrapped = true;
  // v2.614(아키텍처 점검): 게이트 태그(`requireRole`·`requirePerm`·`fullScopeOnlyWith`·`toolGate`·`requireCentral` 이 붙인
  //   `.gate`)를 래퍼에 복사한다 — 안 하면 `wrapAsyncRouter` 를 지난 라우터 스택에서 태그가 통째로 사라진다(테스트가 고정).
  if (handler.gate) wrapped.gate = handler.gate;
  // 디버깅·스택에서 원래 이름이 보이게 한다(익명 래퍼만 남으면 어느 라우트인지 못 찾는다).
  try { Object.defineProperty(wrapped, 'name', { value: handler.name || 'asyncRoute' }); } catch { /* 이름 고정 실패는 무시 */ }
  return wrapped;
}

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];

/**
 * 라우터(또는 app)의 HTTP 메서드를 감싸 **이후에 등록되는 모든 핸들러**를 보호한다.
 * 라우트를 등록하기 **전에** 부를 것 — 이미 등록된 것은 감싸지 않는다.
 * @template T
 * @param {T} router express Router 또는 app
 * @returns {T} 같은 객체(체이닝용)
 */
export function wrapAsyncRouter(router) {
  if (!router || router.__asyncRouterWrapped) return router;
  for (const verb of VERBS) {
    const orig = router[verb];
    if (typeof orig !== 'function') continue;
    router[verb] = function patched(...args) {
      return orig.apply(this, args.map((a) => (typeof a === 'function' ? asyncRoute(a) : a)));
    };
  }
  try { Object.defineProperty(router, '__asyncRouterWrapped', { value: true, enumerable: false }); } catch { /* 프리즈된 객체면 무시 */ }
  return router;
}
