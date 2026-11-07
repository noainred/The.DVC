/**
 * bmusage/snapshot/command.js — 진단 스냅샷의 **상수 명령**과 파서(순수 · v2.923 예정 · 설계 README §4.1 · 아트보드 Server.dc.html 진단 스냅샷).
 *
 * ⚠⚠ 원격 명령 실행 경로의 규약(docs/rules/security-api.md v2.923 — 테스트가 고정):
 *   ① **명령은 이 파일의 상수 문자열 하나**다 — 서버 이름 · 사유 · 사용자 입력 · 설정값(상위 N · 줄 수)을 끼워 넣지 않는다(설정은 파서가 결과를 자를 때만 쓴다).
 *   ② **읽기 전용** — /proc · ps · ss · dmesg 만. 대상 서버에 파일을 쓰지 않는다(임시 파일 없음 — /proc/<pid>/io 두 번의 차이는 awk 메모리에서 계산).
 *   ③ **sudo 금지** — 권한이 없으면 그 칸은 ‘확인 불가’(권한 부족)다. sudo · su · pkexec 를 자동으로 시도하지 않는다(소스 스윕).
 *   ④ **프로세스 인자를 읽지 않는다** — ps 는 comm(이름)만, /proc/<pid>/comm 만(cmdline · environ 금지 — 인자 · 환경 변수에 비밀번호가 실린다).
 *   ⑤ **출력 상한** — 구획마다 head/tail · cut(줄 수 · 줄 폭) + 전체 head -c(SNAPSHOT_OUTPUT_MAX — sshExec 상한보다 작게). 파서도 줄 수 · 길이를 다시 자른다.
 *   ⑥ 앵커 없는 무제한 반복 정규식 금지(장비 출력) — 줄 길이를 먼저 자르고 앵커 + 길이 상한으로만.
 *   iDRAC 쪽은 이 명령이 아니다 — 이미 가진 인벤토리(SEL/LC 최근)와 센서 순간값만(Redfish 호출 0 — snapshot/run.js).
 */

/**
 * 결과 code → HTTP 상태(라우트 공용 — 웹 문구 표와 1:1). 실행을 시도한 실패(ssh-error · auth · timeout …)는 200 + ok:false(보관됨).
 * edge 는 중앙이 엣지에 닿지 못했을 때(엣지 대행 실패 — kind 가 원인을 나눈다).
 */
export const SNAPSHOT_CODE_STATUS = Object.freeze({
  ok: 200, 'bad-reason': 400, 'not-found': 404, forbidden: 403, 'no-os-path': 409, busy: 409, 'daily-cap': 429, 'store-unavailable': 503,
  'ssh-error': 200, auth: 200, 'host-key': 200, timeout: 200, 'not-linux': 200, edge: 502,
});
export const SNAPSHOT_CODES = Object.freeze(Object.keys(SNAPSHOT_CODE_STATUS));
/** 칸 상태(파서) — 웹 문구 표와 1:1. */
export const SNAPSHOT_STATES = Object.freeze(['ok', 'perm', 'partial', 'absent', 'missing']);

/** 명령이 받는 최대치(설정 topN · dmesgLines 의 상한과 같다 — 결과는 파서가 설정값으로 더 자른다). */
export const SNAPSHOT_PS_MAX = 30;
export const SNAPSHOT_IO_MAX = 30;
export const SNAPSHOT_DMESG_MAX = 200;
export const SNAPSHOT_SS_MAX = 20;
/** 전체 출력 상한(바이트) — 구획 상한의 합(약 80KB)보다 크고 sshExec EXEC_MAX_OUTPUT(4MB)보다 훨씬 작다(테스트가 산수를 고정). */
export const SNAPSHOT_OUTPUT_MAX = 256 * 1024;
/** 보관 결과 JSON 상한(글자) — db.js snapshotInsert 의 마지막 방어선과 같은 값(단일 원천). 넘치면 fitSnapshotResult 가 큰 칸부터 덜어 낸다(반증 R4). */
export const SNAPSHOT_RESULT_MAX = 64 * 1024;
/** 구획 순서 — 파서는 이 순서에서 지금보다 뒤의 표지만 받는다(반증 R6 — 이미 본 구획을 다시 열지 않는다). */
export const SNAPSHOT_SECTIONS = Object.freeze(['PSCPU', 'PSMEM', 'PIDS', 'IO', 'SS', 'DMESG', 'END']);
/** /proc/<pid>/io 두 표본 사이 간격(초) — 명령 안의 sleep 과 같은 값(상수). */
export const SNAPSHOT_IO_GAP_S = 2;
/** 구획 줄 폭(cut) — 파서 MAX_LINE 과 같다. */
const W = { PS: 160, SS: 200, DMESG: 300 };

