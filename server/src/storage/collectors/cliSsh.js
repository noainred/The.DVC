/**
 * storage/collectors/cliSsh.js — SSH CLI 수집기 공용 뼈대(v2.405, 사용자 요구
 * '장비별 특화 수집 방법'). PowerStore(pstcli)·Unity(uemcli)·XtremIO(xmcli)·
 * VPLEX/Metro Node(vplexcli) 가 공유한다. isilonSsh.js 와 같은 철학이되, 저 넷은 CLI 마다
 * 출력 형식과 버전차가 커서 '명세 → 실행 → 파싱' 을 표로 분리했다.
 *
 * ── 왜 원문(raw)을 붙잡아 두나 ──────────────────────────────────────────────────
 * 이 CLI 들의 출력 형식은 **버전마다 다르고 실장비 없이는 확정할 수 없다**. 그래서 각 명령의
 * 원문 앞부분을 보관해, 등록 화면의 '연결 테스트'가 요청하면 그대로 돌려준다(adminOnly).
 * 파싱이 빗나가도 사용자가 실제 출력을 바로 볼 수 있어야 원인 파악과 교정이 가능하다 —
 * '수집 실패'만 남기고 원문을 버리면 원격 장비의 문제를 추측으로만 다뤄야 한다.
 * ⚠ 원문에는 비밀번호를 넣지 않는다: 명령줄에 자격증명을 싣지 않고(SSH 로 그 계정에 접속한
 *   상태에서 실행), 캡처 길이도 상한을 둔다.
 *
 * ── 스냅샷 계약 ────────────────────────────────────────────────────────────────
 * 각 타입의 SSH 수집기는 types.js 의 NormalizedSnapshot 을 그대로 반환한다(API 수집기와 동일).
 * 섹션별 성공/실패는 snap.sections 에 남겨 부분 실패를 숨기지 않는다.
 */

import { withSsh, isSshAuthError } from '../../proxy/sshExec.js';
import { emptySnapshot } from '../types.js';

/** 캡처할 원문 상한(문자) — 응답/로그가 비대해지지 않게. */
const RAW_LIMIT = Number(process.env.STORAGE_CLI_RAW_LIMIT) || 4000;
/** 명령 1개 타임아웃(ms) — CLI 는 로그인 배너·페이지네이션으로 느릴 수 있어 넉넉히. */
const CMD_TIMEOUT_MS = Number(process.env.STORAGE_CLI_TIMEOUT_MS) || 45_000;
/**
 * 세션 전체 예산(v2.528 — **v2.526 회귀 수정**).
 *
 * ⚠ 왜 필요한가: v2.526 이 Unity 명령을 5개 → **24개**로 늘렸는데 폴러의 장비 시한
 * (`storage/poller.js DEVICE_TIMEOUT_MS`, 기본 180초)은 그대로였다. 명령당 시한이 45초라
 * **느린 명령 4개면 180초를 넘고**, 그 순간 `withDeadline` 이 던져 **그때까지 모은 결과가
 * 통째로 버려진다**(용량·상태까지 전부). 사용자 신고 "수정 이후에 유니티 ssh 안되" 가 이것이다.
 *
 * 그래서 세션이 **스스로** 예산을 보고 멈춘다 — 남은 시간이 부족하면 새 명령을 시작하지 않고
 * **여기까지의 결과를 돌려준다**. 필수·매주기 항목이 앞에 있으므로(`unitySsh.js SPECS` 순서)
 * 용량·상태는 살아남고, 못 돌린 구성 명령은 **개수와 이유를 밝힌다**(조용한 생략 금지).
 *
 * 기본값은 장비 시한보다 **작아야** 한다 — 같거나 크면 이 가드가 발동하기 전에 폴러가 먼저 던진다.
 */
const SESSION_BUDGET_MS = Math.max(20_000, Number(process.env.STORAGE_CLI_SESSION_BUDGET_MS) || 150_000);
/** 남은 예산이 이보다 적으면 새 명령을 시작하지 않는다(시작해 놓고 잘리면 결과가 버려진다). */
const MIN_SLICE_MS = 5_000;

/**
 * 한 SSH 세션에서 명령 묶음을 실행한다.
 * specs: [{ key, section?, cmds: [string, ...], required? }]
 *   - cmds 는 **후보 목록**이다. 앞에서부터 시도해 '쓸 만한 출력'이 나오면 멈춘다(버전차 폴백).
 *   - required 인 명령이 전부 실패하면 전체 수집을 실패로 본다(대개 핵심 상태 조회).
 * 반환: { out: {key: stdout}, raw: [{key, cmd, ok, sample}], errors: {key: message} }
 */
