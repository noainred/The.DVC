/**
 * bmusage/parse/linuxTop.js — 리눅스 성능 8b단계 **프로세스 Top-N**(설계 PROFILES §20 ⑳ · 아트보드 TopProc).
 *
 * 같은 SSH **세션**에서 주 명령 · 피크 창 · 덧붙인 exec(7a 로그) 뒤에 도는 **별도 exec** 하나(`collectors/osSsh.js collectOsUsage` · `topCommand()`).
 *   ⚠⚠ 8b 반증 F1: 처음 판은 주 명령(`linuxCommand`) 안 구획 `##TOP` 이었다 — 주 명령은 exec 시한(30초) 하나라 top 대기 · 시한이 주 명령의 timeout 합을
 *   시한 밖으로 밀면 그 주기 **전 구획**(CPU · 메모리 · 디스크 · 네트 · 사실 · 건강)을 잃었다(실제 collectOsUsage 재현). 이제 남은 예산 안에서만 돌고(MIN_SLICE 아래면
 *   건너뛰고 사유 'budget') · 실패해도 본 표본은 그대로다. 명령 조각은 전부 이 모듈의 **상수**다(변수 삽입 없음).
 *
 * ── 무엇을 읽나(읽기 전용 · kill 등 조작 없음) ────────────────────────────────────────────
 *   ① CPU 상위 후보 20 — `top -b -n 2 -d 1 -w 512 -o %CPU` 의 **둘째 프레임**(첫 프레임은 부팅 이후 평균이라 버린다 — procps-ng top(8)).
 *      top 이 없거나 둘째 프레임 머리글을 못 찾으면 대안 `/proc/[0-9]*\/stat` 을 1초 간격 2회 읽어 (utime+stime) 차이 ÷ CLK_TCK ÷ 경과(proc(5)).
 *      ⚠ top 의 COMMAND 열은 **보내지 않는다** — awk 가 머리글로 PID · S · %CPU 열만 골라 낸다(사용자 toprc 가 명령줄 표시를 켜 두었어도 인자가 셸 밖으로
 *        나오지 않게 · HOME/XDG_CONFIG_HOME 을 없는 곳으로 돌려 개인 toprc 도 읽지 않는다). 이름은 아래 ③ 의 /proc/<pid>/stat comm 만 쓴다.
 *   ② I/O — `/proc/<pid>/io` read_bytes · write_bytes 를 CPU 측정 앞(전 프로세스 · grep 1회 · 내보내지 않음)과 뒤(**CPU 상위 후보 20 만**) 두 번 읽은 차이 ÷ 경과.
 *      그 파일은 같은 사용자 또는 CAP_SYS_PTRACE 가 필요하다 — 못 읽으면 `p`(권한) 로 내고 파서는 값을 null(‘—’)로 둔다(0 으로 적지 않는다).
 *   ③ 후보마다 `/proc/<pid>/stat`(comm · 상태 · 누적 utime+stime · starttime · rss) · `/proc/<pid>/status`(Uid) → /etc/passwd 이름(없으면 숫자 uid).
 *      **comm 만**(커널이 주는 프로세스 이름 · 인자 · 환경 · 열린 파일은 읽지 않는다 — 16차 보안 설계).
 *   ④ 메모리 상위 5 — `ps -eo pid,user:16,rss,stat,etimes,comm --sort=-rss`(RSS 는 공유 페이지 중복 포함 — PSS 아님).
 *   ⑤ 프로세스 수 · 실행 중(R) · D(디스크 대기) 수 · 전 프로세스 %CPU 합(나머지 합계용) — 같은 프레임(또는 같은 두 번째 stat 읽기)에서 센다.
 *
 * ── 구획 규약(4단계 반증 R1 · 1단계 D1 — 되돌리지 말 것) ─────────────────────────────────────
 *   · **모든 줄에 고정 접두**(`tS:` 머리 · `tC:` CPU 후보 · `tM:` 메모리 상위) — comm 은 아무 사용자나 정하는 문자열이라(`prctl PR_SET_NAME` · /proc/self/comm 쓰기)
 *     줄 머리에 오면 ‘##END’ · ‘##MEM’ 표지를 위조할 수 있다. comm 은 줄 **끝** 칸에만 온다 · awk 가 인쇄 가능한 ASCII 밖(개행 포함)을 ‘?’ 로 바꾼다 ·
 *     stat 파일의 comm 안 개행은 getline 으로 줄을 이어 붙여 한 줄로 만든다(그래도 접두가 앞에 있다). 파서는 접두 없는 줄을 버린다.
 *   · 출력 상한: 줄마다 `cut -c1-200` · 구획 `head -n 40` → 40 × 201 = 8,040 바이트 ≤ 8KB(설계 ‘40줄/8KB’ — 산수 시험이 고정).
 *   · 멈출 수 있는 명령은 전부 `timeout`(top 3 · 전 프로세스 /proc 읽기 · ps 2 · 후보만 읽기 1 — 8b 반증 S1: /proc/<pid>/io 는 대상의 exec 잠금을 기다릴 수 있다).
 *     그 합 + 여유 ≤ 이 exec 시한(TOP_EXEC_TIMEOUT_MS) — bmTop8bBudget 시험이 명령 문자열에서 timeout · sleep 을 뽑아 합을 고정한다.
 *     ⚠ 정직 기록: 커널의 끊을 수 없는 대기(D 상태)는 timeout 으로도 못 끊는다 — 그때는 이 exec 만 시한에 걸리고(TOP 만 결측) 본 표본은 남는다.
 *   · 비용: 1초 대기(top -d 1 또는 sleep 1) + /proc 읽기(평소 약 1.2초).
 *
 * ⚠ 정직 기록: Rocky 9(procps-ng 3.3.17)의 top 배치 출력 형식은 이 개발 컨테이너(procps-ng 4.0.4)에서만 확인했다 — 머리글로 열을 찾으므로
 *   열 순서가 달라도 읽지만, 머리글 이름이 다르면 대안(/proc)으로 넘어간다. 컨테이너 이름은 알 수 없다(호스트 PID · comm 만).
 */

