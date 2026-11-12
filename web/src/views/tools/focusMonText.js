/**
 * views/tools/focusMonText.js — 특수 기능 ‘집중 모니터링’ 화면의 문구 · 표기(순수 · v2.976).
 *
 * 판정(상한 · 주기 · 임계 · iostat 식)은 서버가 한다 — 여기는 서버 값을 글자로 바꾸고, 임계는 응답(settings)에서 읽는다(숫자를 박지 않는다).
 * 값이 없으면 단위를 붙이지 않고 ‘—’(루트 CLAUDE.md). 문구에 백틱을 쓰지 않는다(BoldText 는 별표 강조만 해석한다).
 */
import { numOrNull } from '../../numOrNull.js';

export const DASH = '—';
const n = numOrNull;

/** 상태 → 배지 문구 · 색조(색만으로 말하지 않는다 — 낱말을 붙인다). 서버 collector 상태 1:1(테스트가 대조). */
export const STATE_TEXT = Object.freeze({
  connecting: { label: '연결 중', tone: 'off' },
  ok: { label: '정상', tone: 'ok' },
  stale: { label: '지연', tone: 'off' },
  auth: { label: '키 로그인 거부', tone: 'warn' },
  hostkey: { label: '호스트키 승인 필요', tone: 'warn' },
  unreachable: { label: '닿지 않음', tone: 'crit' },
  'no-key': { label: '키 없음', tone: 'warn' },
  'unsupported-os': { label: '리눅스 아님', tone: 'warn' },
  limit: { label: '노드 상한', tone: 'warn' },
  stopped: { label: '멈춤', tone: 'off' },
  error: { label: '오류', tone: 'crit' },
});
export const STATE_KEYS = Object.freeze(Object.keys(STATE_TEXT));

/** 연결 시험 결과 code → 문구(서버 TEST_KINDS 1:1). */
export const TEST_TEXT = Object.freeze({
  ok: '정상 — 키 로그인 · RHEL 7 확인',
  'os-unverified': '접속됨 — RHEL 7 이 아닌 리눅스(값이 일부 빌 수 있음)',
  'no-key': '이 노드에 SSH 키가 없습니다',
  auth: '키 로그인 거부 — 공개키를 확인하세요',
  'auth-stopped': '키 로그인 거부로 멈춤 — 공개키를 넣은 뒤 다시 연결',
  hostkey: '호스트키 승인 필요 — 설정 › 장비 신뢰',
  timeout: '시한 초과',
  unreachable: '닿지 않음',
  'unsupported-os': '리눅스가 아닙니다',
  'bad-output': '서버 정보를 읽지 못했습니다',
});

export const MODE_TEXT = Object.freeze({ watch: '잠깐 보기', record: '계속 수집' });
export const ENDED_TEXT = Object.freeze({ stopped: '사람이 끝냄', timeout: '시한이 지나 끝남', 'no-viewer': '보는 화면이 없어 끝남', moved: '서버를 계속 수집으로 넘겨 끝남', removed: '서버를 모두 빼 끝남' });

/* ── v2.979 진행 중인 수집 · 중복 방지(사용자 '모니터링 종료 버튼' · '중복 모니터링 방지' · '기존 모니터링 돌고 있는데 추가하면 잘 안 돼') ── */

/** 서버 → 그 서버를 수집하는 수집(서버는 수집 하나에만 있다 — 서버 store.planJoin). */
export function sessionIndex(sessions) {
  const m = new Map();
  for (const s of sessions || []) for (const t of s.targets || []) if (!m.has(t)) m.set(t, s);
  return m;
}
/** 진행 중인 수집 한 줄 글. */
export function sessionLabel(s, now) {
  if (!s) return '';
  const remain = s.mode === 'watch' && s.until ? ` · 남은 ${remainText(s.until - now)}` : '';
  return `${MODE_TEXT[s.mode] || s.mode} · ${(s.targets || []).length}대 · ${s.interval}초${s.by ? ` · ${s.by}` : ''}${remain}`;
}
/**
 * 시작 전에 미리 알려 줄 글 — 고른 서버 중 이미 수집 중인 것(서버가 빼거나 넘겨받는다). 없으면 ''.
 * @param {{picked:string[], index:Map, mode:'watch'|'record'}} o
 */
export function startNote({ picked, index, mode }) {
  let skip = 0; let move = 0;
  for (const id of picked || []) {
    const s = index.get(id);
    if (!s) continue;
    if (mode === 'record' && s.mode === 'watch') move += 1; else skip += 1;
  }
  if (!skip && !move) return '';
  const parts = [];
  if (skip) parts.push(`${skip}대는 이미 수집 중이라 빼고 시작합니다`);
  if (move) parts.push(`${move}대는 잠깐 보기에서 계속 수집으로 넘겨받습니다`);
  return `고른 ${(picked || []).length}대 가운데 ${parts.join(' · ')}.`;
}
/** 시작 · 추가 응답 → 알림 글(뺀 수 · 넘겨받은 수를 숨기지 않는다). */
export function joinResultText(r, { verb = '시작했습니다' } = {}) {
  if (!r?.ok) return r?.reason || '';
  const n = r.added ? r.added.length : (r.session?.targets || []).length;
  const extra = [];
  if (r.skipped?.length) extra.push(`이미 수집 중인 ${r.skipped.length}대는 뺐습니다`);
  if (r.moved?.length) extra.push(`${r.moved.length}대는 잠깐 보기에서 넘겨받았습니다`);
  return `${n}대 수집을 ${verb}${extra.length ? ` — ${extra.join(' · ')}` : ''}.`;
}

export const TABS = Object.freeze([
  { key: 'overview', label: '개요' },
  { key: 'compare', label: '비교' },
  { key: 'procs', label: '프로세스' },
  { key: 'load', label: '수집 부하' },
  { key: 'targets', label: '대상 · 키' },
]);

/** iostat 열 — 서버 IOSTAT_COLS 순서. 이름은 iostat 그대로, 아래에 한글. */
export const IOSTAT_LABEL = Object.freeze({
  rrqm: '읽기 병합', wrqm: '쓰기 병합', r: '읽기 횟수', w: '쓰기 횟수', rMB: '읽기량', wMB: '쓰기량', rqsz: '요청 크기', qu: '대기열',
  await: '지연', rAwait: '읽기 지연', wAwait: '쓰기 지연', svctm: '서비스 시간', util: '사용률',
});
/** 디스크 표의 요약 열(결정 2026-11-11 — 처음 열 때 요약 열). */
export const SUMMARY_COLS = Object.freeze(['r', 'w', 'rMB', 'wMB', 'rAwait', 'wAwait', 'qu', 'util']);

/** 비교 지표 · 항목. */
export const METRICS = Object.freeze([
  { key: 'cpu', label: 'CPU', items: [['pct', '사용률'], ['usr', '사용자'], ['sys', '시스템'], ['iow', 'I/O 대기'], ['stl', 'steal']], unit: '%' },
  { key: 'mem', label: '메모리', items: [['pct', '사용률'], ['swU', '스왑 사용']], unit: '%' },
  { key: 'net', label: '네트워크', items: [['u', '사용률'], ['rx', '수신'], ['tx', '송신'], ['er', '오류'], ['dr', '드롭']], unit: '' },
  { key: 'disk', label: '디스크', items: [['r', ''], ['w', ''], ['rMB', ''], ['wMB', ''], ['rAwait', ''], ['wAwait', ''], ['await', ''], ['qu', ''], ['rqsz', ''], ['svctm', ''], ['util', ''], ['rrqm', ''], ['wrqm', '']], unit: '' },
]);

