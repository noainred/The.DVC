/**
 * views/tools/bulkIoText.js — 대량 등록(CSV·자유텍스트) 화면의 **판정·문구**(순수, v2.513).
 *
 * 왜 순수 모듈인가: 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더를 테스트할 수 없다.
 * 그래서 이 저장소 관례대로(`components/accessDeniedText.js`·`version_4/loadState.js`)
 * '무엇을 켜고 무엇을 뭐라고 부르는가' 는 여기서 결정하고 회귀로 고정한다.
 *
 * ── 반드시 지킬 것 ──────────────────────────────────────────────────────────
 *  · **'테스트 불가'(skipped)를 '실패'(fail)로 뭉치지 말 것.** 엣지 위임 장비는 중앙에서
 *    닿을 수 없어 테스트를 **하지 않은** 것이다(서버 bulkRun 의 정직 규약과 같은 이유).
 *    실패라 말하면 사용자가 멀쩡한 자격증명을 의심하며 고친다.
 *  · **기본 선택에서 skipped 를 빼지 말 것.** 등록해야 엣지가 수집한다 — 테스트하지 못한
 *    것이 '등록하면 안 되는 것' 은 아니다. 빼는 것은 `fail` 뿐이다.
 *  · **검증본과 실행본 불일치 금지**: 입력을 고치면 검증·테스트 결과를 무효로 본다
 *    (`stageFlags.changed`). 고친 내용으로 옛 판정을 근거 삼아 저장하면 안 된다.
 */

/** 입력 형식 — CSV 와 자유텍스트. 서버는 body.csv / body.text 로 구분한다. */
export const FORMATS = [
  { key: 'csv', label: 'CSV', ext: 'csv', hint: '헤더 행 + 쉼표 구분(엑셀에서 저장한 그대로)' },
  { key: 'text', label: '자유텍스트', ext: 'txt', hint: '탭·파이프·공백 구분 또는 `키=값` — 위키 표·메일 본문을 붙여넣어도 됩니다' },
];

/** 드라이런 동작 배지. */
export function actionLabel(action) {
  return { add: '추가', update: '수정', error: '오류' }[action] || String(action || '');
}
export function actionClass(action) {
  return { add: 'green', update: 'blue', error: 'red' }[action] || '';
}

/**
 * 연결 테스트 행 상태 → 표시.
 * ⚠ skipped 는 '실패' 가 아니다 — 중앙에서 닿을 수 없어 **시도하지 않은** 것이다.
 */
export function testLabel(status) {
  switch (status) {
    case 'ok': return { text: '성공', cls: 'green', icon: '✅' };
    case 'fail': return { text: '실패', cls: 'red', icon: '❌' };
    case 'skipped': return { text: '테스트 불가', cls: 'amber', icon: '⊘' };
    case 'testing': return { text: '시도 중…', cls: '', icon: '…' };
    case 'pending': return { text: '대기', cls: '', icon: '·' };
    default: return { text: '—', cls: '', icon: '' };
  }
}

/**
 * 드라이런 요약 한 줄.
 * ⚠ **'검증 결과:' 접두를 지우지 말 것** — 등록 결과 줄(`registerSummary`)과 형태가 같아
 * 한 화면에 나란히 뜨면 사람이 구분하지 못한다(v2.513 Chromium 스크린샷 판독에서 발견 —
 * 문자열 테스트로는 잡히지 않았다).
 */
export function dryRunSummary(check) {
  if (!check) return '';
  const s = check.summary || {};
  return `검증 결과: 총 ${check.total ?? 0}행 — 추가 ${s.add ?? 0} · 수정 ${s.update ?? 0} · 오류 ${s.error ?? 0} · 비밀번호 반영 ${s.withPassword ?? 0}건`;
}

/**
 * 연결 테스트 진행/결과 한 줄. **진행 중과 완료를 구분**하고, 완료 후에도
 * '테스트 불가' 를 따로 센다(합치면 실패로 읽힌다).
 */
export function testProgressText(run) {
  if (!run) return '';
  const s = run.summary || {};
  const head = run.status === 'done' ? '연결 테스트 완료' : `연결 테스트 진행 중 ${run.done ?? 0}/${run.total ?? 0}`;
  const parts = [`성공 ${s.ok ?? 0}`, `실패 ${s.fail ?? 0}`];
  if (s.skipped) parts.push(`테스트 불가 ${s.skipped}`);
  if (run.status !== 'done' && s.pending) parts.push(`남음 ${s.pending}`);
  return `${head} — ${parts.join(' · ')}`;
}

