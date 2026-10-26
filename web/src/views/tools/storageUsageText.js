/**
 * views/tools/storageUsageText.js — 스토리지 사용량 보고서 화면의 **판정·문구·CSV**(순수, v2.789).
 *
 * 사용자 요청(2026-10-26): "스토리지 사용량을 일간/주간 별로 이렇게 정리해서 보는 기능" + 엑셀 캡처 ·
 *   "표 형식으로 보는 것을 기본 · CSV export 기본 기능 · 법인별/같은 종류 스토리지별 비교 등 다양한 기능" ·
 *   "사용자가 지정한 시간에 전체 사용량을 이메일로".
 *
 * ── 규칙 ──────────────────────────────────────────────────────────────────────
 *  · 합계(`aggregateCells`)·변화(`deltaOf`)·'값이 있어야 하는 장비'(`expectedIn`)는 서버 `storage/usageReport.js` 의 **사본**이다
 *    (번들 경계라 두 벌 — 메일과 화면의 숫자가 같아야 한다). 웹 테스트가 같은 입력으로 서버 모듈과 대조한다. 한쪽만 고치지 말 것.
 *  · 값이 없으면 '—' 이고 단위를 붙이지 않는다(0 이 아니다 — numOrNull). 부분 합에는 '값 있음 N/M대' 표지를 단다.
 *  · 기준일에 관측이 없어 기간 안의 이전 관측을 쓴 칸은 '≈' 와 실제 관측일을 밝힌다.
 *  · 문구에 백틱을 쓰지 않는다(BoldText 는 **강조** 만 해석한다 — 값 인용은 ‘ ’).
 *  · CSV 는 두 가지다 — ① 화면 그대로(엑셀형: 날짜 행 × 법인 › 장비 › 지표 열, 머리 3줄) ② 행 단위(피벗용: 한 줄 = 기간 × 장비/항목).
 *    둘 다 수식 가드(`util/csv.js`)를 거친다. 숫자 칸은 숫자만 싣는다(단위는 머리에) — 엑셀이 합계·정렬할 수 있게.
 *  · v2.791: 주간 행 이름은 ISO 주차('2026년 44주차', 기준일은 `dayLabel`) · PowerScale 은 HDD 풀·SSD 풀을 장비 아래 열로(`pools`) —
 *    한 매체만 있으면 열을 만들지 않고 `poolNote`('HDD 풀만') 로 밝힌다. 풀 값은 장비 합계의 부분이라 합계에 더하지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { toCsv } from '../../util/csv.js';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const PiB = 1024 ** 5;

/** 표시 단위. auto = 크기에 맞춰(장비 표기와 같은 1024 단위). */
export const UNITS = Object.freeze([
  { key: 'auto', label: '자동' }, { key: 'GB', label: 'GB' }, { key: 'TB', label: 'TB' }, { key: 'PB', label: 'PB' },
]);
const DIV = { GB: GiB, TB: TiB, PB: PiB };

