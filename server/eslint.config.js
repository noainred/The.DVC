// 서버 ESLint flat config(v3.52 — 디버깅 6회차 보안 축 제안 · 사용자 결정 2026-11-27) — 목적은 스타일이 아니라 **정의되지 않은 이름**(no-undef)을 CI 이전에 잡는 것.
//   실례: security/secretScan.js 가 safeLoadText 를 import 하지 않아 손상 파일 하나로 평문 점검 전체가 500(21회차부터 숨어 있다 6회차에 발견 — 소스 글자 시험이 못 잡음).
//   서버에는 eslint 의존성을 두지 않는다 — 웹(web/node_modules)의 eslint · globals 를 쓴다(루트 `npm run lint:server`). 다른 규칙은 켜지 않는다(대량 노이즈 방지).
import globals from '../web/node_modules/globals/index.js';

export default [
  { ignores: ['src/intro/**'] },   // dc-runtime 생성물(GENERATED — 손대지 않음)
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // nodeBuiltin — ESM 에 없는 require · __dirname · __filename · module · exports 는 전역이 아니다(globals.node 는 CommonJS 이름까지 넣어 놓쳤다 — 반증 12b #7)
      globals: { ...globals.nodeBuiltin, ...globals.es2021 },
    },
    // 소스의 ‘eslint-disable import/no-unresolved’(node:sqlite 등) 주석이 규칙 정의 없음 오류가 되지 않게 빈 규칙을 둔다(검사는 하지 않는다)
    plugins: { import: { rules: { 'no-unresolved': { create: () => ({}) } } } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error',
      // 전역 crypto 는 Web Crypto — node:crypto 의 createHash · randomBytes 가 없다. import 를 빠뜨리면 실행 때 TypeError(반증 12b #7)
      'no-restricted-globals': ['error', { name: 'crypto', message: 'node:crypto 를 import 하십시오(전역 crypto 는 Web Crypto — createHash 등이 없습니다)' }],
    },
  },
];