const fix = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export function pctText(v, d = 0) { const x = n(v); return x == null ? DASH : `${fix(x, d)}%`; }
export function msText(v) { const x = n(v); return x == null ? DASH : `${fix(x, x >= 100 ? 0 : 1)} ms`; }
export function numText(v, d = 2) { const x = n(v); return x == null ? DASH : fix(x, d); }
/** 비트/초 → Gb/s · Mb/s · Kb/s. */
export function bpsText(v) {
  const x = n(v);
  if (x == null) return DASH;
  if (x >= 1e9) return `${fix(x / 1e9, 1)} Gb/s`;
  if (x >= 1e6) return `${fix(x / 1e6, 0)} Mb/s`;
  if (x >= 1e3) return `${fix(x / 1e3, 0)} Kb/s`;
  return `${fix(x, 0)} b/s`;
}
export function bytesText(v) {
  const x = n(v);
  if (x == null) return DASH;
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let y = x;
  while (y >= 1024 && i < u.length - 1) { y /= 1024; i += 1; }
  return `${fix(y, y >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
/** 저장 장치 크기(10진 — 디스크 표기 관례). */
export function sizeText(v) {
  const x = n(v);
  if (x == null) return '';
  if (x >= 1e12) return `${fix(x / 1e12, 1)} TB`;
  if (x >= 1e9) return `${fix(x / 1e9, 0)} GB`;
  if (x >= 1e6) return `${fix(x / 1e6, 0)} MB`;
  return `${fix(x, 0)} B`;
}
/** 지표 · 항목 → 값 글자. */
export function metricValueText(metric, item, v) {
  if (metric === 'cpu' || (metric === 'mem' && item === 'pct')) return pctText(v, 1);
  if (metric === 'mem') return bytesText(v);
  if (metric === 'net') return item === 'u' ? pctText(v, 1) : item === 'rx' || item === 'tx' ? bpsText(v) : numText(v, 0);
  if (metric === 'disk') return iostatText(item, v);
  return numText(v);
}
export function metricUnitText(metric, item) {
  if (metric === 'cpu' || (metric === 'mem' && item === 'pct') || (metric === 'net' && item === 'u') || (metric === 'disk' && item === 'util')) return '%';
  if (metric === 'net' && (item === 'rx' || item === 'tx')) return 'b/s';
  if (metric === 'disk') return ({ rAwait: 'ms', wAwait: 'ms', await: 'ms', svctm: 'ms', rMB: 'MB/s', wMB: 'MB/s', r: '회/초', w: '회/초', rrqm: '회/초', wrqm: '회/초', qu: '', rqsz: '섹터' })[item] ?? '';
  if (metric === 'mem') return 'B';
  return '';
}
/** iostat 칸 글자 — iostat 처럼 소수 둘째 자리(못 구하면 ‘—’ — iostat 은 0.00). */
export function iostatText(col, v) { const x = n(v); if (x == null) return DASH; return col === 'util' ? `${fix(x, 0)}%` : fix(x, 2); }

/** 남은 시간 mm:ss. */
export function remainText(ms) {
  const x = n(ms);
  if (x == null) return DASH;
  const s = Math.max(0, Math.round(x / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/** 시각 HH:MM:SS(브라우저 시계). 날짜를 붙이면 MM-DD HH:MM:SS. */
export function clockText(ts, withDate = false) {
  const x = n(ts);
  if (x == null) return DASH;
  const d = new Date(x);
  const p = (v) => String(v).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withDate ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}` : t;
}
export function agoShort(ts, now) {
  const x = n(ts);
  if (x == null) return DASH;
  const s = Math.max(0, Math.round((now - x) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
}
export function etText(sec) {
  const x = n(sec);
  if (x == null) return DASH;
  const d = Math.floor(x / 86400); const h = Math.floor((x % 86400) / 3600); const m = Math.floor((x % 3600) / 60); const s = Math.floor(x % 60);
  const p = (v) => String(v).padStart(2, '0');
  return d > 0 ? `${d}일 ${p(h)}:${p(m)}` : `${p(h)}:${p(m)}:${p(s)}`;
}

/** 값의 수준(임계는 응답 settings 에서). 사용률류만. */
export function levelOf(v, settings) {
  const x = n(v);
  if (x == null || !settings) return '';
  if (x >= settings.critPct) return 'crit';
  if (x >= settings.warnPct) return 'warn';
  return '';
}
export function awaitLevel(v, settings) {
  const x = n(v);
  if (x == null || !settings) return '';
  if (x >= settings.wAwaitWarnMs * 50) return 'crit';
  if (x >= settings.wAwaitWarnMs) return 'warn';
  return '';
}

/** 카드 배지 — 상태가 정상이 아니면 그 상태, 정상이면 가장 높은 지표의 주의/위험. */
export function cardBadge(target, sum, settings) {
  const st = target?.status;
  if (st && st.state !== 'ok') return { label: STATE_TEXT[st.state]?.label || st.state, tone: STATE_TEXT[st.state]?.tone || 'off' };
  if (st?.stale) return { label: '지연', tone: 'off' };
  if (!sum) return { label: '값 없음', tone: 'off' };
  if (sum.stuck) return { label: '응답 없는 디스크', tone: 'crit' };
  const items = [['CPU', sum?.cpu], ['메모리', sum?.mem], ['네트워크', sum?.net], ['디스크', sum?.disk]].filter(([, v]) => n(v) != null);
  let worst = null;
  for (const [name, v] of items) { if (!worst || v > worst[1]) worst = [name, v]; }
  const lv = worst ? levelOf(worst[1], settings) : '';
  return lv ? { label: `${lv === 'crit' ? '위험' : '주의'} · ${worst[0]}`, tone: lv } : null;
}

/** 시간 띠 아래 글. */
export function windowCaption({ past, from, to, win }) {
  const span = `${clockText(from, true)} ~ ${clockText(to)}`;
  return past
    ? `과거 구간 · ${span} · 이 구간은 갱신하지 않습니다 — 수집과 기록은 계속됩니다`
    : `최근 구간 · ${span} · ${win}분 · 슬라이더는 최근 24시간(날짜를 고르면 그 날 하루) · 기록은 DB 에 보관합니다`;
}

/**
 * 표의 값 단추(v2.979 — 사용자 요청 '네트워크 · 디스크 시간별로 보기' 의 선택 ‘구간 평균 단추를 카드에’).
 * ‘구간 평균’ 은 시간 띠에서 고른 구간(1 · 5 · 10 · 30분) 전체의 평균 — 단추 글에 그 길이를 적어 무엇의 평균인지 보이게 한다.
 */
export const AT_KEYS = Object.freeze(['end', 'avg']);
export function atOptions(win) { return [['end', '구간 끝 순간'], ['avg', `${win}분 평균`]]; }
/** 저장된 값 → 쓸 값(모르는 값 · 못 읽음은 ‘구간 끝 순간’). */
export function normAt(v) { return AT_KEYS.includes(v) ? v : 'end'; }

/**
 * 카드 제목 옆에 붙이는 지금 보는 값 — 응답이 실제로 덮는 시간을 본다(v2.979 반증 2: 수집이 20분 전에 끝났는데 ‘지금’ · ‘최근 30분 평균’ 이라고 했다).
 * @param {{win:number, past:boolean, lastAt?:number|null, coverMs?:number|null, now?:number, staleMs?:number}} o
 *   lastAt = 구간 안 마지막 표본 시각 · coverMs = 평균이 덮는 시간(서버 시간 가중의 무게 합) · staleMs = 이보다 오래된 마지막 표본은 ‘지금’ 이 아니다
 */
export function atCaption(at, { win, past, lastAt = null, coverMs = null, now = Date.now(), staleMs = 10_000 } = {}) {
  if (at === 'avg') {
    const base = `${past ? '고른' : '최근'} ${win}분 평균`;
    const c = Number(coverMs);
    if (coverMs != null && Number.isFinite(c) && c < win * 60_000 * 0.9) return `${base} · 표본은 ${c < 60_000 ? '1분 미만' : `${Math.round(c / 60_000)}분치`}`;
    return base;
  }
  if (past) return lastAt ? `고른 구간의 마지막 표본 · ${clockText(lastAt)}` : '고른 구간 끝 순간';
  if (lastAt && now - lastAt > staleMs) return `마지막 표본 · ${agoShort(lastAt, now)}`;
  return '지금(가장 최근 표본)';
}

/** 수집 상태 알약 글. */
export function sessionPill(s, now) {
  if (!s) return { live: false, text: '수집 안 함', sub: '대상 · 키 탭에서 서버를 고르고 시작하세요' };
  const remain = s.mode === 'watch' && s.until ? remainText(s.until - now) : null;
  return { live: true, text: '수집 중', sub: `${s.targets.length}대 · 주기 ${s.interval}초 · ${MODE_TEXT[s.mode] || s.mode}`, remain };
}

/** 공개키를 대상 서버에 넣는 명령(복사용). from= 은 그 노드 주소를 사람이 확인해 넣는다 — 모르면 줄을 빼라고 말한다. */
export function installCommand(pub, user = 'dvcmon') {
  if (!pub) return '';
  const u = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user) ? user : 'dvcmon';
  return [
    `# 대상 서버에서 root 로 한 번만 (계정 이름은 예시 — 등록한 계정과 같게)`,
    `id ${u} >/dev/null 2>&1 || useradd -m ${u}`,
    `install -d -m 700 -o ${u} -g ${u} ~${u}/.ssh`,
    `cat >> ~${u}/.ssh/authorized_keys <<'EOF'`,
    `restrict ${pub}`,
    `EOF`,
    `chown ${u}:${u} ~${u}/.ssh/authorized_keys`,
    `chmod 600 ~${u}/.ssh/authorized_keys`,
    `restorecon -R ~${u}/.ssh 2>/dev/null || true`,
  ].join('\n');
}
/** 키 로그인 거부일 때 — 가장 흔한 원인(사용자 보고 2026-11-12: ssh-copy-id 로 넣었는데 거부). */
export const AUTH_HINT = '포탈 전용 키(노드 카드의 공개키)를 넣어야 합니다 — ssh-copy-id 는 셸 계정의 키를 넣어 포탈 연결에는 쓰이지 않습니다. 넣은 뒤 다시 연결을 누르세요.';
/** 노드 셸에서 포탈 키를 직접 확인하는 법(경로는 설치 기본값 — 설정 폴더가 다르면 그 아래 ssh). */
export const KEY_FILE_NOTE = '노드 셸(root)에서 같은 공개키를 뽑으려면: ssh-keygen -y -f /etc/vmware-portal/ssh/focusmon_key (설정 폴더가 다르면 그 아래 ssh/focusmon_key) — 지문이 카드와 같은지 확인하세요. 포탈 서비스는 홈 디렉터리의 ~/.ssh 키를 읽지 않습니다.';
/** 다시 연결 버튼을 보일 상태(중앙 정지 · 수집 상태 · 시험 결과 어느 쪽이든 — 엣지 서버는 시험 결과로만 안다). */
export function needsRetry(t) {
  return !!(t && (t.status?.state === 'auth' || t.authStop || ['auth', 'auth-stopped'].includes(t.test?.result?.kind)));
}
/* ── 등록된 서버 수정(v2.980 — 사용자 '등록된 서버 수정하는 기능 추가') ─────────────────────────────
 * 서버 registry.EDIT_FIELDS · targetChanges 와 같은 칸 · 같은 규칙(담당 노드 대소문자 무시) — 서버 테스트가 칸 목록을 대조한다.
 * 판정은 서버가 한다(응답 moved · cleared). 여기는 저장 전 미리보기(저장 단추 · 안내 글)다. */
export const EDIT_FIELDS = Object.freeze(['name', 'host', 'port', 'username', 'agent', 'group']);
export const EDIT_FIELD_TEXT = Object.freeze({ name: '이름', host: 'IP', port: '포트', username: '계정', agent: '담당 노드', group: '그룹' });
const ENDPOINT_FIELDS = new Set(['host', 'port', 'username', 'agent']);
/** 수정 칸의 처음 값(등록부 값 그대로 — 포트는 글자). */
export function editFormOf(t) {
  return { name: t?.name ?? '', host: t?.host ?? '', port: t?.port == null || t?.port === '' ? '22' : String(t.port), username: t?.username ?? '', agent: t?.agent ?? '', group: t?.group ?? '' };
}
const editKey = (k, v) => {
  const x = String(v ?? '').trim();
  if (k === 'port') return x === '' ? '22' : /^\d{1,5}$/.test(x) ? String(Number(x)) : x; // 서버: 빈 칸 = 22 · 수로 읽는다
  if (k === 'agent') return x.toLowerCase();
  return x;
};
/** 고친 칸 — { changes:[{k,label,from,to}], endpoint } (endpoint = 주소 · 포트 · 계정 · 담당 노드 중 하나라도 바뀜). */
export function editChanges(t, form) {
  const changes = [];
  for (const k of EDIT_FIELDS) {
    const was = k === 'port' ? (t?.port ?? 22) : t?.[k];
    if (editKey(k, was) === editKey(k, form?.[k])) continue;
    const now = String(form?.[k] ?? '').trim();
    changes.push({ k, label: EDIT_FIELD_TEXT[k], from: k === 'agent' ? nodeText(was) : k === 'group' ? groupLabel(was) : String(was ?? '') || DASH, to: k === 'agent' ? nodeText(now) : k === 'group' ? groupLabel(now) : now || (k === 'port' ? '22' : DASH) });
  }
  return { changes, endpoint: changes.some((c) => ENDPOINT_FIELDS.has(c.k)) };
}
/** 저장 전에 알릴 글 — 접속처가 바뀌면 생기는 일(다시 연결 · 시험 결과 지움 · 키 · 기록이 이어짐)을 숨기지 않는다. 이름만이면 없음. */
export function editNotes(t, form, { inSession = false } = {}) {
  const { changes, endpoint } = editChanges(t, form);
  if (!endpoint) return [];
  const has = (k) => changes.some((c) => c.k === k);
  const out = [];
  if (inSession) out.push('수집 중인 서버입니다 — 저장하면 새 접속처로 다시 연결합니다.');
  out.push('예전 접속처의 연결 시험 결과 · 상태를 지웁니다 — 저장한 뒤 ‘시험’ 으로 확인하세요.');
  if (has('agent')) out.push(`담당 노드가 바뀝니다 — 그 서버 계정의 authorized_keys 에 ${nodeText(String(form?.agent ?? '').trim())}의 공개키가 있어야 합니다.`);
  if (has('host')) out.push('기록은 이 서버 줄로 이어집니다 — 다른 서버로 바꾸는 것이면 수정 대신 새로 등록하세요(기록이 섞입니다).');
  return out;
}
/** 저장 응답 → 알림 글. */
export function editResultText(r, name = '') {
  if (!r?.ok) return r?.reason || '';
  if (!r.changes?.length) return '바뀐 값이 없습니다 — 저장하지 않았습니다.';
  const what = r.changes.map((c) => EDIT_FIELD_TEXT[c.k] || c.k).join(' · ');
  return `${r.target?.name || name} 을(를) 고쳤습니다(${what})${r.cleared ? ' — 접속처가 바뀌어 예전 연결 시험 결과를 지웠습니다. ‘시험’ 으로 확인하세요' : ''}.`;
}
/* ── 프로세스 세부 정보(v2.981 — 사용자 '프로세스를 클릭하면 어떤 프로세스인지 · 네트워크 · 디스크 · CPU' · 시안 ⑩ 컨펌 '구현해줘') ─────────
 * '이름으로 본 설명' — comm(프로세스 이름 · 최대 15자)만 보고 붙이는 사전 문구다. 이름을 바꾼 프로그램이면 틀릴 수 있어 화면이 '이름으로 본 설명' 이라고 적는다.
 * 사전에 없으면 null(화면 '아는 설명이 없습니다'). 같은 java 라도 무슨 프로그램인지는 서비스 이름(cgroup)으로 본다. */
const PROC_DESC_EXACT = Object.freeze({
  java: 'Java 프로그램(JVM) — 무슨 프로그램인지는 서비스 이름으로 봅니다',
  postgres: 'PostgreSQL 데이터베이스', postmaster: 'PostgreSQL 데이터베이스',
  mysqld: 'MySQL 데이터베이스', mariadbd: 'MariaDB 데이터베이스',
  oracle: 'Oracle 데이터베이스 서버 프로세스', tnslsnr: 'Oracle 리스너',
  mongod: 'MongoDB 데이터베이스', 'redis-server': 'Redis',
  nginx: 'nginx 웹 서버', httpd: 'Apache 웹 서버', 'php-fpm': 'PHP-FPM',
  node: 'Node.js 프로그램', perl: 'Perl 프로그램',
  sshd: 'SSH 서버(접속 세션마다 하나씩)', systemd: 'systemd(서비스 관리자)',
  'systemd-journal': '시스템 로그 수집(journald)', 'systemd-journald': '시스템 로그 수집(journald)', 'systemd-logind': '로그인 관리(logind)', 'systemd-udevd': '장치 관리(udev)',
  rsyslogd: '시스템 로그(rsyslog)', crond: '예약 작업(cron)', auditd: '감사 로그(auditd)', chronyd: '시간 동기화(chrony)', ntpd: '시간 동기화(ntp)',
  NetworkManager: '네트워크 관리', firewalld: '방화벽(firewalld)', tuned: '성능 프로필(tuned)', irqbalance: '인터럽트 분산',
  dockerd: '컨테이너 런타임(Docker)', containerd: '컨테이너 런타임(containerd)', kubelet: 'Kubernetes 노드 에이전트',
  kthreadd: '커널 스레드 관리', kswapd0: '커널 메모리 회수(스왑)', khugepaged: '커널 큰 페이지 정리',
  bash: '셸', sh: '셸', ksh: '셸', zsh: '셸', csh: '셸',
  rsync: '파일 동기화(rsync)', scp: '파일 복사(scp)', tar: '파일 묶기 · 풀기', gzip: '압축', pigz: '압축', bzip2: '압축', xz: '압축', zstd: '압축',
  cp: '파일 복사', dd: '블록 복사(dd)', find: '파일 찾기', updatedb: '파일 색인(locate)',
  awk: '명령줄 도구 — 이 포탈의 수집도 awk · cat 을 씁니다', cat: '명령줄 도구 — 이 포탈의 수집도 awk · cat 을 씁니다', grep: '명령줄 도구', sleep: '명령줄 도구',
  vmtoolsd: 'VMware Tools', snmpd: 'SNMP 에이전트', zabbix_agentd: '모니터링 에이전트(Zabbix)', node_exporter: '모니터링 에이전트(Prometheus)',
  telegraf: '모니터링 에이전트(Telegraf)', collectd: '모니터링 에이전트(collectd)', splunkd: '로그 전송(Splunk)', filebeat: '로그 전송(Filebeat)', fluentd: '로그 전송(fluentd)',
  haproxy: '부하 분산(HAProxy)', keepalived: '고가용성(keepalived)', named: 'DNS 서버(BIND)', smbd: '파일 공유(Samba)', nfsd: 'NFS 서버',
  'bareos-fd': 'Bareos 백업 — 파일 데몬', 'bareos-dir': 'Bareos 백업 — 디렉터', 'bareos-sd': 'Bareos 백업 — 저장 데몬', dsmc: 'TSM 백업 클라이언트', dsmcad: 'TSM 백업 클라이언트',
  multipathd: '다중 경로(multipath) 관리', iscsid: 'iSCSI', lvmetad: 'LVM', dmeventd: 'LVM 이벤트', polkitd: '권한 관리(polkit)', 'dbus-daemon': '시스템 메시지 버스',
  sssd: '인증(SSSD)', sssd_be: '인증(SSSD)', gssproxy: '인증(GSS)',
});
const PROC_DESC_RULES = Object.freeze([
  [/^ora_[a-z0-9]+_/, 'Oracle 데이터베이스 백그라운드 프로세스'],
  [/^python[0-9.]*$/, 'Python 프로그램'],
  [/^containerd-shim/, '컨테이너 1개를 맡은 shim'],
  [/^kworker[_/]/, '커널 작업 스레드'], [/^ksoftirqd[_/]/, '커널 소프트 인터럽트 처리'], [/^migration[_/]/, '커널 CPU 간 작업 이동'],
  [/^rcu_/, '커널 RCU'], [/^jbd2[_/]/, 'ext4 저널 기록(커널)'], [/^xfs/, 'XFS 파일시스템(커널)'], [/^kblockd/, '커널 블록 입출력'],
  [/^watchdog[_/]/, '커널 감시'], [/^cpuhp[_/]/, '커널 CPU 핫플러그'], [/^scsi_/, '커널 SCSI'],
]);
/** '이름으로 본 설명'(없으면 null). comm 은 원격이 안전한 글자로 바꾼 값('/' → '_')이다. */
export function procDescOf(comm) {
  const c = String(comm || '');
  if (!c) return null;
  if (Object.hasOwn(PROC_DESC_EXACT, c)) return PROC_DESC_EXACT[c];
  for (const [re, d] of PROC_DESC_RULES) if (re.test(c)) return d;
  return null;
}
/** 프로세스 상태(/proc/<pid>/stat 3번째 칸). */
export const PROC_STATE_TEXT = Object.freeze({ R: '실행 중', S: '잠듦(기다림)', D: '디스크 대기(끊을 수 없음)', Z: '좀비(끝났지만 부모가 거두지 않음)', T: '멈춤', t: '추적 중', I: '유휴(커널 스레드)', X: '끝남' });
/** 펼친 줄 열쇠 — 서버 · pid · 시작 tick(같은 pid 재사용을 가른다). */
export const procKey = (id, p) => `${id}|${p?.pid}|${p?.sk ?? ''}`;
/** 상위 30 에 든 시간 — '이 구간의 82% 동안 상위 30 에 있었습니다'. 덮은 시간을 모르면 ''. */
export function procCoverText(cover) {
  const tot = Number(cover?.totalMs); const inn = Number(cover?.inTopMs);
  if (!(tot > 0) || !Number.isFinite(inn)) return '';
  const pct = Math.round((inn / tot) * 100);
  // 반증 F11: 덮은 시간은 '수집한 시간' 기준이다(수집하지 않은 시간은 분모에 없다)
  if (pct >= 100) return '이 구간에 수집한 시간 내내 CPU 상위 30 에 있었습니다.';
  return `이 구간에 수집한 시간의 ${pct}% 동안 CPU 상위 30 에 있었습니다 — 그 밖의 시간은 값을 모릅니다(차트가 끊긴 곳 · 0 이 아닙니다).`;
}
/**
 * 스레드가 여럿인 프로세스의 안내(반증 F3): /proc/<pid>/stat 의 상태 · 디스크 대기 tick 은 **주 스레드 하나**의 값이다
 * (CPU 시간 · major fault 는 스레드 합). 스레드가 하나면 ''.
 */
export function procThreadNote(th) {
  const n = Number(th);
  if (!Number.isFinite(n) || n <= 1) return '';
  return `스레드 ${n}개 — 상태와 디스크를 기다린 시간은 주 스레드 하나의 값입니다(다른 스레드가 기다린 시간은 들어가지 않아 실제보다 작게 나올 수 있습니다). CPU 와 major fault 는 모든 스레드의 합입니다.`;
}
/** 디스크 읽기 · 쓰기를 못 읽은 까닭(값이 있으면 ''). */
export function procIoNote(info) {
  if (info && (info.rb != null || info.wb != null)) return '';
  return '이 프로세스의 읽기 · 쓰기 양은 읽을 수 없습니다 — /proc/<pid>/io 는 그 프로세스의 계정이나 root 만 읽습니다(수집 계정에 sudo 를 주지 않습니다). 수집 계정이 띄운 프로세스만 값이 나옵니다.';
}
/** 디스크 대기를 아는지(da: 지연 집계) → 안내('' = 앎). */
export function procWaitNote(da) {
  if (da === true) return '';
  if (da === false) return '이 서버는 지연 집계(task_delayacct)가 꺼져 있어 디스크를 기다린 시간을 알 수 없습니다(리눅스 5.14 이후 기본 꺼짐).';
  return '이 서버가 지연 집계를 쓰는지 모릅니다(새 판 수집으로 다시 시작하면 나옵니다).';
}
export const PROC_NET_NOTE = '리눅스는 프로세스별 네트워크 바이트를 /proc 에 남기지 않습니다(root 권한 도구 nethogs · eBPF 가 필요하고 RHEL 7.8 기본 설치에 없습니다). 아래는 같은 시간의 서버 전체 수신 · 송신 — 이 프로세스의 몫이 아닌 참고입니다.';
export const PROC_ARGS_NOTE = '명령 인자 · 환경은 수집하지 않습니다(인자에 비밀번호가 흔합니다) — 같은 이름이라도 무슨 프로그램인지는 서비스 이름으로 봅니다.';
/** MB/s 글(값이 없으면 —). */
export function mbsText(v) {
  const x = Number(v);
  if (v == null || v === '' || !Number.isFinite(x)) return DASH;
  return x >= 100 ? `${Math.round(x)} MB/s` : x >= 10 ? `${x.toFixed(1)} MB/s` : `${x.toFixed(2)} MB/s`;
}
/** 메모리 MB → 'N MB' · 'N.N GB'(값이 없으면 —). */
export function mbText(v) {
  const x = Number(v);
  if (v == null || v === '' || !Number.isFinite(x)) return DASH;
  return x >= 1024 ? `${(x / 1024).toFixed(1)} GB` : `${Math.round(x)} MB`;
}

/* ── 서버 그룹(v2.982 — 사용자 '등록된 서버를 그룹별로 분류해서 보는 기능' · 시안 ⑫ · 컨펌 '구현해줘' = 기본값) ───────────────
 * 서버마다 그룹 하나('' = 그룹 없음) · 순서는 응답 groups.list(만든 순서) · 그룹 이름 규칙은 서버 registry.GROUP_RE 와 같다(테스트가 대조). */
export const GROUP_NONE = '그룹 없음';
export const GROUP_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,31}$/;
export function groupLabel(g) { return g ? String(g) : GROUP_NONE; }
/**
 * 대상 → 그룹 묶음(순서: 응답 그룹 순서 → 그 밖에 쓰인 이름 → 그룹 없음). 빈 그룹은 keepEmpty 일 때만.
 * @returns {{key:string, label:string, targets:object[]}[]}  key '' = 그룹 없음
 */
