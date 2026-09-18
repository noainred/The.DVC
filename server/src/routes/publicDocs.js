/**
 * `/api/docs` — **로그인 없이** 보는 API 안내 데이터 (v2.564).
 *
 * 사용자 요청: "로그인 없이 볼 수 있는 페이지를 하나 만들어서 API 를 찾아서 사용할 수 있는
 * 페이지 만들어줘, 사용 예시와 샘플을 같이 제공하는 기능".
 *
 * ⚠⚠ **여기서 나가는 것은 문서뿐이다 — 운영 데이터는 한 바이트도 나가지 않는다.**
 * 엔드포인트 카탈로그는 `allowlist.js`(선언)에서, 샘플은 `samples.js`(손으로 지어낸 값)에서
 * 온다. `store.get()` 같은 스냅샷을 여기서 읽으면 **무인증으로 vCenter 이름·대수가 샌다** —
 * 그래서 이 파일은 스냅샷·DB·등록부를 **import 하지 않는다**(테스트가 소스에서 고정한다).
 *
 * ⚠⚠ **내부 API 812개는 싣지 않는다.** 공개하는 것은 `/api/v1` 의 조회 전용 8개뿐이다.
 * 전량을 무인증으로 내보내면 이 저장소의 기존 불변조건 셋과 정면으로 어긋난다 —
 * ① `/api/v1` 404 는 경로 목록을 알려주지 않는다(열거 단서) ② 미인증 응답에 계정명을 싣지
 * 않는다 ③ `x-powered-by` 제거. RMA 원격 명령·프로비저닝·방화벽 변경·백업 다운로드 경로의
 * 이름이 드러나는 것은 **공격자에게 지도를 주는 일**이다.
 *
 * ⚠ 끄면 **404** 다(403 이 아니다) — 403 은 "여기 뭔가 있다" 를 알려준다.
 */
import { Router } from 'express';
import { ENDPOINTS, GROUPS } from '../publicapi/allowlist.js';
import { CONTRACT_NOTES } from '../publicapi/openapi.js';
import { sampleFor } from '../publicapi/samples.js';
import { KEY_PREFIX, DEFAULT_RPM } from '../publicapi/keys.js';
import { docsEnabled } from '../publicapi/docsSettings.js';

export const publicDocsRouter = Router();

/**
 * 오류 코드표 — 사유마다 조치가 다르므로 한 문구로 덮지 않는다.
 * ⚠ `publicapi/auth.js` 의 `DENY` · `allowlist.js` 의 코드와 **같아야 한다**(테스트가 대조).
 */
const ERRORS = Object.freeze([
  { status: 401, code: 'missing-key', when: 'X-Api-Key 헤더가 없음', fix: '헤더를 넣으세요.' },
  { status: 401, code: 'unknown-key', when: '서버가 모르는 값(오타·삭제된 키)', fix: '값을 확인하거나 재발급받으세요.' },
  { status: 401, code: 'revoked', when: '폐기된 키', fix: '같은 값은 다시 살아나지 않습니다 — 새로 발급받으세요.' },
  { status: 401, code: 'expired', when: '만료된 키', fix: '관리자가 만료일을 늘리거나 재발급합니다.' },
  { status: 403, code: 'no-groups', when: '키에 허용 분류가 하나도 없음', fix: '관리자가 분류를 켜야 합니다. (키는 유효하므로 401 이 아닙니다)' },
  { status: 403, code: 'group-denied', when: '그 경로의 분류가 이 키에 없음', fix: '관리자가 그 분류를 켜야 합니다.' },
  { status: 403, code: 'needs-full-scope', when: 'vCenter 범위로 나눌 수 없는 자원', fix: '범위를 지정하지 않은(전체) 키를 쓰세요. 빈 목록을 주면 ‘장비 0대’ 라는 거짓이 되므로 거절합니다.' },
  { status: 404, code: 'unknown-endpoint', when: '공개되지 않은 경로', fix: 'GET /api/v1/ 로 이 키가 쓸 수 있는 목록을 확인하세요.' },
  { status: 429, code: 'rate-limited', when: '분당 상한 초과', fix: '응답의 Retry-After 초 뒤에 재시도하세요.' },
  { status: 503, code: 'not-collected', when: '첫 수집이 끝나지 않음', fix: '잠시 뒤 재시도하세요 — 장애가 아닙니다.' },
  { status: 503, code: 'unavailable', when: '해당 기능 모듈을 불러올 수 없음', fix: '포탈 관리자에게 문의하세요.' },
  { status: 500, code: 'internal', when: '포탈 내부 오류(버그)', fix: '포탈 관리자에게 시각과 경로를 알려주세요 — 재시도해도 같을 수 있습니다.' },
]);