/** 바이트 → '282.8 TB'(auto) · '122880.0 GB'(단위 고정). 못 읽으면 '—'. */
export function bytesText(b, unit = 'auto') {
  const n = numOrNull(b);
  if (n == null) return '—';
  const u = DIV[unit] ? unit : (Math.abs(n) >= PiB ? 'PB' : Math.abs(n) >= TiB ? 'TB' : 'GB');
  return `${(n / DIV[u]).toFixed(1)} ${u}`;
}
/** 바이트 → 그 단위의 수(소수 둘째 자리). CSV 숫자 칸용. 못 읽으면 ''(빈 칸 — 0 이 아니다). */
export function bytesNum(b, unit) {
  const n = numOrNull(b);
  if (n == null) return '';
  return Math.round((n / (DIV[unit] || TiB)) * 100) / 100;
}
export function deltaText(d, unit = 'auto') {
  const n = numOrNull(d);
  if (n == null) return '—';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${bytesText(Math.abs(n), unit)}`;
}
export const pctText = (p) => (numOrNull(p) == null ? '—' : `${Number(p).toFixed(0)}%`);
/** 사용률 색조 — 값이 없으면 none(회색). 경계는 화면 범례가 같은 값을 말한다. */
export const PCT_WARN = 80;
export const PCT_CRIT = 90;
export function pctTone(p) {
  const n = numOrNull(p);
  if (n == null) return 'none';
  return n >= PCT_CRIT ? 'crit' : n >= PCT_WARN ? 'warn' : 'ok';
}

/* ── 서버 usageReport.js 의 사본(테스트 대조) ───────────────────────────── */
const pctOf = (t, u) => (t != null && t > 0 && u != null ? Math.round((u / t) * 1000) / 10 : null);
export function expectedIn(dev, p) {
  const f = numOrNull(dev?.firstDay);
  if (f == null || f > p.toDay) return false;
  if (dev.enabled === false) { const l = numOrNull(dev.lastDay); return l != null && l >= p.fromDay; }
  return true;
}
export function aggregateCells(devs, periods) {
  return (periods || []).map((p, i) => {
    let t = 0; let u = 0; let counted = 0; let expected = 0; let missing = 0; let usedUnknown = 0; let inexact = 0;
    for (const d of devs || []) {
      const c = d?.cells?.[i] || null;
      const exp = expectedIn(d, p);
      if (exp) expected += 1;
      if (!c) { if (exp) missing += 1; continue; }
      if (c.usedBytes == null) { usedUnknown += 1; continue; }
      t += c.totalBytes; u += c.usedBytes; counted += 1;
      if (!c.exact) inexact += 1;
    }
    return {
      totalBytes: counted ? t : null, usedBytes: counted ? u : null, pct: counted ? pctOf(t, u) : null,
      counted, expected, missing, usedUnknown, inexact, partial: missing > 0 || usedUnknown > 0,
    };
  });
}
export function deltaOf(prev, cur) {
  const a = numOrNull(prev?.usedBytes); const b = numOrNull(cur?.usedBytes);
  return a == null || b == null ? null : b - a;
}

/* ── 칸 표지 ─────────────────────────────────────────────────────────── */
/**
 * 일 인덱스 → 'YYYY-MM-DD'. 서버 일 인덱스는 포탈 시각(dayOffsetMin)으로 이미 밀린 날 번호라 그 날의 UTC 날짜 부품이 곧 포탈 날짜다
 * (브라우저 '오늘' 을 만드는 함수가 아니다 — 오늘은 서버가 asOfLabel 로 준다).
 */
const pad2 = (n) => String(n).padStart(2, '0');
export function isoOfDay(day) {
  const d = new Date(Number(day) * 86_400_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const mmdd = (day) => isoOfDay(day).slice(5);
/** 기준일과 다른 날의 관측이면 '≈ 10-17 관측'. 아니면 ''. */
export function inexactNote(cell) {
  return cell && cell.exact === false && cell.day != null ? `≈ ${mmdd(cell.day)} 관측` : '';
}
/** 부분 합 표지 — '값 있음 3/4대'. 부분이 아니면 ''. */
export function partialNote(agg) {
  if (!agg?.partial) return '';
  const extra = agg.usedUnknown ? ` · 사용량 미확인 ${agg.usedUnknown}대` : '';
  return `값 있음 ${agg.counted}/${agg.expected}대${extra}`;
}

/** 하위 항목 수집 표지 → 문구. 서버 `storage/resources.js PROBE_STATES` 와 1:1(테스트 대조). */
export const PROBE_TEXT = Object.freeze({
  ok: '읽음',
  unparsed: '출력 형식을 인식하지 못함(상세의 CLI 원문 확인)',
  failed: '명령 실패',
  skipped: '수집 시간 예산이 모자라 이번 주기에는 건너뜀',
});
export function probeLine(kindLabel, p) {
  // 표지가 없는 이유는 여럿이다 — 하나로 단정하지 않는다(구버전 수집기·엣지 / 이 수집 방식이 하위 항목을 읽지 않음 / 아직 첫 수집 전).
  if (!p) return `${kindLabel}: 최근 수집 결과에 상태 표지 없음(구버전 수집기·엣지이거나 아직 새 수집 전)`;
  const base = PROBE_TEXT[p.state] || p.state;
  const n = p.state === 'ok' && numOrNull(p.count) != null ? ` ${p.count}개` : '';
  return `${kindLabel}: ${base}${n}${p.detail ? ` — ${p.detail}` : ''}`;
}

/** 예약 메일을 보내지 않은 사유 — 서버 `storage/usageMailRules.js SKIP_CODES` 와 1:1(테스트가 서버 소스에서 뽑아 대조). */
export const SKIP_TEXT = Object.freeze({
  'no-recipients': '받는 사람이 없음',
  'no-devices': '이력이 있는 장비가 없음',
  'mail-off': '메일 발송이 꺼져 있음(설정 › 메일 발송)',
  'auth-stopped': 'SMTP 인증 실패로 자동 발송 정지',
  unreadable: '설정·등록부를 읽지 못함',
  'db-off': '용량 이력 DB 를 쓸 수 없음',
});
export const MISSED_TEXT = Object.freeze({
  down: '포탈이 꺼져 있던 회차', late: '30분 넘게 늦게 확인한 회차', clock: '서버 시계가 뒤로 감',
});
export const DAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);

/* ── 묶음 ─────────────────────────────────────────────────────────── */
/**
 * 장비 묶음 → 기간별 합계 + 요약(마지막 값 · 직전 대비 · 범위 전체 변화 · 기간당 평균 변화).
 * 범위 변화는 **첫 기간과 마지막 기간이 둘 다 완전한 합계일 때만**(부분 합끼리 빼면 장비 수 차이가 변화로 보인다).
 */
export function groupSummary(key, label, list, periods) {
  const cells = aggregateCells(list, periods);
  const n = cells.length;
  const cur = n ? cells[n - 1] : null;
  const prev = n > 1 ? cells[n - 2] : null;
  const first = cells.find((c) => c.counted > 0) || null;
  const fi = first ? cells.indexOf(first) : -1;
  const rangeOk = !!(first && cur && fi < n - 1 && !first.partial && !cur.partial);
  const range = rangeOk ? deltaOf(first, cur) : null;
  return {
    key, label, devices: list.length, cells, cur,
    delta: prev && cur && !prev.partial && !cur.partial ? deltaOf(prev, cur) : null,
    deltaWhy: prev && cur && (prev.partial || cur.partial) ? '두 시점 중 하나가 부분 합이라 변화를 내지 않았습니다' : '',
    range, rangeSteps: rangeOk ? n - 1 - fi : 0,
    avg: rangeOk && n - 1 - fi > 0 ? range / (n - 1 - fi) : null,
  };
}

/**
 * 비교 차트의 계열 — 색은 **개체를 따른다**(순위·필터로 다시 칠하지 않는다): `order`(전체 데이터 기준의 고정 순서) 앞 7개에
 * 고정 색, 나머지는 회색 '기타' 하나로 접는다(9번째 색을 만들지 않는다 — 팔레트는 8색이고 8번째 빨강은 상태색과 헷갈려 쓰지 않는다).
 * 부분 합인 점은 끊는다(null) — 부분 합을 추이로 그리지 않는다.
 * @returns {{series:{key:string,label:string,color:string}[], data:object[], cutPoints:number}}
 */
export const SERIES_COLORS = Object.freeze(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9']);
export const OTHER_COLOR = '#8a94a6';
export function chartSeries(groups, order, periods, { metric = 'pct' } = {}) {
  const rank = new Map((order || []).map((k, i) => [k, i]));
  const colored = groups.filter((g) => (rank.get(g.key) ?? 99) < SERIES_COLORS.length)
    .sort((a, b) => rank.get(a.key) - rank.get(b.key));
  const rest = groups.filter((g) => !colored.includes(g));
  const series = colored.map((g) => ({ key: g.key, label: g.label, color: SERIES_COLORS[rank.get(g.key)], cells: g.cells }));
  if (rest.length) {
    const cells = aggregateCells(rest.flatMap((g) => g.list || []), periods);
    series.push({ key: '__other', label: `기타 ${rest.length}개`, color: OTHER_COLOR, cells });
  }
  let cutPoints = 0;
  const val = (c) => {
    if (!c || c.counted === 0) return null;
    if (c.partial) { cutPoints += 1; return null; }
    return metric === 'used' ? c.usedBytes : c.pct;
  };
  const data = (periods || []).map((p, i) => {
    const row = { label: periodAxis(p) };
    for (const s of series) row[s.key] = val(s.cells[i]);
    return row;
  });
  return { series: series.map(({ key, label, color }) => ({ key, label, color })), data, cutPoints };
}

/** 기간 행 이름 — 주간은 '2026년 44주차 (10-26)'(ISO 주차 + 기준일), 그 밖은 서버 label 그대로. */
export function periodText(p) {
  return p?.dayLabel ? `${p.label} (${String(p.dayLabel).slice(5)})` : (p?.label ?? '');
}
/** 차트 가로축 — 주간은 '2026-W44'(여러 해에 걸친 전체 누적에서도 겹치지 않게), 그 밖은 label. */
export const periodAxis = (p) => p?.isoKey || p?.label || '';
/** 장비 머리의 보조 문구 — 종류 · 풀 표지('HDD 풀만'). */
export const deviceSub = (d, typeLabel) => [typeLabel(d.type), d.poolNote].filter(Boolean).join(' · ');

/* ── CSV ─────────────────────────────────────────────────────────── */
const csvUnit = (unit, fallback) => (DIV[unit] ? unit : fallback);

/**
 * ① 화면 그대로(엑셀형) — 머리 3줄(법인 / 장비·항목 / 지표) + 기간 행. 장비는 전체·사용·사용률 3칸, 하위 항목도 같은 3칸.
 * 단위 'auto' 면 장비는 TB, 하위 항목은 GB(사용자 캡처와 같다). 단위는 지표 머리에 적는다.
 */
export function wideCsv(devices, periods, { dcName = (x) => x, typeLabel = (x) => x, unit = 'auto', resources = true, pools = true, kindGroup = {} } = {}) {
  const du = csvUnit(unit, 'TB'); const ru = csvUnit(unit, 'GB');
  const h1 = ['법인']; const h2 = ['장비 / 항목']; const h3 = [periods?.[0]?.dayLabel ? '주차 (기준일)' : '일자'];
  const cols = [];
  for (const d of devices) {
    const corp = dcName(d.datacenterId) || '미지정';
    const nm = `${d.name} (${deviceSub(d, typeLabel)})`;
    h1.push(corp, corp, corp); h2.push(nm, nm, nm); h3.push(`Total Usable (${du})`, `Used (${du})`, 'Percent (%)');
    cols.push({ cells: d.cells, unit: du });
    if (pools) {
      for (const pl of d.pools || []) {
        const pn = `${d.name} › ${pl.label}`;
        h1.push(corp, corp, corp); h2.push(pn, pn, pn); h3.push(`Total Usable (${du})`, `Used (${du})`, 'Percent (%)');
        cols.push({ cells: pl.cells, unit: du });
      }
    }
    if (resources) {
      for (const r of d.resources || []) {
        const rn = `${d.name} › ${kindGroup[r.kind] || r.kind} ${r.name}`;
        h1.push(corp, corp, corp); h2.push(rn, rn, rn); h3.push(`Size (${ru})`, `Used (${ru})`, 'Percent (%)');
        cols.push({ cells: r.cells, unit: ru });
      }
    }
  }
  const rows = [h1, h2, h3];
  (periods || []).forEach((p, i) => {
    const row = [periodText(p)];
    for (const c of cols) {
      const cell = c.cells[i];
      row.push(bytesNum(cell?.totalBytes, c.unit), bytesNum(cell?.usedBytes, c.unit), cell?.pct ?? '');
    }
    rows.push(row);
  });
  return toCsv(rows);
}

/**
 * ② 행 단위(피벗용) — 한 줄 = 기간 × (장비 | 하위 항목). 직전 기간 대비 변화를 함께 싣는다. 관측일이 기준일과 다르면 '관측일' 칸이 말한다.
 */
export function longCsv(devices, periods, { dcName = (x) => x, typeLabel = (x) => x, unit = 'auto', resources = true, pools = true, kindGroup = {} } = {}) {
  const u = csvUnit(unit, 'GB');
  const label = (day) => (day == null ? '' : isoOfDay(day));
  const rows = [['기간', '기준일', '관측일', '법인', '종류', '장비', '구분', '항목', `전체(${u})`, `사용(${u})`, '사용률(%)', `직전 대비(${u})`]];
  const push = (d, kind, name, cells) => {
    (periods || []).forEach((p, i) => {
      const c = cells[i];
      const dl = i > 0 ? deltaOf(cells[i - 1], c) : null;
      rows.push([p.label, label(p.toDay), c ? label(c.day) : '', dcName(d.datacenterId) || '미지정', typeLabel(d.type), d.name, kind, name,
        bytesNum(c?.totalBytes, u), bytesNum(c?.usedBytes, u), c?.pct ?? '', dl == null ? '' : bytesNum(dl, u)]);
    });
  };
  for (const d of devices) {
    push(d, '장비', d.name, d.cells);
    if (pools) for (const pl of d.pools || []) push(d, '풀', pl.label, pl.cells);
    if (resources) for (const r of d.resources || []) push(d, kindGroup[r.kind] || r.kind, r.name, r.cells);
  }
  return toCsv(rows);
}

/** 내려받기 파일 이름 — 'storage-usage-weekly-2026-10-26-wide.csv'. 법인·종류 필터가 걸렸으면 '-filtered'. */
export function csvFileName({ gran, asOfLabel, kind, filtered }) {
  return `storage-usage-${gran || 'weekly'}-${asOfLabel || 'report'}-${kind}${filtered ? '-filtered' : ''}.csv`;
}

/** 저장되지 않은 메일 폼과 저장값이 다른가(‘지금 보내기’ 잠금 판정). */
export function mailDirty(form, saved) {
  if (!form || !saved) return false;
  const keys = ['enabled', 'days', 'time', 'includeAdmin', 'to', 'attachExcel', 'includeResources'];
  const norm = (o, k) => (k === 'to' ? String(o.to || '') : JSON.stringify(o[k]));
  return keys.some((k) => norm(form, k) !== norm(saved, k));
}

/** 받는 사람 미리 세기 — 통합 관리자(고르면) ∪ 추가 주소, 대소문자 무시 한 번(서버 digestRecipients 와 같은 규칙). */
// 서버 isidu/mailRules.js EMAIL_RE 의 사본(같은 주소를 화면은 받고 서버는 400 으로 거절하면 안 된다 — 테스트가 같은 입력으로 대조).
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);
export function parseMailList(text) {
  const parts = String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return { list: parts.filter(isEmail), invalid: parts.filter((s) => !isEmail(s)) };
}
export function recipientCount(includeAdmin, adminTo, extra) {
  const seen = new Set();
  for (const a of [...(includeAdmin ? adminTo || [] : []), ...(extra || [])]) {
    const v = String(a || '').trim();
    if (isEmail(v)) seen.add(v.toLowerCase());
  }
  return seen.size;
}
export function daysText(days) {
  const d = [...new Set((days || []).map(Number))].filter((n) => n >= 0 && n <= 6).sort((a, b) => a - b);
  if (d.length === 7) return '매일';
  if (d.join(',') === '1,2,3,4,5') return '평일';
  if (!d.length) return '요일 없음';
  return d.map((x) => DAY_LABELS[x]).join('·');
}

/** 메일 탭 — 본문 구성 안내(v2.791 승인 시안). BoldText 로 그린다. */
export function mailBodyText(rule, dataWeeks) {
  const r = rule || {};
  const crit = r.warnPct != null ? `(${r.warnPct}% 이상 또는 ${r.horizonWeeks}주 안 ${r.critPct}% 도달 예상)` : '';
  const trim = dataWeeks ? `데이터 시트만 최근 ${dataWeeks}주로 줄이고` : '데이터 시트를 줄이고';
  return `본문은 **주간(ISO 주차)** 입니다 — 핵심 지표 · 조치가 필요한 항목${crit} · 지난주 증가량 상위 · PowerScale 풀별 · 법인별 요약 · 값을 못 읽은 장비. 첨부 엑셀에는 **누적된 전 주차**가 포탈 표와 같은 모양으로 들어갑니다(첨부 크기 상한을 넘으면 ${trim} 본문에 밝힙니다).`;
}
/** 보낸 기록의 첨부 상태 — 서버 usageMail record 의 attach 값. */
export const ATTACH_TEXT = Object.freeze({ attached: '엑셀 첨부', trimmed: '엑셀 첨부(데이터 시트 줄임)', failed: '엑셀 못 붙임', off: '' });

/** 화면 아래 범례 문구(BoldText 로 그린다 — **강조** 만 해석). */
export function legendText() {
  return `사용률 색: **${PCT_WARN}% 이상** 주의 · **${PCT_CRIT}% 이상** 위험. 합계는 크기와 사용량을 **둘 다 읽은 장비만** 더하고, 값이 없는 장비가 있으면 ‘값 있음 N/M대’ 로 밝힙니다(0 으로 채우지 않습니다). ‘≈’ 는 기준일에 수집이 없어 기간 안의 가장 최근 관측을 쓴 칸입니다. LUN 의 사용량은 풀에서 할당된 양(Current allocation)이고, 파일시스템은 파일시스템이 보고한 사용량입니다. PowerScale(아이실론)은 **HDD 풀·SSD 풀**을 장비 아래에 따로 보여 줍니다 — 한 매체만 있으면 ‘HDD 풀만’·‘SSD 풀만’ 으로 적고 빈 풀 열을 만들지 않습니다(없는 풀은 0 TB 가 아닙니다).`;
}
