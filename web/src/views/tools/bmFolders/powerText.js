/**
 * 물리서버 원격 전원 조작 · 위치 LED 켜기/끄기 화면 글자(v3.52 · 시안 docs/design/bm-feature-proposals ⑦ ⑥). 순수 — 집행 · 판정은 서버(routes/api/bmFolders.js powerGate)가 한다.
 *  · ‘받음’ 은 장비가 요청을 받았다는 뜻이지 끝났다는 뜻이 아니다 — 실제 전원 · LED 상태는 다음 수집에서 본다.
 *  · 시한 초과는 ‘닿았는지 모름’ 이다(다시 보내지 않는다) — 다시 누르기 전에 상태를 먼저 보라고 쓴다.
 *  · 문구에 백틱을 쓰지 않는다 · 주기 숫자(간격)는 서버 응답의 사유 그대로.
 */
export const POWER_NOTE = '장비 상태를 바꾸는 동작입니다 — 전원은 전체 범위 관리자가 서버 이름 다시 입력 · 사유 · 본인 OTP(인증을 켠 포탈)로, 위치 LED 는 그 서버 법인의 쓰기 범위가 있는 운영자 이상이 보냅니다. 모두 감사 로그에 남고, 그 서버를 수집하는 쪽(이 포탈 또는 법인 엣지)이 장비에 한 번 보내고 다시 보내지 않습니다.';
export const POWER_OFF_NOTE = '원격 전원 · 위치 LED 조작은 꺼져 있습니다(전체 범위 관리자가 Bare Metal Server › 원격 전원 설정에서 켭니다).';
export const FORCE_NOTE = '강제 재시작 · 강제 끄기는 운영체제를 기다리지 않습니다 — 저장하지 않은 데이터가 사라질 수 있습니다.';

/** 결과 상태 → 사람이 읽는 글자. accepted 는 ‘받음’ 이지 ‘끝남’ 이 아니다. */
export const POWER_STATUS = Object.freeze({
  accepted: '장비가 요청을 받았습니다 — 끝났다는 뜻이 아닙니다. 실제 상태는 다음 수집에서 확인하십시오.',
  'not-allowed': '장비가 이 동작을 허용하지 않습니다.',
  auth: 'iDRAC 인증에 실패했습니다(401 — 등록 계정 또는 장비 세션 문제일 수 있습니다). 다시 보내지 않았습니다 — 상태를 확인한 뒤 다시 하십시오.',
  'auth-stopped': 'iDRAC 인증 실패로 이 서버의 주기 수집이 멈춰 있어 장비에 보내지 않았습니다.',
  busy: '이 서버에 보낸 요청이 아직 끝나지 않았거나 방금 보냈습니다 — 잠시 뒤 상태를 보고 다시 누르십시오.',
  timeout: '장비가 시한 안에 답하지 않았습니다 — 요청이 장비에 닿았는지 모릅니다. 다시 누르기 전에 다음 수집에서 상태를 확인하십시오.',
  'old-version': '이 서버를 맡은 엣지가 이 기능보다 낮은 판입니다 — 엣지를 올린 뒤 다시 하십시오(보내지 않았습니다).',
  'not-found': '이 서버를 맡은 엣지의 등록부에 이 서버가 없습니다(보내지 않았습니다).',
  disabled: '이 서버를 맡은 엣지가 원격 전원 · LED 요청을 켜지 않았습니다(엣지 env BM_POWER_EDGE_ENABLE=true).',
  'force-off': '강제 재시작 · 강제 끄기가 허용되지 않았습니다(설정 또는 그 엣지의 BM_POWER_EDGE_FORCE).',
  rate: '그 엣지의 10분 상한에 걸렸습니다 — 잠시 뒤 다시.',
  'tag-mismatch': '장비가 알려 준 서비스 태그가 등록과 달라 보내지 않았습니다 — 다른 서버일 수 있습니다(등록 주소를 확인하십시오).',
  'edge-disabled': '이 서버를 맡은 엣지가 원격 전원 · LED 요청을 켜지 않았습니다(엣지 env BM_POWER_EDGE_ENABLE=true).',
  'edge-refused': '이 서버를 맡은 엣지 · 중앙이 요청을 장비에 보내기 전에 멈췄습니다 — 장비에 보내지 않았고 상태는 바뀌지 않았습니다.',
  'edge-fail': '이 서버를 맡은 엣지에 닿지 못했거나 엣지가 답하지 않았습니다 — 요청이 장비에 닿았는지 모릅니다. 다시 누르기 전에 상태를 확인하십시오.',
  'bad-args': '잘못된 요청입니다.',
  error: '장비에 보내지 못했습니다.',
});
const ACTION_ORDER = ['on', 'shutdown', 'restart', 'forceRestart', 'forceOff'];

