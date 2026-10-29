/**
 * Veeam 백업 현황 › EM 탭(v2.788) 순수 도우미 — 화면(BackupEmTool.jsx)과 테스트가 같은 함수를 쓴다.
 * 규칙: 못 읽은 값(null·undefined)은 '—' 이고 단위를 붙이지 않는다(0 과 구분 — web/src/numOrNull.js 규칙).
 */
import { numOrNull } from '../../numOrNull.js';
import { fmtNum, shortTs } from './backupViewText.js';
import { agoText } from './relTime.js';

export { fmtNum, shortTs };

/** 바이트 → 'TB'·'GB'·'MB'(1000 단위 — Veeam 화면과 같다). 모르면 '—'. */
export function fmtBytes(v) {
  const n = numOrNull(v);
  if (n == null || n < 0) return '—';
  const U = [['PB', 1e15], ['TB', 1e12], ['GB', 1e9], ['MB', 1e6]];
  for (const [u, d] of U) if (n >= d) return `${(n / d).toFixed(n / d >= 100 ? 0 : 1)} ${u}`;
  return `${Math.round(n)} B`;
}
/** 초 → '5시간 12분'·'42분'·'30초'. 모르면 '—'. */
export function fmtDur(sec) {
  const n = numOrNull(sec);
  if (n == null || n < 0) return '—';
  const h = Math.floor(n / 3600); const m = Math.floor((n % 3600) / 60);
  if (h) return `${h}시간${m ? ` ${m}분` : ''}`;
  if (m) return `${m}분`;
  return `${Math.round(n)}초`;
}
const p2 = (x) => String(x).padStart(2, '0');
/** 'YYYY-MM-DD'(이 브라우저 시간대). 모르면 '—'. */
export function dateText(ts) {
  const t = numOrNull(ts);
  if (t == null || t <= 0) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** 'n분 전'·'n시간 전'·'n일 전' — 공용 코어(relTime.agoText) 한 줄 껍데기(DEPS2613-11 — 상대 시각을 따로 구현하지 않는다). */
export const ago = (ts, now = Date.now()) => agoText(ts, now);

export const JOB_FILTERS = [['all', '전체'], ['fail', '실패'], ['warn', '경고'], ['run', '실행 중'], ['ok', '정상'], ['none', '기록 없음']];
export const JOB_LABEL = { fail: '실패', warn: '경고', run: '실행 중', ok: '정상', none: '기록 없음' };
export const TONE = { fail: '#fca5a5', warn: '#fcd34d', run: '#67e8f9', ok: '#86efac', none: 'var(--text-dim)' };
export const BADGE_BG = { fail: 'rgba(239,68,68,.16)', warn: 'rgba(245,158,11,.16)', run: 'rgba(34,211,238,.14)', ok: 'rgba(34,197,94,.14)', none: 'var(--panel-deep)' };

/** 수집 항목 이름 — 서버 veeam/em/client.js EM_SECTIONS 와 같은 키·순서(테스트가 대조). */
export const SECTION_LABEL = Object.freeze({
  overview: '전체 개요', jobStats: '작업 통계', vms: 'VM 개요', processed: '처리 VM', repoReport: '저장소 보고서',
  backupServers: '백업 서버', jobs: '작업', repositories: '저장소', hierarchyRoots: '연결 호스트', sessions: '세션', vmBackups: 'VM 별 기록',
});
/** 수집 상태 칩 — 항목별 성공·실패(사유). 수집 전이면 빈 목록. */
export function sectionChips(status) {
  const sec = status?.sections || {};
  return Object.keys(SECTION_LABEL).filter((k) => sec[k]).map((k) => ({ k, label: SECTION_LABEL[k], ok: sec[k].ok === true, reason: sec[k].reason || '' }));
}

/** 수집 상태 한 줄 — { tone:'ok'|'warn'|'bad'|'muted', text }. */
export function statusLine(status, now = Date.now()) {
  if (!status) return { tone: 'muted', text: '아직 수집 전입니다(첫 수집은 포탈 시작 2분 뒤 · 설정에서 지금 수집).' };
  if (status.kind === 'auth-stopped' || status.authStop) return { tone: 'bad', text: `인증 실패로 주기 수집을 멈췄습니다 — 설정 › Veeam 백업 서버 › Enterprise Manager 에서 계정을 고치세요${status.lastOkTs ? ` · 마지막 성공 ${shortTs(status.lastOkTs)}` : ''}` };
  if (!status.ok) return { tone: 'bad', text: `마지막 수집 실패 — ${status.error || '사유 모름'}${status.lastOkTs ? ` · 아래 값은 마지막 성공(${shortTs(status.lastOkTs)}) 기준` : ''}` };
  if (status.stale) return { tone: 'warn', text: `마지막 성공 ${shortTs(status.lastOkTs)}(${ago(status.lastOkTs, now)}) — 수집이 늦어지고 있습니다` };
  const failed = sectionChips(status).filter((c) => !c.ok).length;
  return { tone: failed ? 'warn' : 'ok', text: `마지막 수집 ${shortTs(status.ts)}(${ago(status.ts, now)})${failed ? ` · ${failed}개 항목을 읽지 못했습니다` : ''}` };
}

/** 만료 남은 일 — 'D-47'·'만료'·'—'. */
export function ddayText(daysLeft) {
  const d = numOrNull(daysLeft);
  if (d == null) return '—';
  return d < 0 ? `만료(${-d}일 지남)` : `D-${d}`;
}
export const ddayTone = (daysLeft) => { const d = numOrNull(daysLeft); return d == null ? 'none' : d < 0 || d <= 7 ? 'fail' : d <= 30 ? 'warn' : d <= 90 ? 'run' : 'ok'; };

/** 라이선스 카드 — 사용률(둘 다 아는 서버만 합) · 서버별 줄(사용 많은 순). */
export function licenseCard(lic) {
  const t = lic?.totals || {};
  const items = (Array.isArray(lic?.items) ? lic.items : []).map((x) => {
    const i = x.license?.instances || null;
    const used = numOrNull(i?.used); const licensed = numOrNull(i?.licensed);
    return { id: x.id, name: x.name, used, licensed, pct: used != null && licensed ? Math.round((used / licensed) * 1000) / 10 : null, edition: x.license?.edition || '', type: x.license?.type || '', expires: x.license?.expires ?? null, supportExpires: x.license?.supportExpires ?? null, demo: !!x.demo };
  }).sort((a, b) => ((b.used ?? -1) - (a.used ?? -1)) || String(a.name).localeCompare(String(b.name)));
  const used = numOrNull(t.used); const licensed = numOrNull(t.licensed);
  return {
    items, used, licensed, remain: used != null && licensed != null ? licensed - used : null,
    pct: used != null && licensed ? Math.round((used / licensed) * 1000) / 10 : null,
    unknown: numOrNull(t.unknown) || 0, earliest: t.earliest || null, earliestSupport: t.earliestSupport || null,
  };
}

/** 저장소 사용률 색 — 90% 이상 빨강 · 80% 이상 주황 · 모르면 흐림. */
export const repoTone = (pct) => { const p = numOrNull(pct); return p == null ? 'none' : p >= 90 ? 'fail' : p >= 80 ? 'warn' : 'run'; };

/** 작업 필터 + 검색(이름·백업 서버). */
export function filterJobs(items, f = 'all', q = '') {
  const s = String(q || '').trim().toLowerCase();
  return (Array.isArray(items) ? items : []).filter((j) => (f === 'all' || j.state === f) && (!s || `${j.name} ${j.server} ${(j.vcNames || []).join(' ')}`.toLowerCase().includes(s)));   // v2.788.1 법인 이름으로도
}

/** 24시간 실행 결과 막대 조각(%). 끝난 세션이 0 이면 null(막대를 그리지 않는다). */
export function runBar(counts) {
  const c = counts || {};
  const total = (numOrNull(c.ok) || 0) + (numOrNull(c.warn) || 0) + (numOrNull(c.fail) || 0);
  if (!total) return null;
  const p = (n) => Math.round(((numOrNull(n) || 0) / total) * 1000) / 10;
  return { ok: p(c.ok), warn: p(c.warn), fail: p(c.fail), total };
}

/**
 * 이력 → 작은 선(SVG points 문자열). series = [[day, a, b], ...], val = (a, b) => 값|null.
 * 값이 2개 미만이면 null(선을 그리지 않는다 — 한 점은 추이가 아니다). 값이 없는 날은 건너뛴다(0 으로 내리지 않는다).
 */
export function sparkPoints(series, val, { w = 120, h = 28 } = {}) {
  const pts = (Array.isArray(series) ? series : []).map(([d, a, b]) => [d, val(a, b)]).filter(([, v]) => v != null && Number.isFinite(v));
  if (pts.length < 2) return null;
  const d0 = pts[0][0]; const d1 = pts[pts.length - 1][0];
  const vs = pts.map(([, v]) => v); const lo = Math.min(...vs); const hi = Math.max(...vs);
  const x = (d) => (d1 === d0 ? 0 : ((d - d0) / (d1 - d0)) * w);
  const y = (v) => (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h);
  return { points: pts.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' '), days: pts.length, first: vs[0], last: vs[vs.length - 1] };
}
export const usedPctOf = (cap, free) => { const c = numOrNull(cap); const f = numOrNull(free); return c != null && c > 0 && f != null ? Math.round(((c - f) / c) * 1000) / 10 : null; };

