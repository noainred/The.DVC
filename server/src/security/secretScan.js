/**
 * secretScan.js — 평문 자격증명 점검 스캐너(특수기능, v2.297).
 *
 * 사용자 요구사항(2026-08-15): 소스·로그·설정 등을 점검해 **평문으로 저장된 계정정보/로그인
 * 정보**가 있는지 확인하는 기능. v2.296 자격증명 암호화(secretVault)와 짝을 이룬다 —
 * "어디에 평문이 남아 있나"를 찾아 '설정 › 자격증명 저장 방식'으로 전환을 유도한다.
 *
 * 설계 원칙:
 * - **값은 절대 응답에 싣지 않는다**: 설정 필드는 위치+상태+길이만, 로그/소스 매치는 비밀
 *   부분을 '***'로 치환한 프리뷰만 반환한다(점검 도구가 유출 통로가 되면 본말전도).
 *   회귀 테스트가 '응답 직렬화에 원문 비밀 부재'를 고정한다(secretScan.test.js).
 * - **논블로킹**(CLAUDE.md): 파일 사이마다 setImmediate 로 이벤트 루프를 양보하고,
 *   파일당 바이트 상한(로그는 꼬리 2MB·소스는 512KB·설정 JSON 5MB)·파일 수 상한을 둔다 —
 *   수집 폴링과 동시에 돌아도 UI 가 멈추지 않는다.
 * - **단일 실행 + 짧은 캐시**: 스캔 중 재요청은 진행 중 결과에 합류(single-flight), 완료
 *   결과는 30초 캐시(연타가 디스크 전수 재스캔을 만들지 않게).
 * - **정직한 분류**: 설정 필드는 확정(평문/암호화/빈값 — secretVault 포맷 판정), 로그/소스
 *   매치는 정규식 기반이라 오탐 가능 → '의심(검토 필요)'로만 표기(과장 금지).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SECRET_FIELDS, isSealed } from './secretVault.js';

const yieldLoop = () => new Promise((r) => setImmediate(r));
const MASK = '***';

/** 비밀값 마스킹 — 길이만 노출(값 특성 유추 최소화, 빈값/짧은값도 동일 포맷). */
const maskLen = (v) => `${MASK}(${String(v).length}자)`;

/* ── ① 설정 파일(CONFIG_DIR/*.json) — secretVault 와 같은 판정으로 확정 분류 ── */

const CONFIG_JSON_MAX = 5 * 1024 * 1024; // 5MB 초과 JSON(대형 스캔 결과 등)은 건너뛰고 사유 보고

function walkFields(obj, cb, trail = '') {
  if (Array.isArray(obj)) { obj.forEach((v, i) => walkFields(v, cb, `${trail}[${i}]`)); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && SECRET_FIELDS.has(k)) cb(`${trail ? `${trail}.` : ''}${k}`, k, v);
      else walkFields(v, cb, `${trail ? `${trail}.` : ''}${k}`);
    }
  }
}

/** 파일 권한 문자열(예: 600)·그룹/외부 읽기 가능 여부 — 평문이면 권한이 최후 방어선이라 함께 점검. */
function fileMode(fp) {
  try {
    const m = fs.statSync(fp).mode & 0o777;
    return { mode: m.toString(8).padStart(3, '0'), wide: (m & 0o044) !== 0 };
  } catch { return { mode: '', wide: false }; }
}

async function scanConfigFiles() {
  const dir = config.configDir;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return out; }
  for (const name of names) {
    const fp = path.join(dir, name);
    const row = { file: name, ...fileMode(fp), plain: 0, sealed: 0, empty: 0, items: [], note: '' };
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) continue;
      if (st.size > CONFIG_JSON_MAX) { row.note = `크기 초과(${Math.round(st.size / 1e6)}MB) — 건너뜀`; out.push(row); continue; }
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      walkFields(data, (pathStr, field, v) => {
        const state = v === '' ? 'empty' : (isSealed(v) ? 'sealed' : 'plain');
        row[state] += 1;
        // 위치·필드·상태·길이만 — 값 자체는 어떤 상태여도 싣지 않는다.
        if (state !== 'empty' && row.items.length < 200) row.items.push({ path: pathStr, field, state, len: v.length });
      });
    } catch (e) { row.note = `파싱 실패(${String(e.message).slice(0, 60)})`; }
    // 비밀 필드가 하나도 없는 파일은 목록 소음이라 제외(권한 이상 파일은 유지해 경고).
    if (row.plain || row.sealed || row.empty || row.note || row.wide) out.push(row);
    await yieldLoop();
  }
  return out;
}

/* ── ② portal.env — env 시크릿은 '평문이 정상 위치'라 존재+권한만 점검(값·이름 유추 최소) ── */