/*
 * /proc/<pid>/io 두 표본(2초 간격)의 차이 — awk 가 메모리에서 계산하고 바이트 합 상위 SNAPSHOT_IO_MAX 개만 낸다(대상 서버에 파일을 쓰지 않는다).
 *   입력 줄: `/proc/<pid>/io:read_bytes: <n>` · 구분 줄 `@@` · 시각 줄 `t=<uptime 초>`.
 *   출력: `readable=<첫 표본에서 읽힌 pid 수>` · `span=<초>` · `io <pid> <읽기 바이트> <쓰기 바이트> <comm>`.
 *   이름은 /proc/<pid>/comm 만(cmdline 금지). 권한이 없는 pid 는 grep -s 가 조용히 건너뛴다 → readable 이 PIDS 보다 작으면 ‘일부 권한 부족’.
 */
const IO_AWK = "awk -F'[/:]' '"
  + '/^t=/ { t[++ti] = substr($0, 3) + 0; next } '
  + '$0 == "@@" { p = 2; next } '
  + 'NF >= 6 { v = $6; gsub(/ /, "", v); k = $3 SUBSEP $5; '
  + 'if (p == 2) { if (k in a) { d = v - a[k]; if (d < 0) d = 0; if ($5 == "read_bytes") r[$3] += d; else w[$3] += d; s[$3] = 1 } } '
  + 'else { a[k] = v; q[$3] = 1 } } '
  + 'END { n = 0; for (x in q) n++; print "readable=" n; if (ti >= 2) print "span=" (t[2] - t[1]); '
  + `for (i = 1; i <= ${SNAPSHOT_IO_MAX}; i++) { best = ""; bv = 0; for (x in s) if (!(x in done) && r[x] + w[x] > bv) { bv = r[x] + w[x]; best = x } `
  + 'if (best == "") break; done[best] = 1; nm = "?"; f = "/proc/" best "/comm"; if ((getline nm < f) <= 0) nm = "?"; close(f); '
  + 'print "io " best " " r[best] " " w[best] " " substr(nm, 1, 32) } }\'';
const IO_SAMPLE = "grep -s -H -E '^(read_bytes|write_bytes):' /proc/[0-9]*/io";
const UPTIME = "awk '{print \"t=\" $1}' /proc/uptime";

/**
 * 스냅샷 명령(상수) — 함수가 아니라 값이다(인자를 받을 자리가 없다).
 * ps 는 pid · user · %CPU(수명 평균 — 지금 순간값이 아니다) · RSS(KB) · comm.
 */
export const SNAPSHOT_COMMAND = Object.freeze([
  'export LC_ALL=C; {',
  `echo '##PSCPU'; ps -e -o pid=,user=,pcpu=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n ${SNAPSHOT_PS_MAX} | cut -c1-${W.PS};`,
  `echo '##PSMEM'; ps -e -o pid=,user=,pcpu=,rss=,comm= --sort=-rss 2>/dev/null | head -n ${SNAPSHOT_PS_MAX} | cut -c1-${W.PS};`,
  "echo '##PIDS'; ls -d /proc/[0-9]* 2>/dev/null | wc -l;",
  `echo '##IO'; { ${UPTIME}; ${IO_SAMPLE}; echo '@@'; sleep ${SNAPSHOT_IO_GAP_S}; ${UPTIME}; ${IO_SAMPLE}; } 2>/dev/null | ${IO_AWK} | head -n ${SNAPSHOT_IO_MAX + 2} | cut -c1-120;`,
  `echo '##SS'; ss -s 2>/dev/null | head -n ${SNAPSHOT_SS_MAX} | cut -c1-${W.SS};`,
  // 반증 R6: 커널 로그 줄마다 `d:` 접두 — 이어진 줄(들여쓰기)이나 메시지 안 문자열이 ‘##IO’ 같은 표지가 되지 못하게(파서가 벗긴다).
  `echo '##DMESG'; dmesg --level=err,warn -T 2>&1 | tail -n ${SNAPSHOT_DMESG_MAX} | cut -c1-${W.DMESG} | sed 's/^/d:/';`,
  "echo '##END';",
  `} | head -c ${SNAPSHOT_OUTPUT_MAX}`,
].join(' '));

