/**
 * 폴더 사용량 화면의 표 행(순수 — dirUsageRows.test.js 가 고정).
 *
 * v2.767(점검 R2-B2-05): 증감·신규·순위 진입 판정은 **서버 compareScans 결과**(`/admin/dir-usage/scan/:id` 의 `compare`)를 그대로 쓴다.
 *   예전에는 화면이 Top-N 끼리 다시 비교해(v2.620 SRV2620-01 이전 방식) 순위에 올라온 기존 폴더를 '신규' 로, 순위 밖으로 밀린 폴더는
 *   아무 표시 없이 보였다 — 메일(같은 데이터라고 안내)과 달랐다(재현: topN=2, a300·b200·c100 → a300·b50·c250).
 *   compare 가 없는 응답(구버전 서버)이면 증감을 지어내지 않고 '—' 로 둔다.
 */
export function dirUsageRows(detail) {
  const scan = detail?.scan;
  if (!scan) return [];
  const delta = detail?.compare?.delta || {};
  const denom = scan.total_bytes || scan.sum_bytes || 0;
  return (scan.entries || []).map((e, i) => {
    const d = Object.prototype.hasOwnProperty.call(delta, e.name) ? delta[e.name] : null;
    return {
      rank: i + 1,
      name: e.name,
      bytes: e.bytes,
      pct: denom > 0 ? Math.round((e.bytes / denom) * 1000) / 10 : null,
      // 기준선 원칙: 직전 관측이 없으면 증감을 만들지 않는다(0 으로 채우지 않는다).
      delta: d && Number.isFinite(d.deltaBytes) ? d.deltaBytes : null,
      isNew: !!d?.isNew,
      entered: !!d?.entered,
      existedBefore: d?.existedBefore ?? null,
    };
  });
}

/** 표 아래 안내 — 메일 본문(report.js)과 같은 사실을 같은 기준으로 말한다. */
export function dirUsageNotes(detail) {
  const c = detail?.compare;
  const out = [];
  if (detail?.baseChanged) out.push('대상 경로(또는 엣지)가 바뀐 뒤 첫 수집이라 증감을 표시하지 않았습니다.');
  if (!c) return out;
  const names = (list) => `${list.slice(0, 10).map((r) => r.name).join(', ')}${list.length > 10 ? ' …' : ''}`;
  const removed = Array.isArray(c.removed) ? c.removed : [];
  const out1 = (Array.isArray(c.rankedOut) ? c.rankedOut : []).filter((r) => r.confirmed);
  const out2 = (Array.isArray(c.rankedOut) ? c.rankedOut : []).filter((r) => !r.confirmed);
  if (removed.length) out.push(`직전 수집에 있었으나 사라진 폴더 ${removed.length}개: ${names(removed)}`);
  if (out1.length) out.push(`순위 밖으로 밀린 폴더 ${out1.length}개(지금도 있음 — 이번 크기는 '그 외' 에 합산): ${names(out1)}`);
  if (out2.length) out.push(`순위 밖으로 벗어난 폴더 ${out2.length}개 — 전체 폴더 목록이 없어 삭제인지 순위 밖인지 확인할 수 없습니다: ${names(out2)}`);
  if (c.enteredUnknown > 0) out.push(`'순위 진입' ${c.enteredUnknown}개는 직전 기록에 전체 폴더 목록이 없어 새로 생긴 폴더인지 알 수 없습니다.`);
  return out;
}

/** 증감 칸 글자 — 메일 fmtDelta 와 같은 규칙. */
export function dirUsageDeltaText(r, human) {
  if (r.isNew) return '신규';
  if (r.entered) return '순위 진입';
  if (r.delta == null) return '—';
  if (r.delta === 0) return '0';
  return `${r.delta > 0 ? '+' : ''}${human(r.delta)}`;
}
