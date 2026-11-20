/**
 * test/_centralSource.js — 중앙 수신 라우트의 **소스 전체**(v2.954 개선 검토 4번).
 * routes/central.js 는 v2.954 에 영역별 파일(routes/central/*.js)로 나뉘었다 — 라우트 등록은 central.js 의 원래 자리에서 그대로 하고(순서 불변),
 * 본문만 옮겼다. 'central 라우트 소스에 X 가 있다' 를 보는 스윕은 이 함수로 읽는다(central.js 다음에 등록 순서대로 이어 붙인다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
/** 등록 순서(central.js 의 register* 호출 순서) — 새 영역 파일을 만들면 여기에도 넣는다(아래 테스트가 대조한다). */
export const CENTRAL_PARTS = Object.freeze(['storageRoutes', 'pduSanRoutes', 'cvpIsiduRoutes', 'opsRoutes']);
export function centralSource() {
  return [fs.readFileSync(path.join(SRC, 'routes/central.js'), 'utf8'), ...CENTRAL_PARTS.map((m) => fs.readFileSync(path.join(SRC, `routes/central/${m}.js`), 'utf8'))].join('\n');
}