/**
 * v2.929(5단계) — 집중 모니터링의 **경량 스냅샷**(설계 PROFILES §13 ‘ps 상위 5 · /proc/pid/io 차이 · softnet · ss -s’). 진단 스냅샷의 같은 조각(상수)에서
 *   CPU 상위 5 · PIDS · IO 차이(2초) · ss -s 만 — 커널 로그(dmesg 원문) · 메모리 상위는 넣지 않는다(분마다 원문을 남기지 않는다 · 개수는 주 명령의 ##DMESG).
 *   softnet 은 주 명령(##SOFTNET)이 이미 읽는다. 같은 SSH 세션에서 주 명령 뒤에 돈다(collectOsUsage extraCommands — 세션을 더 열지 않는다).
 *   규약은 SNAPSHOT_COMMAND 와 같다: 상수 · 읽기 전용 · sudo 없음 · 인자 없음(comm 만) · 출력 상한. 파서도 같다(parseSnapshot — 없는 구획은 missing).
 */
export const FOCUS_SNAPSHOT_TOP = 5;
export const FOCUS_SNAPSHOT_OUTPUT_MAX = 16 * 1024;
export const FOCUS_SNAPSHOT_COMMAND = Object.freeze([
  'export LC_ALL=C; {',
  `echo '##PSCPU'; ps -e -o pid=,user=,pcpu=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n ${FOCUS_SNAPSHOT_TOP} | cut -c1-${W.PS};`,
  "echo '##PIDS'; ls -d /proc/[0-9]* 2>/dev/null | wc -l;",
  `echo '##IO'; { ${UPTIME}; ${IO_SAMPLE}; echo '@@'; sleep ${SNAPSHOT_IO_GAP_S}; ${UPTIME}; ${IO_SAMPLE}; } 2>/dev/null | ${IO_AWK} | head -n ${FOCUS_SNAPSHOT_TOP + 2} | cut -c1-120;`,
  `echo '##SS'; ss -s 2>/dev/null | head -n 8 | cut -c1-${W.SS};`,
  "echo '##END';",
  `} | head -c ${FOCUS_SNAPSHOT_OUTPUT_MAX}`,
].join(' '));

const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const MAX_LINE = 320;
const MAX_LINES = 400;

/**
 * 구획 표지로 쪼갠다(줄 길이 · 줄 수를 먼저 자른다).
 * ⚠ 반증 R6(R1 과 같은 규칙): 표지는 줄 머리 그대로(trim 없이) 정확 일치 · SNAPSHOT_SECTIONS 순서에서 지금보다 뒤의 표지만 · 이미 본 표지는 다시 열지 않는다.
 */
export function splitSnapshot(text) {
  const out = {}; let cur = null; let curIdx = -1;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    const m = /^##([A-Z]{2,8})$/.exec(line);
    if (m && !Object.hasOwn(out, m[1])) {
      const i = SNAPSHOT_SECTIONS.indexOf(m[1]);
      if (i > curIdx) { cur = m[1]; curIdx = i; out[cur] = []; continue; }
    }
    if (cur && out[cur].length < MAX_LINES && line.trim() !== '') out[cur].push(line);
  }
  return out;
}

