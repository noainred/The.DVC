/**
 * 설정 메뉴 상태 배지 — 판정 코어(v2.916, 설계 docs/design/settings-menu §4.4).
 *
 * 설정 화면 왼쪽 목록이 항목마다 '미설정 · 꺼짐 · 주의 · 새 버전' 을 붙이는 데 쓰는 **순수 함수**다.
 * 사실(facts)은 `sources.js` 가 각 모듈의 파일·메모리 값에서 모아 넘기고, 여기서는 그 사실을 등급으로만 바꾼다.
 *
 * 등급:
 *   unset   — 이 항목이 비어 있어 포탈의 기본 기능이 동작하지 않는다(법인 0 · vCenter 0 · SMTP 없음 · 알림 채널 0 …).
 *   off     — 선택 기능(opt-in)을 쓰지 않는다. **미설정이 아니다** — 쓰지 않는 법인에 호박색이 13개 붙지 않게 회색으로 둔다.
 *   warn    — 서버가 이미 계산한 '주의' 값(인증 정지 · 자가진단 위험 · 장비 신뢰 승인 대기 · 등록부 손상 …).
 *   new     — 업그레이드 새 버전(마지막 확인 기준 — 여기서 외부에 묻지 않는다).
 *   unknown — 그 사실을 **읽지 못했다**. 0 으로도 정상으로도 보지 않는다(루트 CLAUDE.md '못 읽은 값은 0 이 아니다').
 * 아무 표시가 필요 없는 항목은 결과에 넣지 않는다(등급 없음 = 표시 없음).
 *
 * ⚠ 사실 함수 하나가 던져도 다른 항목은 계속 판정한다 — 그 항목만 unknown.
 */

const n = (v) => (Number.isFinite(v) ? v : null);

/**
 * 항목별 규칙. 각 규칙은 사실 하나(이름 = 키)를 받아 { grade, text, count? } 또는 null 을 돌려준다.
 * 사실 함수가 없거나 던지면 unknown 이다(아래 buildSettingsStatus).
 */
