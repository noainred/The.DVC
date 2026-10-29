/**
 * bareos/names.js — Bareos 콘솔 명령에 들어가는 이름·값의 **유일한 관문**(순수 함수).
 *
 * 근거(Director 원본에서 확인):
 *  - 콘솔 인자 파서 `next_arg`(lib/scan.cc): 공백이 필드 끝, `"` 는 인용을 켜고 끄며 지워지고, `\` 는 다음 글자를 그대로 넣는다.
 *  - `configure add`(dird/ua_configure.cc): 값에 `@`(include)·`;`(지시어 끝)가 있으면 거부. 문자열·이름·리소스 형은
 *    `Key = "값"` 으로, **`FdPluginOptions`(CFG_TYPE_ALIST_STR)는 따옴표 없이** 그대로 쓴다 — 공백이 든 값을 쓰려면
 *    값 자체에 따옴표를 넣어 넘겨야 한다(문서의 `directive="\"value with spaces\""` 형식).
 *  - FD 플러그인 옵션 파서(BareosFdPluginBaseclass.parse_plugindef_string): `:` 로 나누고 첫 `=` 로 키·값을 가른다.
 *    값의 `:` 는 `\:` 로 피할 수 있지만, 그 문자열이 설정 파일 렉서를 한 번 더 지나며 `\` 가 사라질 수 있어 **`:` 자체를 거부**한다.
 *  - FD 는 옵션 문자열 앞의 플러그인 이름을 `python3`(정확히) 또는 `python`(끝 글자 뺀 것)으로 맞춘다(filed/fd_plugins.cc).
 */

