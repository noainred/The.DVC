/**
 * 분할된 routes/api 소스를 하나의 문자열로 결합해 반환 — 소스 텍스트 회귀 테스트 전용.
 *
 * v2.283.0 대형 파일 분할로 routes/api.js(구 2,445줄)가 집계 라우터 + routes/api/*.js
 * 도메인 모듈로 나뉘었다. 보안 불변조건 테스트(scope 강제·가드 존재 등)는 파일 원문을
 * 정규식으로 검사하므로, 분할 후에도 전 모듈을 커버하도록 여기서 이어 붙인다.
 *
 * 결합 순서 = api.js 본문 → shared.js → 도메인 모듈(등록 호출 순서). 도메인 모듈 순서를
 * api.js 의 import 목록에서 읽어오므로, 모듈이 늘거나 순서가 바뀌어도 테스트는 자동 추종한다.
 * (marker→next-marker 슬라이스 방식 테스트가 원본 등록 순서를 가정하기 때문에 순서 보존이 중요)
 */
import fs from 'node:fs';

export function readApiSource() {
  const base = new URL('../../src/routes/', import.meta.url);
  const main = fs.readFileSync(new URL('api.js', base), 'utf8');
  const parts = [main];
  try { parts.push(fs.readFileSync(new URL('api/shared.js', base), 'utf8')); } catch { /* 분할 전 호환 */ }
  for (const m of main.matchAll(/from '\.\/api\/(\w+\.js)'/g)) {
    if (m[1] === 'shared.js') continue;
    parts.push(fs.readFileSync(new URL(`api/${m[1]}`, base), 'utf8'));
  }
  return parts.join('\n');
}