/** 구획 순서(linuxCommand 가 이 순서로 붙이고 splitSections 가 이 순서로만 받는다 — osSsh LINUX_SECTIONS). */
export const TOP_SECTIONS = Object.freeze(['TOP']);
/** 줄 고정 접두. */
export const TOP_PREFIX = Object.freeze({ head: 'tS:', cpu: 'tC:', mem: 'tM:' });
/** 구획 줄 상한(명령의 head -n 과 같은 값) · 줄 폭(cut) — 40 × 201 ≤ 8KB. */
export const TOP_LINE_CAP = Object.freeze({ TOP: 40 });
export const TOP_LINE_BYTES = Object.freeze({ TOP: 201 });
export const TOP_LINE_WIDTH = 200;
/** CPU 상위 후보 수(I/O 를 읽는 대상) · 화면 · 저장 상위 수. */
export const TOP_CANDIDATES = 20;
export const TOP_KEEP = 5;
export const MEM_TOP = 5;
/** comm · 사용자 길이 상한(설계 ‘사용자 이름 16자’ — comm 은 커널 TASK_COMM_LEN 15 지만 커널 스레드 이름은 더 길 수 있다). */
export const COMM_MAX = 64;
export const USER_MAX = 16;
/** top 시한(초 — top -n 2 -d 1 은 실측 약 1.2초) · 1초 대기. */
export const TOP_TIMEOUT_S = 3;
export const TOP_WAIT_S = 1;
/** 8b 반증 S1: 전 프로세스 /proc 읽기(io · stat) · ps 시한(초) · 후보 20(+ 메모리 상위)만 읽는 시한(초). */
export const TOP_READ_TIMEOUT_S = 2;
export const TOP_PICK_TIMEOUT_S = 1;
/** 안 timeout · sleep 합(최악 15초 — top 3 · 대안 2+1+2 · io 2 · 후보 1×3 · ps 2)에 여유 5초(ssh 왕복 · 시한 없는 짧은 읽기 — 추정)를 더한 exec 시한(ms). 남은 예산과 작은 쪽. */
export const TOP_EXEC_TIMEOUT_MS = 20_000;

