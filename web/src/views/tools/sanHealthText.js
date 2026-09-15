/**
 * views/tools/sanHealthText.js — 월간 점검 **문구·PDF 문서 모델**(v2.519, 순수 모듈).
 *
 * 판정은 서버(`server/src/sanswitch/healthCheck.js`)가 한다. 여기서는 사람이 읽는 말과 PDF 문서
 * 모델만 만든다 — 판정 한 곳, 문구 한 곳(이 저장소의 관례).
 *
 * ⚠ **제1 규칙: '확인 불가' 를 '이상 없음' 에 섞지 않는다.** 점검 보고서는 "이번 달 이상 없음"
 *   결재의 근거다. 그래서 요약 문구는 정상/주의/이상과 **확인 불가를 나란히** 적고, 확인 불가가
 *   있으면 '이상 없음' 이라고 끝내지 않는다.
 * ⚠ 제2 규칙: 기준선이 없으면 '당월 신규 에러' 를 말하지 않는다(누적값만 밝힌다).
 */

export const STATUS_LABEL = { ok: '정상', warn: '주의', bad: '이상', unknown: '확인 불가' };
export const STATUS_COLOR = { ok: 'green', warn: 'amber', bad: 'red', unknown: 'muted' };
export const STATUS_MARK = { ok: '●', warn: '▲', bad: '■', unknown: '○' };
const STAGE_LABEL = {
  1: '1단계 · 하드웨어와 환경',
  2: '2단계 · 포트와 광량',
  3: '3단계 · 에러 카운터와 병목',
  4: '4단계 · 로그와 패브릭',
};
export const stageLabel = (n) => STAGE_LABEL[n] || '기타';

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** `2026-09-15 21:40` (없으면 '—'). PDF·화면이 같은 표기를 쓰게 한다. */
export function stamp(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const d = new Date(t); const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 장비 1대 한 줄 판정 문구.
 * ⚠ 확인 불가가 있으면 **'이상 없음' 으로 끝내지 않는다** — 무엇을 못 봤는지 함께 말한다.
 */
export function deviceVerdict(r) {
  if (!r) return { label: '—', color: 'muted', text: '결과가 없습니다.' };
  const c = r.counts || {};
  const unchecked = n0(r.uncheckedCount);
  const tail = unchecked ? ` · 확인 불가 ${unchecked}항목` : '';
  if (r.collectFailed) {
    return { label: STATUS_LABEL.unknown, color: 'muted', text: `수집이 실패해 점검하지 못했습니다(${unchecked}항목 전부 확인 불가).` };
  }
  if (r.overall === 'bad') return { label: STATUS_LABEL.bad, color: 'red', text: `이상 ${n0(c.bad)}항목 · 주의 ${n0(c.warn)}항목${tail}` };
  if (r.overall === 'warn') return { label: STATUS_LABEL.warn, color: 'amber', text: `주의 ${n0(c.warn)}항목${tail}` };
  if (r.overall === 'unknown') return { label: STATUS_LABEL.unknown, color: 'muted', text: `판정 가능한 항목이 없습니다(${unchecked}항목 확인 불가).` };
  // ⚠ **확인 불가가 남아 있으면 배지 자체를 바꾼다**(v2.519 Chromium 판독에서 발견한 결함).
  //   문구로만 밝히고 배지를 초록 '정상' 으로 두면, 표의 판정 열만 훑는 사람은 색을 보고
  //   '괜찮다' 고 읽는다 — 월간 점검표에서 그게 가장 흔한 오독이다.
  if (unchecked) {
    return {
      label: `${STATUS_LABEL.ok}(일부 미확인)`, color: 'amber',
      text: `확인한 ${n0(c.ok)}항목은 이상 없음 · 확인 불가 ${unchecked}항목`,
    };
  }
  return { label: STATUS_LABEL.ok, color: 'green', text: `${n0(c.ok)}항목 모두 이상 없음` };
}

/** 전체 요약 한 줄. */
export function allSummaryText(summary) {
  if (!summary) return '';
  const b = summary.byOverall || {};
  const parts = [
    `점검 ${n0(summary.devices)}대`,
    `이상 ${n0(b.bad)}`,
    `주의 ${n0(b.warn)}`,
    `정상 ${n0(b.ok)}`,
  ];
  if (n0(b.unknown)) parts.push(`판정 불가 ${n0(b.unknown)}`);
  if (n0(summary.missing)) parts.push(`스냅샷 없음 ${n0(summary.missing)}대`);
  if (n0(summary.uncheckedItems)) parts.push(`확인 불가 항목 합계 ${n0(summary.uncheckedItems)}`);
  return parts.join(' · ');
}

/**
 * 전체 점검 결과를 '조치가 필요한 것 먼저' 로 정렬.
 * 이상 → 주의 → 판정 불가 → 정상, 같은 등급 안에서는 확인 불가가 많은 것 먼저.
 */
export function sortResults(results) {
  const rank = { bad: 0, warn: 1, unknown: 2, ok: 3 };
  return [...(results || [])].sort((a, b) => {
    const d = (rank[a.overall] ?? 9) - (rank[b.overall] ?? 9);
    if (d) return d;
    const u = n0(b.uncheckedCount) - n0(a.uncheckedCount);
    if (u) return u;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ko');
  });
}

/** 기준선 안내 — 없으면 '왜 필요한지' 를 말한다. */
export function baselineNote(baseline) {
  if (!baseline) {
    return '기준선이 없어 **당월 신규 에러**를 판정하지 않았습니다 — 포트 에러 카운터는 부팅 이후 누적이라 누적값만으로는 최근 발생을 알 수 없습니다. 아래 `이번 달 기준선 저장` 을 누르면 다음 점검부터 신규분을 가려 줍니다.';
  }
  const parts = [`기준선 ${stamp(baseline.at)} (포트 ${n0(baseline.portCount)}개)`];
  if (baseline.portsComplete === false) parts.push('⚠ 이 기준선은 중앙에 일부 포트만 있을 때 저장돼 누락 포트는 신규 판정이 되지 않습니다');
  return parts.join(' · ');
}

/* ══════════════ PDF 문서 모델 ══════════════════════════════════════════════════
 * `reportExport.saveDocAsPdf(doc, filename)` 이 받는 모델을 만든다(벡터·한글 임베드 폰트).
 * block = kvrow | heading | note | table
 */

/**
 * `san-switch-health_<대상>_<YYYYMMDD-HHmm>.pdf`
 *
 * ⚠ **파일명은 ASCII 로 만든다**(문서 안 제목·내용은 한글 그대로다). 근거는 실측이다 —
 * 같은 페이지에서 `<a download>` 의 파일명만 바꿔 A/B 하면 헤드리스 Chromium 에서
 * `ascii_report.pdf` → `ascii_report.pdf` 인데 `SAN스위치_점검보고서_전체.pdf` → **`download`**
 * 로 떨어졌다. 실제 데스크톱 Chrome 에서는 한글 파일명이 보존될 가능성이 크지만 **확인하지
 * 못했고**, 월간 점검 보고서는 아카이브에 쌓는 파일이라 이름을 잃으면 쓸모가 없다. 그래서
 * 불확실을 없애는 쪽을 골랐다(서버 export 의 기존 ASCII 규약 — `tools/wasteExport.js` 와 같은 축).
 * 대상 이름에 든 한글·공백은 제거하지 않고 **ASCII 로 치환**한다(영문/숫자/-_ 만 남긴다).
 */
export function reportFileName(scope, now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const tag = String(scope || 'all')
    .replace(/[^A-Za-z0-9._-]+/g, '-')   // 한글·공백·경로 문자 → '-'
    .replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'all';
  return `san-switch-health_${tag}_${ts}.pdf`;
}

/** 장비 1대 상세 보고서 문서 모델. */
export function deviceReportDoc(r, { baseline = null, now = Date.now() } = {}) {
  const v = deviceVerdict(r);
  const c = r?.counts || {};
  const blocks = [
    { type: 'kvrow', items: [
      { k: '종합 판정', v: v.label, color: v.color, sub: v.text },
      { k: '확인한 항목', v: `${n0(c.ok) + n0(c.warn) + n0(c.bad)}개`, sub: `정상 ${n0(c.ok)} · 주의 ${n0(c.warn)} · 이상 ${n0(c.bad)}` },
      { k: '확인 불가', v: `${n0(r?.uncheckedCount)}개`, color: n0(r?.uncheckedCount) ? 'amber' : 'muted', sub: '명령 없음·실행 실패·형식 미인식' },
      { k: '수집 시각', v: stamp(r?.collectedAt), sub: '이 시각의 데이터로 판정했습니다' },
    ] },
    { type: 'note', text: baselineNote(baseline).replace(/\*\*/g, '') },
  ];
  // 단계별로 묶어 체크리스트 순서대로 싣는다.
  for (const stage of [1, 2, 3, 4]) {
    const items = (r?.items || []).filter((i) => i.stage === stage);
    if (!items.length) continue;
    blocks.push({ type: 'heading', text: stageLabel(stage) });
    blocks.push({
      type: 'table',
      columns: [{ label: '항목', w: 38 }, { label: '판정', w: 20, align: 'center' }, { label: '명령', w: 32 }, { label: '결과' }],
      rows: items.map((i) => [
        { text: i.label },
        { text: STATUS_LABEL[i.status] || i.status, align: 'center', color: STATUS_COLOR[i.status] },
        { text: i.cmd || '—' },
        { text: String(i.detail || '').replace(/\*\*/g, '') },
      ]),
    });
    // 근거(evidence)는 이상·주의 항목만 싣는다 — 정상 항목의 근거까지 넣으면 보고서가 부푼다.
    for (const i of items) {
      const ev = (i.evidence || []).slice(0, 20);
      if (!ev.length || i.status === 'ok') continue;
      blocks.push({ type: 'note', text: `· ${i.label} 근거\n${ev.map((e) => `   - ${e}`).join('\n')}` });
    }
  }
  blocks.push({ type: 'note', text: [
    '판정 기준 메모',
    '- 온도·전압 임계는 스위치 자신의 센서 상태(sensorshow 의 is Ok)를 따릅니다 — 포탈이 임계 숫자를 정하지 않습니다.',
    '- 수신 광량은 주의 -9 dBm / 이상 -12 dBm 기준입니다(화면 표시와 같은 기준).',
    '- 포트 에러는 부팅 이후 누적값입니다. 기준선이 있을 때만 당월 신규분을 판정합니다.',
    '- 포탈은 portstatsclear 를 실행하지 않습니다(다른 도구의 기준선을 지우는 파괴적 동작).',
    "- '확인 불가' 는 이상이 없다는 뜻이 아니라 그 항목을 보지 못했다는 뜻입니다.",
  ].join('\n') });

  return {
    title: `SAN 스위치 점검 보고서 — ${r?.name || '-'}`,
    subtitle: [r?.host, r?.model && `모델 ${r.model}`, r?.fabricOs && `FOS ${r.fabricOs}`,
      r?.serial && `S/N ${r.serial}`, r?.domainId != null && `Domain ${r.domainId}`,
      r?.agent ? `수집 엣지 ${r.agent}` : '중앙 직접 수집'].filter(Boolean).join(' · '),
    meta: `보고서 작성 ${stamp(now)} · 판정 데이터 수집 ${stamp(r?.collectedAt)}`,
    blocks,
  };
}

/** 전체 점검 보고서 문서 모델 — 요약표 + 장비별 상세를 이어 붙인다. */
export function allReportDoc(payload, { now = Date.now(), maxDetail = 30 } = {}) {
  const summary = payload?.summary || {};
  const results = sortResults(payload?.results || []);
  const b = summary.byOverall || {};
  const baseMap = new Map((payload?.baselines || []).map((x) => [x.deviceId, x]));
  const blocks = [
    { type: 'kvrow', items: [
      { k: '점검 대상', v: `${n0(summary.devices)}대`, sub: `등록 ${n0(summary.registered)}대 중` },
      { k: '이상', v: `${n0(b.bad)}대`, color: n0(b.bad) ? 'red' : 'muted' },
      { k: '주의', v: `${n0(b.warn)}대`, color: n0(b.warn) ? 'amber' : 'muted' },
      { k: '정상', v: `${n0(b.ok)}대`, color: n0(b.ok) ? 'green' : 'muted' },
    ] },
  ];
  if (n0(summary.missing) || n0(b.unknown) || n0(summary.uncheckedItems)) {
    blocks.push({ type: 'note', text: [
      '점검하지 못한 부분',
      n0(summary.missing) ? `- 스냅샷이 없어 점검 대상에서 빠진 스위치 ${n0(summary.missing)}대 — 먼저 수집하세요.` : null,
      n0(b.unknown) ? `- 판정 가능한 항목이 하나도 없던 스위치 ${n0(b.unknown)}대.` : null,
      n0(summary.uncheckedItems) ? `- 확인 불가 항목 합계 ${n0(summary.uncheckedItems)}개(명령 없음·실행 실패·형식 미인식).` : null,
      "이 숫자가 0 이 아니면 '전부 이상 없음' 이라고 결론 내릴 수 없습니다.",
    ].filter(Boolean).join('\n') });
  }
  blocks.push({ type: 'heading', text: '스위치별 요약' });
  blocks.push({
    type: 'table',
    columns: [{ label: '스위치', w: 34 }, { label: '법인', w: 22 }, { label: '판정', w: 18, align: 'center' },
      { label: '확인불가', w: 18, align: 'right' }, { label: '내용' }],
    rows: results.map((r) => {
      const v = deviceVerdict(r);
      return [
        { text: r.name || r.deviceId },
        { text: r.datacenterName || '—' },
        { text: v.label, align: 'center', color: v.color },
        { text: String(n0(r.uncheckedCount)), align: 'right', color: n0(r.uncheckedCount) ? 'amber' : 'muted' },
        { text: v.text },
      ];
    }),
  });
  for (const m of (payload?.missing || []).slice(0, 50)) {
    blocks.push({ type: 'note', text: `· 점검 제외 — ${m.name || m.deviceId}: 수집된 스냅샷이 없습니다${m.agent ? `(엣지 ${m.agent} 수집 대상)` : ''}.` });
  }

  // 상세는 조치가 필요한 것부터. 상한을 두고 **자른 개수를 밝힌다**(조용한 상한 금지).
  const detail = results.filter((r) => r.overall !== 'ok').slice(0, maxDetail);
  const omitted = results.filter((r) => r.overall !== 'ok').length - detail.length;
  if (detail.length) {
    blocks.push({ type: 'heading', text: '조치가 필요한 스위치 상세' });
    for (const r of detail) {
      blocks.push({ type: 'heading', text: `${r.name || r.deviceId}${r.datacenterName ? ` · ${r.datacenterName}` : ''}`, right: stamp(r.collectedAt) });
      const rows = (r.items || []).filter((i) => i.status !== 'ok').map((i) => [
        { text: `${stageLabel(i.stage).slice(0, 3)} ${i.label}` },
        { text: STATUS_LABEL[i.status] || i.status, align: 'center', color: STATUS_COLOR[i.status] },
        { text: String(i.detail || '').replace(/\*\*/g, '') },
      ]);
      blocks.push({ type: 'table', columns: [{ label: '항목', w: 46 }, { label: '판정', w: 20, align: 'center' }, { label: '결과' }], rows });
      const bl = baseMap.get(r.deviceId) || null;
      if (!bl) blocks.push({ type: 'note', text: '· 에러 기준선 없음 — 당월 신규 에러는 판정하지 않았습니다.' });
    }
  }
  if (omitted > 0) blocks.push({ type: 'note', text: `· 상세는 ${maxDetail}대까지만 실었습니다 — ${omitted}대는 생략됐습니다(요약표에는 전부 있습니다).` });

  return {
    title: 'SAN 스위치 월간 점검 보고서',
    subtitle: allSummaryText(summary),
    meta: `보고서 작성 ${stamp(now)}`,
    blocks,
  };
}
