# 릴리스 서명(배포자 서명 검증)

> v2.730(검토 S-10). 업그레이드 번들·설치 패키지가 **우리 CI 가 만든 것**인지 설치 전에 확인한다.
> 코드: `server/src/upgrade/signatureCore.js`(형식·서명·검증 코어) · `server/src/upgrade/signature.js`(런타임 판정 하나) ·
> `server/src/upgrade/verifyCli.js`(오프라인 확인 도구) · `scripts/release-sign.mjs`(CI 서명) · `scripts/release-keygen.mjs`(키 만들기 — 사람이 실행).

## 1. 왜 필요한가

v2.729 까지 업그레이드의 무결성 검사는 **sha256** 하나였다. 그런데 sha256 은 번들과 **같은 채널**에서 온다.

- 원격 다운로드: `versions.json` 의 `sha256` 과 번들을 같은 곳(GitHub 롤링 릴리스·사내 미러)에서 받는다.
  미러나 배포 토큰을 가진 쪽은 **번들과 sha 를 함께 바꿀 수 있다.** 재현(기준 코드): 교체한 번들과 그 새 sha 를 함께
  넣으면 `downloadArchive` 가 받아들였다.
- 중앙 → 엣지 push: `X-Bundle-Sha256` 은 **같은 요청이 스스로 신고한 값**이다. 전송 중 손상만 잡는다.
- 감시 폴더·수동 업로드·오프라인 패키지: 검사할 기준값 자체가 없었다.

sha256 은 '전송 중 손상' 을 잡을 뿐 **누가 만들었는지**를 증명하지 않는다. 그래서 CI 가 보호된 배포 키(Ed25519)로
산출물 목록(manifest)에 서명하고, 수신측은 **미리 고정된 신뢰 공개키**로 설치 전에 검증한다.
SHA 검사·아카이브 경로 검증·크기 상한은 그대로 남는다(서명은 그 위에 더하는 것이다).

## 2. manifest 형식

파일 이름: `vmware-portal-<버전>.manifest.json` — 버전마다 하나이고 그 버전의 **모든 산출물**을 담는다.
릴리스 자산(`downloads` 롤링 릴리스)에 패키지와 함께 올라가고, `versions.json` 의 그 버전 항목에 `manifest` 필드로 이름이 적힌다.

봉투(envelope):

```json
{ "format": "vmware-portal-release-manifest", "v": 1, "alg": "ed25519",
  "keyId": "ed25519:<16hex>",
  "payload": "<base64(JSON 바이트)>",
  "signature": "<base64(Ed25519 서명 64바이트)>" }
```

payload JSON:

```json
{ "format": "vmware-portal-release-manifest", "v": 1, "product": "vmware-portal",
  "version": "2.730.0", "createdAt": "2026-10-09T…Z", "keyId": "ed25519:<16hex>",
  "files": [ { "name": "vmware-portal-2.730.0.tar.gz", "kind": "bundle", "platform": "any", "size": 123, "sha256": "…" } ] }
```

- 서명 대상은 **payload 바이트 그대로**다(JSON 을 다시 직렬화하지 않는다 — 정규화 차이로 서명이 깨지지 않게).
- `kind`: `bundle`(업그레이드 번들) · `installer`(el9 설치 패키지) · `installer_cent9` · `windows` · `other`.
  `platform` 은 정보용이다(판정에 쓰지 않는다).
- 봉투 상한 64KB · 파일 64개.
- **keyId** = 공개키(SPKI DER)의 sha256 앞 16자리(`ed25519:` 접두). 키 파일에 적힌 keyId 가 공개키에서 계산한 값과 다르면
  그 항목을 버린다 — 이름표만 바꿔 다른 키를 그 이름으로 믿게 만들 수 없다.

## 3. 신뢰 공개키(고정)

| 출처 | 위치 | 누가 바꾸나 |
|---|---|---|
| ① 저장소 파일 | `server/src/upgrade/release-signing-keys.json` | 커밋·릴리스(번들과 함께 배포된다) |
| ② 호스트 파일(선택) | `CONFIG_DIR/release-signing-keys.conf` (기본 `/etc/vmware-portal/`) | 호스트 관리자(root) |