/*
 * top 둘째 프레임 → `C <pid> <%cpu> <state>`(상위 20) + `K <프로세스 수> <R 수> <D 수> <%CPU 합>`. 머리글을 못 찾으면 K 를 내지 않는다(→ 대안 경로).
 *   ⚠ COMMAND 열을 인쇄하지 않는다(인자 차단) — 열은 머리글 이름으로 찾는다.
 *   ⚠ 8b 반증 S3: 공백이 들어갈 수 있는 열(COMMAND · ENVIRON · CGROUPS · SUPGRPS · CGNAME · LXC)이 PID · S · %CPU 보다 **앞**에 있으면
 *     (시스템 /etc/topdefaultrc 가 열을 옮긴 procps-ng 4) 공백 든 comm 이 뒤 칸을 밀어 %CPU 자리에 이름 조각이 올 수 있다 → 그 머리글은 받지 않는다(→ 대안 /proc).
 */
const TOP_AWK = "awk 'BEGIN{f=0;h=0;n=0;r=0;d=0;t=0;k=0} /^top -/{f++;h=0;next} f<2{next} h==0{split(\"\",c); for(i=1;i<=NF;i++)c[$i]=i; if((\"PID\" in c)&&(\"%CPU\" in c)&&(\"S\" in c)){m=c[\"PID\"]; if(c[\"%CPU\"]>m)m=c[\"%CPU\"]; if(c[\"S\"]>m)m=c[\"S\"]; h=1; for(i=1;i<m;i++)if($i ~ /^(COMMAND|ENVIRON|CGROUPS|SUPGRPS|CGNAME|LXC)$/)h=0}; next} $(c[\"PID\"]) ~ /^[0-9]+$/ {s=$(c[\"S\"]); v=$(c[\"%CPU\"]); if(v !~ /^[0-9.]+$/)next; n++; if(s==\"R\")r++; if(s==\"D\")d++; t+=v; if(k<20){print \"C \" $(c[\"PID\"]) \" \" v \" \" s; k++}} END{if(h)printf \"K %d %d %d %.1f\\n\", n, r, d, t}'";

/*
 * 대안 — stat 두 번(U·A 앞 · V·B 뒤) → 같은 (pid, starttime) 의 tick 차이로 상위 20 · K 줄. 읽기는 `grep -H '' /proc/[0-9]*\/stat`(파일 이름이 줄마다 붙는다) —
 *   comm 안 개행으로 stat 한 파일이 여러 줄이 돼도 **파일 이름으로 다시 잇는다**(예전 판 cat 은 그 프로세스를 통째로 놓쳐 목록에서 숨을 수 있었다 — 이 컨테이너 재현).
 *   comm 안 괄호 · 공백은 마지막 ‘)’ 로 넘는다.
 */