export function groupSections(targets = [], list = [], { keepEmpty = false } = {}) {
  const order = (list || []).map((g) => g.name);
  for (const t of targets) if (t.group && !order.includes(t.group)) order.push(t.group);
  const out = order.map((name) => ({ key: name, label: name, targets: targets.filter((t) => t.group === name) }));
  const none = targets.filter((t) => !t.group);
  const all = [...out, { key: '', label: GROUP_NONE, targets: none }];
  return keepEmpty ? all : all.filter((x) => x.targets.length);
}
/** 그룹 단추(전체 + 그룹마다 + 그룹 없음) — 대수가 0 인 그룹은 뺀다. key 'all' · '' · 이름. */
export function groupChips(targets = [], list = []) {
  return [{ key: 'all', label: '전체', n: targets.length }, ...groupSections(targets, list).map((x) => ({ key: x.key, label: x.label, n: x.targets.length }))];
}
/**
 * 그룹 단추로 거르기 — sel 이 'all' 이거나 **지금 목록에 그 그룹이 없으면 그대로**(그룹 없음 포함). 단추 쪽도 같은 경우 '전체' 를 켠다
 * (groupChipOn) — 고른 그룹이 지워지거나 서버가 다 옮겨져도 화면이 빈 목록에 머물지 않게.
 */