/** Bareos 리소스 이름(잡·클라이언트·스토리지·풀·스케줄·JobDefs·FileSet) — 포탈이 받는 범위. */
export const RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** FD 측 경로(config_file) — 절대 경로, 안전한 문자만. */
const FD_PATH_RE = /^\/[A-Za-z0-9._/-]{1,250}$/;
/** 플러그인 이름 — FileSet 의 `Plugin = "python3:…"` 와 맞춘다. */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** vSphere 객체 이름(VM·폴더·데이터센터)에서 받지 않는 글자. 이유는 머리말. */
const FORBIDDEN_VALUE_RE = /[\u0000-\u001f\u007f"\\:;@]/;
const MAX_VALUE_LEN = 200;

export const isResourceName = (s) => typeof s === 'string' && RESOURCE_NAME_RE.test(s);

/**
 * vSphere 쪽 값(VM 이름·폴더 경로·데이터센터 경로·vCenter 주소)을 플러그인 옵션에 넣을 수 있는가.
 * @returns {string} 거부 사유('' 이면 통과)
 */
export function pluginValueIssue(v, what = '값') {
  const s = typeof v === 'string' ? v : '';
  if (!s.trim()) return `${what}이(가) 비어 있습니다.`;
  if (s.length > MAX_VALUE_LEN) return `${what}이(가) 너무 깁니다(${MAX_VALUE_LEN}자 이하).`;
  if (s !== s.trim()) return `${what} 앞뒤에 공백이 있습니다.`;
  const bad = FORBIDDEN_VALUE_RE.exec(s);
  if (bad) {
    const ch = bad[0];
    const label = ch === '"' ? '큰따옴표' : ch === '\\' ? '역슬래시' : ch === ':' ? '콜론(:)' : ch === ';' ? '세미콜론(;)' : ch === '@' ? '@' : '제어 문자';
    return `${what}에 Bareos 가 받지 못하는 글자(${label})가 있습니다.`;
  }
  return '';
}

/** 32비트 FNV-1a → 16진 8자리(잡 이름의 vCenter 부분 — vcenterId 에는 콜론·공백이 들어갈 수 있다). */
export function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 포탈이 만드는 Bareos 잡 이름: `pv-<vCenter 해시 8>-<moref>`. moref 는 `vm-123` 같은 vSphere 관리 객체 id.
 * 같은 VM 은 언제나 같은 이름(재등록 시 Director 가 '이미 있음' 으로 알려 준다 — 중복 잡을 만들지 않는다).
 * @returns {string} 잡 이름(리소스 규칙을 만족하지 못하면 '')
 */
export function jobNameFor(vcenterId, moref, suffix = '') {
  const m = String(moref ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!m) return '';
  const sx = String(suffix ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  const name = `pv-${shortHash(vcenterId)}-${m}${sx ? `-${sx}` : ''}`;
  return isResourceName(name) ? name : '';
}

/** vSphere 폴더 경로 → 플러그인 형식(`/a/b`, 루트는 `/`). 빈 값·`vm`(포탈의 루트 표기)은 `/`. */
export function folderForPlugin(folderPath) {
  const s = String(folderPath ?? '').trim();
  if (!s || s === '/' || s === 'vm') return '/';
  const parts = s.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

/**
 * 백업 잡의 FD 플러그인 옵션 문자열(따옴표 없이). 자격증명은 넣지 않는다 — `config_file`(FD 의 INI)이 갖는다.
 * @param {{ plugin?: string, vcserver: string, dc: string, folder: string, vmname: string, configFile: string }} p
 * @returns {{ value?: string, issue?: string }}
 */
export function backupPluginOptions(p = {}) {
  const plugin = p.plugin || 'python3';
  if (!PLUGIN_NAME_RE.test(plugin)) return { issue: '플러그인 이름이 올바르지 않습니다.' };
  const checks = [
    [p.vcserver, 'vCenter 주소(vcserver)'], [p.dc, '데이터센터 이름'], [p.vmname, 'VM 이름'],
  ];
  for (const [v, what] of checks) { const i = pluginValueIssue(v, what); if (i) return { issue: i }; }
  const folder = folderForPlugin(p.folder);
  const fi = pluginValueIssue(folder, '폴더 경로');
  if (fi) return { issue: fi };
  if (!FD_PATH_RE.test(String(p.configFile || '')) || /(^|\/)\.\.(\/|$)/.test(p.configFile)) {
    return { issue: 'FD 자격증명 파일 경로(config_file)가 올바르지 않습니다(절대 경로, 영문·숫자·._-/ 만).' };
  }
  return { value: `${plugin}:vcserver=${p.vcserver}:dc=${p.dc}:folder=${folder}:vmname=${p.vmname}:config_file=${p.configFile}` };
}

/**
 * 복원용 플러그인 옵션(덮어쓸 키만). 값 규칙은 백업과 같다.
 * @param {Record<string,string>} kv  예: { restore_powerstate:'off', vmname:'x', restore_datastore:'ds1' }
 */
export function restorePluginOptions(kv = {}, plugin = 'python3') {
  if (!PLUGIN_NAME_RE.test(plugin)) return { issue: '플러그인 이름이 올바르지 않습니다.' };
  const ALLOWED = new Set(['restore_powerstate', 'vmname', 'restore_datastore', 'restore_esxhost', 'restore_cluster', 'restore_resourcepool', 'localvmdk', 'folder', 'dc']);
  const parts = [];
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined || v === null || v === '') continue;
    if (!ALLOWED.has(k)) return { issue: `복원 옵션 ‘${k}’ 은(는) 받지 않습니다.` };
    const val = k === 'folder' ? folderForPlugin(v) : String(v);
    const i = pluginValueIssue(val, k);
    if (i) return { issue: i };
    parts.push(`${k}=${val}`);
  }
  if (!parts.length) return { issue: '복원 옵션이 비어 있습니다.' };
  return { value: `${plugin}:${parts.join(':')}` };
}

/**
 * 콘솔 인자 1개를 인용한다(`key="값"` 의 값 부분). 값은 이미 관문을 지난 것이어야 한다 — 여기서는 `\`·`"` 만 피한다.
 * @param {string} v
 * @param {{ literalQuotes?: boolean }} [o] literalQuotes=true 면 값 자체를 따옴표로 감싸 넘긴다(ALIST_STR 지시어 — 머리말).
 */
export function consoleQuote(v, { literalQuotes = false } = {}) {
  const inner = literalQuotes ? `"${String(v)}"` : String(v);
  return `"${inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Bareos 잡 레벨(포탈 입력) → 콘솔 값. */
export const LEVELS = Object.freeze({ Full: 'Full', Incremental: 'Incremental', Differential: 'Differential' });
export const normLevel = (v, def = 'Incremental') => (Object.prototype.hasOwnProperty.call(LEVELS, v) ? LEVELS[v] : def);

/**
 * Bareos JobStatus 한 글자 → 포탈 상태.
 * 근거: Bareos `include/job_status.h` — C created · R running · B blocked · T OK · W OK with warnings · E error · e non-fatal error ·
 *       f fatal error · D verify diff · A canceled · I incomplete · F/S/m/M/s/j/c/d/t/p/q/L 는 대기 계열.
 * @returns {'queued'|'running'|'ok'|'warning'|'error'|'canceled'|'waiting'|'unknown'}
 */
export function statusOf(code) {
  const c = String(code ?? '').slice(0, 1);
  if (c === 'T') return 'ok';
  if (c === 'W') return 'warning';
  if (c === 'R') return 'running';
  if (c === 'C') return 'queued';
  if (c === 'A') return 'canceled';
  if (c && 'EefID'.includes(c)) return 'error';
  if (c && 'BFSmMsjcdtpqL'.includes(c)) return 'waiting';
  return 'unknown';
}
/** 끝난 상태인가(폴러가 pending 을 내릴지). */
export const isFinalStatus = (code) => ['ok', 'warning', 'error', 'canceled'].includes(statusOf(code));