/** power-state 응답 → 그릴 단추(강제 동작은 허용됐을 때만 · 서버가 준 이름). */
export function powerButtons(ps) {
  const acts = ps && typeof ps.actions === 'object' && ps.actions ? ps.actions : {};
  return ACTION_ORDER.filter((k) => Object.hasOwn(acts, k) && (!acts[k]?.force || ps.allowForce === true)).map((k) => ({ k, label: String(acts[k]?.label || k), force: acts[k]?.force === true }));
}

/** 확인 칸 검사(서버가 다시 본다 — 여기서는 단추를 열지 말지만). '' = 보낼 수 있음. */
export function confirmIssue(f, name, otpRequired) {
  const nm = String(name ?? '').trim();
  if (!nm) return '이 서버의 이름을 몰라 확인할 수 없습니다.';
  if (String(f?.confirm ?? '').trim() !== nm) return '확인을 위해 서버 이름을 그대로 입력하십시오.';
  if (String(f?.reason ?? '').trim().length < 4) return '사유를 4자 이상 적으십시오(감사 로그에 남습니다).';
  if (otpRequired && !/^\d{6}$/.test(String(f?.otp ?? ''))) return '본인 OTP 6자리를 입력하십시오.';
  return '';
}

/** 결과(서버 응답 또는 오류) → { ok, text }. 서버가 준 장비 글자(message)는 뒤에 붙인다. */
// 상태 글자가 장비 · 엣지 메시지와 같은 말을 하는 상태 — 메시지를 덧붙이지 않는다(같은 문장이 두 번 나오지 않게 — 반증 B7)
const SELF_EXPLAINED = new Set(['timeout', 'busy', 'auth', 'auth-stopped', 'edge-disabled', 'disabled', 'rate', 'force-off', 'not-found']);   // not-found 도 문구가 스스로 말한다(4회차 화면 E2)
export function powerResultText(r, label = '') {
  if (!r || typeof r !== 'object') return { ok: false, text: POWER_STATUS.error };
  const head = (t) => (label ? `${label} — ${t}` : t);
  // 데모 — ‘받음’ 이라 하지 않는다(반증 B6)
  if (r.via === 'demo') return { ok: true, text: head('데모: 장비에 보내지 않았습니다(실제 포탈에서는 그 서버를 수집하는 쪽이 장비에 보냅니다).') };
  const ok = r.ok === true && r.status === 'accepted';
  const base = POWER_STATUS[r.status] || (r.reason ? '' : POWER_STATUS.error);
  const parts = [head(base)];
  if (ok && r.reset) parts.push(`보낸 값 ${r.reset}`);
  if (ok && r.before) parts.push(`보내기 전 전원 ${r.before}`);
  if (ok && r.tagChecked === false) parts.push('서비스 태그는 대조하지 못했습니다(장비 · 등록 한쪽에 없음)');
  if (r.message && !SELF_EXPLAINED.has(r.status)) parts.push(String(r.message).slice(0, 300));
  if (!ok && r.reason && !SELF_EXPLAINED.has(r.status)) parts.push(String(r.reason).slice(0, 300));
  return { ok, text: parts.filter(Boolean).join(' · ') };
}
export const POWER_UNKNOWN_HOLD_MS = 60_000;
/**
 * 브라우저 쪽 실패(응답을 받지 못함) → { text, unknown }. 서버가 사유와 함께 거절한 4xx(권한 · 입력 · OTP · 진행 중 등)는 그 사유를,
 * 연결 끊김 · 게이트웨이 5xx · 시한은 ‘닿았는지 모름’ 으로(반증 B5). err.status 가 없으면 응답을 못 받은 것이다.
 */
