// 원격 명령 실행(RMA) 화면의 순수 헬퍼(v2.416) — 웹 테스트는 node 환경(DOM 없음)이라 판정·문구는
// 여기서 회귀로 고정한다.

export const ago = (ts, now = Date.now()) => {
  if (!ts) return '—';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return '방금';
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`;
};

export const durationText = (ms) => {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const n = Number(ms);
  return n < 1000 ? `${n}ms` : n < 60_000 ? `${(n / 1000).toFixed(1)}초` : `${Math.round(n / 60_000)}분 ${Math.round((n % 60_000) / 1000)}초`;
};

export const uptimeText = (sec) => {
  const n = Number(sec) || 0;
  if (n < 60) return `${n}초`;
  if (n < 3600) return `${Math.floor(n / 60)}분`;
  if (n < 86400) return `${Math.floor(n / 3600)}시간 ${Math.floor((n % 3600) / 60)}분`;
  return `${Math.floor(n / 86400)}일 ${Math.floor((n % 86400) / 3600)}시간`;
};

/** 법인 그룹의 표시 상태 — 'online'(1개 이상) / 'offline'(하트비트 있었으나 전부 만료) / 'none'(미배포). */
export function agentStatus(g) {
  if (!g || g.notDeployed || !(g.instances || []).length) return 'none';
  return (g.instances || []).some((i) => i.online) ? 'online' : 'offline';
}

/** 결과 판정 문구 — 성공/실패/거부/타임아웃/절단을 사람이 읽을 한 줄로. */
export function resultSummary(r) {
  if (!r) return { tone: 'muted', text: '결과 없음' };
  if (r.rejected) return { tone: 'bad', text: `거부: ${r.reason || ''}` };
  if (r.timedOut) return { tone: 'bad', text: `제한 시간 초과${r.durationMs != null ? ` (${durationText(r.durationMs)})` : ''}` };
  if (r.ok) return { tone: 'ok', text: `성공 (exit 0${r.durationMs != null ? `, ${durationText(r.durationMs)}` : ''})${r.clipped ? ' · 앞부분만 표시' : ''}` };
  if (r.truncated) return { tone: 'warn', text: `출력 상한 초과로 중단${r.reason ? ` — ${r.reason}` : ''}` };
  return { tone: 'bad', text: r.reason || `실패 (exit ${r.exitCode ?? '?'})` };
}

/** 프리셋 파라미터 초기값(def 채움). */
export function defaultArgs(preset) {
  const out = {};
  for (const p of preset?.params || []) if (p.def != null) out[p.name] = String(p.def);
  return out;
}

/** 실행 전 클라이언트 측 형식 검사(서버·엣지가 재검증 — UX 용). 오류면 문구, 정상 null. */
export function argsIssue(preset, args = {}) {
  for (const p of preset?.params || []) {
    const v = String(args?.[p.name] ?? '').trim();
    if (!v) { if (p.required && p.def == null) return `'${p.label}' 값을 입력하세요.`; continue; }
    if (p.type === 'int') {
      const n = Number(v);
      if (!/^\d+$/.test(v)) return `'${p.label}'은 정수여야 합니다.`;
      if (p.min != null && n < p.min) return `'${p.label}'은 ${p.min} 이상이어야 합니다.`;
      if (p.max != null && n > p.max) return `'${p.label}'은 ${p.max} 이하여야 합니다.`;
    }
    if (p.type !== 'shell' && p.type !== 'int' && v.startsWith('-')) return `'${p.label}' 값은 -로 시작할 수 없습니다.`;
  }
  return null;
}

/** 그룹별 카탈로그 — [{ group, items }] (카탈로그 순서 유지). */
export function groupCatalog(catalog = []) {
  const map = new Map();
  for (const p of catalog) { const g = map.get(p.group) || []; g.push(p); map.set(p.group, g); }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
}

/** 분배 방식 라벨. */
export function modeLabel(mode, modes = []) {
  return modes.find((m) => m.id === mode)?.label || mode || '전역 기본';
}

/** 실행 대상 문구 — 어느 인스턴스가 받을지 사용자에게 미리 알려준다(선택 인스턴스 우선). */
export function targetHint(group, instance, modes = []) {
  if (!group) return '';
  if (instance) return `인스턴스 '${instance}' 에서만 실행`;
  const online = (group.instances || []).filter((i) => i.online);
  if (!online.length) return '온라인 인스턴스 없음 — 처음 폴링하는 인스턴스가 실행(15분 내 미인출 시 폐기)';
  if (group.mode === 'active-backup') return `Active-Backup: '${group.activePrimary || online[0].instance}' 가 실행(오프라인이면 다음 순위)`;
  if (group.mode === 'balance') return `부하 분산: 온라인 ${online.length}개 중 진행 중 명령이 가장 적은 인스턴스에 배정`;
  return `Active-Active: 온라인 ${online.length}개 중 먼저 폴링한 인스턴스가 실행`;
}

/** 점검 상태 색/라벨(v2.418). */
export function statusTone(status, TONE = { ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444', muted: '#94a3b8' }) {
  return status === 'ok' ? TONE.ok : status === 'warn' ? TONE.warn : status === 'bad' ? TONE.bad : TONE.muted;
}
export function statusLabel(status) {
  return { ok: '정상', warn: '경고', bad: '실패', unknown: '불명' }[status] || status || '—';
}
