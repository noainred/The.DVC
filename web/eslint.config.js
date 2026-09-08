// ESLint flat config(v2.289 #4) — 목적은 스타일 통일이 아니라 "React 훅 규칙" 위반을 CI 이전에
// 잡는 것이다. CLAUDE.md 회귀 사례: 조기 return 뒤에 useState 를 추가해 렌더 간 훅 개수가 달라져
// React #310 으로 화면 전체가 크래시(v2.202 사용자 관리 → v2.203 긴급 수정). 이 클래스의 버그는
// 리뷰로 놓치기 쉬우므로 rules-of-hooks 를 'error'(=lint 실패)로 강제한다.
//
// exhaustive-deps 는 'warn' 으로 둔다 — 의존성 배열 누락은 대개 의도적(폴링 setInterval 등)이라
// error 로 올리면 기존 코드가 대량으로 걸려 게이트가 무의미해진다. 경고는 표시하되 빌드는 막지
// 않는다(lint 는 error 가 있을 때만 비정상 종료). 나머지 스타일 규칙은 의도적으로 켜지 않는다
// (병렬 작업과의 충돌·대량 노이즈 방지 — 딱 훅 안전성만 본다).
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021, process: 'readonly' },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // no-undef(v2.421): 다른 컴포넌트의 지역 함수를 그대로 참조하는 실수(v2.416 SanSwitchTool `closeDetail` —
      // 포트 상세를 열면 ReferenceError 로 특수기능 전체 크래시, 2.416~2.420 실제 장애)를 CI 이전에 잡는다.
      'no-undef': 'error',
    },
  },
];