const PROC_AWK = "awk -v clk=\"$_tk\" 'function ps(l,  i,j,a,n){i=index(l,\" (\"); if(i<2)return 0; P=substr(l,1,i-1); if(P !~ /^[0-9]+$/)return 0; for(j=length(l);j>i;j--)if(substr(l,j,1)==\")\")break; if(j<=i)return 0; n=split(substr(l,j+2),a,\" \"); if(n<20)return 0; S=a[1]; T=a[12]+a[13]; B=a[20]; return 1} function add(w,  l,i,f,c,p){l=substr($0,3); i=index(l,\":\"); if(i<1)return; f=substr(l,1,i-1); c=substr(l,i+1); p=f; sub(/^\\/proc\\//,\"\",p); sub(/\\/stat$/,\"\",p); if(p !~ /^[0-9]+$/)return; if(w==1){if(p in A0)A0[p]=A0[p] \" \" c; else A0[p]=c} else {if(p in B1)B1[p]=B1[p] \" \" c; else B1[p]=c}} $1==\"U\"{u0=$2;next} $1==\"V\"{u1=$2;next} $1==\"A\"{add(1);next} $1==\"B\"{add(2);next} END{if(clk<=0)clk=100; dt=u1-u0; if(dt<=0)dt=1; for(p in A0)if(ps(A0[p])&&P==p){t0[p]=T;b0[p]=B} for(p in B1){if(!ps(B1[p])||P!=p)continue; n++; if(S==\"R\")r++; if(S==\"D\")d++; if((p in t0)&&b0[p]==B){dd[p]=T-t0[p]; st[p]=S}} for(q=0;q<20;q++){b=\"\"; bv=-1; for(p in dd)if(!(p in u)&&dd[p]>bv){bv=dd[p];b=p} if(b==\"\")break; u[b]=1; printf \"C %s %.1f %s\\n\", b, bv/clk/dt*100, st[b]} t=0; for(p in dd)t+=dd[p]; if(n)printf \"K %d %d %d %.1f\\n\", n, r+0, d+0, t/clk/dt*100}'";

/*
 * 보강 — 입력 줄만 읽는다(⚠ awk getline 으로 /proc 을 읽지 않는다: mawk 는 /proc/<pid>/io 의 읽기 오류(EACCES — 열기는 되고 읽을 때 거부)를
 *   **프로그램 전체 중단**으로 다룬다 — 이 컨테이너 재현. 파일 읽기는 셸(grep · tr — 오류를 넘긴다)이 하고 awk 는 줄만 받는다).
 *   I = io 첫 읽기(전 프로세스) · J = io 둘째 읽기(후보만) · C · K = 후보 · 개수 · T = 둘째 읽기 뒤 uptime · S = 후보의 stat(개행은 공백으로) · U = 후보의 Uid 줄 · W = passwd 이름:uid.
 *   tC:<pid>|<user>|<state>|<%cpu>|<누적 tick>|<starttime tick>|<rss 페이지>|<읽기 B/s 또는 p · ->|<쓰기 B/s 또는 p · ->|<comm>
 */
const ENRICH_AWK = "awk -v u0=\"$_tu0\" -v src=\"$_tsrc\" -v clk=\"$_tk\" -v pg=\"$_tpg\" 'function io(t){x=$2; sub(/^\\/proc\\//,\"\",x); p=x; sub(/\\/.*/,\"\",p); if(p !~ /^[0-9]+$/)return; if(x ~ /:read_bytes:$/){if(t==1)r0[p]=$3; else r1[p]=$3} else if(x ~ /:write_bytes:$/){if(t==1)w0[p]=$3; else w1[p]=$3}} $1==\"I\"{io(1);next} $1==\"J\"{io(2);next} $1==\"C\"{if($2 ~ /^[0-9]+$/){nc++; cp[nc]=$2; cv[nc]=$3; cs[nc]=$4}; next} $1==\"K\"{K=$2 \" \" $3 \" \" $4 \" \" $5; next} $1==\"T\"{u1=$2; next} $1==\"S\"{l=$0; sub(/^S [0-9]+ /,\"\",l); if($2 ~ /^[0-9]+$/)sl[$2]=l; next} $1==\"U\"{if($2 ~ /^[0-9]+$/)ud[$2]=$4; next} $1==\"W\"{n2=split($2,pa,\":\"); if(n2>=2 && pa[2]!=\"\" && !(pa[2] in un))un[pa[2]]=pa[1]; next} END{dt=(u1!=\"\"&&u0!=\"\")?u1-u0:0; split(K,ka,\" \"); printf \"tS:src=%s dt=%s clk=%s pg=%s up=%s n=%s r=%s d=%s tot=%s c=%d\\n\", src, (dt>0?sprintf(\"%.2f\",dt):\"-\"), clk, pg, (u1!=\"\"?u1:\"-\"), (ka[1]!=\"\"?ka[1]:\"-\"), (ka[2]!=\"\"?ka[2]:\"-\"), (ka[3]!=\"\"?ka[3]:\"-\"), (ka[4]!=\"\"?ka[4]:\"-\"), nc; for(i=1;i<=nc;i++){p=cp[i]; if(!(p in sl))continue; s=sl[p]; a1=index(s,\"(\"); for(j=length(s);j>a1;j--)if(substr(s,j,1)==\")\")break; if(a1<1||j<=a1)continue; cm=substr(s,a1+1,j-a1-1); m=split(substr(s,j+2),fa,\" \"); if(m<22)continue; uid=(p in ud)?ud[p]:\"\"; us=(uid in un)?un[uid]:(uid!=\"\"?uid:\"-\"); gsub(/[^A-Za-z0-9._@+-]/,\"?\",us); io2=\"p|p\"; if((p in r1)&&(p in w1)){io2=\"-|-\"; if((p in r0)&&(p in w0)&&dt>0&&r1[p]>=r0[p]&&w1[p]>=w0[p])io2=sprintf(\"%.0f|%.0f\",(r1[p]-r0[p])/dt,(w1[p]-w0[p])/dt)} gsub(/[^ -~]/,\"?\",cm); printf \"tC:%s|%s|%s|%s|%s|%s|%s|%s|%s\\n\", p, substr(us,1,16), substr(fa[1],1,1), cv[i], fa[12]+fa[13], fa[20], fa[22], io2, substr(cm,1,64)}}'";

