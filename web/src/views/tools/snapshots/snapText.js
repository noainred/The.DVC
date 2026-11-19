/**
 * snapText.js — 특수 기능 ‘스냅샷 있는 VM’ 화면의 순수 로직(v3.26.0 · 설계 docs/design/snapshots).
 *
 * 판정은 서버(snaphist/view.js — hygieneFindings)가 한다. 여기서는 서버가 준 sig · band · judged 로 **거르고 · 묶고 · 세기만** 한다
 * (판정 코어는 하나 — 루트 CLAUDE.md). 못 읽은 값(null)은 합에 넣지 않고 따로 센다 · 정렬에서는 늘 뒤로.
 */
import { numOrNull } from '../../../numOrNull.js';
import { unitText } from '../../unitText.js';

export const BANDS = Object.freeze(['d90', 'd30', 'd7', 'new', 'skip', 'unk']);
export const BAND_COLOR = Object.freeze({ new: '#4b7bb8', d7: '#f59e0b', d30: '#f0865a', d90: '#ef4444', skip: '#64748b', unk: '#475569' });
export const BAND_FG = Object.freeze({ new: '#c3cfe2', d7: '#fcd34d', d30: '#fdba74', d90: '#fca5a5', skip: '#c3cfe2', unk: '#8b9bb4' });

/** 나이 구간 이름 — 기준 일수 · 경계는 응답의 thresholds 값(화면에 숫자를 박지 않는다). */
export function bandLabels(th) {
  const a = numOrNull(th?.snapAgeDays); const [e1, e2] = th?.ageEdgesDays || [];
  return {
    new: a != null ? `${a}일 미만` : '기준 미만', d7: a != null ? `${a}–${e1}일` : `${e1}일 미만`, d30: `${e1}–${e2}일`, d90: `${e2}일 이상`,
    skip: '판정 안 함', unk: '생성일 못 읽음',
  };
}

/** 빠른 보기(칩) — 한 번에 하나. */
export const VIEWS = Object.freeze([
  ['all', '전체'], ['old', '사내 기준 넘김'], ['h72', '72시간 넘김'], ['first', '먼저 볼 것'], ['cons', '통합 필요'], ['backup', '백업 도구가 남긴 것'], ['off', '전원 꺼짐'], ['skip', '판정 안 함'],
]);
export const VIEW_KEYS = Object.freeze(VIEWS.map(([k]) => k));

/** 신호(패널) — 누르면 그 신호만 본다. grow 는 이력 DB 가 있을 때만(값이 없으면 숨긴다). */
export function signalDefs(th) {
  const a = numOrNull(th?.snapAgeDays);
  return [
    ['old', `사내 기준(${a != null ? `${a}일` : '설정 없음'})을 넘김`, '‘VM 구성 점검’ · ‘오래된 스냅샷’ 카드와 같은 판정', '#fbbf24'],
    ['h72', `VMware 권고(${unitText(th?.adviseHours ?? 72, '시간')})를 넘김`, '참고선 — 판정은 사내 기준입니다', '#fde68a'],
    ['count', `한 VM 에 ${unitText(th?.snapCount, '개')} 넘음`, '줄기가 길수록 디스크 입출력이 느려집니다', '#fdba74'],
    ['size', `${unitText(th?.snapSizeGB, ' GB')} 넘음`, '크기 기준', '#93c5fd'],
    ['ds', `데이터스토어 사용 ${unitText(th?.dsHighPct ?? 85, '%')} 이상`, '스냅샷이 커지면 그 데이터스토어가 찹니다', '#fca5a5'],
    ['cons', '디스크 통합 필요', 'vCenter 가 ‘통합 필요’ 로 표시한 VM', '#fca5a5'],
    ['backup', '백업 도구가 남긴 임시 스냅샷', '백업이 끝났는데 남아 있을 수 있습니다', '#d8b4fe'],
    ['mem', '메모리까지 담은 스냅샷', '켜진 채로 찍어 파일이 메모리 크기만큼 더 큽니다', '#d8b4fe'],
    ['grow', '7일 사이 10 GB 넘게 커짐', '스냅샷 이력으로 셉니다', '#fca5a5'],
    ['noDesc', '설명이 없음', '왜 만들었는지 적혀 있지 않습니다', '#c3cfe2'],
  ];
}
export const SIGNAL_KEYS = Object.freeze(['old', 'h72', 'count', 'size', 'ds', 'cons', 'backup', 'mem', 'grow', 'noDesc']);
export const GROW_GB = 10;

