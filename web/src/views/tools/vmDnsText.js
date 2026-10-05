/**
 * vmDnsText.js — 'VM DNS 설정 확인'(도구 키 `vm-dns`) 화면의 판정 표지·문구(순수, v2.696).
 *
 * 판정(정체·정책·불일치·다른 법인)은 **서버**(`server/src/vmdns/analyze.js`)가 한다. 여기는 그 결과를
 * **보여 주는 방법**만 갖는다 — 판정을 다시 하지 않는다(같은 판정을 두 곳이 가지면 갈라진다).
 *  · 값이 없으면 '—' 이고 단위를 붙이지 않는다(v2.575 unitText 규약).
 *  · '모름'(Tools 가 DNS 를 보고하지 않음)과 '미수집'(그 VM 을 보낸 수집기가 2.695 이전)은 정상에도 0 에도 넣지 않는다 — 따로 센다.
 *  · KPI 0 을 경고색으로 칠하지 않는다(숫자는 '문제 없음' 이라 하는데 색이 '문제 있음' 이라 말하게 된다 — v2.556).
 *  · 정체를 모르는 주소는 '대장에 없음' 이라 말하고 지어내지 않는다.
 *  · 문구에 백틱을 쓰지 않는다(BoldText 는 강조 표시만 해석한다 — 값 인용은 홑화살괄호).
 *
 * 순수 모듈이다 — React·api.js 를 import 하지 않는다(vitest 가 node 환경이라).
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';
import { agoText } from './relTime.js';

export const TABS = Object.freeze(['overview', 'server', 'policy', 'changes']);
export const TAB_LABEL = Object.freeze({ overview: '개요', server: 'DNS 서버 상세', policy: '정책 · 도달성', changes: '변경 이력' });

/** 숫자 → '1,234'. 못 읽은 값은 '—'(0 이 아니다). */
export function nText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : Math.round(n).toLocaleString('en-US');
}