/**
 * CLI 가 **정상 종료했는데도 오류인** 경우를 잡는다(v2.526, 실측 기반).
 *
 * uemcli 는 잘못된 명령에 exit 0 + 본문으로 응답한다(사용자 실측 2026-09-16):
 *   `Operation failed. Error code: 0x1000017`
 *   `There is a syntax error in the command. Please recheck the command syntax.`
 * 배너를 걷어낸 뒤 **앞부분에서** 이 문구를 찾는다 — 본문 아무 데나 찾으면 정상 출력의
 * `Health details = "…No action is required."` 같은 문장에 오탐한다.
 */
export function cliLooksError(stdout, stderr = '') {
  const head = String(stdout || '').trim().slice(0, 400);
  if (!head) return true;
  if (/^\s*(error|command not found|invalid|unknown command)/i.test(head)) return true;
  if (/Operation failed\.\s*Error code/i.test(head)) return true;
  if (/There is a syntax error in the command/i.test(head)) return true;
  if (/Expected one of the following mandatory keywords/i.test(head)) return true;
  if (/command not found|not recognized/i.test(String(stderr || ''))) return true;
  return false;
}

/**
 * 한 명령의 결과가 **끊겼는가**(v2.543). 시한 초과·응답 상한·중단(abort) 은 전부 그 후보의 실패다.
 *
 * ⚠ 순수 함수로 분리한 이유: 이 판정을 되돌리면 sudo 프롬프트 26 바이트가 **명령의 정상 출력으로
 * 저장**되고(파서가 '형식이 다르다' 고 엉뚱한 탓을 한다) 화면은 `✓ 성공 3 · 실패 0` 이라는
 * 거짓을 말한다. 회귀를 소스 grep 이 아니라 **동작으로** 고정하기 위한 것이다.
 */
export function commandCut(r) {
  return !!(r && (r.truncated || r.timedOut || r.aborted));
}

/**
 * @param {object[]} specs `[{ key, section?, cmds, required?, answered?, rules?, timeoutMs? }]`
 *   · `accept(stdout)` — **이 후보가 원하는 것을 실제로 줬는가**(v2.545). 거짓이면 다음 후보로.
 *     오류 문구가 없다는 것과 원하는 값을 읽었다는 것은 다르다(v2.525 규약).
 *   · `timeoutMs` — 그 항목의 명령당 시한(기본 `CMD_TIMEOUT_MS` 45초). 짧은 명령에 45초를
 *     그대로 주면 명령 수 × 45초가 세션 예산을 넘겨 뒤 항목이 실행되지 않는다(v2.528).
 *   · `answered:true` — 대화형 프롬프트에 자동 응답한다(`sshExec.execAnswered`).
 *     uemcli 는 자체서명 인증서 수락 프롬프트에서 멈추므로 이 모드가 **필수**다(v2.526).
 * @param {object} [opts]
 * @param {(t:string)=>string} [opts.clean] 파싱 전 전처리(배너 제거 등). 오류 판정도 이 결과로 한다.
 */
