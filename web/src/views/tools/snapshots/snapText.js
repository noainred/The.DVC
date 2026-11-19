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

/** 법인 카드 — 서버 corps 순서가 아니라 기준 넘긴 수 많은 순. 스냅샷 VM 이 없는 법인도 카드로 남긴다(0대 — 수집은 됐다). */
export function corpCards(items, corps) {
  const byCorp = new Map((corps || []).map((c) => [c.id, { id: c.id, name: c.name, stale: (c.vcenters || []).some((v) => v.stale), items: [] }]));
  for (const x of items) {
    if (!byCorp.has(x.corpId)) byCorp.set(x.corpId, { id: x.corpId, name: x.corpName, stale: false, items: [] });
    byCorp.get(x.corpId).items.push(x);
  }
  return [...byCorp.values()].map((c) => {
    const over = c.items.filter((x) => x.sig?.age === true);
    const judged = c.items.filter((x) => x.judged !== false).map((x) => numOrNull(x.days)).filter((d) => d != null);
    return { ...c, n: c.items.length, over: over.length, gb: gbSum(c.items), overGb: gbSum(over), oldest: judged.length ? Math.max(...judged) : null };
  }).sort((a, b) => b.over - a.over || b.gb.gb - a.gb.gb || String(a.name).localeCompare(String(b.name)));
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
