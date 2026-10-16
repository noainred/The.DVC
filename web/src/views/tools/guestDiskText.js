/**
 * views/tools/guestDiskText.js — 게스트 디스크 리포트 안내 문구(순수, v2.600 감사 LO2600-07).
 * 서버(`guestdisk/service.js`·`poller.js lastResult.partsUnknown`)가 여유 공간을 보고하지 않은 파티션을
 * 할당·사용 합계에서 **빼고** 개수를 준다. 화면이 말하지 않으면 '전부 반영했다' 는 거짓이 된다.
 */
/** @returns {string} 빈 문자열이면 표시하지 않는다. */
export function partsUnknownNote(n) {
  const k = Number(n);
  if (!Number.isFinite(k) || k <= 0) return '';
  return `최근 수집에서 여유 공간을 보고하지 않은 파티션 ${k}개는 할당·사용 합계와 회수 후보에서 **제외**했습니다(0 으로 채우지 않았습니다).`;
}

/**
 * 부분 합 VM 안내(v2.631 감사 A6-2631-04 — 서버 v2.630 A2-01·v2.631 R2631-01 의 화면 부분).
 * 서버(`guestdisk/db.js commitCollection` → `poller.js lastResult`)는 여유를 보고하지 않은 파티션이 있는 VM 의 값이
 * **부분 합**이라 추이(vm_series)에 적재하지 않고, 최신 표에는 직전 온전한 값을 유지하거나(partialHeld) 부분 합을
 * 표지와 함께 넣거나(partialShown) 새 값을 만들 수 없어 직전 행을 그대로 둔다(partialStale). 필드가 없으면(구버전 서버·
 * 부분 합 0) 표시하지 않는다.
 * @returns {string} 빈 문자열이면 표시하지 않는다.
 */
export function partialVmsNote(lastResult) {
  const cnt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);
  const r = lastResult || {};
  const vms = cnt(r.partialVms);
  if (!vms) return '';
  const held = cnt(r.partialHeld);
  const shown = cnt(r.partialShown);
  const stale = cnt(r.partialStale);
  const parts = [];
  if (held) parts.push(`직전 온전한 값 유지 ${held}대`);
  if (shown) parts.push(`부분 합을 표지와 함께 표시 ${shown}대`);
  if (stale) parts.push(`새 값을 만들 수 없어 직전 행 그대로 ${stale}대`);
  return `최근 수집에서 일부 파티션의 여유를 보고하지 않은 VM ${vms}대는 값이 **부분 합**이라 **추이에 적재하지 않았습니다**${parts.length ? `(${parts.join(' · ')})` : ''} — 그 VM 의 추이는 이번 주기에 비어 있을 수 있습니다.`;
}

const posInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

/**
 * 회수 합계의 신선도·삭제된 vCenter 안내(v2.743 감사 VC-02 — 서버 `guestdisk/service.js reclaimReport` 의 화면 부분).
 * 서버는 ① 등록부·스냅샷 어디에도 없는 vCenter(등록에서 지운 vCenter)의 행을 합계·목록·CSV 에서 **빼고** 개수(orphanRows·orphanVcenters)를,
 * ② 마지막 적재가 수집 주기 × 3(staleAfterMs — 부분 합 보류와 같은 경계)보다 오래된 행은 합계에 **남긴 채** 개수·용량(staleRows·staleReclaimGB)을 준다.
 * 오래된 행을 합계에서 빼지 않는 이유: 비활성·점검중·수집이 꺼진 법인의 마지막 관측은 의도로 남기는 값이다(빼면 그 법인의 회수 후보가 통째로 사라진다).
 * 필드가 없으면(구버전 서버) 말하지 않는다.
 * @returns {string} 빈 문자열이면 표시하지 않는다.
 */
export function reclaimFreshnessNote(data) {
  const d = data || {};
  const out = [];
  const stale = posInt(d.staleRows);
  if (stale) {
    const gb = Number(d.staleReclaimGB);
    const h = Number(d.staleAfterMs) > 0 ? Math.round(Number(d.staleAfterMs) / 3_600_000) : null;
    const gbText = Number.isFinite(gb) ? ` · 회수 가능 ${gb.toLocaleString()} GB` : '';
    out.push(`목록의 VM ${stale}대${gbText}는 마지막 수집이 ${h ? `${h}시간(수집 주기의 3배)` : '수집 주기의 3배'}보다 **오래된 관측**입니다 — 지금 값과 다를 수 있습니다(합계에서 빼지 않았습니다. vCenter 커버리지의 최근 수집 시각을 보세요).`);
  }
  const orphanRows = posInt(d.orphanRows);
  if (orphanRows) {
    const vcs = posInt(d.orphanVcenters);
    out.push(`등록에서 지운 vCenter${vcs ? ` ${vcs}곳` : ''}의 VM ${orphanRows}대는 합계·목록·CSV 에서 **제외**했습니다(남은 기록은 다음 보존 정리 때 지웁니다).`);
  }
  return out.join(' ');
}

/** vCenter 커버리지 행의 상태 문구(v2.743 VC-02: 마지막 적재가 오래됐으면 '데이터 있음' 이라고만 하지 않는다). */
export function coverageStateText(c) {
  if (!c) return '—';
  if (c.vmCount > 0) return c.stale ? '⚠ 오래된 관측' : '✅ 데이터 있음';
  return c.collectSource === 'site' ? '⏳ 엣지 push 대기' : '⏳ 미수집';
}