export async function runCliSession(device, specs, { clean = (t) => t, budgetMs = SESSION_BUDGET_MS } = {}) {
  const creds = {
    host: device.host,
    port: Number(device.sshPort) || 22,
    username: device.username,
    password: device.password || '',
    signal: device._signal, // 폴러의 장비당 타임아웃(v2.417) — 만료 시 세션을 끊는다
  };
  const startedAt = Date.now();
  const leftMs = () => budgetMs - (Date.now() - startedAt);
  return withSsh(creds, async (sh) => {
    const out = {};
    const raw = [];
    const errors = {};
    const skipped = [];
    const truncatedKeys = {}; // v2.539: 시한/응답 상한으로 끊긴 명령 {key: {cmd, ms, timedOut, answers, bytes}}      // 예산이 모자라 **시작조차 하지 않은** 항목 — 반드시 밝힌다
    for (const spec of specs) {
      // ── 세션 예산(v2.528) ──
      // 필수 항목은 예산을 무시하고 시도한다(그것이 없으면 스냅샷 자체가 무의미하다).
      if (!spec.required && leftMs() < MIN_SLICE_MS) { skipped.push(spec.key); continue; }
      let lastErr = null;
      let done = false;
      for (const cmd of spec.cmds) {
        try {
          // 남은 예산 안에서만 기다린다 — 한 명령이 전체 예산을 먹지 않게.
          /*
           * 항목별 시한(v2.544) — 기본은 `CMD_TIMEOUT_MS`(45초)지만 **빠른 것이 확실한 명령은
           * 짧게** 준다. 명령을 늘릴 때 45초를 그대로 곱하면 세션 예산을 넘겨 뒤 항목이
           * 통째로 실행되지 않는다(v2.528 이 고친 회귀가 정확히 그것이다).
           * ⚠ 늘릴 때는 `unitySshBudget2528.test.js` 의 산수를 **먼저** 볼 것.
           */
          const cap = Math.max(1000, Number(spec.timeoutMs) || CMD_TIMEOUT_MS);
          const slice = spec.required ? cap : Math.max(MIN_SLICE_MS, Math.min(cap, leftMs()));
          const t0 = Date.now();
          const r = spec.answered
            /*
             * ⚠⚠ **PTY 를 요청하지 않는다**(`pty:false`, v2.543 — 사용자 재현으로 확정).
             * 같은 계정·같은 명령인데 `-tt`(PTY) 를 붙이면 `[sudo] password for root:` 에서 멈추고,
             * 안 붙이면 3.7초에 정상 출력이 나온다. PTY 세션에서 그 계정 환경이 sudo 를 부르기
             * 때문이고 `uemcli` 는 실행조차 되지 않는다.
             * ⚠ v2.530 이 넣은 `WIDE_PTY`(1000칸)는 **PTY 가 만든 줄바꿈을 PTY 로 막으려던 것**이다.
             *   PTY 가 없으면 장비가 폭에 맞춰 접을 이유 자체가 없다 — 사용자의 비-PTY 출력이
             *   한 줄도 접히지 않은 것이 그 증거다. **PTY 를 되살리지 말 것.**
             * ⚠ 프롬프트 자동 응답은 그대로 둔다 — PTY 없이도 exec 채널의 stdin 에 쓸 수 있다.
             */
            ? await sh.execAnswered(cmd, { timeoutMs: slice, pty: false, rules: spec.rules || ['certAccept', 'pager'] })
            : await sh.exec(cmd, slice);
          const ms = Date.now() - t0;
          // 배너·프롬프트를 먼저 걷어낸다 — 그 뒤에 오류 판정·파싱을 한다(둘이 같은 텍스트를 봐야 한다).
          const stdout = clean(String(r.stdout || ''));
          const stderr = String(r.stderr || '');
          // CLI 는 오류를 exit code 0 + stderr/본문 문구로 내보내는 경우가 흔하다.
          /*
           * ⚠⚠ **끊긴 명령을 성공으로 세지 말 것**(v2.543 에 고친 v2.539 결함).
           * v2.542 까지 `ok` 는 `!cliLooksError(...)` 하나였다. 그런데 sudo 프롬프트 26 바이트는
           * 오류 문구가 아니므로 `looksError` 가 거짓이었고, 그 결과:
           *   ① 화면이 `✓ 성공 3 · 실패 0` 이라고 말했다(**동시에 '끊긴 명령 3건' 이었다**)
           *   ② 더 나쁜 것 — 아래 `out[spec.key] = stdout` 이 실행돼 **그 26 바이트가 명령의
           *      정상 출력으로 저장**됐다. 파서는 그것을 읽고 '풀 출력을 읽지 못했습니다' 라고
           *      **형식 탓**을 했다. 원인은 형식이 아니라 명령이 시작조차 못 한 것이다.
           * 시한 초과·응답 상한·중단(abort)은 **전부 그 후보의 실패**다 — 다음 후보로 넘어가고,
           * 넘어갈 후보가 없으면 그 항목은 오류다.
           */
          const cut = commandCut(r);
          /*
           * ⚠⚠ **'오류 문구가 없다' 를 '원하는 것을 읽었다' 로 쓰지 말 것**(v2.545 —
           * 사용자 신고 "아직 버전명이 나오지 않네").
           *
           * v2.544 의 버전 항목은 후보가 둘(`uemcli /sys/general show -detail` → `svc_diag`)인데
           * 후보를 넘어가는 조건이 `cliLooksError` 하나뿐이었다. 실측:
           *     svc_diag 출력            → cliLooksError = false (정상)
           *     버전이 **없는** 정상 출력 → cliLooksError = false  ← 여기서 멈춘다
           * 그래서 첫 후보가 오류만 안 내면 **버전이 없어도 거기서 체인이 끝나** `svc_diag` 를
           * 아예 부르지 않았다. 수집은 성공인데 버전 열만 비었다(화면 그대로).
           * 이것은 v2.525 규약('결과가 비어 있지 않다를 읽었다로 쓰지 말 것')을 어긴 것이다.
           *
           * `accept(stdout)` 는 **그 항목이 실제로 원하는 것을 얻었는지**를 본다. 거짓이면 그
           * 후보는 실패로 보고 다음 후보로 넘어간다 — 넘어갈 후보가 없으면 그 항목은 오류다.
           * ⚠ 파싱이 무거운 항목(풀 상세 등)에 붙이지 말 것 — 여기서 파싱을 두 번 하게 된다.
           *   가볍게 판정할 수 있는 항목에만 쓴다(버전은 정규식 한 번이다).
           */
          const wanted = typeof spec.accept === 'function' ? !!spec.accept(stdout) : true;
          const looksError = cut || cliLooksError(stdout, stderr) || !wanted;
          // v2.539: 소요·끊김·자동응답 횟수를 원문 옆에 남긴다 — '형식이 다르다' 와 '끊겼다' 는 조치가 다르다.
          //   (실제 사고: 인증서 프롬프트 에코 루프가 400회 응답 뒤 명령을 죽였는데 화면은 형식 탓을 했다.)
          raw.push({
            key: spec.key, cmd, ok: !looksError, sample: (stdout || stderr).slice(0, RAW_LIMIT), ms,
            ...(r.truncated ? { truncated: true } : {}),
            ...(r.timedOut ? { timedOut: true } : {}),
            ...(r.aborted ? { aborted: r.aborted, abortReason: r.abortReason } : {}),
            ...(r.answers ? { answers: r.answers } : {}),
          });
          if (cut) {
            const n = Object.values(r.answers || {}).reduce((a, b) => a + (b || 0), 0);
            truncatedKeys[spec.key] = {
              cmd, ms, timedOut: !!r.timedOut, answers: n,
              bytes: Buffer.byteLength(String(r.stdout || '')),
              ...(r.aborted ? { aborted: r.aborted, abortReason: r.abortReason } : {}),
            };
          }
          if (looksError) {
            // '오류를 냈다' 와 '원하는 값이 없다' 는 조치가 다르다 — 사유를 구분해 남긴다.
            lastErr = new Error(r.abortReason
              || (!cut && !cliLooksError(stdout, stderr) && !wanted
                ? `${cmd}: 실행은 됐지만 원하는 값이 없습니다(다음 후보로 넘어감).`
                : (firstLine(stdout || stderr) || '빈 출력')));
            continue;
          }
          out[spec.key] = stdout;
          done = true;
          break;
        } catch (e) {
          lastErr = e;
          raw.push({ key: spec.key, cmd, ok: false, sample: `실행 오류: ${e.message}`.slice(0, RAW_LIMIT) });
        }
      }
      if (!done) {
        errors[spec.key] = lastErr?.message || '명령 실패';
        if (spec.required) throw new Error(`${spec.key}: ${errors[spec.key]}`);
      }
    }
    // 예산으로 건너뛴 항목은 '명령이 없는 장비' 와 구분되게 사유를 적는다 — 조치가 다르다
    // (전자는 주기를 늘리거나 예산을 키우면 되고, 후자는 그 장비에 그 명령이 없는 것이다).
    for (const k of skipped) errors[k] = '수집 시간 예산 초과로 이번 주기에는 실행하지 않았습니다(다음 주기에 시도).';
    return { out, raw, errors, skipped, truncated: truncatedKeys, elapsedMs: Date.now() - startedAt, budgetMs };
  });
}