/* 후보 stat(grep -H — `/proc/<pid>/stat:<줄>`) → `S <pid> <한 줄>`(comm 안 개행으로 나뉜 줄은 파일 이름으로 공백을 넣어 잇는다 · 파일 이름에는 ‘:’ 가 없다). */
const JOIN_AWK = "awk '{i=index($0,\":\"); if(i<1)next; f=substr($0,1,i-1); c=substr($0,i+1); p=f; sub(/^\\/proc\\//,\"\",p); sub(/\\/stat$/,\"\",p); if(p !~ /^[0-9]+$/)next; if(p in s)s[p]=s[p] \" \" c; else {s[p]=c; o[++n]=p}} END{for(k=1;k<=n;k++)print \"S \" o[k] \" \" s[o[k]]}'";

/* 메모리 상위 5 — ps(그 프로세스의 comm 은 줄 끝 · 공백 포함 가능 → 앞 다섯 칸을 떼고 나머지). */
const MEM_AWK = "awk 'NR>1 && NR<=6 {c=$0; for(i=1;i<=5;i++)sub(/^ *[^ ]+ +/,\"\",c); gsub(/[^ -~]/,\"?\",c); u=$2; gsub(/[^A-Za-z0-9._@+-]/,\"?\",u); printf \"tM:%s|%s|%s|%s|%s|%s\\n\", $1, substr(u,1,17), $3, substr($4,1,8), $5, substr(c,1,64)}'";

/**
 * `##TOP` 구획 조각(상수). forceProc = 시험 이음매(top 이 있어도 대안 경로 — 운영 명령은 늘 false).
 * @param {{off?:boolean, forceProc?:boolean}} [o]
 */