export const RULES = Object.freeze({
  // --- 인프라 등록 ---
  'datacenter-admin': (f) => (f.count === 0 ? { grade: 'unset', text: '등록된 법인 없음' } : null),
  'vcenter-admin': (f) => {
    if (f.count === 0) return { grade: 'unset', text: '등록된 vCenter 없음' };
    if (n(f.authStopped) > 0) return { grade: 'warn', text: `인증 실패로 수집 정지 ${f.authStopped}대`, count: f.authStopped };
    return null;
  },
  'nsx-admin': (f) => (f.count === 0 ? { grade: 'off', text: '사용 안 함(등록 없음)' } : null),
  'horizon-admin': (f) => (f.count === 0 ? { grade: 'off', text: '사용 안 함(등록 없음)' } : null),
  'idrac-admin': (f) => (f.loadError ? { grade: 'warn', text: '등록부를 읽지 못함' } : null),
  // --- 백업 ---
  veeam: (f) => {
    if (f.loadError) return { grade: 'warn', text: '등록부를 읽지 못함' };
    return f.count === 0 ? { grade: 'off', text: '사용 안 함(등록 없음)' } : null;
  },
  bareos: (f) => {
    if (f.loadError) return { grade: 'warn', text: '설정을 읽지 못함' };
    return f.directors === 0 ? { grade: 'unset', text: 'Director 없음' } : null;
  },
  backup: (f) => (f.scheduleEnabled === false ? { grade: 'unset', text: '정기 백업 꺼짐' } : null),
  // --- 수집 주기·임계 ---
  'storage-intervals': (f) => (f.loadError ? { grade: 'warn', text: '설정을 읽지 못함' } : null),
  vmseries: (f) => {
    if (f.loadError) return { grade: 'warn', text: '설정을 읽지 못함' };
    return f.enabled === false ? { grade: 'off', text: '꺼짐' } : null;
  },
  'sansw-perf': (f) => {
    if (f.loadError) return { grade: 'warn', text: '설정을 읽지 못함' };
    return f.enabled === false ? { grade: 'off', text: '꺼짐' } : null;
  },
  'isilon-dirusage': (f) => {
    if (f.loadError) return { grade: 'warn', text: '설정을 읽지 못함' };
    return f.targets === 0 ? { grade: 'off', text: '수집 대상 없음' } : null;
  },
  'dir-usage': (f) => (f.targets === 0 ? { grade: 'off', text: '리포트 대상 없음' } : null),
  // --- 게스트·GPU ---
  'guest-partition': (f) => {
    if (f.loadError) return { grade: 'warn', text: '설정을 읽지 못함' };
    return f.enabled === false ? { grade: 'off', text: '꺼짐' } : null;
  },
  'gpu-guest': (f) => (f.enabled === false ? { grade: 'off', text: '꺼짐' } : null),
  // --- 엣지·원격 ---
  collectors: (f) => {
    if (f.loadError) return { grade: 'warn', text: '등록부를 읽지 못함' };
    return f.count === 0 ? { grade: 'off', text: '원격 수집 서버 없음' } : null;
  },
  proxy: (f) => (!f.proxyHost && f.proxies === 0 ? { grade: 'off', text: '중계 서버 없음' } : null),
  // --- 사용자 ---
  'auth-ad': (f) => {
    if (n(f.warnings) > 0) return { grade: 'warn', text: `전송 보안 경고 ${f.warnings}건`, count: f.warnings };
    return f.enabled === false ? { grade: 'off', text: '사용 안 함' } : null;
  },
  // --- 보안 ---
  secrets: (f) => {
    if (f.locked) return { grade: 'warn', text: '정책을 읽지 못해 잠김' };
    if (f.recovered) return { grade: 'warn', text: '정책 파일 이상 — 직전 정책 유지 중' };
    return f.mode === 'plain' ? { grade: 'unset', text: '평문 저장(암호화 미설정)' } : null;
  },
  'host-access': (f) => (f.pendingOverdue ? { grade: 'warn', text: '적용 확인 기한 지남' } : null),
  'peer-trust': (f) => {
    if (f.loadError) return { grade: 'warn', text: '신뢰 목록을 읽지 못함' };
    return n(f.pending) > 0 ? { grade: 'warn', text: `승인 대기 ${f.pending}건${n(f.changed) > 0 ? `(변경 ${f.changed})` : ''}`, count: f.pending } : null;
  },
  'security-self-check': (f) => {
    const risk = n(f.risk) || 0; const warn = n(f.warn) || 0;
    if (risk + warn === 0) return null;
    return { grade: 'warn', text: [risk ? `위험 ${risk}` : '', warn ? `경고 ${warn}` : ''].filter(Boolean).join(' · '), count: risk + warn };
  },
  // --- 알림·메일 ---
  alerts: (f) => (f.channels === 0 ? { grade: 'unset', text: '알림 채널 없음' } : null),
  mail: (f) => {
    if (f.configured === false) return { grade: 'unset', text: 'SMTP 미설정' };
    return f.authStopped ? { grade: 'warn', text: 'SMTP 인증 실패로 발송 정지' } : null;
  },
  'ai-search': (f) => (f.enabled === false ? { grade: 'off', text: '사용 안 함' } : null),
  // --- 로그 ---
  diagnostics: (f) => (n(f.collectionErrors) > 0 ? { grade: 'warn', text: `수집 오류 ${f.collectionErrors}건`, count: f.collectionErrors } : null),
  // --- 시스템 ---
  upgrade: (f) => {
    if (f.available) return { grade: 'new', text: f.latest ? `새 버전 ${String(f.latest).slice(0, 32)}` : '새 버전 있음' };
    return !f.remoteConfigured && !f.watchDir ? { grade: 'unset', text: '업그레이드 소스 없음' } : null;
  },
});

/** 슈퍼 관리자에게만 보이는 항목(설정 화면 SUB 의 superOnly 와 같다). */
export const SUPER_ONLY = Object.freeze(['isilon-dirusage']);

/**
 * @param {Record<string, () => object>} sources 키 → 사실 함수(동기). 없으면 그 항목은 판정하지 않는다.
 * @param {{ superAdmin?: boolean }} who
 * @returns {{ items: Record<string, {grade:string, text:string, count?:number}> }}
 */
export function buildSettingsStatus(sources = {}, { superAdmin = false } = {}) {
  const items = {};
  for (const [k, rule] of Object.entries(RULES)) {
    if (SUPER_ONLY.includes(k) && !superAdmin) continue;   // 슈퍼 전용 항목은 등급(불리언)도 싣지 않는다
    const src = sources[k];
    if (typeof src !== 'function') continue;
    let facts;
    try { facts = src(); } catch { items[k] = { grade: 'unknown', text: '상태를 읽지 못함' }; continue; }
    if (!facts || typeof facts !== 'object') { items[k] = { grade: 'unknown', text: '상태를 읽지 못함' }; continue; }
    let out = null;
    try { out = rule(facts); } catch { out = { grade: 'unknown', text: '상태를 읽지 못함' }; }
    if (out) items[k] = out;
  }
  return { items };
}
