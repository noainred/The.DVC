/**
 * v2.768(점검 R3-C5-02): 예약된 백업 복원을 **기동 때 다른 모듈보다 먼저** 적용한다 — index.js 의 두 번째 import(logbuffer.js 바로 뒤).
 * 부수 효과만 있는 모듈이다(테스트가 stagedRestore.js 를 import 해도 적용이 돌지 않게 따로 둔다). 근거·규칙은 stagedRestore.js 머리말.
 * ⚠ index.js 에서 이 줄을 아래로 옮기지 말 것 — 그 앞에 오는 모듈이 설정 파일을 캐시하면 복원이 다시 덮인다.
 */
import { applyStagedRestore } from './stagedRestore.js';

applyStagedRestore();
