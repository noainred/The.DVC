/**
 * isiduBulkText.js — '아이실론 디렉터리 사용량' 수집 대상 **일괄 변경**(v2.739)의 문구·변환(순수 — 테스트가 고정한다).
 *
 * 사용자 요청: "설정에서 일괄로 변경할 수 있는 기능 추가, 일괄 수집, 일괄 대기 시간 변경 같은 설정에서 변경할 수 있는 모든 기능을 등록된
 *   아이템에서 일괄적으로 변경할 수 있는 기능".
 *  · 판정은 서버(`isidu/bulk.js`)가 한다 — 화면은 '그대로' 를 뺀 바꿀 항목(patch)을 만들고, 서버의 미리보기(dryRun) 결과를 문장으로 바꾼다.
 *  · 항목 키는 서버 `BULK_KEYS` 와 1:1 이다(테스트가 서버 소스와 대조한다 — 한쪽에만 생기면 그 항목을 고를 수 없거나 400 이 된다).
 *  · '그대로' 는 빈 값이다. 숫자 칸의 빈 값은 '그대로' 이지 0 이 아니다(`Number('') === 0` 함정).
 *  · 문구에 백틱을 쓰지 않는다. 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';
import { parseMailInput, everyText, nodeText, mailDaysOf, mailDaysText, isMailTime, MAIL_WHEN_CHOICES } from './isiduText.js';

/** 실행 노드 '장비 담당 노드 따름' · '메인' 표지(서버 bulk.js 와 같은 값). */
export const RUN_FOLLOW = '__device__';
export const RUN_MAIN = '__main__';
export const DC_NONE = '__none__';
export const USER_REGISTRY = '__registry__';

/** 켜기/끄기 칸의 선택지. '' = 그대로. */
export const BOOL_CHOICES = Object.freeze([['', '그대로'], ['on', '켜기'], ['off', '끄기']]);

/**
 * 바꿀 수 있는 항목(서버 BULK_KEYS 와 같은 키). kind: bool | select | num | text | mail.
 * 라벨은 개별 편집 창과 같은 말을 쓴다.
 */
export const BULK_FIELDS = Object.freeze([
  { key: 'enabled', label: '주기 수집', kind: 'bool', on: '켜기', off: '끄기' },
  { key: 'intervalHours', label: '주기', kind: 'select' },
  { key: 'timeoutMin', label: '시한(대기 시간)', kind: 'select' },
  { key: 'sizeMode', label: '크기 표기', kind: 'select' },
  { key: 'topN', label: 'Top N', kind: 'num', min: 5, max: 50, placeholder: '그대로' },
  { key: 'detach', label: '장비에서 분리 실행', kind: 'bool', on: '켜기(재시작해도 계속)', off: '끄기' },
  { key: 'auth', label: '인증', kind: 'select' },
  { key: 'runNode', label: '실행 노드', kind: 'select' },
  { key: 'port', label: 'SSH 포트', kind: 'num', min: 1, max: 65535, placeholder: '그대로' },
  { key: 'username', label: '접속 계정', kind: 'text', placeholder: '그대로' },
  { key: 'datacenterId', label: 'DataCenter(직접 입력 대상)', kind: 'select' },
  { key: 'mailTo', label: '결과 메일 받는 사람', kind: 'mail' },
  { key: 'mailExcludeCommon', label: '공통 받는 사람 빼기', kind: 'bool', on: '빼기', off: '공통에도 보내기' },
  { key: 'mailOnlyOnChange', label: '변화 없으면 보내지 않기', kind: 'bool', on: '켜기', off: '끄기' },
  { key: 'mailOnFailure', label: '실패하면 알리기', kind: 'bool', on: '켜기', off: '끄기' },
  // v2.745 결과 메일 보내는 때 — 요일은 칩(kind 'days' — '그대로' 가 아니면 요일 배열), 시각은 'HH:MM'(kind 'time').
  { key: 'mailWhen', label: '결과 메일 보내는 때', kind: 'select' },
  { key: 'mailDays', label: '결과 메일 요일(정한 요일·시각일 때)', kind: 'days' },
  { key: 'mailTime', label: '결과 메일 시각(포탈 시각)', kind: 'time' },
  { key: 'mailSkipIfNoNew', label: '새 조사가 없으면 보내지 않기', kind: 'bool', on: '켜기', off: '끄기' },
]);
/** 보내는 때 선택지 — 개별 편집 창과 같은 글자(isiduText.MAIL_WHEN_CHOICES). */
export const MAIL_WHEN_OPTIONS = MAIL_WHEN_CHOICES;
export const BULK_FIELD_KEYS = Object.freeze(BULK_FIELDS.map((f) => f.key));