export function powerFailText(err, label = '') {
  const st = Number(err?.status);
  const reason = String(err?.body?.reason || err?.message || '').slice(0, 300);
  const head = (t) => (label ? `${label} — ${t}` : t);
  if (st >= 400 && st < 500 && err?.body && typeof err.body === 'object') return { unknown: false, text: head(`보내지 않았습니다 — ${reason}`) };
  // 등록부를 못 읽어 보내지 않았다고 서버가 밝힌 503 은 ‘닿았는지 모름’ 이 아니다(잠그지 않는다 — 디버깅 3회차 화면 N5)
  if (st === 503 && err?.body && typeof err.body === 'object' && err.body.error === 'registryUnreadable') return { unknown: false, text: head(reason || '등록부를 읽지 못해 보내지 않았습니다.') };   // 서버 사유가 이미 ‘보내지 않았습니다’ 를 말한다(4회차 화면 E3)
  return { unknown: true, text: head(`응답을 받지 못했습니다(${st ? `HTTP ${st}` : '연결 끊김 · 시한'}) — 요청이 장비에 닿았는지 모릅니다. 다시 누르기 전에 다음 수집에서 상태를 확인하십시오.`) };
}

// ───────── ⑬ 장애 바로 받기(이벤트 구독) ─────────
export const EVT_NOTE = '장비(iDRAC)가 장애 경고를 이 포탈로 바로 보내게 구독을 겁니다. 위험 · 주의 이벤트를 받으면 그 서버의 인벤토리를 주기를 기다리지 않고 다시 읽고, 부품 장애 점검을 바로 한 번 돕니다(같은 신호가 몰려도 묶어서). 장애 판정은 지금처럼 부품 장애 점검이 합니다 — 이벤트 글자로 판정하지 않습니다. 이 포탈 등록부의 서버에만 걸고, 엣지가 맡은 서버는 그 엣지 포탈에서 겁니다. 장비가 이 포탈의 받는 주소(https)에 닿아야 합니다.';
export const EVT_SYNC_STATUS = Object.freeze({
  subscribed: { label: '걸림', tone: 'green' }, removed: { label: '지움', tone: 'gray' }, none: { label: '지울 것 없음', tone: 'gray' },
  'not-supported': { label: '지원 안 함', tone: 'amber' }, 'auth-stopped': { label: '인증 정지', tone: 'amber' }, auth: { label: '인증 실패', tone: 'red' },
  timeout: { label: '시한 초과', tone: 'red' }, error: { label: '실패', tone: 'red' }, demo: { label: '데모(보내지 않음)', tone: 'gray' },
});
const SEV_LABEL = { critical: '위험', warning: '주의', ok: '정보', '': '모름' };
export const EVT_SEV_ORDER = Object.freeze({ critical: 0, warning: 1, ok: 2, '': 3 });
/** 구독 결과 정렬 — 실패가 먼저(영문 열쇠 순이면 실패 · 성공이 섞였다 — 디버깅 2회차 화면 D10). */
export const EVT_SYNC_ORDER = Object.freeze({ auth: 0, timeout: 1, error: 2, 'auth-stopped': 3, 'not-supported': 4, subscribed: 5, removed: 6, none: 7, demo: 8 });   // 정렬 — 위험 → 주의 → 정보 → 모름(반증 B12)
export const evtSevLabel = (v) => SEV_LABEL[typeof v === 'string' && Object.hasOwn(SEV_LABEL, v) ? v : ''];
/** 장비별 결과 → 한 줄(상태별 수). */
export function syncSummary(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return '대상 서버 없음(이 포탈 등록부에 켜진 iDRAC 이 없습니다)';
  const n = {};
  for (const x of list) n[x?.status] = (n[x?.status] || 0) + 1;
  return `${list.length}대 — ${Object.entries(n).map(([k, v]) => `${EVT_SYNC_STATUS[k]?.label || k} ${v}`).join(' · ')}`;
}