/** 항목이 이 보기 · 신호에 드는가. grow 는 change(이력)가 있어야 판정한다. */
export function matchKey(it, key, change = null) {
  const s = it?.sig || {};
  switch (key) {
    case 'all': return true;
    case 'old': return s.age === true;
    case 'h72': return s.h72 === true;
    case 'first': return s.age === true && (s.size === true || s.ds === true || s.cons === true);
    case 'count': return s.count === true;
    case 'size': return s.size === true;
    case 'ds': return s.ds === true;
    case 'cons': return s.cons === true;
    case 'backup': return s.backup === true;
    case 'mem': return s.mem === true;
    case 'noDesc': return s.noDesc === true;
    case 'off': return it?.powerState != null && it.powerState !== 'POWERED_ON';
    case 'skip': return it?.judged === false;
    case 'grow': { const c = change?.get?.(changeKey(it)); return !!c && c.kind === 'grew' && c.gb >= GROW_GB; }
    default: return false;
  }
}

export const changeKey = (it) => `${it?.vcenterId}\n${it?.id}`;

/** 정렬 — 못 읽은 값(null)은 방향과 무관하게 늘 뒤. */
export function sortItems(items, key, dir, change = null) {
  const val = {
    name: (x) => String(x.name || '').toLowerCase(), oldest: (x) => (x.oldestName == null ? null : String(x.oldestName).toLowerCase()),
    days: (x) => numOrNull(x.days), count: (x) => numOrNull(x.snapshotCount), gb: (x) => numOrNull(x.snapGB),
    chg: (x) => { const c = change?.get?.(changeKey(x)); return c && c.gb != null ? c.gb : null; },
    power: (x) => (x.powerState === 'POWERED_ON' ? 1 : 0), sig: (x) => sigCount(x), corp: (x) => String(x.corpName || ''),
  }[key] || ((x) => numOrNull(x.days));
  const sgn = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = val(a); const y = val(b);
    if (x == null && y == null) return String(a.name).localeCompare(String(b.name));
    if (x == null) return 1;
    if (y == null) return -1;
    if (x < y) return -sgn;
    if (x > y) return sgn;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function sigCount(it) {
  const s = it?.sig || {};
  return ['age', 'count', 'size', 'ds', 'cons', 'backup', 'mem'].reduce((n, k) => n + (s[k] === true ? 1 : 0), 0) + (s.h72 === true && s.age !== true ? 1 : 0);
}

/** 크기 합 — 못 읽은 것은 빼고 그 수를 따로. */
export function gbSum(items) {
  let gb = 0; let unknown = 0;
  for (const x of items) { const g = numOrNull(x.snapGB); if (g == null) unknown += 1; else gb += g; }
  return { gb: Math.round(gb * 10) / 10, unknown };
}

/** 묶어 보기 — corp · cluster · band · who · none. 묶음 순서: 기준 넘긴 수 많은 순 → 크기 큰 순(band 는 오래된 구간부터). */
export const GROUPS = Object.freeze([['corp', '법인'], ['cluster', '클러스터'], ['band', '나이 구간'], ['who', '만든 계정'], ['none', '묶지 않음']]);
export function groupItems(items, mode, labels, whoOf = null) {
  if (mode === 'none') return [{ key: '', label: '', items }];
  const keyOf = {
    corp: (x) => [x.corpId, x.corpName],
    cluster: (x) => [`${x.corpId}\n${x.cluster || ''}`, `${x.corpName} › ${x.cluster || '클러스터 없음'}`],
    band: (x) => [x.band, labels?.[x.band] || x.band],
    who: (x) => { const w = whoOf ? whoOf(x) : null; return [w || '', w || '만든 계정 모름']; },
  }[mode] || ((x) => [x.corpId, x.corpName]);
  const map = new Map();
  for (const x of items) {
    const [k, label] = keyOf(x);
    if (!map.has(k)) map.set(k, { key: k, label, items: [] });
    map.get(k).items.push(x);
  }
  const out = [...map.values()];
  if (mode === 'band') out.sort((a, b) => BANDS.indexOf(a.key) - BANDS.indexOf(b.key));
  else out.sort((a, b) => overCount(b.items) - overCount(a.items) || gbSum(b.items).gb - gbSum(a.items).gb || String(a.label).localeCompare(String(b.label)));
  return out;
}
export const overCount = (xs) => xs.filter((x) => x.sig?.age === true).length;

/** 나이 구간 비율 막대(linear-gradient) — 구간 순서는 새것 → 오래된 것. */
export function bandGradient(items) {
  const n = items.length;
  if (!n) return 'transparent';
  let acc = 0; const parts = [];
  for (const k of ['new', 'd7', 'd30', 'd90', 'skip', 'unk']) {
    const c = items.filter((x) => x.band === k).length;
    if (!c) continue;
    const a = Math.round((acc / n) * 1000) / 10; acc += c; const b = Math.round((acc / n) * 1000) / 10;
    parts.push(`${BAND_COLOR[k]} ${a}% ${b}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** 요약 숫자(값이 낡은 vCenter 의 VM 은 빼고 따로 센다). */
export function summaryOf(items) {
  const fresh = items.filter((x) => !x.stale);
  const over = fresh.filter((x) => x.sig?.age === true);
  const all = gbSum(fresh); const ov = gbSum(over);
  const ages = fresh.map((x) => numOrNull(x.days)).filter((d) => d != null);
  return {
    vms: fresh.length, stale: items.length - fresh.length, skip: fresh.filter((x) => x.judged === false).length,
    over: over.length, h72: fresh.filter((x) => x.sig?.h72 === true).length, ageUnknown: fresh.filter((x) => x.judged !== false && numOrNull(x.days) == null).length,
    gb: all.gb, gbUnknown: all.unknown, overGb: ov.gb, overGbUnknown: ov.unknown,
    snaps: fresh.reduce((a, x) => a + (numOrNull(x.snapshotCount) ?? 0), 0), maxAge: ages.length ? Math.max(...ages) : null,
  };
}

/**
 * 지금 값을 못 읽은 vCenter(서버 view.vcReadIssue 가 준 unread) — 값이 낡은 것(stale)은 ‘값이 낡음’ 으로 따로 말하므로 뺀다.
 * 138회차: 이 vCenter 들은 items 에 없다 — ‘0대 · 스냅샷 없음’ 이 아니라 ‘못 읽음’ 이다(못 읽은 값은 0 이 아니다).
 */
export const unreadVcs = (vcs) => (vcs || []).filter((v) => v && v.unread && !v.stale);

/** 법인 카드 — 서버 corps 순서가 아니라 기준 넘긴 수 많은 순. 스냅샷 VM 이 없는 법인도 카드로 남긴다(0대 — 수집은 됐다 · 못 읽은 vCenter 는 unread 로 센다). */
export function corpCards(items, corps) {
  const byCorp = new Map((corps || []).map((c) => [c.id, { id: c.id, name: c.name, stale: (c.vcenters || []).some((v) => v.stale),
    unread: unreadVcs(c.vcenters).length, vcN: (c.vcenters || []).length, items: [] }]));
  for (const x of items) {
    if (!byCorp.has(x.corpId)) byCorp.set(x.corpId, { id: x.corpId, name: x.corpName, stale: false, items: [] });
    byCorp.get(x.corpId).items.push(x);
  }
  return [...byCorp.values()].map((c) => {
    const over = c.items.filter((x) => x.sig?.age === true);
    const judged = c.items.filter((x) => x.judged !== false).map((x) => numOrNull(x.days)).filter((d) => d != null);
    return { ...c, n: c.items.length, over: over.length, gb: gbSum(c.items), overGb: gbSum(over), oldest: judged.length ? Math.max(...judged) : null,
      blind: !c.items.length && c.unread > 0 && c.unread === c.vcN };   // 이 법인의 vCenter 를 하나도 못 읽었다 — 수 · 크기를 말하지 않는다
  }).sort((a, b) => b.over - a.over || b.gb.gb - a.gb.gb || String(a.name).localeCompare(String(b.name)));
}

/** 법인 카드 아래 줄 — 못 읽은 법인을 ‘스냅샷 없음’ 으로 적지 않는다(138회차). */
export function corpFootText(c) {
  const parts = [c.oldest != null ? `가장 오래된 것 ${daysText(c.oldest)}` : c.n ? '판정한 스냅샷 없음' : c.blind ? null : '스냅샷 없음'];
  if (c.stale) parts.push('값이 낡음');
  if (c.unread) parts.push(`지금 값을 못 읽은 vCenter ${c.unread}곳`);
  return parts.filter(Boolean).join(' · ');
}

/** 로그 눈금 위치(%) — 1 ~ max. */
export function logPos(n, max = 1200) {
  const v = Math.min(max, Math.max(1, Number(n) || 1));
  return Math.round((Math.log10(v) / Math.log10(max)) * 1000) / 10;
}

export const gbText = (gb) => {
  const n = numOrNull(gb);
  if (n == null) return '—';
  if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)} TB`;
  if (Math.abs(n) >= 100) return `${Math.round(n).toLocaleString('en-US')} GB`;
  return `${Math.round(n * 10) / 10} GB`;
};
export const daysText = (d) => { const n = numOrNull(d); return n == null ? '—' : `${n.toLocaleString('en-US')}일`; };
export function dateText(ts) {
  const n = numOrNull(ts);
  if (n == null || n <= 0) return '—';
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 정리 요청 글 — 그 법인 담당자에게 보낼 목록(onlyOver = 사내 기준 넘긴 VM 만). */
export function requestText(title, items, th, { onlyOver = true, whoOf = null } = {}) {
  const xs = onlyOver ? items.filter((x) => x.sig?.age === true) : items;
  const g = gbSum(xs);
  const head = `[${title}] 스냅샷 정리 요청 — ${onlyOver ? `사내 기준 ${th?.snapAgeDays ?? '—'}일을 넘긴 VM ` : '고른 VM '}${xs.length}대 · 약 ${gbText(g.gb)}${g.unknown ? `(크기 못 읽음 ${g.unknown}대 제외)` : ''}`;
  const lines = xs.map((x, i) => {
    const who = whoOf ? whoOf(x) : null;
    return `${i + 1}. ${x.name} (${x.vcName}${x.cluster ? ` · ${x.cluster}` : ''}) — ${daysText(x.days)} · ${gbText(x.snapGB)} · 스냅샷 ${x.snapshotCount}개`
      + `${x.oldestName ? ` · 가장 오래된 것 ‘${x.oldestName}’` : ''}${who ? ` · 만든 계정 ${who}` : ''}`
      + `${x.sig?.cons ? ' · 통합 필요' : ''}${x.sig?.ds && x.ds ? ` · 데이터스토어 ${x.ds.name} ${x.ds.pct}%` : ''}`;
  });
  return [head, ...(lines.length ? lines : ['(해당하는 VM 이 없습니다)']),
    '지우기 전에 통합 필요 표시와 데이터스토어 여유를 먼저 확인해 주세요. 계속 둘 스냅샷은 사유와 기한을 알려 주세요.'].join('\n');
}

/** CSV 머리 · 줄(보이는 줄 그대로). */
export const CSV_HEAD = ['VM', '법인', 'vCenter', '클러스터', '호스트', '스냅샷 수', '크기(GB)', '지난 일수', '가장 오래된 스냅샷', '만든 날', '설명', '전원', '신호', '판정 안 함 사유', '데이터스토어', '데이터스토어 사용(%)'];
const SIG_TEXT = { age: '사내 기준 넘김', h72: '72시간 넘김', count: '개수', size: '크기', ds: '데이터스토어', cons: '통합 필요', backup: '백업 임시', mem: '메모리 포함' };
const SKIP_TEXT = { template: '템플릿', exception: '예외 목록', 'no-settings': '설정 없음' };
export function csvRow(x) {
  const sig = Object.entries(SIG_TEXT).filter(([k]) => x.sig?.[k] === true).map(([, t]) => t).join(' / ');
  return [x.name, x.corpName, x.vcName, x.cluster || '', x.host || '', x.snapshotCount, x.snapGB ?? '', x.days ?? '', x.oldestName || '', dateText(x.oldestTs) === '—' ? '' : dateText(x.oldestTs),
    x.oldestDesc || '', x.powerState === 'POWERED_ON' ? '켜짐' : '꺼짐', sig, SKIP_TEXT[x.skip] || '', x.ds?.name || '', x.ds?.pct ?? ''];
}

/**
 * 주소 — `#/tools/snapshots/<보기>/<vCenter id 목록>`. id 는 하나씩 encodeURIComponent 한 뒤 쉼표로 잇는다(platformText.hubScopeQuery 와 같은 규칙 —
 * id 에 쉼표 · 빗금이 있어도 갈리지 않는다). 모르는 보기는 null(기본값은 부르는 쪽이 정한다).
 */
export function parseSnapHash(hash) {
  const segs = String(hash || '').replace(/^#\/?/, '').split('/');
  if (segs[0] !== 'tools' || segs[1] !== 'snapshots') return { view: null, vcIds: [] };
  const view = VIEW_KEYS.includes(segs[2]) ? segs[2] : null;
  const raw = segs[3] || '';
  const vcIds = [];
  for (const p of raw.split(',')) {
    if (!p) continue;
    let id = p;
    try { id = decodeURIComponent(p); } catch { /* 잘못된 % — 날 글자 그대로 */ }
    id = id.trim();
    if (id && !vcIds.includes(id) && vcIds.length < 200) vcIds.push(id);
  }
  return { view, vcIds };
}
export function buildSnapHash(view, vcIds = []) {
  const ids = (vcIds || []).filter(Boolean).map((id) => encodeURIComponent(String(id))).join(',');
  return `#/tools/snapshots/${VIEW_KEYS.includes(view) ? view : 'all'}${ids ? `/${ids}` : ''}`;
}

// ── 2단계(v3.27.0) — 스냅샷 이력 DB 로 그리는 것 ──────────────────────────────────────────

/**
 * 7일 변화 — ago7 = 서버 /tools/snapshots/history 의 ago7({day, okVcenters, rows}).
 * 7일 전 그 vCenter 를 'ok' 로 기록하지 않았으면 그 VM 의 변화는 모른다(null — ‘그대로’ 로 적지 않는다).
 * @returns {Map<string, {kind:'new'|'grew'|'shrank'|'same', gb:number|null}>}
 */
export function changeMap(items, ago7) {
  const out = new Map();
  if (!ago7 || !Array.isArray(ago7.rows)) return out;
  const okVc = new Set(ago7.okVcenters || []);
  const before = new Map(ago7.rows.map((r) => [`${r.vcenterId}\n${r.vmId}`, r]));
  for (const x of items) {
    if (!okVc.has(String(x.vcenterId))) continue;
    const k = changeKey(x);
    const b = before.get(k);
    if (!b) { out.set(k, { kind: 'new', gb: numOrNull(x.snapGB) }); continue; }
    const now = numOrNull(x.snapGB); const was = numOrNull(b.gb);
    if (now == null || was == null) { out.set(k, { kind: 'same', gb: null }); continue; }
    const d = Math.round((now - was) * 10) / 10;
    out.set(k, { kind: d >= 0.1 ? 'grew' : d <= -0.1 ? 'shrank' : 'same', gb: d });
  }
  return out;
}

/** 7일 전에는 스냅샷이 있었는데 지금은 없는 VM(정리했거나 VM 이 없어짐) — 값이 낡은 vCenter 는 모른다(뺀다). */
export function clearedSince(items, ago7, staleVcIds = new Set()) {
  if (!ago7 || !Array.isArray(ago7.rows)) return null;
  const now = new Set(items.map(changeKey));
  const out = ago7.rows.filter((r) => !staleVcIds.has(String(r.vcenterId)) && !now.has(`${r.vcenterId}\n${r.vmId}`));
  const g = out.reduce((a, r) => { const n = numOrNull(r.gb); if (n == null) a.unknown += 1; else a.gb += n; return a; }, { gb: 0, unknown: 0 });
  return { n: out.length, gb: Math.round(g.gb * 10) / 10, gbUnknown: g.unknown };
}

/** 추이 한 줄의 값 — metric 'gb' | 'vms' | 'over'. 빠진 날은 null(선이 끊긴다). */
export const seriesValues = (series, metric) => (series || []).map((p) => (p ? numOrNull(p[metric]) : null));

/**
 * SVG 꺾은선 조각 — null 은 선을 끊는다(빠진 날을 0 으로 잇지 않는다). 값은 0 ~ 최대값을 높이 h 에 맞춘다.
 * @returns {{d:string, area:string, max:number|null, gaps:number[]}}  gaps = 빠진 날의 x 위치(%)
 */
export function lineGeom(values, w = 100, h = 30) {
  const n = values.length;
  const nums = values.filter((v) => v != null);
  const max = nums.length ? Math.max(...nums) : null;
  if (!n || max == null) return { d: '', area: '', max, gaps: values.map((_, i) => i) };
  const x = (i) => (n === 1 ? w / 2 : Math.round((i / (n - 1)) * w * 100) / 100);
  const y = (v) => Math.round((h - (max > 0 ? (v / max) * (h - 2) : 0) - 1) * 100) / 100;
  let d = ''; let area = ''; let seg = [];
  const flush = () => {
    if (!seg.length) return;
    d += seg.map(([i, v], j) => `${j ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
    area += `M${x(seg[0][0])},${h}${seg.map(([i, v]) => `L${x(i)},${y(v)}`).join('')}L${x(seg[seg.length - 1][0])},${h}Z`;
    seg = [];
  };
  const gaps = [];
  values.forEach((v, i) => { if (v == null) { flush(); gaps.push(i); } else seg.push([i, v]); });
  flush();
  return { d, area, max, gaps };
}

/** 정리된 스냅샷 줄 — 있었던 기간 = (생성 시각, 없으면 처음 본 시각) → 없어진 것을 처음 본 시각. 기준 안 정리 = 그 기간 < 기준 일수. */
export function goneRows(gone, corpOfVc, ageDays) {
  const DAY = 86_400_000;
  return (gone || []).map((g) => {
    const from = numOrNull(g.createTs) ?? numOrNull(g.firstSeen);
    const lived = from != null && numOrNull(g.goneAt) != null ? Math.max(0, Math.floor((g.goneAt - from) / DAY)) : null;
    return { ...g, corpName: corpOfVc(g.vcenterId), lived, fromCreate: numOrNull(g.createTs) != null,
      inTime: ageDays != null && lived != null ? lived < ageDays : null };
  });
}

/** 정리 실적 요약 — 사유 'vm'(VM 이 없어짐)은 정리 실적에 넣지 않는다. */
export function goneSummary(rows) {
  const snap = rows.filter((r) => r.reason !== 'vm');
  const lived = snap.map((r) => r.lived).filter((d) => d != null);
  const judged = snap.filter((r) => r.inTime != null);
  return {
    n: snap.length, vm: rows.length - snap.length,
    avgLived: lived.length ? Math.round(lived.reduce((a, d) => a + d, 0) / lived.length) : null,
    inTimePct: judged.length ? Math.round((judged.filter((r) => r.inTime).length / judged.length) * 100) : null,
  };
}
