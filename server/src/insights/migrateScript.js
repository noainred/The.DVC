/**
 * DB 마이그레이션 **스크립트 생성기**(v2.379).
 *
 * 왜 포탈이 직접 복사하지 않는가(설계 판단):
 *  - 포탈 프로세스가 자기 DB 를 열어둔 상태에서 옮기면 WAL/SHM 이 어긋나 손상 위험이 있다.
 *  - 대용량 복사 중 포탈이 죽으면 절단본이 남고, 어디까지 됐는지 추적이 어렵다.
 *  - 무엇보다 **서비스 중단·재시작은 관리자(systemd)의 관할**이다. 포탈이 자신을 멈추고
 *    되살릴 수 없으니, 정지→복사→검증→기동을 하나의 스크립트로 만들어 관리자가 실행하는 것이
 *    가장 안전하고 되돌리기 쉽다.
 *
 * 그래서 포탈은 (1) 사전 점검, (2) **실행 스크립트 + 설명 파일 생성**, (3) 실행 방법 안내까지
 * 하고, 실제 이전은 관리자가 스크립트로 수행한다. 스크립트는 원본을 **삭제하지 않는다**.
 */

import fs from 'node:fs';
import path from 'node:path';
import { migrationInventory, defaultDbDir, dbDir, MIGRATABLE, MIGRATABLE_DIRS } from './dbLocation.js';

/** 스크립트를 저장할 디렉터리 — CONFIG_DIR/migrations (권한 0700). */
export function migrationsDir() {
  return path.join(defaultDbDir(), 'migrations');
}

const stamp = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 셸 인용 — 경로에 공백/특수문자가 있어도 안전하게. 단일 인용부호를 '\'' 로 이스케이프. */
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * bash 스크립트 본문 생성(Rocky/RHEL 계열 systemd 전제).
 * 순서: 확인 → 서비스 정지 → 복사(rsync 우선, 없으면 cp) → 체크섬 검증 → 경로 설정 파일 기록
 *       → 소유권/권한 → 안내(원본 보존, 기동은 마지막 단계에서 관리자가 확인 후)
 */
