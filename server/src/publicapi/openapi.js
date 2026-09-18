/**
 * OpenAPI 3.1 문서 생성 (v2.562) — **순수 모듈**.
 *
 * ⚠⚠ **카탈로그(`allowlist.js`)에서 생성한다 — 손으로 쓴 스펙을 두지 말 것.** 두 벌이면
 * 문서와 실제 응답이 갈라지고, 그때 상대 포탈은 **문서를 믿고** 잘못된 코드를 쓴다
 * (CLAUDE.md '조언이 틀리면 무음 실패보다 나쁘다' 와 같은 계열).
 *
 * ⚠ **그 키가 쓸 수 있는 것만** 담는다. 전량을 담으면 403 이 날 경로를 문서가 '있다' 고
 *   말하게 되고, 동시에 경로 열거 단서가 된다.
 *
 * 필드 타입은 선언하지 않고 `nullable` 만 밝힌다 — 이 API 의 정직성 규약이 "읽지 못한 값은
 * null" 이라서, 소비자가 가장 자주 틀리는 지점이 그것이다(0 으로 읽으면 거짓이 된다).
 */

import { ENDPOINTS, GROUPS, GROUP_BY_KEY } from './allowlist.js';

/** 이 API 가 소비자에게 반드시 알려야 하는 정직성 규약 — 문서 맨 앞에 넣는다. */
export const CONTRACT_NOTES = Object.freeze([
  '읽지 못한 수치는 **0 이 아니라 `null`** 입니다. `null` 을 0 으로 읽으면 ‘사용량 0’·‘부하 없음’ 같은 거짓이 됩니다.',
  '목록은 상한이 있고, 잘리면 `meta.truncated: true` 와 `meta.omitted` 로 밝힙니다 — 조용히 자르지 않습니다.',
  '`meta.scopedToVcenters` 가 숫자면 그 키의 vCenter 범위로 걸러진 결과이고, `null` 이면 전체입니다.',
  '수집이 끝나지 않았으면 빈 배열이 아니라 **503 `not-collected`** 입니다 — ‘데이터가 없다’ 와 구분하세요.',
  '분당 상한을 넘기면 **429** 이고 `Retry-After` 헤더가 옵니다. 재시도는 그 시간 뒤에 하세요.',
  '응답은 `Cache-Control: no-store` 입니다 — 키마다 범위가 달라 중간 캐시가 섞으면 안 됩니다.',
]);

const ERROR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { const: false },
    error: { type: 'string' },
    code: { type: 'string', description: '조치가 다른 사유를 구분한 코드 — 한 문구로 덮지 않습니다.' },
    reason: { type: 'string', description: '사람이 읽는 사유(한국어).' },
  },
  required: ['ok', 'code', 'reason'],
});

/** 공통 오류 응답 — 코드마다 조치가 다르므로 설명을 붙인다. */
const COMMON_RESPONSES = Object.freeze({
  401: { description: '키가 없거나(missing-key) 모르거나(unknown-key) 폐기·만료됨(revoked·expired). 같은 값으로 재시도해도 같습니다.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
  403: { description: '이 키에 그 분류가 없음(group-denied·no-groups) 또는 범위로 나눌 수 없는 자원(needs-full-scope). 관리자가 설정 › 연동 키에서 바꿔야 합니다.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
  404: { description: '공개되지 않은 경로(unknown-endpoint). `GET /` 로 목록을 확인하세요.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
  429: { description: '분당 상한 초과(rate-limited). `Retry-After` 초 뒤 재시도.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
  503: { description: '첫 수집 미완료(not-collected) 또는 해당 모듈 사용 불가(unavailable). 빈 데이터와 구분하세요.', content: { 'application/json': { schema: ERROR_SCHEMA } } },
});

function dataSchemaFor(ep) {
  const props = {};
  // ⚠ 전부 nullable 이다 — '읽지 못함' 을 표현하는 것이 이 API 의 계약이다(위 머리말).
  for (const f of ep.fields) props[f] = { nullable: true, description: '읽지 못하면 null.' };
  const obj = { type: 'object', properties: props };
  // 단건인지 목록인지는 선언한 필드 모양이 아니라 **엔드포인트 성질**이다 — 경로로 판단하지
  // 않고 카탈로그의 `list` 를 쓴다(추측 금지). 없으면 필드에 식별자가 있으면 목록으로 본다.
  const isList = ep.list != null ? !!ep.list : ep.fields.includes('id') || ep.fields.includes('deviceId') || ep.fields.includes('partKey');
  return isList ? { type: 'array', items: obj } : obj;
}

/**
 * @param {{groups?:string[], baseUrl?:string}} opt
 * @returns {object} OpenAPI 3.1 문서
 */
export function buildOpenApi({ groups = [], baseUrl = '/api/v1' } = {}) {
  const mine = new Set(groups);
  const visible = ENDPOINTS.filter((e) => mine.has(e.group));

  const paths = {};
  for (const ep of visible) {
    paths[ep.path] = {
      get: {
        summary: ep.summary,
        tags: [GROUP_BY_KEY[ep.group]?.label || ep.group],
        operationId: ep.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, ''),
        description: ep.requiresFullScope
          ? '⚠ vCenter 범위로 나눌 수 없는 자원입니다 — 범위를 지정한 키는 403(needs-full-scope) 입니다.'
          : (ep.scoped ? '키의 vCenter 범위가 적용됩니다(범위 미지정 = 전체).' : ''),
        responses: {
          200: {
            description: '성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { const: true },
                    apiVersion: { type: 'string' },
                    endpoint: { type: 'string' },
                    generatedAt: { type: 'integer', description: '응답을 만든 시각(epoch ms).' },
                    data: dataSchemaFor(ep),
                    meta: { type: 'object', description: '범위·상한·잘린 개수·주의 문구.' },
                  },
                  required: ['ok', 'apiVersion', 'data', 'meta'],
                },
              },
            },
          },
          ...COMMON_RESPONSES,
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'VMware Global Monitoring Portal — 공개 조회 API',
      version: '1.0.0',
      description: [
        '다른 포탈이 이 포탈의 **조회 데이터**를 읽는 API 입니다. 조회 전용이고, 관리자가 키마다',
        '허용한 분류만 나갑니다(거부 기본값).',
        '',
        '## 반드시 알아야 하는 것',
        ...CONTRACT_NOTES.map((n) => `- ${n}`),
        '',
        '## 인증',
        '`X-Api-Key: dvcapi_...` 헤더를 넣으세요. `Authorization: Bearer dvcapi_...` 도 됩니다.',
        '키는 발급 순간 **1회만** 표시되며 서버는 해시만 보관합니다 — 잃으면 재발급해야 합니다.',
      ].join('\n'),
    },
    servers: [{ url: baseUrl }],
    tags: GROUPS.filter((g) => mine.has(g.key)).map((g) => ({ name: g.label, description: g.desc })),
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      },
    },
    security: [{ ApiKeyHeader: [] }],
    paths,
    'x-notAllowedForThisKey': ENDPOINTS.filter((e) => !mine.has(e.group)).length,
  };
}
