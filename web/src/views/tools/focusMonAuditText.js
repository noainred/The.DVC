/**
 * focusMonAuditText.js — 서버 집중 모니터링 ‘디스크 점검’ 탭의 글 · 표시 규칙(v3.11.0). 판정 · 집계는 서버(focusmon/audit/*) 하나 — 여기는 글자로 바꾸기만 한다.
 *  · 숫자는 프로그램이 찾은 **줄 수**(장애 횟수 아님) · 값이 없으면 '—'(0 아님) · 끝까지 돌지 않은 회차는 숫자를 합계처럼 쓰지 않는다.
 *  · 문구에 백틱을 쓰지 않는다(BoldText 규칙 — 값 인용은 ‘ ’).
 */
export const DASH = '—';
export const AUDIT_VIEWS = Object.freeze([['server', '서버'], ['corp', '법인별'], ['disk', '디스크 모델별'], ['cross', '법인 × 디스크 모델'], ['smodel', '서버 모델별'], ['group', '그룹별']]);
export const AUDIT_VIEW_KEYS = AUDIT_VIEWS.map((v) => v[0]);

export const READY_TEXT = Object.freeze({
  ready: { tone: 'ok', label: '준비됨' },
  nopy: { tone: 'warn', label: '준비 안 됨 — python3 없음' },
  pyold: { tone: 'warn', label: '준비 안 됨 — python3 판이 낮음' },
  notinstalled: { tone: 'warn', label: '준비 안 됨 — 설치 안 됨' },
  unreadable: { tone: 'warn', label: '준비 안 됨 — 설치 파일을 읽지 못함' },
  version: { tone: 'warn', label: '프로그램 판본 다름' },
  owner: { tone: 'bad', label: '설치 권한 위험 — 실행 안 함' },
  nosudo: { tone: 'warn', label: '준비 안 됨 — sudo 규칙 없음' },
  'bad-output': { tone: 'warn', label: '확인 출력 이상' },
});
export const OUTCOME_TEXT = Object.freeze({
  done: '점검함', timeout: '시한 초과 — 끊음', 'program-timeout': '프로그램 시한 초과 — 일부만', 'program-error': '프로그램 오류로 끝남', incomplete: '끝까지 돌지 않음',
  cut: '출력이 중간에 끊김', 'no-start': '시작하지 못함', 'sudo-denied': 'sudo 가 거부함', 'sudo-tty': 'sudo 가 tty 를 요구함',
  'wrapper-nopython': 'python3 없음', 'wrapper-args': '실행 파일이 인자를 거절', 'wrapper-tmp': '임시 폴더를 만들지 못함', 'wrapper-other': '실행 파일 오류',
  'wrapper-busy': '앞선 점검이 아직 대상 서버에서 도는 중', 'wrapper-nonce': '실행 표지를 만들지 못함', 'report-shape': '보고서 모양 이상 — 숫자를 쓰지 않음',
});
export const ERROR_TEXT = Object.freeze({
  'no-key': '이 노드에 SSH 키가 없음', auth: '키 로그인 거부', 'auth-stopped': '키 로그인 거부로 멈춤 — 대상 · 키 탭의 ‘다시 연결’', hostkey: '호스트키 승인 필요',
  unreachable: '연결 실패', timeout: '시한 안에 끝나지 않음', 'bad-output': '출력 이상', lost: '결과를 받지 못함', db: '결과를 기록하지 못함',
  busy: '엣지에서 같은 서버의 이전 작업이 아직 끝나지 않음', 'queue-full': '엣지 점검 대기열이 가득 참', 'too-big': '결과가 너무 커서 원문을 받지 못함',
});
/** 끝까지 돌지 않은 회차의 안내 한 줄(결과 화면). 시작하지 못했으면 대상 서버가 남긴 까닭(표준 오류 첫 줄)을 붙인다. */
export function notDoneText(run) {
  if (!run || run.outcome === 'done') return '';
  const head = `${OUTCOME_TEXT[run.outcome] || run.outcome}${run.rc != null ? `(종료값 ${run.rc})` : ''}`;
  if (run.outcome === 'report-shape') return `${head} — 보고서가 받은 프로그램의 모양과 다릅니다. 대상 서버의 로그에 줄바꿈이 든 기록이 있으면 그 내용이 보고서 줄처럼 보일 수 있어, 이 회차의 숫자를 합계로 쓰지 않습니다. 원문을 받아 확인하세요.`;
  const why = run.summary?.stderr ? ` 대상 서버가 남긴 까닭: ${run.summary.stderr}` : '';
  return `${head} — 끝까지 돌지 않은 회차라 숫자를 합계로 쓰지 않습니다. 받은 데까지의 원문은 ‘보고서 원문 받기’ 로 볼 수 있습니다.${why}`;
}
/** 디스크 수 — 기록 수를 아는 디스크 + (상세 근거가 잘려 모르는 디스크). */
export const diskCountText = (x) => `${countText(x?.n ?? null)}${x?.unknown ? ` · 모름 ${x.unknown}` : ''}`;
export const PHASE_NOTE = '실행 중에는 프로그램이 내는 구획(로그 수집 범위 → PERC/StorCLI 조회 → OS/SMART 조회 → RAID 경유 물리 SMART 조회 → 판정 → 상세 근거 → 해석 범위 → 디스크 목록)을 받아 지금 단계를 보여 줍니다.';

