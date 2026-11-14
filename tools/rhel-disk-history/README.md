# rhel-disk-history — RHEL 디스크 과거 장애 이력 점검(읽기 전용 · 독립 실행)

Red Hat / RHEL 서버에서 root 로 직접 실행하는 스크립트입니다. 포탈과는 연결되어 있지 않습니다(포탈 반영은 나중).
남아 있는 로그와 디스크 · 컨트롤러가 들고 있는 기록을 모아 세 가지를 **확정 / 추정 / 불명** 으로 판정하고, 판정마다 근거 줄을 붙입니다.

1. 과거 bad sector / I/O / media error 발생 여부
2. 포맷 후 재사용 정황
3. 과거 장애 디스크가 교체되어 지금은 없는지(시리얼 / WWN 기준)

> **실서버 미검증입니다(2026-11-14).** 가짜 로그와 가짜 명령으로만 시험했습니다. 커널 · smartctl · storcli/perccli 의 출력 형식은
> 공개 소스와 문서를 기억해 적은 것이라 실제 장비와 다를 수 있습니다. **서버 한 대에서 `--save-raw` 로 먼저 돌려 결과를 확인**한 뒤 넓히십시오
> (아래 '처음 돌릴 때').

## 파일

| 파일 | 내용 |
|---|---|
| `rhel-disk-history.sh` | 스크립트 본체(이 파일 하나만 서버에 복사하면 됩니다) |
| `test/run-tests.sh` · `test/fakebin/` | 시나리오 시험(가짜 로그 폴더 + PATH 에 둔 가짜 smartctl · storcli · lsblk …) |

## 요구 환경

- RHEL 7 · 8 · 9. bash 4.2 이상, GNU awk(RHEL 의 `/usr/bin/awk`), coreutils · grep · sed.
- root 권한. root 가 아니면 무엇을 못 읽는지 알리고 읽을 수 있는 것만 진행합니다(`--require-root` 를 주면 진행하지 않고 끝냅니다).
- 있으면 쓰고 없으면 '명령 없음' 으로 기록하고 계속합니다: `journalctl` · `dmesg` · `lsblk` · `smartctl`(smartmontools) ·
  `perccli64` / `storcli64`(PATH 또는 `/opt/MegaRAID/perccli/` · `/opt/MegaRAID/storcli/`) · `tune2fs` · `xfs_db` · `mdadm` · `rpm` · `gzip` · `xz` · `bzip2`.

## 실행

```bash
chmod 700 rhel-disk-history.sh
```

```bash
./rhel-disk-history.sh --save-raw
```

화면에는 요약이, 결과 파일에는 근거 줄까지 전부 들어갑니다.

- 결과 파일: `/root/rhel-disk-history/rhel-disk-history_<호스트>_<YYYYmmdd-HHMMSS>.txt` (권한 600)
- `--save-raw` 를 주면 그 옆 `…_raw/` 폴더에 명령 원본 출력(smartctl · storcli · lsblk …)과 `facts.tsv`(판정에 쓴 사실 목록)가 남습니다.
- 작업용 임시 파일은 `/dev/shm`(메모리)에 만들고 끝나면 지웁니다. 디스크에 쓰는 것은 결과 파일(보통 수십 KB)뿐입니다.
- 저장 위치에 쓸 수 없으면(읽기 전용으로 바뀐 루트 등) `/dev/shm` → `/tmp` 순으로 바꿔 저장하고 그 사실을 알립니다.

### 옵션

