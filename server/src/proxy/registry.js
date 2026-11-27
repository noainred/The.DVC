/**
 * Remote-access configuration + mapping store (CONFIG_DIR/remote-access.json).
 *
 * A "mapping" exposes one backend target (an ESXi host / server / VM reachable
 * only through the global proxy) as a public TCP port on the HAProxy proxy, so
 * users can SSH/RDP to proxyHost:publicPort. Targets may use non-standard ports
 * (entered per mapping). The HAProxy side is provisioned via the Data Plane API.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { config } from '../config.js';
import { ipBlockReason, ssrfBlockReason } from '../collector/registry.js'; // v2.537: proxyHost 차단 대역 검사 · v2.631 AX3-02: 배포 주소도
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileLoad.js';   // 76회차 F5: 읽기 오류 ≠ 손상(손상이면 reader 가 preserveCorrupt)
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js';
import { numOrNull } from '../util/numOrNull.js';
import { envPort } from '../util/envNumber.js';   // 100회차(99회차 남긴 것): 포트 env 는 1~65535 정수만(−1 · 70000 · Infinity → 기본값 — 결정 57)
import { normalizeGuacdFlags } from './guacdFlags.js';   // 48회차 F2
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로
import { registerRegistryStatus } from '../util/registryCore.js';   // 결정(76~105 남긴 것 · 2026-11-20) A1: 서비스 점검 '장비 등록부 파일' 행(표시 전용)

/**
 * v2.606(감사 WEB2606-04): 포트 칸 → 저장값. 1~65535 정수만 받고 **빈 값·숫자 아님·범위 밖은 이전 값 유지**다.
 * 예전에는 병합만 해서 칸을 비우면 0('' 도) 이 저장됐고, 사용 지점(ssh2 `port || 22`·guacd `|| 4822`)이 조용히
 * 기본 포트로 되돌렸다 — 비표준 포트(예 2222)를 쓰던 현장이 칸을 비우면 말없이 22 로 접속했다. 99999 도 그대로 저장됐다.
 */