export const countText = (n) => (n == null || !Number.isFinite(Number(n)) ? DASH : Number(n).toLocaleString('ko-KR'));
export function whenText(ms, now = Date.now()) {
  if (!ms) return DASH;
  const d = new Date(ms); const p = (x) => String(x).padStart(2, '0');
  const today = new Date(now);
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}-${md}`} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function durText(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return DASH;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60); const r = s % 60;
  return r ? `${m}분 ${r}초` : `${m}분`;
}
export const nodeText = (agent) => (agent ? `엣지 ${agent}` : '중앙 직접');
export const corpText = (r, labels) => (r?.corp ? r.corp.name : labels?.noCorp || '법인 미지정');
export const smodelText = (r, labels) => r?.smodel || labels?.noModel || '모델 모름';

/** 서버 한 줄의 상태 — 작업 > 연결 오류 > 준비 상태 > 최근 결과. { tone, label, sub } */
export function rowStatus(r, now = Date.now()) {
  if (r?.job) {
    if (r.job.state === 'running') return { tone: 'live', label: `실행 중${r.job.mode === 'check' ? ' — 준비 확인' : ''}`, sub: r.job.phase ? `지금 단계: ${r.job.phase}${r.job.startedAt ? ` · ${durText(now - r.job.startedAt)}째` : ''}` : '' };
    return { tone: 'live', label: r.job.mode === 'check' ? '준비 확인 대기' : '차례를 기다림', sub: r.job.node ? (r.job.delivered ? `엣지 ${r.job.node} 에 보냄` : `엣지 ${r.job.node} 가 받아 가기를 기다림`) : r.job.position ? `중앙 줄 ${r.job.position}번째` : '' };
  }
  const err = r?.lastError && (!r.ready?.at || r.lastError.at >= r.ready.at) ? r.lastError : null;
  if (err) return { tone: 'warn', label: `확인 못 함 — ${ERROR_TEXT[err.kind] || err.kind}`, sub: err.error || '' };
  const rd = r?.ready?.state ? READY_TEXT[r.ready.state] || { tone: 'warn', label: r.ready.state } : null;
  if (rd && r.ready.state !== 'ready') return { tone: rd.tone, label: rd.label, sub: r.ready.reason || '' };
  if (r?.last) return { tone: r.last.outcome === 'done' ? 'ok' : 'warn', label: OUTCOME_TEXT[r.last.outcome] || r.last.outcome, sub: r.last.outcome !== 'done' && r.last.summary?.stderr ? r.last.summary.stderr : rd ? `준비됨 · 판본 같음${r.ready.py ? ` · python ${r.ready.py}` : ''}` : '' };
  if (rd) return { tone: 'off', label: '점검한 적 없음', sub: `준비됨${r.ready.py ? ` · python ${r.ready.py}` : ''}` };
  return { tone: 'off', label: '확인한 적 없음', sub: '‘준비 상태 다시 확인’ 을 누르면 이 서버에 설치 · sudo 규칙이 있는지 봅니다.' };
}

/** 점검 단추를 열까 — 작업 중이면 닫고, 알려진 ‘준비 안 됨’ 이면 닫는다(서버가 다시 판정한다 — 이것은 화면의 안내일 뿐). */
export function canRunRow(r) { if (!r || r.job) return false; if (r.ready?.state && r.ready.state !== 'ready') return false; return true; }
/** 최근 결과의 숫자 — 끝까지 돈 회차만. 아니면 null(‘—’). */
export function lastCounts(r) { return r?.last?.outcome === 'done' ? r.last.summary?.counts || null : null; }

export function rateText(x, minDisks = 10) {
  if (!x || !x.n) return DASH;
  return x.rate != null ? `${x.rate}% (${x.bad}/${x.n})` : `${x.bad} / ${x.n}${x.n < minDisks ? ' · 표본 적음' : ''}`;
}

/** 거르기 칩. */
export function chipCounts(rows) {
  const hit = rows.filter((r) => r.last?.outcome === 'done' && r.last.summary?.hit).length;
  const notReady = rows.filter((r) => r.ready?.state && r.ready.state !== 'ready').length;
  return [['all', `전체 ${rows.length}`], ['hit', `기록 있음 ${hit}`], ['notready', `준비 안 됨 ${notReady}`], ['never', `점검 결과 없음 ${rows.filter((r) => !r.last).length}`]];
}
export function chipFilter(key) {
  if (key === 'hit') return (r) => r.last?.outcome === 'done' && !!r.last.summary?.hit;
  if (key === 'notready') return (r) => !!(r.ready?.state && r.ready.state !== 'ready');
  if (key === 'never') return (r) => !r.last;
  return () => true;
}
/** 묶음 줄을 누르면 서버 표를 그 묶음으로 거른다. */
export function scopeFilter(scope, labels) {
  if (!scope) return () => true;
  if (scope.k === 'corp') return (r) => (r.corp ? r.corp.id : '') === scope.key;
  if (scope.k === 'smodel') return (r) => (r.smodel || '') === scope.key;
  if (scope.k === 'group') return (r) => (r.group || '') === scope.key;
  if (scope.k === 'disk') return (r) => r.last?.outcome === 'done' && (r.last.summary?.disks || []).some((d) => (d.model || labels?.noModel) === scope.key);
  if (scope.k === 'cross') return (r) => (r.corp ? r.corp.id : '') === scope.corp && r.last?.outcome === 'done' && (r.last.summary?.disks || []).some((d) => (d.model || labels?.noModel) === scope.model);
  return () => true;
}
export function scopeText(scope) {
  if (!scope) return '';
  const N = { corp: '법인', smodel: '서버 모델', group: '그룹', disk: '디스크 모델' };
  return scope.k === 'cross' ? `법인 = ${scope.corpName} · 디스크 모델 = ${scope.model}` : `${N[scope.k] || scope.k} = ${scope.name}`;
}

/** 요약 4칸의 ‘준비 안 됨’ 까닭 글. */
export function notReadyText(by = {}) {
  const parts = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${(READY_TEXT[k]?.label || k).replace(/^준비 안 됨 — /, '')} ${n}`);
  return parts.length ? parts.join(' · ') : '없음';
}
export const VERDICT_TONE = Object.freeze({ 확정: 'bad', 추정: 'warn', 불명: 'off', 참고: 'off', 대상: 'off' });
export const KIND_TONE = Object.freeze({ '매체 오류 기록': 'bad', 'I/O·경로 오류 기록': 'warn', '재할당 기록': 'warn', '파일시스템 생성 성공 기록': 'off', '파일시스템 생성 명령': 'off' });

/** 설치 안내 — 화면에 그대로 싣는 명령(서버 응답의 경로 · 판본으로 만든다 — 박지 않는다). */
export function installSteps(paths, version) {
  return [
    `# 1) 포탈에서 받은 설치 파일을 서버로 옮긴 뒤 root 로(판본: 프로그램 ${version?.program || DASH} · 실행 파일 ${version?.wrapper || DASH})`,
    'sh dvc-disk-audit-install.sh <수집 계정>',
    `#    → ${paths?.program || ''}(0644) · ${paths?.wrapper || ''}(0755) · ${paths?.sudoers || ''}(0440)`,
    '# 2) 포탈이 부르는 명령(고정 — 인자 없음)',
    paths?.run || '',
    '# 지우려면',
    `rm -f ${paths?.sudoers || ''} ${paths?.wrapper || ''} ${paths?.program || ''}`,
  ].join('\n');
}
