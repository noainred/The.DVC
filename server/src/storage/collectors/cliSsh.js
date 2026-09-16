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

import { withSsh } from '../../proxy/sshExec.js';
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
 * @param {object[]} specs `[{ key, section?, cmds, required?, answered?, rules? }]`
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
    const skipped = [];      // 예산이 모자라 **시작조차 하지 않은** 항목 — 반드시 밝힌다
    for (const spec of specs) {
      // ── 세션 예산(v2.528) ──
      // 필수 항목은 예산을 무시하고 시도한다(그것이 없으면 스냅샷 자체가 무의미하다).
      if (!spec.required && leftMs() < MIN_SLICE_MS) { skipped.push(spec.key); continue; }
      let lastErr = null;
      let done = false;
      for (const cmd of spec.cmds) {
        try {
          // 남은 예산 안에서만 기다린다 — 한 명령이 전체 예산을 먹지 않게.
          const slice = spec.required ? CMD_TIMEOUT_MS : Math.max(MIN_SLICE_MS, Math.min(CMD_TIMEOUT_MS, leftMs()));
          const r = spec.answered
            ? await sh.execAnswered(cmd, { timeoutMs: slice, rules: spec.rules || ['certAccept', 'pager'] })
            : await sh.exec(cmd, slice);
          // 배너·프롬프트를 먼저 걷어낸다 — 그 뒤에 오류 판정·파싱을 한다(둘이 같은 텍스트를 봐야 한다).
          const stdout = clean(String(r.stdout || ''));
          const stderr = String(r.stderr || '');
          // CLI 는 오류를 exit code 0 + stderr/본문 문구로 내보내는 경우가 흔하다.
          const looksError = cliLooksError(stdout, stderr);
          raw.push({
            key: spec.key, cmd, ok: !looksError, sample: (stdout || stderr).slice(0, RAW_LIMIT),
            ...(r.truncated ? { truncated: true } : {}),
            ...(r.answers ? { answers: r.answers } : {}),
          });
          if (looksError) { lastErr = new Error(firstLine(stdout || stderr) || '빈 출력'); continue; }
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
    return { out, raw, errors, skipped, elapsedMs: Date.now() - startedAt, budgetMs };
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
    const m = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(body);
    if (!m) continue;
    if (!cur) cur = {};
    cur[m[1].trim()] = m[2].trim();
  }
  if (cur && Object.keys(cur).length) blocks.push(cur);
  return blocks;
}

/** 출력에서 첫 JSON 값(객체/배열)을 관대하게 추출 — CLI 가 배너를 함께 찍는 경우 대응. */
export function parseJsonLoose(text) {
  const s = String(text || '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  for (let end = s.length; end > start; end -= 1) {
    const slice = s.slice(start, end);
    const last = slice.trimEnd().slice(-1);
    if (last !== '}' && last !== ']') continue;
    try { return JSON.parse(slice); } catch { /* 더 짧게 재시도 */ }
  }
  return null;
}

/**
 * 사람이 읽는 용량 문자열 → 바이트. '1.5 TB', '1536G', '12345678' 모두 처리.
 * 단위가 없으면 바이트로 본다(장비 CLI 는 대개 바이트 또는 단위 표기 둘 중 하나다).
 */
export function toBytes(v) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s || s === '-' || /^(n\/?a|none|unknown)$/i.test(s)) return 0;

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
    const any = /([\d.]+)\s*([kKmMgGtTpPeE])(?:i?[bB])?/.exec(s);
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

/** 실패 스냅샷(공통) — SSH 자체가 안 될 때. raw 를 붙여 진단이 가능하게 한다. */
export function sshFailureSnapshot(device, err, raw = []) {
  const snap = emptySnapshot(device);
  snap.extra = { collectMethod: 'ssh', cliRaw: raw };
  snap.error = `SSH 수집 실패: ${err?.message || err}`;
  return snap;
}