export function filterByGroup(targets = [], sel = 'all') {
  if (sel === 'all' || sel == null) return targets;
  const hit = targets.filter((t) => (t.group || '') === sel);
  return hit.length ? hit : targets;
}
/** 단추가 켜져 있는가 — filterByGroup 과 같은 판정(고른 그룹이 단추 목록에 없으면 '전체'). */
export function groupChipOn(chips = [], sel, key) {
  return sel === key || (key === 'all' && !chips.some((c) => c.key === sel && c.key !== 'all'));
}
/** 그룹 묶음 한 줄 요약(개요 · 그룹별로 나눠 보기): 'N대 · 평균 CPU x% · 가장 바쁜 이름 y%'. 값이 없는 서버는 평균에 넣지 않는다. */
export function groupSummary(rows = []) {
  const vals = rows.filter((x) => x?.sum?.cpu != null && Number.isFinite(x.sum.cpu));
  const avg = vals.length ? vals.reduce((a, x) => a + x.sum.cpu, 0) / vals.length : null;
  const top = vals.reduce((a, x) => (a == null || x.sum.cpu > a.sum.cpu ? x : a), null);
  return { n: rows.length, valued: vals.length, avg, top: top ? { name: top.t?.name ?? top.id, cpu: top.sum.cpu } : null };
}
/** 그룹 단위 시작 — 수집 하나의 상한(max)을 넘으면 앞 max 대로 시작하고 나머지를 알린다(시안 ⑫ 컨펌 ② 기본값). */
export function groupStartPlan(ids = [], max = 20) {
  const list = [...new Set(ids)];
  return { start: list.slice(0, max), rest: list.slice(max) };
}
export function groupStartText(name, plan, max) {
  if (!plan.rest.length) return '';
  return `${groupLabel(name)} ${plan.start.length + plan.rest.length}대 가운데 앞 ${max}대로 시작합니다(수집 하나는 ${max}대까지) — 나머지 ${plan.rest.length}대는 ‘진행 중인 수집에 더하기’ 나 새 수집으로 넣으세요.`;
}
/**
 * 자동 묶기 제안(시안 ⑫ 컨펌 ③) — **그룹 없음** 서버만 · 이미 그룹이 있는 서버는 건드리지 않는다. 둘 이상 묶이는 것만 제안한다.
 *  · prefix: 이름의 마지막 '-숫자' 앞(lab-test-01 → lab-test) · node: 담당 노드(중앙 · 엣지 이름) · subnet: IPv4 /24
 * @returns {{kind:string, title:string, moves:{group:string, ids:string[], names:string[]}[]}[]}
 */
