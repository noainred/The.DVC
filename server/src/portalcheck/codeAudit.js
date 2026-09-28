/**
 * portalcheck/codeAudit.js — 포탈 점검 › **코드 감사**(v2.636). 감사 결과 카탈로그(`codeAudit.json`)를 읽고
 * **각 발견의 앵커(코드 조각)가 지금 이 설치본의 소스에 아직 있는지** 를 확인해 화면에 내린다.
 *
 * 사용자 요청(2026-09-28): "전체 코드 분석해서 아키텍처 리뷰·버그·개선 포인트·튜닝 포인트 각각 10개씩 찾아서
 * 문서로 저장하고 화면에도 보여줘". 선택: 포탈 화면(특수 기능 › 포탈 점검 › 코드 감사) · 전체 검증 · 수정은 다음 요청.
 *
 * ── 원천은 하나다 ────────────────────────────────────────────────────────────
 *  · `codeAudit.json` 이 원천이고 `docs/AUDIT-2026-09-28.md` 는 `scripts/code-audit-doc.mjs` 가 그것으로 **생성**한다
 *    (CLAUDE.md v2.563 '문서는 손으로 적는 목록을 두지 않는다'). 화면도 같은 JSON 을 이 라우트로 받는다 —
 *    문서와 화면이 다른 말을 할 수 없다.
 *  · 발견은 **감사 시점(`base` 커밋)의 파일:라인**이다. 코드는 계속 바뀌므로 화면이 '이 발견이 아직 소스에 있는가' 를
 *    앵커로 확인한다(`checkAnchor`): present(같은 줄) · moved(다른 줄에 있음) · gone(파일은 있는데 조각이 없음 —
 *    고쳐졌거나 바뀐 것, **어느 쪽인지 단정하지 않는다**) · missing-file · no-source(이 설치본에 그 소스 트리가 없다 —
 *    오프라인 패키지·업그레이드 번들은 `web/dist` 만 담고 `web/src` 를 담지 않는다) · unchecked(status 가 fixed).
 *  · 고쳐진 발견은 JSON 의 `status:'fixed'` + `fixedIn` 으로 밝힌다 — 지우지 않는다(무엇을 찾았고 언제 고쳤는지가 기록).
 *    회귀 테스트(`test/codeAudit2636.test.js`)가 open 발견의 앵커가 소스에 실재하는지 고정하므로, 발견을 고칠 때는
 *    그 커밋에서 status 를 fixed 로 바꿔야 한다(안 바꾸면 테스트가 '앵커가 사라졌다' 로 잡는다).
 *
 * ── 이 모듈이 하지 않는 것 ──────────────────────────────────────────────────
 *  · 판정을 다시 하지 않는다 — 감사가 정한 심각도·신뢰도를 그대로 전한다. 앵커 확인은 '있는가' 뿐이다.
 *  · 장비·엣지·네트워크에 나가지 않는다(왕복 0). 파일은 상한(`MAX_FILE_BYTES`) 안에서만 읽는다.
 *  · 절대 경로를 응답에 싣지 않는다 — `file` 은 저장소 상대 경로다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 저장소 루트(server/src/portalcheck → 3단계 위). 배포본도 같은 상대 구조다(`server/src/...`). */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const DATA_FILE = path.join(HERE, 'codeAudit.json');

export const CATEGORIES = Object.freeze(['arch', 'bug', 'improve', 'tuning']);
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const CONFIDENCES = Object.freeze(['confirmed', 'likely', 'speculative']);
export const ANCHOR_STATES = Object.freeze(['present', 'moved', 'gone', 'missing-file', 'no-source', 'unchecked']);
export const FINDING_STATUS = Object.freeze(['open', 'fixed']);
/** 카테고리마다 이 개수(사용자 요청 '각각 10개씩'). 테스트가 고정한다. */
export const PER_CATEGORY = 10;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const FINDING_STR_FIELDS = Object.freeze(['id', 'title', 'file', 'anchor', 'evidence', 'impact', 'fix']);

const t = (v) => String(v ?? '').trim();

/** JSON 을 읽는다 — 못 읽으면 `ok:false` + 사유(조용한 빈값 금지). */
export function loadCodeAudit({ file = DATA_FILE } = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const errors = validateCodeAudit(data);
    return { ok: errors.length === 0, data, errors };
  } catch (e) {
    return { ok: false, data: null, errors: [`codeAudit.json 을 읽지 못했습니다: ${String(e?.message || e).slice(0, 200)}`] };
  }
}

/**
 * 모양 검사 — 결함이 있으면 문장 배열(빈 배열이면 정상). 개수 규칙(카테고리마다 PER_CATEGORY)은 **open+fixed 합**으로 본다
 * (고친 발견도 목록에 남긴다).
 */
