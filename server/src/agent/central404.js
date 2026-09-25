/**
 * 호환 재수출(v2.613 DEPS2613-01) — 본체는 `util/central404.js` 로 옮겼다(envTimeout 과 같은 이유 — 순수 판정 헬퍼이고
 * cvp/push.js 등 agent/ 밖에서도 쓴다). ⚠ `export { x } from` 이 아니라 import + export 다(v2.575 규약).
 */
import { classifyCentral404, classifyCentral404Body } from '../util/central404.js';
export { classifyCentral404, classifyCentral404Body };
