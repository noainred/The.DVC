/**
 * curuser/agentScript.js — 게스트(Windows) 발행기 스크립트 생성(v2.520).
 *
 * '게스트 계정 없이' 경로의 나머지 절반이다. 포탈은 이 스크립트를 **내려주기만** 하고
 * (`GET /tools/curuser/agent-script`), 실행·등록은 각 Windows 서버에서 한 번 한다.
 *
 * ── 설계 규칙 ────────────────────────────────────────────────────────────────────
 * · **스크립트 내용은 ASCII 만** 쓴다. `.ps1` 파일 인코딩은 Windows 버전·BOM 유무에 따라
 *   ANSI/UTF-8 로 다르게 읽히고, 한글 주석이 깨지면 **스크립트 자체가 문법 오류**가 된다
 *   (PDF 파일명을 ASCII 로 만든 v2.519 와 같은 이유 — 배포물의 이름·내용은 보수적으로).
 *   사람이 읽는 설명은 화면·문서에 한글로 둔다.
 * · **네트워크를 쓰지 않는다.** 포탈 주소·토큰이 스크립트에 들어가지 않는다 — 발행 경로는
 *   `vmtoolsd` → VMX 이고, 수집은 포탈이 vCenter 에서 당겨 간다. 운영 서버에 포탈로 나가는
 *   아웃바운드를 만들지 않는 것이 이 방식의 가장 큰 이점이다.
 * · **게스트는 판단하지 않는다.** `quser` 원문을 base64 로 싣기만 한다(파서는 포탈에 있다).
 * · **쓰는 순서가 계약이다** — `d*` → `n` → 부가값 → **`at` 을 마지막에**. 중간 상태를 읽으면
 *   '오래된 시각 + 새 데이터' 가 되어 `stale` 로 보수적으로 떨어진다. 반대 순서면 '새 시각 +
 *   오래된 데이터' 가 되어 **거짓으로 신선**해진다.
 * · 청크가 줄어들 때 남는 옛 `d*` 키는 지우지 않는다 — 읽는 쪽이 `n` 만큼만 본다.
 */

/** 청크 1개 길이(base64 문자). VMX 값 길이 상한이 문서로 확인되지 않아 보수적으로 잡았다. */
export const CHUNK = 900;
/** 청크 최대 개수 — 8 × 900 = 7,200 base64 ≈ 원문 5.4KB ≈ quser 약 65 세션. */
export const MAX_CHUNKS = 8;
export const DEFAULT_TASK = 'PortalCurrentUsers';

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** 스케줄 작업 등록 명령(화면이 그대로 보여 준다 — 복사해서 붙이면 된다). */
export function installCommand({ intervalMinutes = 10, taskName = DEFAULT_TASK, scriptPath = 'C:\\ProgramData\\Portal\\curuser-agent.ps1' } = {}) {
  const m = clampInt(intervalMinutes, 1, 1440, 10);
  const tn = String(taskName || DEFAULT_TASK).replace(/[^A-Za-z0-9._-]/g, '') || DEFAULT_TASK;
  return `schtasks /Create /TN "${tn}" /TR "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \\"${scriptPath}\\"" /SC MINUTE /MO ${m} /RU SYSTEM /RL HIGHEST /F`;
}

/**
 * 발행기 스크립트 본문(ASCII).
 *
 * @param {object} p
 * @param {number} [p.intervalMinutes] 스케줄 주기(주석·`-Install` 에 들어간다)
 * @param {string} [p.taskName]
 */