const ENV_SENSITIVE = /(PASS|PASSWORD|TOKEN|SECRET|KEY)$/;

function scanEnvFile() {
  const fp = path.join(config.configDir, 'portal.env');
  if (!fs.existsSync(fp)) return null;
  const row = { file: 'portal.env', ...fileMode(fp), keys: [] };
  try {
    for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || !m[2].trim()) continue;
      if (ENV_SENSITIVE.test(m[1])) row.keys.push({ key: m[1], len: m[2].trim().length });
    }
  } catch { /* 읽기 실패 — 키 목록 없이 권한만 */ }
  return row;
}

/* ── ③ 로그 파일 — 비밀번호가 '기록되어 버린' 흔적을 패턴으로 탐지(의심 수준) ── */

const LOG_TAIL_BYTES = 2 * 1024 * 1024;   // 파일당 꼬리 2MB — GB 로그를 통째로 읽지 않는다
const LOG_MAX_HITS_PER_FILE = 20;

// (패턴, 마스킹할 그룹 idx). 값 그룹은 프리뷰에서 ***로 치환된다.
const LOG_PATTERNS = [
  { name: 'password=', re: /(password|passwd|pwd)["']?\s*[:=]\s*["']?([^"'\s&,}]{3,})/i, g: 2 },
  { name: 'url-cred', re: /:\/\/([^/\s:@]+):([^@\s]{3,})@/, g: 2 },
  { name: 'basic-auth', re: /(authorization\s*[:=]\s*["']?basic\s+)([A-Za-z0-9+/=]{8,})/i, g: 2 },
];

// 프리뷰 마스킹용 패턴(v2.313 보안 감사 수정) — 탐지용 LOG_PATTERNS 와 별개로, 값 경계를
// **공백까지**로 넓혀(콤마·특수문자 포함 비밀번호가 통째로 가려지게) 전역(g)으로 마스킹한다.
// 과거: 탐지 그룹(`[^"'\s&,}]`)이 콤마·& 에서 끊겨 `password=***,w0rd,2026` 처럼 비밀번호
// 뒷부분이 프리뷰에 원문 노출됐고, 한 줄에 자격증명이 둘이면 두 번째가 안 가려졌다. 과다
// 마스킹은 안전(부분 노출이 유출) — 점검 도구가 유출 통로가 되지 않게 값을 통째로 가린다.
const MASK_PATTERNS = [
  /((?:password|passwd|pwd)["']?\s*[:=]\s*["']?)([^\s"']{3,})/ig,                       // password=... (공백/따옴표 전까지)
  /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"`])([^'"`]{3,})(['"`])/ig,  // 소스 따옴표 값(SRC_RE 탐지 대응 — secret/token/api_key 포함)
  /(:\/\/[^/\s:@]+:)([^@\s]{3,})(@)/ig,                                                  // scheme://user:PASS@
  /((?:authorization\s*[:=]\s*["']?basic\s+))([A-Za-z0-9+/=]{8,})/ig,                    // Authorization: Basic <b64>
];

/**
 * 한 줄 전체를 모든 패턴으로 마스킹한 뒤, 첫 마스킹 지점 주변 160자만 프리뷰로 돌려준다.
 * 안전 폴백: 어떤 패턴도 마스킹하지 못하면(탐지 정규식과 마스킹 정규식이 어긋난 경우) 원문을
 * 절대 돌려주지 않고 전체를 숨긴다 — 점검 도구가 유출 통로가 되지 않게(v2.313 감사 반영).
 */
function maskLine(line) {
  let masked = String(line);
  for (const re of MASK_PATTERNS) masked = masked.replace(re, (_full, pre, _val, post = '') => `${pre}${MASK}${post}`);
  if (!masked.includes(MASK)) return `${MASK} (마스킹 패턴 불일치 — 값 전체 숨김)`;
  const at = Math.max(0, masked.indexOf(MASK) - 60);
  return masked.slice(at, at + 160);
}

async function scanLogFiles() {
  const out = [];
  const targets = [];
  try {
    for (const n of fs.readdirSync(config.configDir)) {
      if (/\.(ndjson|log)$/.test(n)) targets.push(path.join(config.configDir, n));
    }
  } catch { /* */ }
  // svcmon CSV 로그 디렉터리(있으면) — 점검 결과 기록에 비밀번호가 섞였는지.
  try {
    const { logDir } = await import('../svcmon/logsettings.js');
    const d = logDir();
    if (d && fs.existsSync(d)) for (const n of fs.readdirSync(d).slice(0, 50)) targets.push(path.join(d, n));
  } catch { /* svcmon 미사용 구성 */ }

  for (const fp of targets.slice(0, 100)) {
    try {
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size === 0) continue;
      const start = Math.max(0, st.size - LOG_TAIL_BYTES);
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(Math.min(st.size, LOG_TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const hits = [];
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < LOG_MAX_HITS_PER_FILE; i++) {
        for (const p of LOG_PATTERNS) {
          const m = p.re.exec(lines[i]);
          // 마스킹 흔적(***)·해시 필드 등 명백한 비값은 제외 — 오탐 소음 억제.
          if (m && !m[p.g].startsWith(MASK) && !/passwordhash/i.test(lines[i])) {
            hits.push({ pattern: p.name, preview: maskLine(lines[i]) });
            break;
          }
        }
      }
      if (hits.length) out.push({ file: path.relative(config.configDir, fp), scanned: `${Math.round(buf.length / 1024)}KB(꼬리)`, truncated: start > 0, hits });
    } catch { /* 개별 파일 실패는 무시(점검 도구가 죽으면 안 됨) */ }
    await yieldLoop();
  }
  return out;
}

/* ── ④ 소스 — 하드코딩된 자격증명 의심 라인(정규식 휴리스틱 — '검토 필요' 수준) ── */

const SRC_EXT = new Set(['.js', '.jsx', '.mjs', '.py', '.sh', '.yml', '.yaml', '.env']);
const SRC_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'vendor', 'intro', 'coverage']);
const SRC_MAX_FILES = 4000;
const SRC_MAX_BYTES = 512 * 1024;
const SRC_MAX_HITS = 100;
// 값이 실제 문자열 리터럴로 박힌 경우만: password: 'secret123' / PASSWORD="..." 등.
const SRC_RE = /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"`]([^'"`]{6,})['"`]/i;
// 명백한 비값(플레이스홀더·필드 정의·마스킹·예시)은 제외 — 오탐 소음 억제. 완전하지 않다(정직 표기).
const SRC_FALSE = /(\*{3}|example|sample|샘플|placeholder|redact|000000|process\.env|\$\{|<[^>]+>|changeme|your[-_]?)/i;

async function scanSourceDirs(dirs) {
  const out = [];
  let seen = 0;
  const walk = async (dir, depth) => {
    if (depth > 8 || seen > SRC_MAX_FILES || out.length >= SRC_MAX_HITS) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= SRC_MAX_HITS) return;
      if (e.isDirectory()) { if (!SRC_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1); continue; }
      if (!SRC_EXT.has(path.extname(e.name))) continue;
      seen += 1;
      if (seen % 20 === 0) await yieldLoop();
      const fp = path.join(dir, e.name);
      try {
        const st = fs.statSync(fp);
        if (st.size > SRC_MAX_BYTES) continue;
        const lines = fs.readFileSync(fp, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = SRC_RE.exec(lines[i]);
          if (!m || SRC_FALSE.test(lines[i])) continue;
          out.push({ file: fp, line: i + 1, preview: maskLine(lines[i].trim()).slice(0, 160) });
          if (out.length >= SRC_MAX_HITS) break;
        }
      } catch { /* 개별 파일 실패 무시 */ }
    }
  };
  for (const d of dirs) if (d && fs.existsSync(d)) await walk(d, 0);
  return { hits: out, scannedFiles: seen, capped: seen > SRC_MAX_FILES || out.length >= SRC_MAX_HITS };
}

