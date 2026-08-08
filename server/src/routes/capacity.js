/**
 * Capacity Advisor API — 포탈/엣지 호스트 리소스 실측·평가·권고 조회.
 *
 * **admin 전용**(index.js mount 에서 requireRole('admin') — 호스트 스펙·증설 판단은 운영
 * 인프라 정보라 viewer/operator 에 열지 않는다. specialToolsList 의 adminOnly 는 UX 게이트일
 * 뿐이므로 서버에서 반드시 강제한다: CLAUDE.md '기능 권한은 서버가 진실의 원천').
 *
 * 조회 전용(상태변경 라우트 없음). 응답은 res.json 경로만 사용 — util/compress.js 래퍼가
 * ETag/304 를 자동 처리한다(res.send/스트리밍으로 바꾸면 304 최적화가 죽는다).
 */

import express from 'express';
import { requireRole } from '../auth/auth.js';
import { getCapacityDb } from '../capacity/db.js';
import { evaluateHost, summarizeHosts, WINDOWS } from '../capacity/evaluate.js';
import { capacitySamplerStatus } from '../capacity/sampler.js';
import { capacityPushStatus } from '../agent/capacityPush.js';
import { collectorMeta } from '../capacity/collectors.js';

export const capacityRouter = express.Router();
const adminOnly = requireRole('admin');
capacityRouter.use(adminOnly);

/** 호스트 키 검증 — 'local' 또는 엣지 agent 이름(수신 시 이미 바인딩 검증됨). 경로 주입 방지용 형식 검사만. */
const cleanKey = (v) => {
  const k = String(v || '').trim().slice(0, 100);
  return k && !k.includes('\0') ? k : '';
};

/** 전 호스트 요약(1달 창 축 종합) + 샘플러/push 상태. 목록 화면의 단일 폴링 엔드포인트. */
capacityRouter.get('/summary', async (req, res) => {
  try {
    const hosts = await summarizeHosts();
    res.json({
      hosts,
      windows: WINDOWS.map((w) => ({ key: w.key, label: w.label })),
      collectors: collectorMeta(),
      sampler: capacitySamplerStatus(),
      push: capacityPushStatus(),
      generatedAt: Date.now(),
    });
  } catch (e) { res.status(500).json({ error: `요약 실패: ${e.message}` }); }
});

/** 호스트 1대 상세 — 창(1일/1주/1달)별 지표 통계·판정·권고 문장. */
capacityRouter.get('/host', async (req, res) => {
  const k = cleanKey(req.query.k);
  if (!k) return res.status(400).json({ error: '호스트 키(k)가 필요합니다.' });
  try {
    const r = await evaluateHost(k);
    if (!r) return res.status(404).json({ error: `호스트를 찾을 수 없습니다: ${k}` });
    res.json(r);
  } catch (e) { res.status(500).json({ error: `평가 실패: ${e.message}` }); }
});

/** 추세 차트 — metric × 호스트 × 창. 버킷은 창에 맞춰 서버가 정한다(1일=10분, 1주=1시간, 1달=4시간). */
const WINDOW_BUCKETS = { day: 10 * 60_000, week: 3600_000, month: 4 * 3600_000 };
capacityRouter.get('/history', async (req, res) => {
  const k = cleanKey(req.query.k);
  const metric = String(req.query.metric || '').trim();
  const win = WINDOWS.find((w) => w.key === req.query.window) || WINDOWS[0];
  if (!k) return res.status(400).json({ error: '호스트 키(k)가 필요합니다.' });
  if (!collectorMeta().some((m) => m.key === metric)) return res.status(400).json({ error: `알 수 없는 지표: ${metric.slice(0, 40)}` });
  try {
    const db = await getCapacityDb();
    const points = db.history(metric, k, Date.now() - win.ms, WINDOW_BUCKETS[win.key], 400);
    res.json({ metric, k, window: win.key, points });
  } catch (e) { res.status(500).json({ error: `조회 실패: ${e.message}` }); }
});