```json
{ "format": "vmware-portal-release-keys", "schema": 1,
  "keys": [ { "keyId": "ed25519:<16hex>", "publicKey": "<base64(SPKI DER)>", "addedAt": "2026-10-09",
              "note": "2026 배포 키", "revoked": false, "revokedAt": null, "revokedReason": "" } ],
  "revoked": [ "ed25519:<16hex>" ] }
```

- 두 출처의 키는 **합집합**이다. **회수(revoked)는 어느 출처든 이긴다** — 호스트 파일이 저장소 키를 회수할 수 있고,
  저장소가 회수한 키를 호스트 파일이 되살릴 수 없다. `revoked` 배열은 공개키 없이 회수만 적는 목록이다.
- 호스트 파일의 확장자가 `.conf` 인 이유: 백업 복원·엣지 설정 push 는 `.json`/`.env` 만 쓴다 — **웹 화면 경로로 신뢰 키를
  늘릴 수 없게** 했다. 그룹·기타 쓰기 권한이 있으면(`chmod` 600/640 이 아니면) 읽지 않고 검증을 멈춘다.
- 호스트 파일이 **있는데** 읽지 못하면(형식 오류·권한) 회수 목록을 알 수 없으므로 검증을 진행하지 않는다(fail-closed).
- 개인키는 **어디에도 없다** — 저장소·번들·엣지·로그·화면 어디에도. CI 비밀 `RELEASE_SIGNING_KEY` 에만 있다.

## 4. 수신측 판정(모든 경로가 같은 함수)

`decideSignature`(server/src/upgrade/signature.js) 하나를 다음 경로가 전부 쓴다.

| 경로 | where(화면 표기) |
|---|---|
| 원격 다운로드(GitHub·사내 미러·중앙 `/dl`) — 큰 번들을 받기 **전에** manifest 를 먼저 받아 사전 확인 | `remote-preflight` · `remote` |
| 중앙 → 엣지 push(`/api/upgrade/bundle`) — manifest 는 `X-Bundle-Manifest` 헤더(base64) | `push-edge` |
| 중앙 → 수집기 push(`/api/collector/upgrade`) | `push-collector` |
| 감시 폴더 · 수동 업로드(번들 옆 같은 폴더의 manifest) | `watch` |
| 엣지 배포용 번들 준비(감시 폴더·원격) | `bundle-source` |
| 설치 패키지 받기(에이전트 배포용) | `package` |
| 오프라인 확인 도구(`vmware-portal-verify`·install.sh) | `offline` |

판정 순서와 결과:

1. 신뢰 키 파일을 못 읽음 → **확인할 수 없음**(`trust-unreadable`)
2. manifest 없음 / 받아 오지 못함 → **확인할 수 없음**(`manifest-missing` · `manifest-unavailable`)
3. 봉투·서명 검증: 형식 오류(`manifest-malformed`) · 서명 불일치(`bad-signature`) · **회수된 키**(`revoked-key`) → **거부**.
   모르는 키 → **확인할 수 없음**(`unknown-key`, 쓸 수 있는 신뢰 키가 0개면 `no-trusted-keys`).
4. 산출물 대조 — manifest 의 버전이 **설치하려는 버전과 같아야** 하고(`version-mismatch`), 그 파일이 목록에 있고(`file-not-in-manifest`),
   종류·크기·sha256 이 같아야 한다(`kind-mismatch` · `size-mismatch` · `sha-mismatch`). 다르면 **거부**.
5. 번들을 푼 뒤 그 안의 `package.json` 버전이 서명된 버전과 같아야 한다(`content-version-mismatch` — **거부**).

- **거부**(확인했더니 틀림)는 정책과 무관하게 언제나 설치하지 않는다.
- **확인할 수 없음**은 정책 `require`(기본)면 설치하지 않고, `warn` 이면 경고를 남기고 진행한다.
- 거부·보류 사유는 업그레이드 상태(`/upgrade/status` 의 `signature.last`)·적용 결과·콘솔에 남는다. 사유에 자격증명을 싣지 않는다.

