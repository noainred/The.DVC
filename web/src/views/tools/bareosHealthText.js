// v2.890 Bareos 사전 점검(docs/design/bareos-precheck) 화면 문구 — 판정은 서버(bareos/health.js judgeCorp) 하나이고 여기는 보이는 글자만 고른다.
// 모름은 0 이 아니다 — 수에 넣지 않고 '모름' 으로 · '정상' 은 백업 성공을 보장하지 않는다(문구가 그 한계를 말한다).
import { numOrNull } from '../../numOrNull.js';

export const HEALTH_BADGE = Object.freeze({
  ok: { text: '정상', tone: 'ok' }, warn: { text: '경고', tone: 'warn' }, bad: { text: '불가', tone: 'bad' },
  unknown: { text: '모름', tone: 'muted' }, info: { text: '참고', tone: 'warn' },
});
export const healthBadge = (s) => HEALTH_BADGE[s] || HEALTH_BADGE.unknown;
export const HEALTH_LIMIT_TEXT = '‘정상’ 은 백업 성공을 보장하지 않습니다 — vCenter 계정 · 권한 · 스냅샷 · 플러그인 오류는 보지 않습니다.';

export function fmtBytes(n) {
  const v0 = numOrNull(n);
  if (v0 === null || v0 < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let v = v0; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** 법인 판정 수(모름은 따로) — corps 는 GET /health 의 corps. */
export function healthCounts(corps) {
  const n = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const c of Array.isArray(corps) ? corps : []) n[c?.verdict in n ? c.verdict : 'unknown'] += 1;
  return n;
}

const item = (c, key) => (Array.isArray(c?.items) ? c.items.find((x) => x?.key === key) : null) || null;

/** 표의 '사전 점검' 칸 — 가장 나쁜 항목의 짧은 글. 점검 기록이 없으면 null(칸은 '—'). */
export function healthCell(c) {
  if (!c) return null;
  const order = { bad: 0, warn: 1, info: 2, unknown: 3, ok: 4 };
  const worst = (c.items || []).filter((x) => x.status === 'bad' || x.status === 'warn').sort((a, b) => order[a.status] - order[b.status])[0];
  if (c.verdict === 'ok') return { ...healthBadge('ok'), detail: `${whenShort(c.at)}${c.from === 'central' ? ' · 중앙에서' : ''}` };
  if (worst) return { ...healthBadge(c.verdict), detail: `${worst.label} — ${String(worst.detail || '').slice(0, 80)}` };
  const why = (c.items || []).find((x) => x.status === 'unknown')?.detail || '점검하지 못했습니다';
  return { ...healthBadge(c.verdict), detail: String(why).slice(0, 80) };
}

/** 표의 'SD 디스크 여유' 칸 — 첫 경로. 못 읽었으면 null('—'). */
export function diskCell(c) {
  const d = item(c, 'disk');
  const x = d?.disks?.find((y) => y && y.availBytes != null && y.sizeBytes != null);
  if (!x) return null;
  return { tone: x.status === 'bad' ? 'bad' : x.status === 'warn' ? 'warn' : '', avail: fmtBytes(x.availBytes), size: fmtBytes(x.sizeBytes), days: x.daysLeft == null ? null : Math.round(x.daysLeft), pct: x.pct };
}

/** 경고 띠 — 불가 법인과 그 첫 불가 항목(이름 순). */
export function healthBand(corps, nameOf = (id) => id) {
  return (Array.isArray(corps) ? corps : []).filter((c) => c?.verdict === 'bad')
    .map((c) => { const x = (c.items || []).find((i) => i.status === 'bad'); return { vcenterId: c.vcenterId, name: nameOf(c.vcenterId), label: x?.label || '', detail: String(x?.detail || '').slice(0, 120) }; })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function whenShort(at) {
  const t = numOrNull(at);
  if (t === null || t <= 0) return '—';
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const fromText = (from) => (from === 'edge' ? '엣지 노드에서' : from === 'central' ? '중앙에서(FD 시점 아님)' : '—');

/** 디스크 사용량 추이 → SVG polyline 점(사용률 0~100% 를 높이로). 표본 2개 미만이면 ''. */
export function sparkPoints(samples, w = 180, h = 36) {
  const pts = (Array.isArray(samples) ? samples : []).filter((x) => numOrNull(x?.used) !== null && numOrNull(x?.size) > 0);
  if (pts.length < 2) return '';
  const step = (w - 4) / (pts.length - 1);
  return pts.map((x, i) => `${(2 + i * step).toFixed(1)},${(h - 2 - (x.used / x.size) * (h - 4)).toFixed(1)}`).join(' ');
}

/** 설정 폼 → 서버 본문(숫자 칸은 수로 · 빈 칸은 그대로 두어 서버가 거부). */
export function healthSettingsBody(f) {
  const n = (v) => (v === '' || v == null ? v : Number(v));
  return {
    enabled: !!f.enabled, time: String(f.time || '').trim(),
    disk: { warnPct: n(f.warnPct), warnDays: n(f.warnDays), badPct: n(f.badPct), badDays: n(f.badDays) },
    mail: { onWorse: !!f.onWorse, onRecover: !!f.onRecover, inDigest: !!f.inDigest },
  };
}
export const healthSettingsForm = (c) => ({
  enabled: c?.enabled !== false, time: c?.time || '20:00',
  warnPct: c?.disk?.warnPct ?? 15, warnDays: c?.disk?.warnDays ?? 14, badPct: c?.disk?.badPct ?? 5, badDays: c?.disk?.badDays ?? 3,
  onWorse: c?.mail?.onWorse !== false, onRecover: c?.mail?.onRecover !== false, inDigest: c?.mail?.inDigest !== false,
});

export function lastRunText(last) {
  if (!last || !numOrNull(last.at)) return '아직 돌지 않았습니다';
  const sec = numOrNull(last.endedAt) && numOrNull(last.at) ? Math.max(0, Math.round((last.endedAt - last.at) / 1000)) : null;
  return `${whenShort(last.at)} · Director ${last.directors ?? '—'}곳 · 회신 ${last.ok ?? '—'} · 못 받음 ${last.failed ?? '—'}${sec != null ? ` · ${sec}초` : ''}${last.trigger === 'manual' ? ' · 지금 점검' : ''}`;
}