export function portOrPrev(v, prev) {
  if (v === undefined) return prev;
  const n = numOrNull(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : prev;
}

const FILE = path.join(config.configDir, 'remote-access.json');

const DEFAULTS = {
  dataplane: {
    enabled: false,
    url: process.env.HAPROXY_DATAPLANE_URL || '', // http://proxy:5555
    basePath: process.env.HAPROXY_DATAPLANE_BASE || '/v3', // v3 (3.x) or v2 (2.x)
    username: process.env.HAPROXY_DATAPLANE_USER || '',
    password: process.env.HAPROXY_DATAPLANE_PASS || '',
    bindAddress: '*', // address HAProxy binds the public frontends on
  },
  // SSH-based auto-deploy: push generated HAProxy config to the proxy and reload
  // (alternative to the Data Plane API for environments without it).
  deploy: {
    enabled: false,
    host: process.env.PROXY_SSH_HOST || '',
    port: envPort(process.env.PROXY_SSH_PORT, 22),
    username: process.env.PROXY_SSH_USER || '',
    password: process.env.PROXY_SSH_PASS || '',
    privateKey: '', // optional PEM; takes precedence over password when set
    haproxyConfigPath: process.env.PROXY_HAPROXY_CFG || '/etc/haproxy/haproxy.cfg',
    // 보안 잔여 11-27 M1: validateCmd · reloadCmd 는 여기 두지 않는다 — 키가 없으면 기본값(호스트 운영자 env → 내장)이고, 실효 값은
    //   resolveDeployCmd 가 **호출 시각에** 정한다. 예전에는 env 를 모듈 로드 때 이 객체에 복사해 저장 한 번이 그 값을 파일에 굳혔고(출처가 사라졌다),
    //   normalizeProxy 가 모든 중계 서버 항목에 그 값을 채웠다.
  },
  proxyHost: process.env.PROXY_PUBLIC_HOST || '', // what users connect to (and the SSH gateway dials)
  publicPortBase: envPort(process.env.PROXY_PUBLIC_PORT_BASE, 20000),
  guacd: { host: process.env.GUACD_HOST || '', port: envPort(process.env.GUACD_PORT, 4822), tls: false, verifyRdpCert: false },   // 48회차 F2: tls · verifyRdpCert(guacdTransport.js)
  // Additional per-vCenter proxies. Each: { id, name, vcenterIds:[], proxyHost,
  // publicPortBase, dataplane, deploy, guacd }. A VM's vCenter selects its proxy;
  // when none matches, the top-level ("기본") proxy above is used.
  proxies: [],
  mappings: [],
};

let cache = null;

/*
 * 76회차 F5(재현 — 중간 · 데이터 손실): **읽기 오류는 손상이 아니다**(결정 G2 · util/jsonFileLoad.js 와 같은 판정). 예전 catch 하나는 EIO · EACCES · EMFILE 같은
 *   읽기 실패도 손상으로 보고 온전한 원본을 `.corrupt.<시각>` 으로 옮긴 뒤 빈 설정으로 돌았다 — 그다음 매핑 하나(quick-connect · touchMapping)가 저장되면
 *   중계 서버 목록 · 기본 중계 주소 · Data Plane/SSH 배포 자격증명 · 다른 사람의 매핑이 빠진 파일이 남았다(원본은 보존본에만 — 재현 스크립트로 확인).
 *   이제 읽기 오류면 원본을 그대로 두고 **캐시하지 않으며**(30초 간격으로 다시 읽는다 — reader) 그동안 저장(persist)은 거절한다. 손상(parse 실패 ·
 *   복호 실패)은 예전처럼 보존본으로 옮기고 빈 값이다(server/CLAUDE.md '로드 손상 preserveCorrupt').
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => openSecretsDeep(parseJsonObject(t)), tag: 'remote' }); // v2.296 자격증명 복호 · v3.17.2 객체만
let _readError = null;
let _readErrorAt = null;   // 결정 A1: 이어지는 읽기 오류는 처음 시각을 유지한다(서비스 점검의 '언제부터')
export const REGISTRY_READ_ERROR_TEXT = '원격 접속 설정 파일(remote-access.json)을 읽지 못했습니다(읽기 오류 — 손상이 아니라 원본은 그대로 둡니다). 권한 · 디스크를 확인하세요 — 그동안 원격 접속 설정 · 매핑 저장을 거절합니다.';

function load() {
  if (cache) return cache;
  const r = _reader.read();
  if (r.kind === 'read-error') {
    if (!_readError) _readErrorAt = Date.now();
    _readError = r.error;
    return buildCache({});   // 캐시하지 않는다 — 원본이 다시 읽히면 그 값으로(그동안 persist 는 거절)
  }
  _readError = null; _readErrorAt = null;
  cache = buildCache(r.kind === 'ok' ? r.value : {});   // missing · corrupt(보존본으로 옮겼다)는 빈 값 — 예전과 같다
  return cache;
}

function buildCache(saved) {
  return {
    ...DEFAULTS, ...saved,
    dataplane: { ...DEFAULTS.dataplane, ...(saved.dataplane || {}) },
    guacd: { ...DEFAULTS.guacd, ...(saved.guacd || {}) },
    proxies: Array.isArray(saved.proxies) ? saved.proxies : [],
    mappings: Array.isArray(saved.mappings) ? saved.mappings : [],
  };
}

function persist() {
  // 76회차 F5: 읽기 오류 중(cache 없음)에는 쓰지 않는다 — 빈 설정이 온전한 원본을 덮는다.
  if (_readError || !cache) { const e = new Error(REGISTRY_READ_ERROR_TEXT); e.status = 409; e.code = 'settings-unreadable'; throw e; }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(cache), null, 2), { mode: 0o600 }); // 암호화 모드면 password/privateKey 봉인(복제 — cache 평문 유지)
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
}

export function getConfig() { return load(); }
/** 79회차 반증: 읽기 오류 중인가(76 F5 — 그동안 load() 는 빈 설정을 준다). 화면 · 설정 상태가 빈 목록을 '없음' 으로 말하지 않게 표지로 쓴다. */
export function registryReadError() { load(); return _readError ? { readError: true, reason: REGISTRY_READ_ERROR_TEXT } : null; }
/*
 * 결정(76~105 남긴 것 · 2026-11-20) A1: 서비스 점검의 '장비 등록부 파일' 행에 등록한다(표시 전용 — 확정 버튼 없음). 이 등록부는 makeLoadError 가 아니라
 *   reader 의 읽기 상태(_readError)를 들고 있어 getter 로 잇는다. 읽기 오류가 선 동안만 load() 로 다시 판정한다(reader 가 30초 간격을 지킨다 —
 *   조회가 디스크를 매번 보지 않는다). 오류가 없으면 load() 를 부르지 않는다(조회가 첫 로드 · 손상 보존을 일으키지 않게).
 *   손상(보존본으로 옮김)은 이 모듈이 표지를 남기지 않는다 — 파일이 없고 보존본만 있으면 공용 목록(listRegistryLoadErrors)이 '보존본만 남음' 으로 싣는다.
 */
registerRegistryStatus({
  label: '원격 접속 설정', file: FILE,
  get: () => {
    if (_readError) load();
    if (!_readError) return null;
    const code = String(_readError?.code || 'read-error').slice(0, 32);
    return { at: _readErrorAt, readError: true, reason: `읽기 오류(${code}) — 손상이 아니라 원본은 그대로 둡니다` };
  },
});

const REDACT = '********';

/** Config with secrets redacted, for the UI. */
export function getConfigSafe() {
  const c = load();
  return {
    ...c,
    dataplane: { ...c.dataplane, password: c.dataplane.password ? REDACT : '' },
    deploy: { ...c.deploy, password: c.deploy.password ? REDACT : '', privateKey: c.deploy.privateKey ? REDACT : '' },
    // 보안 잔여 11-27 M1: 실효 검증 · 재적재 명령 · 출처 · 문법 밖 사유 — deploy **밖** 형제 칸(화면이 deploy 를 다시 보내도 저장에 섞이지 않는다 · saveConfig 는 아는 키만 본다)
    deployCommands: deployCommandsView(c.deploy),
    // ⚠ v2.503 (감사 S2, medium): `{...c}` 스프레드는 **최상위만** 가린다 — 프록시별 설정
    // (`c.proxies[].dataplane.password` · `deploy.password` · `deploy.privateKey`)은 복호된 평문
    // 그대로 응답에 실렸다. 형제 라우트 `/proxies/full` 은 이미 `redactProxy` 를 통과시킨다.
    // v2.500 D/M1(relaycheck) 과 같은 원인 — '응답을 스프레드하면 뒤에 붙인 가림이 하위를 못 덮는다'.
    // normalizeProxy 를 먼저 태운다 — 저장 파일에 dataplane/deploy 가 없는 구버전 항목이면
    // redactProxy 가 undefined 를 참조해 던진다(listProxiesSafe 와 같은 순서).
    proxies: Array.isArray(c.proxies) ? c.proxies.map(normalizeProxy).map(redactProxy) : [],
  };
}

/**
 * ⚠ 보안(v2.500 감사 H2): 저장 경로도 "접속처가 바뀌면 저장 비밀을 승계하지 않는다" 규칙을 지킨다.
 * v2.488(H-2)은 `/remote/test`·`/deploy/test` 만 고쳤는데, `PUT /api/remote/config` 로
 * `{dataplane:{url:'http://attacker:5555', password:'********'}}` 를 저장한 뒤
 * `POST /remote/proxies/:id/health` 를 부르면 저장된 Data Plane 비밀번호가 Basic 으로 그 URL 에
 * 전송됐고, deploy 쪽은 저장된 root 비번·개인키로 공격자 sshd 에 접속했다. 규칙: util/secretCarry.js.
 */
/**
 * ⚠ v2.503 (감사 S2, high) — **idKeys 는 '최종 요청 URL 을 만드는 모든 필드' 여야 한다.**
 * v2.500 은 `['url']` 만 넣었는데 실제 요청 주소는 `proxy/dataplane.js base()` 에서
 * `url + (basePath || '/v3') + '/services/haproxy'` 로 **문자열 연결**된다. 그래서
 * `{basePath: '@attacker.example/v3', password: '********'}` 로 저장하면 `accessMoved` 가 거짓이라
 * 비밀번호가 승계되고, 조립된 주소는 `http://haproxy.internal:5555@attacker.example/v3/...` 가 되어
 * **앞부분이 userinfo 로 접힌다** — 접속처가 공격자 호스트로 바뀌면서 저장된 Data Plane 비밀번호가
 * Basic 헤더로 전송된다(`new URL(...).host === 'attacker.example'` 실측 확인).
 * 새 스토어를 만들 때도 같은 기준으로 idKeys 를 고를 것: 호스트만이 아니라 **경로 조각·포트·계정 등
 * 요청 대상을 바꿀 수 있는 모든 필드**가 들어간다.
 */
// 98회차: 계정(username)도 신원이다 — 위 머리말의 '계정 등' 기준인데 빠져 있어, 계정명만 바꾼 저장 · 연결 시험이 저장 비밀번호를 다른 계정명으로 Basic 전송했다.
export const DP_ID_KEYS = ['url', 'basePath', 'username'];   // Data Plane 접속처 = url + basePath(조립 URL 전부) + 계정
export const DEPLOY_ID_KEYS = ['host', 'port', 'username']; // SSH 배포는 호스트·포트·계정(98회차: 연결 시험 routes/remote.js 도 같은 키 — export)

/**
 * Data Plane `basePath` 형식 검증(v2.503). 경로 조각이어야 하며 권한부(authority)를 열 수 없다.
 * `@`(userinfo 로 앞을 접어 호스트를 바꾼다) · `//`(스킴 상대 URL) · `?`·`#`(질의·프래그먼트) ·
 * 공백·제어문자를 거부하고 반드시 `/` 로 시작하게 한다. 빈 값은 '미지정'(기본 `/v3`).
 * 순수 함수 — 테스트로 고정한다.
 */
export function basePathIssue(v) {
  if (v === undefined || v === null || v === '') return null;   // 미지정 = 기본값 사용
  const s = String(v);
  if (s.length > 120) return 'basePath 가 너무 깁니다(120자 이내).';
  if (!s.startsWith('/')) return "basePath 는 '/' 로 시작해야 합니다.";
  if (s.startsWith('//')) return "basePath 를 '//' 로 시작할 수 없습니다(다른 호스트를 가리킵니다).";
  if (/[@?#\\]/.test(s)) return "basePath 에 '@' · '?' · '#' · '\\' 를 쓸 수 없습니다(요청 대상이 바뀝니다).";
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return 'basePath 에 공백·제어문자를 쓸 수 없습니다.';
  return null;
}

/**
 * HAProxy `bind` 주소 검증(v2.600, 감사 LO2600-06 — v2.598 INJ-02 의 형제). 이 값은 `proxy/deploy.js` 가
 * `bind ${bindAddress}:${port}` 로 **HAProxy 설정 파일에 그대로 보간**한다 — 개행이 들어가면 관리 블록 안에 임의의
 * listen 섹션이 생긴다. `*`·IPv4·IPv6(대괄호 선택)·호스트 이름 글자만 받는다. 빈 값은 '미지정'(기본 `*`). 순수 함수.
 */
export function bindAddressIssue(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (s.length > 253) return 'bindAddress 가 너무 깁니다.';
  if (s === '*') return null;
  if (/^[A-Za-z0-9.-]+$/.test(s)) return null;                 // IPv4 · 호스트 이름
  if (/^\[?[0-9A-Fa-f:.]+\]?$/.test(s) && s.includes(':')) return null; // IPv6
  return "bindAddress 는 '*' · IP 주소 · 호스트 이름만 쓸 수 있습니다(공백·제어문자·기호 불가).";
}

export function saveConfig(partial = {}) {
  const c = load();
  { const bad = deployTargetIssue(partial); if (bad) { const e = new Error(bad); e.status = 400; throw e; } } // v2.631 AX3-02
  // 보안 잔여 11-27 M1: 검증 · 재적재 명령 — 바뀌지 않은 옛 값만 예외(c.deploy = 지금 저장값)
  { const bad = deployCmdSaveIssue(partial.deploy, c.deploy); if (bad) { const e = new Error(bad); e.status = 400; throw e; } }
  if (partial.dataplane) {
    const dp = partial.dataplane;
    const bad = basePathIssue(dp.basePath) || bindAddressIssue(dp.bindAddress);
    if (bad) { const e = new Error(bad); e.status = 400; throw e; }
    const moved = accessMoved(c.dataplane, dp, DP_ID_KEYS);
    if (dp.password === REDACT) delete dp.password; // keep existing when redacted placeholder sent
    c.dataplane = { ...c.dataplane, ...dp };
    if (moved) dropCarriedSecrets(c.dataplane, dp, ['password']);
  }
  if (partial.deploy) {
    const dep = { ...partial.deploy };
    if ('port' in dep) dep.port = portOrPrev(dep.port, c.deploy?.port); // accessMoved 보다 먼저(빈 칸이 '접속처 변경' 으로 읽히지 않게)
    const moved = accessMoved(c.deploy, dep, DEPLOY_ID_KEYS);
    if (dep.password === REDACT) delete dep.password;
    if (dep.privateKey === REDACT) delete dep.privateKey;
    c.deploy = normalizeDeployCmds({ ...c.deploy, ...dep });   // 보안 잔여 11-27 M1: 빈 칸은 키 삭제(기본값을 굳히지 않는다) · 통과값은 정규형
    if (moved) dropCarriedSecrets(c.deploy, dep, ['password', 'privateKey']);
  }
  if (partial.guacd) {
    const g = { ...partial.guacd };
    if ('port' in g) g.port = portOrPrev(g.port, c.guacd?.port);
    c.guacd = normalizeGuacdFlags({ ...c.guacd, ...g });   // 48회차 F2: 불리언 칸은 true/'true' 만 켬
  }
  // v2.537: proxyHost 는 SSH 게이트웨이가 다이얼하는 주소다 — 루프백·링크로컬 거부(사용자가 접속할
  // 주소이기도 하므로 127.x 는 어차피 동작하지 않는다). 이름은 통과시킨다(접속 시 lookup 훅이 본다).
  { const bad = proxyHostIssue(partial.proxyHost); if (bad) throw new Error(bad); }
  if (partial.proxyHost !== undefined) c.proxyHost = partial.proxyHost;
  if (partial.publicPortBase !== undefined) c.publicPortBase = portOrPrev(partial.publicPortBase, c.publicPortBase);
  persist();
  return getConfigSafe();
}

/**
 * HAProxy 설정 파일 경로 검증(157회차 — 재현 · 순수). 이 값은 `proxy/deploy.js` 가 **원격 셸 명령**(`test -r` · `cp -a` · `mv` · `rm -f` · 검증 명령의 {file})에 그대로 보간한다.
 *   `/remote/deploy/test` 는 요청의 값을 **저장된 SSH 비밀번호 · 개인키**와 함께 써서, 기본 · 공유 중계 서버 설정을 바꿀 수 없는 범위 관리자(PUT /config 403)가
 *   경로 칸에 셸 문장(`/etc/hosts; <명령> #`)을 넣어 그 중계 서버에서 임의 명령을 돌리고 출력까지 받았다. 절대 경로 · 영숫자와 . _ - / 만 · 255자까지
 *   (공백 · 따옴표 · 기호 · 제어문자 불가 — server/CLAUDE.md ‘셸 명령 조립: 화이트리스트 정규식 뒤에만’). 빈 값 · 주지 않은 칸은 기본 경로를 쓰므로 통과.
 *   판정은 이 함수 하나 — 저장(deployTargetIssue) · 시험 · 배포(deploy.js)가 같이 쓴다.
 */
const HAPROXY_CFG_PATH_RE = /^\/[A-Za-z0-9._/-]{1,254}$/;
export function haproxyCfgPathIssue(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !HAPROXY_CFG_PATH_RE.test(v)) return 'HAProxy 설정 파일 경로는 ‘/’ 로 시작하는 절대 경로여야 하고 영숫자와 . _ - / 만 쓸 수 있습니다(공백 · 따옴표 · 기호 불가 · 255자까지).';
  return null;
}

/*
 * ───────── 보안 잔여 11-27 M1 — SSH 자동 배포의 검증 · 재적재 명령(판정 코어 하나) ─────────
 * deploy.js 는 이 두 명령을 **저장된 중계 서버 SSH 자격(root 일 수 있다)으로 셸에서** 돌린다. 예전에는 자유 문자열이라, 설정 소유자가 아닌 admin 이
 *   (adminOnly 라우트 — PUT /config · POST /proxies) 'curl …|sh' 를 저장하고 POST /deploy 로 화면에 가려진 root 비밀번호로 중계 서버에서 임의 명령을 돌렸다
 *   (2026-11-08 감사 axis-C C-1 · 157회차가 경로만 막고 남긴 것).
 * 신뢰는 **값을 정한 주체**로 나눈다:
 *   · 호스트 운영자 값(portal.env PROXY_VALIDATE_CMD · PROXY_RELOAD_CMD — root 소유)은 운영자 책임 — 그대로 실행한다(컨테이너 · SCL 같은 별난 현장의 탈출구).
 *   · 화면/API 로 저장 · 요청된 값은 아래 **좁은 문법**만 받고, 토큰을 다시 이은 **정규형**을 실행한다(원문을 셸로 보내지 않는다).
 * 저장(saveConfig · saveProxy) · 시험(testDeploy) · 상태 확인 · 배포(deployToProxy — 라우트 · provision · 만료 작업)가 모두 resolveDeployCmd 하나를 쓴다.
 * 문법 밖의 **이미 저장된 값**은 조용히 버리지도 실행하지도 않는다 — 파일에 그대로 두고, 배포 · 시험이 접속 전에 사유와 함께 거절하며(deployCmdRefusal),
 *   GET 응답의 deployCommands 가 그 사실을 실어 화면이 보인다. 문법이 남기는 능력은 'haproxy 설정 검증' 과 'haproxy 유닛 reload/restart' 뿐이다.
 */
export const DEPLOY_CMD_KINDS = Object.freeze(['validateCmd', 'reloadCmd']);
export const DEPLOY_CMD_BUILTIN = Object.freeze({ validateCmd: 'haproxy -c -f {file}', reloadCmd: 'systemctl reload haproxy' });
export const DEPLOY_CMD_ENV = Object.freeze({ validateCmd: 'PROXY_VALIDATE_CMD', reloadCmd: 'PROXY_RELOAD_CMD' });
export const DEPLOY_CMD_LABEL = Object.freeze({ validateCmd: '검증 명령', reloadCmd: '재적재(reload) 명령' });
/** 화면이 그대로 보이는 형식 안내(서버가 내려 준다 — 웹은 문법 · 상한을 복제하지 않는다). 백틱 금지 · 인용은 ‘ ’. */
export const DEPLOY_CMD_HELP = Object.freeze({
  validateCmd: '‘[sudo -n] haproxy -c -f {file}’ 꼴만 받습니다 — 실행 파일은 ‘haproxy’ 또는 /usr/sbin · /usr/bin · /usr/local/sbin · /usr/local/bin · /sbin · /bin 의 haproxy, /opt/rh/<이름>/root/usr/sbin/haproxy, /opt/haproxy/sbin/haproxy · 옵션은 -c(필수) · -q · -V 와 ‘-f {file}’ 한 번(순서 무관) · 추가 설정은 ‘-f /etc/haproxy/…’ 로 4개까지 · sudo 는 -n(비밀번호를 묻지 않음)으로 실행합니다. 셸 기호 · 따옴표 · 줄바꿈은 쓸 수 없습니다(300자까지).',
  reloadCmd: '‘[sudo -n] systemctl reload|restart|reload-or-restart|try-reload-or-restart <유닛>’ 또는 ‘[sudo -n] service <이름> reload|restart’ 꼴만 받습니다 — 유닛 · 이름에는 ‘haproxy’ 가 들어가야 하고(템플릿 유닛이면 ‘@’ 앞에) 영숫자와 @ . _ - 만(100자까지) · sudo 는 -n 으로 실행합니다. 셸 기호 · 따옴표 · 줄바꿈은 쓸 수 없습니다(300자까지).',
});
const DEPLOY_CMD_MAX = 300;
const DEPLOY_CMD_CHARS = /^[A-Za-z0-9 ._/@{}-]+$/;   // 길이를 먼저 자른 뒤에만 — 문자 집합 하나라 선형
const HAPROXY_BINS = new Set(['haproxy', '/usr/sbin/haproxy', '/usr/bin/haproxy', '/usr/local/sbin/haproxy', '/usr/local/bin/haproxy', '/sbin/haproxy', '/bin/haproxy', '/opt/haproxy/sbin/haproxy', '/opt/haproxy/bin/haproxy']);
const SCL_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;   // 선행 '.' 불가 — '.' · '..' 단으로 /opt/rh 밖을 가리키지 못한다
const VALIDATE_FLAGS = new Set(['-c', '-q', '-V']);
const EXTRA_CFG_MAX = 4;
const SYSTEMCTL_BINS = new Set(['systemctl', '/usr/bin/systemctl', '/bin/systemctl']);
const SERVICE_BINS = new Set(['service', '/usr/sbin/service', '/sbin/service']);
const SYSTEMCTL_VERBS = new Set(['reload', 'restart', 'reload-or-restart', 'try-reload-or-restart']);
const SERVICE_VERBS = new Set(['reload', 'restart']);
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,99}$/;   // 선행 '-' 불가(옵션 주입) · 글롭 불가

/** 호스트 운영자 값(portal.env) — **호출 시각에** 읽는다(모듈 로드 때 굳히지 않는다). 비었으면 ''. */
export function operatorDeployCmd(kind) {
  const v = process.env[DEPLOY_CMD_ENV[kind]];
  return typeof v === 'string' ? v.trim() : '';
}
function haproxyBinOk(t) {
  if (HAPROXY_BINS.has(t)) return true;
  // Red Hat SCL: /opt/rh/<이름>/root/usr/(s)bin/haproxy — 임의 /opt 경로는 받지 않는다(그 아래에 쓸 수 있는 저권한 계정 + sudo 결합 차단)
  const s = t.split('/');
  return s.length === 8 && s[0] === '' && s[1] === 'opt' && s[2] === 'rh' && SCL_SEG_RE.test(s[3]) && s[4] === 'root' && s[5] === 'usr'
    && (s[6] === 'sbin' || s[6] === 'bin') && s[7] === 'haproxy';
}
/** 추가 '-f' 설정 경로 — /etc/haproxy/ 아래만('.' · '..' · 빈 단 불가). 다른 위치(/etc/shadow · /dev/stdin)를 읽게 하는 원시 기능을 남기지 않는다. */
function extraCfgOk(p) {
  if (haproxyCfgPathIssue(p) !== null || !p.startsWith('/etc/haproxy/')) return false;
  return p.slice('/etc/haproxy/'.length).split('/').every((x, i, a) => (x !== '' || i === a.length - 1) && x !== '.' && x !== '..') && p !== '/etc/haproxy/';
}

/**
 * 순수 문법 판정. → { ok: true, canonical } | { ok: false, issue }. canonical 은 검사한 토큰을 공백 하나로 다시 이은 것(sudo 는 'sudo -n').
 * ReDoS: 길이를 먼저 자르고(300) 문자 집합 하나 · split 만 쓴다.
 */
export function parseDeployCmd(kind, s) {
  if (typeof s !== 'string') return { ok: false, issue: '글자가 아닙니다.' };
  if (s.length > DEPLOY_CMD_MAX) return { ok: false, issue: `${DEPLOY_CMD_MAX}자를 넘습니다.` };
  const t = s.trim();
  if (!t) return { ok: false, issue: '비어 있습니다.' };
  if (!DEPLOY_CMD_CHARS.test(t)) return { ok: false, issue: '쓸 수 없는 글자가 있습니다(셸 기호 · 따옴표 · 백틱 · 줄바꿈 · 탭 불가).' };
  const tk = t.split(' ').filter(Boolean);
  const pre = [];
  if (tk[0] === 'sudo') {
    tk.shift();
    if (tk[0] === '-n') tk.shift();
    if (tk[0] && tk[0].startsWith('-')) return { ok: false, issue: 'sudo 옵션은 -n 만 쓸 수 있습니다.' };
    pre.push('sudo', '-n');
  }
  if (kind === 'validateCmd') {
    const [bin, ...rest] = tk;
    if (!bin || !haproxyBinOk(bin)) return { ok: false, issue: '실행 파일이 허용된 haproxy 가 아닙니다.' };
    const seen = new Set(); let files = 0; let extra = 0;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (VALIDATE_FLAGS.has(a)) { if (seen.has(a)) return { ok: false, issue: `옵션 ${a} 가 두 번 있습니다.` }; seen.add(a); continue; }
      if (a !== '-f') return { ok: false, issue: `허용되지 않은 인자입니다(${a.slice(0, 40)}).` };
      const p = rest[i + 1]; i += 1;
      if (p === undefined) return { ok: false, issue: '-f 뒤에 파일이 없습니다.' };
      if (p === '{file}') { files += 1; continue; }
      if (!extraCfgOk(p)) return { ok: false, issue: '추가 -f 는 /etc/haproxy/ 아래 절대 경로만 쓸 수 있습니다.' };
      extra += 1;
    }
    if (!seen.has('-c')) return { ok: false, issue: '-c(검사만) 옵션이 없습니다.' };
    if (files !== 1) return { ok: false, issue: '‘-f {file}’ 가 정확히 한 번 있어야 합니다.' };
    if (extra > EXTRA_CFG_MAX) return { ok: false, issue: `추가 -f 는 ${EXTRA_CFG_MAX}개까지입니다.` };
    return { ok: true, canonical: [...pre, ...tk].join(' ') };
  }
  if (kind === 'reloadCmd') {
    if (tk.length !== 3) return { ok: false, issue: '‘systemctl <동작> <유닛>’ 또는 ‘service <이름> <동작>’ 세 낱말이어야 합니다.' };
    const [bin, a, b] = tk;
    let unit;
    if (SYSTEMCTL_BINS.has(bin)) { if (!SYSTEMCTL_VERBS.has(a)) return { ok: false, issue: `systemctl 동작은 reload · restart · reload-or-restart · try-reload-or-restart 만 쓸 수 있습니다(${a.slice(0, 40)}).` }; unit = b; }
    else if (SERVICE_BINS.has(bin)) { if (!SERVICE_VERBS.has(b)) return { ok: false, issue: `service 동작은 reload · restart 만 쓸 수 있습니다(${b.slice(0, 40)}).` }; unit = a; }
    else return { ok: false, issue: '실행 파일은 systemctl 또는 service 만 쓸 수 있습니다.' };
    // 반증 1회차 N-1: 'haproxy' 는 템플릿 이름(‘@’ 앞)에 있어야 한다 — 'getty@haproxy' · 'user@haproxy' 처럼 다른 템플릿에 인스턴스 이름만 맞춘 유닛을 받지 않는다
    if (!UNIT_RE.test(unit) || !/haproxy/i.test(unit.split('@')[0])) return { ok: false, issue: '유닛 · 이름은 영숫자로 시작하고 영숫자와 @ . _ - 만(100자까지) 쓸 수 있으며 ‘haproxy’ 가 들어가야 합니다(템플릿 유닛이면 ‘@’ 앞에).' };
    return { ok: true, canonical: [...pre, ...tk].join(' ') };
  }
  return { ok: false, issue: '알 수 없는 명령 종류입니다.' };
}