### 롤백·재사용 방지

- manifest 버전 = 요청·설치하려는 버전(4) + 번들 안 버전 = 서명 버전(5) — 옛 버전의 정상 서명을 새 버전 이름으로 다시 쓸 수 없다.
- 파일 이름·sha 로 묶여 있어 같은 버전의 다른 파일(예: 설치 패키지)의 서명을 번들에 쓸 수 없다.
- 자동 업그레이드는 원래대로 **더 새 버전만** 적용한다. 옛 버전의 정상 서명 번들을 다시 밀어 넣어도 '최신' 이라 적용하지 않는다
  (`push` 의 `force` 는 같은 버전 재설치만 허용한다 — 낮은 버전은 여전히 거부).

## 5. 정책과 비상 탈출구

| 값(호스트 `portal.env`) | 동작 |
|---|---|
| (없음) · `require` | **서명 필수**(기본). 확인할 수 없으면 설치하지 않는다 |
| `warn` | 확인할 수 없어도 경고 후 설치. **확인했더니 틀린 것은 여전히 거부** |
| 그 밖의 값 | 필수로 본다(화면이 '알 수 없는 설정값' 이라 말한다 — 조용히 약해지지 않게) |

```bash
# 비상시에만 — 서명 없는 소스(서명 도입 이전 번들·내부 빌드)를 한 번 설치해야 할 때
echo 'UPGRADE_SIGNATURE_POLICY=warn' | sudo tee -a /etc/vmware-portal/portal.env
sudo systemctl restart vmware-portal
# 끝나면 그 줄을 지우고 다시 재시작한다
```

- 이 값은 **웹 화면에서 바꿀 수 없다**(호스트 관리자만). 화면 '업그레이드 › 릴리스 서명' 칸은 정책·신뢰 공개키 수·마지막 검증 결과를
  보여 주기만 한다.
- `warn` 은 '서명이 없는 소스' 를 위한 것이지 '틀린 서명을 받기' 위한 것이 아니다.

## 6. 처음 설정하기(사용자가 한 번 — 이 절차 전에는 릴리스가 실패한다)

> ⚠ **v2.730 부터 release 워크플로는 서명 준비가 안 되어 있으면 빌드 전에 실패한다** — 저장소 공개키 목록이 비어 있거나
> 비밀 `RELEASE_SIGNING_KEY` 가 없으면 `Check release signing prerequisites` 단계가 `::error::` 와 함께 멈춘다.
> 공개키 없이 게시된 버전은 '서명 필수' 기본값 때문에 **다음 버전을 영원히 받지 못하므로**(수동 재설치로만 복구) 일부러 막았다.

1. **신뢰하는 PC(저장소 밖)에서 키를 만든다** — Node 22 가 있는 곳:

   ```bash
   git clone https://github.com/noainred/The.DVC.git && cd The.DVC
   node scripts/release-keygen.mjs --note "2026 배포 키" --add-to server/src/upgrade/release-signing-keys.json
   ```

   - 개인키는 `~/.vmware-portal-release-keys/release-signing-<16hex>.key.pem`(권한 0600)에 생긴다.
     **git 작업 트리 안에는 쓰지 않는다**(스크립트가 거부한다). 개인키 내용은 화면에 출력하지 않는다.
   - `--add-to` 를 주면 공개키 항목이 저장소 키 파일에 추가된다(공개키만).

2. **공개키 커밋** — `server/src/upgrade/release-signing-keys.json` 의 변경을 커밋·PR 해 main 에 넣는다.

3. **GitHub 비밀 등록** — 저장소 Settings › Secrets and variables › Actions › New repository secret:
   이름 `RELEASE_SIGNING_KEY`, 값 = 개인키 PEM 파일 내용 전체(`-----BEGIN PRIVATE KEY-----` 부터). gh CLI 가 있으면:

   ```bash
   gh secret set RELEASE_SIGNING_KEY < ~/.vmware-portal-release-keys/release-signing-<16hex>.key.pem
   ```

   PEM 원문 대신 그 base64 를 넣어도 된다.