/* ── v2.788.1 EM 백업 서버 매핑(설정 › Veeam 백업 서버 › Enterprise Manager) ─────────── */
/** B&R 짝 문구 — { text, tone }. 서버 veeam/em/view.js mapBackupServers 의 brSource 값을 그대로 읽는다. */
export function brMatchText(r) {
  if (!r) return { text: '—', tone: 'none' };
  if (r.brSource === 'manual') return { text: `${r.brName} (수동)`, tone: 'ok' };
  if (r.brSource === 'auto') return { text: `${r.brName} (이름으로 자동)`, tone: 'ok' };
  if (r.brSource === 'none') return { text: '포탈에 없음(확정)', tone: 'none' };
  if (r.brSource === 'missing') return { text: '고른 B&R 등록이 지워졌습니다', tone: 'fail' };
  return { text: '짝 없음 — 포탈 미등록', tone: 'warn' };
}
/** 법인(vCenter) 문구 — 수동 · B&R 등록을 따름 · 모름. */
export function vcMatchText(r) {
  const names = Array.isArray(r?.vcNames) ? r.vcNames : [];
  if (r?.vcSource === 'manual') return { text: names.join(', '), sub: '수동', tone: 'ok' };
  if (r?.vcSource === 'br') return { text: names.join(', '), sub: 'B&R 등록을 따름', tone: 'run' };
  return { text: '정하지 않음', sub: '', tone: 'warn' };
}
/**
 * v2.795 'vCenter 반영' — 서버(admin/veeamEm.js reflectOf)가 정한 값을 문구로. VM 기록 수는 모르면 '—'(0 이 아니다).
 *  br = 짝지은 B&R 직접 수집이 정상이라 그것으로(EM 기록은 쓰지 않음) · em = EM 의 VM 별 기록으로 · mixed = vCenter 마다 다름 · none = 법인을 정하지 않아 싣지 않음.
 */
