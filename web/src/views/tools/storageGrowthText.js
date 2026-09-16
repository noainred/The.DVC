/**
 * views/tools/storageGrowthText.js — 스토리지 증가량 화면의 **판정·문구·서식**(순수 · v2.531).
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다 — 그래서 판정과 문구는
 * 전부 여기 두고 vitest 로 회귀 고정한다(`accessDeniedText.js`·`loadState.js` 와 같은 관례).
 *
 * ── 이 모듈이 지키는 규칙 ────────────────────────────────────────────────────────
 *  ① **`null` 을 `0` 으로 쓰지 않는다.** 증가량 `null` 은 '기준선이 없어 계산하지 못함' 이고
 *     `0` 은 '변화 없음' 이다. 둘을 섞으면 임원 보고서가 "증가 없음" 이라 거짓말한다.
 *     ⚠ `Number(null) === 0` 이므로 **`v == null` 을 먼저 본다**(v2.525 에서 실제로 잡힌 결함).
 *  ② **감소(−)를 숨기지 않는다.** 부호를 붙여 그대로 보여준다.
 *  ③ **단위는 사용자가 고른다**(사용자 요청 "1기가 단위/1TB 단위로 구분") — 자동 축약은
 *     기본값일 뿐이고, GB/TB 를 고르면 **전 칸이 같은 단위**여서 눈으로 세로 비교가 된다.
 */

/** 단위 선택지 — 화면 토글이 이 표로 그려진다(숫자를 화면에 박지 않는다). */
export const GROWTH_UNITS = Object.freeze([
  { key: 'auto', label: '자동', hint: '값 크기에 맞춰 GB/TB/PB 를 섞어 씁니다. 한눈에 크기를 보기 좋지만 칸끼리 비교하기는 어렵습니다.' },
  { key: 'gb', label: 'GB', div: 1024 ** 3, digits: 1, hint: '전 칸을 GB 로 통일합니다. 작은 증가를 보기에 좋습니다.' },
  { key: 'tb', label: 'TB', div: 1024 ** 4, digits: 2, hint: '전 칸을 TB 로 통일합니다. 대용량 어레이 비교에 좋습니다.' },
]);

const UNIT_BY_KEY = new Map(GROWTH_UNITS.map((u) => [u.key, u]));

