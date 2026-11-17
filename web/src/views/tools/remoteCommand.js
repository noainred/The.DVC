import { agoText } from './relTime.js';
// 원격 명령 실행(RMA) 화면의 순수 헬퍼(v2.416) — 웹 테스트는 node 환경(DOM 없음)이라 판정·문구는
// 여기서 회귀로 고정한다.

// v2.613 DEPS2613-11: 상대시각은 공용 코어 relTime.agoText 하나다 — 이 화면 계약('5초 미만 = 방금')만 옵션으로 남긴다.
export const ago = (ts, now = Date.now()) => agoText(ts, now, { subMinute: 5000 });

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

/**
 * 결정(56~75 남긴 것) — 상태를 바꾸거나 임의 실행인 명령(서버 카탈로그 ownerOtp — danger) · 셸 점검(script · ssh) 저장은
 *   설정 소유자 등급 + 본인 OTP 다. 판정은 서버(routes/api/rma.js)가 하고 화면은 그 표지로 OTP 칸을 열고 등급이 아니면 잠근다.
 *   인증이 꺼진 설치(Anonymous)는 서버도 통과시키므로 잠그지 않고 OTP 칸도 열지 않는다.
 * @param {{ownerOtp?:boolean}|null} item  카탈로그 항목(명령 또는 점검)
 * @param {{settingsOwnerTier?:boolean, name?:string}|null} user  /auth/me
 * @returns {{ need:boolean, otp:boolean, locked:boolean, reason:string }}
 */
export function ownerOtpGate(item, user, args = null) {
  // 결정(반증 G1a): 인수에 따라 위험해지는 명령(http-request 의 POST · 본문 — 카탈로그 dangerIf)도 같은 게이트(서버 commands.js presetDanger 와 같은 규칙).
  const need = !!item && (item.ownerOtp === true || presetArgsDanger(item.dangerIf, args));
  if (!need) return { need: false, otp: false, locked: false, reason: '' };
  const anonymous = user?.name === 'Anonymous';
  const tier = anonymous || user?.settingsOwnerTier === true;
  return {
    need: true, otp: !anonymous, locked: !tier,
    reason: tier ? '' : '이 명령 · 점검은 상태를 바꾸거나 임의로 실행하므로 설정 소유자 등급(소유자 목록 ∧ 전체 범위) 계정만 쓸 수 있습니다(본인 OTP 도 필요합니다).',
  };
}

/**
 * 결정(반증 G1a): 카탈로그 dangerIf(서버 rma/commands.js presetDanger 와 같은 규칙 — 서버 시험이 같은 입력으로 대조)로 이 인수가 위험 등급인가.
 *   methodPost — 메서드가 POST(앞뒤 공백 무시 · 대소문자 무시) · body — 본문이 비어 있지 않음(앞뒤 공백 제거 뒤).
 */
export function presetArgsDanger(rule, args) {
  if (!rule || typeof rule !== 'object') return false;
  const v = (k) => String(args?.[k] ?? '').trim();
  return !!((rule.methodPost && /^POST$/i.test(v('method'))) || (rule.body && v('body') !== ''));
}

/** 설정 소유자 등급 + 본인 OTP 가 늘 필요한 동작(RMA 비밀번호 설정 · 해제 · 원격 배포 — 서버 ownerOtpThen) — ownerOtpGate 에 넘기는 표지. */
export const OWNER_OTP_ALWAYS = Object.freeze({ ownerOtp: true });

/** OTP 입력값 정리 — 숫자만 6자리까지(빈 값이면 ''). */
export const otpInput = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 6);
