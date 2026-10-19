/**
 * v2.744 최종 수정분 적대적 검토 — 그룹 VA(패키징 셸) · PKG-01.
 *
 *  PKG-01 install.sh 4) 가 AUTH_SECRET 을 만들 때 "$PREFIX/runtime/node/bin/node" 를 root 로 실행했다. 부모 $PREFIX/runtime 은 지난 설치의
 *         5) chown -R 로 서비스 계정 소유라, 2) 가 root 로 새로 복사한 node 를 3) 의 mv·cp -a(수 초) 동안 서비스 계정이 rename 으로
 *         갈아끼울 수 있었다(같은 부모 안의 rename 은 옮기는 폴더의 쓰기 권한을 요구하지 않는다 — 반증자 둘이 uid 0 실행으로 재현).
 *         같은 파일의 VP_CFG_NODE 규칙('$PREFIX/runtime/node 는 root 로 실행하지 않는다')을 그 한 줄만 따르지 않았다.
 *         이제 vp_gen_secret 이 root 가 믿는 도구만 쓴다 — ① 패키지 node(VP_CFG_NODE) ② openssl rand ③ od(/dev/urandom). 전부 실패하면
 *         빈 AUTH_SECRET 으로 portal.env 를 만들지 않고 멈춘다.
 *
 *  ① 소스 스윕(주석 제거 · 따옴표·명령 치환·heredoc 을 아는 스캐너): root 로 도는 install.sh 에서 $PREFIX·$APP_DST·$BAK·$CONFIG_DIR
 *     (와 그 값에서 파생된 변수) 아래 경로를 **명령 자리**에서 실행하는 곳이 0 이다. 변수로 실행하는 명령은 허용 목록(사유)과 대조한다.
 *     스윕 자체는 합성 입력(양성·음성)으로 먼저 고정한다 — 공허하게 통과하는 스윕을 막는다.
 *  ② vp_gen_secret 의 순서·폴백·실패(가짜 node·openssl·od 를 PATH 앞에 둔다).
 *  ③ install.sh 4) 구간을 실제 bash 로 돌린다 — 가짜 $PREFIX/runtime/node/bin/node(실행되면 표지 파일을 남김)를 심어 둔 채로,
 *     그 파일이 실행되지 않고 AUTH_SECRET 이 그 출력이 아닌 64자리 16진인지 · 도구가 없으면 portal.env 를 만들지 않고 멈추는지.
 *
 * ⚠ install.sh 는 통째로 실행하지 않는다(시스템을 바꾼다) — audit2744j·fh 와 같이 함수·구간을 꺼내 임시 폴더 위에서 돌린다.
 *   시각(Date.now())을 기준값으로 쓰지 않는다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_PATH = path.join(ROOT, 'packaging', 'offline', 'install.sh');
const INSTALL = fs.readFileSync(INSTALL_PATH, 'utf8');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744va-'));
after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* */ } });
let seq = 0;
/** 가짜 설치 환경: <d>/etc/cfg(= CONFIG_DIR — 부모 <d>/etc 가 root 전용 임시 폴더 자리) · <d>/prefix · <d>/bin(가짜 도구) */
function mkEnv() {
  const d = path.join(BASE, `e${++seq}`);
  fs.mkdirSync(path.join(d, 'etc', 'cfg'), { recursive: true });
  fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
  return { d, cfg: path.join(d, 'etc', 'cfg'), etc: path.join(d, 'etc'), bin: path.join(d, 'bin'), prefix: path.join(d, 'prefix') };
}
const leftovers = (env) => fs.readdirSync(env.etc).filter((n) => n.startsWith('.vmware-portal-cfg.'));