export function reflectText(r) {
  const n = r?.vmCount == null ? '—' : `${Number(r.vmCount).toLocaleString('ko-KR')}대`;
  if (r?.gone) return { text: '반영 안 함', sub: 'EM 결과에 없음', tone: 'none' };
  switch (r?.reflect) {
    case 'br': return { text: 'B&R 직접 수집', sub: `EM 기록 ${n} — B&R 이 정상이라 쓰지 않음`, tone: 'ok' };
    case 'em': return { text: 'EM 기록으로', sub: `VM ${n}${r.brId ? ' · B&R 읽기 실패·대기 대신' : ''}`, tone: 'run' };
    case 'mixed': return { text: 'vCenter 마다 다름', sub: `VM ${n} · B&R 이 맡은 vCenter 는 B&R`, tone: 'run' };
    default: return { text: '반영 안 함', sub: '법인(vCenter)을 정하면 반영됩니다', tone: 'warn' };
  }
}
/** 매핑 요약 — 전체 · B&R 짝 있음 · 법인 정함(사라진 줄은 세지 않는다). */
export function mappingSummary(rows) {
  const live = (Array.isArray(rows) ? rows : []).filter((r) => !r.gone);
  return { total: live.length, registered: live.filter((r) => r.registered).length, withVc: live.filter((r) => r.vcSource).length, gone: (rows || []).length - live.length };
}