/**
 * 실효 명령 하나 — 배포 · 시험 · 화면이 부르는 **유일한** 판정. → { cmd, source: 'builtin'|'env'|'saved', stored, issue }.
 *   저장값 없음 · 빈 칸 → 운영자 env(있으면) 또는 내장 기본 · 운영자 env 와 같은 글자 → 운영자 값(신뢰) · 그 밖 → 문법(통과면 정규형, 아니면 cmd null + issue).
 */
export function resolveDeployCmd(deploy, kind) {
  const v = deploy && typeof deploy === 'object' ? deploy[kind] : undefined;
  const env = operatorDeployCmd(kind);
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    return env ? { cmd: env, source: 'env', stored: null, issue: null } : { cmd: DEPLOY_CMD_BUILTIN[kind], source: 'builtin', stored: null, issue: null };
  }
  if (typeof v !== 'string') return { cmd: null, source: 'saved', stored: null, issue: '글자가 아닙니다.' };
  if (env && v.trim() === env) return { cmd: env, source: 'env', stored: v, issue: null };
  const p = parseDeployCmd(kind, v);
  return p.ok ? { cmd: p.canonical, source: 'saved', stored: v, issue: null } : { cmd: null, source: 'saved', stored: v, issue: p.issue };
}

/** 접속 전 거절 문구(두 종류 모두 본다) 또는 null. 관리자 화면 · 배포 결과용(운영자 탈출구 안내 포함). */
export function deployCmdRefusal(deploy) {
  for (const kind of DEPLOY_CMD_KINDS) {
    const r = resolveDeployCmd(deploy, kind);
    if (r.issue) {
      return `저장된 ${DEPLOY_CMD_LABEL[kind]}이 허용 형식 밖이라 중계 서버에 접속하지 않았습니다 — ${r.issue} ${DEPLOY_CMD_HELP[kind]} 화면(설정 › 중계 서버)에서 고치거나 비워 기본값을 쓰세요. 이 형식이 꼭 필요하면 호스트 운영자가 portal.env 의 ${DEPLOY_CMD_ENV[kind]} 에 두면 그대로 실행합니다(값을 비운 모든 중계 서버에 적용).`;
    }
  }
  return null;
}
/** 철거 보류 매핑 상태(보안 잔여 11-27 M1 — proxy/provision.js): 삭제 · 만료했지만 배포 명령 거절로 HAProxy 포트를 닫지 못했다. 게이트웨이 · quick-connect 가 쓰지 않는다. */
export const MAPPING_TEARDOWN_PENDING = 'teardown-pending';
export const MAPPING_TEARDOWN_TEXT = '중계 서버의 자동 배포 설정(명령 · 설정 파일 경로)이 허용 형식 밖이라 HAProxy 포트를 닫지 못해 삭제를 보류했습니다 — 관리자가 설정 › 중계 서버에서 고치면 자동으로 정리됩니다.';
/** 접속 전 거절이 매핑 상태(소유자 — 비관리자일 수 있다)에 남길 문구 — 구성 단서(env 이름 · 명령)를 싣지 않는다. */
export const DEPLOY_CMD_MAPPING_TEXT = '중계 서버의 자동 배포 설정(명령 · 설정 파일 경로)이 허용 형식 밖이라 배포하지 않았습니다 — 관리자에게 문의하세요(설정 › 중계 서버에서 고칩니다).';
/**
 * 접속 전 설정 거절(스스로 낫지 않는 거절) 문구 또는 null — 설정 파일 경로(157회차 haproxyCfgPathIssue) · 두 명령(deployCmdRefusal) 순.
 *   반증 1회차 S-1: 경로 거절도 명령 거절과 같은 '접속 전 · 설정 문제' 라 철거 보류 · 기동 경고가 같이 본다(deploy.js 가 code 로 가른다).
 */
