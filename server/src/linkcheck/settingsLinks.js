/**
 * linkcheck/settingsLinks.js — **설정 등록부 전수 → 점검 대상 목록**(v2.553).
 *
 * 사용자 요청: "설정에 있는 모든 통신이 되는지 점검하고 해결책 제시하는 기능".
 *
 * ── 왜 등록부에서 '계산' 하는가(v2.552 와 같은 이유) ──────────────────────────
 * 점검 대상을 손으로 등록하게 하면 **등록을 안 한 것이 조용히 빠진다** — 그러면 "설정에 있는
 * 모든 통신 정상" 이라는 화면이 거짓이 된다. 그래서 등록부 13곳을 직접 읽어 대상을 만든다.
 * 등록부가 바뀌면 대상도 자동으로 바뀐다(손으로 맞추는 곳이 없다).
 *
 * ⚠⚠ **자격증명을 담지 않는다.** 대상 객체는 API 응답·DB·화면을 오가므로 토큰·비밀번호를
 *   넣으면 여러 경로로 샌다. 포탈 자기 토큰(`set:collector`·`set:central`)만 점검 **실행 시점**에
 *   `run.js` 가 등록부에서 직접 읽는다(v2.552 규약).
 * ⚠ **한 등록부가 예외를 던져도 나머지는 계산한다** — 손상된 파일 하나가 전 목록을 비우면
 *   화면이 '설정에 아무것도 없다' 고 말한다(거짓). 실패한 등록부는 `sourceErrors` 로 밝힌다.
 * ⚠ 읽기는 **redact 된 목록**을 쓴다(`listDevices`·`listRegistry` 등) — 비밀이 섞일 여지를
 *   구조적으로 없앤다. 비밀 유무는 `hasPassword` 류 불리언으로 온다.
 */
import { SETTING_KINDS } from './settingsKinds.js';

const t = (v) => String(v ?? '').trim();

/** `https://10.0.0.1:443/` → `{scheme,host,port}`. 실패는 `bad` 로 밝힌다(조용히 버리지 않는다). */
export function splitTarget(raw, { defaultPort = 443, defaultScheme = 'https' } = {}) {
  const s = t(raw);
  if (!s) return { bad: '주소가 비어 있습니다.' };
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
    const u = new URL(hasScheme ? s : `${defaultScheme}://${s}`);
    const scheme = u.protocol.replace(':', '').toLowerCase();
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host) return { bad: 'host 를 읽지 못했습니다.' };
    const port = u.port ? Number(u.port) : defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { bad: `포트가 올바르지 않습니다(${u.port}).` };
    return { scheme, host, port, hadScheme: hasScheme, basePath: u.pathname.replace(/\/+$/, '') };
  } catch (e) { return { bad: `주소를 해석하지 못했습니다(${String(e?.message || e).slice(0, 60)}).` }; }
}

/** 대상 id — **안정적**이어야 한다(DB 기본키이고 이력이 이어진다). */
export function targetIdOf(kind, ref) { return `${kind}|${t(ref) || '-'}`; }

/**
 * 대상 하나를 만든다. `entry` 는 등록부 원본(비밀 제거본)이고 화면·조치가 쓰는 사실만 옮긴다.
 * @returns {object|null} `bad` 가 있으면 `problem` 으로 올릴 객체
 */
function makeTarget(kind, { ref, name, address, port, agent, vcenterId, enabled = true, facts = {} }) {
  const spec = SETTING_KINDS[kind];
  if (!spec) return null;
  const tg = splitTarget(address, {
    defaultPort: port || spec.defaultPort || 443,
    defaultScheme: spec.probe.mode === 'http' || spec.probe.mode === 'tls' ? 'https' : 'tcp',
  });
  const base = {
    id: targetIdOf(kind, ref), kind, ref: t(ref),
    label: spec.label, group: spec.group, depth: spec.depth, settings: spec.settings,
    name: t(name) || t(ref), agent: t(agent), vcenterId: t(vcenterId),
    enabled: enabled !== false,
    // ⚠ 등록값을 **그대로** 싣는다(화면이 '무엇이 등록돼 있나' 를 보여줘야 조치가 가능하다).
    address: t(address),
    facts,
  };
  if (tg.bad) return { ...base, bad: tg.bad };
  // 포트 우선순위: 등록부 명시 포트 > 주소에 박힌 포트 > 종류 기본값
  const finalPort = Number.isInteger(port) && port > 0 ? port : tg.port;
  return { ...base, scheme: tg.scheme, host: tg.host, port: finalPort, hadScheme: !!tg.hadScheme, basePath: tg.basePath || '' };
}

