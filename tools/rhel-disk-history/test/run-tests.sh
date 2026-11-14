#!/bin/bash
# rhel-disk-history.sh 시나리오 시험 — 가짜 로그 폴더(RDH_ROOT)와 PATH 에 둔 가짜 명령으로 실제로 돌려 본다.
#
#   bash test/run-tests.sh            전체
#   bash test/run-tests.sh -k         시험 폴더를 지우지 않고 남긴다(결과 파일을 직접 볼 때)
#   bash test/run-tests.sh 이름…      그 시나리오만
#
# 한계: 여기의 로그 · smartctl · storcli 출력은 '문서와 소스를 기억해 쓴 모양' 이다. 실서버 출력으로 만든 것이 아니다.
#       이 시험은 '스크립트가 자기가 아는 모양을 옳게 판정하는가' 만 본다 — 실물과 같은지는 실서버에서 확인해야 한다.

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../rhel-disk-history.sh"
KEEP=0; ONLY=()
while [ $# -gt 0 ]; do case "$1" in -k) KEEP=1; shift ;; *) ONLY[${#ONLY[@]}]="$1"; shift ;; esac; done

TOP=$(mktemp -d "${TMPDIR:-/tmp}/rdh-test.XXXXXX") || exit 1
[ "$KEEP" = 1 ] || trap 'rm -rf "$TOP"' EXIT
NOW=$(date +%s)
PASS=0; FAIL=0; FAILED=""

BASE_TOOLS="bash sh gawk grep sed sort cut tr head tail mktemp rm mkdir chmod cat id date stat timeout gzip xz bzip2 readlink ls cp uniq wc sleep env basename dirname touch"

trad() { date -d "@$1" '+%b %e %H:%M:%S'; }                 # 전통 syslog 시각(연도 없음)
iso()  { date -d "@$1" '+%Y-%m-%dT%H:%M:%S%z'; }            # journalctl -o short-iso
ctime() { date -d "@$1" '+%a %b %e %H:%M:%S %Y'; }          # tune2fs · mdadm · storcli 의 날짜
ymd()  { date -d "@$1" '+%Y-%m-%d'; }
ago()  { echo $((NOW - $1 * 86400 - ${2:-0})); }             # ago 일 [초]

# new_case 이름 "쓸 가짜 명령…"  — 시나리오 폴더(root · fix · bin · out)를 만든다
new_case() {
  CASE="$1"; D="$TOP/$1"; ROOT="$D/root"; FIX="$D/fix"; BIN="$D/bin"; OUT="$D/out"
  mkdir -p "$ROOT/var/log" "$ROOT/proc" "$ROOT/etc" "$ROOT/run/log/journal" "$FIX" "$BIN" "$OUT"
  echo "Red Hat Enterprise Linux Server release 7.9 (Maipo)" > "$ROOT/etc/redhat-release"
  echo "$((30 * 86400)).12 1234567.89" > "$ROOT/proc/uptime"     # 30일째 가동
  local t p
  for t in $BASE_TOOLS; do p=$(command -v "$t") && ln -s "$p" "$BIN/$t"; done
  ln -s "$(command -v gawk)" "$BIN/awk"
  ln -s "$HERE/fakebin/_common" "$BIN/_common"
  for t in hostname uname $2; do ln -s "$HERE/fakebin/$t" "$BIN/$t"; done
}
run_case() { # run_case [스크립트 옵션…] → RC · RES(결과 파일) · SCREEN
  ( cd "$D" && env -i PATH="$BIN" HOME="$D/home" LANG=en_US.UTF-8 RDH_ROOT="$ROOT" RDH_FIX="$FIX" TMPDIR="$D" \
      bash "$SCRIPT" -o "$OUT" "$@" > "$D/screen.txt" 2> "$D/stderr.txt" )
  RC=$?
  RES=$(ls "$OUT"/rhel-disk-history_*.txt 2>/dev/null | head -n 1)
  SCREEN="$D/screen.txt"
}
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); FAILED="$FAILED\n  [$CASE] $1"; echo "  FAIL [$CASE] $1"; }
expect()     { if grep -q -e "$1" "${2:-$RES}" 2>/dev/null; then ok; else bad "있어야 함: $1"; fi; }
expect_not() { if grep -q -e "$1" "${2:-$RES}" 2>/dev/null; then bad "없어야 함: $1"; else ok; fi; }
expect_rc()  { if [ "$RC" = "$1" ]; then ok; else bad "종료 코드 $RC (기대 $1)"; fi; }
# 공통 검사: 결과 파일 권한 600 · 가짜 명령 호출에 변경 동사 없음 · storcli 로그가 시험 폴더에 떨어지지 않음 · stderr 에 awk 오류 없음
common_checks() {
  if [ -n "$RES" ] && [ "$(stat -c %a "$RES")" = 600 ]; then ok; else bad "결과 파일 없음 또는 권한이 600 이 아님"; fi
  if [ -f "$FIX/calls.log" ] && grep -E -q '^smartctl .*( -t | -s | -S | -o | -X |--test|--set|--smart)|^storcli64 .* (set|start|stop|delete|del|add|flash|erase|init) |^dmesg .*(-c|-C|--clear)|^tune2fs .*-[^l ]|^mdadm .*--(create|assemble|stop|add|remove|fail|zero)' "$FIX/calls.log"; then bad "상태를 바꾸는 명령 호출이 있음"; else ok; fi
  if [ -e "$D/storcli.log" ]; then bad "storcli 로그가 실행 폴더에 남음"; else ok; fi
  if grep -q -i -E 'awk:|syntax error|unbound|command not found' "$D/stderr.txt"; then bad "stderr 에 오류: $(grep -i -E 'awk:|syntax error|unbound|command not found' "$D/stderr.txt" | head -n 2)"; else ok; fi
  if ls /dev/shm/rdh.* "$D"/rdh.* >/dev/null 2>&1; then bad "작업 폴더가 남음"; else ok; fi
}
want() { # 이 시나리오를 돌릴까
  [ "${#ONLY[@]}" = 0 ] && return 0
  local x; for x in "${ONLY[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1
}