export function deployConfigRefusal(deploy) {
  return haproxyCfgPathIssue(deploy?.haproxyConfigPath) || deployCmdRefusal(deploy);
}

/** 화면 표시용 — { validateCmd: { value, stored, source, issue, help }, reloadCmd: {…} }. value 는 실효 명령(문법 밖이면 null). */
export function deployCommandsView(deploy) {
  const out = {};
  for (const kind of DEPLOY_CMD_KINDS) {
    const r = resolveDeployCmd(deploy, kind);
    out[kind] = { value: r.cmd, stored: typeof r.stored === 'string' ? r.stored.slice(0, 400) : null, source: r.source, issue: r.issue, help: DEPLOY_CMD_HELP[kind] };
  }
  return out;
}

/**
 * 저장 판정 — 요청에 **있는** 종류만 본다. 빈 칸 · null 은 '기본값 사용' 으로 통과. 이미 저장된 값과 같은 글자는 통과(바뀌지 않은 옛 값 —
 *   실행은 여전히 거절되고 화면에 보인다. 다른 칸 저장 · 비밀번호 교체가 막히지 않게). 그 밖은 resolveDeployCmd 의 판정(운영자 env 와 같은 글자 포함).
 */
export function deployCmdSaveIssue(incoming, prevStored) {
  if (!incoming || typeof incoming !== 'object') return null;
  for (const kind of DEPLOY_CMD_KINDS) {
    if (!(kind in incoming)) continue;
    const v = incoming[kind];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) continue;
    if (prevStored && typeof prevStored === 'object' && v === prevStored[kind]) continue;
    const r = resolveDeployCmd({ [kind]: v }, kind);
    if (r.issue) return `${DEPLOY_CMD_LABEL[kind]}: 허용 형식이 아닙니다 — ${r.issue} ${DEPLOY_CMD_HELP[kind]}`;
  }
  return null;
}