/** 첫 줄(오류 메시지용) — 길면 자른다. */
export function firstLine(text) {
  return String(text || '').split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) || '';
}

/**
 * CSV 출력 파서(uemcli -output csv 등). 헤더 1줄 + 데이터. 따옴표·쉼표를 지키기 위해
 * util/csv.js 의 RFC4180 파서를 쓰지 않고 여기서 최소 구현한다(의존 최소화 — 이 파일은
 * 수집기 전용이고, 장비 CSV 는 헤더가 앞에 배너를 달고 나오는 경우가 있어 전처리가 필요하다).
 */
export function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  // 배너/프롬프트를 건너뛰고 '쉼표가 2개 이상인 첫 줄'을 헤더로 본다.
  const headIdx = lines.findIndex((l) => (l.match(/,/g) || []).length >= 1);
  if (headIdx < 0) return [];
  const split = (line) => {
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
    }
    cells.push(cur);
    // `open` — 줄이 **따옴표 안에서 끝났다** = 그 줄은 중간에서 잘렸다는 뜻이다.
    return { cells: cells.map((s) => s.trim()), open: q };
  };
  const head = split(lines[headIdx]);
  // ⚠ **줄바꿈된 CSV 는 통째로 거부한다**(v2.530 — 실측으로 확정한 결함).
  //   TTY 폭(ssh2 기본 80칸)에 걸려 CSV 가 접히면, 접힌 조각이 데이터 줄로 읽혀
  //   **없는 장비가 만들어진다** — Unity 실측에서 `ID=47%` · 이름 `38 x 3.8T SAS Flash 4`
  //   라는 가짜 풀이 나왔고, 살아남은 줄도 `Current allocation` 이 `(27.2T` 로 잘렸다.
  //   일부를 살리려 하지 말 것: **틀린 값은 빈 값보다 나쁘다**(화면이 정상처럼 보인다).
  //   빈 배열을 돌려주면 `unitySsh.recordsFor` 가 Key=Value 로, 그것도 안 되면 명령 체인의
  //   다음 후보로 넘어간다 — 안전한 쪽으로 실패한다.
  if (head.open) return [];
  const header = head.cells.map((h) => h.replace(/^"|"$/g, ''));
  const rows = [];
  for (const line of lines.slice(headIdx + 1)) {
    const { cells, open } = split(line);
    if (open) return [];                       // 데이터 줄이 잘렸다 — 위와 같은 이유
    if (cells.length < 2) continue;
    // 열 수가 헤더와 다르면 그 줄은 CSV 행이 아니다(접힘 조각·꼬리 배너). 조용히 끼워 넣지 않는다.
    if (cells.length !== header.length) continue;
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/**
 * 'Key = Value' / 'Key: Value' 블록 파서(uemcli 기본 출력, vplexcli ls 등).
 * 빈 줄 또는 새 인덱스(예: '1:  ID = spa')로 레코드를 나눈다.
 */
export function parseKeyValueBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { if (cur && Object.keys(cur).length) { blocks.push(cur); cur = null; } continue; }
    // '3:    ID = spa' 처럼 앞에 레코드 번호가 붙으면 새 레코드 시작.
    const idx = /^(\d+):\s*(.*)$/.exec(t);
    const body = idx ? idx[2] : t;
    if (idx) { if (cur && Object.keys(cur).length) blocks.push(cur); cur = {}; }
    // v2.599(SEC2599-02): 예전 `/^([^=:]+?)\s*[=:]\s*(.*)$/` 는 게으른 키가 한 글자씩 늘 때마다 뒤 공백 연속을 다시 훑어
    //   '=' 도 ':' 도 없는 긴 공백 줄에서 O(n²) 였다(3만 자 약 0.8초). 같은 뜻을 선형으로 — 첫 '='/':' 에서 자른다(키는 1자 이상).
    const sep = body.search(/[=:]/);
    if (sep < 1) continue;
    if (!cur) cur = {};
    cur[body.slice(0, sep).trim()] = body.slice(sep + 1).trim();
  }
  if (cur && Object.keys(cur).length) blocks.push(cur);
  return blocks;
}