/**
 * 코드 예시 — 경로마다 만들어 준다.
 * ⚠ **실제 키를 넣지 않는다.** 자리표시자(`<발급받은 키>`)만 쓴다.
 */
function examples(basePath, apiPath) {
  const url = `${basePath}${apiPath}`;
  return [
    { lang: 'curl', label: 'curl', code: `curl -H "X-Api-Key: ${KEY_PREFIX}<발급받은 키>" \\\n  ${url}` },
    {
      lang: 'js',
      label: 'Node (fetch)',
      code: [
        `const res = await fetch('${url}', {`,
        `  headers: { 'X-Api-Key': process.env.DVC_API_KEY },  // 소스에 박지 마세요`,
        '});',
        'const body = await res.json();',
        "if (!res.ok) throw new Error(`${res.status} ${body.code}: ${body.reason}`);",
        "// ⚠ null 을 0 으로 바꾸지 마세요 — '읽지 못함' 과 '0' 은 다릅니다.",
        'console.log(body.data);',
      ].join('\n'),
    },
    {
      lang: 'python',
      label: 'Python (requests)',
      code: [
        'import os, requests',
        `r = requests.get('${url}',`,
        "                 headers={'X-Api-Key': os.environ['DVC_API_KEY']}, timeout=30)",
        'body = r.json()',
        'if not r.ok:',
        "    raise SystemExit(f\"{r.status_code} {body['code']}: {body['reason']}\")",
        "if body['meta'].get('truncated'):",
        "    print('잘렸습니다:', body['meta']['omitted'], '건 누락')",
        "print(body['data'])",
      ].join('\n'),
    },
  ];
}

publicDocsRouter.get('/', (req, res) => {
  // ⚠ 끈 현장에서는 '있는데 막혔다' 도 알려주지 않는다.
  if (!docsEnabled()) return res.status(404).json({ ok: false, reason: 'not-found' });

  /*
   * ⚠ baseUrl 은 **요청 호스트**로 만든다(문서의 예시가 그대로 붙여 쓸 수 있게).
   *   `req.get('host')` 는 사용자 입력이지만 여기서는 **문자열로 화면에 보여줄 뿐** 서버가
   *   그 주소로 접속하지 않는다(SSRF 아님). 그래도 제어문자·길이는 잘라 낸다.
   */
  const host = String(req.get('host') || '').replace(/[^\w.:\-[\]]/g, '').slice(0, 200);
  const base = host ? `${req.protocol}://${host}/api/v1` : '/api/v1';

  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    apiVersion: 'v1',
    baseUrl: base,
    keyPrefix: KEY_PREFIX,
    defaultRpm: DEFAULT_RPM,
    listMax: 5000,
    groups: GROUPS,
    contract: CONTRACT_NOTES,
    errors: ERRORS,
    endpoints: ENDPOINTS.map((e) => ({
      path: e.path,
      method: e.method,
      group: e.group,
      summary: e.summary,
      fields: e.fields,
      scoped: !!e.scoped,
      requiresFullScope: !!e.requiresFullScope,
      sample: sampleFor(e.path),
      examples: examples(base, e.path),
    })),
    // ⚠ 이 페이지가 무엇을 보여주지 '않는지' 도 말한다 — 전부라고 오해하지 않게.
    disclosure: {
      publicOnly: true,
      note: '이 페이지는 외부 연동용 공개 조회 API 만 다룹니다. 포탈 내부 API 는 공개하지 않습니다.',
      samplesAreSynthetic: true,
      sampleNote: '샘플 응답은 손으로 지어낸 값입니다 — 이 포탈의 실제 데이터가 아닙니다.',
    },
  });
});

export default publicDocsRouter;