/** 저장 직전 정규화(새 객체): 빈 칸 · null → 키 삭제(기본값을 파일에 굳히지 않는다) · 문법 통과값 → 정규형 · 그 밖(운영자 값과 같은 글자 · 바뀌지 않은 옛 값)은 그대로. */
export function normalizeDeployCmds(dep) {
  const out = { ...(dep || {}) };
  for (const kind of DEPLOY_CMD_KINDS) {
    const v = out[kind];
    if (v === undefined) continue;
    if (v === null || (typeof v === 'string' && !v.trim())) { delete out[kind]; continue; }
    const r = resolveDeployCmd({ [kind]: v }, kind);
    if (r.source === 'saved' && !r.issue) out[kind] = r.cmd;
  }
  return out;
}

/**
 * v2.631(AX3-02): 저장 시점에 배포 대상 주소도 검사한다(순수 · 동기). 형제 시험 라우트(/remote/deploy/test·/remote/test)는
 *   `ipBlockReason(deploy.host)`·`ssrfBlockReasonResolved(dataplane.url)` 로 막는데, 실제 배포(deployToProxy → SSH 다이얼)와
 *   Data Plane 매핑(applyMapping → resilientFetch)은 저장값을 그대로 쓴다 — 시험 버튼을 거치지 않는 저장·직접 API 경로가 그 검사를
 *   우회했다. 비어 있으면 통과(미설정 허용). 이름(DNS)은 동기 판정이라 리터럴·loopback 이름까지만 본다(해석 결과는 시험 라우트가 본다).
 */
