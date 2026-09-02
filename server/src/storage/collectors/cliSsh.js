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
 * 한 SSH 세션에서 명령 묶음을 실행한다.
 * specs: [{ key, section?, cmds: [string, ...], required? }]
 *   - cmds 는 **후보 목록**이다. 앞에서부터 시도해 '쓸 만한 출력'이 나오면 멈춘다(버전차 폴백).
 *   - required 인 명령이 전부 실패하면 전체 수집을 실패로 본다(대개 핵심 상태 조회).
 * 반환: { out: {key: stdout}, raw: [{key, cmd, ok, sample}], errors: {key: message} }
 */
export async function runCliSession(device, specs) {
  const creds = {
    host: device.host,
    port: Number(device.sshPort) || 22,
    username: device.username,
    password: device.password || '',
  };
  return withSsh(creds, async (sh) => {
    const out = {};
    const raw = [];
    const errors = {};
    for (const spec of specs) {
      let lastErr = null;
      let done = false;
      for (const cmd of spec.cmds) {
        try {
          const r = await sh.exec(cmd, CMD_TIMEOUT_MS);
          const stdout = String(r.stdout || '');
          const stderr = String(r.stderr || '');
          // CLI 는 오류를 exit code 0 + stderr/본문 문구로 내보내는 경우가 흔하다.
          // 그래서 code 만 보지 않고 '내용이 있는지'와 '오류 문구인지'를 함께 본다.
          const looksError = !stdout.trim() || /^\s*(error|command not found|invalid|unknown command)/i.test(stdout)
            || /command not found|not recognized/i.test(stderr);
          raw.push({ key: spec.key, cmd, ok: !looksError, sample: (stdout || stderr).slice(0, RAW_LIMIT) });
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
    return { out, raw, errors };
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
    return cells.map((s) => s.trim());
  };
  const header = split(lines[headIdx]).map((h) => h.replace(/^"|"$/g, ''));
  const rows = [];
  for (const line of lines.slice(headIdx + 1)) {
    const cells = split(line);
    if (cells.length < 2) continue;
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
  if (!s) return 0;
  const m = /^([\d.]+)\s*([kKmMgGtTpP])?(?:i?[bB])?$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] || '').toLowerCase();
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 }[unit] || 1;
  return Math.round(n * mult);
}

/** 실패 스냅샷(공통) — SSH 자체가 안 될 때. raw 를 붙여 진단이 가능하게 한다. */
export function sshFailureSnapshot(device, err, raw = []) {
  const snap = emptySnapshot(device);
  snap.extra = { collectMethod: 'ssh', cliRaw: raw };
  snap.error = `SSH 수집 실패: ${err?.message || err}`;
  return snap;
}
