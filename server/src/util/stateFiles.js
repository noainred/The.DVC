/**
 * util/stateFiles.js — '이 파일은 설정이 아니라 **상태·캐시** 다' 를 파일이 스스로 선언하는 등록부(v2.613 PERSIST2613-01·08).
 *
 * 왜: `backup/service.js isRuntimeStateFile` 은 이름 목록(RUNTIME_STATE_NAMES) + 접미 규약(-latest·-activity …)으로 상태
 *   파일을 가른다. 새 기능이 상태 파일을 만들면서 그 목록에 넣는 것을 잊으면 **조용히 '설정'** 이 되어 push·폴러 쓰기마다
 *   'change' 백업이 생기고(v2.590 P1) 엣지 설정 push 가 30분 → 5분마다 나간다(v2.602 EDGE2602-01). v2.608 CVP 가 그렇게
 *   두 파일(`central-agent-cvp.json`·`cvp-push.json`)을 빠뜨렸다 — 손으로 더한 이력이 v2.590·595·596·601·602 다섯 번이라
 *   여섯 번째였다. 이제 상태 파일을 **만드는 헬퍼**(`createDebouncedWriter`·`createActivityLog`·`createAuthGuard`·push 커서)가
 *   자기 파일명을 여기에 등록하고 `isRuntimeStateFile` 이 이 등록부도 본다 — 새 기능이 그 헬퍼를 쓰면 등록이 자동이다.
 *
 * ⚠ 이 모듈은 **아무것도 import 하지 않는 leaf** 다(backup/service.js 와 헬퍼 양쪽이 쓴다 — 순환을 만들지 않게). 등록은
 *   프로세스 메모리뿐이고 파일을 쓰지 않는다. 헬퍼가 모듈 로드 시점에 등록하므로 '모듈이 아직 로드되지 않은' 파일은 등록부에
 *   없다 — 그래서 확정된 이름은 `RUNTIME_STATE_NAMES` 에도 함께 적는다(이중 안전망. 테스트가 두 축을 각각 고정한다).
 */
import path from 'node:path';

const REGISTRY = new Set();

const baseOf = (name) => path.basename(String(name || '')).trim();

/** 상태 파일명(경로여도 된다 — basename 만 본다)을 등록한다. 빈 값은 무시. 등록한 basename 을 돌려준다. */
export function registerStateFile(name) {
  const b = baseOf(name);
  if (b) REGISTRY.add(b);
  return b;
}

/** 헬퍼가 등록한 상태 파일인가(basename 비교). */
export function isRegisteredStateFile(name) {
  const b = baseOf(name);
  return !!b && REGISTRY.has(b);
}

/** 등록된 이름 목록(정렬) — 진단·테스트용. */
export function registeredStateFiles() { return [...REGISTRY].sort(); }