/** 절대 용량 표기(자동 축약). 음수도 그대로 받는다. */
export function bytesAuto(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  const abs = Math.abs(n);
  const U = [['PB', 1024 ** 5], ['TB', 1024 ** 4], ['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];
  for (const [label, div] of U) {
    if (abs >= div) return `${(n / div).toFixed(digits)} ${label}`;
  }
  return `${n.toFixed(0)} B`;
}

/**
 * 고정 단위 표기. `unitKey` 가 'auto' 면 자동 축약.
 * @returns {string|null} null 이면 '값 없음' — 호출부가 '—' 를 그린다(0 을 쓰지 말 것).
 */
export function bytesIn(v, unitKey = 'auto') {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const u = UNIT_BY_KEY.get(unitKey);
  if (!u || !u.div) return bytesAuto(v);
  return `${(Number(v) / u.div).toFixed(u.digits)} ${u.label}`;
}

/**
 * 증가량 한 칸의 표시 정보.
 * @param {object|null} g `growth.js growthFor()` 결과
 * @returns {{text:string, tone:'up'|'down'|'flat'|'none', title:string, exact:boolean}}
 */
export function growthCell(g, unitKey = 'auto') {
  if (!g || g.bytes == null) {
    // 규칙 ① — 왜 못 냈는지까지 말한다. '0' 이라 쓰지 않는다.
    const reason = g?.reason;
    const why = reason === 'no-baseline'
      ? '이 기간의 기준선이 아직 없습니다(관측 기간이 짧습니다). 기다리면 채워집니다.'
      : reason === 'no-latest-used'
        ? '최근 관측에 사용량 값이 없습니다(수집이 용량을 읽지 못했습니다).'
        : reason === 'no-baseline-used'
          ? '기준선 날짜의 사용량 값이 비어 있습니다.'
          : '계산에 필요한 값이 없습니다.';
    return { text: '—', tone: 'none', title: why, exact: false };
  }
  const n = Number(g.bytes);
  const body = bytesIn(Math.abs(n), unitKey) ?? '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const parts = [];
  // 기준선은 **날짜로** 말한다. 라우트가 `baselineLabel` 을 붙여 주며, 없을 때만 일 인덱스를
  // 쓴다(사람에게 숫자 인덱스를 보여주는 것은 마지막 수단이다).
  if (g.baselineLabel || g.baselineDay != null) parts.push(`기준선 ${g.baselineLabel || `일 ${g.baselineDay}`}`);
  if (g.spanDays != null) parts.push(`실제 구간 ${g.spanDays}일`);
  if (g.exact === false) parts.push('요청한 날짜에 관측이 없어 그 이전 가장 가까운 날과 비교했습니다');
  if (g.perDayBytes != null) parts.push(`하루 평균 ${bytesIn(g.perDayBytes, unitKey) ?? '—'}`);
  return {
    text: n === 0 ? '0' : `${sign}${body}`,
    tone: n > 0 ? 'up' : n < 0 ? 'down' : 'flat',
    title: parts.join(' · '),
    exact: g.exact !== false,
  };
}

/**
 * 합계 칸 — 일부만 더했으면 **반드시 그 사실을 말한다**(growth.js 규칙 ③의 화면 쪽 짝).
 */
export function totalCell(t, unitKey = 'auto') {
  const base = growthCell(t, unitKey);
  if (!t) return base;
  const notes = [];
  if (t.partial) notes.push(`${t.measured}대만 합산했습니다 — ${t.missing}대는 이 기간의 기준선이 없어 뺐습니다(전체 합이 아닙니다).`);
  else if (t.missing > 0 && !t.measured) notes.push(`${t.missing}대 모두 이 기간의 기준선이 없습니다.`);
  return { ...base, partial: !!t.partial, title: [base.title, ...notes].filter(Boolean).join(' · ') };
}

/** 소진 예상 문구 — 근거 기간을 반드시 함께 적는다(1일 추세로 5년을 예측하지 않게). */
export function fullEtaText(d) {
  if (!d || d.days == null) return null;
  if (d.days <= 0) return { text: '이미 가득', tone: 'bad', title: '남은 공간이 없습니다.' };
  const y = d.days / 365;
  const text = d.days < 60 ? `${d.days}일` : y >= 1 ? `약 ${y.toFixed(1)}년` : `약 ${Math.round(d.days / 30)}개월`;
  return {
    text,
    tone: d.days < 90 ? 'bad' : d.days < 365 ? 'warn' : 'ok',
    title: `${d.basisLabel} 추세를 그대로 이어 간다고 가정한 계산입니다(예측이 아니라 산술 외삽입니다).`,
  };
}

/**
 * 보고서 상단 요약 문장 — **읽은 것만 말한다**.
 * `db:false` 면 수치를 말하지 않는다(DB 가 없으면 이력 자체가 없다).
 */
export function headline(data, unitKey = 'auto') {
  if (!data) return { kind: 'loading', title: '불러오는 중…', body: '' };
  if (data.db === false) {
    return { kind: 'no-db', title: '이력 데이터베이스를 쓸 수 없습니다',
      body: '이 서버에서 SQLite 를 열지 못해 사용량 이력이 **저장되지 않고 있습니다**. 증가량은 이력이 있어야 계산할 수 있습니다.' };
  }
  const n = data.devices?.length || 0;
  if (!n) {
    return { kind: 'empty', title: '아직 집계할 이력이 없습니다',
      body: '스토리지 수집이 한 번이라도 성공하면 그날부터 하루 1행씩 쌓입니다. **기간 비교는 그 기간만큼 지나야** 나옵니다.' };
  }
  const t = data.totals || {};
  const pieces = [`장비 **${n}대**`];
  if (t.usedBytes != null && t.totalBytes != null) {
    pieces.push(`사용 **${bytesAuto(t.usedBytes)}** / 전체 **${bytesAuto(t.totalBytes)}**${t.pct != null ? ` (${t.pct}%)` : ''}`);
  }
  if (t.unknownUsed > 0) pieces.push(`사용량을 읽지 못한 장비 **${t.unknownUsed}대**는 합계에서 빠졌습니다`);
  return { kind: 'ok', title: `기준일 ${data.asOfLabel || ''}`, body: pieces.join(' · ') };
}

/**
 * 표에 뜨지 않는 장비 안내 — **조용히 빼지 않는다**.
 * 등록은 돼 있는데 이력이 0줄인 장비(수집 전·수집 실패 중·용량을 못 읽는 장비)를 구분해 말한다.
 */
export function missingNote(noHistory) {
  const list = noHistory || [];
  if (!list.length) return null;
  const off = list.filter((d) => d.enabled === false).length;
  const on = list.length - off;
  const parts = [];
  if (on) parts.push(`**${on}대**는 등록돼 있지만 사용량 이력이 아직 없습니다 — 수집이 한 번도 성공하지 못했거나, 용량을 보고하지 않는 장비(예: VPLEX 같은 가상화 계층)입니다.`);
  if (off) parts.push(`**${off}대**는 등록이 꺼져 있어 수집 대상이 아닙니다.`);
  return { count: list.length, text: parts.join(' ') , names: list.slice(0, 20).map((d) => d.name || d.id), omitted: Math.max(0, list.length - 20) };
}

/** 증가량 크기 → 히트맵 강도(0~1). 표의 어느 칸이 큰지 눈으로 잡히게 한다. */
export function heat(bytes, maxAbs) {
  if (bytes == null || !maxAbs) return 0;
  return Math.min(1, Math.abs(Number(bytes)) / maxAbs);
}

/** 그 기간 열에서 절대값이 가장 큰 증가량(히트맵 정규화 기준). */
export function maxAbsFor(devices, periodKey) {
  let m = 0;
  for (const d of devices || []) {
    const b = d.growth?.[periodKey]?.bytes;
    if (b != null && Number.isFinite(Number(b))) m = Math.max(m, Math.abs(Number(b)));
  }
  return m;
}