/** 출력에서 첫 JSON 값(객체/배열)을 관대하게 추출 — CLI 가 배너를 함께 찍는 경우 대응. */
/*
 * v2.605(감사 LEFT2605-03): 예전 구현은 끝에서 한 글자씩 줄이며 '}'/']' 위치마다 전체 slice 를 JSON.parse 해
 *   잘린·깨진 JSON 에서 O(n²) 였다(160KB 에 26.7초 — 수집은 메인 스레드라 그동안 포탈 전체가 멈춘다).
 *   같은 뜻을 선형으로: 첫 '['/'{' 부터 문자열·이스케이프를 인식해 괄호 깊이를 세고, **깊이가 처음 0 으로 돌아오는
 *   위치** 하나만 JSON.parse 한다. 그 위치가 유일한 후보인 이유 — start 에서 시작하는 유효한 JSON 값이라면 그 값의
 *   토큰화가 이 스캔과 같고 값의 끝에서만 깊이가 0 이 된다(뒤에 다른 글자가 붙으면 JSON.parse 가 거부한다).
 *   옛 구현과의 결과 동일성은 audit2605c 테스트가 결정적 난수 입력으로 대조한다.
 */
export function parseJsonLoose(text) {
  const s = String(text || '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0; let inStr = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    if (inStr) {
      if (ch === 92) i += 1;                 // '\\' — 다음 글자를 건너뛴다
      else if (ch === 34) inStr = false;     // '"'
      continue;
    }
    if (ch === 34) inStr = true;
    else if (ch === 91 || ch === 123) depth += 1;           // '[' '{'
    else if (ch === 93 || ch === 125) {                     // ']' '}'
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 사람이 읽는 용량 문자열 → 바이트. '1.5 TB', '1536G', '12345678' 모두 처리.
 * 단위가 없으면 바이트로 본다(장비 CLI 는 대개 바이트 또는 단위 표기 둘 중 하나다).
 */
/**
 * 사용량처럼 **못 읽은 것과 0 을 구분해야 하는 값**(v2.595, 감사 C2595-01): toBytes 는 빈 값·'N/A'·형식 불명을
 * 0 으로 돌려준다(전체 용량 판정에는 '0 이면 건너뜀' 으로 안전하다). 사용량에 그대로 쓰면 '비었다' 는 거짓이
 * DB 에 적재된다. 숫자로 시작하는 0 표기('0', '0.0T', '0 (0.0T)')만 0 이고 나머지 0 은 null 이다.
 */
export function toBytesOrNull(v) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (s.length > TO_BYTES_MAX_LEN) return null;   // v2.600(SEC2600-02): 형식 미상 — 0 이 아니라 '못 읽음'
  const r = toBytes(s);
  if (r !== 0) return r;
  return /^0+(\.0+)?(\s|$|[kKmMgGtTpPeEbB(])/.test(s) ? 0 : null;   // v2.596: '0B' 도 0
}

/**
 * 공백 정렬 표(xmcli·vplexcli `ll`)의 행을 **머리글 열 위치로** 자른다(v2.600 감사 COL-2600-04 — 두 파서 공용).
 * 공백 2칸 분할은 가운데 칸이 비면 뒤 값을 왼쪽으로 당긴다(끊긴 컨트롤러의 'disconnected' 가 IP 칸에 들어가
 * 상태 미상 → 비정상 0 으로 숨었다). 칸 수가 머리글과 같은 행은 예전 분할을 그대로 쓰고, **다를 때만** 이것을 쓴다.
 * @returns {Record<string,string>|null} 머리글 위치를 확정하지 못하면 null(호출부가 예전 방식으로)
 */
export function sliceRowByHeader(headerLine, header, line) {
  const starts = [];
  let from = 0;
  for (const h of header) {
    const at = String(headerLine).indexOf(h, from);
    if (at < 0 || (starts.length && at <= starts[starts.length - 1])) return null;
    starts.push(at); from = at + h.length;
  }
  const row = {};
  header.forEach((h, i) => { row[h] = String(line).slice(i === 0 ? 0 : starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim(); });
  row._positional = true;   // 위치로 읽었다(진단용 — pick 대상 키가 아니다)
  return row;
}

// v2.600(감사 SEC2600-02): 용량 셀로 받아들이는 최대 길이. 실제 표기(`117544396521472 (106.9T)`·`Size: 11.0T`)는
//   30자 안팎이다 — 그보다 훨씬 긴 셀은 형식을 모르는 것(0 = 미상)으로 본다(장비 출력 한 셀로 루프를 멈추지 않게).
const TO_BYTES_MAX_LEN = 256;

export function toBytes(v) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s || s === '-' || /^(n\/?a|none|unknown)$/i.test(s)) return 0;
  if (s.length > TO_BYTES_MAX_LEN) return 0;

  // ⚠ v2.525 (사용자 신고 "unity 장비에 ssh 로 접속은 성공했는데, 수집하는 정보가 없어"):
  //   **uemcli 는 바이트와 사람용 표기를 함께 낸다** — `12094627905536 (11.0T)`.
  //   예전 정규식은 `^숫자+단위$` 만 받아 이 형태를 **0 으로 버렸고**, `unitySsh.normalizeUnitySsh`
  //   가 `if (!t) continue;` 로 그 풀을 건너뛰어 **풀 0개 · 용량 섹션 '건너뜀'** 이 됐다
  //   (화면은 '0.0 TB' 로 보였다 — 수집 실패가 아니라 파싱 실패였다).
  //   앞에 붙은 **정수 바이트가 있으면 그것이 가장 정확하므로 우선한다**(괄호 안은 반올림 표기다).
  const paren = /^(\d+)\s*\(/.exec(s);
  if (paren) return Number(paren[1]);

  const m = /^([\d.]+)\s*([kKmMgGtTpPeE])?(?:i?[bB])?$/.exec(s);
  if (!m) {
    // `11.0T (12094627905536)` 처럼 순서가 뒤바뀐 표기, 또는 `Size: 11.0T` 같은 접두가 붙은 값.
    // ⚠ v2.600(감사 SEC2600-02 — 재현 60,000자 셀 7,979ms): 앵커 없는 `([\d.]+)\s*` 는 단위 없는 긴 숫자열에서
    //   시작 위치마다 끝까지 다시 훑어 O(n²) 였다. 숫자·공백 길이에 상한을 둬 시작 위치당 작업을 상수로 묶는다.
    const any = /((?:\d{1,30}(?:\.\d{0,12})?|\.\d{1,12}))\s{0,8}([kKmMgGtTpPeE])(?:i?[bB])?/.exec(s);
    if (!any) {
      const plain = /^(\d+)$/.exec(s);
      return plain ? Number(plain[1]) : 0;
    }
    return scale(Number(any[1]), any[2]);
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return scale(n, m[2]);
}

function scale(n, unit) {
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5, e: 1024 ** 6 }[String(unit || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}

/**
 * 실패 스냅샷(공통) — SSH 자체가 안 될 때. raw 를 붙여 진단이 가능하게 한다.
 *
 * ⚠ **자격증명 거부는 여기서 '인증 실패' 라고 못 박는다**(v2.541). 예전에는 어떤 실패든
 * `SSH 수집 실패: <원문>` 이었고, ssh2 의 원문은
 * `All configured authentication methods failed` 라 `util/authGuard.js` 의 판정을 빠져나갔다
 * → 비밀번호가 틀려도 **주기 수집이 멈추지 않고 매 주기 같은 계정으로 재로그인**했다
 * (계정 잠금 경로. v2.528 이 막으려던 바로 그것). 판정은 문구가 아니라 ssh2 의
 * `err.level` 을 보는 `isSshAuthError` 가 한다.
 *
 * ⚠ 원문을 지우지 말 것 — 뒤에 그대로 붙인다. '인증 실패' 라고만 하면 어느 단계에서
 * 거부됐는지(공개키/비밀번호/키보드 인터랙티브)를 사용자가 알 수 없다.
 */
/**
 * 버전 항목의 후보별 시도 요약(순수, v2.585) — 화면의 '버전' 열이 빈 이유를 말하는 재료.
 * 원문 앞 160자만 싣는다(전체는 `cliRaw` 에 있다). 시도가 없으면 빈 배열(예산으로 건너뛴 경우 — `errors.version` 이 말한다).
 */
export function versionAttemptsOf(raw = []) {
  return (Array.isArray(raw) ? raw : []).filter((x) => x && x.key === 'version').map((x) => ({
    cmd: String(x.cmd || ''), ok: !!x.ok, ms: Number.isFinite(Number(x.ms)) ? Number(x.ms) : null,
    ...(x.timedOut ? { timedOut: true } : {}), ...(x.truncated ? { truncated: true } : {}),
    ...(x.aborted ? { aborted: String(x.abortReason || x.aborted) } : {}),
    head: String(x.sample || '').slice(0, 160),
  }));
}

export function sshFailureSnapshot(device, err, raw = []) {
  const snap = emptySnapshot(device);
  snap.extra = { collectMethod: 'ssh', cliRaw: raw, versionAttempts: versionAttemptsOf(raw) };
  const msg = err?.message || err;
  snap.error = isSshAuthError(err)
    ? `SSH 인증 실패: ${msg} — 계정·비밀번호(또는 개인키)를 확인하세요.`
    : `SSH 수집 실패: ${msg}`;
  return snap;
}