function renderBash({ srcDir, targetDir, inv, service, user, configDir, ts }) {
  const files = [];
  for (const m of MIGRATABLE) if (inv.files.some((f) => f.file === m.file)) files.push(m.file);
  const dirs = [];
  for (const m of MIGRATABLE_DIRS) if (inv.files.some((f) => f.dir === m.dir)) dirs.push(m.dir);
  const totalMB = Math.round(inv.totalBytes / 1048576);

  return `#!/usr/bin/env bash
# =============================================================================
#  VMware Global Monitoring Portal — DB 저장 경로 마이그레이션 스크립트
#  생성 시각 : ${new Date(ts).toISOString()}
#  현재 경로 : ${srcDir}
#  새  경 로 : ${targetDir}
#  대상 용량 : 약 ${totalMB} MB
#
#  ⚠ 이 스크립트는 서비스를 **정지**한 뒤 DB 를 복사합니다(원본은 지우지 않습니다).
#     정지 시간 동안 포탈 접속·수집이 중단됩니다. 유지보수 시간에 실행하세요.
#     실패하면 아무것도 바꾸지 않은 상태로 남으므로 서비스만 다시 켜면 원상 복구됩니다.
# =============================================================================
set -euo pipefail

SERVICE=${q(service)}
SRC=${q(srcDir)}
DST=${q(targetDir)}
CONFIG_DIR=${q(configDir)}
RUN_USER=${q(user)}
LOG="\${DST%/}/migration-${stamp(ts)}.log"

log() { echo "[\$(date '+%F %T')] \$*" | tee -a "\$LOG"; }

echo
echo "  현재 경로 : \$SRC"
echo "  새  경 로 : \$DST"
echo "  대상 용량 : 약 ${totalMB} MB"
echo "  서비스    : \$SERVICE (정지 후 복사 → 완료 후 수동 기동)"
echo
read -r -p "계속하려면 'yes' 를 입력하세요: " ANSWER
[ "\$ANSWER" = "yes" ] || { echo "취소했습니다."; exit 1; }

# 0) 준비 — 대상 디렉터리와 로그
mkdir -p "\$DST"
log "마이그레이션 시작 (src=\$SRC dst=\$DST)"

# 1) 여유 공간 확인(원본을 남기므로 전체 용량 + 여유 필요)
NEED_KB=\$(( ${Math.ceil(inv.totalBytes / 1024)} + ${Math.ceil(inv.totalBytes / 1024 / 10)} ))
FREE_KB=\$(df -Pk "\$DST" | awk 'NR==2 {print \$4}')
log "필요 \${NEED_KB} KB / 여유 \${FREE_KB} KB"
if [ "\$FREE_KB" -lt "\$NEED_KB" ]; then
  log "ERROR 여유 공간 부족 — 중단합니다(아무것도 변경하지 않았습니다)."
  exit 2
fi

# 2) 서비스 정지 — 열린 DB 핸들/WAL 을 안전하게 닫는다
log "서비스 정지: \$SERVICE"
systemctl stop "\$SERVICE"
sleep 2
if systemctl is-active --quiet "\$SERVICE"; then
  log "ERROR 서비스가 아직 동작 중입니다 — 중단합니다."
  exit 3
fi
log "서비스 정지 확인"

# 3) 복사 — rsync 가 있으면 사용(재시도·부분전송에 유리), 없으면 cp
COPY_OK=1
copy_one() {  # \$1=원본 \$2=대상
  if command -v rsync >/dev/null 2>&1; then rsync -a --info=progress2 "\$1" "\$2";
  else cp -a "\$1" "\$2"; fi
}
${files.map((f) => `
# ${f} (+ -wal/-shm 사이드카)
for SFX in "" "-wal" "-shm"; do
  P="\${SRC%/}/${f}\${SFX}"
  if [ -f "\$P" ]; then
    log "복사: ${f}\${SFX}"
    copy_one "\$P" "\${DST%/}/" || COPY_OK=0
  fi
done`).join('')}
${dirs.map((d) => `
# ${d}/ (vCenter별 독립 DB 디렉터리)
if [ -d "\${SRC%/}/${d}" ]; then
  log "복사: ${d}/ (디렉터리)"
  mkdir -p "\${DST%/}/${d}"
  copy_one "\${SRC%/}/${d}/" "\${DST%/}/${d}/" || COPY_OK=0
fi`).join('')}

[ "\$COPY_OK" = "1" ] || { log "ERROR 복사 중 오류 — 중단합니다. 서비스를 다시 켜면 기존 경로로 정상 동작합니다."; exit 4; }

# 4) 검증 — 파일별 SHA-256 비교(무성 절단·손상 탐지)
log "검증 시작(SHA-256)"
VERIFY_FAIL=0
verify_one() {  # \$1=원본 \$2=대상
  local a b
  a=\$(sha256sum "\$1" | awk '{print \$1}')
  b=\$(sha256sum "\$2" | awk '{print \$1}')
  if [ "\$a" != "\$b" ]; then log "  MISMATCH \$1"; VERIFY_FAIL=1; else log "  ok \$(basename "\$1")"; fi
}
${files.map((f) => `
for SFX in "" "-wal" "-shm"; do
  P="\${SRC%/}/${f}\${SFX}"
  [ -f "\$P" ] && verify_one "\$P" "\${DST%/}/${f}\${SFX}"
done`).join('')}
${dirs.map((d) => `
if [ -d "\${SRC%/}/${d}" ]; then
  while IFS= read -r -d '' P; do
    verify_one "\$P" "\${DST%/}/${d}/\$(basename "\$P")"
  done < <(find "\${SRC%/}/${d}" -maxdepth 1 -type f -print0)
fi`).join('')}

if [ "\$VERIFY_FAIL" != "0" ]; then
  log "ERROR 검증 실패 — 경로를 바꾸지 않았습니다. 서비스를 다시 켜면 기존 경로로 정상 동작합니다."
  exit 5
fi
log "검증 통과"

# 5) 소유권·권한 — 서비스 계정이 읽고 쓸 수 있게
if id "\$RUN_USER" >/dev/null 2>&1; then
  chown -R "\$RUN_USER":"\$RUN_USER" "\$DST" || log "WARN chown 실패(수동 확인 필요)"
fi
chmod 700 "\$DST" || true
find "\$DST" -maxdepth 2 -type f -name '*.db*' -exec chmod 600 {} \\; || true
log "권한 설정 완료"

# 6) 포탈 설정에 새 경로 기록 — 기동 시 이 파일을 읽어 DB 를 새 경로에서 연다
LOCFILE="\${CONFIG_DIR%/}/db-location.json"
printf '{\\n  "dbDir": "%s",\\n  "updatedAt": %s\\n}\\n' "\$DST" "\$(date +%s000)" > "\$LOCFILE"
chmod 600 "\$LOCFILE"
if id "\$RUN_USER" >/dev/null 2>&1; then chown "\$RUN_USER":"\$RUN_USER" "\$LOCFILE" || true; fi
log "경로 설정 기록: \$LOCFILE → \$DST"

echo
echo "  ============================================================"
echo "   복사·검증 완료. 이제 서비스를 시작하세요:"
echo
echo "     sudo systemctl start \$SERVICE"
echo "     sudo systemctl status \$SERVICE --no-pager"
echo
echo "   기동 후 포탈에서 [특수 기능 > 포탈 DB] 화면을 열어"
echo "   경로가 \$DST 로 바뀌었고 용량·정합성이 정상인지 확인하세요."
echo
echo "   ⚠ 원본은 지우지 않았습니다: \$SRC"
echo "     며칠 정상 운영을 확인한 뒤 직접 삭제하세요(되돌릴 필요가 있을 수 있습니다)."
echo "     되돌리기: 서비스 정지 → \$LOCFILE 삭제 → 서비스 시작"
echo "   로그: \$LOG"
echo "  ============================================================"
echo
log "스크립트 정상 종료(서비스는 수동 기동)"
`;
}

