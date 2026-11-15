/**
 * focusmon/audit/bundle.js — 서버 집중 모니터링 ‘디스크 점검’(배드 섹터 점검 프로그램) 의 **고정된 것들**(v3.11.0).
 *
 * 사용자 요청(2026-11-14): "집중 모니터링 기능에 배드섹터 점검 프로그램 추가해줘" + 점검 프로그램 원문(RHEL 저장장치 이력 점검 · Python 3.6+ 표준 라이브러리).
 * 착수 전 선택: root 는 **고정 설치 + sudoers 한 줄** · 실행은 **맡은 노드(중앙 · 엣지)** · 시안 ⑰(docs/design/focus-mon/README.md §20) · '기본값대로 모두 구현해줘'.
 *
 *  · 받은 프로그램은 **한 글자도 고치지 않는다**(`rhel_disk_audit.py` — sha256 이 판본이다). 감싸는 실행 파일(`WRAPPER_TEXT`)이 임시 폴더 · 낮은 우선순위 ·
 *    시한 20분 · 끝나면 보고서 파일 지우기 · 디스크 목록(모델 — 프로그램 보고서에 없다) 덧붙이기를 맡는다.
 *  · 대상 서버에는 관리자가 root 로 **한 번** 설치한다(`installScript` — 포탈에서 내려받는 설치 파일). 포탈은 대상 서버에 파일을 쓰지 않고,
 *    root 로 돌 코드를 보내지 않는다. 원격 명령은 상수 둘뿐이다 — 준비 확인(`READY_COMMAND` — 일반 계정) · 실행(`RUN_COMMAND` — sudo 인자 없이).
 *  · sudoers 는 그 실행 파일 **하나 · 인자 없이**(`""`)만 허용한다. 실행 전마다 일반 계정으로 두 파일의 sha256 · 소유자 · 쓰기 권한을 읽어
 *    포탈 판본과 다르거나 root 소유가 아니면 실행하지 않는다(server/src/focusmon/CLAUDE.md '디스크 점검' — 불변조건의 사용자 승인 예외 1건).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROGRAM_PATH = '/usr/local/libexec/dvc/rhel_disk_audit.py';
export const WRAPPER_PATH = '/usr/local/sbin/dvc-disk-audit';
export const SUDOERS_PATH = '/etc/sudoers.d/dvc-disk-audit';
/** 감싸는 실행 파일의 시한(초) — 이 값은 실행 파일 안의 상수다(인자로 받지 않는다). 노드의 세션 시한은 이보다 길다(`AUDIT_DEADLINE_MS`). */
export const WRAPPER_TIMEOUT_S = 1200;
export const PROGRAM_TIMEOUT_S = 120;
export const RAID_TIMEOUT_S = 120;
/** 노드가 SSH 세션을 끊는 시한 — 실행 파일 시한(20분) + 준비 확인 · 디스크 목록 · 여유. 산수는 테스트가 고정한다. */
export const READY_EXEC_MS = 30_000;
export const AUDIT_DEADLINE_MS = (WRAPPER_TIMEOUT_S + RAID_TIMEOUT_S + 60) * 1000 + READY_EXEC_MS;

