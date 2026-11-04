/**
 * bareos/install/targets.js — 완전 설치 대상 표(v2.844): vCenter(법인)마다 엣지 노드 · 배포 등록부 SSH 계정 · 엣지 응답 · Director 등록 여부.
 *
 * 법인 · vCenter · Bareos 는 1:1:1(루트 CLAUDE.md) — 행 하나 = vCenter 하나.
 *  - 엣지: 그 vCenter 의 인벤토리를 올리는 엣지(listInventory().agent — Veeam·Bareos 설정 화면과 같은 출처) · 응답 = 마지막 인벤토리 수신 시각과
 *    그 엣지의 마지막 인증된 중앙 요청(v2.849 central/agentContact.js) 중 최근 값.
 *  - SSH: 배포 등록부(agent-deploy-targets.json)에서 agentName 이 그 엣지인 항목. 비밀번호(또는 키)가 저장돼 있어야 한다(다시 묻지 않는다).
 *  - Director: 그 vCenter 의 매핑(sites)이 가리키는 Director. 있으면 '초기화 후 재설치' — 단 Director 주소가 그 엣지 노드(SSH 주소 또는
 *    이 기능이 기록한 서버 주소)일 때만(다른 서버의 Bareos 는 이 기능이 지우지 않는다).
 * 비밀은 응답에 싣지 않는다(hasPassword 만).
 */
import { store } from '../../store.js';
import { listInventory } from '../../central/inventory.js';
import { listTargetsRaw } from '../../agent/deployRegistry.js';
import { loadSettings, siteFor, directorById } from '../settings.js';
import { agentLastContact } from '../../central/agentContact.js';
import { registryHosts, vcHostOf } from '../vcHost.js';

export const EDGE_STALE_MS = 30 * 60_000;
const lc = (s) => String(s ?? '').trim().toLowerCase();

/**
 * 순수 판정(시험용 주입). knownHostAddrs: vcenterId → 이 기능이 설치한 서버 주소(작업 기록).
 * @returns {{ vcenterId, vcenterName, vcHost, agent, edgeAt, edgeAgeMs, targetId, sshHost, sshPort, sshUser, hasPassword, director, mode, can, why }[]}
 */
export function buildTargets({ vcenters = [], inventory = [], deployTargets = [], settings = { directors: [], sites: [] }, knownHostAddrs = new Map(), now = Date.now(), contactOf = () => null, vcHosts = new Map() } = {}) {
  const inv = new Map(inventory.map((i) => [i.vcenterId, i]));
  return vcenters.map((v) => {
    const i = inv.get(v.id) || null;
    const agent = i?.agent || '';
    const t = agent ? deployTargets.find((x) => lc(x.agentName) === lc(agent) && x.enabled !== false) || deployTargets.find((x) => lc(x.agentName) === lc(agent)) : null;
    const site = siteFor(v.id, settings);
    const dir = site ? directorById(site.directorId, settings) : null;
    // v2.849(사용자 화면 — 엣지가 살아 있어도 '응답 없음(55153분 전)'): 인벤토리 수신 시각만 보면 중앙이 직접 수집하는 vCenter 의 엣지는
    //   오래전 시각이 남는다 — 그 엣지가 중앙에 보낸 **마지막 인증된 요청**(central/agentContact.js)과 둘 중 최근 값으로 본다.
    const invAt = Number(i?.at) || null;
    const contactAt = agent ? Number(contactOf(agent)) || null : null;
    const edgeAt = invAt && contactAt ? Math.max(invAt, contactAt) : (invAt || contactAt);
    const edgeAgeMs = edgeAt ? Math.max(0, now - edgeAt) : null;
    const row = {
      // v2.851.1(사용자 화면 — 재현): 주소는 등록부에서(vcHost.js) — 수집 스냅샷의 vCenter 항목에는 host 가 없어 늘 빈 값이었다
      vcenterId: v.id, vcenterName: v.name || v.id, vcHost: vcHosts.get(String(v.id)) || vcHostOf(v.host),
      agent, edgeAt, edgeAgeMs,
      targetId: t?.id || '', sshHost: t?.host || '', sshPort: Number(t?.port) || 22, sshUser: t?.username || '',
      // 4·5단계(autoSetup)가 비밀번호 SSH 만 쓴다 — 키만 저장된 대상은 아직 고를 수 없다
      hasPassword: !!(t && t.password),
      director: dir ? { id: dir.id, name: dir.name, host: dir.host, agent: dir.agent || '' } : null,
      mode: dir ? 'reinstall' : 'install', can: false, why: '',
    };
    if (!agent) row.why = '엣지 노드 없음 — 이 vCenter 의 인벤토리를 올리는 엣지가 없습니다.';
    else if (!t) row.why = `배포 등록부에 엣지 ‘${agent}’ 의 SSH 대상이 없습니다 — 배포 › 엣지 노드에서 저장하세요.`;
    else if (!row.hasPassword) row.why = '배포 등록부에 SSH 비밀번호가 저장돼 있지 않습니다(키만 저장된 대상은 아직 지원하지 않습니다).';
    else if (edgeAgeMs == null || edgeAgeMs > EDGE_STALE_MS) row.why = `엣지 응답 없음(마지막 수신 ${edgeAgeMs == null ? '기록 없음' : `${Math.round(edgeAgeMs / 60_000)}분 전`}).`;
    else if (dir) {
      const known = knownHostAddrs.get(v.id);
      const onEdge = lc(dir.host) === lc(t.host) || (known && lc(dir.host) === lc(known));
      if (!onEdge) row.why = `Director ‘${dir.name}’ 가 엣지 노드가 아닌 서버(${dir.host})에 있습니다 — 이 기능은 엣지 노드만 지우고 설치합니다.`;
      else { row.can = true; }
    } else row.can = true;
    return row;
  });
}