/** 등록부 하나를 안전하게 읽는다 — 던지면 그 등록부만 비우고 사유를 남긴다. */
async function safe(label, fn, errors) {
  try { const v = await fn(); return v == null ? [] : v; }
  catch (e) { errors.push({ source: label, reason: String(e?.message || e).slice(0, 200) }); return []; }
}

/**
 * 설정 전수 → 대상 목록.
 *
 * @param {object} [deps] 테스트 주입용(각 등록부 로더). 미지정이면 실제 모듈을 지연 import 한다.
 * @returns {{targets:Array, problems:Array, sourceErrors:Array, counts:object}}
 */
export async function buildSettingsTargets(deps = {}) {
  const errors = [];
  const targets = [];
  const problems = [];
  const push = (o) => { if (!o) return; if (o.bad) problems.push({ kind: o.kind, ref: o.ref, name: o.name, address: o.address, reason: o.bad, settings: o.settings }); else targets.push(o); };

  /*
   * ⚠⚠ **export 이름이 바뀌면 조용히 빈 목록이 되게 두지 말 것.** 이 기능의 존재 이유가
   *   '등록한 대상이 조용히 빠지지 않게' 인데, 로더가 `m.listX?.() || []` 로 폴백하면
   *   모듈 이름 변경 하나로 그 등록부 전체가 **문제 없이 0건**이 된다(v2.553 초판이 실제로
   *   `relaytopo`·`gpuPhysical`·`packages` 세 곳에서 그랬다 — 소스 검사로 발견했다).
   *   그래서 **기대하는 export 이름을 명시**하고, 하나도 없으면 `sourceErrors` 로 올린다.
   */
  const load = async (key, path, fnNames, pick) => {
    if (deps[key]) return deps[key];
    return safe(key, async () => {
      const m = await import(path);
      const name = fnNames.find((n) => typeof m[n] === 'function');
      if (!name) throw new Error(`${path} 에 ${fnNames.join('/')} 중 아무 함수도 없습니다(모듈이 바뀌었습니다 — 이 등록부는 점검에서 빠집니다).`);
      return pick(m, name) ?? [];
    }, errors);
  };

  /* ── 가상화 ───────────────────────────────────────────────────────────── */
  for (const v of await load('vcenters', '../vcenter/registry.js', ['listRegistry'], (m, n) => m[n]())) {
    push(makeTarget('set:vcenter', {
      ref: t(v.id), name: t(v.name) || t(v.id), address: v.host, vcenterId: t(v.id), enabled: v.enabled !== false,
      agent: t(v.collectMode) === 'site' ? t(v.remoteAgent) : '',
      facts: { collectMode: t(v.collectMode) || 'direct', username: t(v.username), hasPassword: v.hasPassword !== false },
    }));
  }
  for (const n of await load('nsx', '../nsx/registry.js', ['listRegistry'], (m, n) => m[n]())) {
    push(makeTarget('set:nsx', {
      ref: t(n.id), name: t(n.name) || t(n.id), address: n.host, vcenterId: t(n.vcenterId), enabled: n.enabled !== false,
      facts: { username: t(n.username), hasPassword: n.hasPassword !== false, region: t(n.region) },
    }));
  }
  for (const h of await load('horizon', '../horizon/horizon.js', ['listHorizon'], (m, n) => m[n]())) {
    push(makeTarget('set:horizon', {
      ref: t(h.id), name: t(h.name) || t(h.id), address: h.host, enabled: h.enabled !== false,
      facts: { username: t(h.username), domain: t(h.domain), hasPassword: h.hasPassword !== false },
    }));
  }

  /* ── 중앙↔엣지 ───────────────────────────────────────────────────────── */
  for (const c of await load('collectors', '../collector/registry.js', ['listCollectors'], (m, n) => m[n]())) {
    push(makeTarget('set:collector', {
      ref: t(c.id), name: t(c.name) || t(c.id), address: c.url, enabled: c.enabled !== false,
      facts: { hasToken: !!(c.hasToken ?? c.token), datacenter: t(c.datacenter), vcenterId: t(c.vcenterId) },
    }));
  }
  {
    const cfg = deps.agentConfig || (await safe('central', async () => {
      const { config } = await import('../config.js');
      return { url: t(config.agent?.centralUrl), name: t(config.agent?.name), hasToken: !!config.agent?.centralToken };
    }, errors)) || {};
    const one = Array.isArray(cfg) ? cfg[0] : cfg;
    if (one && t(one.url)) {
      push(makeTarget('set:central', {
        ref: 'central', name: '중앙 포탈', address: one.url,
        facts: { agentName: t(one.name), hasToken: !!one.hasToken },
      }));
    }
  }
  for (const d of await load('deploy', '../agent/deployRegistry.js', ['listTargets'], (m, n) => m[n]())) {
    push(makeTarget('set:deploy', {
      ref: t(d.id), name: t(d.name) || t(d.host), address: d.host, port: Number(d.port) || 22, enabled: d.enabled !== false,
      facts: { username: t(d.username), hasPassword: !!d.hasPassword, hasKey: !!d.hasPrivateKey },
    }));
  }
  for (const nd of await load('relaytopo', '../relaytopo/store.js', ['loadTopology'], (m, n) => (m[n]()?.nodes || []))) {
    const addr = t(nd.publicIp) || t(nd.privateIp) || t(nd.host);
    push(makeTarget('set:relaytopo', {
      ref: t(nd.id) || addr, name: t(nd.name) || t(nd.dc) || addr, address: addr, port: Number(nd.sshPort) || 22,
      facts: { role: t(nd.role), dc: t(nd.dc), privateIp: t(nd.privateIp), publicIp: t(nd.publicIp) },
    }));
  }

  /* ── 서버 ─────────────────────────────────────────────────────────────── */
  for (const s of await load('idrac', '../idrac/registry.js', ['listRegistry'], (m, n) => m[n]())) {
    const kind = t(s.type) === 'ome' ? 'set:ome' : 'set:idrac';
    push(makeTarget(kind, {
      ref: t(s.id), name: t(s.name) || t(s.id), address: s.host, vcenterId: t(s.vcenterId), enabled: s.enabled !== false,
      agent: t(s.remoteAgent) || t(s.agent),
      facts: { type: t(s.type) || 'idrac', username: t(s.username), serviceTag: t(s.serviceTag) },
    }));
  }
  for (const b of await load('bmstor', '../bmstor/registry.js', ['listBmServers'], (m, n) => m[n]())) {
    push(makeTarget('set:bmstor', {
      ref: t(b.id), name: t(b.name) || t(b.host), address: b.host, port: Number(b.port) || 22, agent: t(b.agent), enabled: b.enabled !== false,
      facts: { username: t(b.username), hasPassword: !!b.hasPassword, mounts: Array.isArray(b.mounts) ? b.mounts.length : 0 },
    }));
  }
  for (const g of await load('gpuPhysical', '../gpu/physicalRegistry.js', ['listPhysical'], (m, n) => m[n]())) {
    push(makeTarget('set:gpu-physical', {
      ref: t(g.id), name: t(g.name) || t(g.host), address: g.host, port: Number(g.port) || 22, enabled: g.enabled !== false,
      facts: { username: t(g.username), hasPassword: !!g.hasPassword },
    }));
  }

  /* ── 스토리지 · SAN · PDU ─────────────────────────────────────────────── */
  for (const d of await load('storage', '../storage/registry.js', ['listDevices'], (m, n) => m[n]())) {
    const ssh = t(d.collectMethod) === 'ssh';
    push(makeTarget(ssh ? 'set:storage-ssh' : 'set:storage-api', {
      ref: t(d.id), name: t(d.name) || t(d.host), address: d.host, port: ssh ? (Number(d.sshPort) || 22) : 443,
      agent: t(d.agent), vcenterId: t(d.datacenterId), enabled: d.enabled !== false,
      facts: { type: t(d.type), collectMethod: t(d.collectMethod) || 'api', username: t(d.username) },
    }));
  }
  for (const d of await load('sanswitch', '../sanswitch/registry.js', ['listDevices'], (m, n) => m[n]())) {
    const rest = t(d.collectMethod) === 'rest' || t(d.collectMethod) === 'api';
    push(makeTarget(rest ? 'set:sanswitch-rest' : 'set:sanswitch-ssh', {
      ref: t(d.id), name: t(d.name) || t(d.host), address: d.host,
      port: rest ? (Number(d.httpsPort) || 443) : (Number(d.sshPort) || 22),
      agent: t(d.agent), enabled: d.enabled !== false,
      facts: { type: t(d.type), collectMethod: t(d.collectMethod) || 'ssh', username: t(d.username), vfId: d.vfId ?? null },
    }));
  }
  for (const d of await load('pdu', '../pdu/registry.js', ['listDevices'], (m, n) => m[n]())) {
    push(makeTarget('set:pdu', {
      ref: t(d.id), name: t(d.name) || t(d.host), address: d.host, agent: t(d.agent), vcenterId: t(d.datacenterId), enabled: d.enabled !== false,
      facts: { username: t(d.username), model: t(d.model) },
    }));
  }

  /* ── 원격접속 · 캡처 · 통합 계정 ───────────────────────────────────────── */
  {
    const cfg = deps.remote || (await safe('remote', async () => (await import('../proxy/registry.js')).getConfigSafe?.() || {}, errors)) || {};
    for (const p of (Array.isArray(cfg.proxies) ? cfg.proxies : [])) {
      const dp = p?.dataplane || {};
      if (t(dp.url)) {
        push(makeTarget('set:dataplane', {
          ref: t(p.id) || t(dp.url), name: t(p.name) || t(p.id), address: dp.url, enabled: p.enabled !== false,
          // ⚠ basePath 를 사실로 실어야 조치가 'v2.503 S-1 형태의 잘못된 basePath' 를 지목할 수 있다.
          facts: { basePath: t(dp.basePath), username: t(dp.username), hasPassword: !!dp.hasPassword },
        }));
      }
      if (t(p?.ssh?.host)) {
        push(makeTarget('set:remote-ssh', {
          ref: `${t(p.id) || 'proxy'}:ssh`, name: `${t(p.name) || t(p.id)} (SSH)`, address: p.ssh.host, port: Number(p.ssh.port) || 22, enabled: p.enabled !== false,
          facts: { username: t(p.ssh.username), hasPassword: !!p.ssh.hasPassword, hasKey: !!p.ssh.hasPrivateKey },
        }));
      }
    }
  }
  for (const m of await load('capture', '../net/monitor.js', ['listMonitors'], (m, n) => m[n]())) {
    const addr = t(m.host) || t(m.captureHost);
    if (!addr) continue;
    push(makeTarget('set:capture', {
      ref: t(m.id) || addr, name: t(m.name) || addr, address: addr, port: Number(m.port) || 22, enabled: m.enabled !== false,
      facts: { username: t(m.username), iface: t(m.iface) },
    }));
  }
  for (const c of await load('credentials', '../security/credentialStore.js', ['listCredentials'], (m, n) => m[n]())) {
    for (const h of (Array.isArray(c.hosts) ? c.hosts : []).slice(0, 50)) {
      if (!t(h) || /[*?]/.test(t(h))) continue;   // 와일드카드 범위는 점검 대상이 아니다
      push(makeTarget('set:credential-host', {
        ref: `${t(c.id)}:${t(h)}`, name: `${t(c.name) || t(c.id)} → ${t(h)}`, address: h, port: 22,
        facts: { credId: t(c.id), username: t(c.username) },
      }));
    }
  }

  /* ── 알림 · 인증 · 업그레이드 ──────────────────────────────────────────── */
  {
    const mail = deps.mail || (await safe('mail', async () => (await import('../mail/settings.js')).load(), errors)) || {};
    const smtp = mail?.smtp || {};
    if (t(smtp.host)) {
      push(makeTarget('set:smtp', {
        ref: 'smtp', name: 'SMTP 서버', address: smtp.host, port: Number(smtp.port) || (smtp.secure ? 465 : 25),
        enabled: mail.enabled !== false,
        facts: { secure: !!smtp.secure, user: t(smtp.user), hasPassword: !!smtp.hasPassword, from: t(smtp.from) },
      }));
    }
  }
  {
    const al = deps.alerts || (await safe('alerts', async () => (await import('../alerts.js')).loadAlertConfig(), errors)) || {};
    for (const [ch, o] of Object.entries(al?.channels || {})) {
      const url = t(o?.url);
      if (!url) continue;
      push(makeTarget('set:webhook', {
        ref: `webhook:${ch}`, name: `${ch} 웹훅`, address: url, enabled: o?.enabled !== false,
        facts: { channel: ch },
      }));
    }
  }
  {
    const ad = deps.ad || (await safe('ad', async () => (await import('../auth/ad.js')).loadAdConfig(), errors)) || {};
    if (t(ad.url)) {
      const ldaps = /^ldaps:/i.test(t(ad.url));
      push(makeTarget('set:ad', {
        ref: 'ad', name: 'AD / LDAP', address: ad.url, port: ldaps ? 636 : 389, enabled: ad.enabled !== false,
        facts: { ldaps, domain: t(ad.domain), baseDN: t(ad.baseDN) },
      }));
    }
  }
  {
    const up = deps.upgrade || (await safe('upgrade', async () => (await import('../upgrade/settings.js')).loadSettings(), errors)) || {};
    // ⚠ 필드 이름은 `remoteBase` 다(`config.js:307`). `remoteBaseUrl` 은 존재하지 않는다.
    const url = t(up.remoteBase) || t(up.remoteBaseUrl) || t(up.baseUrl);
    if (url) push(makeTarget('set:upgrade-src', { ref: 'upgrade', name: '업그레이드 원격 소스', address: url, enabled: up.enabled !== false, facts: { hasToken: !!up.remoteToken || !!up.hasToken, autoApply: !!up.autoApply } }));
  }
  {
    // ⚠ export 이름은 `getPackageSettings` 다(`loadSettings` 가 아니다 — 초판이 틀렸고 그래서
    //   패키지 저장소가 **조용히 0건**이었다). baseUrl 은 기본값이 있어 대개 비어 있지 않다.
    const pk = deps.packages || (await safe('packages', async () => {
      const m = await import('../upgrade/packageSettings.js');
      if (typeof m.getPackageSettings !== 'function') throw new Error('upgrade/packageSettings.js 에 getPackageSettings 가 없습니다(모듈이 바뀌었습니다).');
      return m.getPackageSettings();
    }, errors)) || {};
    const url = t(pk.baseUrl);
    if (url) push(makeTarget('set:package-repo', { ref: 'packages', name: '패키지 저장소', address: url, enabled: true, facts: { hasToken: !!pk.hasToken, overridden: !!pk.overridden?.baseUrl } }));
  }

  const counts = { total: targets.length, byKind: {}, byGroup: {}, byDepth: {}, disabled: 0, problems: problems.length, sourceErrors: errors.length };
  for (const x of targets) {
    counts.byKind[x.kind] = (counts.byKind[x.kind] || 0) + 1;
    counts.byGroup[x.group] = (counts.byGroup[x.group] || 0) + 1;
    counts.byDepth[x.depth] = (counts.byDepth[x.depth] || 0) + 1;
    if (!x.enabled) counts.disabled += 1;
  }
  return { targets, problems, sourceErrors: errors, counts };
}

/** 응답용 — 화이트리스트(새 필드가 들어와도 새지 않게. v2.552 `publicLink` 와 같은 규약). */
const PUBLIC_KEYS = Object.freeze(['id', 'kind', 'ref', 'label', 'group', 'depth', 'settings', 'name',
  'agent', 'vcenterId', 'enabled', 'address', 'scheme', 'host', 'port', 'hadScheme', 'basePath', 'facts']);
export function publicTarget(x = {}) {
  const out = {};
  for (const k of PUBLIC_KEYS) if (x[k] !== undefined) out[k] = x[k];
  return out;
}