const PROGRAM_FILE = fileURLToPath(new URL('./rhel_disk_audit.py', import.meta.url));
let _program = null;
/** 받은 프로그램 원문(바이트 그대로 — 판본 sha 가 이 바이트의 sha256 이다). 읽지 못하면 null. */
export function programBytes() {
  if (_program) return _program;
  try { _program = fs.readFileSync(PROGRAM_FILE); } catch { _program = null; }
  return _program;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export function programSha() { const b = programBytes(); return b ? sha256(b) : null; }

/**
 * 감싸는 실행 파일(POSIX sh · root 로 돈다 · 인자 없이만). 출력은 표준 출력 한 줄씩:
 *   ##DA BEGIN 2 <표지> → (프로그램 보고서 줄들) → ##DA <표지> EXIT <rc> → ##DA <표지> DISKS → (lsblk -P 줄) → [##DA <표지> RAID → (perccli/storcli 줄)] → ##DA <표지> END
 *   오류(첫 줄 · 프로그램이 돌기 전): ##DA ERR args|nopython|busy|tmp|nonce
 *  · **표지 = 실행마다 만드는 난수 16자**(v3.11.0 반증 F2) — 보고서에는 대상 서버의 로그 내용이 들어가고, 일반 계정도 줄바꿈이 든 로그를 남길 수 있다.
 *    해석은 첫 줄의 표지가 붙은 `##DA` 줄만 표지로 받는다(로그는 실행 전에 쓰였으므로 그 난수를 알 수 없다). 표지는 변수로만 두고 내보내지 않는다.
 *  · 겹쳐 돌지 않게 /run 의 잠금(flock) — 채널이 끊긴 뒤에도 root 프로그램은 시한까지 돈다(같은 서버를 곧바로 다시 누르면 'busy').
 *  · SIGPIPE 도 끝내기 처리(trap) — dash 계열 sh 에서 채널이 먼저 닫히면 EXIT trap 없이 죽어 임시 폴더가 남았다(반증 F9-d).
 *  · python 은 -I -S(사용자 · site 경로를 보지 않는다 — 프로그램은 표준 라이브러리만 쓴다).
 *  · 프로그램 시한은 timeout -s KILL(채널이 끊겨도 root 프로세스가 끝없이 남지 않게 — 프로그램은 끊긴 파이프를 만나도 계속 돈다).
 *  · 우선순위 nice 19 · ionice best-effort 7(유휴 등급은 바쁜 서버에서 끝나지 않을 수 있어 쓰지 않는다).
 *  · 보고서 파일은 임시 폴더에 쓰이고 끝나면 폴더째 지운다(대상 서버에 남기지 않는다).
 *  · 디스크 목록 — lsblk 의 SERIAL 칸이 없는 판(옛 util-linux)이면 SERIAL 없이 한 번 더.
 */
export const WRAPPER_TEXT = `#!/bin/sh
# dvc-disk-audit — 서버 집중 모니터링 '디스크 점검' 실행 파일(포탈 설치 묶음). root 소유 · sudoers 에서 인자 없이만 허용한다.
# 고정 경로의 점검 프로그램(받은 그대로)을 낮은 우선순위 · 시한 ${WRAPPER_TIMEOUT_S}초로 돌리고, 임시 폴더의 보고서 파일은 지운다.
# 끝에 디스크 목록(모델 · 시리얼 · WWN)을 덧붙인다. 출력은 표준 출력뿐이다.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
PROG=${PROGRAM_PATH}
if [ "$#" -ne 0 ]; then echo '##DA ERR args'; exit 64; fi
PY=$(command -v python3 2>/dev/null)
if [ -z "$PY" ]; then echo '##DA ERR nopython'; exit 69; fi
if command -v flock >/dev/null 2>&1 && [ -d /run ] && [ -w /run ]; then
  exec 9>/run/dvc-disk-audit.lock
  flock -n 9 || { echo '##DA ERR busy'; exit 75; }
fi
N=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -dc '0-9a-f')
case "$N" in ''|*[!0-9a-f]*) echo '##DA ERR nonce'; exit 70 ;; esac
if [ "\${#N}" -ne 16 ]; then echo '##DA ERR nonce'; exit 70; fi
D=$(mktemp -d /tmp/dvc-disk-audit.XXXXXXXX) || { echo '##DA ERR tmp'; exit 70; }
trap 'rm -rf "$D"' EXIT
trap 'exit 143' HUP INT TERM
trap 'exit 141' PIPE
IO=''
if command -v ionice >/dev/null 2>&1; then IO='ionice -c2 -n7'; fi
echo "##DA BEGIN 2 $N"
cd "$D" || exit 70
timeout -s KILL ${WRAPPER_TIMEOUT_S} nice -n 19 $IO "$PY" -I -S "$PROG" --output-dir "$D" --timeout ${PROGRAM_TIMEOUT_S} 2>&1
echo "##DA $N EXIT $?"
echo "##DA $N DISKS"
lsblk -d -n -P -o NAME,TYPE,MODEL,SERIAL,WWN,SIZE,ROTA,TRAN 2>/dev/null | head -n 512 || true
if ! lsblk -d -n -o SERIAL >/dev/null 2>&1; then lsblk -d -n -P -o NAME,TYPE,MODEL,WWN,SIZE,ROTA,TRAN 2>/dev/null | head -n 512; fi
for T in perccli64 perccli storcli64 storcli /opt/MegaRAID/perccli/perccli64 /opt/MegaRAID/perccli/perccli /opt/MegaRAID/storcli/storcli64 /opt/MegaRAID/storcli/storcli /opt/lsi/perccli/perccli64 /opt/lsi/storcli/storcli64; do
  P=$(command -v "$T" 2>/dev/null) || continue
  [ -n "$P" ] || continue
  echo "##DA $N RAID"
  timeout -s KILL ${RAID_TIMEOUT_S} "$P" /call/eall/sall show all 2>/dev/null | grep -E '^Drive /c[0-9]|^ *[0-9]+:[0-9]+ +[0-9]+ |^(SN|WWN|Model Number) *=' | head -n 8000
  break
done
echo "##DA $N END"
`;
export function wrapperSha() { return sha256(Buffer.from(WRAPPER_TEXT, 'utf8')); }

/**
 * 준비 확인(일반 계정 · root 아님 · 상수). python3 · 두 파일의 sha256 · 소유자 · 권한 · 경로 폴더 · sudo 규칙 · 서버 모델(/sys/class/dmi/id — 0444).
 *  · sudo -n -l <명령> 은 비밀번호 없이 그 명령이 허용되는지만 본다(실행하지 않는다).
 */
export const READY_COMMAND = [
  // 실행 파일과 같은 PATH(반증 F6) — 수집 계정의 PATH 에만 있는 python3(/usr/local/bin · SCL)는 실행 파일이 찾지 못한다
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'LC_ALL=C; export LC_ALL',
  "echo '##DR 1'",
  'P=$(command -v python3 2>/dev/null)',
  "if [ -n \"$P\" ]; then echo \"##DR py $(\"$P\" -c 'import sys; print(\"%d.%d.%d\" % sys.version_info[:3])' 2>/dev/null)\"; else echo '##DR py -'; fi",
  `for f in ${PROGRAM_PATH} ${WRAPPER_PATH}; do if [ -r "$f" ]; then echo "##DR file $f $(sha256sum "$f" 2>/dev/null | cut -c1-64) $(stat -c '%u:%g:%a' "$f" 2>/dev/null)"; elif [ -e "$f" ]; then echo "##DR file $f unreadable -"; else echo "##DR file $f - -"; fi; done`,
  "for d in /usr/local/libexec/dvc /usr/local/libexec /usr/local/sbin /usr/local; do echo \"##DR dir $d $(stat -c '%u:%g:%a' \"$d\" 2>/dev/null || echo -)\"; done",
  `if sudo -n -l ${WRAPPER_PATH} >/dev/null 2>&1; then echo '##DR sudo ok'; else echo '##DR sudo no'; fi`,
  "V=$(head -c 64 /sys/class/dmi/id/sys_vendor 2>/dev/null | tr -d '\\n'); M=$(head -c 64 /sys/class/dmi/id/product_name 2>/dev/null | tr -d '\\n')",
  'echo "##DR dmi $V|$M"',
  "echo '##DR end'",
].join('\n');

/** 실행(상수) — sudoers 의 한 줄과 정확히 같다(인자 없음). */
export const RUN_COMMAND = `sudo -n ${WRAPPER_PATH}`;

const EOF_PROGRAM = 'DVC_DISK_AUDIT_PROGRAM_EOF';
const EOF_WRAPPER = 'DVC_DISK_AUDIT_WRAPPER_EOF';

/**
 * 설치 파일(관리자가 대상 서버에서 root 로: `sh dvc-disk-audit-install.sh <수집 계정>`).
 *  · 두 파일을 따옴표 heredoc 으로 싣는다(셸이 내용을 펼치지 않는다) — 끝 표지가 내용에 있으면 만들지 않는다(throw).
 *  · 싣은 파일의 sha256 을 설치 전에 다시 확인한다(내려받기 손상).
 *  · 경로 폴더가 root 소유이고 그룹 · 남이 쓸 수 없는지 확인한다(아니면 설치하지 않는다 — root 로 도는 파일을 남이 바꿀 수 있게 된다).
 *  · sudoers 는 임시 파일에 써서 visudo -cf 로 검사한 뒤에만 넣는다.
 */
export function installScript() {
  const prog = programBytes();
  if (!prog) throw new Error('점검 프로그램 파일을 읽지 못했습니다');
  const progText = prog.toString('utf8');
  if (progText.includes(EOF_PROGRAM) || WRAPPER_TEXT.includes(EOF_WRAPPER)) throw new Error('설치 파일 끝 표지가 내용과 겹칩니다');
  const pSha = programSha(); const wSha = wrapperSha();
  return `#!/bin/sh
# 서버 집중 모니터링 — 디스크 점검(배드 섹터 점검 프로그램) 설치 파일
# 판본: 프로그램 ${pSha.slice(0, 12)} · 실행 파일 ${wSha.slice(0, 12)}
# 사용법(대상 서버에서 root 로): sh dvc-disk-audit-install.sh <수집 계정>
#   설치하는 것: ${PROGRAM_PATH}(0644) · ${WRAPPER_PATH}(0755) · ${SUDOERS_PATH}(0440 — <수집 계정> 이 그 실행 파일을 인자 없이만 root 로)
#   지우려면: rm -f ${SUDOERS_PATH} ${WRAPPER_PATH} ${PROGRAM_PATH}
set -eu
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
ACCT="\${1:-}"
case "$ACCT" in
  ''|-*|*[!A-Za-z0-9._-]*) echo "사용법: sh $0 <수집 계정>   (계정 이름은 영문 · 숫자 · . _ - 만)"; exit 64 ;;
esac
if [ "$(id -u)" -ne 0 ]; then echo 'root 로 실행하세요.'; exit 77; fi
if ! id "$ACCT" >/dev/null 2>&1; then echo "계정 $ACCT 가 이 서버에 없습니다."; exit 67; fi
if ! command -v python3 >/dev/null 2>&1; then echo '주의: python3 가 없습니다 — 점검 프로그램은 Python 3.6 이상이 필요합니다(설치는 계속합니다).'; fi
for d in /usr/local /usr/local/sbin /usr/local/libexec; do
  [ -d "$d" ] || continue
  o=$(stat -c '%u' "$d"); m=$(stat -c '%a' "$d")
  if [ "$o" != 0 ]; then echo "$d 가 root 소유가 아닙니다 — 설치하지 않습니다."; exit 73; fi
  case "$m" in *[2367]?|*[2367]) echo "$d 를 그룹 · 다른 계정이 쓸 수 있습니다(권한 $m) — 설치하지 않습니다."; exit 73 ;; esac
done
if [ ! -d /etc/sudoers.d ] || ! grep -Eq '^[#@]includedir[[:space:]]+/etc/sudoers.d' /etc/sudoers; then echo '/etc/sudoers 에 includedir /etc/sudoers.d 가 없습니다 — 설치하지 않습니다.'; exit 78; fi
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cat > "$T/rhel_disk_audit.py" <<'${EOF_PROGRAM}'
${progText}${progText.endsWith('\n') ? '' : '\n'}${EOF_PROGRAM}
cat > "$T/dvc-disk-audit" <<'${EOF_WRAPPER}'
${WRAPPER_TEXT}${WRAPPER_TEXT.endsWith('\n') ? '' : '\n'}${EOF_WRAPPER}
echo "${pSha}  $T/rhel_disk_audit.py" | sha256sum -c --quiet - || { echo '점검 프로그램이 손상됐습니다 — 설치 파일을 다시 내려받으세요.'; exit 65; }
echo "${wSha}  $T/dvc-disk-audit" | sha256sum -c --quiet - || { echo '실행 파일이 손상됐습니다 — 설치 파일을 다시 내려받으세요.'; exit 65; }
printf '%s\\n' '# 서버 집중 모니터링 디스크 점검(포탈 설치 묶음) — 이 실행 파일 하나를 인자 없이만 허용한다' \\
  'Defaults!${WRAPPER_PATH} !requiretty' \\
  "$ACCT ALL=(root) NOPASSWD: ${WRAPPER_PATH} \\"\\"" > "$T/sudoers"
visudo -cf "$T/sudoers" >/dev/null || { echo 'sudoers 검사(visudo)를 통과하지 못했습니다 — 아무것도 바꾸지 않았습니다.'; exit 65; }
install -d -o root -g root -m 0755 /usr/local/libexec/dvc
install -o root -g root -m 0644 "$T/rhel_disk_audit.py" ${PROGRAM_PATH}
install -o root -g root -m 0755 "$T/dvc-disk-audit" ${WRAPPER_PATH}
install -o root -g root -m 0440 "$T/sudoers" ${SUDOERS_PATH}
echo "설치했습니다 — 수집 계정 $ACCT · 포탈 › 서버 집중 모니터링 › 디스크 점검에서 '준비 상태 다시 확인' 을 누르세요."
`;
}