/** 지금 값으로(라우트용). */
export function listInstallTargets({ knownHostAddrs = new Map() } = {}) {
  const snap = store.get();
  let inventory = []; try { inventory = listInventory(); } catch { inventory = []; }
  let deployTargets = []; try { deployTargets = listTargetsRaw(); } catch { deployTargets = []; }
  return buildTargets({ vcenters: snap?.vcenters || [], inventory, deployTargets, settings: loadSettings(), knownHostAddrs, contactOf: agentLastContact, vcHosts: registryHosts() });
}

/** 공개용(비밀·내부 id 정리). */
export const publicTarget = (r) => ({ ...r });

/** 내부 전용 — 실행에 쓸 SSH 자격(비밀 포함). */
export function sshCredsFor(targetId) {
  const t = listTargetsRaw().find((x) => x.id === targetId);
  if (!t) return null;
  return { host: t.host, port: Number(t.port) || 22, username: t.username, password: t.password || undefined, privateKey: t.privateKey || undefined, passphrase: t.passphrase || undefined };
}

const lcHost = (s) => String(s ?? '').trim().toLowerCase();
/**
 * v2.876(2026-11-04 사용자 화면 — 사전 점검 '이미 설치된 Bareos ✗' 에서 막다른 길): 포탈에 Director 가 등록되지 않은 법인의 엣지 노드에 Bareos 가 이미 있으면
 *   (사람이 직접 설치 · 이전 설치가 남김) 대상 표는 '새 설치' 이고 사전 점검이 막는데, 조치 문구가 가리키는 '초기화 후 재설치' 는 Director 가 있어야 열렸다.
 *   이제 화면이 resetExisting 을 보내면 그 대상만 재설치(0단계 초기화 → 설치 → 4단계가 Director 를 새로 등록)로 다룬다. 지우는 규칙 · 확인은 기존 재설치와 같다.
 *   ⚠ 다른 법인의 등록을 지우지 않는다: 이 서버(SSH 주소 · 러너가 읽은 서버 주소)가 이미 어떤 Director 로 등록돼 있으면 거부한다(그 법인에서 재설치).
 * @returns {object} 대상 행(재설치로 바꿨으면 mode 'reinstall' · resetUnregistered true)
 */
export function resetTarget(t, body, settings, hostAddr = '') {
  if (!(body && body.resetExisting === true) || !t || t.mode !== 'install') return t;
  const hosts = [lcHost(t.sshHost), lcHost(hostAddr)].filter(Boolean);
  const other = (settings?.directors || []).find((d) => hosts.includes(lcHost(d.host)));
  if (other) throw Object.assign(new Error(`이 서버의 Bareos 는 Director ‘${other.name}’ 로 포탈에 등록돼 있습니다 — 다른 법인의 등록을 지우지 않습니다. 그 Director 의 법인에서 '초기화 후 재설치' 를 고르세요.`), { code: 'invalid' });
  return { ...t, mode: 'reinstall', resetUnregistered: true };
}