/* ── v2.788.1 실패·경고 상세 ─────────── */
const RES_ORDER = { fail: 0, warn: 1, ok: 2, none: 3 };
/** 상세 응답 → 요약 한 줄 + VM 줄(실패 → 경고 → 정상 순 · 소요 초). 결과를 모르면 그 칸은 '—'. */
export function detailSummary(d) {
  const tasks = (Array.isArray(d?.tasks) ? d.tasks : []).map((t) => ({
    ...t, order: RES_ORDER[t.result] ?? 4,
    durSec: typeof t.start === 'number' && typeof t.end === 'number' && t.end >= t.start ? Math.round((t.end - t.start) / 1000) : null,
  })).sort((a, b) => (a.order - b.order) || String(a.vm).localeCompare(String(b.vm)));
  const c = { fail: 0, warn: 0, ok: 0 };
  for (const t of tasks) if (c[t.result] != null) c[t.result]++;
  const head = d?.head || null;
  const parts = [];
  if (head?.end) parts.push(`끝남 ${shortTs(head.end)}`);
  if (Array.isArray(d?.tasks)) parts.push(`VM ${tasks.length}대 — 실패 ${c.fail} · 경고 ${c.warn} · 정상 ${c.ok}`);
  if (d?.cachedAt) parts.push('5분 안에 읽은 값');
  return { tasks, counts: c, line: parts.join(' · ') };
}
/** 상세를 열 수 있는 결과인가(실패·경고 + 세션 UID 가 있을 때만). */
export const canOpenDetail = (result, uid) => (result === 'fail' || result === 'warn') && !!uid;

/* ── v2.798 EM 서버를 포탈 B&R 로 바로 등록 · 백업 서버 수 확인 ───────────── */
/** 등록 양식 처음 값 — 표시명·주소는 EM 이 아는 서버 이름(주소로 쓸 수 있는지는 사람이 확인), 포트는 B&R REST 기본 9419. */
export function brRegisterDraft(row, vcenterIds = []) {
  const name = String(row?.name || '').trim();
  return { name: name.slice(0, 64), host: name, port: '9419', username: '', password: '', vcenterIds: [...vcenterIds] };
}
/** 보내기 전에 막을 것 — 서버(veeam/registry serverInputIssue)가 최종 판정이고, 여기서는 빈 칸만 먼저 알린다. */
export function brRegisterIssue(d) {
  if (!String(d?.name || '').trim()) return '표시명을 입력하세요.';
  if (!String(d?.host || '').trim()) return '주소(IP·호스트 이름)를 입력하세요.';
  if (!String(d?.username || '').trim()) return '접속 계정을 입력하세요.';
  if (!String(d?.password || '')) return '비밀번호를 입력하세요.';
  if (!Array.isArray(d?.vcenterIds) || !d.vcenterIds.length) return '이 서버가 백업하는 vCenter(법인)를 하나 이상 고르세요.';
  return '';
}
/** EM 별 백업 서버 수 — 개요보다 받은 목록이 적은 EM 만 문구로(모르면 말하지 않는다). */
export function serverCountWarnings(counts) {
  return (Array.isArray(counts) ? counts : [])
    .filter((c) => Number.isFinite(c?.overview) && Number.isFinite(c?.merged) && c.merged < c.overview)
    .map((c) => `EM ‘${c.emName}’ — 개요는 백업 서버 ${c.overview}대인데 목록은 ${c.merged}대만 받았습니다${c.viaQuery ? '(질의 서비스로 다시 읽은 뒤)' : ''}. EM 계정의 역할이 일부 서버만 보이게 할 수 있습니다(추정 — EM 에서 그 계정의 역할·범위를 확인하세요).`);
}

/* ── v2.817 EM 연결 현황 — 모든 EM 을 한 표로(EM → 백업 서버 → EM 이 본 vCenter · 포탈 매핑 대조) ── */
export const VC_CHECK = Object.freeze({
  same: { label: '같음', tone: 'ok' }, diff: { label: '다름', tone: 'fail' }, unmapped: { label: '매핑 없음', tone: 'warn' },
  none: { label: 'EM 에 호스트 없음', tone: 'none' }, unknown: { label: '모름', tone: 'none' }, orphan: { label: '목록에 없는 서버', tone: 'warn' },
});
const isVc = (r) => /^(vc|vcenter)/i.test(String(r?.hostType || '').replace(/\s+/g, ''));
/** EM 이 본 호스트 한 개 → 칸 글자 — 포탈 vCenter 로 맞췄으면 그 이름 · VC 인데 못 맞춤 '(포탈에 없음)' · 그 밖은 종류. */
export function rootText(r) {
  if (r?.vcName) return { text: r.vcName, tone: 'ok', inPortal: true };
  if (isVc(r)) return { text: `${r.name} (포탈에 없음)`, tone: 'warn', inPortal: false };
  return { text: `${r?.name || '—'}${r?.hostType ? ` (${r.hostType})` : ''}`, tone: 'none', inPortal: false };
}
const srcText = { manual: '수동', br: 'B&R 등록' };
/**
 * 표 행 — 백업 서버 하나가 한 행. 수집 결과가 없는 EM(실패·수집 전)·서버 목록을 못 읽은 EM·서버가 없는 EM 은 상태 한 행.
 * EM 루트에만 있고 서버 목록에 없는 서버(orphanRoots)도 서버별 한 행으로 보인다(서버가 일부만 보이는 까닭을 찾게).
 */