export function validateCodeAudit(data) {
  const errs = [];
  if (!data || typeof data !== 'object') return ['최상위가 객체가 아닙니다'];
  for (const k of ['version', 'date', 'base', 'doc']) if (!t(data[k])) errs.push(`${k} 가 비어 있습니다`);
  if (!Array.isArray(data.findings)) return [...errs, 'findings 가 배열이 아닙니다'];
  const ids = new Set();
  const perCat = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  data.findings.forEach((f, i) => {
    const where = `findings[${i}]${f?.id ? `(${f.id})` : ''}`;
    if (!f || typeof f !== 'object') { errs.push(`${where}: 객체가 아닙니다`); return; }
    for (const k of FINDING_STR_FIELDS) if (!t(f[k])) errs.push(`${where}: ${k} 가 비어 있습니다`);
    if (!CATEGORIES.includes(f.category)) errs.push(`${where}: category '${f.category}' 는 ${CATEGORIES.join('|')} 가 아닙니다`);
    if (!SEVERITIES.includes(f.severity)) errs.push(`${where}: severity '${f.severity}' 는 ${SEVERITIES.join('|')} 가 아닙니다`);
    if (!CONFIDENCES.includes(f.confidence)) errs.push(`${where}: confidence '${f.confidence}' 는 ${CONFIDENCES.join('|')} 가 아닙니다`);
    if (!FINDING_STATUS.includes(f.status || 'open')) errs.push(`${where}: status '${f.status}' 는 ${FINDING_STATUS.join('|')} 가 아닙니다`);
    if (!Number.isInteger(f.line) || f.line < 1) errs.push(`${where}: line 은 1 이상의 정수여야 합니다`);
    if (!Number.isInteger(f.rank) || f.rank < 1 || f.rank > PER_CATEGORY) errs.push(`${where}: rank 는 1..${PER_CATEGORY} 여야 합니다`);
    if (path.isAbsolute(t(f.file)) || t(f.file).includes('..')) errs.push(`${where}: file 은 저장소 상대 경로여야 합니다`);
    if (ids.has(f.id)) errs.push(`${where}: id 중복`); ids.add(f.id);
    if (f.also != null && !Array.isArray(f.also)) errs.push(`${where}: also 는 배열이어야 합니다`);
    // 화면은 BoldText 로 그린다 — 백틱은 글자로 샌다(CLAUDE.md v2.576). repro 는 <pre> 라 예외.
    for (const k of ['title', 'evidence', 'impact', 'fix', 'prior']) if (String(f[k] ?? '').includes('`')) errs.push(`${where}: ${k} 에 백틱`);
    if (perCat[f.category]) perCat[f.category].push(f);
  });
  for (const c of CATEGORIES) {
    const list = perCat[c];
    if (list.length !== PER_CATEGORY) errs.push(`category ${c}: ${list.length}건 — ${PER_CATEGORY}건이어야 합니다`);
    const ranks = new Set(list.map((f) => f.rank));
    if (ranks.size !== list.length) errs.push(`category ${c}: rank 중복`);
  }
  return errs;
}

/** 소스 트리 존재 여부 — `file` 의 앞 두 조각(예: web/src) 디렉터리가 있는가. */
function treeOf(file) {
  const segs = t(file).split('/').filter(Boolean);
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0] || '';
}

/**
 * 앵커 확인(순수 I/O — 파일 하나만 읽는다). @returns {{state:string, lineNow:number|null}}
 * ⚠ 'gone' 은 '고쳐졌다' 가 아니다 — 조각이 바뀐 것일 수도 있다. 화면 문구가 그렇게 말한다.
 */
export function checkAnchor(finding, { root = REPO_ROOT } = {}) {
  if ((finding?.status || 'open') === 'fixed') return { state: 'unchecked', lineNow: null };
  const rel = t(finding?.file);
  const anchor = String(finding?.anchor ?? '');
  if (!rel || !anchor) return { state: 'unchecked', lineNow: null };
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return { state: 'unchecked', lineNow: null };
  let st;
  try { st = fs.statSync(abs); } catch {
    const tree = path.resolve(root, treeOf(rel));
    return { state: fs.existsSync(tree) ? 'missing-file' : 'no-source', lineNow: null };
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return { state: 'unchecked', lineNow: null };
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const want = Number(finding.line);
  if (Number.isInteger(want) && want >= 1 && want <= lines.length && lines[want - 1].includes(anchor)) return { state: 'present', lineNow: want };
  const idx = lines.findIndex((l) => l.includes(anchor));
  return idx >= 0 ? { state: 'moved', lineNow: idx + 1 } : { state: 'gone', lineNow: null };
}

/** 카테고리·심각도·신뢰도·앵커 상태·조치 상태 개수(항등식: 카테고리 합 = 전체). */
export function kpiOf(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const count = (keys, pick) => Object.fromEntries(keys.map((k) => [k, list.filter((f) => pick(f) === k).length]));
  return {
    total: list.length,
    byCategory: count(CATEGORIES, (f) => f?.category),
    bySeverity: count(SEVERITIES, (f) => f?.severity),
    byConfidence: count(CONFIDENCES, (f) => f?.confidence),
    byAnchor: count(ANCHOR_STATES, (f) => f?.check?.state),
    byStatus: count(FINDING_STATUS, (f) => f?.status || 'open'),
  };
}

/** 응답 조립 — 라우트가 부른다. 절대 경로 0(테스트 고정). */
export function buildCodeAuditReport({ root = REPO_ROOT, file = DATA_FILE } = {}) {
  const loaded = loadCodeAudit({ file });
  if (!loaded.data) return { ok: false, errors: loaded.errors, findings: [], kpi: kpiOf([]), source: sourceInfo(root) };
  const findings = loaded.data.findings.map((f) => ({ ...f, status: f.status || 'open', also: Array.isArray(f.also) ? f.also : [], check: checkAnchor(f, { root }) }));
  const { findings: _omit, ...head } = loaded.data;
  return { ok: loaded.ok, errors: loaded.errors, ...head, findings, kpi: kpiOf(findings), source: sourceInfo(root), vocab: { categories: CATEGORIES, severities: SEVERITIES, confidences: CONFIDENCES, anchorStates: ANCHOR_STATES, status: FINDING_STATUS } };
}

/** 이 설치본에 어느 소스 트리가 있는가 — 화면이 'no-source' 를 설명하는 근거. */
export function sourceInfo(root = REPO_ROOT) {
  const has = (p) => { try { return fs.statSync(path.join(root, p)).isDirectory(); } catch { return false; } };
  return { serverSrc: has('server/src'), webSrc: has('web/src'), docs: has('docs'), scripts: has('scripts') };
}