export function deployTargetIssue({ deploy, dataplane } = {}) {
  if (deploy) { const b = haproxyCfgPathIssue(deploy.haproxyConfigPath); if (b) return b; }   // 157회차: 셸에 보간되는 값 — 저장할 때도 같은 판정
  if (deploy && deploy.host !== undefined) {
    const h = String(deploy.host ?? '').trim();
    if (h) { const b = ipBlockReason(h); if (b) return `배포 SSH 호스트가 차단되었습니다: ${b}`; }
  }
  if (dataplane && dataplane.url !== undefined) {
    const u = String(dataplane.url ?? '').trim();
    if (u) { const b = ssrfBlockReason(u); if (b) return `Data Plane URL 이 차단되었습니다: ${b}`; }
  }
  return null;
}

/** v2.537: proxyHost 검증(순수) — 비어 있으면 통과(미설정 허용), IP 리터럴이면 차단 대역 검사. */
export function proxyHostIssue(v) {
  if (v === undefined) return null;
  const h = String(v || '').trim();
  if (!h) return null;
  const bad = ipBlockReason(h);
  return bad ? `proxyHost 거부: ${bad}` : null;
}

/* ------------------------------ proxies ------------------------------------ */

function normalizeProxy(p) {
  return {
    id: p.id, name: p.name || p.id, vcenterIds: Array.isArray(p.vcenterIds) ? p.vcenterIds : [],
    proxyHost: p.proxyHost || '', publicPortBase: Number(p.publicPortBase) || 20000,
    dataplane: { ...DEFAULTS.dataplane, ...(p.dataplane || {}) },
    deploy: { ...DEFAULTS.deploy, ...(p.deploy || {}) },
    guacd: { ...DEFAULTS.guacd, ...(p.guacd || {}) },
  };
}

// The top-level config acts as the "기본(default)" proxy.
function defaultProxy() {
  const c = load();
  return { id: 'default', name: '기본 프록시', vcenterIds: [], proxyHost: c.proxyHost, publicPortBase: c.publicPortBase, dataplane: c.dataplane, deploy: c.deploy, guacd: c.guacd };
}

export function listProxies() {
  return [defaultProxy(), ...load().proxies.map(normalizeProxy)];
}

export function getProxyById(id) {
  if (!id || id === 'default') return defaultProxy();
  const p = load().proxies.find((x) => x.id === id);
  return p ? normalizeProxy(p) : defaultProxy();
}

/**
 * 76회차 F3(재현 — 중간): 매핑이 **실제로 만들어진** 중계. 매핑의 proxyId 가 지워진 프록시를 가리키면 null 이다 — getProxyById 처럼
 *   기본 프록시로 바꿔 끼우지 않는다. 예전 게이트웨이(SSH · RDP)는 getProxyById 의 기본 프록시 폴백으로 **기본 프록시 주소 + 그 매핑의 공개 포트**에
 *   접속했는데, 공개 포트는 프록시마다 따로 매기므로(nextPublicPort) 기본 프록시에서 같은 포트는 **다른 매핑의 대상**이다 —
 *   화면은 '연결 중 <원래 대상>' 인데 다른 장비로 붙고 입력한 비밀번호(SSH · RDP 티켓)가 그쪽으로 갔다(호스트키가 관찰 모드면 막지 못한다).
 *   범위 계정은 mappingTargetScopeIssue 의 중계 대조가 이미 막았고, 전체 범위 계정(소유자 · admin)이 그대로 지났다.
 */
/** 76회차 F3: 매핑의 중계가 지워졌을 때의 문구(SSH 상태 줄 · /rdp/:id) — 게이트웨이 닫힘 사유는 'mapping-proxy-gone'(웹 remote/sshSend.js 표와 1:1). */
export const MAPPING_PROXY_GONE_TEXT = '이 접속 매핑의 중계 서버(프록시)가 삭제되어 접속하지 않았습니다 — 매핑을 지우고 다시 접속하면 지금 배정된 중계로 만들어집니다.';
export function mappingProxyOf(m) {
  const id = m?.proxyId;
  if (!id || id === 'default') return defaultProxy();
  const p = load().proxies.find((x) => x.id === id);
  return p ? normalizeProxy(p) : null;
}

/** Pick the proxy assigned to a vCenter (else the default proxy). */
export function resolveProxy(vcenterId) {
  // 165회차(163 반증): 163 이전 판이 저장해 둔 배열이 아닌 vcenterIds(수 · 객체 · 불리언)는 includes 가 없어 던졌다 — 모든 probe · quick-connect · mappings 가 500.
  //   저장은 163 이 막았고, 읽는 쪽은 includes 가 있는 모양(배열 · 예전에도 던지지 않던 글자)만 본다 — 그 밖은 배정 없음(목록의 normalizeProxy 와 같은 결과).
  //   목록 · 삭제 · 다시 저장은 예전부터 normalizeProxy 를 거쳐 열려 있었다(복구 길은 있었다 — 그때까지 전 사용자 원격 접속이 500 이던 것만 없앤다).
  const extra = load().proxies.find((p) => (Array.isArray(p.vcenterIds) || typeof p.vcenterIds === 'string') && p.vcenterIds.includes(vcenterId));
  return extra ? normalizeProxy(extra) : defaultProxy();
}

const redactProxy = (p) => ({
  ...p,
  dataplane: { ...p.dataplane, password: p.dataplane.password ? REDACT : '' },
  deploy: { ...p.deploy, password: p.deploy.password ? REDACT : '', privateKey: p.deploy.privateKey ? REDACT : '' },
  deployCommands: deployCommandsView(p.deploy),   // 보안 잔여 11-27 M1(getConfigSafe 와 같다 — deploy 밖 형제 칸)
});

export function listProxiesSafe() { return load().proxies.map(normalizeProxy).map(redactProxy); }

/**
 * 비밀 병합 — REDACT 는 '기존 유지'. 단 `idKeys`(접속처)가 바뀌면 승계하지 않는다(v2.500 H2).
 * idKeys 를 넘기지 않는 호출을 새로 만들지 말 것 — 그게 이 결함의 원래 모양이다.
 */