/* ── 실행(단일 비행 + 30초 캐시) ─────────────────────────────────────────── */

const SRC_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'); // server/src
let _inflight = null;
let _last = null; // { at, result }

export async function runSecretScan({ fresh = false, sourceDirs } = {}) {
  if (!fresh && _last && Date.now() - _last.at < 30_000) return _last.result;
  if (_inflight) return _inflight; // 스캔 중 재요청은 합류(전수 재스캔 중복 방지)
  _inflight = (async () => {
    const t0 = Date.now();
    const dirs = sourceDirs || [SRC_ROOT, path.resolve(SRC_ROOT, '../../web/src')]; // 패키징 설치엔 web/src 부재 — exists 검사로 자연 제외
    const [configFiles, logs, source] = [await scanConfigFiles(), await scanLogFiles(), await scanSourceDirs(dirs)];
    const env = scanEnvFile();
    const sum = (k) => configFiles.reduce((a, f) => a + (f[k] || 0), 0);
    const result = {
      generatedAt: Date.now(), ms: Date.now() - t0,
      summary: {
        configPlain: sum('plain'), configSealed: sum('sealed'), configEmpty: sum('empty'),
        envKeys: env?.keys?.length || 0, logHits: logs.reduce((a, f) => a + f.hits.length, 0),
        sourceHits: source.hits.length, widePerm: configFiles.filter((f) => f.wide).length + (env?.wide ? 1 : 0),
      },
      configFiles, env, logs, source,
    };
    _last = { at: Date.now(), result };
    return result;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

export { maskLen }; // 테스트용(마스킹 규약 고정)