# ── 공용 고정 출력 ─────────────────────────────────────────────────────────────
smart_ata() { # smart_ata 파일 시리얼 WWN(공백 구분) 재할당 보류 복구불가 가동시간 [오류로그 가동시간]
  {
    cat <<EOF
smartctl 7.0 2018-12-30 r4883 [x86_64-linux-3.10.0-1160.el7.x86_64] (local build)
Copyright (C) 2002-18, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF INFORMATION SECTION ===
Model Family:     Seagate Constellation ES.3
Device Model:     ST1000NM0033-9ZM173
Serial Number:    $2
LU WWN Device Id: $3
Firmware Version: SN04
User Capacity:    1,000,204,886,016 bytes [1.00 TB]
Rotation Rate:    7200 rpm
SMART support is: Enabled

=== START OF READ SMART DATA SECTION ===
SMART overall-health self-assessment test result: PASSED

SMART Attributes Data Structure revision number: 10
Vendor Specific SMART Attributes with Thresholds:
ID# ATTRIBUTE_NAME          FLAGS    VALUE WORST THRESH FAIL RAW_VALUE
  1 Raw_Read_Error_Rate     POSR--   080   063   044    -    111224312
  5 Reallocated_Sector_Ct   PO--CK   100   100   010    -    $4
  9 Power_On_Hours          -O--CK   071   071   000    -    $7
187 Reported_Uncorrect      -O--CK   100   100   000    -    0
197 Current_Pending_Sector  -O--C-   100   100   000    -    $5
198 Offline_Uncorrectable   ----C-   100   100   000    -    $6
199 UDMA_CRC_Error_Count    -OSRCK   200   200   000    -    0
                            ||||||_ K auto-keep
                            |||||__ C event count

EOF
    if [ -n "$8" ]; then
      cat <<EOF
SMART Extended Comprehensive Error Log Version: 1 (5 sectors)
Device Error Count: 1
	CR     = Command Register

Error 1 [0] occurred at disk power-on lifetime: $8 hours (99 days + 0 hours)
  When the command that caused the error occurred, the device was active or idle.

  After command completion occurred, registers were:
  ER -- ST COUNT  LBA_48  LH LM LL DV DC
  -- -- -- == -- == == == -- -- -- -- --
  40 -- 51 00 08 00 00 12 34 56 78 40 00  Error: UNC at LBA = 0x12345678 = 305419896

EOF
    else
      printf 'SMART Extended Comprehensive Error Log Version: 1 (5 sectors)\nNo Errors Logged\n\n'
    fi
  } > "$FIX/$1"
}
boot_lines() { # boot_lines epoch — 전통 형식의 부팅 머리 줄(호스트 어댑터 · 디스크 연결)
  local t; t=$(trad "$1")
  cat <<EOF
$t rdh kernel: Linux version 3.10.0-1160.el7.x86_64 (mockbuild@x86-vm-26) (gcc version 4.8.5)
$t rdh kernel: scsi host0: ahci
$t rdh kernel: scsi host1: ahci
$t rdh kernel: scsi 0:0:0:0: Direct-Access     ATA      ST1000NM0033-9ZM SN04 PQ: 0 ANSI: 5
$t rdh kernel: sd 0:0:0:0: [sda] Attached SCSI disk
$t rdh kernel: scsi 1:0:0:0: Direct-Access     ATA      ST1000NM0033-9ZM SN04 PQ: 0 ANSI: 5
$t rdh kernel: sd 1:0:0:0: [sdb] Attached SCSI disk
EOF
}
media_lines() { # media_lines epoch 장치 hctl — RHEL 7 의 미디어 오류 한 벌
  local t; t=$(trad "$1")
  cat <<EOF
$t rdh kernel: sd $3: [$2] tag#3 FAILED Result: hostbyte=DID_OK driverbyte=DRIVER_SENSE
$t rdh kernel: sd $3: [$2] tag#3 Sense Key : Medium Error [current]
$t rdh kernel: sd $3: [$2] tag#3 Add. Sense: Unrecovered read error - auto reallocate failed
$t rdh kernel: sd $3: [$2] tag#3 CDB: Read(10) 28 00 12 34 56 78 00 00 08 00
$t rdh kernel: blk_update_request: critical medium error, dev $2, sector 305419896
$t rdh kernel: Buffer I/O error on dev ${2}1, logical block 38177231, async page read
EOF
}

echo "시험 폴더: $TOP"

# ══ 1. 깨끗한 서버 ═════════════════════════════════════════════════════════════
if want clean; then
new_case clean "lsblk smartctl journalctl dmesg tune2fs rpm"
{ boot_lines "$(ago 30)"
  echo "$(trad "$(ago 30 -60)") rdh smartd[1201]: Device: /dev/sda [SAT], ST1000NM0033-9ZM173, S/N:ZAAA0001, WWN:5-000c50-07b1c2d3e, FW:SN04, 1.00 TB"
  echo "$(trad "$(ago 2)") rdh systemd: Started Session 12 of user root."
} > "$ROOT/var/log/messages"
echo 'NAME="sda" KNAME="sda" TYPE="disk" SIZE="931.5G" MODEL="ST1000NM0033-9ZM" VENDOR="ATA     " SERIAL="ZAAA0001" WWN="0x5000c5007b1c2d3e" TRAN="sata" HCTL="0:0:0:0" ROTA="1"' > "$FIX/lsblk-disk.out"
printf '%s\n' 'NAME="sda" KNAME="sda" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""' 'NAME="sda1" KNAME="sda1" PKNAME="sda" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/"' > "$FIX/lsblk-tree.out"
echo "/dev/sda -d scsi # /dev/sda, SCSI device" > "$FIX/smartctl-scan.out"
smart_ata smartctl__dev_sda.out ZAAA0001 "5 000c50 07b1c2d3e" 0 0 0 25000
echo "Filesystem created:       $(ctime "$(ago 900)")" > "$FIX/tune2fs_sda1.out"
ago 900 > "$FIX/rpm.out"
echo "[    0.000000] Linux version 3.10.0-1160.el7.x86_64" > "$FIX/dmesg.out"
echo "$(iso "$(ago 30)") rdh kernel: Linux version 3.10.0-1160.el7.x86_64" > "$FIX/journal.out"
run_case
expect_rc 0
expect '\[불명\] 근거 구간 안에서는 미디어'
expect '누적값 0 1대'
expect '전부 지금도 있습니다'
expect 'OS 로그 근거 구간: '
expect '휘발성(/run/log/journal)'
expect_not '\[확정\] sd'
common_checks
fi