export const MAIL_MODES = Object.freeze([['', '그대로'], ['add', '추가'], ['remove', '빼기'], ['replace', '이 목록으로 바꾸기'], ['clear', '모두 지우기']]);

/** 빈 편집 상태(전부 '그대로'). */
export function blankBulk() {
  const s = {};
  for (const f of BULK_FIELDS) s[f.key] = '';
  s.mailMode = ''; s.mailList = '';
  return s;
}

/**
 * 편집 상태 → 서버 patch. '그대로'(빈 값)는 싣지 않는다.
 * @returns {{patch:object, issues:{key:string, text:string}[]}}
 */
export function bulkPatchFrom(s) {
  const st = s || {};
  const patch = {}; const issues = [];
  for (const f of BULK_FIELDS) {
    const v = st[f.key];
    if (f.kind === 'mail') continue;
    if (v == null || v === '') continue;
    if (f.kind === 'bool') { patch[f.key] = v === 'on'; continue; }
    // v2.745 요일 — 지정했는데 하나도 고르지 않으면 막는다(서버도 mailDays 로 400). '그대로' 는 빈 값('')이다.
    if (f.kind === 'days') {
      const d = mailDaysOf(v);
      if (!d.length) { issues.push({ key: f.key, text: `${f.label}: 요일을 하나 이상 고르세요.` }); continue; }
      patch[f.key] = d; continue;
    }
    if (f.kind === 'time') {
      if (!isMailTime(v)) { issues.push({ key: f.key, text: `${f.label}: 00:00~23:59 형식이어야 합니다.` }); continue; }
      patch[f.key] = String(v).trim(); continue;
    }
    if (f.key === 'intervalHours' || f.key === 'timeoutMin' || f.kind === 'num') {
      const n = numOrNull(v);
      if (n == null || !Number.isInteger(n)) { issues.push({ key: f.key, text: `${f.label}: 정수를 입력하세요.` }); continue; }
      if (f.kind === 'num' && (n < f.min || n > f.max)) { issues.push({ key: f.key, text: `${f.label}: ${f.min}~${f.max} 사이여야 합니다.` }); continue; }
      patch[f.key] = n; continue;
    }
    // v2.740 D-11: 빈 값 검사는 trim 뒤에 한다 — 공백만 넣은 칸은 '그대로' 다(예전에는 username:'' 이 실려 미리보기가 '계정 ‘’' 이라 말했다).
    const sv = String(v).trim();
    if (!sv) continue;
    patch[f.key] = sv;
  }
  if (st.mailMode) {
    if (st.mailMode === 'clear') patch.mailTo = { mode: 'clear' };
    else {
      const p = parseMailInput(st.mailList);
      if (p.invalid.length) issues.push({ key: 'mailTo', text: `받는 사람: 형식이 잘못된 주소 — ${p.invalid.slice(0, 3).join(', ')}` });
      else if (!p.list.length) issues.push({ key: 'mailTo', text: '받는 사람: 주소를 입력하세요.' });
      else patch.mailTo = { mode: st.mailMode, list: p.list };
    }
  }
  return { patch, issues };
}