/** 시각(epoch ms 숫자 또는 ISO 문자열) → epoch ms. 숫자 문자열은 Date.parse 에 넘기지 않는다(v2.562 — '12345' 가 연도가 된다). */
export function tsMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  if (/^\d+$/.test(v.trim())) { const n = Number(v); return n > 0 ? n : null; }
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:mm'(브라우저 시간대 = 사용자). 못 읽으면 '—'. */
export function dateTimeText(v) {
  const t = tsMs(v);
  if (t == null) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 변경 시각 — 하루 안이면 '3시간 전', 그보다 오래면 날짜·시각. */
export function whenText(v, now = Date.now()) {
  const t = tsMs(v);
  if (t == null) return '—';
  if (now - t < 86_400_000) return agoText(t, now);
  return dateTimeText(t);
}

/** IPv4 문자열 → 정렬용 숫자(못 읽으면 null — 정렬에서 뒤로). */
export function ipSortKey(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? '').trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

/** 주소 목록 → 'a, b'. 빈 목록은 '(DNS 없음)' — 모름(null)과 구분한다. */
export function ipsText(list) {
  if (!Array.isArray(list)) return '—';
  const xs = list.filter((x) => typeof x === 'string' && x.trim());
  return xs.length ? xs.join(', ') : '(DNS 없음)';
}

// ── 정체(kind) · 정책(policy) 표지 ────────────────────────────────────────────
export const KIND_LABEL = Object.freeze({ vm: 'VM', host: 'ESXi 호스트', public: '공인', unknown: '대장에 없음' });
export const KIND_BADGE = Object.freeze({ vm: 'blue', host: 'teal', public: 'red', unknown: 'gray' });
export const kindLabel = (k) => KIND_LABEL[k] || '확인 불가';
export const kindBadge = (k) => KIND_BADGE[k] || 'gray';

export const POLICY_LABEL = Object.freeze({ approved: '승인', unapproved: '비승인', mixed: '법인마다 다름', none: '정책 없음' });
export const POLICY_BADGE = Object.freeze({ approved: 'green', unapproved: 'amber', mixed: 'amber', none: 'gray' });
export const policyLabel = (p) => POLICY_LABEL[p] || '확인 불가';
export const policyBadge = (p) => POLICY_BADGE[p] || 'gray';

/** 서버 정책 칸의 설명(title) — '정책 없음' 이 '승인' 으로 읽히지 않게. */
export const POLICY_TITLE = Object.freeze({
  approved: '이 주소를 쓰는 VM 의 법인 정책에 들어 있습니다',
  unapproved: '이 주소를 쓰는 법인 정책 밖입니다(또는 공인 DNS 를 비승인으로 정했습니다)',
  mixed: '어떤 법인에서는 승인, 어떤 법인에서는 비승인입니다 — 상세에서 VM 별 판정을 보세요',
  none: '이 주소를 쓰는 법인에 승인 목록이 없어 판정하지 않았습니다(위반으로 세지 않습니다)',
});

/** 범위 밖 소유자 가림 표지(서버 계약: who = { label:'다른 법인 VM', name:null, vcenterId:null }). */
export function isMaskedWho(who) {
  return !!who && typeof who === 'object' && !who.name && !who.vcenterId && typeof who.label === 'string' && !!who.label;
}

/** 서버 주소의 정체 문장(표·머리 카드). 모르는 것은 모른다고 말한다. */
export function whoText(s) {
  if (!s || typeof s !== 'object') return '—';
  const who = s.who && typeof s.who === 'object' ? s.who : null;
  const owners = numOrNull(s.owners);
  const more = owners != null && owners > 1 ? ` 외 ${owners - 1}대` : '';
  if (s.kind === 'public') return s.publicName || '공인 주소(알려진 공인 DNS 아님)';
  if (s.kind === 'unknown') return '등록·스캔 기록 없음';
  if (!who) return '—';
  if (isMaskedWho(who)) return `${who.label}${more}`;
  const place = who.vcenterName || who.vcenterId || '';
  const name = who.name || who.label || '—';
  const head = s.kind === 'host' ? `ESXi ${name}` : name;
  return `${head}${place ? ` · ${place}` : ''}${more}`;
}

// ── 도달성(53) ───────────────────────────────────────────────────────────────
const ERR_TEXT = {
  timeout: '시한 초과', refused: '거부', econnrefused: '거부', unreachable: '도달 불가', reset: '끊김',
  closed: '연결 닫힘', 'bad-response': 'DNS 응답 아님', 'too-large': '응답 과대', error: '오류',
};
/** 점검하지 않은 사유(서버 probe.js skip) — 실패로 세지 않는다. */
export const SKIP_TEXT = Object.freeze({
  mock: '데모 vCenter 만 사용 — 점검하지 않음',
  local: '루프백·링크 로컬 등 — 중앙에서 물으면 중앙 자신의 값이라 점검하지 않음',
  cap: '대상 상한을 넘어 이번에 점검하지 않음',
  budget: '시간 예산을 넘어 이번에 점검하지 않음(다시 누르면 다시 잽니다)',
});
export const skipText = (why) => SKIP_TEXT[why] || (why ? `점검하지 않음(${why})` : '점검하지 않음');
function legText(leg, name) {
  if (!leg || typeof leg !== 'object') return null;
  if (leg.ok === true) {
    const ms = unitText(numOrNull(leg.ms), 'ms');
    const rc = leg.rcode != null && leg.rcode !== 0 && leg.rcode !== 'NOERROR' && leg.rcode !== '' ? ` · rcode ${leg.rcode}` : '';
    return `${name} ${ms === '—' ? '응답' : ms}${rc}`;
  }
  if (leg.ok === false) {
    const e = String(leg.error || '').trim();
    return `${name} ${ERR_TEXT[e.toLowerCase()] || e || '응답 없음'}`;
  }
  return null;
}

/**
 * 마지막 도달성 점검 → { text, tone, where }. tone: ok | bad | muted.
 * ⚠ 엣지만 쓰는 사내 DNS 는 중앙에서 닿지 않는 것이 정상일 수 있다 — 'edge-only' 는 실패가 아니다(muted).
 * ⚠ 응답 패킷을 받으면 rcode 와 무관하게 '응답' 이다(서버 계약).
 */
export function reachText(probe) {
  if (!probe || typeof probe !== 'object') return { text: '점검 안 함', tone: 'muted', where: '' };
  if (probe.where === 'edge-only') return { text: '중앙에서 못 잼', tone: 'muted', where: '엣지 법인만 사용 — 실패로 세지 않습니다' };
  if (probe.skipped) return { text: '건너뜀', tone: 'muted', where: skipText(probe.skipped) };
  const parts = [legText(probe.udp, 'udp'), legText(probe.tcp, 'tcp')].filter(Boolean);
  const any = probe.udp?.ok === true || probe.tcp?.ok === true;
  const measured = probe.udp?.ok === false || probe.tcp?.ok === false || any;
  const tone = any ? 'ok' : measured ? 'bad' : 'muted';
  return { text: parts.length ? parts.join(' · ') : '결과 없음', tone, where: probe.where === 'central' ? '중앙에서' : '' };
}

/** 질의 이름 — '.' 은 루트 NS 질의(도메인을 모를 때). */
export function qnameText(q) {
  if (q == null || q === '') return '—';
  return q === '.' ? '루트(NS)' : String(q);
}

/** 점검 요약의 건너뜀 사유 분해 — '데모 3 · 시간 예산 2'. 없으면 ''. */
export function skippedByText(summary) {
  const by = summary && typeof summary.skippedBy === 'object' && summary.skippedBy ? summary.skippedBy : {};
  const label = { mock: '데모', local: '로컬 주소', cap: '상한 초과', budget: '시간 예산' };
  return Object.entries(by).map(([k, v]) => [k, numOrNull(v)]).filter(([, v]) => v != null && v > 0)
    .map(([k, v]) => `${label[k] || k} ${nText(v)}`).join(' · ');
}

export const TONE_COLOR = Object.freeze({ ok: 'var(--green)', bad: 'var(--red)', warn: 'var(--amber)', muted: 'var(--text-dim)', info: 'var(--accent)' });

/** 도달성 점검 요약 카드 — 0 은 경고색이 아니다. summary 가 없으면 '—'. */
export function probeSummaryCards(summary) {
  const s = summary && typeof summary === 'object' ? summary : null;
  const card = (key, label, tone) => {
    const v = s ? numOrNull(s[key]) : null;
    return { key, label, value: nText(v), tone: v != null && v > 0 ? tone : 'muted' };
  };
  return [card('answered', '응답', 'ok'), card('failed', '응답 없음', 'bad'), card('edgeOnly', '중앙에서 못 잼', 'muted'), card('skipped', '건너뜀', 'muted')];
}

// ── KPI ──────────────────────────────────────────────────────────────────────
/**
 * KPI 카드 목록. tone 은 값이 0 보다 클 때만 경고색이다.
 * @param {object} kpis 서버 kpis
 * @param {{ vcCount?: number, publicUnapproved?: boolean|null }} [ctx]
 */
export function kpiCards(kpis, ctx = {}) {
  // 첫 인벤토리 병합 전(골격 스냅샷)에는 0 이 아니라 '아직 모름' 이다(v2.675 규약) — 값을 비운다.
  const k = kpis && typeof kpis === 'object' && ctx.initial !== true ? kpis : {};
  const n = (key) => numOrNull(k[key]);
  const tone = (v, t) => (v != null && v > 0 ? t : 'plain');
  const vms = n('vms');
  const reported = n('reported');
  const pct = vms && reported != null ? Math.round((reported / vms) * 100) : null;
  const byKind = k.serversByKind && typeof k.serversByKind === 'object' ? k.serversByKind : {};
  const kindParts = ['vm', 'host', 'public', 'unknown']
    .map((x) => [KIND_LABEL[x], numOrNull(byKind[x])])
    .filter(([, v]) => v != null && v > 0)
    .map(([l, v]) => `${l} ${nText(v)}`);
  const corps = numOrNull(k.policyCorps);
  const pubRule = ctx.publicUnapproved === true ? ' + 공인 DNS 규칙' : '';
  const unapprovedSub = corps != null && corps > 0
    ? `정책이 있는 법인 ${nText(corps)}곳${pubRule} 기준`
    : ctx.publicUnapproved === true ? '법인 정책 없음 — 공인 DNS 규칙만 판정' : '정책 없음 — 판정하지 않았습니다';
  const vcCount = numOrNull(ctx.vcCount);
  return [
    { key: 'vms', label: '조사한 VM', value: nText(vms), dot: 'var(--accent)', tone: 'plain',
      sub: `템플릿 제외 · 켜짐·꺼짐 포함${vcCount != null ? ` · vCenter ${nText(vcCount)}개` : ''}` },
    { key: 'reported', label: 'DNS 보고', value: nText(reported), dot: 'var(--mint)', tone: 'plain',
      sub: pct != null ? `${pct}% · 나머지는 모름·미수집` : 'VMware Tools 가 보고한 VM' },
    { key: 'servers', label: '고유 DNS 서버', value: nText(n('servers')), dot: 'var(--accent-2)', tone: 'plain',
      sub: kindParts.length ? kindParts.join(' · ') : '쓰는 주소 없음' },
    { key: 'unapprovedVms', label: '비승인 DNS 사용', value: nText(n('unapprovedVms')), dot: 'var(--amber)', tone: tone(n('unapprovedVms'), 'warn'), sub: unapprovedSub },
    { key: 'publicVms', label: '공인 DNS 사용', value: nText(n('publicVms')), dot: 'var(--red)', tone: tone(n('publicVms'), 'bad'), sub: '8.8.8.8 · 통신사 DNS 등 외부 주소' },
    { key: 'mismatchVms', label: 'NIC ≠ OS 불일치', value: nText(n('mismatchVms')), dot: 'var(--purple)', tone: tone(n('mismatchVms'), 'purple'), sub: 'NIC 설정과 OS 실제 값이 다름' },
    { key: 'unknown', label: '모름', value: nText(n('unknown')), dot: 'var(--text-faint)', tone: 'plain', sub: 'Tools 미보고 — 정상도 0 도 아님' },
    { key: 'notCollected', label: '미수집', value: nText(n('notCollected')), dot: 'var(--text-faint)', tone: 'plain', sub: '보낸 수집기가 2.695 이전(엣지 업그레이드 필요)' },
  ];
}
export const KPI_TONE_COLOR = Object.freeze({ plain: 'var(--text)', warn: 'var(--amber)', bad: 'var(--red)', purple: 'var(--purple)' });

// ── vCenter 칩 ───────────────────────────────────────────────────────────────
/** vCenter 칩 — '전체' + vCenter 별(VM 수). title 에 보고·모름·미수집을 밝힌다. */
export function vcChips(vcenters, selected = '') {
  const list = (Array.isArray(vcenters) ? vcenters : []).filter((v) => v && typeof v === 'object' && v.id);
  let total = 0; let anyTotal = false;
  const chips = list.map((v) => {
    const vms = numOrNull(v.vms);
    if (vms != null) { total += vms; anyTotal = true; }
    return {
      id: String(v.id), label: v.name || v.id, n: nText(vms), active: String(v.id) === String(selected || ''),
      title: `보고 ${nText(v.reported)} · 모름 ${nText(v.unknown)} · 미수집 ${nText(v.notCollected)}${v.collect === 'site' ? ' · 엣지 수집' : v.collect === 'direct' ? ' · 중앙 직접 수집' : ''}${v.rest ? ' · REST 폴백' : ''}`,
    };
  });
  return [{ id: '', label: '전체', n: anyTotal ? nText(total) : '—', active: !selected, title: '조회 범위의 모든 vCenter' }, ...chips];
}

// ── 빈 상태 사유 ─────────────────────────────────────────────────────────────
/**
 * DNS 서버 목록이 비어 있을 때 '왜' — 기다리면 되는지·조치가 필요한지 다르다.
 * @returns {{ text: string, tone: 'info'|'warn' } | null} 서버가 있으면 null
 */
export function emptyReason(data) {
  if (!data || typeof data !== 'object') return null;
  const servers = Array.isArray(data.servers) ? data.servers : [];
  if (servers.length) return null;
  if (data.initial === true) return { text: '첫 인벤토리 수집 중입니다 — 아직 VM 이 없는 것이 아니라 비어 있는 것입니다. 잠시 뒤 새로고침하세요.', tone: 'info' };
  const k = data.kpis || {};
  const vms = numOrNull(k.vms);
  const reported = numOrNull(k.reported) ?? 0;
  const unknown = numOrNull(k.unknown) ?? 0;
  const notCol = numOrNull(k.notCollected) ?? 0;
  const vcs = Array.isArray(data.vcenters) ? data.vcenters.length : 0;
  if (!vcs && !vms) return { text: '조회할 vCenter 가 없습니다 — 등록된 vCenter 가 없거나 첫 수집 중입니다.', tone: 'info' };
  if (!vms) return { text: '템플릿을 뺀 VM 이 없습니다 — 첫 수집 중이면 잠시 뒤 새로고침하세요.', tone: 'info' };
  if (reported > 0) return { text: `VM ${nText(reported)}대가 DNS 설정을 보고했지만 서버 주소가 비어 있습니다 — 게스트에 DNS 가 설정되지 않았을 수 있습니다(추정).`, tone: 'warn' };
  if (notCol > 0 && notCol >= vms) return { text: `VM ${nText(vms)}대 전부 미수집입니다 — 이 VM 들을 보낸 수집기(엣지)가 2.695 이전이라 DNS 를 보내지 않습니다. 기다려도 채워지지 않습니다 — 엣지를 업그레이드하세요.`, tone: 'warn' };
  if (unknown > 0 && unknown >= vms) return { text: `VM ${nText(vms)}대 전부 모름입니다 — VMware Tools 가 DNS 를 보고하지 않았습니다(Tools 꺼짐·미설치·구버전일 수 있습니다 — 추정).`, tone: 'warn' };
  return { text: `DNS 를 보고한 VM 이 없습니다 — 모름 ${nText(unknown)}대 · 미수집 ${nText(notCol)}대.`, tone: 'warn' };
}

// ── 표·매트릭스 ──────────────────────────────────────────────────────────────
/** 쓰는 법인 칸 — 이름 2개까지 + '외 N곳'. */
export function corpsText(corps, max = 2) {
  const list = (Array.isArray(corps) ? corps : []).filter((c) => c && typeof c === 'object');
  if (!list.length) return '—';
  const names = list.map((c) => c.name || c.id || '—');
  if (names.length <= max) return names.join(' · ');
  return `${names.slice(0, max).join(' · ')} 외 ${names.length - max}곳`;
}

/** 사용 VM 막대 폭(%) — 최대 대비. 0·못 읽음은 0, 그 밖은 최소 3. */
export function barPct(v, max) {
  const x = numOrNull(v); const m = numOrNull(max);
  if (x == null || !m || x <= 0) return 0;
  return Math.max(3, Math.min(100, Math.round((x / m) * 100)));
}

/** 표 아래 문구 — 서버가 상한으로 자른 주소 수를 밝힌다. */
export function serversFootText(data, shown) {
  const total = numOrNull(data?.serversTotal);
  const listed = Array.isArray(data?.servers) ? data.servers.length : 0;
  const omitted = numOrNull(data?.serversOmitted);
  const head = total != null ? `주소 ${nText(total)}개 중 ${nText(shown ?? listed)}개 표시` : `주소 ${nText(shown ?? listed)}개 표시`;
  const cut = omitted != null && omitted > 0 ? ` · 사용 VM 이 적은 ${nText(omitted)}개는 서버 상한으로 목록에서 뺐습니다(CSV 에는 VM 단위로 전부 있습니다)` : '';
  return head + cut;
}

const TONE_VAR = Object.freeze({ ok: 'var(--accent)', bad: 'var(--red)', other: 'var(--amber)', none: 'var(--text-dim)', mixed: 'var(--text-dim)' });
export const MATRIX_LEGEND = Object.freeze([
  { tone: 'ok', label: '승인 DNS' },
  { tone: 'bad', label: '비승인·공인' },
  { tone: 'other', label: '다른 법인의 DNS' },
  { tone: 'none', label: '정책 없음·법인마다 다름' },
]);

/** 칸 색 강도(0~0.9) — 그 법인 안에서의 비중. 0 이면 0(빈 칸). */
export function cellAlpha(v, total) {
  const x = numOrNull(v);
  if (x == null || x <= 0) return 0;
  const t = numOrNull(total);
  const ratio = t && t > 0 ? Math.min(1, x / t) : 1;
  return Math.min(0.9, 0.18 + ratio * 0.8);
}

/** 톤 + 강도 → 칸 배경(테마 토큰만 — 새 hex 를 만들지 않는다). */
export function cellBg(tone, alpha) {
  if (!(alpha > 0)) return 'var(--panel-deep)';
  const pct = Math.round(alpha * 100);
  return `color-mix(in srgb, ${TONE_VAR[tone] || TONE_VAR.none} ${pct}%, transparent)`;
}
export const legendBg = (tone) => cellBg(tone, 0.6);

/** 열(서버) 기본 톤. 공인·비승인 → bad, 승인 → ok, 법인마다 다름 → mixed, 정책 없음 → none. */
export function colTone(col) {
  if (!col || typeof col !== 'object') return 'none';
  if (col.kind === 'public' || col.policy === 'unapproved') return 'bad';
  if (col.policy === 'approved') return 'ok';
  if (col.policy === 'mixed') return 'mixed';
  return 'none';
}

/**
 * 그 칸의 서버가 그 행(법인)의 것이 아닌가. 소유자 vCenter 를 알면 비교하고, 범위 밖이라 가린 소유자는
 * 다른 법인이다(범위 안 행과 같을 수 없다). 소유자를 모르면(공인·대장에 없음) false.
 */
export function isOtherCorp(server, rowVcId) {
  const who = server?.who;
  if (!who || typeof who !== 'object') return false;
  if (server.kind !== 'vm' && server.kind !== 'host') return false;
  if (who.vcenterId) return String(who.vcenterId) !== String(rowVcId);
  return isMaskedWho(who);
}

/** 칸 톤 — 공인은 늘 bad, 그다음 다른 법인(amber), 그다음 열 정책. */
export function cellTone(col, rowVcId, server) {
  if (col?.kind === 'public') return 'bad';
  if (isOtherCorp(server, rowVcId)) return 'other';
  return colTone(col);
}

/** 열 머리 표기 — 길면 줄인다(title 에 원문). */
export function shortIp(ip, max = 13) {
  const s = String(ip ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 매트릭스 화면 모델. 열 = 서버 상위 N + '기타'.
 * @returns {{ cols: Array, rows: Array, empty: boolean }}
 */
export function matrixView(matrix, servers) {
  const byIp = new Map((Array.isArray(servers) ? servers : []).filter((s) => s && s.ip).map((s) => [s.ip, s]));
  const cols = (Array.isArray(matrix?.cols) ? matrix.cols : []).filter((c) => c && typeof c === 'object').map((c) => {
    const s = byIp.get(c.ip);
    return { ip: c.ip, label: shortIp(c.ip), title: `${c.ip} — ${kindLabel(c.kind)} · ${policyLabel(c.policy)}${s ? ` · ${whoText(s)}` : ''}`, tone: colTone(c), kind: c.kind, policy: c.policy };
  });
  const rows = (Array.isArray(matrix?.rows) ? matrix.rows : []).filter((r) => r && typeof r === 'object').map((r) => {
    const cells = Array.isArray(r.cells) ? r.cells : [];
    const sum = cells.reduce((a, v) => a + (numOrNull(v) || 0), 0) + (numOrNull(r.other) || 0);
    const total = numOrNull(r.total) || sum;
    const mk = (v, tone, title) => {
      const x = numOrNull(v);
      const a = cellAlpha(x, total);
      return { v: x, text: x == null ? '—' : x === 0 ? '·' : nText(x), bg: cellBg(tone, a), strong: a > 0, tone, title };
    };
    const out = cols.map((c, i) => {
      const tone = cellTone(c, r.vcenterId, byIp.get(c.ip));
      return mk(cells[i], tone, `${r.name || r.vcenterId} → ${c.ip}: ${nText(cells[i])}대${tone === 'other' ? ' · 다른 법인의 DNS' : ''}`);
    });
    out.push(mk(r.other, 'none', `${r.name || r.vcenterId} → 상위 ${cols.length}개 밖의 주소: ${nText(r.other)}대`));
    return { vcenterId: r.vcenterId, name: r.name || r.vcenterId || '—', total, cells: out };
  });
  return { cols, rows, empty: !cols.length || !rows.length };
}

/** 도메인·검색 접미사 막대 목록(상위 n). */
export function barList(items, n = 6) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === 'object' && x.name != null).slice(0, n);
  const max = list.reduce((m, x) => Math.max(m, numOrNull(x.vms) || 0), 0);
  return list.map((x) => ({ name: String(x.name), text: nText(x.vms), pct: barPct(x.vms, max) }));
}

/** 설정 방식 분할(고정·DHCP). 둘 다 모르면 null. */
export function modeSplit(kpis) {
  const st = numOrNull(kpis?.staticVms);
  const dh = numOrNull(kpis?.dhcpVms);
  if (st == null && dh == null) return null;
  const base = (st || 0) + (dh || 0);
  return { static: st, dhcp: dh, base, staticText: nText(st), dhcpText: nText(dh), baseText: nText(base) };
}

/** 정합성 점검 3줄 — 0 이면 중립색. */
export function checkRows(checks) {
  const c = checks && typeof checks === 'object' ? checks : {};
  const row = (key, label, sub, tone) => {
    const v = numOrNull(c[key]);
    return { key, label, sub, n: nText(v), tone: v != null && v > 0 ? tone : 'plain' };
  };
  return [
    row('mismatch', 'NIC 설정 ≠ OS 실제 DNS', '어댑터에 넣은 값과 OS 가 쓰는 값이 다름', 'purple'),
    row('otherCorp', '다른 법인 DNS 사용', '같은 회선이 아니면 해석 지연·장애 전파', 'warn'),
    row('singleDns', 'DNS 1개만 설정', '그 서버가 내려가면 이름 해석이 멈춤', 'neutral'),
  ];
}

// ── 변경 이력 ────────────────────────────────────────────────────────────────
export const CHANGE_TONE = Object.freeze({
  bad: { label: '공인 DNS 로', color: 'var(--red)' },
  good: { label: '공인 DNS 를 뺌', color: 'var(--green)' },
  warn: { label: '대장에 없는 주소로', color: 'var(--amber)' },
  info: { label: '변경', color: 'var(--accent)' },
  first: { label: '첫 관측', color: 'var(--text-faint)' },
});

/**
 * 변경 한 건의 톤. kindOf(ip) 는 지금 쓰이는 서버 목록에서 찾은 정체(없으면 null — 지금 아무도 쓰지 않는 주소는 판정하지 않는다).
 */
export function changeTone(ch, kindOf = () => null) {
  if (!ch || typeof ch !== 'object') return 'info';
  if (ch.first) return 'first';
  const before = Array.isArray(ch.before) ? ch.before : [];
  const after = Array.isArray(ch.after) ? ch.after : [];
  const pub = (ip) => kindOf(ip) === 'public';
  if (after.some(pub) && !before.some(pub)) return 'bad';
  if (before.some(pub) && !after.some(pub)) return 'good';
  if (after.some((ip) => !before.includes(ip) && kindOf(ip) === 'unknown')) return 'warn';
  return 'info';
}

/** 변경 이력 빈 상태 / 사용 불가 문구. */
export function changesNote(resp, days) {
  if (!resp || typeof resp !== 'object') return null;
  if (resp.available === false) return { tone: 'warn', text: `변경 이력 저장소를 쓸 수 없습니다 — 기록이 없다는 뜻이 아닙니다${resp.reason ? `(${String(resp.reason).slice(0, 160)})` : '(서버 DB 를 열지 못했습니다)'}.` };
  const list = Array.isArray(resp.changes) ? resp.changes : Array.isArray(resp.recent) ? resp.recent : [];
  if (!list.length) return { tone: 'info', text: `${days ? `최근 ${days}일 동안 ` : ''}바뀐 DNS 설정이 없습니다 — 첫 관측은 변경으로 기록하지 않고, 이력은 이 기능이 수집을 시작한 뒤부터 쌓입니다.` };
  return null;
}

/** 변경 이력 수집 상태 한 줄(서버 history) — 주기·보관·마지막 기록·쉬는 사유. 숫자를 박지 않는다(서버 값만). */
export function historyNote(h, now = Date.now()) {
  if (!h || typeof h !== 'object') return '';
  const parts = [];
  const iv = numOrNull(h.intervalMs);
  if (iv != null && iv > 0) parts.push(`기록 주기 ${iv >= 3_600_000 ? `${Math.round(iv / 3_600_000)}시간` : `${Math.max(1, Math.round(iv / 60_000))}분`}`);
  const rd = numOrNull(h.retentionDays);
  if (rd != null) parts.push(rd === 0 ? '보관 기한 없음' : `보관 ${nText(rd)}일`);
  const t = tsMs(h.lastRunAt);
  parts.push(t ? `마지막 기록 확인 ${agoText(t, now)}` : '아직 기록을 확인하지 않았습니다');
  if (h.idleReason) parts.push(String(h.idleReason).slice(0, 160));
  return parts.join(' · ');
}

// ── DNS 서버 상세(VM 목록) ────────────────────────────────────────────────────
export const FLAG_LABEL = Object.freeze({ public: '공인 DNS', unapproved: '비승인', 'other-corp': '다른 법인 DNS', mismatch: 'NIC ≠ OS', single: 'DNS 1개' });
export const FLAG_BADGE = Object.freeze({ public: 'red', unapproved: 'amber', 'other-corp': 'amber', mismatch: 'purple', single: 'gray' });
const FLAG_ORDER = ['public', 'unapproved', 'other-corp', 'mismatch', 'single'];

/** 판정 표지 칩(순서 고정). 모르는 표지도 버리지 않고 원문 그대로 회색으로 보인다. */
export function flagChips(flags) {
  const list = (Array.isArray(flags) ? flags : []).filter((f) => typeof f === 'string' && f);
  const uniq = [...new Set(list)];
  uniq.sort((a, b) => {
    const ia = FLAG_ORDER.indexOf(a); const ib = FLAG_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return uniq.map((f) => ({ key: f, label: FLAG_LABEL[f] || f, badge: FLAG_BADGE[f] || 'gray' }));
}

/** VM 이 쓰는 서버 목록 — OS 실제 값이 있으면 그것, 없으면 NIC 설정. */
export function vmServerList(vm) {
  if (Array.isArray(vm?.servers) && vm.servers.length) return vm.servers;   // 서버가 정한 '쓰는 서버' 목록(OS 먼저)
  const os = Array.isArray(vm?.osServers) ? vm.osServers : [];
  if (os.length) return os;
  return Array.isArray(vm?.nicServers) ? vm.nicServers : [];
}
/** 이 서버를 첫 DNS 로 쓰는가 — position 의 기준(0/1)에 기대지 않고 목록에서 직접 본다. */
export const isFirstFor = (vm, ip) => vmServerList(vm)[0] === ip;
// 포탈 스냅샷은 POWERED_ON/POWERED_OFF/SUSPENDED(밑줄)이고, vSphere API 원문은 poweredOn 이다 — 둘 다 받는다.
//   (v2.696 Chromium 검증에서 밑줄형을 못 읽어 전원 칸이 전부 '—'·'켜짐 0' 이던 것을 잡았다.)
const normPower = (ps) => String(ps || '').replace(/_/g, '').toLowerCase();
export const isPoweredOn = (ps) => { const s = normPower(ps); return s === 'poweredon' || s === 'on'; };
export function powerText(ps) {
  const s = normPower(ps);
  if (s === 'poweredon' || s === 'on') return { text: '켜짐', badge: 'green' };
  if (s === 'poweredoff' || s === 'off') return { text: '꺼짐', badge: 'gray' };
  if (s === 'suspended') return { text: '일시중지', badge: 'gray' };
  return { text: '—', badge: '' };
}
export const modeText = (dhcp) => (dhcp === true ? 'DHCP' : dhcp === false ? '고정' : '—');

export const SERVER_FILTERS = Object.freeze([
  ['all', '전체'], ['on', '켜짐'], ['first', '첫 DNS 로 사용'], ['mismatch', 'NIC ≠ OS'],
  ['dhcp', 'DHCP'], ['single', 'DNS 1개만'], ['unapproved', '비승인'], ['other-corp', '다른 법인'],
]);

export function vmMatches(vm, filter, ip) {
  if (!vm || typeof vm !== 'object') return false;
  const flags = Array.isArray(vm.flags) ? vm.flags : [];
  switch (filter) {
    case 'on': return isPoweredOn(vm.powerState);
    case 'first': return isFirstFor(vm, ip);
    case 'dhcp': return vm.dhcp === true;
    case 'mismatch': case 'single': case 'unapproved': case 'other-corp': return flags.includes(filter);
    default: return true;
  }
}
export function filterCounts(vms, ip) {
  const list = Array.isArray(vms) ? vms : [];
  return Object.fromEntries(SERVER_FILTERS.map(([k]) => [k, list.filter((v) => vmMatches(v, k, ip)).length]));
}
/** VM 검색 — 이름·vCenter·도메인·주소(대소문자 무시, 공백으로 나눈 단어 AND). */
export function searchVms(vms, q) {
  const list = Array.isArray(vms) ? vms : [];
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return list;
  return list.filter((v) => {
    const hay = [v.name, v.vcenterName, v.vcenterId, v.domain, ...vmServerList(v), ...(Array.isArray(v.nicServers) ? v.nicServers : [])]
      .filter((x) => typeof x === 'string').join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * VM 행 안의 주소 칩 색 — 공인 red · 다른 법인 amber · 대장에 없음 gray · 그 밖 blue.
 * serverByIp 는 개요의 서버 목록(ip → 원소).
 */
export function ipBadge(ip, vm, serverByIp) {
  const s = serverByIp?.get ? serverByIp.get(ip) : null;
  if (!s) return 'gray';
  if (s.kind === 'public') return 'red';
  if (isOtherCorp(s, vm?.vcenterId)) return 'amber';
  if (s.kind === 'unknown') return 'gray';
  return 'blue';
}

/** NIC ≠ OS 안내 — 어느 쪽이 덮였는지는 모른다(추정이라 적는다). */
export function mismatchNote(vm) {
  const os = Array.isArray(vm?.osServers) ? vm.osServers : [];
  const nic = Array.isArray(vm?.nicServers) ? vm.nicServers : [];
  if (!os.length || !nic.length) return null;
  const a = [...new Set(os)].sort().join(','); const b = [...new Set(nic)].sort().join(',');
  if (a === b) return null;
  return `어댑터에는 ${ipsText(nic)} 이 있지만 OS 는 ${ipsText(os)} 을 씁니다 — 레지스트리·그룹 정책(GPO)·DHCP 옵션으로 덮였을 수 있습니다(추정).`;
}

/** 서버 머리 카드 설명 — 정체를 모르면 모른다고 말한다. */
export function serverHeadDesc(s) {
  if (!s || typeof s !== 'object') return '';
  const who = s.who && typeof s.who === 'object' ? s.who : null;
  const owners = numOrNull(s.owners);
  const dup = owners != null && owners > 1 ? ` 같은 주소를 가진 VM 이 ${owners - 1}대 더 있습니다(중복 IP 확인 필요).` : '';
  if (s.kind === 'public') {
    return s.publicName
      ? `잘 알려진 공인 DNS(${s.publicName})입니다. 사내 이름을 이 서버로 물으면 해석되지 않거나 질의가 외부로 나갑니다.`
      : 'IP 대장 분류상 공인 주소입니다(알려진 공인 DNS 목록에는 없습니다). 사내 이름을 이 서버로 물으면 해석되지 않거나 질의가 외부로 나갑니다.';
  }
  if (s.kind === 'unknown') return '이 포탈의 IP 대장(VM·호스트·공인 DNS 목록·대장 분류)에서 이 주소를 찾지 못했습니다 — 무엇인지 지어내지 않습니다. 사내 DNS 라면 IP관리에 등록하거나 스캔 대역을 확인하세요.';
  if (isMaskedWho(who)) return `조회 범위 밖 법인의 장비가 이 주소를 갖고 있습니다 — 이름은 가립니다.${dup}`;
  if (s.kind === 'host') return `ESXi 호스트 ‘${who?.name || '—'}’(${who?.vcenterName || who?.vcenterId || '—'}) 의 관리 주소입니다.`;
  if (s.kind === 'vm') return `VM ‘${who?.name || '—'}’(${who?.vcenterName || who?.vcenterId || '—'}) 이 이 주소를 갖고 있습니다.${dup}`;
  return '';
}

/** 서버 머리 카드의 정책 표지 문구. */
export function policyHeadText(s) {
  if (!s || typeof s !== 'object') return '—';
  const corps = Array.isArray(s.corps) ? s.corps.length : 0;
  const un = numOrNull(s.unapprovedVms);
  switch (s.policy) {
    case 'approved': return '승인';
    case 'unapproved': return `비승인 — 법인 ${corps}곳에서 사용`;
    case 'mixed': return `법인마다 다름 — 비승인 ${nText(un)}대`;
    case 'none': return '정책 없음(판정 안 함)';
    default: return '확인 불가';
  }
}

/** 상세 VM 목록 아래 문구 — 서버 상한으로 잘린 수를 밝힌다. */
export function vmListFoot(resp, shown) {
  const total = numOrNull(resp?.total);
  const listed = Array.isArray(resp?.vms) ? resp.vms.length : 0;
  const head = total != null ? `${nText(total)}대 중 ${nText(shown)}대 표시` : `${nText(shown)}대 표시`;
  const cut = resp?.truncated && total != null && total > listed ? ` · 서버가 ${nText(listed)}대까지만 보냈습니다` : '';
  return head + cut;
}

// ── 정책 편집 ────────────────────────────────────────────────────────────────
const CANON_IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// '숫자 넷이고 각 255 이하' — 서버 ipToNum 이 읽는 모양(앞자리 0·앞뒤 빈 칸은 읽되 정규형이 아니다).
const looseIpv4 = (b) => /^\s*\d+\.\d+\.\d+\.\d+\s*$/.test(b) && b.trim().split('.').every((o) => Number(o) <= 255);
const ipNum = (b) => b.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const numIp = (n) => [24, 16, 8, 0].map((sh) => Math.floor(n / 2 ** sh) % 256).join('.');
const notCanon = (b) => (looseIpv4(b) ? `‘${b}’ 는 정규형 IPv4 가 아닙니다(앞자리 0·빈 칸 없이)` : `‘${b || '(비어 있음)'}’ 는 IPv4 주소가 아닙니다`);

/**
 * 정책 항목 한 줄 판정(미리보기 — 저장 때 서버가 다시 판정한다).
 * ⚠ 서버 `server/src/vmdns/policy.js checkPolicyEntry` 와 **같은 규칙의 사본**이다(번들 경계 — 웹은 서버 소스를 import 할 수 없다).
 *   정규형 IPv4 또는 CIDR(정규형 기준 주소 + /8~/32, **네트워크 경계**). 앞자리 0·빈 마스크(/0 으로 읽힌다 — v2.637)·
 *   경계가 아닌 CIDR 은 받지 않는다. 범위(a-b)는 형식이 아니라서 거부한다(문구만 친절하게).
 * @returns {{ ok: true, value: string, kind: 'ip'|'cidr' } | { ok: false, reason: string }}
 */
export function checkPolicyEntry(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: '글자가 아닙니다' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: '빈 항목' };
  if (s.length > 64) return { ok: false, reason: '64자를 넘습니다' };
  if (s.includes('-')) return { ok: false, reason: '범위(시작-끝)는 받지 않습니다 — IP 하나 또는 CIDR(예: 10.20.0.0/24)로 쓰세요' };
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return { ok: false, reason: '‘/’ 가 두 번 이상 있습니다' };
    const [b, m] = parts;
    if (!CANON_IPV4.test(b)) return { ok: false, reason: notCanon(b) };
    if (!m) return { ok: false, reason: '‘/’ 뒤 마스크가 비어 있습니다 — 비워 두면 전체 주소(/0)로 읽힐 수 있어 받지 않습니다' };
    if (!/^\d{1,2}$/.test(m) || (m.length === 2 && m[0] === '0')) return { ok: false, reason: `마스크 ‘${m}’ 는 숫자(8~32)가 아닙니다` };
    const k = Number(m);
    if (k > 32) return { ok: false, reason: `마스크 /${k} 는 32 를 넘습니다` };
    if (k < 8) return { ok: false, reason: `마스크 /${k} 는 너무 넓습니다(/8 이상만 받습니다)` };
    const n = ipNum(b);
    const size = 2 ** (32 - k);
    const lo = Math.floor(n / size) * size;
    if (lo !== n) return { ok: false, reason: `네트워크 경계가 아닙니다 — ${numIp(lo)}/${k} 로 적으세요` };
    return { ok: true, value: `${b}/${k}`, kind: 'cidr' };
  }
  if (CANON_IPV4.test(s)) return { ok: true, value: s, kind: 'ip' };
  return { ok: false, reason: looseIpv4(s) ? notCanon(s) : `‘${s.length > 40 ? `${s.slice(0, 40)}…` : s}’ 는 IPv4 주소나 CIDR 이 아닙니다` };
}

/** 입력 칸 → 항목 목록(쉼표·공백·줄바꿈으로 나눈다) 미리보기. 이미 있는 값은 dup. */
export function previewPolicyInput(text, existing = []) {
  const have = new Set((Array.isArray(existing) ? existing : []).map(String));
  const tokens = String(text ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 64);
  const seen = new Set();
  return tokens.map((t) => {
    const r = checkPolicyEntry(t);
    if (!r.ok) return { raw: t, ok: false, reason: r.reason };
    if (have.has(r.value) || seen.has(r.value)) return { raw: t, ok: false, dup: true, value: r.value, reason: '이미 있습니다' };
    seen.add(r.value);
    return { raw: t, ok: true, value: r.value, kind: r.kind };
  });
}

/** 정책 비교(저장 버튼 활성) — 순서는 의미가 없다. 빈 목록 키는 '없음' 과 같다. */
export function normPolicy(p) {
  const corps = {};
  const src = p && typeof p.corps === 'object' && p.corps ? p.corps : {};
  for (const [k, v] of Object.entries(src)) {
    const list = [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].sort();
    if (list.length) corps[k] = list;
  }
  return { corps, publicUnapproved: p?.publicUnapproved !== false };
}
export function samePolicy(a, b) {
  const x = normPolicy(a); const y = normPolicy(b);
  if (x.publicUnapproved !== y.publicUnapproved) return false;
  const kx = Object.keys(x.corps).sort(); const ky = Object.keys(y.corps).sort();
  if (kx.join('|') !== ky.join('|')) return false;
  return kx.every((k) => x.corps[k].join('|') === y.corps[k].join('|'));
}

/** 서버가 돌려준 invalid 한 건 → 문장(vCenter 이름으로). */
export function invalidText(x, vcName = (id) => id) {
  if (!x || typeof x !== 'object') return '';
  const where = x.vcenterId ? vcName(x.vcenterId) : '공통';
  return `${where}: ‘${x.value ?? ''}’ — ${x.reason || '형식 오류'}`;
}

/**
 * 정책 화면의 법인 행 — 조회 범위의 vCenter + 정책 파일에만 있는 키(삭제된 vCenter 등, 고아).
 * 위반 수는 서버가 vcenters[].unapprovedVms 로 줄 때만 숫자이고, 없으면 null(지어내지 않는다).
 */
export function policyRows(vcenters, policy) {
  const vcs = (Array.isArray(vcenters) ? vcenters : []).filter((v) => v && v.id);
  const corps = policy?.corps && typeof policy.corps === 'object' ? policy.corps : {};
  const rows = vcs.map((v) => ({
    id: String(v.id), name: v.name || v.id, vms: numOrNull(v.vms), orphan: false,
    list: Array.isArray(corps[v.id]) ? corps[v.id].map(String) : [],
    viol: numOrNull(v.unapprovedVms),
  }));
  const known = new Set(rows.map((r) => r.id));
  for (const [k, v] of Object.entries(corps)) {
    if (known.has(k) || !Array.isArray(v) || !v.length) continue;
    rows.push({ id: k, name: k, vms: null, orphan: true, list: v.map(String), viol: null });
  }
  return rows;
}

/** 법인 행의 판정 표지 — 목록이 비면 '정책 없음'(위반으로 세지 않는다). */
export function violText(row) {
  if (!row) return { text: '—', tone: 'muted' };
  // 목록이 비어도 '공인 DNS 는 어느 법인에서도 비승인' 규칙은 적용된다 — 그 개수가 있으면 숨기지 않는다.
  if (!row.list?.length) {
    if (row.viol > 0) return { text: `공인 DNS ${nText(row.viol)}대`, tone: 'warn', title: '승인 목록은 비어 있지만 공인 DNS 를 쓰는 VM 입니다(공인 DNS 비승인 규칙)' };
    return { text: '정책 없음', tone: 'muted' };
  }
  if (row.viol == null) return { text: '—', tone: 'muted', title: '이 법인은 이번 조회에서 판정하지 않았습니다(vCenter 필터) — 전체 vCenter 로 보면 나옵니다' };
  if (row.viol === 0) return { text: '위반 없음', tone: 'ok' };
  return { text: `위반 ${nText(row.viol)}대`, tone: 'warn' };
}

/** 조회 범위 밖 안내에 쓸 단위(서버 scope 필드 형태 그대로 scopeOmitNote 에 넘긴다). */
export function scopeOf(data) {
  const s = data?.scope;
  return s && typeof s === 'object' ? s : null;
}
