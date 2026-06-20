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
  mappings: [],
};

let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try { if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { saved = {}; }
  cache = {
    ...DEFAULTS, ...saved,
    dataplane: { ...DEFAULTS.dataplane, ...(saved.dataplane || {}) },
    guacd: { ...DEFAULTS.guacd, ...(saved.guacd || {}) },
    mappings: Array.isArray(saved.mappings) ? saved.mappings : [],
  };
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
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
  };
}

export function saveConfig(partial = {}) {
  const c = load();
  if (partial.dataplane) {
    const dp = partial.dataplane;
    if (dp.password === REDACT) delete dp.password; // keep existing when redacted placeholder sent
    c.dataplane = { ...c.dataplane, ...dp };
  }
  if (partial.deploy) {
    const dep = { ...partial.deploy };
    if (dep.password === REDACT) delete dep.password;
    if (dep.privateKey === REDACT) delete dep.privateKey;
    c.deploy = { ...c.deploy, ...dep };
  }
  if (partial.guacd) c.guacd = { ...c.guacd, ...partial.guacd };
  for (const k of ['proxyHost', 'publicPortBase']) if (partial[k] !== undefined) c[k] = partial[k];
  persist();
  return getConfigSafe();
}

export function listMappings() { return load().mappings; }
export function getMapping(id) { return load().mappings.find((m) => m.id === id) || null; }

function nextPublicPort() {
  const c = load();
  const used = new Set(c.mappings.map((m) => m.publicPort));
  let p = c.publicPortBase;
  while (used.has(p)) p++;
  return p;
}

export function addMapping({ name, vcenterId, protocol, targetHost, targetPort, publicPort } = {}) {
  const c = load();
  protocol = protocol === 'rdp' ? 'rdp' : 'ssh';
  targetPort = Number(targetPort) || (protocol === 'rdp' ? 3389 : 22);
  if (!targetHost) return { ok: false, reason: '대상 호스트(IP)를 입력하세요.' };
  publicPort = Number(publicPort) || nextPublicPort();
  if (c.mappings.some((m) => m.publicPort === publicPort)) return { ok: false, reason: `공개 포트 ${publicPort} 가 이미 사용 중입니다.` };
  const m = {
    id: crypto.randomBytes(5).toString('hex'),
    name: name || `${protocol.toUpperCase()} ${targetHost}:${targetPort}`,
    vcenterId: vcenterId || '', protocol, targetHost, targetPort, publicPort,
    createdAt: new Date().toISOString(), status: 'pending',
  };
  c.mappings.push(m);
  persist();
  return { ok: true, mapping: m };
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
