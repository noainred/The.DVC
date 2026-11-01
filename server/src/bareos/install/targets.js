/**
 * bareos/install/targets.js — 완전 설치 대상 표(v2.844): vCenter(법인)마다 엣지 노드 · 배포 등록부 SSH 계정 · 엣지 응답 · Director 등록 여부.
 *
 * 법인 · vCenter · Bareos 는 1:1:1(루트 CLAUDE.md) — 행 하나 = vCenter 하나.
 *  - 엣지: 그 vCenter 의 인벤토리를 올리는 엣지(listInventory().agent — Veeam·Bareos 설정 화면과 같은 출처) · 응답 = 마지막 인벤토리 수신 시각.
 *  - SSH: 배포 등록부(agent-deploy-targets.json)에서 agentName 이 그 엣지인 항목. 비밀번호(또는 키)가 저장돼 있어야 한다(다시 묻지 않는다).
 *  - Director: 그 vCenter 의 매핑(sites)이 가리키는 Director. 있으면 '초기화 후 재설치' — 단 Director 주소가 그 엣지 노드(SSH 주소 또는
 *    이 기능이 기록한 서버 주소)일 때만(다른 서버의 Bareos 는 이 기능이 지우지 않는다).
 * 비밀은 응답에 싣지 않는다(hasPassword 만).
 */
import { store } from '../../store.js';
import { listInventory } from '../../central/inventory.js';
import { listTargetsRaw } from '../../agent/deployRegistry.js';
import { loadSettings, siteFor, directorById } from '../settings.js';

export const EDGE_STALE_MS = 30 * 60_000;
const lc = (s) => String(s ?? '').trim().toLowerCase();

/**
 * 순수 판정(시험용 주입). knownHostAddrs: vcenterId → 이 기능이 설치한 서버 주소(작업 기록).
 * @returns {{ vcenterId, vcenterName, vcHost, agent, edgeAt, edgeAgeMs, targetId, sshHost, sshPort, sshUser, hasPassword, director, mode, can, why }[]}
 */
export function buildTargets({ vcenters = [], inventory = [], deployTargets = [], settings = { directors: [], sites: [] }, knownHostAddrs = new Map(), now = Date.now() } = {}) {
  const inv = new Map(inventory.map((i) => [i.vcenterId, i]));
  return vcenters.map((v) => {
    const i = inv.get(v.id) || null;
    const agent = i?.agent || '';
    const t = agent ? deployTargets.find((x) => lc(x.agentName) === lc(agent) && x.enabled !== false) || deployTargets.find((x) => lc(x.agentName) === lc(agent)) : null;
    const site = siteFor(v.id, settings);
    const dir = site ? directorById(site.directorId, settings) : null;
    const edgeAt = Number(i?.at) || null;
    const edgeAgeMs = edgeAt ? Math.max(0, now - edgeAt) : null;
    const row = {
      vcenterId: v.id, vcenterName: v.name || v.id, vcHost: String(v.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
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
  return buildTargets({ vcenters: snap?.vcenters || [], inventory, deployTargets, settings: loadSettings(), knownHostAddrs });
}

/** 공개용(비밀·내부 id 정리). */
export const publicTarget = (r) => ({ ...r });

/** 내부 전용 — 실행에 쓸 SSH 자격(비밀 포함). */
export function sshCredsFor(targetId) {
  const t = listTargetsRaw().find((x) => x.id === targetId);
  if (!t) return null;
  return { host: t.host, port: Number(t.port) || 22, username: t.username, password: t.password || undefined, privateKey: t.privateKey || undefined, passphrase: t.passphrase || undefined };
}
