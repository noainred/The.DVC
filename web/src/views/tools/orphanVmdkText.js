/**
 * 고아 VMDK 화면의 **판정·문구**(v2.505) — 순수 함수.
 *
 * 사용자 요청: "VMDK 같은 파일이 VM에 연결되지 않은 상태인지 찾아내는 기능".
 *
 * 왜 순수 모듈인가: 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다.
 * 게다가 이 화면의 문구는 **사람이 파일을 지울지 결정하는 근거**라, 표현이 틀리면 사고가 된다.
 * 그래서 판정·문구를 여기 모아 테스트로 고정한다(`accessDeniedText.js`·`sensorText.js` 와 같은 규약).
 *
 * 문구 원칙:
 *  - '삭제 대상' 이라고 쓰지 않는다. 언제나 **'확인 필요 후보'** 다.
 *  - 신뢰도가 낮으면 숫자보다 그 사실을 앞세운다.
 *  - 왜 후보에서 빠졌는지(제외 사유)를 숨기지 않는다.
 */

export const VERDICT = {
  orphan: { label: '소유 VM 없음', tone: 'red', desc: '이 vCenter 의 어떤 VM 도 이 파일을 쓰지 않습니다. 폴더에 .vmx 도 없습니다.' },
  unregistered: { label: '미등록 VM 폴더', tone: 'amber', desc: '같은 폴더에 .vmx 가 있습니다 — 등록 해제된 VM 이거나 다른 vCenter 가 등록한 VM 일 수 있습니다.' },
  hold: { label: '판정 보류', tone: 'blue', desc: '최근에 변경된 파일입니다 — 복제·마이그레이션·백업이 진행 중일 수 있습니다.' },
};

export const verdictLabel = (v) => VERDICT[v]?.label || v || '—';
export const verdictTone = (v) => VERDICT[v]?.tone || '';

/**
 * 바이트 → 사람이 읽는 크기(소수 1자리).
 * **0 은 '0 B', 모르는 값은 '—'** 로 구분한다 — `Number(null) === 0` 이라 그냥 변환하면
 * '크기를 모른다' 가 '0바이트' 로 둔갑한다(회수 용량 판단에서 오판을 만든다).
 */
export function fmtBytes(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '—';
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let x = v / 1024; let i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(1)} ${u[i]}`;
}

/**
 * 요약 한 줄. **'삭제하면 N GB 회수' 라고 쓰지 않는다** — 확인 전에는 회수 가능이 아니다.
 */
export function summaryText(r) {
  const s = r?.summary;
  if (!s) return '';
  const parts = [];
  if (s.orphanDisks) parts.push(`소유 VM 없음 ${s.orphanDisks}개(${fmtBytes(s.orphanBytes)})`);
  if (s.unregisteredDisks) parts.push(`미등록 VM 폴더 ${s.unregisteredDisks}개(${fmtBytes(s.unregisteredBytes)})`);
  if (s.holdDisks) parts.push(`판정 보류 ${s.holdDisks}개(${fmtBytes(s.holdBytes)})`);
  if (!parts.length) return `연결되지 않은 VMDK 후보가 없습니다 — VMDK ${s.scannedVmdkFiles}개 전부 소유 VM 이 확인됐습니다.`;
  return `${parts.join(' · ')} — 모두 **확인 필요 후보**입니다(삭제 판단은 사람이 합니다).`;
}

/** 대조 근거 한 줄 — 무엇과 무엇을 비교했는지 숫자로 밝힌다(신뢰의 근거). */
export function basisText(r) {
  if (!r || r.mock) return '';
  const bits = [
    `파일 ${Number(r.totalFiles || 0).toLocaleString()}개 스캔`,
    `VMDK ${Number(r.summary?.scannedVmdkFiles || 0).toLocaleString()}개 중 소유 확인 ${Number(r.summary?.ownedVmdkFiles || 0).toLocaleString()}개`,
    `VM ${Number(r.dsVmCount || 0)}대 대조(파일 목록 확보 ${Number(r.vmsWithLayout || 0)}대)`,
  ];
  if (r.summary?.excludedFiles) bits.push(`제외 ${r.summary.excludedFiles}개`);
  return bits.join(' · ');
}

/** 신뢰도 배지 톤. none/low 는 눈에 띄게 — 숫자를 그대로 믿으면 안 되는 상태다. */
export const confidenceTone = (level) => (level === 'high' ? 'green' : level === 'medium' ? 'blue' : 'red');
export const confidenceLabel = (level) => ({
  high: '대조 완료', medium: '참고', low: '신뢰도 낮음', none: '신뢰 불가',
}[level] || '판정 안 함');

/** 보류 창(시간) 선택지. 0 = 끔(명시적 선택이며, 진행 중 작업까지 후보로 나온다). */
export const HOLD_HOURS = [[0, '끔'], [6, '6시간'], [24, '24시간'], [72, '3일'], [168, '1주']];

/**
 * 스캔 전/실패 상태 문구(순수). null 이면 결과를 그린다.
 * 네 경우를 구분한다 — v2.493 규칙: 사용자가 할 일이 다르다.
 */
export function scanStateNote({ ds = null, loading = false, error = '', result = null } = {}) {
  if (!ds) return { kind: 'pick', text: '스캔할 데이터스토어를 고르세요. 데이터스토어 하나를 라이브로 탐색하므로 파일이 많으면 수십 초 걸립니다.' };
  if (loading) return null;
  if (error) return { kind: 'error', text: error };
  if (!result) return { kind: 'idle', text: '‘스캔 실행’ 을 누르면 이 데이터스토어의 파일과 VM 소유 파일을 대조합니다.' };
  if (result.mock) return { kind: 'mock', text: result.reason || '데모 모드에서는 판정하지 않습니다.' };
  return null;
}

/** 파일 목록이 상한에서 잘렸을 때의 경고(조용히 자르지 않는다 — v2.502 교훈). */
export function truncatedNote(r) {
  if (!r?.truncated) return '';
  return '파일 목록이 상한(10,000개)에서 잘렸습니다 — 목록에 없는 파일은 판정 대상에서 빠졌습니다. 이 결과로 "고아가 이것뿐" 이라고 결론 내리지 마세요.';
}

/** 제외 사유별 집계(순수) — 무엇이 왜 후보에서 빠졌는지 표로 보여주기 위함. */
export function excludedByReason(excluded = []) {
  const m = new Map();
  for (const e of excluded || []) {
    const k = e?.reason || 'other';
    const cur = m.get(k) || { reason: k, files: 0, sizeBytes: 0 };
    cur.files += 1; cur.sizeBytes += Number(e?.sizeBytes) || 0;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export const EXCLUDE_LABEL = {
  fcd: 'FCD(개선된 가상 디스크 · 쿠버네티스 PV)',
  contentlib: '콘텐츠 라이브러리',
  replication: 'vSphere Replication',
  system: '시스템/숨김 폴더',
  ctk: '백업 CBT 파일',
  other: '기타',
};
export const excludeLabel = (r) => EXCLUDE_LABEL[r] || r;