export function groupSuggestions(targets = [], existing = []) {
  const free = targets.filter((t) => !t.group && !t.demo);
  const exist = new Map((existing || []).map((g) => [String(g.name || g).toLowerCase(), String(g.name || g)]));
  const clean = (x) => String(x || '').replace(/[^A-Za-z0-9가-힣._ -]/g, '-').replace(/^[^A-Za-z0-9가-힣]+/, '').slice(0, 32);
  const build = (kind, title, keyOf) => {
    const m = new Map();
    for (const t of free) { const k = clean(keyOf(t)); if (!k || !GROUP_RE.test(k)) continue; const name = exist.get(k.toLowerCase()) || k; const x = m.get(name) || { group: name, ids: [], names: [] }; x.ids.push(t.id); x.names.push(t.name); m.set(name, x); }
    const moves = [...m.values()].filter((x) => x.ids.length >= 2).sort((a, b) => b.ids.length - a.ids.length);
    return moves.length ? { kind, title, moves } : null;
  };
  return [
    build('prefix', '이름 앞부분으로', (t) => { const m = /^(.*?)[-_ .]?\d+$/.exec(String(t.name || '')); return m && m[1] ? m[1] : ''; }),
    build('node', '담당 노드로', (t) => (t.agent ? t.agent : '중앙')),
    build('subnet', 'IP 대역(/24)으로', (t) => { const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(String(t.host || '')); return m ? `${m[1]}.${m[2]}.${m[3]}` : ''; }),
  ].filter(Boolean);
}
/** 제안 한 줄 글 — 'lab-test 2대(lab-test-01 · lab-test-02) · …'. */
export function suggestionText(sg, existing = []) {
  const have = new Set((existing || []).map((g) => String(g.name || g)));
  return sg.moves.slice(0, 6).map((m) => `${m.group}${have.has(m.group) ? '' : '(새 그룹)'} ${m.ids.length}대(${m.names.slice(0, 3).join(' · ')}${m.names.length > 3 ? ' …' : ''})`).join(' · ') + (sg.moves.length > 6 ? ` 외 ${sg.moves.length - 6}묶음` : '');
}