export function topShell({ off = false, forceProc = false } = {}) {
  if (off) return `echo '${TOP_PREFIX.head}off=1'`;
  const hasTop = forceProc ? 'false' : 'command -v top >/dev/null 2>&1';
  return [
    '{ _tk=$(getconf CLK_TCK 2>/dev/null); _tpg=$(getconf PAGESIZE 2>/dev/null); _tsrc=proc; _tc=\'\';',
    "_tu0=$(cut -d' ' -f1 /proc/uptime 2>/dev/null);",
    `_tio=$(timeout ${TOP_READ_TIMEOUT_S} grep -H -E '^(read|write)_bytes:' /proc/[0-9]*/io 2>/dev/null | head -n 40000);`,
    `if ${hasTop}; then _tc=$(HOME=/nonexistent XDG_CONFIG_HOME=/nonexistent timeout ${TOP_TIMEOUT_S} top -b -n 2 -d ${TOP_WAIT_S} -w 512 -o %CPU 2>/dev/null | ${TOP_AWK}); case "$_tc" in *"K "[0-9]*) _tsrc=top;; esac; fi;`,
    `if [ "$_tsrc" = proc ]; then _tpa=$(cut -d' ' -f1 /proc/uptime 2>/dev/null); _ts0=$(timeout ${TOP_READ_TIMEOUT_S} grep -H '' /proc/[0-9]*/stat 2>/dev/null | head -n 40000);`,
    `_tc=$({ echo "U $_tpa"; printf '%s\\n' "$_ts0" | sed 's/^/A /'; sleep ${TOP_WAIT_S}; echo "V $(cut -d' ' -f1 /proc/uptime 2>/dev/null)"; timeout ${TOP_READ_TIMEOUT_S} grep -H '' /proc/[0-9]*/stat 2>/dev/null | head -n 40000 | sed 's/^/B /'; } | ${PROC_AWK}); fi;`,
    "_tp=$(printf '%s\\n' \"$_tc\" | awk '$1==\"C\" && $2 ~ /^[0-9]+$/ {print $2}' | head -n 20);",
    `{ printf '%s\\n' "$_tio" | sed 's/^/I /'; printf '%s\\n' "$_tc";`,
    `if [ -n "$_tp" ]; then timeout ${TOP_PICK_TIMEOUT_S} grep -H -E '^(read|write)_bytes:' $(for _p in $_tp; do printf '/proc/%s/io ' "$_p"; done) 2>/dev/null | sed 's/^/J /'; fi;`,
    'echo "T $(cut -d\' \' -f1 /proc/uptime 2>/dev/null)";',
    // 후보의 stat · status — 파일마다 프로세스를 띄우지 않고 grep 한 번씩(시한 하나) · stat 은 comm 안 개행으로 여러 줄이 될 수 있어 파일 이름으로 다시 잇는다(S 줄 하나).
    `if [ -n "$_tp" ]; then timeout ${TOP_PICK_TIMEOUT_S} grep -H '' $(for _p in $_tp; do printf '/proc/%s/stat ' "$_p"; done) 2>/dev/null | ${JOIN_AWK};`,
    `timeout ${TOP_PICK_TIMEOUT_S} grep -H -m 1 '^Uid:' $(for _p in $_tp; do printf '/proc/%s/status ' "$_p"; done) 2>/dev/null | sed -n 's|^/proc/\\([0-9]*\\)/status:|U \\1 |p'; fi;`,
    `cut -d: -f1,3 /etc/passwd 2>/dev/null | head -n 5000 | sed 's/^/W /'; } | ${ENRICH_AWK};`,
    `timeout ${TOP_READ_TIMEOUT_S} ps -eo pid,user:16,rss,stat,etimes,comm --sort=-rss 2>/dev/null | ${MEM_AWK};`,
    `} 2>/dev/null | cut -c1-${TOP_LINE_WIDTH} | head -n ${TOP_LINE_CAP.TOP}`,
  ].join(' ');
}
/**
 * 별도 exec 명령(collectOsUsage 가 같은 세션에서 돌린다 — 8b 반증 F1). LC_ALL=C(머리글 · 수 형식) · 출력은 topShell 끝의 줄 폭 · 줄 수 상한(40 × 201 ≤ 8KB).
 * @param {{forceProc?:boolean}} [o] forceProc = 시험 이음매(운영은 늘 false)
 */
export function topCommand({ forceProc = false } = {}) {
  return `export LC_ALL=C; ${topShell({ forceProc })}`;
}
export const TOP_COMMAND = topCommand();