/** 설명 파일(README) 생성 — 스크립트가 무엇을 하는지·되돌리는 방법까지. */
function renderReadme({ srcDir, targetDir, inv, service, scriptName, ts }) {
  const rows = inv.files.map((f) => `| ${f.file || `${f.dir}/`} | ${f.label} | ${(f.bytes / 1048576).toFixed(1)} MB |`).join('\n');
  return `# DB 저장 경로 마이그레이션 안내

- 생성 시각: ${new Date(ts).toLocaleString('ko-KR')}
- 현재 경로: \`${srcDir}\`
- 새 경로: \`${targetDir}\`
- 대상 총 용량: **${(inv.totalBytes / 1048576).toFixed(1)} MB**
- 실행 스크립트: \`${scriptName}\`

## 왜 스크립트로 실행하나

포탈이 자기 DB 를 열어둔 상태로 옮기면 WAL/SHM 이 어긋나 손상될 수 있고, 대용량 복사 중
포탈이 죽으면 절단본이 남습니다. 무엇보다 **서비스 정지·기동은 systemd(관리자) 관할**입니다.
그래서 포탈은 사전 점검과 스크립트 생성까지만 하고, 실제 이전은 관리자가 실행합니다.

## 이 스크립트가 하는 일 (순서)

1. 확인 프롬프트(\`yes\` 입력) — 실수 실행 방지
2. 대상 여유 공간 확인(원본을 남기므로 **전체 용량 + 10%** 필요)
3. **서비스 정지** (\`systemctl stop ${service}\`) 후 실제 정지 확인
4. DB 파일 복사 — \`rsync\` 있으면 사용, 없으면 \`cp -a\`. \`-wal\`/\`-shm\` 사이드카와
   \`vmperf/\` 디렉터리(vCenter별 독립 DB)까지 포함
5. **SHA-256 검증** — 원본과 대상 해시 비교(무성 손상·절단 탐지)
6. 소유권/권한 설정(서비스 계정, DB 파일 0600)
7. 포탈 설정에 새 경로 기록 (\`db-location.json\`)
8. **서비스 기동은 하지 않습니다** — 마지막에 실행할 명령을 안내합니다

## 이전 대상

| 파일/디렉터리 | 내용 | 현재 용량 |
|---|---|---|
${rows || '| (없음) | 아직 생성된 DB 가 없습니다 | 0 MB |'}

**이전하지 않는 것**
- \`ipam.db\` — 외부 프로그램이 경로를 고정해 읽는 공유 파일입니다. 옮기면 그 연동이 조용히
  끊기므로 기본 대상에서 제외했습니다(필요하면 별도로 협의해 옮기세요).
- \`*.json\` 설정·자격증명(\`vcenters.json\`·\`users.json\` 등), \`*.ndjson\` 감사 로그 —
  용량이 작고 업그레이드·백업 절차가 이 경로를 전제로 합니다.

## 실행 방법

\`\`\`bash
# 1) 스크립트가 있는 디렉터리로 이동
cd ${path.dirname(path.join(migrationsDir(), scriptName))}

# 2) 내용을 먼저 읽어보세요(무엇을 하는지 확인)
less ${scriptName}

# 3) root 로 실행 (서비스 정지·복사·권한 변경이 필요)
sudo bash ${scriptName}

# 4) 스크립트가 안내하는 대로 서비스 시작
sudo systemctl start ${service}
sudo systemctl status ${service} --no-pager
\`\`\`

## 실패하면?

스크립트는 **실패 시 아무것도 바꾸지 않습니다**(경로 설정 파일은 검증 통과 후에만 기록).
서비스만 다시 시작하면 기존 경로로 정상 동작합니다.

\`\`\`bash
sudo systemctl start ${service}
\`\`\`

## 되돌리기(이전 완료 후에도 가능)

원본을 지우지 않았으므로 언제든 되돌릴 수 있습니다.

\`\`\`bash
sudo systemctl stop ${service}
sudo rm -f ${path.join(defaultDbDir(), 'db-location.json')}   # 경로 설정 삭제 → 기본 경로 사용
sudo systemctl start ${service}
\`\`\`

## 완료 후 확인

1. 포탈 접속 → **특수 기능 › 포탈 DB**
2. 경로가 \`${targetDir}\` 로 바뀌었는지, 용량이 이전과 비슷한지 확인
3. **DB 정합성 점검**(같은 화면) 실행 → 모두 \`ok\` 인지 확인
4. 며칠 정상 운영을 확인한 뒤 원본 삭제:
   \`\`\`bash
   # ⚠ 되돌릴 수 없습니다. 위 3단계 확인 후에만.
   sudo rm -f ${srcDir}/host-temp.db* ${srcDir}/idrac-power.db* ...
   \`\`\`
`;
}

