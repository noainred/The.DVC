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

/**
 * v2.932(점검 D1-01 — 재현): load-error 표지(`registryLoadError` 류)를 내보내지 않는 등록부 → 그 등록부 **파일 이름**.
 *   이 모듈들은 손상된 파일을 보존본(<파일>.corrupt.<시각>)으로 옮기고 빈 목록을 준다 — 그것을 '등록 0건' 으로 읽으면 설정 연동이
 *   그 종류의 연동 대상 전부를 '설정에서 사라짐' 으로 판정했다(vcenters.json 손상 → vCenter 대상 전부 gone → 적용하면 전부 중지).
 *   판정은 설정 메뉴 상태 배지와 같은 `settingsStatus/sources.js damaged`(파일 없음 ∧ 손상 보존본만 있음) 하나를 쓴다.
 *   ⚠ 이름이 틀리면 늘 '정상' 이다 — 각 모듈의 FILE 과 같은 문자열이어야 한다(시험이 실제 로더로 대조한다). '파일 없음 ∧ 보존본 없음' 은
 *   진짜 0건이라 보류가 아니다.
 */
export const REGISTRY_FILE_OF = Object.freeze({
  vcenters: 'vcenters.json', nsx: 'nsx.json', horizon: 'horizon.json', deploy: 'agent-deploy-targets.json',
  relaytopo: 'relay-topology.json', gpuPhysical: 'gpu-physical.json', capture: 'capture-monitors.json', credentials: 'credentials.json',
});

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
      const list = pick(m, name) ?? [];
      // v2.932(점검 D1-01): 표지 함수가 없는 모듈은 등록부 파일의 손상 보존본으로 본다(로더가 파일을 옮긴 **뒤**라야 보인다 — pick 다음).
      if (!noteLoadError(key, m)) await noteDamagedFile(key);
      return list;
    }, errors);
  };
  /*
   * v2.915(반증 M2 — 재현): 손상된 등록부는 **던지지 않고 빈 목록**을 준다(preserveCorrupt 뒤 []). 그것을 '등록 0건' 으로 읽으면 설정 연동이
   *   그 종류의 연동 대상 전부를 '설정에서 사라짐' 으로 판정했다. 모듈이 손상 상태를 알려 주면(registryLoadError 류) sourceErrors 로 올린다
   *   — 통신 점검 화면도 '못 읽음' 을 말한다(조용한 0건 금지 — 이 파일 머리말과 같은 원칙). 원문(파일 조각)은 싣지 않는다.
   */
  const LOAD_ERROR_REASON = '등록부 파일을 읽지 못했습니다(손상본을 보존했습니다) — 이 출처의 항목이 빠졌을 수 있습니다.';
  /** @returns {boolean} 모듈이 load-error 표지 함수를 갖고 있는가(있으면 그 판정이 진실 — 파일 판정을 겹쳐 보지 않는다) */
  function noteLoadError(key, m) {
    for (const fn of ['registryLoadError', 'emRegistryLoadError', 'settingsLoadError', 'isiduSettingsLoadError']) {
      if (typeof m?.[fn] !== 'function') continue;
      let bad = null;
      try { bad = m[fn](); } catch { bad = null; }
      if (bad) errors.push({ source: key, reason: LOAD_ERROR_REASON });
      return true;
    }
    return false;
  }
  let damagedFile = null;
  async function noteDamagedFile(key) {
    const file = REGISTRY_FILE_OF[key];
    if (!file) return;
    try {
      damagedFile ||= (await import('../settingsStatus/sources.js')).damaged;
      if (damagedFile(file)) errors.push({ source: key, reason: LOAD_ERROR_REASON });
    } catch (e) { console.warn(`[linkcheck] 등록부 손상 판정 실패(${key}): ${String(e?.message || e).slice(0, 120)}`); }
  }

  /* ── 가상화 ───────────────────────────────────────────────────────────── */
  /*
   * v2.915(설정 연동 — 정직 정정): vCenter 등록부(vcenter/registry.js normalize)에는 `remoteAgent` 필드가 **없다** — 예전 코드는
   *   현지 수집(site) vCenter 의 담당 엣지를 늘 빈 값으로 읽었다. 담당 엣지는 스냅샷이 관측한 push 엣지(`collectedBy`)로 보완한다
   *   (commmap/build.js 의 '등록값 → 관측값' 순서와 같다). 스냅샷을 못 읽으면 빈 값 — 지어내지 않는다.
   */
  const observedBy = new Map();
  {
    const snap = deps.snapshot !== undefined ? deps.snapshot
      : await (async () => { try { return (await import('../store.js')).store.get(); } catch { return null; } })();
    for (const sv of (Array.isArray(snap?.vcenters) ? snap.vcenters : [])) {
      if (t(sv?.id) && t(sv?.collectedBy)) observedBy.set(t(sv.id), t(sv.collectedBy));
    }
  }
  for (const v of await load('vcenters', '../vcenter/registry.js', ['listRegistry'], (m, n) => m[n]())) {
    push(makeTarget('set:vcenter', {
      ref: t(v.id), name: t(v.name) || t(v.id), address: v.host, vcenterId: t(v.id), enabled: v.enabled !== false,
      agent: t(v.collectMode) === 'site' ? (t(v.remoteAgent) || observedBy.get(t(v.id)) || '') : '',
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
    // v2.915: PDU 는 SSH 로 수집한다 — 등록된 sshPort(기본 22)를 잰다(예전에는 관리 웹 443 을 찔렀다).
    push(makeTarget('set:pdu', {
      ref: t(d.id), name: t(d.name) || t(d.host), address: d.host, port: Number(d.sshPort) || 22,
      agent: t(d.agent), vcenterId: t(d.datacenterId), enabled: d.enabled !== false,
      facts: { username: t(d.username), model: t(d.model), sshPort: Number(d.sshPort) || 22 },
    }));
  }
  /* ── v2.915(설정 연동): 카탈로그에 없던 등록부 — CVP · Veeam · Veeam EM · Bareos Director · 아이실론 직접 대상 · LLM ── */
  for (const c of await load('cvp', '../cvp/registry.js', ['listServers'], (m, n) => m[n]())) {
    push(makeTarget('set:cvp', {
      ref: t(c.id), name: t(c.name) || t(c.host), address: c.host, agent: t(c.agent), vcenterId: t(c.datacenterId), enabled: c.enabled !== false,
      facts: { authMode: t(c.authMode), hasToken: !!c.hasToken, hasPassword: !!c.hasPassword },
    }));
  }
  for (const v of await load('veeam', '../veeam/registry.js', ['listServers'], (m, n) => m[n]())) {
    const vcs = Array.isArray(v.vcenterIds) ? v.vcenterIds.map(t).filter(Boolean) : [];
    push(makeTarget('set:veeam', {
      ref: t(v.id), name: t(v.name) || t(v.host), address: v.host, port: Number(v.port) || 9419, agent: t(v.agent),
      vcenterId: vcs[0] || '', enabled: v.enabled !== false,
      facts: { vcenterIds: vcs.slice(0, 20), username: t(v.username), hasPassword: !!v.hasPassword },
    }));
  }
  for (const e of await load('veeamEm', '../veeam/em/registry.js', ['listEms'], (m, n) => m[n]())) {
    push(makeTarget('set:veeam-em', {
      ref: t(e.id), name: t(e.name) || t(e.host), address: e.host, port: Number(e.port) || 9398, agent: t(e.agent), enabled: e.enabled !== false,
      facts: { username: t(e.username), hasPassword: !!e.hasPassword },
    }));
  }
  {
    // ⚠ publicSettings(비밀 제거본)만 읽는다 — loadSettings 는 Director 비밀번호를 담는다.
    const bs = deps.bareos || (await safe('bareos', async () => {
      const m = await import('../bareos/settings.js');
      if (typeof m.publicSettings !== 'function') throw new Error('bareos/settings.js 에 publicSettings 가 없습니다(모듈이 바뀌었습니다).');
      const v = m.publicSettings();
      noteLoadError('bareos', m);
      return v;
    }, errors)) || {};
    const sites = Array.isArray(bs.sites) ? bs.sites : [];
    for (const d of (Array.isArray(bs.directors) ? bs.directors : [])) {
      if (!t(d?.host)) continue;
      const vcs = sites.filter((x) => t(x?.directorId) === t(d.id)).map((x) => t(x.vcenterId)).filter(Boolean);
      push(makeTarget('set:bareos-dir', {
        ref: t(d.id), name: t(d.name) || t(d.host), address: d.host, port: Number(d.port) || 9101, agent: t(d.agent),
        vcenterId: vcs[0] || '',
        facts: { vcenterIds: vcs.slice(0, 20), consoleName: t(d.consoleName) },
      }));
    }
  }
  {
    // 장치 연결(deviceId) 대상은 스토리지 등록부 항목과 같은 장비라 빼고, 주소를 직접 적은 대상만 싣는다(중복 측정 방지).
    const isd = deps.isidu || (await safe('isidu', async () => {
      const m = await import('../isidu/settings.js');
      if (typeof m.loadSettings !== 'function') throw new Error('isidu/settings.js 에 loadSettings 가 없습니다(모듈이 바뀌었습니다).');
      const v = m.loadSettings();
      noteLoadError('isidu', m);
      return v;
    }, errors)) || {};
    for (const x of (Array.isArray(isd.targets) ? isd.targets : [])) {
      if (!x || x.deviceId || !t(x.host)) continue;
      push(makeTarget('set:isidu-host', {
        ref: t(x.id) || t(x.host), name: t(x.label) || t(x.host), address: x.host, port: Number(x.port) || 22,
        agent: t(x.agent), vcenterId: t(x.datacenterId), enabled: x.enabled !== false,
        facts: { path: t(x.path).slice(0, 200), auth: t(x.auth) },
      }));
    }
  }
  {
    const llm = deps.llm || (await safe('llm', async () => (await import('../llm/config.js')).loadLlmConfig(), errors)) || {};
    // 꺼져 있으면 싣지 않는다 — 기본값(http://localhost:11434)이 늘 보여 '설정한 것' 처럼 읽힌다.
    if (llm.enabled === true && t(llm.url)) {
      push(makeTarget('set:llm', { ref: 'llm', name: `LLM (${t(llm.provider) || 'ollama'})`, address: llm.url, facts: { model: t(llm.model) } }));
    }
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