/* ── 수집 부하(v2.983 — 시안 ⑪ · '늘 잼 · 세 묶음') ─────────────────────────────────────────────────── */
/** 판정(서버 load.judgeLoad 와 같은 이름) — 문턱은 응답 settings(코어 1개 기준 %). */
export const LOAD_JUDGE = Object.freeze({ light: { label: '가벼움', tone: 'ok' }, mid: { label: '보통', tone: 'warn' }, heavy: { label: '큼', tone: 'crit' } });
export function loadJudgeNote(s) {
  const w = s?.loadWarnPct ?? 1; const c = s?.loadCritPct ?? 3;
  return [['light', `${w}% 미만`], ['mid', `${w}~${c}%`], ['heavy', `${c}% 이상`]];
}
/** 바이트/초 → B/s · KB/s · MB/s(보내는 양 — 네트워크 bpsText 는 비트). */
export function byteRateText(v) { const x = n(v); return x == null ? DASH : `${bytesText(x)}/s`; }
/** 세 묶음 이름(원격 스크립트의 CB · CC · CP). 프로세스 묶음은 지금 표본 주기를 붙인다. */
export function loadGroupLabel(g, procEvery) {
  if (g === 'base') return '기본 지표(매 주기)';
  if (g === 'topo') return '구성(30초)';
  if (g === 'proc') return `프로세스(${procEvery ?? 5}초 · 주기가 더 길면 그 주기)`;
  return g;
}
export const LOAD_GROUPS = Object.freeze(['base', 'topo', 'proc']);
/** 묶음마다 무엇이 들었나(줄 아래 패널). */
export const LOAD_GROUP_WHAT = Object.freeze({
  base: '/proc/stat · loadavg · meminfo · net/dev · diskstats 와 반복 자체(시각 · sleep)',
  topo: '인터페이스 · 본딩 · lsblk · ps(pid → 사용자) · systemd 서비스',
  proc: '모든 프로세스의 /proc/<pid>/stat · 읽을 수 있는 /proc/<pid>/io',
});
/**
 * 줄이는 방법(이 서버 · 추정) — 응답 est(서버 load.estimateLoad)로만 말한다. 값이 없으면 빈 목록.
 * @returns {string[]}
 */