| 옵션 | 뜻 |
|---|---|
| `-o, --output-dir DIR` | 결과 저장 위치(기본 `/root/rhel-disk-history`, root 가 아니면 `$HOME/rhel-disk-history`) |
| `--save-raw` | 명령 원본 출력을 결과 옆 폴더에 남김 — 처음 돌릴 때 권장 |
| `--extra-log FILE` | 추가로 분석할 로그 파일(여러 번 가능 · gz/xz/bz2 가능). 따로 보관해 둔 옛 messages 를 넣을 때 |
| `--no-smart` · `--no-raid` · `--no-journal` · `--no-history` | 해당 출처를 건너뜀(건너뛴 만큼 판정이 불명이 됩니다) |
| `--require-root` | root 가 아니면 종료(코드 3) |
| `--timeout SEC` | 일반 명령 1개 시한(기본 60초) |
| `--long-timeout SEC` | journalctl · 컨트롤러 이벤트 로그 시한(기본 600초) |
| `--max-evidence N` | 장치 1개당 결과 파일에 싣는 근거 묶음 수(기본 30) |
| `-q, --quiet` | 화면에는 결과 파일 경로만 |

### 종료 코드

| 코드 | 뜻 |
|---|---|
| 0 | 근거 구간 안에 확정 · 추정 오류 기록 없음(= '없었다' 가 아닙니다) |
| 10 | 추정만 있음 |
| 20 | 확정 있음 |
| 2 | 사용법 오류 |
| 3 | 실행 불가(필수 도구 없음 · `--require-root` 인데 root 아님 · 저장할 곳 없음) |

## 읽기 전용 보증

스크립트가 실행하는 외부 명령은 아래가 전부이고, 모두 조회입니다. 결과 파일 `[7]` 에 실제로 실행한 명령줄과 종료 상태가 남습니다.

| 명령 | 용도 |
|---|---|
| `lsblk -d -n -P -o …` · `lsblk -n -P -o …` | 현재 디스크 · 파티션 트리 |
| `smartctl --scan` · `smartctl -x [-d megaraid,N] DEV`(옛 판이면 `-a`) | 누적 오류값 · 시리얼 · 오류 로그 |
| `perccli64 / storcli64 show ctrlcount` · `/cN/eall/sall show all` · `/cN/sall show all` · `/cN/vall show all` · `/cN show events` | 물리 디스크 집계 · 가상 디스크 · 컨트롤러 이벤트 로그 |
| `journalctl --no-pager -o short-iso …` · `dmesg` | 커널 · smartd 로그 |
| `gzip -dc` · `xz -dc` · `bzip2 -dc` | 회전된 로그 읽기(표준 출력으로만) |
| `tune2fs -l DEV` · `xfs_db -r -c … DEV` · `stat -c %W` · `mdadm --detail` · `rpm -q --qf` | 파일시스템 · md · OS 설치 시각 |

- `smartctl -t`(자가 진단 시작) · `-s` · `-X`, `storcli … set/start/delete`, `dmesg -c`, `fsck`, `mkfs`, 마운트 변경 등은 쓰지 않습니다.
- `run_cmd()` 를 거치는 명령은 `ro_guard()` 가 한 번 더 걸러, 상태를 바꾸는 인자가 섞이면 실행하지 않고 '차단' 으로 기록합니다.
- storcli/perccli 는 실행 폴더에 로그 파일을 만들 수 있어 임시 작업 폴더에서 실행합니다(끝나면 함께 지워짐).
- 파일로는 `/var/log/messages*` · `/var/log/secure*` · `/var/log/dmesg*` · `/etc/lvm/backup` · `/etc/lvm/archive` · `/proc/mdstat` · `/proc/uptime` ·
  `/dev/disk/by-id` · `/sys/block/dm-*` · `/root/.bash_history`(포맷 계열 명령 줄만 추림)를 읽기만 합니다.
- `smartctl -x` 는 대기(standby) 중인 디스크를 깨울 수 있습니다. 서버 디스크는 보통 상시 가동이라 영향이 없다고 봤습니다(추정).

## 판정 읽는 법