/**
 * 스크립트 + 설명 파일 생성. 파일을 만들기만 하고 실행하지 않는다.
 * @returns { dir, scriptPath, readmePath, scriptName, inventory }
 */
export function writeMigrationScript({ targetDir, service = 'vmware-portal', user = 'vmware-portal', now = Date.now() } = {}) {
  const srcDir = dbDir() || defaultDbDir();
  const configDir = defaultDbDir();
  const inv = migrationInventory(srcDir);
  const dir = migrationsDir();
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }

  const scriptName = `migrate-db-${stamp(now)}.sh`;
  const readmeName = `migrate-db-${stamp(now)}-README.md`;
  const scriptPath = path.join(dir, scriptName);
  const readmePath = path.join(dir, readmeName);

  fs.writeFileSync(scriptPath, renderBash({ srcDir, targetDir, inv, service, user, configDir, ts: now }), { mode: 0o700 });
  fs.writeFileSync(readmePath, renderReadme({ srcDir, targetDir, inv, service, scriptName, ts: now }), { mode: 0o600 });
  return { dir, scriptPath, readmePath, scriptName, readmeName, sourceDir: srcDir, targetDir, inventory: inv };
}

/** 생성된 스크립트 목록(최근 우선) — 화면에서 다시 내려받거나 경로를 확인할 때. */
export function listMigrationScripts() {
  const dir = migrationsDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /\.(sh|md)$/.test(n)).map((n) => {
    const p = path.join(dir, n);
    let size = 0; let mtime = null;
    try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch { /* */ }
    return { name: n, path: p, sizeBytes: size, mtime, kind: n.endsWith('.sh') ? 'script' : 'readme' };
  }).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}
