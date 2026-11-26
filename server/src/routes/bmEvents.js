/**
 * routes/bmEvents.js — 물리서버 장애 바로 받기(v3.52 · ⑬) — 장비(iDRAC)가 보내는 Redfish 이벤트를 받는다. **사용자 인증이 없다**(index.js 가 authMiddleware 없이 단다).
 *  · POST /api/bm-events/in/:secret — 비밀이 틀리거나 꺼져 있으면 **본문을 읽기 전에** 404(있는지 밝히지 않는다).
 *  · 본문 64KB(EVT_BODY_MAX) · 꼴이 아니면 400 · Context HMAC 이 틀리면 404(서버를 모름). 받으면 202 — 처리(바로 점검)는 묶어서 뒤에.
 *  · 장비가 다시 보낼 수 있으니 응답은 짧게(본문 없음).
 *  · 경로의 비밀은 요청 기록 · 오류 기록에 싣지 않는다(index.js scrubEventPath).
 */
import express from 'express';
import { wrapAsyncRouter } from '../util/asyncRoute.js';
import { eventSubStore, secretOk, parseEventBody, acceptEvents, noteRejected, idOfContext, EVT_BODY_MAX } from '../idrac/eventSub.js';

export const bmEventsRouter = express.Router();
wrapAsyncRouter(bmEventsRouter);   // async 처리기 예외가 응답 없이 매달리지 않게(asyncHang2574 스윕)
/** 등록부의 켜진 서버 이름 — 없으면 null(등록부에 없는 id 는 받지 않는다 — 반증 A9). */
const nameOf = async (id) => {
  try { const { loadRegistry } = await import('../idrac/registry.js'); const e = loadRegistry().find((x) => String(x.id) === id && x.enabled !== false); return e ? String(e.name || e.id) : null; } catch { return null; }
};
bmEventsRouter.post('/in/:secret', (req, res, next) => {
  const s = eventSubStore.get();
  if (!secretOk(s, req.params.secret)) { noteRejected(); return res.status(404).end(); }
  req._evSettings = s;
  return next();
}, express.json({ limit: EVT_BODY_MAX, type: () => true }), async (req, res) => {
  try {   // Express 4 는 async 오류를 받지 않는다 — 던지면 응답 없이 소켓이 남는다(반증 A6)
    const s = req._evSettings;
    const p = parseEventBody(req.body);
    if (!p) { noteRejected(); return res.status(400).end(); }
    const id = idOfContext(s, p.context);
    const name = id ? await nameOf(id) : null;
    if (!id || name == null) { noteRejected(); return res.status(404).end(); }
    const r = acceptEvents(s, p, { name });
    return res.status(r.ok ? 202 : 404).end();
  } catch { if (!res.headersSent) res.status(400).end(); return undefined; }
});
// 그 밖의 경로 · 방법은 404(비밀 없는 주소에 무엇이 있는지 밝히지 않는다)
bmEventsRouter.use((_req, res) => res.status(404).end());