| 표시 | 뜻 |
|---|---|
| `[확정]` | 근거 줄이 직접 말합니다 — 커널의 `critical medium error` · `Sense Key : Medium Error`, smartd 의 보류 섹터 보고, SMART 누적값, 시리얼 일치 등 |
| `[추정]` | 정황은 있으나 다른 설명이 가능합니다. 결과 파일의 '틀릴 수 있는 경우' 를 함께 보십시오 |
| `[불명]` | 판단할 근거가 없거나 읽지 못했습니다. **'없음' 이 아닙니다** |
| `[해당 없음]` · `[제외]` | 전송 · 경로 계열만 있어 미디어 오류로 세지 않았거나, 서버 디스크가 아닌 장치(광학 · USB · loop) |

**'기록 없음' 은 '발생한 적 없음' 이 아닙니다.** 모든 '없음' 은 `[1]` 의 **근거 구간**(가장 오래된 로그 시각 ~ 실행 시각) 안에서만 하는 말입니다.
못 읽은 값은 0 이나 정상으로 치지 않고 불명으로 둡니다.

### 결과 파일 구성

| 절 | 내용 |
|---|---|
| `[1]` | 출처별 상태와 보존 구간(가장 오래된 시각 ~ 가장 최근), 저널이 휘발성인지, 못 읽은 출처와 그 때문에 판단 못 하는 것 |
| `[2]` | 현재 디스크와 식별자(lsblk · by-id · smartctl), PERC 물리 디스크 목록 |
| `[3]` | 판정 ① — (a) OS 로그 (b) 현재 디스크의 SMART 누적값 (c) RAID 컨트롤러 집계 · 이벤트 로그, 그리고 제외한 것 |
| `[4]` | 판정 ② — 오류 시각과 파일시스템 · md · 가상 디스크 생성 시각 비교, 참고용 시각 목록(OS 설치 · LVM · 포맷 계열 명령) |
| `[5]` | 판정 ③ — 오류 당시 시리얼과 현재 시리얼 대조, '과거에 있었으나 지금 없는 디스크' 목록 |
| `[6]` | 한계 |
| `[7]` | 실행한 명령과 상태 |

### ① 오류 분류(오탐 방지)

| 분류 | 넣은 문구(예) | 취급 |
|---|---|---|
| 미디어 오류 | `critical medium error, dev sdX` · `Sense Key : Medium Error` · `Add. Sense: Unrecovered read error` · ATA `error: { UNC }` · NVMe `(sct 0x2 / …)` · md `read error corrected` | 확정 |
| I/O 오류 | `I/O error, dev sdX, sector N` · `Buffer I/O error on dev …` · 파일시스템의 I/O error | 같은 때(±1분) 같은 장치에 미디어 근거가 있으면 미디어 쪽, 전송 근거가 있으면 전송 쪽, 둘 다 없으면 '원인 미상' → 추정 |
| 하드웨어 오류 | `Sense Key : Hardware Error` | 추정 |
| 전송 · 경로 | `hostbyte=DID_*`(DID_OK 제외) · `rejecting I/O to offline device` · ATA 링크 리셋 · `{ ICRC }` · NVMe timeout · iSCSI `detected conn error` · FC rport · multipath | 미디어 오류로 세지 않음 |
| 결함 아님 | `critical target error`(WRITE SAME/UNMAP 미지원) · `critical nexus` · `critical space allocation` · `Illegal Request` · `Unit Attention` | 세지 않음 |
| 제외 | `sr*` · `fd*` · `loop*` · `ram*`, USB 저장 장치(`usb-storage` 호스트) | 판정에서 뺌(결과 파일에만 기록) |
| SAN LUN | 호스트 어댑터가 iSCSI · FC(qla2xxx · lpfc …) | 오류는 기록하되 '이 서버의 물리 디스크 아님' 으로 표시 |