# ══ 2. 미디어 오류 → 같은 디스크를 포맷해 계속 사용 ════════════════════════════
if want reuse; then
new_case reuse "lsblk smartctl journalctl dmesg tune2fs rpm"
{ boot_lines "$(ago 60)"
  echo "$(trad "$(ago 60 -60)") rdh smartd[1201]: Device: /dev/sdb [SAT], ST1000NM0033-9ZM173, S/N:ZBBB0002, WWN:5-000c50-07b1c2d4f, FW:SN04, 1.00 TB"
  media_lines "$(ago 40)" sdb 1:0:0:0
  media_lines "$(ago 40 -61)" sdb 1:0:0:0
  echo "$(trad "$(ago 40 -90)") rdh smartd[1201]: Device: /dev/sdb [SAT], 2 Currently unreadable (pending) sectors"
} > "$ROOT/var/log/messages-rot"
gzip "$ROOT/var/log/messages-rot"; mv "$ROOT/var/log/messages-rot.gz" "$ROOT/var/log/messages-20261001.gz"
touch -d "@$(ago 39)" "$ROOT/var/log/messages-20261001.gz"
echo "$(trad "$(ago 1)") rdh systemd: Started Session 99 of user root." > "$ROOT/var/log/messages"
printf '%s\n' 'NAME="sda" KNAME="sda" TYPE="disk" SIZE="931.5G" MODEL="ST1000NM0033-9ZM" VENDOR="ATA" SERIAL="ZAAA0001" WWN="0x5000c5007b1c2d3e" TRAN="sata" HCTL="0:0:0:0" ROTA="1"' \
  'NAME="sdb" KNAME="sdb" TYPE="disk" SIZE="931.5G" MODEL="ST1000NM0033-9ZM" VENDOR="ATA" SERIAL="ZBBB0002" WWN="0x5000c5007b1c2d4f" TRAN="sata" HCTL="1:0:0:0" ROTA="1"' > "$FIX/lsblk-disk.out"
printf '%s\n' 'NAME="sda" KNAME="sda" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""' 'NAME="sda1" KNAME="sda1" PKNAME="sda" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/"' \
  'NAME="sdb" KNAME="sdb" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""' 'NAME="sdb1" KNAME="sdb1" PKNAME="sdb" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/data"' > "$FIX/lsblk-tree.out"
printf '%s\n' "/dev/sda -d scsi # /dev/sda, SCSI device" "/dev/sdb -d scsi # /dev/sdb, SCSI device" > "$FIX/smartctl-scan.out"
smart_ata smartctl__dev_sda.out ZAAA0001 "5 000c50 07b1c2d3e" 0 0 0 25000
smart_ata smartctl__dev_sdb.out ZBBB0002 "5 000c50 07b1c2d4f" 8 2 2 25700 24740     # 오류는 960시간(40일) 전
echo 64 > "$FIX/smartctl__dev_sdb.out.rc"
echo "Filesystem created:       $(ctime "$(ago 900)")" > "$FIX/tune2fs_sda1.out"
echo "Filesystem created:       $(ctime "$(ago 10)")" > "$FIX/tune2fs_sdb1.out"     # 오류 뒤에 새로 만듦
ago 900 > "$FIX/rpm.out"
run_case --save-raw
expect_rc 20
expect '\[확정\] sdb (SATA 직결'
expect '미디어 오류 2회(관련 로그 줄 6)'           # 읽기 실패 2회 — sense · asc · critical medium 줄이 각각 남아도 2회로 센다
expect 'smartd 보류 섹터 최대 2'
expect '\[확정\] sdb — 그대로 있음(교체되지 않음)'
expect '\[확정\] sdb — 포맷 후 재사용'
expect '\[확정\] /dev/sdb · '
expect_not 'smartctl .*-d scsi' "$FIX/calls.log"       # --scan 의 '-d scsi' 를 그대로 넘기면 SATA 자동 판별이 꺼진다
expect '재할당 섹터=8'
expect '가동 시간 역산'
expect '(연도 추정)'
expect 'messages-20261001.gz : 읽음'
expect_not '\[확정\] sda'
if ls -d "$OUT"/rhel-disk-history_*_raw >/dev/null 2>&1; then ok; else bad "--save-raw 폴더 없음"; fi
common_checks
fi

# ══ 3. 미디어 오류 → 디스크 교체됨 ═════════════════════════════════════════════
if want replaced; then
new_case replaced "lsblk smartctl journalctl dmesg tune2fs rpm"
{ boot_lines "$(ago 80)"
  echo "$(trad "$(ago 80 -60)") rdh smartd[1201]: Device: /dev/sdb [SAT], ST1000NM0033-9ZM173, S/N:ZOLD0009, WWN:5-000c50-0deadbeef, FW:SN04, 1.00 TB"
  media_lines "$(ago 50)" sdb 1:0:0:0
  boot_lines "$(ago 30)"
  echo "$(trad "$(ago 30 -60)") rdh smartd[1150]: Device: /dev/sdb [SAT], ST1000NM0033-9ZM173, S/N:ZNEW0010, WWN:5-000c50-0cafef00d, FW:SN04, 1.00 TB"
} > "$ROOT/var/log/messages"
printf '%s\n' 'NAME="sdb" KNAME="sdb" TYPE="disk" SIZE="931.5G" MODEL="ST1000NM0033-9ZM" VENDOR="ATA" SERIAL="ZNEW0010" WWN="0x5000c500cafef00d" TRAN="sata" HCTL="1:0:0:0" ROTA="1"' > "$FIX/lsblk-disk.out"
printf '%s\n' 'NAME="sdb" KNAME="sdb" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""' 'NAME="sdb1" KNAME="sdb1" PKNAME="sdb" TYPE="part" FSTYPE="xfs" MOUNTPOINT="/data"' > "$FIX/lsblk-tree.out"
echo "/dev/sdb -d scsi # /dev/sdb, SCSI device" > "$FIX/smartctl-scan.out"
smart_ata smartctl__dev_sdb.out ZNEW0010 "5 000c50 0cafef00d" 0 0 0 700
echo "v3.crtime.sec = $(ctime "$(ago 29)")" > "$FIX/xfsdb_sdb1.out"
ln -s "$HERE/fakebin/xfs_db" "$BIN/xfs_db"
run_case
expect_rc 20
expect '\[확정\] sdb (SATA 직결'
expect '\[확정\] sdb — 현재 없음(교체 · 제거됨)'
expect 'S/N ZOLD0009'
expect '\[해당 없음\] sdb — 재사용 아님'
expect '과거에 있었으나 지금 없는 디스크: S/N ZOLD0009'
expect 'xfs_db 루트 inode 생성 시각'
expect '미디어 계열 누적값 0'
common_checks
fi

