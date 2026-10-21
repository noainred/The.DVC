/**
 * guestPartText.js — 게스트 파티션 사용률 화면의 순수 판정·문구(v2.749). 렌더는 테스트할 수 없으니 틀리면 오판하는 규칙을 여기 둔다.
 *
 *  - 사용률·용량을 모르면 0 이 아니라 '—'(단위 없음). 확인 불가(Tools 미보고)는 초과·정상 어디에도 넣지 않는다.
 *  - 색 단계: 95% 이상 위험 · 90% 이상 경고 · 임계 이상 주의 · 그 밖 정상. 색만으로 구분하지 않도록 글자 표지(위험·경고·주의)를 함께 준다.
 *  - 판정·무시 규칙의 진실은 서버(guestpart/rules.js)다. 화면의 패턴 검사는 입력을 돕는 것일 뿐이고, 저장 결과는 서버가 정한다.
 */
import { numOrNull } from '../../numOrNull.js';

export const CRIT_PCT = 95;
export const WARN_PCT = 90;

/** 사용률 → { color, tag, tone }. 모르면 회색·태그 없음. */
export function levelOf(pct, thr = 80) {
  const p = numOrNull(pct);
  if (p == null) return { color: '#94a3b8', tag: '', tone: 'none' };
  if (p >= CRIT_PCT) return { color: '#f87171', tag: '위험', tone: 'crit' };
  if (p >= WARN_PCT) return { color: '#fb923c', tag: '경고', tone: 'warn' };
  if (p >= (numOrNull(thr) ?? 80)) return { color: '#fbbf24', tag: '주의', tone: 'over' };
  return { color: '#38bdf8', tag: '', tone: 'ok' };
}

export function gbText(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  if (n >= 1024) return `${(n / 1024).toFixed(1)} TB`;
  return `${n.toFixed(n < 100 ? 1 : 0)} GB`;
}
export const pctText = (v) => (numOrNull(v) == null ? '—' : `${Number(v).toFixed(1)}%`);
export function growthText(g) {
  const n = numOrNull(g);
  if (n == null) return '—';
  if (n <= 0) return '증가 없음';
  return `+${gbText(n)}`;
}
export function etaText(d) {
  const n = numOrNull(d);
  if (n == null) return '—';
  if (n < 1) return '1일 안';
  if (n < 365) return `${Math.round(n)}일 뒤`;
  return '1년 이상';
}
export const OS_LABEL = Object.freeze({ win: 'Windows', lnx: 'Linux', other: '기타' });
export const osLabel = (os) => OS_LABEL[os] || '기타';

