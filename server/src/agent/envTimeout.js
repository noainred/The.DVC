/**
 * 호환 재수출(v2.613 DEPS2613-01) — 본체는 `util/envTimeout.js` 로 옮겼다.
 * config.js 가 agent/ 를 import 하는 방향(설정 leaf → 엣지 워커 디렉터리)이 잠재 순환의 씨앗이었고, agent/ 밖
 * 18개 파일이 이 순수 헬퍼를 가져다 쓰고 있었다 — 도메인 공용 헬퍼는 util/ 이 자리다. 호출부 호환을 위해 옛 경로를 남긴다.
 * ⚠ `export { x } from` 이 아니라 import + export 다(v2.575 규약).
 */
import { reqTimeoutMs } from '../util/envTimeout.js';
export { reqTimeoutMs };
