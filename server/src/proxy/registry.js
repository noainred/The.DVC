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
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { accessMoved, dropCarriedSecrets } from '../util/secretCarry.js';

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
    port: Number(process.env.PROXY_SSH_PORT) || 22,
    username: process.env.PROXY_SSH_USER || '',
    password: process.env.PROXY_SSH_PASS || '',
    privateKey: '', // optional PEM; takes precedence over password when set
    haproxyConfigPath: process.env.PROXY_HAPROXY_CFG || '/etc/haproxy/haproxy.cfg',
    validateCmd: process.env.PROXY_VALIDATE_CMD || 'haproxy -c -f {file}',
    reloadCmd: process.env.PROXY_RELOAD_CMD || 'systemctl reload haproxy',
  },
  proxyHost: process.env.PROXY_PUBLIC_HOST || '', // what users connect to (and the SSH gateway dials)
  publicPortBase: Number(process.env.PROXY_PUBLIC_PORT_BASE) || 20000,
  guacd: { host: process.env.GUACD_HOST || '', port: Number(process.env.GUACD_PORT) || 4822 },
  // Additional per-vCenter proxies. Each: { id, name, vcenterIds:[], proxyHost,
  // publicPortBase, dataplane, deploy, guacd }. A VM's vCenter selects its proxy;
  // when none matches, the top-level ("기본") proxy above is used.
  proxies: [],
  mappings: [],
};

let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try { if (fs.existsSync(FILE)) saved = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch { preserveCorrupt(FILE); saved = {}; } // v2.296 dataplane/SSH 자격증명 복호 · v2.322 손상본 보존
  cache = {
    ...DEFAULTS, ...saved,
    dataplane: { ...DEFAULTS.dataplane, ...(saved.dataplane || {}) },
    guacd: { ...DEFAULTS.guacd, ...(saved.guacd || {}) },
    proxies: Array.isArray(saved.proxies) ? saved.proxies : [],
    mappings: Array.isArray(saved.mappings) ? saved.mappings : [],
  };
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(cache), null, 2), { mode: 0o600 }); // 암호화 모드면 password/privateKey 봉인(복제 — cache 평문 유지)
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
}

export function getConfig() { return load(); }

const REDACT = '********';

/** Config with secrets redacted, for the UI. */
export function getConfigSafe() {
  const c = load();
  return {
    ...c,
    dataplane: { ...c.dataplane, password: c.dataplane.password ? REDACT : '' },
    deploy: { ...c.deploy, password: c.deploy.password ? REDACT : '', privateKey: c.deploy.privateKey ? REDACT : '' },
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
const DP_ID_KEYS = ['url', 'basePath'];              // Data Plane 접속처 = url + basePath(조립 URL 전부)
const DEPLOY_ID_KEYS = ['host', 'port', 'username']; // SSH 배포는 호스트·포트·계정

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

export function saveConfig(partial = {}) {
  const c = load();
  if (partial.dataplane) {
    const dp = partial.dataplane;
    const bad = basePathIssue(dp.basePath);
    if (bad) { const e = new Error(bad); e.status = 400; throw e; }
    const moved = accessMoved(c.dataplane, dp, DP_ID_KEYS);
    if (dp.password === REDACT) delete dp.password; // keep existing when redacted placeholder sent
    c.dataplane = { ...c.dataplane, ...dp };
    if (moved) dropCarriedSecrets(c.dataplane, dp, ['password']);
  }
  if (partial.deploy) {
    const dep = { ...partial.deploy };
    const moved = accessMoved(c.deploy, dep, DEPLOY_ID_KEYS);
    if (dep.password === REDACT) delete dep.password;
    if (dep.privateKey === REDACT) delete dep.privateKey;
    c.deploy = { ...c.deploy, ...dep };
    if (moved) dropCarriedSecrets(c.deploy, dep, ['password', 'privateKey']);
  }
  if (partial.guacd) c.guacd = { ...c.guacd, ...partial.guacd };
  for (const k of ['proxyHost', 'publicPortBase']) if (partial[k] !== undefined) c[k] = partial[k];
  persist();
  return getConfigSafe();
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

/** Pick the proxy assigned to a vCenter (else the default proxy). */
export function resolveProxy(vcenterId) {
  const extra = load().proxies.find((p) => (p.vcenterIds || []).includes(vcenterId));
  return extra ? normalizeProxy(extra) : defaultProxy();
}

const redactProxy = (p) => ({
  ...p,
  dataplane: { ...p.dataplane, password: p.dataplane.password ? REDACT : '' },
  deploy: { ...p.deploy, password: p.deploy.password ? REDACT : '', privateKey: p.deploy.privateKey ? REDACT : '' },
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
  for (const k of ['name', 'proxyHost', 'publicPortBase', 'vcenterIds']) if (body[k] !== undefined) next[k] = body[k];
  if (body.dataplane) {
    const bad = basePathIssue(body.dataplane.basePath);
    if (bad) return { ok: false, reason: bad };
    next.dataplane = mergeSecrets(base.dataplane || DEFAULTS.dataplane, { ...body.dataplane }, ['password'], DP_ID_KEYS);
  }
  if (body.deploy) next.deploy = mergeSecrets(base.deploy || DEFAULTS.deploy, { ...body.deploy }, ['password', 'privateKey'], DEPLOY_ID_KEYS);
  if (body.guacd) next.guacd = { ...(base.guacd || DEFAULTS.guacd), ...body.guacd };
  if (existing) c.proxies = c.proxies.map((p) => (p.id === existing.id ? next : p));
  else c.proxies.push(next);
  persist();
  return { ok: true, proxy: redactProxy(normalizeProxy(next)) };
}

export function removeProxy(id) {
  const c = load();
  const before = c.proxies.length;
  c.proxies = c.proxies.filter((p) => p.id !== id);
  if (c.proxies.length === before) return { ok: false, reason: '프록시를 찾을 수 없습니다.' };
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

export function addMapping({ name, vcenterId, protocol, targetHost, targetPort, publicPort, proxyId, owner, ephemeral } = {}) {
  const c = load();
  protocol = PROTO_PORT[protocol] ? protocol : 'ssh';
  targetPort = Number(targetPort) || PROTO_PORT[protocol];
  targetHost = String(targetHost || '').trim();
  if (!targetHost) return { ok: false, reason: '대상 호스트(IP)를 입력하세요.' };
  if (!SAFE_TARGET_HOST.test(targetHost) || targetHost.length > 255) {
    return { ok: false, reason: '대상 호스트 형식이 올바르지 않습니다(IP/호스트명만, 공백·특수문자 불가).' };
  }
  // 표시 이름은 HAProxy 설정 주석(`# <name>`)에 들어가므로 개행/제어문자를 제거(설정 구조 보호).
  name = name != null ? String(name).replace(/[\r\n\t]/g, ' ').slice(0, 120) : name;
  const proxy = proxyId ? getProxyById(proxyId) : resolveProxy(vcenterId);
  const pid = proxy.id;
  publicPort = Number(publicPort) || nextPublicPort(pid, proxy.publicPortBase);
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
  if (m) { m.lastUsedAt = new Date().toISOString(); persist(); }
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

export function setMappingStatus(id, status, error) {
  const m = getMapping(id);
  if (!m) return;
  m.status = status;
  if (error !== undefined) m.error = error;
  persist();
}