function shellFn(text, name) {
  const a = text.indexOf(`\n${name}() {`);
  if (a < 0) return null;
  const b = text.indexOf('\n}\n', a + 1);
  return b < 0 ? null : text.slice(a + 1, b + 2);
}
function allFns(text) {
  const names = [...text.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{$/gm)].map((m) => m[1]);
  return names.map((n) => shellFn(text, n)).filter(Boolean).join('\n');
}
function region(start, end) {
  const a = INSTALL.indexOf(start);
  const b = INSTALL.indexOf(end, a + 1);
  assert.ok(a > 0 && b > a, `install.sh 구간을 찾지 못했다: ${start} ~ ${end}`);
  return INSTALL.slice(INSTALL.lastIndexOf('\n', a) + 1, b);
}
const FNS = allFns(INSTALL);
/** install.sh 의 함수 전부를 올린 bash(set -euo pipefail). PATH 앞에 가짜 도구 폴더를 둘 수 있다. */
function bash(script, args = [], env = {}, { binFirst = null } = {}) {
  const PATH = binFirst ? `${binFirst}:${process.env.PATH}` : process.env.PATH;
  return spawnSync('bash', ['-c', `set -euo pipefail\n${FNS}\n${script}`, '_', ...args], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH, VP_CFG_NODE: '', VP_CFG_MAX_BYTES: '', VP_CFG_COPY_TIMEOUT: '', VP_CFG_NODE_WARNED: '', NODE_OPTIONS: '', ...env },
  });
}
const done = (r) => assert.equal(r.error, undefined, `시한 안에 끝나야 한다: ${r.error} ${r.stderr}`);
function fakeBin(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(f, 0o755);
  return f;
}
const HEX64 = /^[0-9a-f]{64}$/;
const A64 = 'a'.repeat(64);
const B64 = 'b'.repeat(64);
const F64 = 'f'.repeat(64);

/* ── ① 소스 스윕 ───────────────────────────────────────────────────────────────────────────────────────── */
/** ${…} 를 짝 맞는 } 까지 건너뛴다(i 는 '{' 위치). */
function skipBrace(src, i) {
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}
/** $(( … )) 를 건너뛴다(i 는 첫 '(' 위치). */
function skipArith(src, i) {
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}
/**
 * 단순 명령이 시작하는 위치를 모두 낸다 — 따옴표('…'·"…"·$'…')·명령 치환($(…)·`…`)·${…}·$((…))·((…))·[[ … ]]·주석·heredoc 을 안다.
 * 줄바꿈·; | & ( ) 와 명령 치환 시작이 명령 경계다. 큰따옴표·[[ ]] 안의 $(…) 도 실행이므로 경계로 본다.
 * [[ … ]] 안의 && || ( 는 명령 경계가 아니다(검사 식이다).
 */