4. **백업** — 개인키 파일을 오프라인 매체(암호화된 USB 등) 두 곳에 보관하고, 등록이 끝나면 PC 에서 지우는 것을 권장한다.
   개인키를 잃으면 새 키로 바꿀 때 **옛 키로 서명할 수 없다**(7절 — 현장마다 호스트 파일로 새 키를 넣어야 한다).

5. **확인** — release 워크플로를 돌리면 `Check release signing prerequisites` 가 `릴리스 서명 사전 점검 통과 — 서명 키 ed25519:… ·
   신뢰 공개키 1개` 를 출력하고, `Sign release manifest` 가 manifest 를 만든 직후 같은 검증 코드로 다시 검증한다.

### CI 가 하는 일

1. `node scripts/release-sign.mjs --check` — 빌드 전 사전 점검: 공개키 목록에 쓸 수 있는 키가 있는가 · 비밀이 있는가 ·
   비밀 개인키의 keyId 가 목록에 있고 회수되지 않았는가.
2. 산출물·sha256 사이드카를 만든 뒤 `node scripts/release-sign.mjs --version <버전> --dist dist-offline` — 필수 4종
   (번들·el9·cent9·windows)이 없으면 실패, 서명 후 자기 검증.
3. `REQUIRE_MANIFEST=1` 로 `versions.json` 을 만든다 — manifest 없는 버전을 목록에 올리지 않는다.
4. 패키지와 manifest 를 먼저 올리고 `versions.json` 을 마지막에 올린다(기존 순서 그대로). prune 은 파일 이름의 버전으로 manifest 도 함께 정리한다.

비밀은 사전 점검·서명 두 단계에만 넘기고 잡 전체 env 에 두지 않는다(빌드·테스트 단계가 읽을 수 없게).

## 7. 키 교체(rotation)

1. 새 키를 만든다(6-1). `--add-to` 로 **새 공개키를 기존 키와 함께** 저장소 파일에 둔다(옛 키를 아직 지우지 않는다).
2. 그 커밋을 담은 릴리스를 **옛 키로** 서명해 내보낸다(비밀 `RELEASE_SIGNING_KEY` 는 아직 옛 키).
   이 릴리스를 설치한 현장은 다음부터 새 키를 믿는다.
3. 현장들이 2의 버전으로 올라간 것을 확인한 뒤 비밀을 새 키로 바꾼다. 이후 릴리스는 새 키로 서명된다.
4. 옛 키는 목록에 `"revoked": true`(+ `revokedAt`·`revokedReason`)로 남기거나 지운다 — 유출이 의심되면 **회수**로 남겨야
   옛 키로 서명한 번들이 거부된다.

2를 건너뛰고 비밀만 바꾸면, 새 키를 모르는 현장은 그 릴리스를 `unknown-key`(확인할 수 없음)로 설치하지 않는다.
그때는 현장마다 호스트 파일 `release-signing-keys.conf` 에 새 공개키를 넣거나, 한 번 `warn` 으로 설치한다.

## 8. 키 회수(revocation)

- 유출이 의심되면 즉시: ① 새 키로 교체(7절) ② 저장소 파일에서 그 키를 `revoked: true` 로 표시한 릴리스를 새 키로 서명해 게시.
- 그 릴리스를 아직 받지 않은 현장은 호스트 파일로 바로 회수할 수 있다:

  ```bash
  sudo tee /etc/vmware-portal/release-signing-keys.conf >/dev/null <<'EOF'
  { "format": "vmware-portal-release-keys", "schema": 1, "keys": [], "revoked": ["ed25519:<회수할 keyId>"] }
  EOF
  sudo chmod 600 /etc/vmware-portal/release-signing-keys.conf
  ```

  파일은 매 검증마다 다시 읽으므로 재시작이 필요 없다.

## 9. 오프라인 패키지

**권장 절차 — 패키지를 풀기 전에, 이미 설치된(신뢰하는) 포탈의 도구로 확인한다**:

