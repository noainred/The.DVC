/**
 * vcdSearch.js — Platform(vCenter 상세) 인벤토리 검색 순수 헬퍼(v2.293).
 *
 * VCenterDetail.jsx 의 '호스트 및 클러스터'·'VM 및 폴더' 탭 검색이 사용한다.
 * React/DOM 무의존 순수 함수로 분리한 이유: ① 다단어 OR·메모 매칭·합계는 경계 실수
 * (공백만 입력, notes null, 0 vCPU)로 조용히 틀리기 쉬운 로직이라 단위테스트를 붙인다
 * (web/src/views/vcdSearch.test.js — vitest, v2.289 도입) ② 뷰 파일이 로직을 품으면
 * 테스트가 usePolling 등 React 의존을 끌어온다.
 *
 * 요구사항(2026-08-14 사용자 지정):
 * - 다단어 OR: "NTP WA" 입력 → 'NTP' 포함 항목 + 'WA' 포함 항목 전부 매칭(공백 분리, 대소문자 무시).
 * - '메모 포함' 체크 시 VM 메모(vSphere annotation → 서버 수집 필드 vm.notes)도 검색 대상.
 * - 일치 VM 의 자원 총합(vCPU·메모리·디스크)을 함께 표시(합계는 표시 상한 500개가 아니라 전체 일치 기준).
 */

/** 검색어 → 소문자 토큰 배열. 공백(연속 포함)으로 분리, 빈 토큰 제거. "NTP WA" → ['ntp','wa'] */
export function parseTokens(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * 이름/메모가 토큰 중 **하나라도**(OR) 포함하는지 판정.
 * @returns { hit: boolean, viaNotes: boolean, token: string|null }
 *   viaNotes: 이름으로는 안 걸리고 메모로만 걸렸는지(검색 결과 행에 메모 스니펫을 보여줄 근거).
 *   token: 실제로 걸린 첫 토큰(메모 스니펫 위치 계산용).
 */
export function entityMatches(name, notes, tokens, inclNotes) {
  const n = String(name || '').toLowerCase();
  const m = inclNotes ? String(notes || '').toLowerCase() : '';
  for (const t of tokens) {
    if (n.includes(t)) return { hit: true, viaNotes: false, token: t };
  }
  if (inclNotes) {
    for (const t of tokens) {
      if (m.includes(t)) return { hit: true, viaNotes: true, token: t };
    }
  }
  return { hit: false, viaNotes: false, token: null };
}

/**
 * 메모에서 매칭 토큰 주변 스니펫을 잘라낸다(검색 결과 행 표시용 — 왜 걸렸는지 한눈에).
 * 토큰 앞 12자·뒤 40자 창. 잘렸으면 말줄임 표시.
 */
export function notesSnippet(notes, token, { before = 12, after = 40 } = {}) {
  const s = String(notes || '');
  const i = s.toLowerCase().indexOf(String(token || '').toLowerCase());
  if (i < 0) return s.slice(0, before + after);
  const from = Math.max(0, i - before);
  const to = Math.min(s.length, i + after);
  return `${from > 0 ? '…' : ''}${s.slice(from, to)}${to < s.length ? '…' : ''}`;
}

/**
 * 일치 VM 들의 자원 총합.
 * - vcpu: cpuCount 합
 * - memGB: memMB 합 → GB(정수 반올림)
 * - diskUsedGB: storageGB 합(vSphere committed = 실제 사용 중 디스크)
 * - diskProvGB: storageGB+uncommittedGB 합(프로비저닝 = thin 미기록분 포함 할당)
 * 필드 결측(수집 실패 VM)은 0 으로 취급 — NaN 이 합계 전체를 오염시키지 않게.
 */
export function sumVmResources(vms) {
  let vcpu = 0, memMB = 0, used = 0, prov = 0;
  for (const v of vms || []) {
    vcpu += Number(v.cpuCount) || 0;
    memMB += Number(v.memMB) || 0;
    const u = Number(v.storageGB) || 0;
    used += u;
    prov += u + (Number(v.uncommittedGB) || 0);
  }
  return { vcpu, memGB: Math.round(memMB / 1024), diskUsedGB: used, diskProvGB: prov };
}

/** GB → 사람이 읽는 단위(1TB 이상이면 TB 소수1). VCenterDetail 의 tb() 와 동일 규칙. */
export function fmtGb(gb) {
  const n = Number(gb) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(1)} TB` : `${Math.round(n).toLocaleString()} GB`;
}