function mergeSecrets(target, incoming, keys, idKeys = []) {
  const moved = idKeys.length ? accessMoved(target, incoming, idKeys) : false;
  for (const k of keys) if (incoming[k] === REDACT) delete incoming[k];
  const out = { ...target, ...incoming };
  if (moved) dropCarriedSecrets(out, incoming, keys);
  return out;
}

export function saveProxy(body = {}) {
  if (!body.name && !body.id) return { ok: false, reason: '프록시 이름이 필요합니다.' };
  const c = load();
  const existing = body.id ? c.proxies.find((p) => p.id === body.id) : null;
  const base = existing || normalizeProxy({ id: crypto.randomBytes(4).toString('hex') });
  const next = { ...base };
  for (const k of ['name', 'proxyHost', 'vcenterIds']) if (body[k] !== undefined) next[k] = body[k];
  if (body.publicPortBase !== undefined) next.publicPortBase = portOrPrev(body.publicPortBase, base.publicPortBase); // v2.606 WEB2606-04
  { const bad = proxyHostIssue(body.proxyHost); if (bad) return { ok: false, reason: bad }; } // v2.537
  { const bad = deployTargetIssue(body); if (bad) return { ok: false, reason: bad }; } // v2.631 AX3-02
  { const bad = deployCmdSaveIssue(body.deploy, existing?.deploy); if (bad) return { ok: false, reason: bad }; }   // 보안 잔여 11-27 M1: 옛 값 예외는 이 항목의 원본 저장값만
  if (body.dataplane) {
    const bad = basePathIssue(body.dataplane.basePath) || bindAddressIssue(body.dataplane.bindAddress);
    if (bad) return { ok: false, reason: bad };
    next.dataplane = mergeSecrets(base.dataplane || DEFAULTS.dataplane, { ...body.dataplane }, ['password'], DP_ID_KEYS);
  }
  if (body.deploy) {
    const baseDep = base.deploy || DEFAULTS.deploy;
    const dep = { ...body.deploy };
    if ('port' in dep) dep.port = portOrPrev(dep.port, baseDep.port);
    next.deploy = normalizeDeployCmds(mergeSecrets(baseDep, dep, ['password', 'privateKey'], DEPLOY_ID_KEYS));   // 보안 잔여 11-27 M1
  }
  if (body.guacd) {
    const baseG = base.guacd || DEFAULTS.guacd;
    const g = { ...body.guacd };
    if ('port' in g) g.port = portOrPrev(g.port, baseG.port);
    next.guacd = normalizeGuacdFlags({ ...baseG, ...g });
  }
  if (existing) c.proxies = c.proxies.map((p) => (p.id === existing.id ? next : p));
  else c.proxies.push(next);
  persist();
  return { ok: true, proxy: redactProxy(normalizeProxy(next)) };
}

/**
 * 79회차(76회차 '남긴 것' 결정 — 권장안: 막는 쪽): 그 중계를 쓰는 매핑이 하나라도 있으면 삭제를 **거절**한다(409 · 매핑 목록).
 *   예전에는 지워졌고 매핑은 남아 — 게이트웨이가 기본 프록시 + 같은 공개 포트(= 다른 매핑의 대상)로 접속하거나(76 F3 이전) 접속을 거부했다(76 F3 뒤).
 *   매핑을 함께 지우는 쪽은 택하지 않았다(사람의 매핑 · HAProxy 설정을 조용히 지운다). 매핑을 먼저 지우거나 다른 중계로 옮긴 뒤 지운다.
 *   `using` 은 라우트가 요청자에게 보이는 이름만 고르도록 넘기는 원본(id · name — 응답에 그대로 싣지 말 것).
 */
export function proxyInUseReason(names = [], total = 0, { nsx = 0 } = {}) {
  const shown = names.slice(0, 10).map((n) => `‘${mappingNameText(n, 60)}’`).join(', ');
  const rest = total - Math.min(names.length, 10);
  // NSX 매핑은 NSX 수집(nsx/proxy.js ensureNsxDial)이 매니저의 중계 설정으로 다시 만든다 — 매니저 설정을 먼저 바꾸라고 말한다(지워도 되살아난다).
  const nsxNote = nsx > 0 ? ` NSX 매핑 ${nsx}개는 NSX 수집이 다시 만들므로 NSX 매니저 설정에서 이 중계를 먼저 빼세요.` : '';
  return `이 중계 서버를 쓰는 접속 매핑 ${total}개가 있어 삭제하지 않았습니다${shown ? ` — ${shown}${rest > 0 ? ` 외 ${rest}개` : ''}` : ''}. 매핑을 먼저 지운 뒤 다시 삭제하세요(지우지 않고 중계만 지우면 그 매핑으로 접속할 수 없습니다).${nsxNote}`;
}
export function removeProxy(id) {
  const c = load();
  if (!c.proxies.some((p) => p.id === id)) return { ok: false, reason: '프록시를 찾을 수 없습니다.' };
  const using = c.mappings.filter((m) => m && m.proxyId === id);
  const nsx = using.filter((m) => m.protocol === 'nsx').length;
  if (using.length) return { ok: false, code: 'proxy-in-use', status: 409, inUse: using.length, nsx, using: using.map((m) => ({ id: m.id, name: m.name })), reason: proxyInUseReason(using.map((m) => m.name), using.length, { nsx }) };
  c.proxies = c.proxies.filter((p) => p.id !== id);
  persist();
  return { ok: true };
}

/* ------------------------------ mappings ----------------------------------- */

export function listMappings() { return load().mappings; }
export function getMapping(id) { return load().mappings.find((m) => m.id === id) || null; }

// Public ports are allocated per proxy (different proxies are different hosts,
// so the same port can be reused across them).
function nextPublicPort(proxyId, base) {
  const c = load();
  const used = new Set(c.mappings.filter((m) => (m.proxyId || 'default') === proxyId).map((m) => m.publicPort));
  let p = base || 20000;
  while (used.has(p)) p++;
  return p;
}

const PROTO_PORT = { ssh: 22, rdp: 3389, nsx: 443 }; // nsx = HTTPS API(TCP 패스스루) 경유용

// 대상 호스트 형식 검증 — IP/호스트명만 허용(첫 글자 영숫자/IP). 개행·공백·셸/설정
// 메타문자를 막아 HAProxy 설정(`server target <host>:<port>`)·SSH 프로브 인젝션을 차단한다.
// (remote.js /probe의 SAFE_HOST와 동일 규칙 — 생성 경로에도 반드시 적용.)
const SAFE_TARGET_HOST = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/;

/*
 * v2.770(점검 R5-E5-4): 포트는 정수 1~65535 만 — 예전 'Number(x) || 기본' 은 70000·-1·1.5 를 그대로 저장해 HAProxy 블록에
 *   'server target 10.0.0.5:70000'·'bind *:-3' 이 들어갔고, SSH 자동배포는 프록시의 전 매핑을 한 블록으로 검증(haproxy -c)하므로
 *   그 한 줄 때문에 **그 프록시의 이후 모든 배포가 실패**했다. 대상 호스트의 ':' 는 IPv6(net.isIP===6)일 때만 허용한다 —
 *   '10.0.0.5:2222' 는 haproxyAddress(v2.603)가 IPv6 로 오인해 'ipv6@10.0.0.5:2222:22' 를 만들었다. IPv6 경로는 그대로 둔다.
 * 빈 값(undefined·null·'')은 '미지정'(기본 포트·자동 배정)이고, 값이 있는데 틀리면 NaN(거부)이다.
 */
