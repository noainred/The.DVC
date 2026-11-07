/**
 * issues/fromComment.js — 위키 댓글 → 이슈 1건 만들기의 판정 · 본문 조립(v2.907 · 시안 docs/design/wiki-mention ② · 결정 1 · 2 · 4).
 *
 * 순수 — 저장은 라우트가 createIssue 로 한다(범위 · 상한 · 자동 할당 판정은 그쪽 하나). 여기서는 저장 **전에** 거를 수 있는 것을 전부 거른다:
 *  · 담당자는 그 댓글에서 언급한 사람 중에서만(기본 = 첫 언급) · 그 법인 이슈를 볼 수 있어야 한다(issues/visibility.js canSee) — 아니면 400.
 *  · 나머지 언급은 관찰자 — 그 법인을 볼 수 없는 사람은 빼고 센다(skipped — 조용히 빼지 않는다).
 *  · 요청 권한(viewer) 계정은 '요청' 유형만 · 담당자 · 관찰자 없음(결정 2 — createIssue requestOnly 와 같은 규칙).
 *  · 법인 = 문서의 스페이스(공용 스페이스 → 공용 이슈). 화면이 바꿀 수 없다.
 *  · 출처 origin { kind:'wiki-comment', pageId, commentId } — 같은 댓글로 두 번 만들지 않는 판정의 열쇠.
 */
export const COMMENT_ISSUE_TYPES = Object.freeze(['task', 'incident', 'request']);
const PRIOS = Object.freeze(['p0', 'p1', 'p2', 'p3']);
const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const PUB = 'pub';

function fieldError(field, msg) { const e = new Error(msg); e.status = 400; e.field = field; return e; }
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 문서 스페이스 → 이슈 법인('' = 공용). */
export const vcenterOfSpace = (spaceId) => (!spaceId || spaceId === PUB ? '' : String(spaceId));

/** 기본 제목 — '[위키] 문서 제목 — 댓글 앞부분'(멘션 글자는 계정만 남긴다). */
export function defaultIssueTitle(pageTitle, commentBody) {
  const ex = oneLine(String(commentBody || '').replace(/@([^\s@,()/]{1,64})\/[^\s@,()]{1,64}/g, '@$1')).slice(0, 80);
  return `[위키] ${oneLine(pageTitle).slice(0, 80)}${ex ? ` — ${ex}` : ''}`.slice(0, TITLE_MAX);
}

/**
 * @param {object} o
 * @param {{id:string,title:string,spaceId:string}} o.page
 * @param {{id:string,body:string,quote?:string,author:string,at?:number}} o.comment
 * @param {{assignee?:string,type?:string,priority?:string,title?:string,request?:boolean}} o.req 화면이 보낸 값
 * @param {string[]} o.mentioned 그 댓글에서 언급한 사람(resolveMentions 로 푼 실제 이름 · 순서 유지)
 * @param {boolean} o.canWrite 운영자 · 관리자(데모 제외)인가
 * @param {(name:string, vcenterId:string)=>boolean} o.canSee
 * @param {boolean} [o.restricted] v2.931(점검 B1-06) — mentioned 를 자동완성 후보로 좁혀 푼 계정(전체 범위 쓰기 계정이 아님). 문구가 그 사실을 말한다
 *   (모르는 이름 · 없는 이름 · 후보 밖 이름이 같은 문구 — 계정 존재 판정이 되지 않게).
 * @returns {{ body:object, origin:object, requestOnly:boolean, watchers:string[], skipped:string[] }}
 */
export function planCommentIssue({ page, comment, req = {}, mentioned = [], canWrite = false, canSee = () => true, restricted = false }) {
  const vcenterId = vcenterOfSpace(page.spaceId);
  const requestOnly = !canWrite;
  if (requestOnly && req.request !== true) throw fieldError('issue', '담당자를 지정하는 이슈는 운영자 · 관리자만 만듭니다 — 요청으로 등록하세요');
  const type = requestOnly ? 'request' : (req.type == null || req.type === '' ? 'task' : String(req.type));
  if (!COMMENT_ISSUE_TYPES.includes(type)) throw fieldError('issue.type', `${COMMENT_ISSUE_TYPES.join(' · ')} 중 하나여야 합니다`);
  const priority = req.priority == null || req.priority === '' ? 'p2' : String(req.priority);
  if (!PRIOS.includes(priority)) throw fieldError('issue.priority', 'p0~p3 중 하나여야 합니다');
  const title = oneLine(req.title) || defaultIssueTitle(page.title, comment.body);
  if (title.length > TITLE_MAX) throw fieldError('issue.title', `제목은 ${TITLE_MAX}자까지입니다`);
  let assignee = '';
  const watchers = []; const skipped = [];
  if (!requestOnly) {
    if (!mentioned.length) {
      throw fieldError('issue.assignee', restricted
        ? '담당자로 고를 수 있는 사람을 언급하지 않았습니다 — 이 문서 참여자 · 볼 수 있는 이슈에 나온 사람 · 자기 자신(@ 자동완성 후보)만 고를 수 있습니다'
        : '댓글에 언급한 사람(@계정)이 없어 담당자를 정할 수 없습니다');
    }
    assignee = req.assignee == null || req.assignee === '' ? mentioned[0] : String(req.assignee);
    if (!mentioned.includes(assignee)) throw fieldError('issue.assignee', '담당자는 댓글에서 언급한 사람 중에서 고릅니다');
    if (!canSee(assignee, vcenterId)) throw fieldError('issue.assignee', `‘${assignee}’ 는 이 문서의 법인 이슈를 볼 수 없어 담당자로 지정할 수 없습니다`);
    for (const n of mentioned) {
      if (n === assignee || watchers.includes(n)) continue;
      if (canSee(n, vcenterId)) watchers.push(n); else skipped.push(n);
    }
  }
  const link = `[${oneLine(page.title).replace(/[[\]]/g, '')}](#/wiki/${encodeURIComponent(page.spaceId || PUB)}/${page.id})`;
  const quote = comment.quote ? `> “${oneLine(comment.quote)}”\n\n` : '';
  const body = `위키 댓글에서 등록 — ${link} · ${comment.author}\n\n${quote}${String(comment.body || '')}`.slice(0, BODY_MAX);
  return {
    body: { title, body, type, priority, vcenterId, labels: ['wiki'], ...(requestOnly ? {} : { assignee, watchers }), status: 'backlog' },
    origin: { kind: 'wiki-comment', pageId: page.id, commentId: comment.id },
    requestOnly, watchers, skipped,
  };
}
