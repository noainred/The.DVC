/**
 * wasteExportText.js — 낭비 리소스 엑셀 내보내기 버튼의 **문구·예상치 판정**(순수, v2.497).
 *
 * 왜 순수 모듈인가: 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다 —
 * 판정·문구는 여기서 회귀로 고정한다(CLAUDE.md 프론트엔드 회귀 방지 규칙).
 *
 * 내보내기는 vCenter 성능 조회(리포트 근거)를 동반하므로 수십 초가 걸릴 수 있다. 사용자가 '멈춘 것'
 * 으로 오해하지 않도록 **무엇을 기다리는지·몇 건인지·예상 시간**을 버튼과 안내에 밝힌다.
 */

/** 리포트가 만들어질 VM 수 = CPU 상위 ∪ 메모리 상위(id 중복 제거). 화면 데이터만으로 계산한다. */
export function reportCount(data, { nameFilter = '' } = {}) {
  const oa = data?.overAllocated;
  if (!oa) return 0;
  const term = String(nameFilter || '').trim().toLowerCase();
  const keep = (v) => !term || String(v?.name || '').toLowerCase().includes(term);
  const ids = new Set();
  for (const v of [...(oa.cpuTop || []), ...(oa.memTop || [])]) if (v?.id && keep(v)) ids.add(v.id);
  return ids.size;
}

/**
 * 예상 소요(초) — 정직한 상한이 아니라 **자릿수 감각**이다. 근거: vCenter 당 로그인 2왕복 +
 * 8대 묶음당 QueryPerf 1왕복 + 로그아웃 1왕복, vCenter 동시 4, 왕복 0.8초(고RTT 사이트 기준).
 * vCenter 수를 모르면(단일 범위) 1개로 본다. 반환은 [최소, 최대] 초.
 */
export function estimateSeconds(reportVms, vcenters = 1, { rttMs = 800, concurrency = 4, chunk = 8 } = {}) {
  const n = Math.max(0, Number(reportVms) || 0);
  if (!n) return [0, 0];
  const vc = Math.max(1, Number(vcenters) || 1);
  const perVc = 3 + Math.ceil(n / vc / chunk);        // login 2 + logout 1 + QueryPerf ceil(N/청크)
  const waves = Math.ceil(vc / concurrency);
  const lo = Math.round((waves * perVc * 200) / 1000); // 사내망(RTT 200ms) 가정
  const hi = Math.round((waves * perVc * rttMs) / 1000);
  return [Math.max(1, lo), Math.max(2, hi)];
}

/** 버튼 라벨 — 진행 중이면 경과 초를 함께 보인다(멈춘 것으로 오해하지 않게). */
export function exportLabel({ busy = false, elapsedSec = 0 } = {}) {
  return busy ? `⏳ 내보내는 중… ${Math.max(0, Math.round(elapsedSec))}초` : '📥 엑셀(ZIP) 내보내기';
}

/** 버튼 title(툴팁) — 무엇이 담기는지·왜 시간이 걸리는지. */
export function exportTitle({ reportVms = 0, vcenters = 1, days = 30, nameFilter = '' } = {}) {
  const [lo, hi] = estimateSeconds(reportVms, vcenters);
  const filt = String(nameFilter || '').trim();
  return [
    '표 5개(전원 꺼짐·스냅샷·Tools 미실행·CPU/메모리 과할당) + vCenter 별 현황을 xlsx 로,',
    `CPU/메모리 과할당 ${reportVms}대의 자원 축소 근거 리포트(HTML)를 ZIP 에 함께 담습니다.`,
    filt ? `VM 이름 검색 '${filt}' 이 적용된 화면 그대로 내보냅니다.` : '',
    reportVms ? `근거는 최근 ${days}일 vCenter 성능 롤업을 조회하므로 ${lo}~${hi}초 정도 걸립니다(추정).` : '근거 리포트 대상이 없어 표만 내보냅니다.',
    'ZIP 을 풀고 xlsx 를 열어야 리포트 링크가 동작합니다.',
  ].filter(Boolean).join(' ');
}

/** 진행 중 안내 문구(버튼 아래). */
export function progressNote({ reportVms = 0, vcenters = 1, days = 30, elapsedSec = 0 } = {}) {
  const [, hi] = estimateSeconds(reportVms, vcenters);
  const over = elapsedSec > hi + 30;
  return `vCenter 성능 조회 중 — 근거 리포트 ${reportVms}건(최근 ${days}일). 예상 ${hi}초 내외, 경과 ${Math.round(elapsedSec)}초.`
    + (over ? ' 예상보다 오래 걸리고 있습니다 — 고지연 vCenter 응답을 기다리는 중이며 취소하려면 화면을 떠나세요(서버 작업은 끝까지 진행됩니다).' : '');
}

/** 실패 문구 — 409(다른 내보내기 진행 중)는 '오류' 가 아니라 동시 실행 제한임을 밝힌다. */
export function exportErrText(e) {
  const status = Number(e?.status) || 0;
  const msg = String(e?.message || e || '알 수 없는 오류');
  if (status === 409) return `${msg} (내보내기는 vCenter 부하 때문에 서버에서 한 번에 1건만 실행합니다)`;
  if (status === 403) return msg; // ErrorBox/AccessDenied 가 처리하는 경로 — 문구를 바꾸지 않는다
  return `내보내기 실패: ${msg}`;
}