/** ps 한 줄 `pid user pcpu rss comm…` → 객체(못 읽으면 null). comm 은 마지막 칸(공백 포함 가능 — 앞 네 칸 뒤 전부). */
function psLine(l) {
  const m = /^\s{0,12}(\d{1,10})\s{1,16}(\S{1,40})\s{1,16}([\d.]{1,8})\s{1,16}(\d{1,14})\s{1,16}(.{1,64})$/.exec(String(l).slice(0, 200));
  if (!m) return null;
  return { pid: Number(m[1]), user: m[2].slice(0, 32), cpuPct: num(m[3]), rssKb: num(m[4]), name: m[5].trim().slice(0, 32) };
}

const PERM_RE = /(operation not permitted|permission denied|read kernel buffer failed)/i;

/**
 * 출력 → 결과(순수). topN · dmesgLines 는 설정값(결과를 자를 뿐 — 명령에는 들어가지 않는다).
 * 상태: 칸마다 'ok' | 'perm'(권한 부족) | 'partial'(일부 권한 부족) | 'absent'(명령 없음 · 0줄) | 'missing'(표지 미도착 — 잘림).
 */
export function parseSnapshot(stdout, { topN = 10, dmesgLines = 50 } = {}) {
  const sec = splitSnapshot(stdout);
  const has = (k) => Array.isArray(sec[k]);
  const truncated = !has('END');
  const state = (k, ok) => (!has(k) ? 'missing' : !sec[k].length ? 'absent' : ok ? 'ok' : 'missing');
  const N = Math.max(1, Math.min(SNAPSHOT_PS_MAX, Math.floor(Number(topN) || 10)));
  const cpu = (sec.PSCPU || []).map(psLine).filter(Boolean).slice(0, N);
  const mem = (sec.PSMEM || []).map(psLine).filter(Boolean).slice(0, N);
  const pids = num((sec.PIDS || [])[0]);
  // I/O — readable · span · io 줄
  let readable = null; let span = null; const io = [];
  for (const l of sec.IO || []) {
    const s = String(l).trim();
    let m = /^readable=(\d{1,8})$/.exec(s);
    if (m) { readable = Number(m[1]); continue; }
    m = /^span=([\d.]{1,12})$/.exec(s);
    if (m) { span = num(m[1]); continue; }
    m = /^io (\d{1,10}) (\d{1,20}) (\d{1,20}) (.{1,32})$/.exec(s);
    if (m && io.length < N) {
      const sp = span && span > 0 ? span : SNAPSHOT_IO_GAP_S;
      io.push({ pid: Number(m[1]), name: m[4].trim(), readBps: Math.round(Number(m[2]) / sp), writeBps: Math.round(Number(m[3]) / sp) });
    }
  }
  let ioState = state('IO', readable != null);
  if (ioState === 'ok') {
    if (readable === 0) ioState = 'perm';
    else if (pids != null && readable < pids * 0.9) ioState = 'partial';   // 10% 이상 못 읽음 — 프로세스가 사이에 끝난 것과 구분하려 여유를 둔다(추정)
  }
  // ss -s 요약 줄(주소 없음)
  const ss = (sec.SS || []).map((l) => String(l).trim().slice(0, 200)).filter(Boolean).slice(0, SNAPSHOT_SS_MAX);
  const ssTcp = (() => {
    const l = ss.find((x) => /^TCP:/.test(x));
    if (!l) return null;
    const g = (k) => { const m = new RegExp(`\\b${k}\\s(\\d{1,9})`).exec(l); return m ? Number(m[1]) : null; };
    const total = /^TCP:\s{1,8}(\d{1,9})/.exec(l);
    return { total: total ? Number(total[1]) : null, estab: g('estab'), timewait: g('timewait'), orphaned: g('orphaned') };
  })();
  // dmesg — `d:` 접두 줄만(반증 R6). 권한 판정은 dmesg 자신의 오류 줄(`dmesg:` 로 시작)만 본다(반증 R5 — 커널 메시지 안의 ‘Permission denied’ 는 실제 오류다).
  const dm = (sec.DMESG || []).filter((l) => String(l).startsWith('d:')).map((l) => String(l).slice(2, 302));
  const dmesgSelfErr = dm.length > 0 && dm.length <= 3 && dm.every((l) => /^dmesg:/.test(l));
  const dmesgPerm = dmesgSelfErr && dm.some((l) => PERM_RE.test(l));
  const dmesgFail = dmesgSelfErr && !dmesgPerm;   // 권한이 아닌 dmesg 자체 오류(옵션 미지원 등) — 커널 로그로 보이지 않고 ‘받지 못함’
  const D = Math.max(1, Math.min(SNAPSHOT_DMESG_MAX, Math.floor(Number(dmesgLines) || 50)));
  return {
    v: 1,
    cpuTop: cpu, memTop: mem, ioTop: io,
    pids, ioReadable: readable, ioSpanS: span,
    ss: ss.slice(0, SNAPSHOT_SS_MAX), ssTcp,
    dmesg: dmesgSelfErr ? [] : dm.slice(-D), dmesgTotal: dmesgSelfErr ? 0 : dm.length,
    states: {
      cpu: state('PSCPU', cpu.length > 0), mem: state('PSMEM', mem.length > 0), io: ioState,
      ss: state('SS', ss.length > 0), dmesg: dmesgPerm ? 'perm' : dmesgFail ? 'missing' : !has('DMESG') ? 'missing' : !dm.length ? 'absent' : 'ok',
    },
    truncated,
  };
}