```bash
# 릴리스 자산에서 패키지와 manifest 를 함께 받는다
#   vmware-portal-offline-<버전>-el9-x64.tar.gz
#   vmware-portal-<버전>.manifest.json
sudo vmware-portal-verify --file vmware-portal-offline-<버전>-el9-x64.tar.gz --manifest vmware-portal-<버전>.manifest.json
#   (링크가 없으면) sudo /opt/vmware-portal/app/release-verify.sh --file … --manifest …
```

종료 코드: `0` 확인됨 · `1` 확인했더니 틀림(**설치하지 말 것**) · `2` 확인할 수 없음(신뢰 키·manifest 없음) · `3` 사용법 오류.
`--json` 을 주면 결과를 한 줄 JSON 으로 낸다.

**install.sh 의 자동 확인**: 기존 설치본 위에 다시 설치(업그레이드)하면 install.sh 가 **아무것도 바꾸기 전에** 기존 설치본의
Node·확인 도구·신뢰 키로 패키지 파일과 manifest 를 확인한다. 기본 위치는 압축을 푼 폴더 옆의 `<패키지>.tar.gz` 와
`vmware-portal-<버전>.manifest.json` 이고, 다르면 `--package <파일> --manifest <파일>` 로 지정한다.
확인에 실패하거나 파일을 찾지 못하면 설치를 멈춘다. 확인 없이 진행하려면 `--skip-signature-check`(권장하지 않음 — 경고를 남긴다).

⚠ 정직한 한계: install.sh 는 **새 패키지 안의** 스크립트다. 패키지 자체를 바꾼 공격자는 install.sh 도 바꿀 수 있으므로,
install.sh 의 자동 확인은 '잘못 받은 패키지'·'보관 중 손상' 을 잡는 두 번째 그물이다. 배포자 확인은 위의 권장 절차(풀기 전,
기존 설치본의 도구)로 해야 뜻이 있다.

- **에이전트 원격 배포**(설정 › 에이전트 배포)도 원격 호스트에서 이 install.sh 를 실행한다. 그 호스트에 v2.730 이상이 이미 설치돼
  있으면 install.sh 가 서명 확인을 요구하므로, 중앙 패키지 폴더에 **패키지와 같은 버전의 manifest** 가 있어야 하고 배포가
  패키지를 **원래 파일 이름 그대로** manifest 와 함께 올려 `--package`·`--manifest` 로 넘겨야 한다(확인 도구는 파일 이름으로
  manifest 항목을 찾는다 — 이름을 바꿔 올리면 거부된다). '설치 패키지 받기' 는 manifest 를 함께 받아 둔다.
- 신규 설치(기존 설치본 없음)는 호스트에 신뢰 기준이 없다 — 패키지 안의 도구로 무결성만 확인하고, 그것도 할 수 없으면 안내만 하고 진행한다.
  배포자 확인이 필요하면 신뢰하는 다른 서버의 `vmware-portal-verify` 로 먼저 확인한다.
- v2.730 이전 설치본에는 확인 도구가 없다(첫 v2.730 설치는 무결성만 확인된다).

## 10. 정직한 한계

- **v2.730 이전 설치본은 서명을 확인하지 않는다** — 그 코드에는 검증이 없다. v2.730 으로 올라간 다음부터 보호된다.
- 저장소 공개키 목록이 비어 있는 동안은 CI 가 게시를 막는다(6절). 목록이 빈 채로 게시하는 우회를 만들지 말 것.
- 백업 복원으로 `portal.env` 의 `UPGRADE_SIGNATURE_POLICY` 가 바뀔 수 있는지는 백업 모듈의 규칙에 달려 있다(이 기능 범위 밖 — 리드 확인 사항).
- Windows 패키지(zip)는 manifest 에 서명돼 있지만, Windows 쪽 자동 확인 도구는 만들지 않았다(`verifyCli.js` 를 Node 로 직접 실행하면 확인할 수 있다).
- 실제 GitHub 릴리스·실장비 엣지로는 확인하지 않았다 — 검증은 가짜 HTTP 서버·임시 키(`crypto.generateKeyPairSync('ed25519')`)로 했다.