# ══ 4. 오탐 방지: 전송 · 경로 오류 · 광학 · USB · WRITE SAME ════════════════════
if want transport; then
new_case transport "lsblk dmesg"
T=$(ago 5)
{ echo "$(trad "$(ago 20)") rdh kernel: Linux version 3.10.0-1160.el7.x86_64"
  echo "$(trad "$(ago 20)") rdh kernel: scsi host3: iSCSI Initiator over TCP/IP"
  echo "$(trad "$(ago 20)") rdh kernel: sd 3:0:0:1: [sdc] Attached SCSI disk"
  echo "$(trad "$(ago 20)") rdh kernel: scsi host6: usb-storage 1-1:1.0"
  echo "$(trad "$(ago 20)") rdh kernel: sd 6:0:0:0: [sdd] Attached SCSI removable disk"
  echo "$(trad "$T") rdh kernel: connection1:0: detected conn error (1020)"
  echo "$(trad "$T") rdh kernel: sd 3:0:0:1: [sdc] tag#0 FAILED Result: hostbyte=DID_TRANSPORT_FAILFAST driverbyte=DRIVER_OK"
  echo "$(trad "$T") rdh kernel: blk_update_request: I/O error, dev sdc, sector 1234"
  echo "$(trad "$T") rdh kernel: sd 3:0:0:1: rejecting I/O to offline device"
  echo "$(trad "$T") rdh kernel: Buffer I/O error on dev sdc1, logical block 10, lost async page write"
  echo "$(trad "$T") rdh kernel: blk_update_request: I/O error, dev sr0, sector 0"
  echo "$(trad "$T") rdh kernel: blk_update_request: critical target error, dev sda, sector 2048"
  echo "$(trad "$T") rdh kernel: blk_update_request: I/O error, dev sdd, sector 8"
  echo "$(trad "$T") rdh kernel: blk_update_request: I/O error, dev loop0, sector 8"
} > "$ROOT/var/log/messages"
echo 'NAME="sda" KNAME="sda" TYPE="disk" SIZE="100G" MODEL="Virtual disk" VENDOR="VMware" SERIAL="" WWN="" TRAN="" HCTL="0:0:0:0" ROTA="1"' > "$FIX/lsblk-disk.out"
: > "$FIX/lsblk-tree.out"
run_case
expect_rc 0
expect '\[해당 없음·추정\] sdc'
expect '\[해당 없음·추정\] sda'
expect '\[제외\] sr0'
expect '\[제외\] sdd — USB 이동식'
expect '\[제외\] loop0'
expect_not '^    \[확정\]'
expect_not '^    \[추정\] sd'
expect 'smartctl 명령이 없습니다'
expect 'storcli / perccli 명령이 없습니다'
expect '\[해당 없음\] lsblk 기준 RAID 가상 디스크가 없습니다'
expect 'journalctl : 명령 없음'
common_checks
fi

# ══ 5. PERC: 컨트롤러 기록으로만 보이는 오류 · 슬롯 교체 ════════════════════════
if want perc; then
new_case perc "lsblk smartctl storcli64 dmesg tune2fs"
echo "$(trad "$(ago 3)") rdh systemd: Started Session 5 of user root." > "$ROOT/var/log/messages"
echo 'NAME="sda" KNAME="sda" TYPE="disk" SIZE="557.8G" MODEL="PERC H730P Mini" VENDOR="DELL" SERIAL="6d0946600abc" WWN="0x6d0946600abc" TRAN="" HCTL="0:2:0:0" ROTA="1"' > "$FIX/lsblk-disk.out"
printf '%s\n' 'NAME="sda" KNAME="sda" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""' 'NAME="sda1" KNAME="sda1" PKNAME="sda" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/"' > "$FIX/lsblk-tree.out"
echo "Filesystem created:       $(ctime "$(ago 400)")" > "$FIX/tune2fs_sda1.out"
echo "Controller Count = 1" > "$FIX/raid-ctrlcount.out"
pd_block() { # 슬롯 DID 시리얼 WWN SAS주소 MediaErr PredFail
  cat <<EOF
Drive /c0/e32/s$1 :
================

-----------------------------------------------------------------------------
EID:Slt DID State DG     Size Intf Med SED PI SeSz Model            Sp Type
-----------------------------------------------------------------------------
32:$1      $2 Onln   0 558.375 GB SAS  HDD N   N  512B ST600MM0006      U  -
-----------------------------------------------------------------------------

Drive /c0/e32/s$1 - Detailed Information :
=======================================

Drive /c0/e32/s$1 State :
======================
Shield Counter = 0
Media Error Count = $6
Other Error Count = 0
Drive Temperature =  30C (86.00 F)
Predictive Failure Count = $7
S.M.A.R.T alert flagged by drive = No

Drive /c0/e32/s$1 Device attributes :
==================================
SN = $3
Manufacturer Id = SEAGATE
Model Number = ST600MM0006
NAND Vendor = NA
WWN = $4
Firmware Revision = LS08

Port Information :
================
-----------------------------------------
Port Status Linkspeed SAS address
-----------------------------------------
   0 Active 6.0Gb/s   0x$5
   1 Active 6.0Gb/s   0x0
-----------------------------------------

EOF
}
{ pd_block 0 0 S0M0AAAA 5000C5007F8A0B20 5000c5007f8a0b21 0 0
  pd_block 2 5 S0M0NEW2 5000C500AAAA1110 5000c500aaaa1111 0 0
  pd_block 3 3 S0M0CCCC 5000C5007F8A0C30 5000c5007f8a0c31 12 1
} > "$FIX/raid-c0-pd.out"
cat > "$FIX/raid-c0-vd.out" <<EOF
/c0/v0 :
======

---------------------------------------------------------------
DG/VD TYPE  State Access Consist Cache Cac sCC       Size Name
---------------------------------------------------------------
0/0   RAID5 Optl  RW     Yes     RWBD  -   OFF 1.090 TB
---------------------------------------------------------------

PDs for VD 0 :
============

-----------------------------------------------------------------------------
EID:Slt DID State DG     Size Intf Med SED PI SeSz Model            Sp Type
-----------------------------------------------------------------------------
32:0      0 Onln   0 558.375 GB SAS  HDD N   N  512B ST600MM0006      U  -
32:2      5 Onln   0 558.375 GB SAS  HDD N   N  512B ST600MM0006      U  -
32:3      3 Onln   0 558.375 GB SAS  HDD N   N  512B ST600MM0006      U  -
-----------------------------------------------------------------------------

