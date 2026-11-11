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
export const ENDED_TEXT = Object.freeze({ stopped: '사람이 끝냄', timeout: '시한이 지나 끝남', 'no-viewer': '보는 화면이 없어 끝남' });

export const TABS = Object.freeze([
  { key: 'overview', label: '개요' },
  { key: 'compare', label: '비교' },
  { key: 'procs', label: '프로세스' },
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
export const CSV_FIELD_TEXT = Object.freeze({ name: '이름', username: '계정', agent: '담당 노드', port: '포트' });

/** 미리보기의 머리글 안내 — 못 찾은 선택 열은 기본값이 들어간다는 것 · 읽지 않은 열(반증 4: 조용한 기본값 금지). */
export function csvHeaderNotes(plan) {
  if (!plan?.header) return [];
  const out = [];
  const miss = plan.missing || [];
  if (miss.includes('port')) out.push('포트 열을 찾지 못해 모든 줄을 22 로 넣습니다.');
  if (miss.includes('agent')) out.push('담당 노드 열을 찾지 못해 모든 줄을 중앙이 맡습니다.');
  if (miss.includes('username')) out.push('계정 열을 찾지 못했습니다 — 모든 줄이 오류입니다.');
  if (plan.ignored?.length) out.push(`읽지 않은 열: ${plan.ignored.join(', ')} — 이 열의 값은 쓰지 않습니다.`);
  return out;
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
    const a = f === 'agent' ? nodeText(row.before?.[f]) : row.before?.[f] || DASH;
    const b = f === 'agent' ? nodeText(row.value?.[f]) : row.value?.[f] || DASH;
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