/**
 * 반증 R4 — 보관 결과가 SNAPSHOT_RESULT_MAX 를 넘으면 예전에는 db.js 가 결과를 통째로 `{truncated}` 로 바꿔 **다시 열면 모든 칸이 ‘받지 못함’** 이 됐다
 *   (설정 상한 topN 30 · dmesgLines 200 × 300자 안에서 도달 — 반증 재현 70KB). 큰 칸부터 덜어 상한 안에 맞추고 덜어 낸 사실을 밝힌다(1단계 D1 ‘전부 버리지 않는다’):
 *   ① 커널 로그를 **오래된 줄부터**(최근 줄을 남긴다) ② iDRAC 이벤트 문장 ③ ss 원문 ④ 프로세스 표(상위 5개만) ⑤ 오류 문장 100자.
 * @returns {object} 상한 안이면 그대로, 아니면 `trimmed:[칸]` · `dmesgDropped` 를 단 사본.
 */
export function fitSnapshotResult(result, maxChars = SNAPSHOT_RESULT_MAX) {
  if (!result || typeof result !== 'object') return result;
  const len = (o) => { try { return JSON.stringify(o).length; } catch { return Infinity; } };
  if (len(result) <= maxChars) return result;
  let r = { ...result, trimmed: [] };
  const mark = (k) => { if (!r.trimmed.includes(k)) r = { ...r, trimmed: [...r.trimmed, k] }; };
  if (Array.isArray(r.dmesg) && r.dmesg.length) {
    const all = r.dmesg; let excess = len(r) - maxChars; let cut = 0;
    while (cut < all.length && excess > 0) { excess -= JSON.stringify(all[cut]).length + 1; cut += 1; }
    r = { ...r, dmesg: all.slice(cut), dmesgDropped: cut }; mark('dmesg');
  }
  if (len(r) > maxChars && r.idrac && Array.isArray(r.idrac.events) && r.idrac.events.length) { r = { ...r, idrac: { ...r.idrac, events: r.idrac.events.map((e) => ({ ...e, message: String(e?.message || '').slice(0, 40) })) } }; mark('idrac'); }
  if (len(r) > maxChars && Array.isArray(r.ss) && r.ss.length) { r = { ...r, ss: [] }; mark('ss'); }
  if (len(r) > maxChars) { for (const k of ['cpuTop', 'memTop', 'ioTop']) if (Array.isArray(r[k]) && r[k].length > 5) { r = { ...r, [k]: r[k].slice(0, 5) }; mark(k); } }
  if (len(r) > maxChars && typeof r.error === 'string' && r.error.length > 100) { r = { ...r, error: r.error.slice(0, 100) }; mark('error'); }
  return r;
}
