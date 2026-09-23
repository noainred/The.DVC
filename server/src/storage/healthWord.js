/**
 * storage/healthWord.js — 장비가 보고한 노드·컨트롤러 상태 문자열 → 'ok' | 'bad' | 'unknown'(순수, v2.586).
 *
 * ⚠ 왜 따로 두나: 수집기 셋(`isilon.js`·`vplexSsh.js`·`xtremioSsh.js`)이 각자 **앵커 없는 부분 문자열**
 *   정규식(`/ok|healthy|…|connected/`)으로 정상을 판정했다. 그 결과
 *     'disconnected' → 'connected' 가 들어 있어 **정상**(XtremIO 컨트롤러가 끊겨도 ⚠ 가 안 붙는다)
 *     'unhealthy'    → 'healthy' 가 들어 있어 **정상**
 *     'not ok'·'broken' → 'ok' 가 들어 있어 **정상**
 *   노드 장애 표지(v2.523)·파트 장애(v2.548)가 이 값을 믿으므로 **장애를 조용히 숨기는** 방향의 결함이다.
 *   웹 `views/tools/storageNodeText.js nodeHealthKind` 도 같은 규칙이어야 하고 서버 테스트가 두 구현을 대조한다.
 *
 * 규칙(순서가 계약이다):
 *   ① 비었거나 'unknown'·'n/a'·'-'·'?' → unknown(정상도 이상도 아니다 — v2.523)
 *   ② 부정어가 붙은 정상어('not ok'·'no-connected'…) 또는 명백한 이상어(unhealthy·disconnected·offline·down·
 *      degraded·fail*·error·critical·fault*) → bad  ← **정상어보다 먼저** 본다
 *   ③ 정상어가 **단어로** 있으면 ok(ok·healthy·normal·up·green·online·connected·good·attention_none)
 *   ④ 그 밖 → bad(원문 그대로 보여준다 — 모르는 값을 정상이라 말하지 않는다)
 */
const UNKNOWN = new Set(['', 'unknown', 'n/a', 'na', '-', '?', 'none']);
const NEG_OK = /\b(not|no|non)[\s_-]*(ok|healthy|normal|online|connected|up|good)\b/;
const BAD = /\b(unhealthy|disconnected|offline|down|degraded|fail\w*|error\w*|critical|fault\w*|broken|major-failure|minor-failure|smartfail\w*)\b/;
const GOOD = /\b(ok|healthy|normal|up|green|online|connected|good|attention_none)\b/;

export function healthWord(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (UNKNOWN.has(s)) return 'unknown';
  if (NEG_OK.test(s) || BAD.test(s)) return 'bad';
  if (GOOD.test(s)) return 'ok';
  return 'bad';
}