- 같은 커널 줄이 messages · journal · dmesg 에 각각 남으므로 (분 · 분류 · 장치)가 같으면 하나로 셉니다.
- 읽기 실패 한 번이 sense key · ASC · blk 줄을 각각 남기므로, 미디어 오류는 '회수'(같은 분 안에서 줄 종류별 건수의 최댓값)와 '관련 로그 줄 수' 를 따로 보여 줍니다.
- 커널 문구는 판마다 다릅니다(RHEL 7 `blk_update_request:` / `end_request:`, RHEL 8 `print_req_error:`, RHEL 9 후기는 머리말 없음).
  스크립트는 머리말(함수 이름)을 보지 않고 `<종류> error, dev <이름>, sector <N>` 부분만 봅니다. 패턴마다 근거와 확인 수준은 스크립트 주석(`classify.awk` 부분)에 있습니다.

### ③ 시리얼 / WWN 대조

커널 로그에는 보통 `sdX` 이름만 있습니다. 그 시각의 시리얼을 알 수 있는 경우에만 확정이 나옵니다.

| 근거 | 결과 |
|---|---|
| 같은 부팅 안에서 오류 이전에 smartd 가 남긴 `Device: /dev/sdX …, S/N:…, WWN:…` 줄 → 현재 시리얼 목록과 대조 | 확정(그대로 있음 / 현재 없음) |
| PERC 이벤트 로그의 오류 당시 SAS 주소(`Unexpected sense … Path <주소>`) ↔ 현재 그 슬롯 디스크의 WWN · SAS 주소(SAS 디스크만) | 확정(그대로 / 교체됨) |
| 시리얼은 없고 정황만: 오류 뒤 가동 중 같은 이름으로 재연결 · 모델 변경 · 현재 디스크의 누적 가동 시간이 오류 이후 기간보다 짧음 · 같은 슬롯의 삽입 이벤트 | 추정 |
| 연결할 근거 없음 | 불명 |

- '현재 없음' 을 확정으로 말하려면 **현재 디스크의 시리얼을 전부 읽을 수 있어야** 합니다. 못 읽은 현재 디스크가 있으면(예: RAID 뒤인데 storcli · smartctl 없음) 추정으로 내립니다.
- SATA 디스크는 PERC 이벤트의 SAS 주소가 디스크가 아니라 슬롯을 따르므로 주소 비교를 하지 않습니다(슬롯 기준 추정).

### ② 포맷 후 재사용

mkfs 는 로그를 남기지 않습니다. 그래서 '오류 시각' 과 '지금 그 장치 위에 있는 것이 만들어진 시각' 을 비교합니다.

- ext2/3/4: `tune2fs -l` 의 `Filesystem created`
- XFS: 마운트 지점 루트 디렉터리의 생성 시각(`stat -c %W`, RHEL 9) 또는 `xfs_db -r` 로 읽은 루트 inode 생성 시각(v5 포맷). 못 읽으면 불명
- md: `mdadm --detail` 의 `Creation Time` · RAID 가상 디스크: storcli 의 `Creation Date`
- 참고 목록: OS 설치 시각(rpm), LVM `backup` / `archive` 의 LV 생성 · 변경 이력, `/var/log/secure*` 의 sudo 와 root 셸 기록에서 찾은 포맷 계열 명령

오류 뒤에 만들어진 파일시스템이 있으면 — ③ 이 '같은 디스크' 확정이면 **포맷 후 재사용 확정**, '교체됨' 확정이면 해당 없음, 그 밖에는 추정입니다.

## 한계

- **로그 보존**: RHEL 의 logrotate 기본값은 주 단위 4개 보관, 저널은 휘발성(`/run/log/journal`)으로 알고 있습니다(기억 기반 — 서버마다 다르므로 결과 파일 `[1]` 에 실제 설정과 출처별 구간을 싣습니다). 그 이전은 OS 로그로는 알 수 없습니다.
- **RAID 가상 디스크**: OS 는 가상 디스크만 봅니다. 컨트롤러가 다른 디스크의 데이터로 고쳐 읽은 오류, 리빌드, 디스크 교체는 커널 로그에 남지 않습니다.
  storcli/perccli 가 없으면 이 부분은 불명입니다. BOSS 카드(M.2) 뒤의 디스크는 이 스크립트로 읽지 못합니다.