/**
 * 단계 게이팅 — 어느 버튼을 켤 수 있는가.
 * @param {{text:string, check:object|null, checkedText:string|null, run:object|null,
 *          runText:string|null, busy:boolean}} st
 * @returns {{changed:boolean, verified:boolean, canVerify:boolean, canTest:boolean,
 *            canRegister:boolean, testRunning:boolean, testDone:boolean, note:string}}
 */
export function stageFlags({ text = '', check = null, checkedText = null, run = null, runText = null, busy = false } = {}) {
  const has = !!String(text || '').trim();
  const changed = !!check && checkedText !== text;
  const verified = !!check && !changed;
  const testStale = !!run && runText !== text;     // 테스트 후 입력을 고쳤다
  const testRunning = !!run && run.status !== 'done';
  const testDone = !!run && run.status === 'done' && !testStale;
  const okRows = verified ? (check.report || []).filter((r) => r.action !== 'error').length : 0;
  let note = '';
  if (changed) note = '입력이 바뀌었습니다 — 다시 검증하세요(옛 판정으로 저장하지 않습니다).';
  else if (testStale) note = '테스트 후 입력이 바뀌었습니다 — 연결 테스트 결과는 쓰지 않습니다.';
  else if (verified && !okRows) note = '등록할 수 있는 행이 없습니다 — 오류를 먼저 고치세요.';
  return {
    changed, verified, testStale, testRunning, testDone, okRows,
    canVerify: has && !busy && !testRunning,
    canTest: verified && okRows > 0 && !busy && !testRunning,
    canRegister: verified && okRows > 0 && !busy && !testRunning,
    note,
  };
}

/**
 * 체크박스 기본 선택 — **오류 행과 연결 실패 행만 뺀다.**
 * 테스트를 하지 않았으면 오류 아닌 전부, 했으면 `fail` 만 제외(skipped 는 포함 — 위 주석 참조).
 * @returns {number[]} 줄 번호
 */
export function defaultSelection(report, run) {
  const statusOf = new Map(((run && run.results) || []).map((r) => [r.line, r.status]));
  return (report || [])
    .filter((r) => r.action !== 'error' && statusOf.get(r.line) !== 'fail')
    .map((r) => r.line);
}

/** 선택 가능한 줄(오류 행은 고를 수 없다 — 서버가 어차피 거절한다). */
export function selectableLines(report) {
  return (report || []).filter((r) => r.action !== 'error').map((r) => r.line);
}

/**
 * '연결 성공분만' 옵션의 설명 — 무엇이 빠지는지 **명시**한다(조용한 제외 금지).
 * 서버 `passedLines` 는 `ok` 만 돌려주므로 '테스트 불가' 행도 빠진다.
 */
export function testOnlyNote(run) {
  const sk = run?.summary?.skipped || 0;
  return sk
    ? `연결 성공한 행만 서버가 저장합니다 — '테스트 불가' ${sk}건(엣지 위임)도 함께 제외됩니다.`
    : '연결 성공한 행만 서버가 저장합니다(화면 선택과 교집합).';
}

/** 등록 결과 한 줄. 제외 건수는 감추지 않는다. */
export function registerSummary(result) {
  if (!result) return '';
  const parts = [`추가 ${result.added ?? 0}`, `수정 ${result.updated ?? 0}`];
  if (result.failed?.length) parts.push(`실패 ${result.failed.length}`);
  if (result.skipped?.length) parts.push(`제외 ${result.skipped.length}`);
  return `등록 결과: 총 ${result.total ?? 0}행 — ${parts.join(' · ')}`;
}

/**
 * 토큰 위치를 사람 말로. 서버 `token.form` 이 특정하지 못하면 **말하지 않는다**(빈 문자열).
 */
export function tokenHint(item) {
  const t = item?.token;
  if (!t) return '';
  if (t.form === 'keyed') return `\`${item.field}=\` 값`;
  if (t.form === 'missing') return `${t.col}번째 항목이 없음`;
  if (t.form === 'positional') return `${t.col}번째 항목`;
  return '';
}

/** 다운로드 경로 — 도구 base 와 형식으로 조립(화면에 경로를 흩뿌리지 않기 위해). */
export function ioUrl(base, kind, format) {
  const f = FORMATS.find((x) => x.key === format) || FORMATS[0];
  return `${base}/devices/${kind}.${f.ext}`;
}
