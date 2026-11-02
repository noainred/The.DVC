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

/** v2.849 포탈 리소스가 없을 때의 조치(백틱 없음). */
export const PORTAL_RES_FIX_TEXT = '설정 › 기본 설정에서 이 Director 의 자동 설정 2단계를 실행하거나(포탈 리소스 · 포탈 전용 콘솔을 함께 만듭니다), 설정 화면의 사전 준비 블록에서 FileSet · JobDefs · 복원 잡 부분을 Director 의 bareos-dir.d 아래 파일로 넣고 reload 하세요. 이미 있는 다른 이름을 쓰려면 공통 기본값(JobDefs · FileSet · 복원 잡)을 그 이름으로 바꾸세요.';

/** 등록 실패 · 진단에 같이 쓰는 조치 문구(백틱 없음 — 화면 BoldText). */
export const CONFIGURE_FIX_TEXT = '설정 › 기본 설정에서 이 Director 의 자동 설정 2단계(포탈 전용 콘솔 · Profile ‘portal’ — configure 포함)를 실행하거나, 지금 콘솔의 Profile 의 Command ACL 에 configure 를 허용(‘!configure’ 가 있으면 빼기)한 뒤 Director 를 reload 하세요. configure 를 허용한 콘솔은 사실상 Director 관리자 등급입니다(WebUI 사람 계정과 Profile 을 나눠 쓰면 그 계정에도 권한이 생깁니다).';

/**
 * v2.849(사용자 화면 — configure 를 허용한 뒤 'configure error: Could not find config resource "PortalVmwareDefaults" referenced on line 3: JobDefs = …'):
 * 잡이 참조하는 리소스가 Director 에 없다. JobDefs · FileSet 은 포탈 리소스(자동 설정 2단계 · 사전 준비 블록이 만든다 — 직접 구성한 Director 에는 없다),
 * Client · Storage · Pool · Schedule 은 사이트 매핑 값이다. 길이를 먼저 자르고(선형) 이름은 리소스 이름 모양만 받는다.
 */
const MISSING_RES_RE = /Could not find config resource "([A-Za-z0-9._ -]{1,64})" referenced on line \d{1,6}:\s*([A-Za-z ]{1,24}?)\s*=/i;
const PORTAL_KINDS = new Set(['jobdefs', 'fileset']);
const MAPPING_KINDS = new Set(['client', 'storage', 'pool', 'schedule']);
export function missingResourceOf(message) {
  const m = MISSING_RES_RE.exec(String(message ?? '').slice(0, 2000));
  if (!m) return null;
  const kind = m[2].replace(/\s+/g, '').toLowerCase();
  return { name: m[1], kind, label: m[2].trim() };
}

/** 등록 실패 사유 — configure 가 막혔거나(v2.848) 참조 리소스가 없으면(v2.849) 원인 · 조치를 밝힌다(원문은 끝에 남긴다). 그 밖은 원문 그대로. */
export function addJobFailText(message) {
  const m = String(message ?? '');
  const miss = !CONFIGURE_DENIED_RE.test(m) ? missingResourceOf(m) : null;
  if (miss) {
    const tail = `(Director 원문: ${m.trim().slice(0, 160)})`;
    if (PORTAL_KINDS.has(miss.kind)) return `Director 에 포탈 리소스 ${miss.label} ‘${miss.name}’ 가 없습니다 — 포탈이 만드는 잡은 포탈 리소스(JobDefs · FileSet · 복원 잡)를 참조하는데, 이 리소스들은 자동 설정 2단계 또는 설정 화면의 사전 준비 블록으로 만듭니다(직접 구성한 Director 에는 없습니다). ${PORTAL_RES_FIX_TEXT} ${tail}`;
    if (MAPPING_KINDS.has(miss.kind)) return `Director 에 ${miss.label} ‘${miss.name}’ 가 없습니다 — 이 값은 설정 › 기본 설정의 vCenter 매핑에서 옵니다. 그 Director 에 있는 이름으로 매핑을 고치세요(매핑 자동 채움이 Director 목록에서 고릅니다). ${tail}`;
    return `Director 에 ${miss.label} ‘${miss.name}’ 가 없습니다 — 잡이 참조하는 리소스입니다. ${tail}`;
  }
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

/* ───────── v2.849 포탈 리소스 점검(연결 진단 · 연결 시험 대행) ───────── */
const firstArr = (r) => {
  if (Array.isArray(r)) return r;
  if (!r || typeof r !== 'object') return [];
  for (const v of Object.values(r)) if (Array.isArray(v)) return v;
  return [];
};
const nameSet = (r) => new Set(firstArr(r).map((x) => (typeof x === 'string' ? x : x && typeof x.name === 'string' ? x.name : '')).filter(Boolean).slice(0, 100_000));
const RES_CHECKS = Object.freeze([['jobDefs', 'JobDefs', '.jobdefs'], ['fileSet', 'FileSet', '.filesets'], ['restoreJob', '복원 잡', '.jobs']]);

/**
 * 포탈이 잡을 만들 때 참조하는 리소스(공통 기본값 JobDefs · FileSet · 복원 잡)가 Director 에 있는가 — 목록 명령(읽기 전용)만.
 * @param {{ jobDefs?, fileSet?, restoreJob? }} expect 공통 기본값(이름 모양이 아니면 그 칸은 보지 않는다)
 * @returns {Promise<{ ok: boolean|null, missing: {key,label,name}[], unknown: {key,label,name}[], detail: string }>} ok null = 하나라도 확인하지 못함(빠진 것도 없음)
 */
export async function portalResources(session, expect = {}, { timeoutMs } = {}) {
  const missing = []; const unknown = []; const found = [];
  const lists = new Map();
  for (const [key, label, cmd] of RES_CHECKS) {
    const name = String(expect?.[key] ?? '');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) continue;
    if (!lists.has(cmd)) {
      try { lists.set(cmd, nameSet(await session.call(cmd, timeoutMs ? { timeoutMs } : undefined))); } catch (e) { lists.set(cmd, e); }
    }
    const l = lists.get(cmd);
    if (l instanceof Error) unknown.push({ key, label, name });
    else if (l.has(name)) found.push({ key, label, name });
    else missing.push({ key, label, name });
  }
  const fmt = (xs) => xs.map((x) => `${x.label} ‘${x.name}’`).join(' · ');
  const detail = missing.length ? `없음: ${fmt(missing)}${unknown.length ? ` · 확인 못 함: ${fmt(unknown)}` : ''}`
    : unknown.length ? `확인하지 못했습니다: ${fmt(unknown)}(목록 명령이 막혔거나 실패)` : found.length ? `있음: ${fmt(found)}` : '점검할 이름이 없습니다.';
  return { ok: missing.length ? false : unknown.length || !found.length ? null : true, missing, unknown, detail: detail.slice(0, 300) };
}

/** 엣지 회신 정제(probe.resources) — 아는 칸만. */
export function normPortalResources(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const rows = (a) => (Array.isArray(a) ? a : []).slice(0, 5).map((x) => ({ key: String(x?.key ?? '').slice(0, 20), label: String(x?.label ?? '').slice(0, 20), name: String(x?.name ?? '').slice(0, 64) }))
    .filter((x) => /^[A-Za-z0-9._-]{1,64}$/.test(x.name));
  return { ok: v.ok === true ? true : v.ok === false ? false : null, missing: rows(v.missing), unknown: rows(v.unknown), detail: String(v.detail ?? '').replace(/[\r\n\0]/g, ' ').slice(0, 300) };
}
