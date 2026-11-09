/**
 * 리눅스 성능 8a단계 — **정비 창 · 알림 억제** 화면 문구 · 형식(순수 — React 없음 · vitest node 환경).
 * ⚠ 판정(지금 억제 중인가 · 다음 발생 · 남은 시간 · DST 밀림 · 소유자 등급 필요)은 서버가 한다(bmusage/maint/judge.js · schedule.js) — 여기는 그 값을 글자로 옮기기만.
 *   웹이 시간대 · 일정 계산을 복제하지 않는다(미리보기도 서버 POST /maintenance/preview).
 * ⚠ 숫자(길이 상한 · 재확인 주기 · 배포 시한)는 API 의 limits 값만 쓴다 — 문구에 박지 않는다. 값이 없으면 ‘—’(0 이 아니다).
 * ⚠ 문구에 백틱 금지(BoldText 는 ‘**’ 만 해석) — 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';

const n = numOrNull;
export const SCOPE_ORDER = Object.freeze(['alerts', 'hold', 'focus', 'collect', 'exclude']);
/** 억제 범위 5종(서버 judge.SCOPES 와 1:1). short = 목록 칸 · label = 폼 · desc = 설명. */
export const SCOPE_TEXT = Object.freeze({
  alerts: { short: '알림', label: '① 알림 발송 억제', desc: '판정 · 초과 기록은 그대로, 발송 · 이슈만 막는다 — 창이 끝난 뒤에도 초과면 그때 1회(‘정비 창 안부터 초과’)' },
  hold: { short: '전이 보류', label: '② 하드웨어 장애 전이 보류', desc: '파트 장애를 열지도 닫지도 않고 보류(사유 ‘정비 창 안’) — 창이 끝난 뒤 첫 점검에서 다시 판정' },
  focus: { short: '자동 집중', label: '③ 자동 집중 모니터링 억제', desc: '알림 규칙이 거는 자동 집중만 쉰다 — 수동 집중은 사유를 적고 실행할 수 있다' },
  collect: { short: '수집 중단', label: '④ 수집 자체 중단', desc: '기본 꺼짐 · 켜면 그 서버에 접속하지 않는다(‘정비 중’ — 실패로 세지 않는다 · vCenter 점검중 플래그와 같은 뜻)' },
  exclude: { short: '분모 제외', label: '⑤ 목표선 분모 · 베이스라인 롤업 · 용량 추세에서 제외', desc: '그 구간의 값을 목표선 달성률 분모 · 베이스라인 표본 · 용량 예측 추세 창에서 뺀다(뺀 수를 적는다)' },
});
export const STATUS_TEXT = Object.freeze({
  active: { label: '진행 중', tone: 'warn' }, scheduled: { label: '예정', tone: 'idle' }, ended: { label: '끝남', tone: 'idle' },
  expired: { label: '재확인 만료 — 억제 안 함', tone: 'bad' }, deleted: { label: '지움', tone: 'idle' },
});
export const TARGET_KIND_TEXT = Object.freeze({ server: '서버', tag: '태그', corp: '법인 전체' });
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const NTH = { 1: '첫째', 2: '둘째', 3: '셋째', 4: '넷째', 5: '마지막' };
export const WEEKDAY_OPTIONS = Object.freeze(DOW.map((d, i) => [i, d]));
export const NTH_OPTIONS = Object.freeze(Object.entries(NTH).map(([k, v]) => [Number(k), v]));
/** 시간대 선택지(법인이 있는 곳 — 자유 입력도 받는다: 서버가 IANA 이름을 검사). */
export const TZ_OPTIONS = Object.freeze(['Asia/Seoul', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Mexico_City', 'America/Sao_Paulo', 'UTC']);

/** 길이(분) → ‘4시간’ · ‘1시간 30분’ · ‘—’. */
export function durText(min) {
  const m = n(min);
  if (m == null) return '—';
  const h = Math.floor(m / 60); const r = m % 60;
  return h && r ? `${h}시간 ${r}분` : h ? `${h}시간` : `${r}분`;
}
/** 일정 한 줄(서버가 준 벽시계 표기 · 꼴). */
export function scheduleText(w = {}) {
  const s = w.schedule || {};
  if (s.kind === 'once') return `${String(s.start || '').replace('T', ' ')} ~ ${String(s.end || '').replace('T', ' ').slice(String(s.end || '').slice(0, 10) === String(s.start || '').slice(0, 10) ? 11 : 0)} (일회)`;
  if (s.kind === 'weekly') return `매주 ${(s.days || []).map((d) => DOW[d] ?? '?').join('·')} ${s.time || '—'} · ${durText(s.durMin)} (반복)`;
  if (s.kind === 'monthly') return `매월 ${NTH[s.nth] || '?'} ${DOW[s.weekday] ?? '?'} ${s.time || '—'} · ${durText(s.durMin)} (반복)`;
  return '—';
}
/** 남은 시간 ‘1:35’ · 없으면 ''. */
export function remainingText(ms) {
  const x = n(ms);
  if (x == null || x <= 0) return '';
  const m = Math.ceil(x / 60_000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
/** 상태 한 줄 — 진행 중이면 남은 시간 · 예정이면 다음 시작 · 끝났으면 마지막. */
export function statusLine(w = {}) {
  const st = STATUS_TEXT[w.status] || { label: w.status || '—' };
  if (w.status === 'active') return `${st.label}${remainingText(w.remainingMs) ? ` · 남은 ${remainingText(w.remainingMs)}` : ''}`;
  if (w.status === 'scheduled') return `${st.label}${w.next?.startLocal ? ` · 다음 ${w.next.startLocal}` : ''}`;
  if (w.status === 'ended') return `${st.label}${w.endedAt != null ? ' · 지금 끝내기로 끝남' : ''}`;
  return st.label;
}
/** 대상 한 줄. */
export function targetText(w = {}, corpName = (id) => id) {
  const t = w.target || {};
  if (t.kind === 'corp') return `법인 ${corpName(w.vcenterId)} 전체`;
  if (t.kind === 'tag') return `태그 ${t.tag || '—'} (법인 ${corpName(w.vcenterId)})`;
  const names = t.names || [];
  return names.length ? `${names.slice(0, 3).join(' · ')}${(t.count || names.length) > 3 ? ` 외 ${(t.count || names.length) - 3}대` : ''}` : (n(t.count) == null ? '서버 —' : `서버 ${t.count}대`);
}
/** 억제 범위 칸(켠 것만 · 짧게). */
export function scopesText(list = []) { return SCOPE_ORDER.filter((s) => (list || []).includes(s)).map((s) => SCOPE_TEXT[s].short).join(' · ') || '—'; }
/** 억제 계수 한 줄 — 이 노드 + 엣지 봉투 합(서버 값 그대로). 없으면 ''(0 을 지어내지 않는다). */
export function countsText(c) {
  if (!c) return '';
  const parts = [];
  if (n(c.alerts)) parts.push(`억제 알림 ${c.alerts}`);
  if (n(c.after)) parts.push(`창 뒤 발송 ${c.after}`);
  if (n(c.hold)) parts.push(`전이 보류 ${c.hold}대`);
  if (n(c.focus)) parts.push(`자동 집중 쉼 ${c.focus}`);
  if (n(c.collect)) parts.push(`수집 건너뜀 ${c.collect}`);
  if (n(c.collectFail)) parts.push(`창 안 수집 실패 ${c.collectFail}`);
  return parts.join(' · ') || '억제한 것 없음';
}
/** ‘창 끝 뒤 억제’ 점검 한 줄(서버 leak — 0 이어야 정상 · 모르면 모른다고). */
export function leakText(leak) {
  if (!leak || n(leak.n) == null) return { text: '창 끝 뒤 억제 — 아직 점검한 주기가 없습니다', tone: 'idle' };
  if (leak.n === 0) return { text: `창 끝 뒤 억제 0 — 정상(지난 점검 억제 적용 ${n(leak.last) ?? 0}건 · 잡는 것: 창 끝 · 길이 상한 · 지움 · 끝내기 · 재확인 만료 · 배포본 시한 / 못 잡는 것: 판정 규칙 자체)`, tone: 'ok' };
  return { text: `창 끝 뒤 억제 ${leak.n}건 — 억제가 창 끝 · 길이 상한 · 지움 · 끝내기 · 재확인 만료 · 배포본 시한을 넘겨 적용됨(관리자 확인 필요)`, tone: 'bad' };
}
/** 배포 현황 한 줄(엣지 행). */
export const DEPLOY_STATUS_TEXT = Object.freeze({
  applied: { label: '반영됨', tone: 'ok' }, pending: { label: '대기 — 다음 인출에 반영', tone: 'warn' }, never: { label: '인출 기록 없음(이 중앙 기동 뒤)', tone: 'idle' },
  old: { label: '구버전 엣지 — 정비 창을 받지 못함', tone: 'bad' },
  // v2.954(점검 D-1): 중앙이 그 엣지 대상을 몰라(재시작 뒤 · 엣지 인출 전) 태그 창을 펼 수 없다 — 배포를 보류하고 엣지는 지난 배포본을 24시간까지 쓴다
  'targets-unknown': { label: '대상 모름 — 태그 창은 직전 배포 대상으로 유지(엣지 대상 자동 인출 중)', tone: 'warn' },
});
/** 추이 음영 띠(서버 occurrences 응답의 merged — 그리기만). */
export function maintBands(resp) {
  if (!resp || resp.ok === false) return [];
  const names = new Map((resp.items || []).map((x) => [x.id, x.name]));
  return (resp.merged || []).filter((x) => n(x.from) != null && n(x.to) != null && x.to > x.from)
    .map((x) => ({ from: x.from, to: x.to, title: `정비 창 — ${(x.ids || []).map((id) => names.get(id) || id).join(' · ')}` }));
}
/** 시각이 정비 창 구간 안인가(서버 merged — 그리기용 묶음 표시). */
export function inMaint(ts, bands = []) { const t = n(ts); return t != null && bands.some((b) => t >= b.from && t < b.to); }
/** 변경 이벤트를 ‘정비 창 안’ 으로 묶는다 — { inside, outside }(순서 유지). */
export function splitByMaint(events = [], bands = []) {
  const inside = []; const outside = [];
  for (const e of events || []) (inMaint(e?.ts, bands) ? inside : outside).push(e);
  return { inside, outside };
}

/** 폼 상태 → API 본문(순수 — 검사는 서버가 한다: 형식 밖 400 · 여기서는 모양만). */
export function formToBody(f = {}) {
  const target = f.kind === 'server' ? { kind: 'server', keys: String(f.keys || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) }
    : f.kind === 'tag' ? { kind: 'tag', tag: String(f.tag || '').trim() } : { kind: 'corp' };
  const schedule = f.sched === 'once' ? { kind: 'once', start: String(f.start || ''), end: String(f.end || '') }
    : f.sched === 'weekly' ? { kind: 'weekly', days: (f.days || []).map(Number), time: String(f.time || ''), durMin: Number(f.durMin) }
      : { kind: 'monthly', nth: Number(f.nth), weekday: Number(f.weekday), time: String(f.time || ''), durMin: Number(f.durMin) };
  // 서버 대상 = (법인, 키) 쌍 — 법인을 고르면 그 법인 안에서만 키를 찾는다(고르지 않으면 서버가 키로 찾고 여러 법인이면 고르라고 한다)
  const vc = f.kind !== 'server' ? f.corp : String(f.serverCorp || '');
  return { name: f.name, reason: f.reason, tz: f.tz, target, ...(vc ? { vcenterId: vc } : {}), schedule,
    scopes: Object.fromEntries(SCOPE_ORDER.filter((s) => f.scopes?.[s]).map((s) => [s, true])) };
}
/** 빈 폼(억제 기본 = 설계 그림: ① ② ③ ⑤ 켬 · ④ 꺼짐). */
export function emptyForm({ corp = '', tz = 'Asia/Seoul' } = {}) {
  return { name: '', reason: '', kind: 'server', keys: '', serverCorp: '', tag: 'role:web', corp, tz, sched: 'once', start: '', end: '', days: [6], nth: 2, weekday: 6, time: '02:00', durMin: 240,
    scopes: { alerts: true, hold: true, focus: true, collect: false, exclude: true } };
}
/** 고치기 — 서버 창 → 폼. */
export function windowToForm(w = {}) {
  const s = w.schedule || {};
  return { name: w.name || '', reason: w.reason || '', kind: w.target?.kind || 'server', keys: (w.target?.keys || []).join(', '), serverCorp: w.target?.kind === 'server' ? (w.vcenterId || '') : '', tag: w.target?.tag || '', corp: w.vcenterId || '', tz: w.tz || 'Asia/Seoul',
    sched: s.kind || 'once', start: s.start || '', end: s.end || '', days: s.days || [6], nth: s.nth || 2, weekday: s.weekday ?? 6, time: s.time || '02:00', durMin: s.durMin || 240,
    scopes: Object.fromEntries(SCOPE_ORDER.map((k) => [k, (w.scopes || []).includes(k)])) };
}
/** 승인 안내(서버 limits 값으로 — 숫자를 박지 않는다). */
export function approvalNote(limits = {}) {
  const h = n(limits.ownerOverMin) != null ? limits.ownerOverMin / 60 : null;
  const ht = h != null ? `${h}시간` : '—';
  return `법인 전체 · 태그 대상 · ${ht} 넘는 창은 설정 소유자 등급(소유자 + 전체 범위)만 저장할 수 있습니다 — 개별 서버 창은 운영자가 바로(쓰기 범위 안 서버만). `
    + `같은 서버를 덮는 창들(소유자 창 · 법인 · 태그 창 포함)의 합이 어느 24시간에서든 ${ht}을 넘으면 그 창도 소유자 등급입니다(재확인 포함).`;
}
export function limitsNote(limits = {}) {
  const o = n(limits.onceMaxMin); const r = n(limits.recurMaxMin); const c = n(limits.confirmDays);
  return `최대 길이 일회 ${o != null ? durText(o) : '—'} · 반복 ${r != null ? durText(r) : '—'} · 반복 창은 확인 뒤 ${c == null ? '—' : `${c}일`}이 지나면 억제를 멈춥니다(재확인 필요 — 억제가 풀리지 않는 일을 막는 시한).`;
}
export function maintHonest(limits = {}) {
  const ttl = n(limits.deployTtlMs);
  return '정비 창은 **기록은 하되 보내지 않는다** — 판정 자체를 지우지 않습니다. 인증 거부는 창과 무관하게 즉시 정지합니다(계정 잠금 방지). '
    + '반복 일정은 ‘매주 요일 · 매월 n째 요일’ 두 꼴만(시간대는 창마다 저장 — 포탈에 법인 시간대 원천이 없습니다) · 서머타임이 있는 시간대는 미리보기 5회로 확인하세요(없는 시각은 뒤로 밀립니다). '
    + `중앙에 저장하고 엣지에는 그 법인 창만 배포합니다(태그 창은 중앙이 서버 키로 펼쳐 보냅니다) · 엣지는 받은 지 ${ttl != null ? durText(Math.round(ttl / 60_000)) : '—'}이 지난 배포본으로는 억제하지 않습니다. `
    + '파트 장애 보류는 중앙 판정이라 중앙 창만 봅니다(엣지에서 따로 만든 창은 그 엣지의 알림 · 집중 · 수집 · 분모에만).';
}
