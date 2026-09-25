/**
 * toneVar — 판정 톤(`ok`/`warn`/`bad`, 또는 진단 어휘 `green`/`amber`/`red`) → CSS 색 변수. **공용 코어**
 * (v2.613 DEPS2613-11). 예전에는 `bmUsageText`·`edgeLogText`·`partFaultText` 가 각자 정의했고 두 벌은
 * 정의되지 않은 `--ok`/`--warn`/`--bad` 변수에 hex 폴백을 붙여 **테마 토큰과 다른 색**을 냈다.
 * 이제 세 곳이 이 하나를 쓴다(테마 토큰 `--green`·`--amber`·`--red`·`--text-faint`).
 *
 * 순수 모듈이다 — React·api.js 를 import 하지 않는다(`*Text.js` 의 vitest 가 node 환경이라).
 */
export function toneVar(tone) {
  switch (String(tone || '')) {
    case 'red': case 'bad': return 'var(--red)';
    case 'amber': case 'warn': return 'var(--amber)';
    case 'green': case 'ok': return 'var(--green)';
    default: return 'var(--text-faint)';   // gray·muted·모르는 값 — '확인 불가' 는 빨강이 아니다
  }
}