export function loadReduceTips(row) {
  const l = row?.load; const e = row?.est;
  if (!l || !e) return [];
  const out = [];
  const cur = n(l.cpuPct);
  const pe = row.procEvery;
  const g = l.groups || {};
  const big = LOAD_GROUPS.map((k) => [k, n(g[k]?.pct)]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
  if (big && cur != null && cur > 0) out.push(`가장 큰 묶음은 ${loadGroupLabel(big[0], pe)} — 수집 CPU 의 ${Math.round((big[1] / cur) * 100)}%${big[0] === 'proc' && l.procs != null ? `(프로세스 ${l.procs}개)` : ''}.`);
  for (const p of [15, 30]) {
    const x = e.byProcEvery?.[p];
    if (p > (pe ?? 5) && x?.cpuPct != null) out.push(`프로세스 표본 주기 ${p}초: 약 ${pctText(x.cpuPct, 2)} · 보내는 양 약 ${byteRateText(x.bps)}(지금 ${pctText(cur, 2)} · ${byteRateText(l.bps)}).`);
  }
  for (const i of [5, 10]) {
    const x = e.byInterval?.[i];
    if (i > (l.interval ?? 2) && x?.cpuPct != null) out.push(`주기 ${i}초: 약 ${pctText(x.cpuPct, 2)}(값이 ${i}초마다 갱신됩니다).`);
  }
  if (!row.agent && !row.demo && n(l.bps) != null) out.push('중앙이 직접 수집하는 서버입니다 — 그 법인 엣지가 맡으면 원문은 법인 안에 머물고 중앙에는 계산된 값만 갑니다.');
  return out;
}
export const LOAD_HOW = Object.freeze([
  '수집 CPU: 원격 반복문 셸이 30초마다 자기 /proc/<pid>/stat 의 utime · stime · cutime · cstime(끝난 자식 grep · awk · cut · sleep 포함)을 보냅니다 — 앞 값과의 차이 ÷ 경과 = 코어 1개 기준 %.',
  'sshd: 부모(sshd 세션)의 utime + stime — 암호 처리 몫입니다. 같은 계정의 다른 SSH 세션은 섞이지 않습니다(이 세션의 pid).',
  '묶음 비용: 묶음 뒤마다 셸 내장 명령(read · set · 산술 — 새 프로세스 없음)으로 같은 tick 을 읽어 더합니다. 이 개발 환경 실측에서 이 측정 자체는 tick 오차(10ms) 안이었습니다.',
  '보내는 양: 노드가 받은 글자 수를 묶음별로 셉니다(SSH 암호 · 압축 전 원문 기준).',
  "'주기를 바꾸면' 은 잰 1회 비용 × 횟수의 추정입니다 — 실제는 캐시 · 다른 부하에 따라 다릅니다.",
]);
export const NODE_LOAD_NOTE = '포탈 CPU 는 다른 기능을 포함한 프로세스 전체입니다 · 그중 집중 모니터링은 줄을 받아 해석한 시간만입니다(SSH 복호 · 기록은 빠져 실제보다 작습니다) · 지연 p99 = Node 이벤트 루프 지연(다른 요청이 기다린 시간) · 받는 양 = 대상 서버에서 SSH 로 받은 원문 · 중앙으로 = 엣지가 동기화로 보낸 양(압축 뒤) · DB 쓰기 = 기록 DB 에 쓴 묶음 본문.';
/** 노드 열 묶음 합(표 아래 '모든 서버를 이 주기로' 추정의 합) — 값이 하나라도 없으면 그 묶음 합은 null. */
export function sumEstimates(rows = [], pick) {
  const by = { base: 0, topo: 0, proc: 0 }; const ok = { base: true, topo: true, proc: true };
  let bps = 0; let bok = true; let k = 0;
  for (const r of rows) {
    const x = pick(r);
    if (!x) continue;
    k += 1;
    for (const g of LOAD_GROUPS) { const v = n(x.by?.[g]); if (v == null) ok[g] = false; else by[g] += v; }
    const b = n(x.bps); if (b == null) bok = false; else bps += b;
  }
  if (!k) return null;
  const out = { n: k, by: {}, cpuPct: null, bps: bok ? Math.round(bps) : null };
  let all = true; let sum = 0;
  for (const g of LOAD_GROUPS) { out.by[g] = ok[g] ? Math.round(by[g] * 100) / 100 : null; if (out.by[g] == null) all = false; else sum += out.by[g]; }
  out.cpuPct = all ? Math.round(sum * 100) / 100 : null;
  return out;
}

export const INSTALL_NOTE = 'restrict 는 포워딩 · 터미널 할당을 끕니다(OpenSSH 7.2 이상 — RHEL 7.8 은 7.4). 그 노드 주소에서만 쓰게 하려면 줄 앞에 from="노드 IP", 를 덧붙이세요. 수집은 /proc · /sys 를 읽기만 하므로 root · sudo 가 필요 없습니다.';

/** 손으로 만든 폴링 루프의 다음 틱을 걸지 않을 오류(403 권한 · 404 경로 없음은 다시 물어도 같다). */
export function shouldStopPolling(err) { const st = Number(err?.status); return st === 403 || st === 404; }

/** 비교 차트 색(고정한 서버 최대 4대 — 어두운 바탕에서 검증한 4색). 나머지는 회색. */
export const PIN_COLORS = Object.freeze(['#3987e5', '#d95926', '#199e70', '#c98500']);
export const REST_COLOR = '#3d4a66';
export const RX_COLOR = '#3987e5';
export const TX_COLOR = '#d95926';

/* ── v2.978 CSV 대량 등록 · 일괄 시험 · 엣지 연결 진단 ──────────────────────────────────────────── */

/** CSV 미리보기 줄 처리(서버 planCsv 의 action 과 1:1 — 테스트가 대조). */
export const CSV_ACTION_TEXT = Object.freeze({
  add: { label: '새로', tone: 'ok' }, update: { label: '갱신', tone: 'warn' }, same: { label: '그대로', tone: 'off' }, error: { label: '오류', tone: 'crit' },
});
export const CSV_FIELD_TEXT = Object.freeze({ name: '이름', username: '계정', agent: '담당 노드', port: '포트', group: '그룹' });

/** 미리보기의 머리글 안내 — 못 찾은 선택 열은 기본값이 들어간다는 것 · 읽지 않은 열(반증 4: 조용한 기본값 금지). */
export function csvHeaderNotes(plan) {
  if (!plan?.header) return [];
  const out = [];
  const miss = plan.missing || [];
  if (miss.includes('port')) out.push('포트 열을 찾지 못해 모든 줄을 22 로 넣습니다.');
  if (miss.includes('agent')) out.push('담당 노드 열을 찾지 못해 모든 줄을 중앙이 맡습니다.');
  if (miss.includes('username')) out.push('계정 열을 찾지 못했습니다 — 모든 줄이 오류입니다.');
  if (plan.ignored?.length) out.push(`읽지 않은 열: ${plan.ignored.join(', ')} — 이 열의 값은 쓰지 않습니다.`);
  if (plan.groupsOver) out.push(`새 그룹 ${plan.newGroups?.length ?? 0}개를 더하면 그룹이 ${plan.groupsMax ?? 50}개를 넘습니다 — 적용할 수 없습니다. 그룹 이름을 기존 그룹으로 맞추세요.`);
  return out;
}
/** CSV 미리보기 그룹 안내 한 줄(v2.982) — 그룹 열이 없으면 기존 그룹을 그대로 둔다는 것, 있으면 새로 만들 그룹. */
export function csvGroupNote(plan) {
  if (!plan) return '';
  if (!plan.groupColumn) return '그룹 열이 없어 기존 서버의 그룹은 그대로 둡니다(새 서버는 그룹 없음).';
  const fresh = plan.newGroups || [];
  return `그룹 열을 읽어 그룹도 정합니다 — 빈 칸은 그룹 없음${fresh.length ? ` · 새로 만들 그룹 ${fresh.length}개: ${fresh.slice(0, 8).join(', ')}${fresh.length > 8 ? ' …' : ''}` : ''}.`;
}
export const nodeText = (agent) => (agent ? `엣지 ${agent}` : '중앙');

/**
 * 말줄임된 서버 이름에 마우스를 올렸을 때 보일 전체 이름(v2.978 사용자 요청 — '마우스 오버하면 생략된 이름 모두 보이게').
 * 표시 이름이 같은 서버가 여럿일 수 있어(한 서버의 두 주소 등) IP 를 붙여 구분한다. 대상이 없으면 빈 글자(제목 없음).
 */
export function nameTitle(t, extra = '') {
  if (!t) return '';
  return `${t.name || ''}${t.host ? ` (${t.host})` : ''}${extra ? ` — ${extra}` : ''}`;
}

/** 갱신 줄의 바뀌는 칸 — ‘계정 root → dvcmon’ 처럼. */
export function csvChangeText(row) {
  if (!row || row.action !== 'update') return '';
  return (row.changes || []).map((f) => {
    const a = f === 'agent' ? nodeText(row.before?.[f]) : f === 'group' ? groupLabel(row.before?.[f]) : row.before?.[f] || DASH;
    const b = f === 'agent' ? nodeText(row.value?.[f]) : f === 'group' ? groupLabel(row.value?.[f]) : row.value?.[f] || DASH;
    return `${CSV_FIELD_TEXT[f] || f} ${a} → ${b}`;
  }).join(' · ');
}

/**
 * CSV 파일 바이트 → 글자. 한국어 엑셀의 ‘CSV(쉼표로 분리)’ 는 CP949(EUC-KR)로 저장한다 — UTF-8 로 읽어 깨지면 EUC-KR 로 다시 읽는다.
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{text:string, encoding:'utf-8'|'euc-kr'|'utf-16'}}
 */
export function decodeCsvBytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // 엑셀 ‘유니코드 텍스트’ 저장본은 UTF-16(BOM FF FE · FE FF) — 탭 구분이다(서버 파서가 탭을 읽는다)
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16' };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('euc-kr').decode(u8), encoding: 'euc-kr' }; }
}