/** 바꿀 항목을 한 줄로(확인 창·감사 문구). */
export function patchSummary(patch, { dcName = (id) => id } = {}) {
  const p = patch || {};
  const out = [];
  const onoff = (b) => (b ? '켜기' : '끄기');
  if ('enabled' in p) out.push(`주기 수집 ${onoff(p.enabled)}`);
  if ('intervalHours' in p) out.push(`주기 ${everyText(p.intervalHours)}`);
  if ('timeoutMin' in p) out.push(`시한 ${p.timeoutMin}분`);
  if ('sizeMode' in p) out.push(`크기 표기 -${p.sizeMode}`);
  if ('topN' in p) out.push(`Top ${p.topN}`);
  if ('detach' in p) out.push(`분리 실행 ${onoff(p.detach)}`);
  if ('auth' in p) out.push(`인증 ${p.auth === 'device' ? '등록부 계정' : 'SSH 키'}`);
  if ('runNode' in p) out.push(`실행 노드 ${p.runNode === RUN_FOLLOW ? '장비 담당 노드 따름' : p.runNode === RUN_MAIN ? '메인' : nodeText(p.runNode)}`);
  if ('port' in p) out.push(`포트 ${p.port}`);
  if ('username' in p) out.push(`계정 ${p.username === USER_REGISTRY ? '등록부 계정' : `‘${p.username}’`}`);
  if ('datacenterId' in p) out.push(`DataCenter ${p.datacenterId === DC_NONE ? '지정 안 함' : dcName(p.datacenterId)}`);
  if ('mailTo' in p) {
    const m = p.mailTo; const n = Array.isArray(m.list) ? m.list.length : 0;
    out.push(m.mode === 'clear' ? '받는 사람 모두 지우기' : m.mode === 'add' ? `받는 사람 ${n}명 추가` : m.mode === 'remove' ? `받는 사람 ${n}명 빼기` : `받는 사람을 ${n}명으로 바꾸기`);
  }
  if ('mailExcludeCommon' in p) out.push(p.mailExcludeCommon ? '공통 받는 사람 빼기' : '공통 받는 사람에게도 보내기');
  if ('mailOnlyOnChange' in p) out.push(`변화 없으면 생략 ${onoff(p.mailOnlyOnChange)}`);
  if ('mailOnFailure' in p) out.push(`실패 알림 ${onoff(p.mailOnFailure)}`);
  if ('mailWhen' in p) out.push(`결과 메일 보내는 때 ${p.mailWhen === 'schedule' ? '정한 요일·시각' : '조사가 끝날 때마다'}`);
  if ('mailDays' in p) out.push(`결과 메일 요일 ${mailDaysText(p.mailDays)}`);
  if ('mailTime' in p) out.push(`결과 메일 시각 ${p.mailTime}`);
  if ('mailSkipIfNoNew' in p) out.push(`새 조사 없으면 생략 ${onoff(p.mailSkipIfNoNew)}`);
  return out.join(' · ');
}

/** 대상에 맞지 않아 뺀 항목의 사유(서버 bulk.js NOT_APPLIED_CODES 와 1:1 — 테스트가 대조한다). */
export const NOT_APPLIED_TEXT = Object.freeze({
  'dc-from-registry': 'DataCenter 는 등록부 장비가 정합니다(직접 입력 대상에만 적용)',
  'follow-needs-registry': "'장비 담당 노드 따름' 은 등록부 장비에만 있습니다",
  'device-auth-needs-registry': "'등록부 계정' 인증은 등록부 장비에만 쓸 수 있습니다",
  'direct-needs-user': '직접 입력 대상은 접속 계정을 비울 수 없습니다',
});
export const notAppliedText = (code) => NOT_APPLIED_TEXT[code] || code;

/** 서버 key → 화면 라벨(바뀐 항목 표시). 서버 저장 모양의 키(mail·runVia·agent)를 사람 말로. */
const CHANGED_LABEL = {
  enabled: '주기 수집', intervalHours: '주기', timeoutMin: '시한', sizeMode: '크기 표기', topN: 'Top N', detach: '분리 실행', auth: '인증',
  runVia: '실행 노드', agent: '실행 노드', port: '포트', username: '계정', datacenterId: 'DataCenter', mail: '결과 메일',
};
export function changedKeysText(keys) {
  const set = [...new Set((Array.isArray(keys) ? keys : []).map((k) => CHANGED_LABEL[k] || k))];
  return set.join(', ');
}

/**
 * 미리보기·적용 결과 → 요약(순수).
 * @returns {{tone:'ok'|'warn'|'bad'|'muted', head:string, lines:string[]}}
 */