/**
 * 별도 exec 출력 → readSection 꼴 `{ value, absent:false, missing }`(순수). 빈 출력 · 값 0 개는 missing(이 exec 는 늘 머리 줄을 낸다 — 0줄을 ‘없음’ 으로 보지 않는다).
 */
export function readTopOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).slice(0, TOP_LINE_CAP.TOP + 8).filter((l) => l.trim() !== '');
  let value = null;
  try { value = lines.length ? parseTop(lines) : null; } catch { value = null; }
  return value == null ? { value: null, absent: false, missing: true } : { value, absent: false, missing: false };
}

/* ════════════════════════ 파서(순수) ════════════════════════ */
const NUM_RE = /^-?\d{1,15}(?:\.\d{1,4})?$/;
const num = (v) => { const s = String(v ?? '').trim(); return NUM_RE.test(s) ? Number(s) : null; };
const int = (v) => { const s = String(v ?? '').trim(); return /^\d{1,15}$/.test(s) ? Number(s) : null; };
const PID_RE = /^\d{1,9}$/;
/** comm · 사용자 정제(순수 — 길이를 먼저 자르고 제어 · 양방향 · 폭 없는 문자 제거 · 선형). 엣지 봉투 · 대행 응답에도 같은 함수를 쓴다. */
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
export function cleanComm(v) {
  if (typeof v !== 'string') return '';
  return v.slice(0, COMM_MAX * 2).replace(CTRL_RE, '?').trim().slice(0, COMM_MAX);
}
export function cleanUser(v) {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, USER_MAX + 4).replace(/[^A-Za-z0-9._@+?-]/g, '?').slice(0, USER_MAX + 1);
  return s && s !== '-' ? s : null;
}
const STATE_RE = /^[A-Za-z]$/;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function parseHead(rest) {
  const o = {};
  for (const part of rest.split(' ').slice(0, 16)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    o[part.slice(0, i)] = part.slice(i + 1);
  }
  return o;
}

/**
 * ##TOP 줄 → 값(순수). 접두 없는 줄 · 형식이 다른 줄은 버리고 센다(unparsed). 값이 하나도 없으면 null(readSection → missing).
 * @returns {null | { off:true } | {src, dtS, clk, pageKb, uptimeS, nproc, nrun, nd, cpuTotal, candidates:number, cpu:Array, mem:Array, io:Array, ioPerm:number, ioUnknown:number, unparsed:number, capped:boolean}}
 */