VD0 Properties :
==============
Strip Size = 64 KB
OS Drive Name = /dev/sda
Creation Date = $(date -d "@$(ago 400)" '+%d-%m-%Y')
Creation Time = 10:15:00 AM
SCSI NAA Id = 6d0946600abc
EOF
evt() { printf 'seqNum: 0x%08x\nTime: %s\n\nCode: 0x00000071\nClass: 0\nLocale: 0x02\nEvent Description: %s\nEvent Data:\n===========\nDevice ID: 2\n\n\n' "$1" "$(ctime "$2")" "$3"; }
{ echo "CLI Version = 007.1017.0000.0000"; echo "Controller = 0"; echo "Status = Success"; echo
  evt 100 "$(ago 200)" "Inserted: PD 02(e0x20/s2) Info: enclPd=20, scsiType=0, portMap=00, sasAddr=5000c5007f8a0bb1,0000000000000000"
  evt 101 "$(ago 90)" "Unexpected sense: PD 02(e0x20/s2) Path 5000c5007f8a0bb1, CDB: 28 00 0a 1b 2c 3d 00 00 80 00, Sense: 3/11/00"
  evt 102 "$(ago 90 -30)" "Unrecoverable medium error during recovery on PD 02(e0x20/s2) at 0a1b2c3d"
  evt 103 "$(ago 89)" "State change on PD 02(e0x20/s2) from ONLINE(18) to FAILED(11)"
  evt 104 "$(ago 85)" "Removed: PD 02(e0x20/s2)"
  evt 105 "$(ago 85 -600)" "Inserted: PD 05(e0x20/s2) Info: enclPd=20, scsiType=0, portMap=00, sasAddr=5000c500aaaa1111,0000000000000000"
  evt 106 "$(ago 85 -700)" "Rebuild automatically started on PD 05(e0x20/s2)"
  evt 107 "$(ago 20)" "Corrected medium error during recovery on PD 03(e0x20/s3) at 00112233"
  evt 108 "$(ago 20 -5)" "Unexpected sense: PD 03(e0x20/s3) Path 5000c5007f8a0c31, CDB: 28 00 00 11 22 33 00 00 80 00, Sense: 3/11/00"
  evt 109 "$(ago 10)" "Unexpected sense: PD 00(e0x20/s0) Path 5000c5007f8a0b21, CDB: 12 00 00 00 24 00, Sense: 6/29/00"
} > "$FIX/raid-c0-events.out"
printf '%s\n' "/dev/sda -d scsi # /dev/sda, SCSI device" "/dev/bus/0 -d megaraid,0 # /dev/bus/0 [megaraid_disk_00], SCSI device" "/dev/bus/0 -d megaraid,3 # /dev/bus/0 [megaraid_disk_03], SCSI device" > "$FIX/smartctl-scan.out"
cat > "$FIX/smartctl__dev_sda.out" <<EOF
smartctl 7.0 2018-12-30 r4883
/dev/sda: requires option '-d megaraid,N'
Smartctl open device: /dev/sda failed: DELL or MegaRaid controller, please try adding '-d megaraid,N'
EOF
echo 2 > "$FIX/smartctl__dev_sda.out.rc"
sas_out() { # 파일 시리얼 luid grown 읽기미복구
  cat > "$FIX/$1" <<EOF
smartctl 7.0 2018-12-30 r4883
=== START OF INFORMATION SECTION ===
Vendor:               SEAGATE
Product:              ST600MM0006
Revision:             LS08
Rotation Rate:        10000 rpm
Logical Unit id:      0x$3
Serial number:        $2
Device type:          disk
Transport protocol:   SAS (SPL-3)

=== START OF READ SMART DATA SECTION ===
SMART Health Status: OK

Accumulated power on time, hours:minutes 31234:10
Elements in grown defect list: $4

Error counter log:
           Errors Corrected by           Total   Correction     Gigabytes    Total
               ECC          rereads/    errors   algorithm      processed    uncorrected
           fast | delayed   rewrites  corrected  invocations   [10^9 bytes]  errors
read:          0        0         0         0          0      12345.678           $5
write:         0        0         0         0          0       1234.567           0

Non-medium error count:       17
EOF
}
sas_out smartctl__dev_bus_0_megaraid_0.out S0M0AAAA 5000c5007f8a0b20 0 0
sas_out smartctl__dev_bus_0_megaraid_3.out S0M0CCCC 5000c5007f8a0c30 14 3
# 실서버 실측 형식: PERC 뒤 SATA 디스크는 --scan 이 '-d sat+megaraid,N' 으로 알려 준다
echo "/dev/bus/0 -d sat+megaraid,5 # /dev/bus/0 [megaraid_disk_05] [SAT], ATA device" >> "$FIX/smartctl-scan.out"
smart_ata smartctl__dev_bus_0_sat_megaraid_5.out 22TESTSATA05 "5 000039 b78d00005" 1 0 0 12000
run_case --save-raw
RAWF=$(ls "$OUT"/*_raw/facts.tsv 2>/dev/null | head -n 1)
expect "$(printf 'sat+megaraid,5\tosdev=\tkind=ata')" "$RAWF"      # 접근 노드(bus/0)를 OS 디스크 이름으로 오인하지 않는다
expect '\[확정\] /dev/bus/0 -d sat+megaraid,5 · '
expect 'smartctl -x -d sat+megaraid,5 /dev/bus/0' "$FIX/calls.log"
expect_rc 20
expect 'sda .*RAID 가상 디스크'
expect '\[확정\] 슬롯 0:32:3 .*Media Error Count 12'
expect '\[확정\] 이벤트 로그 · 슬롯 0:32:2 — 미디어 오류 2 · 예측 장애 0 · 실패 처리 1'
expect '\[확정\] PERC 슬롯 0:32:2 — 교체됨'
expect '\[확정\] PERC 슬롯 0:32:3 — 그대로 있음'
expect '\[확정\] /dev/bus/0 -d megaraid,3'
expect 'grown defect=14'
expect '읽기 미복구=3'
expect '\[해당 없음\] /dev/sda — RAID 가상 디스크라 SMART 가 없습니다'
expect 'PERC 슬롯 0:32:2 — 가상 디스크 0:0(sda)는 오류 이전'
expect '컨트롤러 이벤트.*읽음'
expect_not '이벤트 로그 · 슬롯 0:32:0'            # sense key 6(Unit Attention)은 오류가 아니다
common_checks
fi

# ══ 6. 도구가 하나도 없을 때: 원인 미상 I/O 오류만 ═════════════════════════════
if want notools; then
new_case notools ""
{ echo "$(trad "$(ago 12)") rdh kernel: blk_update_request: I/O error, dev sda, sector 4096"
  echo "$(trad "$(ago 12)") rdh kernel: EXT4-fs warning (device sda2): ext4_end_bio:323: I/O error -5 writing to inode 12 (offset 0 size 4096 starting block 1234)"
  echo "$(trad "$(ago 12 -5)") rdh kernel: EXT4-fs (sda2): Remounting filesystem read-only"
} > "$ROOT/var/log/messages"
run_case
expect_rc 10
expect '\[추정\] sda (종류 불명'
expect '원인 미상 I/O 오류 1건'
expect '파일시스템 I/O 오류 1건'
expect '\[불명\] sda — 커널 로그에는 장치 이름(sda)만 있고'
expect '\[불명\] sda — 지금 이 장치 이름 위에 생성 시각을 읽을 수 있는 파일시스템이 없습니다'
expect 'smartctl 명령이 없습니다'
expect 'lsblk.*명령 없음'
expect 'dmesg : 못 읽음(명령 없음)'
expect_not '^    \[확정\]'
common_checks
fi

# ══ 7. 압축 로그(gz · xz · bz2) · 해 넘김 · 압축 해제 명령 없음 ═════════════════
if want compressed; then
new_case compressed "lsblk"
Y=$(date +%Y)
DEC31=$(date -d "$((Y - 1))-12-31 23:50:00" +%s); JAN01=$(date -d "$Y-01-01 00:10:00" +%s)
{ echo "$(trad "$DEC31") rdh kernel: blk_update_request: critical medium error, dev sdb, sector 100"
  echo "$(trad "$JAN01") rdh kernel: blk_update_request: critical medium error, dev sdb, sector 200"
} > "$ROOT/var/log/messages-a"
xz "$ROOT/var/log/messages-a"; touch -d "@$((JAN01 + 3600))" "$ROOT/var/log/messages-a.xz"
echo "$(trad "$(ago 3)") rdh kernel: blk_update_request: critical medium error, dev sdc, sector 300" > "$ROOT/var/log/messages-b"
bzip2 "$ROOT/var/log/messages-b"; touch -d "@$(ago 2)" "$ROOT/var/log/messages-b.bz2"
echo "$(trad "$(ago 1)") rdh kernel: blk_update_request: critical medium error, dev sdd, sector 400" > "$ROOT/var/log/messages-c"
gzip "$ROOT/var/log/messages-c"
echo "2026-01-05T10:00:00+09:00 rdh kernel: print_req_error: critical medium error, dev sde, sector 500" > "$ROOT/var/log/messages"   # RSYSLOG_FileFormat(ISO) + RHEL 8 문구
: > "$FIX/lsblk-disk.out"; : > "$FIX/lsblk-tree.out"
rm -f "$BIN/bzip2"                                   # bzip2 가 없는 서버
run_case
expect_rc 20
expect "sdb .*$((Y - 1))-12-31 23:50(연도 추정) ~ $Y-01-01 00:10(연도 추정)\|기간 $((Y - 1))-12-31 23:50(연도 추정) ~ $Y-01-01 00:10(연도 추정)"
expect 'messages-b.bz2 : 못 읽음(압축 해제 명령 bzip2 없음)'
expect '\[확정\] sdd'
expect '\[확정\] sde'
ISOT=$(date -d "2026-01-05T10:00:00+09:00" '+%Y-%m-%d %H:%M')          # 시간대가 붙은 ISO 시각은 이 서버의 시간대로 바꿔 보인다
expect "기간 $ISOT ~ $ISOT"
expect_not '\[확정\] sdc'
common_checks
fi

# ══ 8. 중복 제거(messages · journal · dmesg 에 같은 줄) + RHEL 8/9 문구 + NVMe ═══
if want dedup; then
new_case dedup "lsblk smartctl journalctl dmesg"
echo "Red Hat Enterprise Linux release 9.4 (Plow)" > "$ROOT/etc/redhat-release"
echo "5.14.0-427.el9.x86_64" > "$FIX/uname.out"
mkdir -p "$ROOT/var/log/journal/abc"; : > "$ROOT/var/log/journal/abc/system.journal"
B=$(ago 30); E=$(ago 4)
M1="blk_update_request: critical medium error, dev nvme0n1, sector 777 op 0x0:(READ) flags 0x0 phys_seg 1 prio class 0"
M2="nvme0n1: I/O Cmd(0x2) @ LBA 777, 8 blocks, I/O Error (sct 0x2 / sc 0x81) MORE DNR"
M3="I/O error, dev sdb, sector 9000 op 0x1:(WRITE) flags 0x800 phys_seg 1 prio class 2"
{ echo "$(trad "$B") rdh kernel: Linux version 5.14.0-427.el9.x86_64"
  for m in "$M1" "$M2" "$M3"; do echo "$(trad "$E") rdh kernel: $m"; done
} > "$ROOT/var/log/messages"
{ echo "$(iso "$B") rdh kernel: Linux version 5.14.0-427.el9.x86_64"
  for m in "$M1" "$M2" "$M3"; do echo "$(iso "$E") rdh kernel: $m"; done
} > "$FIX/journal.out"
SECS=$(( E - B ))
{ echo "[    0.000000] Linux version 5.14.0-427.el9.x86_64"
  for m in "$M1" "$M2" "$M3"; do echo "[$SECS.123456] $m"; done
  echo "[$((SECS + 7200)).000001] nvme nvme0: I/O 12 QID 3 timeout, aborting"
} > "$FIX/dmesg.out"
printf '%s\n' 'NAME="nvme0n1" KNAME="nvme0n1" TYPE="disk" SIZE="1.5T" MODEL="Dell Ent NVMe P5600" VENDOR="" SERIAL="PHAB1234" WWN="eui.01000000000000005cd2e4aabbccdd00" TRAN="nvme" HCTL="" ROTA="0"' \
  'NAME="sdb" KNAME="sdb" TYPE="disk" SIZE="1T" MODEL="SSDSC2KB960G8R" VENDOR="ATA" SERIAL="BTYF0001" WWN="0x55cd2e4150000001" TRAN="sata" HCTL="1:0:0:0" ROTA="0"' > "$FIX/lsblk-disk.out"
: > "$FIX/lsblk-tree.out"
echo "/dev/sdb -d scsi # /dev/sdb, SCSI device" > "$FIX/smartctl-scan.out"       # NVMe 는 --scan 에 안 나오는 옛 판 흉내 → lsblk 로 보충
smart_ata smartctl__dev_sdb.out BTYF0001 "5 5cd2e4 150000001" 0 0 0 9000
cat > "$FIX/smartctl__dev_nvme0n1.out" <<EOF
smartctl 7.2 2020-12-30 r5155
=== START OF INFORMATION SECTION ===
Model Number:                       Dell Ent NVMe P5600 MU U.2 1.6TB
Serial Number:                      PHAB1234
Firmware Version:                   1.2.3
=== START OF SMART DATA SECTION ===
SMART overall-health self-assessment test result: PASSED

SMART/Health Information (NVMe Log 0x02)
Critical Warning:                   0x00
Available Spare:                    100%
Percentage Used:                    2%
Power On Hours:                     8,123
Media and Data Integrity Errors:    4
Error Information Log Entries:      9
EOF
B=$((NOW - 30 * 86400))      # dmesg 환산 기준(가동 30일)과 맞춘다
run_case
expect_rc 20
expect '\[확정\] nvme0n1 (NVMe'
expect '미디어 오류 1회(관련 로그 줄 2)'             # 세 출처(messages · journal · dmesg)에 있어도 한 번
expect '\[추정\] sdb (SATA 직결 — 현재 lsblk 기준'
expect '원인 미상 I/O 오류 1건'
expect 'NVMe media errors=4'
expect '\[확정\] /dev/nvme0n1 · Dell Ent NVMe'
expect '영구 저장(/var/log/journal)'
expect '(같은 기록:.*dmesg)'
expect '\[해당 없음·추정\] nvme0 — .*(전송·경로 1 '        # dmesg 에만 있는 nvme 타임아웃(다른 시각)은 살아남는다
expect_not '같은 기록:.*전체 범위'
common_checks
fi

# ══ 9. root 아님 ══════════════════════════════════════════════════════════════
if want nonroot; then
new_case nonroot "lsblk"
echo "$(trad "$(ago 3)") rdh kernel: blk_update_request: critical medium error, dev sdb, sector 100" > "$ROOT/var/log/messages"
: > "$FIX/lsblk-disk.out"; : > "$FIX/lsblk-tree.out"
chmod -R o+rX "$TOP" 2>/dev/null; chmod 777 "$D" "$OUT" "$FIX"; chmod 711 "$TOP"
chmod 600 "$ROOT/var/log/messages"                  # root 전용 로그
if command -v setpriv >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && setpriv --reuid=65534 --regid=65534 --clear-groups test -r "$ROOT/etc/redhat-release" -a -r "$SCRIPT"; then
  ( cd "$D" && setpriv --reuid=65534 --regid=65534 --clear-groups env -i PATH="$BIN" HOME="$D/home" LANG=C RDH_ROOT="$ROOT" RDH_FIX="$FIX" TMPDIR="$D" \
      bash "$SCRIPT" -o "$OUT" > "$D/screen.txt" 2> "$D/stderr.txt" ); RC=$?
  RES=$(ls "$OUT"/rhel-disk-history_*.txt 2>/dev/null | head -n 1); SCREEN="$D/screen.txt"
  expect_rc 0
  expect 'root 가 아닙니다' "$D/stderr.txt"
  expect 'messages : 못 읽음(권한 없음)'
  expect 'root 가 아님'
  expect 'NOTE: terminal locale is not UTF-8' "$SCREEN"
  expect_not '\[확정\] sdb'
  rm -f "$OUT"/*.txt
  ( cd "$D" && setpriv --reuid=65534 --regid=65534 --clear-groups env -i PATH="$BIN" HOME="$D/home" LANG=C RDH_ROOT="$ROOT" RDH_FIX="$FIX" TMPDIR="$D" \
      bash "$SCRIPT" -o "$OUT" --require-root > "$D/screen2.txt" 2> "$D/stderr2.txt" ); RC=$?
  expect_rc 3
  expect 'root 로 다시 실행' "$D/stderr2.txt"
else
  echo "  SKIP [nonroot] setpriv 가 없거나 · root 가 아니거나 · 시험 폴더($TOP)를 다른 계정이 들어갈 수 없어 건너뜀(TMPDIR=/tmp 로 다시 돌리면 됨)"
fi
fi

# ══ 11. 시리얼 근거 없이 정황만: 핫스왑 · 가동 시간 · LVM · md · 셸 기록 · SAN LUN ═══
if want hints; then
new_case hints "lsblk smartctl dmesg xfs_db mdadm tune2fs"
mkdir -p "$ROOT/etc/lvm/backup" "$ROOT/etc/lvm/archive" "$ROOT/root" "$ROOT/dev/disk/by-id" "$ROOT/sys/block/dm-2/dm" "$ROOT/sys/block/dm-2/slaves"
B=$(ago 100); E=$(ago 70)
{ echo "$(trad "$B") rdh kernel: Linux version 3.10.0-1160.el7.x86_64"
  echo "$(trad "$B") rdh kernel: scsi host2: Fusion MPT SAS Host"
  echo "$(trad "$B") rdh kernel: scsi host5: qla2xxx"
  echo "$(trad "$B") rdh kernel: sd 2:0:5:0: [sdc] Attached SCSI disk"
  echo "$(trad "$B") rdh kernel: sd 5:0:0:1: [sdf] Attached SCSI disk"
  echo "$(trad "$E") rdh kernel: sd 2:0:5:0: [sdc] tag#1 Sense Key : Hardware Error [current]"
  echo "$(trad "$E") rdh kernel: blk_update_request: I/O error, dev sdc, sector 4096"
  echo "$(trad "$((E + 3600))") rdh kernel: blk_update_request: critical medium error, dev sdf, sector 77"
  echo "$(trad "$(ago 65)") rdh kernel: sd 2:0:6:0: [sdc] Attached SCSI disk"
} > "$ROOT/var/log/messages"
echo "$(trad "$(ago 64)") rdh sudo:   admin : TTY=pts/0 ; PWD=/home/admin ; USER=root ; COMMAND=/sbin/mkfs.ext4 /dev/sdc1" > "$ROOT/var/log/secure"
echo "[   12.345678] blk_update_request: I/O error, dev sdc, sector 5" > "$ROOT/var/log/dmesg.old"
printf '%s\n' "#$(ago 64)" "mkfs.xfs -f /dev/vgdata/lvdata" "fdisk -l" "#$(ago 64 -60)" "wipefs -a /dev/sdc" "ls -l /data" > "$ROOT/root/.bash_history"
LVT=$(ago 64)
printf '%s\n' '# Generated by LVM2 version 2.02.187(2)-RHEL7' 'contents = "Text Format Volume Group"' 'version = 1' \
  "description = \"Created *after* executing 'lvcreate -n lvdata -l 100%FREE vgdata'\"" 'creation_host = "rdh"	# Linux rdh 3.10.0' "creation_time = $LVT	# comment" '' \
  'vgdata {' '	id = "abc"' '	seqno = 2' '	physical_volumes {' '		pv0 {' '			id = "def"' '			device = "/dev/sdc1"	# Hint only' '			status = ["ALLOCATABLE"]' '		}' '	}' \
  '	logical_volumes {' '		lvdata {' '			id = "ghi"' '			status = ["READ", "WRITE", "VISIBLE"]' "			creation_time = $LVT	# comment" '			creation_host = "rdh"' '			segment_count = 1' \
  '			segment1 {' '				start_extent = 0' '				stripes = [' '					"pv0", 0' '				]' '			}' '		}' '	}' '}' > "$ROOT/etc/lvm/backup/vgdata"
sed "s/Created \*after\* executing 'lvcreate.*'/Created *before* executing 'vgcreate vgdata \/dev\/sdc1'/" "$ROOT/etc/lvm/backup/vgdata" > "$ROOT/etc/lvm/archive/vgdata_00000-1234.vg"
printf 'Personalities : [raid1]\nmd0 : active raid1 sde1[1] sdd1[0]\n      976630464 blocks super 1.2 [2/2] [UU]\n\nunused devices: <none>\n' > "$ROOT/proc/mdstat"
printf '/dev/md0:\n           Version : 1.2\n     Creation Time : %s\n        Raid Level : raid1\n' "$(ctime "$(ago 500)")" > "$FIX/mdadm_md0.out"
: > "$ROOT/dev/sdc"; ln -s ../../sdc "$ROOT/dev/disk/by-id/wwn-0x5000c500bbbb2220"; ln -s ../../sdc "$ROOT/dev/disk/by-id/scsi-35000c500bbbb2220"
echo vgdata-lvdata > "$ROOT/sys/block/dm-2/dm/name"; : > "$ROOT/sys/block/dm-2/slaves/sdc1"
printf '%s\n' 'NAME="sdc" KNAME="sdc" TYPE="disk" SIZE="558.9G" MODEL="ST600MM0006" VENDOR="SEAGATE" SERIAL="S0M0NEWX" WWN="" TRAN="sas" HCTL="2:0:6:0" ROTA="1"' \
  'NAME="sdf" KNAME="sdf" TYPE="disk" SIZE="2T" MODEL="VV" VENDOR="3PARdata" SERIAL="" WWN="0x60002ac0000000000000000000012345" TRAN="fc" HCTL="5:0:0:1" ROTA="1"' > "$FIX/lsblk-disk.out"
printf '%s\n' 'NAME="sdc" KNAME="sdc" PKNAME="" TYPE="disk" FSTYPE="" MOUNTPOINT=""' \
  'NAME="sdc1" KNAME="sdc1" PKNAME="sdc" TYPE="part" FSTYPE="LVM2_member" MOUNTPOINT=""' \
  'NAME="vgdata-lvdata" KNAME="dm-2" PKNAME="sdc1" TYPE="lvm" FSTYPE="xfs" MOUNTPOINT="/data"' \
  'NAME="md0" KNAME="md0" PKNAME="sdd1" TYPE="raid1" FSTYPE="ext4" MOUNTPOINT="/backup"' > "$FIX/lsblk-tree.out"
echo "v3.crtime.sec = $(ctime "$(ago 64)")" > "$FIX/xfsdb_dm-2.out"
echo "Filesystem created:       $(ctime "$(ago 499)")" > "$FIX/tune2fs_md0.out"
echo "/dev/sdc -d scsi # /dev/sdc, SCSI device" > "$FIX/smartctl-scan.out"
printf '%s\n' '=== START OF INFORMATION SECTION ===' 'Vendor:               SEAGATE' 'Product:              ST600MM0006' 'Logical Unit id:      0x5000c500bbbb2220' 'Serial number:        S0M0NEWX' \
  '=== START OF READ SMART DATA SECTION ===' 'SMART Health Status: OK' 'Accumulated power on time, hours:minutes 1500:10' 'Elements in grown defect list: 0' \
  'read:          0        0         0         0          0      12345.678           0' 'write:         0        0         0         0          0       1234.567           0' > "$FIX/smartctl__dev_sdc.out"
run_case
expect_rc 20
expect '\[추정\] sdc (SAS/HBA 직결 — 그때의 부팅 로그)'
expect '하드웨어 오류 1건'
expect '시각 불명 출처 1건'
expect '\[추정\] sdc — 교체된 것으로 보임'
expect '같은 이름으로 장치가 새로 연결됨'
expect '누적 가동 시간(1500h)'
expect '\[추정\] sdc — 첫 오류(.*뒤에 파일시스템이 새로 만들어짐'
expect 'dm-2(xfs /data) 생성'
expect 'LVM: .* VG vgdata LV lvdata 생성'
expect "변경 이력: Created \*before\* executing 'vgcreate vgdata /dev/sdc1'"
expect 'md: md0 생성 .* 구성 sde1,sdd1'
expect '포맷 · 초기화 계열 명령: .*mkfs.xfs -f /dev/vgdata/lvdata'
expect '포맷 · 초기화 계열 명령: .*wipefs -a /dev/sdc'
expect '포맷 · 초기화 계열 명령: .*/sbin/mkfs.ext4 /dev/sdc1'
expect_not '포맷 · 초기화 계열 명령: .*fdisk -l'
expect 'dm-2 = vgdata-lvdata (현재 하위 장치: sdc1)'
expect 'sdc .*S/N S0M0NEWX · WWN 5000c500bbbb2220'
expect '\[확정\] sdf (FC LUN — 그때의 부팅 로그)'
expect '\[해당 없음\] sdf — SAN LUN 입니다'
expect_not 'smartctl .*/dev/sdf' "$FIX/calls.log"            # SAN LUN 에는 smartctl 을 돌리지 않는다
expect 'md0(ext4 /backup) 생성 .* 놓인 디스크 sdd'
expect '같은 장치 이름으로 실행한 포맷 계열 명령 기록'
expect 'dmesg 사본 .*/var/log/dmesg.old : 읽음'
expect '셸 기록 .*/root/.bash_history : 읽음'
common_checks
fi

# ══ 10. 옵션 · 사용법 ═════════════════════════════════════════════════════════
if want cli; then
new_case cli ""
( cd "$D" && env -i PATH="$BIN" bash "$SCRIPT" --help > "$D/help.txt" 2>&1 ); RC=$?; expect_rc 0; expect '읽기 전용' "$D/help.txt"
( cd "$D" && env -i PATH="$BIN" bash "$SCRIPT" --bogus > "$D/bogus.txt" 2>&1 ); RC=$?; expect_rc 2
( cd "$D" && env -i PATH="$BIN" bash "$SCRIPT" --timeout abc > "$D/bad.txt" 2>&1 ); RC=$?; expect_rc 2
echo "$(trad "$(ago 3)") rdh kernel: blk_update_request: critical medium error, dev sdb, sector 100" > "$D/extra.log"
run_case -q --extra-log "$D/extra.log" --no-smart --no-raid --no-journal --no-history
expect_rc 20
expect '추가 로그 .*extra.log : 읽음'
expect 'smartctl 을 실행하지 않았습니다(--no-smart)'
if [ "$(wc -l < "$SCREEN")" = 1 ]; then ok; else bad "-q 인데 화면 출력이 한 줄이 아님"; fi
common_checks
fi

echo
echo "통과 $PASS · 실패 $FAIL"
if [ "$FAIL" -gt 0 ]; then printf '실패 목록:%b\n' "$FAILED"; [ "$KEEP" = 1 ] && echo "남긴 폴더: $TOP"; exit 1; fi
[ "$KEEP" = 1 ] && echo "남긴 폴더: $TOP"
exit 0
