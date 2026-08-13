/**
 * 성능점검 API 집계 라우터 — v2.291.0 대형 파일 분할(구 1,053줄 → ./svcmon/ 8개 도메인 모듈).
 * routes/api.js(v2.283)·routes/admin.js(v2.285) 와 같은 규약: 원 경로는 셸로 남아 이 파일의
 * import 경로(index.js `app.use('/api/svcmon', svcmonRouter)`)가 바뀌지 않고, 도메인 구현은
 * ./svcmon/*.js 의 register*(router) 로 이동했다. 본문은 원본 그대로(기능 변화 없음).
 *
 * 공통 규칙(원본 헤더에서 이관): 조회는 로그인 사용자, 변경은 admin/operator(CLAUDE.md RBAC
 * 불변조건 — 게이트는 ./svcmon/shared.js 의 canEdit/adminOnly). 응답은 res.json 래퍼가
 * ETag/304 를 처리하므로 무변동 폴링은 본문 0바이트다.
 *
 * ⚠️ register 호출 순서 = 라우트 등록 순서(Express 매칭 순서). 원본(단일 파일 시절) 정의 순서를
 * 그대로 유지한다 — 특히 transfer 의 GET /targets/export.csv 는 export.:format 보다 먼저
 * 등록돼야 한다(순서 역전 시 CSV 내보내기가 404 로 무음 파손 — 상세는 ./svcmon/transfer.js 헤더,
 * 회귀 테스트는 server/test/svcmonRouteOrder.test.js). 유일한 의도적 순서 변화는 POST /flush
 * (원본 맨 끝 → overview)이며, 최상위 1세그먼트 param 라우트가 없어 무해함을 overview.js 헤더에
 * 증명해 뒀다. 새 라우트 추가 시 해당 도메인 모듈에 넣을 것.
 */

import express from 'express';
import { registerOverview } from './svcmon/overview.js';
import { registerTree } from './svcmon/tree.js';
import { registerTransfer } from './svcmon/transfer.js';
import { registerTemplates } from './svcmon/templates.js';
import { registerGenerate } from './svcmon/generate.js';
import { registerEdge } from './svcmon/edge.js';
import { registerLogs } from './svcmon/logs.js';

export const svcmonRouter = express.Router();
registerOverview(svcmonRouter);   // /state /diag /refresh /flush
registerTree(svcmonRouter);       // /folders* /reorder/* /sort /targets CRUD /targets/:id/tests*
registerTransfer(svcmonRouter);   // /targets/export.csv → export.:format(순서 불변) /sample /hostmap* /csv-schema /import
registerTemplates(svcmonRouter);  // /templates*
registerGenerate(svcmonRouter);   // /targets/generate /batches*
registerEdge(svcmonRouter);       // /assign* /config-pull-now /edges* /edge-state /push-now /silence-check
registerLogs(svcmonRouter);       // /log*