export function bulkResultText(r, nameOf = (id) => id) {
  if (!r) return { tone: 'muted', head: '', lines: [] };
  if (r.ok === false) return { tone: 'bad', head: r.reason || '처리하지 못했습니다.', lines: [] };
  if (r.mode === 'remove') {
    const n = r.removed?.length || 0;
    return { tone: n ? 'ok' : 'muted', head: r.dryRun ? `목록에서 뺄 대상 ${n}개` : (r.saved ? `목록에서 ${n}개를 뺐습니다(이미 쌓인 수집 기록은 보존 기간 동안 남습니다).` : '뺄 대상이 없습니다.'), lines: (r.notFound || []).length ? [`설정에 없는 대상 ${r.notFound.length}개는 건너뛰었습니다.`] : [] };
  }
  const changed = r.changed || []; const skipped = r.skipped || []; const na = r.notApplied || []; const same = r.unchanged || [];
  const lines = [];
  for (const c of changed.slice(0, 20)) lines.push(`${nameOf(c.id)} — ${changedKeysText(c.keys)}`);
  if (changed.length > 20) lines.push(`… 외 ${changed.length - 20}개`);
  for (const s of skipped) lines.push(`바꾸지 않음: ${nameOf(s.id)} — ${s.reason}`);
  const naBy = new Map();
  for (const x of na) { const k = `${x.key}|${x.reason}`; if (!naBy.has(k)) naBy.set(k, { reason: x.reason, ids: [] }); naBy.get(k).ids.push(x.id); }
  for (const g of naBy.values()) lines.push(`일부 항목 제외(${g.ids.length}개): ${notAppliedText(g.reason)} — ${g.ids.slice(0, 5).map(nameOf).join(', ')}${g.ids.length > 5 ? ' …' : ''}`);
  if ((r.notFound || []).length) lines.push(`설정에 없는 대상 ${r.notFound.length}개는 건너뛰었습니다(다른 곳에서 지워졌을 수 있습니다).`);
  const head = r.dryRun
    ? `바뀜 ${changed.length}개 · 이미 같음 ${same.length}개${skipped.length ? ` · 바꾸지 못함 ${skipped.length}개` : ''}`
    : r.saved ? `저장했습니다 — 바뀜 ${changed.length}개${same.length ? ` · 이미 같음 ${same.length}개` : ''}${skipped.length ? ` · 바꾸지 못함 ${skipped.length}개` : ''}. 엣지 담당 대상은 그 엣지가 다음 설정 pull(최대 5분)에 받습니다.`
      : changed.length ? '저장하지 않았습니다.' : `바뀌는 대상이 없습니다(이미 같음 ${same.length}개${skipped.length ? ` · 바꾸지 못함 ${skipped.length}개` : ''}).`;
  return { tone: skipped.length || na.length ? 'warn' : changed.length ? 'ok' : 'muted', head, lines };
}

/** 대상 선택 필터 — 법인·실행 노드·켜짐. */
export const SELECT_PRESETS = Object.freeze([['all', '전체'], ['none', '선택 해제'], ['on', '켜진 대상'], ['off', '꺼진 대상'], ['fail', '최근 실패']]);

/**
 * 선택 프리셋 적용(순수) — 보이는(필터된) 대상 기준.
 * @param rows 목록 응답 대상(enabled·lastTry·okScan)
 */
export function presetIds(rows, preset) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (preset === 'none') return [];
  if (preset === 'on') return list.filter((t) => t.enabled !== false).map((t) => t.id);
  if (preset === 'off') return list.filter((t) => t.enabled === false).map((t) => t.id);
  if (preset === 'fail') return list.filter((t) => t.lastTry && t.lastTry.ok === false && (!t.okScan || t.lastTry.ts > t.okScan.ts)).map((t) => t.id);
  return list.map((t) => t.id);
}

/** 차례로 실행(연결 시험·메일) 진행 문구. */
export function seqProgressText(s) {
  if (!s) return '';
  const done = s.results?.length || 0;
  const ok = (s.results || []).filter((x) => x.ok).length;
  const label = s.kind === 'test' ? '연결 시험' : s.kind === 'mail' ? '결과 메일' : '실행';
  if (s.running) return `${label} ${done}/${s.total} 진행 중${s.stopping ? ' — 지금 것까지만 하고 멈춥니다' : ''}`;
  return `${label} 끝 — ${s.total}개 중 성공 ${ok} · 실패 ${done - ok}${done < s.total ? ` · 멈춤으로 ${s.total - done}개 안 함` : ''}`;
}