function commandHeads(src) {
  const heads = [0];
  const stack = ['top'];
  const heredocs = [];
  let i = 0;
  const n = src.length;
  const wordStart = (k) => k === 0 || /[\s;|&(!]/.test(src[k - 1]);
  while (i < n) {
    const c = src[i];
    const ctx = stack[stack.length - 1];
    if (ctx === 'sq') { if (c === "'") stack.pop(); i++; continue; }
    if (c === '\\') { i += 2; continue; }
    if (ctx === 'dq') {
      if (c === '"') { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { i = skipBrace(src, i + 1); continue; }
      if (c === '$' && src[i + 1] === '(') {
        if (src[i + 2] === '(') { i = skipArith(src, i + 1); continue; }
        stack.push('cs'); i += 2; heads.push(i); continue;
      }
      if (c === '`') { stack.push('bt'); i++; heads.push(i); continue; }
      i++; continue;
    }
    // top · cs · bt · tst
    if (ctx === 'bt' && c === '`') { stack.pop(); i++; continue; }
    if (c === "'") { stack.push('sq'); i++; continue; }
    if (c === '"') { stack.push('dq'); i++; continue; }
    if (c === '#' && (i === 0 || /[\s;|&(]/.test(src[i - 1]))) { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '$' && src[i + 1] === '{') { i = skipBrace(src, i + 1); continue; }
    if (c === '$' && src[i + 1] === "'") { // $'…'(ANSI-C) — 작은따옴표처럼
      i += 2; while (i < n && src[i] !== "'") { if (src[i] === '\\') i++; i++; } i++; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      if (src[i + 2] === '(') { i = skipArith(src, i + 1); continue; }
      stack.push('cs'); i += 2; heads.push(i); continue;
    }
    if (c === '`') { stack.push('bt'); i++; heads.push(i); continue; }
    if (ctx === 'tst') {
      if (c === ']' && src[i + 1] === ']' && /[\s;)&|]|$/.test(src[i + 2] || '')) { stack.pop(); i += 2; continue; }
      i++; continue;
    }
    if (c === '[' && src[i + 1] === '[' && wordStart(i) && /\s/.test(src[i + 2] || '')) { stack.push('tst'); i += 2; continue; }
    if (c === '(' && src[i + 1] === '(' && wordStart(i)) { i = skipArith(src, i); continue; } // ((…)) 산술 명령
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(src.slice(i));
      if (m) { heredocs.push({ word: m[3], dash: m[1] === '-' }); i += m[0].length; continue; }
    }
    if (c === ')' && ctx === 'cs') { stack.pop(); i++; continue; }
    if (c === '\n') {
      i++;
      while (heredocs.length) { // heredoc 본문은 명령이 아니다 — 끝 표지 줄까지 건너뛴다
        const h = heredocs.shift();
        while (i < n) {
          const e = src.indexOf('\n', i);
          const line = src.slice(i, e < 0 ? n : e);
          i = e < 0 ? n : e + 1;
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.word) break;
        }
      }
      heads.push(i); continue;
    }
    if (c === '&' && (src[i - 1] === '<' || src[i - 1] === '>' || src[i + 1] === '>')) { i++; continue; } // <&·>&·&> 리다이렉션은 경계가 아니다
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { i++; heads.push(i); continue; } // ) — case 패턴·( … ) 묶음 끝
    i++;
  }
  return heads;
}
/** i 에서 시작하는 낱말의 끝 위치(따옴표·$(…)·${…}·$'…' 를 안다). */
function wordEnd(src, i) {
  const st = [];
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const top = st[st.length - 1];
    if (top === 'sq') { if (c === "'") st.pop(); i++; continue; }
    if (c === '\\') { i += 2; continue; }
    if (top === 'dq') {
      if (c === '"') { st.pop(); i++; continue; }
      if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) { st.push(src[i + 1] === '(' ? 'cs' : 'br'); i += 2; continue; }
      i++; continue;
    }
    if (c === "'") { st.push('sq'); i++; continue; }
    if (c === '"') { st.push('dq'); i++; continue; }
    if (c === '$' && src[i + 1] === "'") { st.push('sq'); i += 2; continue; }
    if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) { st.push(src[i + 1] === '(' ? 'cs' : 'br'); i += 2; continue; }
    if (top === 'cs') { if (c === '(') st.push('cs'); else if (c === ')') st.pop(); i++; continue; }
    if (top === 'br') { if (c === '}') st.pop(); i++; continue; }
    if (/[\s;|&()<>]/.test(c)) return i;
    i++;
  }
  return i;
}
/** p 부터 그 단순 명령의 낱말들(리다이렉션은 뺀다). 줄바꿈·; | & ( ) 에서 멈춘다. */
function words(src, p, max = 16) {
  const out = [];
  let i = p;
  const n = src.length;
  while (out.length < max && i < n) {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
    if (i >= n || /[\n;|&()#]/.test(src[i])) break;
    const r = /^\d*(?:<<-?|<>|>>|>&|<&|&>|>\||[<>])/.exec(src.slice(i, i + 4));
    if (r) { // 리다이렉션 + 대상 낱말
      i += r[0].length;
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      i = wordEnd(src, i);
      continue;
    }
    const e = wordEnd(src, i);
    if (e === i) break;
    out.push(src.slice(i, e));
    i = e;
  }
  return out;
}
const WRAPPERS = /^(?:env|exec|sudo|nohup|command|builtin|nice|setsid|bash|sh|source|\.|eval|time)$/;
/** 그 위치의 명령 단어 — 앞의 키워드·변수 대입·감싸개(env·exec·sudo·timeout·bash·source·"${arr[@]}" …)를 건너뛴 첫 낱말. */
function commandWord(src, p) {
  const ws = words(src, p);
  let k = 0;
  while (k < ws.length) {
    const w = ws[k];
    if (/^(?:then|do|else|elif|if|while|until|!|\{)$/.test(w)) { k++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(w)) { k++; continue; }
    if (WRAPPERS.test(w)) {
      k++;
      while (k < ws.length && /^-/.test(ws[k])) { k += /^-[ugCc]$/.test(ws[k]) ? 2 : 1; }
      continue;
    }
    if (w === 'timeout' || w === 'chroot') { k++; while (k < ws.length && /^-/.test(ws[k])) k++; k++; continue; }
    if (w === 'runuser' || w === 'setpriv') { const d = ws.indexOf('--', k); k = d < 0 ? ws.length : d + 1; continue; }
    if (/^"\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}"$/.test(w)) { k++; continue; }
    return w;
  }
  return null;
}
/** 값이 그 변수들(직접 또는 파생)로 시작하는 대입을 따라 '오염된' 변수 집합을 만든다(고정점). for X in "$PREFIX…" 도 센다. */
function taintedVars(src, seeds) {
  const t = new Set(seeds);
  for (let changed = true; changed;) {
    changed = false;
    const names = [...t].join('|');
    const re = new RegExp(String.raw`(?:^|[\s;&|(])(?:local\s+|export\s+|readonly\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=["']?\$\{?(?:${names})\b` +
      String.raw`|\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+["']?\$\{?(?:${names})\b`, 'g');
    for (const m of src.matchAll(re)) {
      const v = m[1] || m[2];
      if (v && !t.has(v)) { t.add(v); changed = true; }
    }
  }
  return t;
}
const SEEDS = ['PREFIX', 'APP_DST', 'BAK', 'CONFIG_DIR'];
/** 오염된 경로를 명령 자리에서 실행하는 곳 · 변수로 실행하는 명령 전부. */
function scanExec(src, seeds = SEEDS) {
  const taint = taintedVars(src, seeds);
  const tre = new RegExp(String.raw`^["']?\$\{?(?:${[...taint].join('|')})\b`);
  const lineOf = (p) => src.slice(0, p).split('\n').length;
  const tainted = [];
  const varExec = [];
  for (const p of commandHeads(src)) {
    const w = commandWord(src, p);
    if (!w) continue;
    if (tre.test(w)) tainted.push({ line: lineOf(p), word: w });
    else if (/^["']?\$/.test(w)) varExec.push({ line: lineOf(p), word: w });
  }
  return { taint, tainted, varExec };
}

test('PKG-01 ①-a 스윕 자체 — 합성 입력: 명령 자리의 실행은 잡고(명령 치환·감싸개·파생 변수·for 변수), 인자·검사·sed 표현식·주석·heredoc 은 잡지 않는다', () => {
  const pos = [
    'SECRET="$("$PREFIX/runtime/node/bin/node" -e \'1\')"',
    '"$APP_DST/server/x.sh" --go',
    'bash "$CONFIG_DIR/hook.sh"',
    'source "$PREFIX/lib.sh"',
    'n="$PREFIX/runtime/node/bin/node"\n"$n" -v',
    'for s in "$BAK/a.sh" "$APP_DST/b.sh"; do "$s"; done',
    'if [[ -f x ]]; then "${PREFIX}/bin/tool" a; fi',
    'x=$(env FOO=1 "$PREFIX/runtime/node/bin/node" -v)',
    'sudo -n "$CONFIG_DIR/x"',
    'out="$(timeout 5 "$PREFIX/runtime/node/bin/node" -v)"',
    'a | "$PREFIX/runtime/node/bin/node" -e 1',
    'ok=`"$PREFIX/x"`',
    'case "$k" in\n  a) "$PREFIX/bin/a" ;;\nesac',
    '[[ -x "$APP_DST/t.sh" ]] && "$APP_DST/t.sh" go',
    'if [[ -n x && -f y ]]; then "$PENV" ; fi\nPENV="$CONFIG_DIR/portal.env"',
  ];
  for (const s of pos) assert.ok(scanExec(s).tainted.length >= 1, `잡아야 한다: ${s}`);
  const neg = [
    'mkdir -p "$PREFIX/runtime"',
    'cp -a "$SCRIPT_DIR/runtime/node" "$PREFIX/runtime/node"',
    '[[ -x "$APP_DST/otp-enroll.sh" ]] && echo y',
    'sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" in > out',
    'echo "$PREFIX/runtime/node/bin/node 는 실행하지 않는다"',
    '# "$PREFIX/runtime/node/bin/node" -e 1',
    'x=1   # ; "$PREFIX/runtime/node/bin/node"',
    'NODE_TYPE="$(stat -c %C "$PREFIX/runtime/node/bin/node" 2>/dev/null | awk -F: \'{print $3}\' || true)"',
    'T="$(vp_cfg_tmp "$PENV")"',
    "cat <<'EOF'\n\"$PREFIX/x\" a\nEOF\necho ok",
    'printf \'%s ALL=(root) NOPASSWD: x; "$PREFIX/y"\\n\' u',
    'VP_CFG_NODE="$SCRIPT_DIR/runtime/node/bin/node"\n"$VP_CFG_NODE" -v',
    'if [[ "$PREFIX" != /opt/* && "$PREFIX" != /usr/* ]] && command -v semanage >/dev/null 2>&1; then :; fi',
    'if ! T="$(vp_cfg_tmp "$PENV")"; then T=""; fi',
    'TOOLS_DIR="$(vp_root_tools_dir "$PREFIX")"',
    'while read -r l; do :; done <&"$fd"\nexec {fd}<&-\ncmd 2>&1 >"$PREFIX/log"',
    '(( 10#$PORT < 1 || 10#$PORT > 65535 )) && echo bad',
    'x="${err%%$\'\\n\'*}"; y=1',
  ];
  for (const s of neg) assert.deepEqual(scanExec(s).tainted, [], `잡으면 안 된다: ${s}`);
  // 변수로 실행하는 명령은 따로 센다(허용 목록 대조용)
  assert.deepEqual(scanExec('node="${VP_CFG_NODE:-}"\n"$node" -e 1').varExec.map((x) => x.word), ['"$node"']);
});

// install.sh 에서 변수로 실행하는 명령의 허용 목록 — 사유와 함께. 새로 생기면 이 표에 사유를 적거나(그 변수가 root 가 믿는 경로일 때만) 고친다.
const VAR_EXEC_ALLOW = [
  { re: /^"\$node"$/, why: 'vp_cfg_snap·vp_gen_secret 의 지역 변수 — 값은 VP_CFG_NODE(패키지 node, $SCRIPT_DIR — 이 스크립트와 같은 신뢰)뿐이다(아래 ①-c 가 대입을 고정)' },
  { re: /^"\$SCRIPT_DIR\/[^"$]+"$/, why: '패키지 폴더(root 가 푼 설치 패키지 — 이 스크립트 자신과 같은 신뢰. 0) 의 source release-verify-lib.sh)' },
];

test('PKG-01 ①-b install.sh — root 로 $PREFIX·$APP_DST·$BAK·$CONFIG_DIR(와 파생 변수) 아래를 명령 자리에서 실행하는 곳이 0 이다', () => {
  const { taint, tainted, varExec } = scanExec(INSTALL);
  // 스윕이 install.sh 를 실제로 훑었다는 증거 — 파생 변수(APP_DST·BAK·PENV·HOSTKEYS)를 찾았고 명령 경계가 수백 개다
  for (const v of ['APP_DST', 'BAK', 'PENV', 'HOSTKEYS']) assert.ok(taint.has(v), `파생 변수 ${v}`);
  assert.ok(commandHeads(INSTALL).length > 300, '명령 경계를 충분히 찾았다');
  assert.deepEqual(tainted, [], `root 가 서비스 계정 소유 트리의 파일을 실행한다: ${JSON.stringify(tainted)}`);
  const unknown = varExec.filter((x) => !VAR_EXEC_ALLOW.some((a) => a.re.test(x.word)));
  assert.deepEqual(unknown, [], `변수로 실행하는 새 명령 — 그 변수가 어디서 오는지 확인하고 허용 목록에 사유를 적을 것: ${JSON.stringify(unknown)}`);
});

test('PKG-01 ①-c "$node" 로 실행하는 함수의 node 는 VP_CFG_NODE 뿐이고 VP_CFG_NODE 는 패키지($SCRIPT_DIR)의 것이다', () => {
  const body = INSTALL.replace(/^\s*#.*$/gm, '');
  const assigns = [...body.matchAll(/\bnode="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(assigns.length >= 2, 'vp_cfg_snap·vp_gen_secret 의 node 대입');
  for (const a of assigns) assert.equal(a, '${VP_CFG_NODE:-}', `node 의 값은 VP_CFG_NODE 뿐: ${a}`);
  const top = body.split('\n').filter((l) => /^VP_CFG_NODE=/.test(l));
  assert.deepEqual(top, ['VP_CFG_NODE="$SCRIPT_DIR/runtime/node/bin/node"']);
  assert.ok(INSTALL.indexOf('VP_CFG_NODE="$SCRIPT_DIR') < INSTALL.indexOf('# 4) Config'), '4) 전에 정한다');
  // 4) 의 AUTH_SECRET 은 vp_gen_secret 으로 — 예전 줄이 남아 있지 않다
  const cfg = region('# 4) Config', '# 5) Permissions').replace(/^\s*#.*$/gm, '');
  assert.match(cfg, /SECRET="\$\(vp_gen_secret\)"/);
  assert.doesNotMatch(cfg, /runtime\/node\/bin\/node"\s+-e/);
});

/* ── ② vp_gen_secret ───────────────────────────────────────────────────────────────────────────────────── */
test('PKG-01 ②-a vp_gen_secret — 함수가 있고, 실제 node 로 64자리 16진을 낸다(두 번 부르면 다르다)', () => {
  assert.ok(shellFn(INSTALL, 'vp_gen_secret'), 'install.sh vp_gen_secret');
  const r = bash('vp_gen_secret; vp_gen_secret', [], { VP_CFG_NODE: process.execPath });
  done(r);
  assert.equal(r.status, 0, r.stderr);
  const [x, y] = r.stdout.trim().split('\n');
  assert.match(x, HEX64);
  assert.match(y, HEX64);
  assert.notEqual(x, y);
});

test('PKG-01 ②-b 순서 — 패키지 node → openssl → od · 형식이 틀린 출력·실패는 다음 도구로', () => {
  const env = mkEnv();
  const pkgNode = fakeBin(path.join(env.d, 'pkg'), 'node', `printf '${A64}'`);
  const badNode = fakeBin(path.join(env.d, 'pkg'), 'badnode', "printf 'not-hex'");
  const failNode = fakeBin(path.join(env.d, 'pkg'), 'failnode', 'exit 1');
  fakeBin(env.bin, 'openssl', `[ "$1 $2 $3" = "rand -hex 32" ] || exit 9\nprintf '${B64}\\n'`);
  // ① 패키지 node 가 먼저
  let r = bash('vp_gen_secret', [], { VP_CFG_NODE: pkgNode }, { binFirst: env.bin });
  done(r); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), A64);
  // ② node 가 없거나(빈 값·실행 불가) 형식이 틀리거나 실패하면 openssl
  for (const n of ['', path.join(env.d, 'pkg', 'nothere'), badNode, failNode]) {
    r = bash('vp_gen_secret', [], { VP_CFG_NODE: n }, { binFirst: env.bin });
    done(r); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), B64, `node='${n}' → openssl`);
  }
  // ③ openssl 이 실패하거나 형식이 틀리면 od(/dev/urandom) — 실제 od
  const env2 = mkEnv();
  fakeBin(env2.bin, 'openssl', "printf 'zz\\n'");
  r = bash('vp_gen_secret; vp_gen_secret', [], { VP_CFG_NODE: badNode }, { binFirst: env2.bin });
  done(r); assert.equal(r.status, 0, r.stderr);
  const [x, y] = r.stdout.trim().split('\n');
  assert.match(x, HEX64); assert.match(y, HEX64); assert.notEqual(x, y);
});

test('PKG-01 ②-c 쓸 수 있는 도구가 하나도 없으면 1 이고 아무것도 내지 않는다(빈 AUTH_SECRET 금지)', () => {
  const env = mkEnv();
  fakeBin(env.bin, 'openssl', 'exit 1');
  fakeBin(env.bin, 'od', 'exit 1');
  const failNode = fakeBin(path.join(env.d, 'pkg'), 'node', 'exit 1');
  const r = bash('r=0; out="$(vp_gen_secret)" || r=$?; printf "rc=%s out=[%s]\\n" "$r" "$out"', [], { VP_CFG_NODE: failNode }, { binFirst: env.bin });
  done(r);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'rc=1 out=[]');
});

/* ── ③ install.sh 4) 구간 — 실제 bash ─────────────────────────────────────────────────────────────────── */
const CFG_REGION = region('# 4) Config', '# 5) Permissions');
/** 4) 를 돌린다. $PREFIX/runtime/node/bin/node 에는 '서비스 계정이 갈아끼운' 가짜를 심는다(실행되면 표지 파일을 남기고 F64 를 낸다). */
function runConfig(env, envVars = {}, opt = {}) {
  const mark = path.join(env.d, 'PREFIX-NODE-RAN');
  fakeBin(path.join(env.prefix, 'runtime', 'node', 'bin'), 'node', `echo "uid=$(id -u)" > '${mark}'\nprintf '${F64}\\n'`);
  const appDst = path.join(env.d, 'app');
  fs.mkdirSync(path.join(appDst, 'server', 'config'), { recursive: true });
  const script = `CONFIG_DIR="$1"; SCRIPT_DIR="$2"; PREFIX="$3"; PORT=4711; BAK=""; APP_DST="$4"\n${CFG_REGION}`;
  const r = bash(script, [env.cfg, path.join(ROOT, 'packaging', 'offline'), env.prefix, appDst], envVars, opt);
  return { r, mark };
}
const authSecretOf = (f) => (fs.readFileSync(f, 'utf8').match(/^AUTH_SECRET=(.*)$/m) || [])[1];

test('PKG-01 ③-a 4) — 패키지 node 가 있으면 그것으로 만든다 · $PREFIX/runtime/node 는 실행하지 않는다', () => {
  const env = mkEnv();
  const pkgNode = fakeBin(path.join(env.d, 'pkg'), 'node', `printf '${A64}'`);
  const { r, mark } = runConfig(env, { VP_CFG_NODE: pkgNode });
  done(r);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(mark), false, `root 가 $PREFIX/runtime/node/bin/node 를 실행했다: ${fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : ''}`);
  assert.deepEqual(leftovers(env), []);
  if (IS_ROOT) {
    const penv = path.join(env.cfg, 'portal.env');
    assert.equal(authSecretOf(penv), A64, 'AUTH_SECRET 은 패키지 node 의 출력');
    assert.match(fs.readFileSync(penv, 'utf8'), /^PORT=4711$/m);
    assert.equal(fs.statSync(penv).mode & 0o7777, 0o640);
  }
});

test('PKG-01 ③-b 4) — 패키지 node 가 없어도(VP_CFG_NODE 빈 값) $PREFIX/runtime/node 로 떨어지지 않는다 · openssl·od 로 64자리 16진', () => {
  const env = mkEnv();
  const { r, mark } = runConfig(env, { VP_CFG_NODE: '' });
  done(r);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(mark), false, `root 가 $PREFIX/runtime/node/bin/node 를 실행했다: ${fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : ''}`);
  if (IS_ROOT) {
    const s = authSecretOf(path.join(env.cfg, 'portal.env'));
    assert.match(s, HEX64);
    assert.notEqual(s, F64, 'AUTH_SECRET 이 $PREFIX node 의 출력이 아니다');
  }
});

test('PKG-01 ③-c 4) — 쓸 수 있는 도구가 없으면 portal.env 를 만들지 않고 멈춘다(사유를 말한다) · 그때도 $PREFIX/runtime/node 는 실행하지 않는다', () => {
  const env = mkEnv();
  fakeBin(env.bin, 'openssl', 'exit 1');
  fakeBin(env.bin, 'od', 'exit 1');
  const { r, mark } = runConfig(env, { VP_CFG_NODE: '' }, { binFirst: env.bin });
  done(r);
  assert.notEqual(r.status, 0, '설치를 멈춘다');
  assert.match(r.stderr, /AUTH_SECRET\(32바이트 난수\)을 만들지 못해/);
  assert.match(r.stderr, /root 로 실행하지 않습니다/);
  assert.equal(fs.existsSync(path.join(env.cfg, 'portal.env')), false, '빈 AUTH_SECRET 으로 portal.env 를 만들지 않는다');
  assert.equal(fs.existsSync(mark), false, '$PREFIX/runtime/node/bin/node 로 떨어지지 않는다');
  assert.deepEqual(leftovers(env), []);
});

test('PKG-01 ③-d 4) — portal.env 가 이미 있으면 AUTH_SECRET 을 만들지 않는다(도구가 없어도 멈추지 않는다 — 예전과 같다)', () => {
  const env = mkEnv();
  fakeBin(env.bin, 'openssl', 'exit 1');
  fakeBin(env.bin, 'od', 'exit 1');
  fs.writeFileSync(path.join(env.cfg, 'portal.env'), 'AUTH_SECRET=keep\nPORT=4000\n');
  const { r, mark } = runConfig(env, { VP_CFG_NODE: '' }, { binFirst: env.bin });
  done(r);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /기존 환경설정 유지/);
  assert.equal(authSecretOf(path.join(env.cfg, 'portal.env')), 'keep');
  assert.equal(fs.existsSync(mark), false);
});
