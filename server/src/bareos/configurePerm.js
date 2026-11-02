/**
 * bareos/configurePerm.js — v2.848 잡 만들기 권한(`configure`) 판정 하나(사용자 화면 '1대 등록 실패 — configure: is an invalid command.').
 *
 * 포탈은 VM 마다 `configure add job` 으로 잡을 만든다. Bareos 는 콘솔 Profile 의 Command ACL 이 막은 명령을 **없는 명령과 같은 문구**
 * ('<명령>: is an invalid command.')로 답한다(v2.841 — `.schedule` 때 확인한 동작 · web bareosText.js catalogErrorText). Bareos 패키지 기본
 * Profile(webui-admin · operator)은 `!configure` 다 — WebUI 계정 콘솔을 포탈 접속에 쓰면 조회는 되고 등록만 실패한다.
 *
 * 판정은 연결 진단(console.diagnoseConsole) · 연결 시험 대행(director.probe → 엣지 회신 정제) · 등록 실패 사유(service · manage/service)가 같이 쓴다.
 * ⚠ 실환경 미확인(추정): 인자 없는 `configure` 는 사용법 오류만 돌려주고 아무것도 만들지 않는다(ua_configure.cc — argc < 3 이면 사용법).
 *   응답이 둘 중 어느 모양도 아니면 '모름'(null)으로 두고 단정하지 않는다.
 */

/** Director 의 '명령이 막힘(또는 없음)' 응답. */
export const CONFIGURE_DENIED_RE = /\bconfigure:\s*is an invalid command/i;

/** 등록 실패 · 진단에 같이 쓰는 조치 문구(백틱 없음 — 화면 BoldText). */
export const CONFIGURE_FIX_TEXT = '설정 › 기본 설정에서 이 Director 의 자동 설정 2단계(포탈 전용 콘솔 · Profile ‘portal’ — configure 포함)를 실행하거나, 지금 콘솔의 Profile 의 Command ACL 에 configure 를 허용(‘!configure’ 가 있으면 빼기)한 뒤 Director 를 reload 하세요. configure 를 허용한 콘솔은 사실상 Director 관리자 등급입니다(WebUI 사람 계정과 Profile 을 나눠 쓰면 그 계정에도 권한이 생깁니다).';

/** 등록 실패 사유 — configure 가 막혔으면 원인 · 조치를 밝힌다(원문은 끝에 남긴다). 그 밖은 원문 그대로. */
export function addJobFailText(message) {
  const m = String(message ?? '');
  if (!CONFIGURE_DENIED_RE.test(m)) return m;
  return `Director 가 잡 만들기 명령(configure)을 받지 않았습니다 — 포탈이 이 Director 에 접속하는 콘솔의 Profile 이 Command ACL 에서 configure 를 허용하지 않는 것으로 보입니다(Bareos 는 ACL 로 막힌 명령을 ‘is an invalid command’ 로 답합니다 · 패키지 기본 Profile webui-admin · operator 는 configure 를 막아 둡니다). ${CONFIGURE_FIX_TEXT} 설정 › 기본 설정의 연결 시험에서 ‘잡 만들기 권한’ 단계로 미리 확인할 수 있습니다. (Director 원문: ${m.trim().slice(0, 120)})`;
}

/**
 * 세션 하나로 권한을 본다 — 인자 없는 `configure`(아무것도 만들지 않는다 — 머리말 추정).
 * @returns {Promise<{ allowed: boolean|null, detail: string }>} allowed: true 허용(사용법 응답) · false 막힘 · null 모름(다른 오류)
 */
export async function configurePermission(session, { timeoutMs } = {}) {
  try {
    await session.call('configure', timeoutMs ? { timeoutMs } : undefined);
    return { allowed: true, detail: '허용(인자 없는 시험 명령 — 아무것도 만들지 않음)' };
  } catch (e) {
    const m = String(e?.message || e || '');
    if (CONFIGURE_DENIED_RE.test(m)) return { allowed: false, detail: m.trim().slice(0, 200) };
    if (e?.code === 'jsonrpc') return { allowed: true, detail: '허용(사용법 응답 — 아무것도 만들지 않음)' };
    return { allowed: null, detail: `확인하지 못했습니다(${e?.code || 'error'}: ${m.slice(0, 160)})` };
  }
}

/** 엣지 회신 정제(probe.configure) — 아는 칸만. */
export function normConfigurePerm(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const allowed = v.allowed === true ? true : v.allowed === false ? false : null;
  return { allowed, detail: String(v.detail ?? '').replace(/[\r\n\0]/g, ' ').slice(0, 200) };
}
