/**
 * 사용률 출처(v2.991 · 설계 docs/design/bm-folders §13 ①) — 서버가 내려 준 지표별 출처 `usrc` { cpu, mem }('os' · 'idrac' · 'vcenter' · null)를 화면용으로.
 * 색은 시안 기본값: OS 파랑 · iDRAC 밝은 청록(밝기도 다르다 — 색만으로 가르지 않게 글자 표지를 함께 쓴다) · vCenter 는 회색.
 */
export const SRC_COLOR = Object.freeze({ os: '#3b82f6', idrac: '#5eead4', vcenter: '#94a3b8' });
export const SRC_LABEL = Object.freeze({ os: 'OS', idrac: 'iDRAC', vcenter: 'vCenter' });
export const SRC_LONG = Object.freeze({ os: 'OS(SSH)', idrac: 'iDRAC', vcenter: 'vCenter', mixed: '지표마다 다름', none: '없음' });
/** 좁은 화면 카드 줄 끝 — 전력 값을 밀어내지 않게 짧게(줄이 넘치면 이것이 먼저 잘린다). */
export const SRC_SHORT = Object.freeze({ os: 'OS', idrac: 'iDRAC', vcenter: 'vCenter', mixed: '혼합' });

/** 행 하나의 출처 분류 — 값이 있는 지표의 출처가 모두 같으면 그 출처, 다르면(또는 서버가 '구분 모름' 이라 하면) 'mixed', 값이 없으면 'none'. */
export function rowSrcClass(r) {
  const u = r?.usrc;
  if (!u) return r?.cpu == null && r?.mem == null ? 'none' : 'unknown';
  if (u.mixed) return 'mixed';
  const s = [...new Set([u.cpu, u.mem].filter(Boolean))];
  if (!s.length) return r?.cpu == null && r?.mem == null ? 'none' : 'unknown';
  return s.length === 1 ? s[0] : 'mixed';
}

/** 묶음 안 출처별 개수 — { os, idrac, vcenter, mixed, none, unknown }. */
export function srcCounts(rows = []) {
  const c = { os: 0, idrac: 0, vcenter: 0, mixed: 0, none: 0, unknown: 0 };
  for (const r of rows) c[rowSrcClass(r)] += 1;
  return c;
}

/** 지표 하나(cpu · mem)의 출처별 개수 — 요약 칸 'OS n · iDRAC n'. */
export function metricSrcText(rows = [], metric) {
  const c = { os: 0, idrac: 0, vcenter: 0 };
  for (const r of rows) { const s = r?.usrc?.[metric]; if (s && c[s] != null && r[metric] != null) c[s] += 1; }
  return ['os', 'idrac', 'vcenter'].filter((k) => c[k]).map((k) => `${SRC_LABEL[k]} ${c[k]}`).join(' · ');
}

/** 칸 툴팁 — 지표마다 어디서 읽었는가. 출처를 모르면 그렇다고 쓴다(지어내지 않는다). */
export function srcTitle(r) {
  const u = r?.usrc;
  const part = (m, lb) => (r?.[m] == null ? `${lb} 값 없음` : `${lb} — ${u?.[m] ? SRC_LONG[u[m]] : '출처 모름'}`);
  if (u?.mixed) return '지표마다 출처가 다릅니다 — 이 행은 어느 지표가 어디서 왔는지 아직 기록되지 않았습니다(다음 수집부터 지표별로 보입니다).';
  return `${part('cpu', 'CPU')} · ${part('mem', '메모리')} · OS 를 먼저 읽고, 안 되거나 값이 없으면 iDRAC 값을 씁니다.`;
}