- **장치 이름**: `sdX` 는 부팅 · 재연결 때 바뀔 수 있습니다.
- **연도**: `/var/log/messages` 에는 연도가 없어 파일 수정 시각을 기준으로 맞춥니다('연도 추정' 표시). 파일을 복사해 수정 시각이 바뀌었으면 틀립니다.
- **컨트롤러 시계**: PERC 이벤트 시각은 컨트롤러 시계 기준입니다(호스트 시간대와 다를 수 있음). 'Seconds since last reboot' 로만 찍힌 이벤트는 시각 불명으로 둡니다.
- **SMART 누적값**: 시각이 없습니다. ATA 오류 로그의 가동 시간으로 역산한 날짜는 전원이 꺼져 있던 기간만큼 틀립니다. 속성의 뜻은 제조사마다 조금씩 다릅니다.
- **모르는 문구**: 스크립트가 모르는 형식의 오류 줄은 '기록 없음' 으로 보일 수 있습니다.
- **영문 출력 없음**: 결과는 한국어(UTF-8)입니다. 터미널이 UTF-8 이 아니면 영어로 한 줄 안내하고 그대로 출력합니다 — 결과 파일을 UTF-8 로 열어 보십시오.

## 검증한 것 / 못 한 것

| 항목 | 상태 |
|---|---|
| `bash -n` · shellcheck(warning 이상 0건) | 확인 |
| 가짜 환경 시나리오 11개(아래 · 176개 검사) | 통과 |
| 100만 줄(118MB) messages 처리 | 약 3초(개발 컨테이너 기준) |
| 실제 RHEL 7/8/9 서버 | **미검증** |
| 실제 PERC + storcli/perccli 출력 형식 | **미검증**(문서 예시를 기억해 작성) |
| 실제 smartctl 출력(SATA · SAS · NVMe · megaraid 경유) | **미검증** — 단 실서버 1대에서 `--scan` 의 종류 표기가 `-d sat+megaraid,N`(PERC 뒤 SATA)임을 화면으로 확인해 반영(2026-11-14) |
| bash 4.2 · gawk 4.0 실물 | **미검증**(bash 5.2 · gawk 5.2 에서만 실행. 4.3+ 문법 · gawk 4.2+ 기능은 쓰지 않도록 작성하고 금지 문법을 검색했습니다) |
| XFS 생성 시각(`xfs_db` 의 `v3.crtime.sec`) | **미검증**(필드 이름 기억 기반) |

시나리오: 깨끗한 서버 · 미디어 오류 뒤 같은 디스크 재포맷 · 디스크 교체 · 전송/광학/USB 오탐 · PERC 슬롯 교체 · 도구 없음 ·
압축 로그와 해 넘김 · 세 출처 중복 제거와 RHEL 8/9 · NVMe 문구 · root 아님 · 옵션 · 시리얼 없이 정황만(LVM · md · 셸 기록 · SAN LUN).

```bash
TMPDIR=/tmp bash test/run-tests.sh
```

## 처음 돌릴 때(권장 흐름)

1. 서버 한 대에 `rhel-disk-history.sh` 만 복사해 `./rhel-disk-history.sh --save-raw` 로 실행합니다.
2. 결과 파일의 `[1]`(출처 상태 · 근거 구간)과 `[7]`(명령 상태)을 먼저 봅니다. '못 읽음' · '이벤트 없음(형식이 다르거나…)' · 종료 코드가 0 이 아닌 명령이 있으면 형식이 예상과 다른 것입니다.
3. 결과 파일과 `…_raw/` 폴더를 보내 주시면 실제 출력에 맞춰 패턴을 고칩니다.
   호스트 이름 · 시리얼 · 로그 줄이 들어 있으니 필요하면 가린 뒤 보내십시오(시리얼은 앞뒤 몇 자만 남겨도 형식 대조에는 충분합니다).
4. 형식이 맞는 것을 확인한 뒤 다른 서버로 넓힙니다.
