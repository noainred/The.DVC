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
    return '기준선이 없어 **당월 신규 에러**를 판정하지 않았습니다 — 포트 에러 카운터는 부팅 이후 누적이라 누적값만으로는 최근 발생을 알 수 없습니다. 아래 ‘이번 달 기준선 저장’ 을 누르면 다음 점검부터 신규분을 가려 줍니다.';
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
export function deviceReportDoc(r, { baseline = null, now = Date.now(), ports = null, problemPorts = [], zoningNote = '', history = null } = {}) {
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
      // ⚠ 모든 열에 `w` 를 **명시**한다 — 하나라도 빼면 그 열이 기본 가중치 1 을 받아 1/91 로
      //   찌그러진다(v2.521 실제 사고. `reportExport.drawTable` 머리말 참조).
      columns: [{ label: '항목', w: 22 }, { label: '판정', w: 12, align: 'center' }, { label: '명령', w: 20 }, { label: '결과', w: 46 }],
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
  // v2.521 — 전 포트 점검 + 이상·주의 포트의 연결 장비·조닝 상대.
  blocks.push(...portBlocks(ports, problemPorts, { zoningNote }));
  // v2.522 — 최근 점검과의 비교(사용자 요청 "최근 10번 점검과 비교").
  blocks.push(...historyBlocks(history));
  blocks.push({ type: 'note', text: [
    '판정 기준 메모',
    '- 온도·전압 임계는 스위치 자신의 센서 상태(sensorshow 의 is Ok)를 따릅니다 — 포탈이 임계 숫자를 정하지 않습니다.',
    '- 수신 광량은 주의 -9 dBm / 이상 -12 dBm 기준이며, 링크가 올라온 포트만 판정합니다',
    '  (링크가 없으면 상대가 빛을 보내지 않아 Rx 가 낮은 것이 정상입니다 — 판정에서 제외한 개수는 위에 적었습니다).',
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
    columns: [{ label: '스위치', w: 20 }, { label: '법인', w: 14 }, { label: '판정', w: 14, align: 'center' },
      { label: '확인불가', w: 10, align: 'right' }, { label: '내용', w: 42 }],
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
      blocks.push({ type: 'table', columns: [{ label: '항목', w: 26 }, { label: '판정', w: 12, align: 'center' }, { label: '결과', w: 62 }], rows });
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

/* ══════════════════ v2.521 — 전 포트 점검 · 불량 포트 세부정보 ══════════════════
 * 사용자 요청: "모든 포트에 대해서 점검" · "불량인 포트는 어떤 서버인지, 어디와 조닝되어
 * 있는지에 대한 세부정보를 표시해줘" · (신고) "포트 광량이 장애수준인데 확인해보면 사용하지
 * 않는 포트에, 사용하지 않는 포트는 제외 해야 맞는거 같다".
 */

/** 포트 판정 라벨 — `idle`(링크 없음)은 **이상이 아니다**. 초록도 아니다(볼 필요가 없었다). */
export const PORT_VERDICT = Object.freeze({
  bad: { label: '이상', color: 'red' },
  warn: { label: '주의', color: 'amber' },
  unknown: { label: '확인 불가', color: 'amber' },
  ok: { label: '정상', color: 'green' },
});
export const portVerdict = (v) => PORT_VERDICT[String(v)] || { label: String(v || '—'), color: 'muted' };

/** 광량 셀 문구 — `skipped` 는 '정상' 이 아니라 **판정 대상 아님**이다(거짓 경보의 원인이었다). */
export function opticalText(row) {
  if (!row) return '—';
  if (row.optical === 'skipped') return `${row.rxPowerDbm == null ? '—' : `${row.rxPowerDbm} dBm`} (링크 없음 — 판정 제외)`;
  if (row.optical === 'unknown') return row.rxPowerDbm == null ? '값 없음' : `${row.rxPowerDbm} dBm (판정 불가)`;
  return `${row.rxPowerDbm} dBm`;
}

/** 에러 셀 문구 — 누적과 기준선 이후 신규를 **나눠서** 말한다. */
export function errorText(row) {
  if (!row) return '—';
  // v2.605 WEB2605-04: k/m/g 축약 카운터로 **신규 판정만 보류**한 포트는 누적이 읽혀 있다 — '카운터 없음'
  //   이라 말하면 사용자가 명령·권한을 의심한다(조치가 다르다).
  if (row.errors === 'unknown' && row.errHeld === 'approx') return `누적 ${row.errSum ?? '—'} (축약 표기 — 신규 판정 보류)`;
  if (row.errors === 'unknown') return '카운터 없음';
  if (row.errNew != null) return `신규 ${row.errNew} (누적 ${row.errSum})`;
  return `누적 ${row.errSum} (기준선 없음)`;
}

/**
 * 전 포트 점검 요약 한 줄.
 * ⚠ 링크 없는 포트 수를 **밝힌다** — 그 포트를 광량 판정에서 뺐기 때문이다(조용히 빼면 거짓).
 */
export function portCheckSummary(pc) {
  if (!pc || !pc.rows) return '';
  const c = pc.counts || {};
  const parts = [`전 포트 ${n0(c.total)}개`];
  if (n0(c.bad)) parts.push(`이상 ${n0(c.bad)}`);
  if (n0(c.warn)) parts.push(`주의 ${n0(c.warn)}`);
  if (n0(c.unknown)) parts.push(`확인 불가 ${n0(c.unknown)}`);
  parts.push(`정상 ${n0(c.ok)}`);
  if (n0(c.idle)) parts.push(`링크 없음 ${n0(c.idle)}(광량 판정 제외)`);
  if (!pc.complete) parts.push(`⚠ 중앙에 ${n0(pc.portsOmitted)}포트 누락 — 전 포트를 본 것이 아닙니다`);
  return parts.join(' · ');
}

/** 기준선 없음 안내 — 전 포트 표에서도 한 번만 말한다. */
export function portBaselineNote(pc) {
  if (!pc) return '';
  return pc.baselineAt
    ? `에러는 기준선(${stamp(pc.baselineAt)}) 이후 **신규분**으로 판정했습니다.`
    : '에러 기준선이 없어 **누적값만** 표시했습니다 — 신규 발생분은 기준선을 저장한 다음 점검부터 가려집니다.';
}

/** 역할 배지 문구 — 확정(네임서버)과 추정(zone 구조)을 **구분**한다(v2.511 규칙). */
export const SIDE_LABEL = Object.freeze({ initiator: '이니시에이터', target: '타깃', middle: '겸용', unknown: '미확정' });
export function sideText(n) {
  if (!n) return '—';
  const base = SIDE_LABEL[n.side] || n.side || '미확정';
  return n.confidence === 'confirmed' ? `${base}(확정)` : `${base}(추정)`;
}

/**
 * 불량 포트 1개의 세부 문구.
 * ⚠ WWN 을 모르는 것을 '조닝 안 됨' 이라 말하지 말 것 — 우리가 그 포트의 WWN 을 모를 뿐이다.
 */
export function problemPortText(p, note = '') {
  if (!p) return '';
  if (!p.wwns?.length) {
    return note
      || '이 포트에 로그인한 WWN 을 알 수 없어(링크 없음 또는 네임서버 미조회) 연결 장비·조닝 상대를 표시할 수 없습니다.';
  }
  if (!p.zones?.length) {
    return note || `연결 장비는 확인했지만 이 WWN 이 속한 zone 을 찾지 못했습니다(조닝에 없거나 조닝 정보가 잘렸습니다).`;
  }
  const om = n0(p.zonesOmitted) ? ` (zone ${n0(p.zonesOmitted)}개는 생략)` : '';
  return `zone ${n0(p.zoneCount)}개 · 조닝 상대 ${n0(p.partnerCount)}개${om}`;
}

/** 전 포트 점검을 PDF 문서 모델 블록으로. 상한을 두고 **자른 개수를 밝힌다**. */
export function portBlocks(pc, problemPorts = [], { maxRows = 80, zoningNote = '' } = {}) {
  const blocks = [];
  if (!pc || !pc.rows?.length) return blocks;
  blocks.push({ type: 'heading', text: '전 포트 점검' });
  blocks.push({ type: 'note', text: `${portCheckSummary(pc)}\n${portBaselineNote(pc).replace(/\*\*/g, '')}` });
  const rows = [...pc.rows].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.index - b.index);
  const shown = rows.slice(0, maxRows);
  blocks.push({
    type: 'table',
    // ⚠ 모든 열에 `w` 명시(빼면 그 열이 1/합계 로 찌그러진다 — v2.521 사고).
    // ⚠ 포트·판정을 너무 좁게 주면 PDF 에서 두 열이 붙어 보인다(실제 출력 판독으로 조정).
    columns: [{ label: '포트', w: 9, align: 'right' }, { label: '판정', w: 13, align: 'center' },
      { label: '상태', w: 14 }, { label: '연결 장비', w: 28 }, { label: '광량(Rx)', w: 18 }, { label: '에러', w: 18 }],
    rows: shown.map((r) => [
      { text: String(r.index), align: 'right' },
      { text: portVerdict(r.verdict).label, align: 'center', color: portVerdict(r.verdict).color },
      { text: r.stateRaw || r.state || '—' },
      { text: r.name || '—' },
      { text: opticalText(r) },
      { text: errorText(r) },
    ]),
  });
  if (rows.length > shown.length) blocks.push({ type: 'note', text: `· 표는 ${maxRows}포트까지만 실었습니다 — ${rows.length - shown.length}포트는 생략됐습니다.` });

  const probs = (problemPorts || []).filter(Boolean);
  if (probs.length) {
    blocks.push({ type: 'heading', text: '이상·주의 포트의 연결 장비와 조닝 상대' });
    if (zoningNote) blocks.push({ type: 'note', text: `· ${zoningNote}` });
    for (const p of probs) {
      const lines = [`· 포트 ${p.index}${p.attachedName ? ` — ${p.attachedName}` : ''} (${problemPortText(p, zoningNote)})`];
      for (const w of (p.wwns || [])) lines.push(`   - ${w.label}  ${w.wwn}${w.vendor ? ` · ${w.vendor}` : ''} · ${sideText(w)}`);
      for (const z of (p.zones || [])) {
        lines.push(`   [zone] ${z.name} (멤버 ${n0(z.memberCount)})`);
        for (const pt of (z.partners || [])) lines.push(`      ↔ ${pt.label}  ${pt.wwn} · ${sideText(pt)}`);
        if (n0(z.partnersOmitted)) lines.push(`      ↔ … ${n0(z.partnersOmitted)}개 생략`);
      }
      blocks.push({ type: 'note', text: lines.join('\n') });
    }
  }
  return blocks;
}

const ORDER = ['bad', 'warn', 'unknown', 'ok'];

/* ══════════════ v2.522 — 대체 명령 표시 · 점검 이력 비교 ══════════════
 * 사용자 요청: "실행되지 않는 명령어가 있는데, 결과가 비슷한 실행 가능한 명령어를 찾아서
 * 대체해줘" · "점검 결과를 DB 로 저장해서 최근 10번 점검과 비교 하는 기능" · "isl 점검 기능 추가".
 */

/**
 * 명령 셀 문구 — **대체 명령을 썼으면 그 사실을 말한다**.
 * 원 명령과 출력이 완전히 같지 않을 수 있으므로(예: `tempshow` 는 전압을 주지 않는다) 숨기면
 * 안 된다. 페이저 자동 응답으로 받은 것(`errshow`)과 상한으로 잘린 것도 밝힌다.
 */
export function cmdText(i) {
  if (!i) return '—';
  if (!i.usedCmd || i.usedCmd === i.cmd) return i.cmd || '—';
  return `${i.usedCmd} (대체)`;
}
export function cmdNote(i) {
  if (!i?.usedCmd || i.usedCmd === i.cmd) return '';
  const bits = [`원 명령 ‘${i.cmd}’ 대신 ‘${i.usedCmd}’ 로 확인했습니다`];
  if (i.usedPaged) bits.push('페이저 자동 응답으로 받았습니다');
  if (i.usedTruncated) bits.push('**출력 상한에 걸려 일부만** 받았습니다');
  return `${bits.join(' · ')}.`;
}

/** 변화 방향 라벨 — `unknown` 을 `ok` 로 흡수하지 않는다(v2.522 규칙). */
export const CHANGE_LABEL = Object.freeze({
  worse: { label: '악화', color: 'red', mark: '▲' },
  better: { label: '호전', color: 'green', mark: '▼' },
  nowKnown: { label: '이제 확인됨', color: 'blue', mark: '◆' },
  nowUnknown: { label: '확인 불가로 바뀜', color: 'amber', mark: '◇' },
});
export const changeLabel = (dir) => CHANGE_LABEL[String(dir)] || { label: String(dir || '변화'), color: 'muted', mark: '·' };

/**
 * 최근 N회 비교 요약 한 줄. **'비슷하다' 같은 뭉갠 말을 하지 않는다** — 무엇이 몇 개
 * 새로 생겼고 무엇이 해소됐는지 센다.
 */
export function compareSummary(c) {
  if (!c) return '';
  if (!c.compared) return c.note || '저장된 점검 이력이 없습니다.';
  if (c.compared === 1) return c.note || '비교할 이전 점검이 없습니다 — 다음 점검부터 변화를 가려 줍니다.';
  const parts = [`최근 ${c.compared}회 기록`];
  if (!c.changes.length) parts.push('직전 점검과 **항목 판정이 모두 같습니다**');
  else {
    if (c.newProblems.length) parts.push(`새로 생긴 문제 ${c.newProblems.length}건(${c.newProblems.slice(0, 3).join(', ')}${c.newProblems.length > 3 ? ' 등' : ''})`);
    if (c.resolved.length) parts.push(`해소 ${c.resolved.length}건(${c.resolved.slice(0, 3).join(', ')}${c.resolved.length > 3 ? ' 등' : ''})`);
    const nk = c.changes.filter((x) => x.dir === 'nowKnown').length;
    const nu = c.changes.filter((x) => x.dir === 'nowUnknown').length;
    if (nk) parts.push(`이제 확인된 항목 ${nk}건`);
    if (nu) parts.push(`확인 불가로 바뀐 항목 ${nu}건`);
    const other = c.changes.length - c.newProblems.length - c.resolved.length - nk - nu;
    if (other > 0) parts.push(`그 밖의 판정 변화 ${other}건`);
  }
  if (c.persistent?.length) parts.push(`**${c.compared}회 내내 문제인 항목 ${c.persistent.length}건**(${c.persistent.slice(0, 3).map((p) => p.label).join(', ')})`);
  return parts.join(' · ');
}

/** 기록 여부 안내 — '수집 1회 = 기록 1회' 를 사람 말로. */
export function recordNote(rec) {
  if (!rec) return '';
  if (rec.saved) return '이번 점검 결과를 이력에 기록했습니다.';
  return rec.reason || '이번 점검은 이력에 기록하지 않았습니다.';
}

/** 이력 비교를 PDF 블록으로 — 변화가 없으면 그 사실도 적는다. */
export function historyBlocks(history, { maxRows = 10 } = {}) {
  const blocks = [];
  const c = history?.compare;
  if (!c) return blocks;
  blocks.push({ type: 'heading', text: '최근 점검과의 비교' });
  blocks.push({ type: 'note', text: compareSummary(c).replace(/\*\*/g, '') });
  if (c.trend?.length) {
    blocks.push({
      type: 'table',
      columns: [{ label: '점검 시각', w: 26 }, { label: '종합', w: 14, align: 'center' },
        { label: '이상', w: 10, align: 'right' }, { label: '주의', w: 10, align: 'right' },
        { label: '확인 불가', w: 14, align: 'right' }, { label: '정상', w: 10, align: 'right' },
        { label: '이상 포트', w: 16, align: 'right' }],
      rows: [...c.trend].reverse().slice(0, maxRows).map((t) => [
        { text: stamp(t.at) },
        { text: STATUS_LABEL[t.overall] || t.overall, align: 'center', color: STATUS_COLOR[t.overall] },
        { text: String(n0(t.bad)), align: 'right', color: n0(t.bad) ? 'red' : 'muted' },
        { text: String(n0(t.warn)), align: 'right', color: n0(t.warn) ? 'amber' : 'muted' },
        { text: String(n0(t.unknown)), align: 'right', color: n0(t.unknown) ? 'amber' : 'muted' },
        { text: String(n0(t.ok)), align: 'right' },
        { text: t.portsBad == null ? '—' : String(t.portsBad), align: 'right' },
      ]),
    });
  }
  if (c.changes?.length) {
    blocks.push({
      type: 'table',
      columns: [{ label: '항목', w: 30 }, { label: '변화', w: 20, align: 'center' },
        { label: '직전', w: 14, align: 'center' }, { label: '이번', w: 14, align: 'center' }, { label: '내용', w: 42 }],
      rows: c.changes.map((x) => [
        { text: x.label },
        { text: changeLabel(x.dir).label, align: 'center', color: changeLabel(x.dir).color },
        { text: STATUS_LABEL[x.from] || x.from, align: 'center', color: STATUS_COLOR[x.from] },
        { text: STATUS_LABEL[x.to] || x.to, align: 'center', color: STATUS_COLOR[x.to] },
        { text: String(x.detail || '').replace(/\*\*/g, '') },
      ]),
    });
  }
  return blocks;
}

/**
 * 조닝 상대 조회 상한(v2.605 WEB2605-02). 서버는 문제 포트를 상한(기본 40)까지만 조닝 조회하고 넘친 개수를
 * `problemPortsOmitted` 로 싣는다 — 그 포트에 '이상·주의 목록에 없다' 고 말하면 거짓이다(실제로는 목록에 있고
 * 상한 때문에 건너뛰었다).
 */
export function problemOmittedNote(omitted) {
  const n = Number.isFinite(omitted) ? omitted : 0;
  if (n <= 0) return '';
  return `문제 포트가 많아 조닝 상대 조회 상한을 넘었습니다 — ${n}개 포트는 조닝 상대를 조회하지 않았습니다.`;
}

/** 조닝 정보가 없는 포트의 문구 — 상한으로 건너뛴 문제 포트와 원래 대상이 아닌 포트를 구분한다. */
export function portZoningFallback(row, zoningNote, omitted) {
  const isProblem = row && (row.verdict === 'bad' || row.verdict === 'warn');
  if (isProblem && Number.isFinite(omitted) && omitted > 0) {
    return `이 포트는 문제 포트지만 조닝 상대 조회 상한을 넘어 조회하지 않았습니다(${omitted}개 생략).`;
  }
  return zoningNote || '이 포트는 이상·주의 목록에 없어 조닝 상대를 조회하지 않았습니다.';
}