const pad = (n) => String(n).padStart(2, '0');
/** epoch ms → 'MM-DD HH:MM'(서버가 준 오프셋 — 기본 한국). */
export function timeText(t, offsetMin = 540) {
  const n = numOrNull(t);
  if (n == null) return '—';
  const d = new Date(n + offsetMin * 60_000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
export function daysLabel(days) {
  const d = [...new Set((days || []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b);
  if (d.length === 7) return '매일';
  if (d.join(',') === '1,2,3,4,5') return '평일';
  if (!d.length) return '요일 없음';
  return d.map((x) => DAY_LABELS[x]).join('·');
}

/** 주소 목록 입력(줄바꿈·쉼표·세미콜론·공백) → 배열. 형식 판정은 서버가 한다(틀리면 저장 거부 + 이유). */
export function splitEmails(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** 패턴 입력 보조(서버 rules.isWinPattern·isLnxPattern 과 같은 규칙 — 웹 테스트가 같은 입력으로 대조). */
export const isWinPattern = (s) => typeof s === 'string' && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s) && (/^[A-Za-z*]:[\\/]/.test(s) || s.startsWith('\\\\'));
export const isLnxPattern = (s) => typeof s === 'string' && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s) && s.startsWith('/') && !/\s/.test(s);

/** 화면 조건 → 쿼리. 기본 임계와 같으면 보내지 않는다(서버가 vCenter 별 임계를 쓰게). */
export function overviewParams({ thr = null, defaultThr = null, mode = null, os = 'all', q = '' } = {}) {
  const p = {};
  if (numOrNull(thr) != null && thr !== defaultThr) p.thr = String(thr);
  if (mode) p.mode = mode;
  if (os && os !== 'all') p.os = os;
  if (String(q || '').trim()) p.q = String(q).trim();
  return p;
}

/** 행 정렬(사용률·남은 용량·가득 참). 값이 없으면 항상 뒤로. */
export function sortRows(rows = [], key = 'pct') {
  const val = (r) => (key === 'free' ? numOrNull(r.freeGB) : key === 'eta' ? numOrNull(r.etaDays) : numOrNull(r.pct));
  const dir = key === 'pct' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = val(a); const y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  });
}

/** 메일 기록 한 줄 문구. */
export const MAIL_STATE_TEXT = Object.freeze({ sent: '보냄', skipped: '건너뜀', failed: '실패', missed: '놓침' });
export const MAIL_KIND_TEXT = Object.freeze({ schedule: '정기', scan: '수집 직후', manual: '지금 보내기', test: '테스트', crit: '95% 즉시', fail: '수집 실패', stale: '값 지연' });
export function historyLine(h, vcName = (id) => id) {
  const scope = h.scope === '전체 법인' ? '전체 법인' : vcName(h.scope);
  const n = numOrNull(h.count) != null ? ` · 대상 ${h.count}개` : '';
  const r = numOrNull(h.recipients) != null ? ` · ${h.recipients}명` : '';
  return `${MAIL_KIND_TEXT[h.kind] || h.kind || ''} · ${scope}${n}${r}${h.reason ? ` — ${h.reason}` : ''}`;
}

/** 수집 상태 안내(값이 없는 이유를 단정하지 않는다 — 아는 것만). */
export function collectNote(c) {
  if (!c) return '';
  if (!c.dbAvailable) return '게스트 디스크 DB 를 열 수 없습니다(설정 › 진단에서 확인).';
  if (c.empty && !c.enabled) return '아직 수집된 값이 없습니다 — 주기 수집이 꺼져 있습니다(설정 › 수집 서버 › 게스트 파티션 사용률에서 켜거나 지금 수집).';
  if (c.empty) return '아직 수집된 값이 없습니다 — 다음 수집이 끝나면 채워집니다(업그레이드 직후라면 첫 수집 전입니다).';
  if (!c.enabled) return '주기 수집이 꺼져 있어 값이 더 갱신되지 않습니다(엣지 위임 vCenter 는 엣지가 보낸 값으로 갱신됩니다).';
  return '';
}

/** v2.750 VM 상세 — '3시간 전' 같은 경과 문구. 미래 시각(시계 차이)은 '방금'. */
export function agoText(ts, now = Date.now()) {
  const t = numOrNull(ts);
  if (t == null) return '';
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/**
 * v2.750 VM 상세 — 파티션 값이 없거나 오래된 이유(아는 것만 말한다).
 *   d = GET /vms/:id/partitions 응답. 반환 { empty: 값이 없을 때의 안내, stale: 값은 있지만 오래됐을 때의 안내 }.
 */
export function vmPartNote(d, now = Date.now()) {
  if (!d) return { empty: '', stale: '' };
  const where = '설정 › 수집 서버 › 게스트 파티션 사용률';
  const enabled = !!d.collect?.enabled;
  const iv = numOrNull(d.collect?.intervalHours);
  if (!d.dbAvailable) return { empty: '게스트 디스크 DB 를 열 수 없어 파티션 값을 보여 줄 수 없습니다(설정 › 진단에서 확인).', stale: '' };
  if (numOrNull(d.collectedAt) == null) {
    const vcTs = numOrNull(d.vcenterLastTs);
    if (vcTs != null) {
      return { empty: `이 vCenter 의 최근 수집(${timeText(vcTs, d.offsetMin)})에 이 VM 의 파티션이 없습니다 — 전원 꺼짐·VMware Tools 미실행·Tools 가 파티션을 보고하지 않는 경우입니다.`, stale: '' };
    }
    return { empty: enabled ? '이 vCenter 는 아직 게스트 파티션을 수집하지 않았습니다 — 다음 수집이 끝나면 채워집니다.'
      : `게스트 파티션 주기 수집이 꺼져 있어 값이 없습니다(${where}에서 켜거나 지금 수집).`, stale: '' };
  }
  if (!enabled) return { empty: '', stale: '주기 수집이 꺼져 있어 마지막으로 수집한 값입니다(엣지 위임 vCenter 는 엣지가 보낸 값으로 갱신됩니다).' };
  if (iv != null && now - d.collectedAt > iv * 2 * 3_600_000) {
    return { empty: '', stale: `수집 주기(${iv}시간)의 두 배 넘게 지났습니다 — 최근 수집이 실패했을 수 있습니다.` };
  }
  return { empty: '', stale: '' };
}