export function emLinkRows(ems, now = Date.now()) {
  const out = [];
  for (const em of Array.isArray(ems) ? ems : []) {
    const st = statusLine(em?.status, now);
    const base = { emId: em.id, emName: em.name || em.id, statusText: st.text, statusTone: st.tone };
    const d = em?.data || null;
    const servers = d?.backupServers;
    if (!d || !Array.isArray(servers) || !servers.length) {
      out.push({ ...base, key: `${em.id}|-`, server: '', note: !d ? '수집 결과 없음 — 이 EM 의 백업 서버가 보이지 않습니다' : !Array.isArray(servers) ? '백업 서버 목록을 읽지 못했습니다' : 'EM 에 백업 서버가 없습니다', roots: [], portal: null, check: VC_CHECK.unknown, checkKey: 'unknown' });
      continue;
    }
    servers.forEach((s, i) => {
      const ck = s.vcCheck && VC_CHECK[s.vcCheck] ? s.vcCheck : 'unknown';
      // 키에 순번 — 같은 EM 안에 같은 이름의 백업 서버가 있으면 React 키가 겹쳐 정렬 때 행이 늘어났다(Chromium 실측 v2.817)
      out.push({ ...base, key: `${em.id}|${i}|${s.uid || ''}|${s.name}`, server: s.name, note: '',
        roots: Array.isArray(s.roots) ? s.roots.map(rootText) : null,
        portal: s.vcSource ? { text: (s.vcNames || []).join(', ') || '—', source: srcText[s.vcSource] || s.vcSource } : null,
        check: VC_CHECK[ck], checkKey: ck });
    });
    const orph = new Map();
    for (const r of Array.isArray(d.orphanRoots) ? d.orphanRoots : []) { const k = r.server || ''; if (!orph.has(k)) orph.set(k, []); orph.get(k).push(r); }
    for (const [sv, list] of orph) out.push({ ...base, key: `${em.id}|orphan|${sv}`, server: sv || '(서버 모름)', note: '연결 호스트에는 있지만 백업 서버 목록에는 없는 서버', roots: list.map(rootText), portal: null, check: VC_CHECK.orphan, checkKey: 'orphan' });
  }
  return out;
}
/** 요약 수 — EM 수·수집 실패·백업 서버·EM 이 본 vCenter(포탈 vCenter 로 맞춘 것)·포탈에 없는 vCenter 호스트·다름·매핑 없음·루트 모름. */
export function emLinkSummary(ems) {
  const list = Array.isArray(ems) ? ems : [];
  const vcSeen = new Set(); const notIn = new Set();
  let servers = 0; let diff = 0; let unmapped = 0; let rootsUnknown = 0;
  for (const em of list) {
    const s = em?.data?.backupServers;
    if (!Array.isArray(s)) continue;
    if (!em.data.hierarchyRootsKnown) rootsUnknown++;
    servers += s.length;
    for (const x of s) {
      if (x.vcCheck === 'diff') diff++;
      if (x.vcCheck === 'unmapped') unmapped++;
      for (const r of x.roots || []) { if (r.vcenterId) vcSeen.add(r.vcenterId); else if (isVc(r)) notIn.add(String(r.name).toLowerCase()); }
    }
  }
  return { ems: list.length, failed: list.filter((e) => e?.status && e.status.ok === false).length, noData: list.filter((e) => !e?.data).length,
    servers, vcSeen: vcSeen.size, notInPortal: notIn.size, diff, unmapped, rootsUnknown };
}