export function mappingPortOf(v) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
  const n = numOrNull(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : NaN;
}
export function targetHostFormatIssue(targetHost) {
  const h = String(targetHost ?? '');
  if (!h) return '대상 호스트(IP)를 입력하세요.';
  if (!SAFE_TARGET_HOST.test(h) || h.length > 255) return '대상 호스트 형식이 올바르지 않습니다(IP/호스트명만, 공백·특수문자 불가).';
  if (h.includes(':') && net.isIP(h) !== 6) return '대상 호스트 형식이 올바르지 않습니다(\':\' 는 IPv6 주소에만 쓸 수 있습니다 — 포트는 포트 칸에 넣으세요).';
  return null;
}
/** 저장된 매핑이 HAProxy 블록에 들어갈 수 있는가(배포 블록 생성이 깨진 예전 매핑을 건너뛰는 데 쓴다). 사유 또는 null. */
export function mappingConfigIssue(m) {
  const hostBad = targetHostFormatIssue(m?.targetHost);
  if (hostBad) return hostBad;
  if (!(mappingPortOf(m?.targetPort) >= 1)) return `대상 포트(${String(m?.targetPort).slice(0, 20)})가 1~65535 정수가 아닙니다.`;
  if (!(mappingPortOf(m?.publicPort) >= 1)) return `공개 포트(${String(m?.publicPort).slice(0, 20)})가 1~65535 정수가 아닙니다.`;
  return null;
}

/*
 * 76회차 F2(중간 — 포탈 쪽 재현 · HAProxy 거부는 2.8.0 원문 근거): 매핑 이름은 SSH 자동 배포 블록의 주석 줄(`listen ra_<id>   # <이름>`)에 들어간다.
 *   예전에는 \r\n\t 만 지워, quick-connect(remote.access 계정)의 name 에 NUL 을 넣으면 설정 파일에 그대로 들어갔다 — HAProxy 는 줄 안의 NUL 을
 *   'Stray NUL character' 치명 오류로 거부하고(cfgparse.c readcfgfile), 배포는 그 프록시의 **전 매핑을 한 블록으로 검증**하므로 그 매핑이 남아 있는 동안
 *   그 프록시의 모든 배포(다른 사용자의 접속 포함)가 실패했다(R5-E5-4 와 같은 모양). 제어 문자는 공백으로 — 저장과 블록 생성(예전 저장본) 둘 다 이 함수를 쓴다.
 */
// eslint-disable-next-line no-control-regex
const NAME_CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
export function mappingNameText(v, max = 120) {
  return String(v ?? '').replace(NAME_CTRL_RE, ' ').slice(0, max);
}

export function addMapping({ name, vcenterId, protocol, targetHost, targetPort, publicPort, proxyId, owner, ephemeral } = {}) {
  const c = load();
  protocol = PROTO_PORT[protocol] ? protocol : 'ssh';
  {
    const tp = mappingPortOf(targetPort);
    if (Number.isNaN(tp)) return { ok: false, reason: '대상 포트는 1~65535 사이의 정수여야 합니다.' };
    targetPort = tp ?? PROTO_PORT[protocol];
  }
  targetHost = String(targetHost || '').trim();
  { const bad = targetHostFormatIssue(targetHost); if (bad) return { ok: false, reason: bad }; }
  const pubIn = mappingPortOf(publicPort);
  if (Number.isNaN(pubIn)) return { ok: false, reason: '공개 포트는 1~65535 사이의 정수여야 합니다.' };
  // 표시 이름은 HAProxy 설정 주석(`# <name>`)에 들어가므로 개행/제어문자를 제거(설정 구조 보호).
  // 76회차 F2: \r\n\t 만이 아니라 제어 문자 전부(mappingNameText — relaytopo INJ-02 와 같은 범위).
  name = name != null ? mappingNameText(name) : name;
  const proxy = proxyId ? getProxyById(proxyId) : resolveProxy(vcenterId);
  const pid = proxy.id;
  publicPort = pubIn ?? nextPublicPort(pid, proxy.publicPortBase);
  if (!(publicPort >= 1 && publicPort <= 65535)) return { ok: false, reason: `프록시 '${proxy.name}'에 배정할 공개 포트가 남아 있지 않습니다(1~65535).` };
  if (c.mappings.some((m) => (m.proxyId || 'default') === pid && m.publicPort === publicPort)) {
    return { ok: false, reason: `프록시 '${proxy.name}'에서 공개 포트 ${publicPort} 가 이미 사용 중입니다.` };
  }
  const now = new Date().toISOString();
  const m = {
    id: crypto.randomBytes(5).toString('hex'),
    name: name || `${protocol.toUpperCase()} ${targetHost}:${targetPort}`,
    vcenterId: vcenterId || '', proxyId: pid, protocol, targetHost, targetPort, publicPort,
    owner: owner || '', ephemeral: Boolean(ephemeral),
    createdAt: now, lastUsedAt: now, status: 'pending',
  };
  c.mappings.push(m);
  persist();
  return { ok: true, mapping: m };
}

/** Bump a mapping's last-used time (resets the ephemeral expiry clock). */
export function touchMapping(id) {
  const m = getMapping(id);
  if (!m) return;
  m.lastUsedAt = new Date().toISOString();
  // 76회차 F5: 사용 시각 기록 실패(읽기 오류 · 디스크)는 접속을 막지 않는다 — WS 처리기 안에서 던지면 처리기 밖 '[fatal]' 이 된다.
  try { persist(); } catch (e) { console.warn(`[remote] 매핑 사용 시각 저장 실패: ${String(e?.message || e).slice(0, 160)}`); }
}

/** Mappings visible to a user: admins see all; others only their own. */
export function listMappingsForUser(user) {
  const all = load().mappings;
  if (!user || user.role === 'admin') return all;
  // v2.478(감사 S7): 소유자 없는(레거시) 매핑은 admin 전용 — v2.313/v2.322 삭제·게이트웨이 규칙과 일치.
  if (user?.role === 'admin') return all;
  return all.filter((m) => m.owner && m.owner === user.username);
}

export function removeMapping(id) {
  const c = load();
  const before = c.mappings.length;
  c.mappings = c.mappings.filter((m) => m.id !== id);
  if (c.mappings.length === before) return { ok: false, reason: '매핑을 찾을 수 없습니다.' };
  persist();
  return { ok: true };
}

/**
 * 매핑 상태 쓰기 — 바꿨으면 true.
 * 보안 잔여 11-27 M1(반증 1회차 R-1 — 재현): 철거 보류(MAPPING_TEARDOWN_PENDING)는 **한 방향**이다. 빠져나가는 길은 철거 성공 뒤의 등록부 삭제(removeMapping) 하나뿐 —
 *   예전에는 관리자 재적용(POST /mappings/:id/apply)이 보류 매핑을 'error' 로 덮어, 소유자가 지운 매핑이 게이트웨이 접속 · quick-connect 재사용 · 다음 배포 블록으로 되살아났다.
 *   전이 판정을 호출처마다 두지 않고 여기 하나에 둔다(새 호출처가 생겨도 같은 판정).
 */
export function setMappingStatus(id, status, error) {
  const m = getMapping(id);
  if (!m) return false;
  if (m.status === MAPPING_TEARDOWN_PENDING && status !== MAPPING_TEARDOWN_PENDING) return false;
  m.status = status;
  if (error !== undefined) m.error = error;
  persist();
  return true;
}