export function guestAgentScript({ intervalMinutes = 10, taskName = DEFAULT_TASK } = {}) {
  const m = clampInt(intervalMinutes, 1, 1440, 10);
  const tn = String(taskName || DEFAULT_TASK).replace(/[^A-Za-z0-9._-]/g, '') || DEFAULT_TASK;
  const install = installCommand({ intervalMinutes: m, taskName: tn });
  return [
    '# ============================================================================',
    '#  Current Users publisher for the VMware Global Monitoring Portal',
    '#',
    '#  WHAT IT DOES',
    '#    Runs "quser" locally, base64-encodes the raw output and stores it in this',
    '#    VM\'s own configuration through VMware Tools:',
    '#        vmtoolsd --cmd "info-set guestinfo.curuser.<key> <value>"',
    '#    The portal then READS those keys from vCenter (config.extraConfig).',
    '#',
    '#  NO NETWORK, NO CREDENTIALS',
    '#    This script never contacts the portal. It needs no portal account and no',
    '#    guest OS account is handed to the portal. Outbound firewall rules are not',
    '#    required. Everything goes through the existing VMware Tools channel.',
    '#',
    '#  WHAT IT PUBLISHES  (prefix: guestinfo.curuser.)',
    `#    v        schema version (currently 1)`,
    '#    n        number of base64 chunks that follow',
    `#    d0..d${MAX_CHUNKS - 1}  base64(UTF-8 raw quser output), ${CHUNK} chars per chunk`,
    '#    omitted  1 when the output was too large and had to be truncated',
    '#    err      error text when quser could not be run (empty otherwise)',
    '#    host     this computer name (cross-check only)',
    '#    at       unix seconds when this run finished  <-- written LAST on purpose',
    '#',
    '#  WRITE ORDER IS A CONTRACT: chunks -> n -> extras -> at. A reader that catches',
    '#  a half-written state then sees an OLD timestamp with NEW data and treats it',
    '#  as stale (safe). The reverse order would look falsely fresh.',
    '#',
    '#  INSTALL (run once per Windows server, elevated):',
    `#    ${install}`,
    '#  or simply:  powershell -ExecutionPolicy Bypass -File .\\curuser-agent.ps1 -Install',
    '#',
    '#  PRIVACY / TRUST',
    '#    The value is written BY THE GUEST, so anyone able to run vmtoolsd inside the',
    '#    guest can change it. Treat the number as monitoring data, not as an audit',
    '#    record. Account names are included so the portal can count a user logged in',
    '#    to several servers as ONE user.',
    '# ============================================================================',
    'param([switch]$Install, [switch]$Uninstall)',
    '',
    '$ErrorActionPreference = "Continue"',
    `$TaskName = "${tn}"`,
    `$IntervalMinutes = ${m}`,
    `$Prefix = "guestinfo.curuser."`,
    `$Chunk = ${CHUNK}`,
    `$MaxChunks = ${MAX_CHUNKS}`,
    '',
    '# --- locate vmtoolsd -------------------------------------------------------',
    'function Find-VmToolsd {',
    '  $c = @(',
    '    (Join-Path $env:ProgramFiles "VMware\\VMware Tools\\vmtoolsd.exe"),',
    '    (Join-Path ${env:ProgramFiles(x86)} "VMware\\VMware Tools\\vmtoolsd.exe"),',
    '    "C:\\Program Files\\VMware\\VMware Tools\\vmtoolsd.exe"',
    '  )',
    '  foreach ($p in $c) { if ($p -and (Test-Path $p)) { return $p } }',
    '  return $null',
    '}',
    '',
    'if ($Install) {',
    '  $self = $MyInvocation.MyCommand.Path',
    '  $cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$self`""',
    '  schtasks /Create /TN $TaskName /TR $cmd /SC MINUTE /MO $IntervalMinutes /RU SYSTEM /RL HIGHEST /F',
    '  if ($LASTEXITCODE -eq 0) { Write-Host "installed: $TaskName every $IntervalMinutes min" }',
    '  exit $LASTEXITCODE',
    '}',
    'if ($Uninstall) { schtasks /Delete /TN $TaskName /F; exit $LASTEXITCODE }',
    '',
    '$tools = Find-VmToolsd',
    'if (-not $tools) { Write-Error "vmtoolsd.exe not found - install VMware Tools first"; exit 2 }',
    '',
    'function Set-GuestInfo([string]$key, [string]$value) {',
    '  # info-set takes "key rest-of-line", so newlines and control characters would',
    '  # truncate or corrupt the value. Collapse them and cap the length. An empty',
    '  # value would leave a trailing space, so publish "-" and let the reader treat',
    '  # "-" as empty (the portal side documents the same convention).',
    '  $v = [string]$value',
    '  $v = $v -replace "[\\r\\n\\t]+", " "',
    '  $v = ($v -replace "[\\x00-\\x1f]", " ").Trim()',
    '  if ($v.Length -gt 1024) { $v = $v.Substring(0, 1024) }',
    '  if ($v.Length -eq 0) { $v = "-" }',
    '  $null = & $tools --cmd ("info-set " + $Prefix + $key + " " + $v) 2>&1',
    '}',
    '',
    '# --- read quser ------------------------------------------------------------',
    '# quser prints localized state words (English "Active"/"Disc", and localized',
    '# equivalents on non-English Windows). Native command output is decoded with',
    '# [Console]::OutputEncoding, so set it to the machine OEM code page (CP949 on',
    '# Korean Windows) instead of guessing UTF-8.',
    '$raw = ""',
    '$err = ""',
    '$prevEnc = [Console]::OutputEncoding',
    'try {',
    '  try {',
    '    $oem = [System.Globalization.CultureInfo]::InstalledUICulture.TextInfo.OEMCodePage',
    '    if ($oem -gt 0) { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding($oem) }',
    '  } catch { }',
    '  $raw = (& quser 2>&1 | Out-String)',
    '} catch {',
    '  $err = $_.Exception.Message',
    '} finally {',
    '  try { [Console]::OutputEncoding = $prevEnc } catch { }',
    '}',
    '',
    '# "No User exists for *" is NOT an error - it means zero sessions. Keep it in the',
    '# payload and let the portal parser decide (it knows the localized wordings).',
    'if (-not $raw -or $raw.Trim().Length -eq 0) {',
    '  if (-not $err) { $err = "quser produced no output (command missing or blocked)" }',
    '}',
    '',
    '$omitted = 0',
    '$chunks = @()',
    'if (-not $err) {',
    '  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($raw))',
    '  $max = $Chunk * $MaxChunks',
    '  if ($b64.Length -gt $max) { $b64 = $b64.Substring(0, $max); $omitted = 1 }',
    '  for ($i = 0; $i -lt $b64.Length; $i += $Chunk) {',
    '    $len = [Math]::Min($Chunk, $b64.Length - $i)',
    '    $chunks += $b64.Substring($i, $len)',
    '  }',
    '}',
    '',
    '# --- publish (order matters - see header) ----------------------------------',
    'for ($i = 0; $i -lt $chunks.Count; $i++) { Set-GuestInfo ("d" + $i) $chunks[$i] }',
    'Set-GuestInfo "n" $chunks.Count',
    'Set-GuestInfo "v" "1"',
    'Set-GuestInfo "omitted" $omitted',
    'Set-GuestInfo "host" $env:COMPUTERNAME',
    'Set-GuestInfo "err" $err',
    'Set-GuestInfo "at" ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())',
    '',
    'if ($err) { Write-Host ("published error: " + $err); exit 1 }',
    'Write-Host ("published " + $chunks.Count + " chunk(s), " + $raw.Length + " chars of quser output")',
    'exit 0',
    '',
  ].join('\r\n');   // Windows 줄바꿈 — 메모장으로 열어 편집하는 현장을 고려한다.
}

/** ASCII 파일명(v2.519 규칙 — 헤드리스 브라우저가 한글 download 파일명을 잃는다). */
export const AGENT_FILE = 'curuser-agent.ps1';

/** 스크립트에 ASCII 아닌 문자가 없는지(테스트가 고정 — 깨진 인코딩은 문법 오류가 된다). */
export function isAscii(text) { return !/[^\x09\x0a\x0d\x20-\x7e]/.test(String(text || '')); }