/** 깨우기 결과(서버 edgePull kind + 'ok' · 'error'). hint 는 못 닿았을 때 무엇을 볼지. */
export const WAKE_TEXT = Object.freeze({
  ok: { label: '바로 닿음', tone: 'ok' },
  timeout: { label: '시간 초과', tone: 'warn', hint: '중앙 → 엣지 직접 연결이 느리거나 막혀 있습니다(중계 엣지 · 방화벽).' },
  unreachable: { label: '못 닿음', tone: 'warn', hint: '중앙 → 엣지 직접 연결이 막혀 있습니다(중계 엣지 · 방화벽) — 수집 서버 URL 을 확인하세요.' },
  'old-version': { label: '옛 판', tone: 'crit', hint: '엣지에 이 기능 경로가 없습니다 — 엣지를 업그레이드하세요.' },
  auth: { label: '토큰 불일치', tone: 'crit', hint: '중앙에 등록한 수집 서버 토큰과 엣지의 COLLECTOR_TOKEN 이 다릅니다.' },
  disabled: { label: '엣지에서 꺼짐', tone: 'warn', hint: '엣지가 이 기능을 끈 상태로 답했습니다.' },
  'not-registered': { label: '수집 서버 미등록', tone: 'crit', hint: '설정 › 엣지 · 원격 › 수집 서버(원격)에 이 이름이 없습니다.' },
  'disabled-central': { label: '중앙에서 꺼 둠', tone: 'warn', hint: '중앙의 수집 서버 등록에서 비활성입니다.' },
  'no-url': { label: 'URL 없음', tone: 'crit', hint: '수집 서버 등록에 URL 이 없습니다.' },
  http: { label: 'HTTP 오류', tone: 'warn' },
  'bad-body': { label: '응답 형식 다름', tone: 'warn', hint: '엣지가 아닌 서버에 닿았을 수 있습니다.' },
  error: { label: '오류', tone: 'warn' },
});
export const WAKE_KEYS = Object.freeze(Object.keys(WAKE_TEXT));

/** 깨우기가 닿지 않을 때 시작이 얼마나 늦는지(쉬는 주기) — 값이 없으면 단정하지 않는다. */
export function wakeFallbackText(node) {
  if (!node || node.kind !== 'edge') return '';
  const s = Number(node.idleMs) > 0 ? Math.round(Number(node.idleMs) / 1000) : null;
  if (node.upgrade === 'diag' || s == null) return '깨우기가 닿지 않아도 엣지가 주기적으로 중앙을 조회해 받아 갑니다(옛 판 엣지는 30초).';
  return `깨우기가 닿지 않아도 엣지가 쉬는 동안 ${s}초마다 중앙을 조회해 받아 갑니다 — 시작이 그만큼 늦을 뿐 수집은 됩니다.`;
}

/** 업그레이드 안내(서버 판정 node.upgrade 를 문장으로). */
export function upgradeText(node, { edgeMin, diagMin } = {}) {
  if (node?.upgrade === 'feature') return `이 엣지는 서버 집중 모니터링이 없는 옛 판입니다 — v${edgeMin || '?'} 이상으로 업그레이드해야 이 엣지가 맡은 서버를 수집합니다.`;
  if (node?.upgrade === 'diag') return `연결 진단과 짧은 조회 주기는 v${diagMin || '?'} 이상 엣지에서 나옵니다(지금 v${node.version || '?'}) — 수집은 됩니다.`;
  return '';
}

/** 엣지 진단 한 줄들(값이 없으면 그 칸을 뺀다 — 0 으로 쓰지 않는다). */
export function diagItems(diag, now) {
  if (!diag) return [];
  const out = [];
  const v = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  if (v(diag.rttMs) != null) out.push(['왕복', `${Math.round(v(diag.rttMs))} ms`]);
  if (v(diag.idleMs) != null) out.push(['쉬는 동안 조회', `${Math.round(v(diag.idleMs) / 1000)}초마다`]);
  if (v(diag.collectors) != null) out.push(['수집기', `${v(diag.collectors)}개`]);
  if (v(diag.buffered) != null) out.push(['못 보낸 표본', `${v(diag.buffered)}개`]);
  if (v(diag.dropped) != null && v(diag.dropped) > 0) out.push(['버린 표본', `${v(diag.dropped)}개`]);
  if (v(diag.fails) != null && v(diag.fails) > 0) out.push(['연속 실패', `${v(diag.fails)}번`]);
  if (diag.lastError) out.push(['마지막 오류', `${diag.lastError}${diag.lastErrorAt ? ` (${agoShort(diag.lastErrorAt, now)})` : ''}`]);
  return out;
}

/** 일괄 시험 진행 — 서버 bulkProgress 를 한 줄로. 끝난 지 30분 지난 작업은 보이지 않는다. */
export function bulkLine(p, now) {
  if (!p || !(p.total > 0)) return null;
  if (p.finished && now - p.startedAt > 30 * 60_000) return null;
  const parts = [`성공 ${p.ok}`, `실패 ${p.fail}`];
  if (p.skipped) parts.push(`건너뜀 ${p.skipped}(10초 안에 시험함)`);
  if (p.noAnswer) parts.push(`답 없음 ${p.noAnswer}`);
  const kinds = Object.entries(p.kinds || {}).filter(([k]) => k !== 'ok').sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, c]) => `${TEST_TEXT[k] || k} ${c}`);
  return {
    tone: p.finished ? (p.fail || p.noAnswer ? 'warn' : 'ok') : 'run',
    text: `${p.finished ? '일괄 시험 끝' : '일괄 시험 중'} — ${p.done} / ${p.total - p.skipped}대 · ${parts.join(' · ')}${kinds.length ? ` (${kinds.join(', ')})` : ''}`,
  };
}

/** 그 노드가 맡은 서버를 계정별로 묶는다 — 설치 명령은 계정마다 한 벌(같은 공개키). */
export function installGroups(targets, agent) {
  const m = new Map();
  for (const t of targets || []) {
    if (t.demo || String(t.agent || '').toLowerCase() !== String(agent || '').toLowerCase()) continue;
    if (!m.has(t.username)) m.set(t.username, []);
    m.get(t.username).push(t.host);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([user, hosts]) => ({ user, hosts: [...new Set(hosts)] }));
}