export function parseTop(lines = []) {
  let head = null; const cpu = []; const mem = []; let unparsed = 0; let rows = 0;
  for (const raw0 of lines) {
    const raw = String(raw0 ?? '').slice(0, TOP_LINE_WIDTH + 1);
    if (!raw.trim()) continue;
    rows += 1;
    if (raw.startsWith(TOP_PREFIX.head)) { if (!head) head = parseHead(raw.slice(TOP_PREFIX.head.length)); else unparsed += 1; continue; }
    if (raw.startsWith(TOP_PREFIX.cpu)) {
      const f = raw.slice(TOP_PREFIX.cpu.length).split('|');
      if (f.length < 10 || !PID_RE.test(f[0])) { unparsed += 1; continue; }
      const comm = cleanComm(f.slice(9).join('|'));
      const cpuPct = num(f[3]);
      if (cpuPct == null || cpuPct < 0 || cpuPct > 100_000) { unparsed += 1; continue; }
      const io = (v) => (v === 'p' ? { perm: true, v: null } : v === '-' ? { perm: false, v: null } : { perm: false, v: int(v) });
      const rd = io(f[7]); const wr = io(f[8]);
      cpu.push({ pid: Number(f[0]), user: cleanUser(f[1]), state: STATE_RE.test(f[2]) ? f[2] : null, cpu: r1(cpuPct), ticks: int(f[4]), startTicks: int(f[5]), rssPages: int(f[6]),
        rd: rd.v, wr: wr.v, ioPerm: rd.perm || wr.perm, comm: comm || null });
      continue;
    }
    if (raw.startsWith(TOP_PREFIX.mem)) {
      const f = raw.slice(TOP_PREFIX.mem.length).split('|');
      if (f.length < 6 || !PID_RE.test(f[0])) { unparsed += 1; continue; }
      const rss = int(f[2]);
      if (rss == null) { unparsed += 1; continue; }
      if (mem.length < MEM_TOP) mem.push({ pid: Number(f[0]), user: cleanUser(f[1]), rssKb: rss, state: STATE_RE.test(String(f[3]).charAt(0)) ? String(f[3]).charAt(0) : null, etimes: int(f[4]), comm: cleanComm(f.slice(5).join('|')) || null });
      continue;
    }
    unparsed += 1;
  }
  if (head && head.off === '1') return { off: true };
  if (!head && !cpu.length && !mem.length) return null;
  const clk = int(head?.clk) || null;
  const pageKb = int(head?.pg) ? int(head.pg) / 1024 : null;
  const uptimeS = num(head?.up);
  const toS = (ticks) => (ticks == null || !clk ? null : Math.round((ticks / clk) * 10) / 10);
  const cpuOut = cpu.slice(0, TOP_CANDIDATES).sort((a, b) => b.cpu - a.cpu).map((x) => ({
    pid: x.pid, user: x.user, state: x.state, comm: x.comm, cpu: x.cpu,
    cpuS: toS(x.ticks), start: x.startTicks == null || !clk ? null : Math.floor(x.startTicks / clk),
    rssKb: x.rssPages == null || pageKb == null ? null : Math.round(x.rssPages * pageKb),
    rd: x.rd, wr: x.wr, ioPerm: x.ioPerm,
  }));
  // 메모리 상위의 시작 시각(부팅 뒤 초) — uptime − etimes(±1초 · PID 재사용 구분용).
  const memOut = mem.map((x) => ({ ...x, start: uptimeS != null && x.etimes != null ? Math.max(0, Math.floor(uptimeS - x.etimes)) : null }));
  const ioOut = cpuOut.filter((x) => x.rd != null && x.wr != null).sort((a, b) => (b.rd + b.wr) - (a.rd + a.wr)).slice(0, TOP_KEEP);
  return {
    src: head?.src === 'top' || head?.src === 'proc' ? head.src : null,
    dtS: num(head?.dt), clk, pageKb, uptimeS,
    nproc: int(head?.n), nrun: int(head?.r), nd: int(head?.d), cpuTotal: num(head?.tot) == null ? null : r1(num(head.tot)),
    candidates: cpuOut.length,
    cpu: cpuOut, mem: memOut, io: ioOut,
    ioPerm: cpuOut.filter((x) => x.ioPerm).length,
    ioUnknown: cpuOut.filter((x) => !x.ioPerm && (x.rd == null || x.wr == null)).length,
    unparsed, capped: rows >= TOP_LINE_CAP.TOP,
  };
}

/**
 * 프로세스 → 프로파일 단서(순수 — ⑥ 카탈로그 이름 규칙 · 4단계 감지와 같은 단서: gpdb = 계정 gpadmin + postgres · airflow = 이름 airflow · celery).
 *   이름만으로 판단하지 않는다는 원칙(설계)은 그대로 — 이 열은 ‘단서’ 이고 판정이 아니다. code 만 낸다(웹이 문장으로).
 */
export function procHint({ comm = '', user = '' } = {}) {
  const c = String(comm || '').toLowerCase(); const u = String(user || '').toLowerCase();
  if (c === 'postgres' && u === 'gpadmin') return 'gpdb';
  if (c === 'airflow' || c.startsWith('airflow ') || c === 'celery') return 'airflow';
  if (/^kswapd\d*$/.test(c)) return 'kswapd';
  if (c === 'sshd') return 'sshd';
  if (/^(kworker|ksoftirqd|migration|rcu_|kthreadd|watchdog)/.test(c)) return 'kernel';
  return null;
}
