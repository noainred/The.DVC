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
export const INSTALL_NOTE = 'restrict 는 포워딩 · 터미널 할당을 끕니다(OpenSSH 7.2 이상 — RHEL 7.8 은 7.4). 그 노드 주소에서만 쓰게 하려면 줄 앞에 from="노드 IP", 를 덧붙이세요. 수집은 /proc · /sys 를 읽기만 하므로 root · sudo 가 필요 없습니다.';

/** 손으로 만든 폴링 루프의 다음 틱을 걸지 않을 오류(403 권한 · 404 경로 없음은 다시 물어도 같다). */
export function shouldStopPolling(err) { const st = Number(err?.status); return st === 403 || st === 404; }

/** 비교 차트 색(고정한 서버 최대 4대 — 어두운 바탕에서 검증한 4색). 나머지는 회색. */
export const PIN_COLORS = Object.freeze(['#3987e5', '#d95926', '#199e70', '#c98500']);
export const REST_COLOR = '#3d4a66';
export const RX_COLOR = '#3987e5';
export const TX_COLOR = '#d95926';
