/**
 * hostaccess/render.js — 호스트 접근 제어(v2.485) **순수 계산** 모듈: 설정 검증, firewalld 상태 파싱, 적용 계획(diff).
 *
 * 사용자 요구: "중요한 정보를 많이 저장한 서버 — ① SSH 클라이언트 제어(완전 차단 포함) ② 80/443 클라이언트 제어
 * ③ OS 방화벽을 포탈에서 설정". 엔진은 Rocky 9 기본 firewalld(nftables 백엔드) — install.sh 가 이미
 * `firewall-cmd --add-port` 로 포탈 포트를 열고 있어 같은 도구를 쓴다. 이 파일은 프로세스를 실행하지 않는다
 * (service.js 가 실행·commit-confirm 담당) — 계획을 테스트로 고정하기 위해서다.
 *
 * 관리 대상(포탈이 '자기 것' 으로 보고 추가/삭제하는 규칙):
 *  - ssh 서비스(`services: ssh`)와 `service name="ssh"` rich rule, 22/tcp 포트 규칙
 *  - 웹 포트(포탈 PORT + 선택한 80/443)의 `port port="P" protocol="tcp"` rich rule, `P/tcp` 포트 규칙, http/https 서비스
 *  - 추가 규칙(firewall.extra)이 만든 rich rule + 직전 적용 때 포탈이 추가한 rich rule(applied.rich)
 * 그 밖의 존 설정(다른 서비스·포트·인터페이스)은 건드리지 않는다.
 */
import net from 'node:net';

export const MODES_SSH = ['open', 'allowlist', 'deny'];
export const MODES_WEB = ['open', 'allowlist'];     // 웹은 '차단' 이 없다 — 포탈 자체가 잠긴다
export const ACTIONS = ['accept', 'drop', 'reject'];
export const CONFIRM_MIN = { min: 1, max: 30, dflt: 5 };

/* ── 주소 검증 ─────────────────────────────────────────────────────────────── */
export function parseCidr(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const ip = m[1];
  const fam = net.isIP(ip);
  if (!fam) return null;
  const maxBits = fam === 4 ? 32 : 128;
  const bits = m[2] == null ? maxBits : Number(m[2]);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;
  return { family: fam === 4 ? 'ipv4' : 'ipv6', ip, bits, text: bits === maxBits ? ip : `${ip}/${bits}` };
}
function ip4ToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
function ip6ToBig(ip) {
  // net.isIP 통과한 IPv6 만 받는다. '::' 확장 + IPv4-embedded 처리.
  let s = ip;
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) { const n = ip4ToInt(v4[1]); s = s.slice(0, v4.index + 1) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16)); }
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : []; const t = tail ? tail.split(':') : [];
  const fill = s.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  const parts = [...h, ...fill, ...t];
  let out = 0n;
  for (const p of parts) out = (out << 16n) + BigInt(parseInt(p || '0', 16));
  return out;
}
/** ip 가 cidr 안에 있는가(패밀리 다르면 false). */
export function ipInCidr(ip, cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const fam = net.isIP(String(ip || ''));
  if (!c || !fam) return false;
  if ((fam === 4 ? 'ipv4' : 'ipv6') !== c.family) return false;
  if (c.family === 'ipv4') {
    if (c.bits === 0) return true;
    const mask = c.bits === 32 ? 0xffffffff : ((0xffffffff << (32 - c.bits)) >>> 0);
    return ((ip4ToInt(ip) & mask) >>> 0) === ((ip4ToInt(c.ip) & mask) >>> 0);
  }
  if (c.bits === 0) return true;
  const shift = BigInt(128 - c.bits);
  return (ip6ToBig(ip) >> shift) === (ip6ToBig(c.ip) >> shift);
}

/* ── 설정 정규화 ───────────────────────────────────────────────────────────── */
const uniq = (arr) => [...new Set(arr)];
function normList(list) {
  const out = []; const bad = [];
  for (const x of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
    const t = String(x || '').trim(); if (!t) continue;
    const c = parseCidr(t); if (c) out.push(c.text); else bad.push(t);
  }
  return { list: uniq(out), bad };
}
const portRe = /^(\d{1,5})(?:-(\d{1,5}))?$/;
export function normPort(p) {
  const m = portRe.exec(String(p || '').trim());
  if (!m) return null;
  const a = Number(m[1]); const b = m[2] != null ? Number(m[2]) : a;
  if (a < 1 || a > 65535 || b < a || b > 65535) return null;
  return a === b ? String(a) : `${a}-${b}`;
}

/**
 * 입력(초안) → 정규화된 설정 + 오류 목록. portalPort 는 항상 web.ports 에 포함(포탈 자기 잠금 방지).
 */
export function normalizeSettings(input = {}, { portalPort = 4000 } = {}) {
  const errors = [];
  const ssh = input.ssh || {}; const web = input.web || {}; const fw = input.firewall || {};
  const sshAllow = normList(ssh.allow); const webAllow = normList(web.allow);
  for (const b of sshAllow.bad) errors.push(`SSH 허용 주소 형식 오류: ${b}`);
  for (const b of webAllow.bad) errors.push(`웹 허용 주소 형식 오류: ${b}`);
  const sshMode = MODES_SSH.includes(ssh.mode) ? ssh.mode : 'open';
  const webMode = MODES_WEB.includes(web.mode) ? web.mode : 'open';
  if (sshMode === 'allowlist' && !sshAllow.list.length) errors.push('SSH 허용목록 모드인데 허용 주소가 없습니다(전부 차단하려면 "차단" 모드를 쓰세요).');
  if (webMode === 'allowlist' && !webAllow.list.length) errors.push('웹 허용목록 모드인데 허용 주소가 없습니다 — 적용하면 포탈 접속이 전부 막힙니다.');
  const ports = uniq([String(Number(portalPort) || 4000), ...(Array.isArray(web.ports) ? web.ports : []).map(normPort).filter(Boolean)]);
  const extra = [];
  for (const [i, r] of (Array.isArray(fw.extra) ? fw.extra : []).entries()) {
    const port = normPort(r?.port);
    const proto = r?.proto === 'udp' ? 'udp' : 'tcp';
    const action = ACTIONS.includes(r?.action) ? r.action : 'accept';
    const src = normList(r?.sources);
    if (!port) { errors.push(`추가 규칙 #${i + 1}: 포트 형식 오류(1~65535 또는 a-b)`); continue; }
    for (const b of src.bad) errors.push(`추가 규칙 #${i + 1}: 주소 형식 오류 ${b}`);
    extra.push({ port, proto, action, sources: src.list, comment: String(r?.comment || '').slice(0, 80) });
  }
  const cm = Number(input.confirmMinutes);
  const confirmMinutes = Number.isFinite(cm) ? Math.min(CONFIRM_MIN.max, Math.max(CONFIRM_MIN.min, Math.round(cm))) : CONFIRM_MIN.dflt;
  return {
    settings: {
      ssh: { mode: sshMode, allow: sshAllow.list, stopService: sshMode === 'deny' && ssh.stopService === true },
      web: { mode: webMode, allow: webAllow.list, ports },
      firewall: { extra },
      confirmMinutes,
    },
    errors,
  };
}

/* ── firewalld --list-all 파싱 ─────────────────────────────────────────────── */
export function parseListAll(text) {
  const out = { zone: '', active: false, target: 'default', interfaces: [], sources: [], services: [], ports: [], richRules: [] };
  const lines = String(text || '').split('\n');
  let inRich = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { const m = /^(\S+)(\s+\(active\))?/.exec(line); if (m) { out.zone = m[1]; out.active = !!m[2]; } inRich = false; continue; }
    if (inRich && /^\t/.test(line)) { out.richRules.push(line.trim()); continue; }
    inRich = false;
    const m = /^\s+([a-z -]+):\s?(.*)$/.exec(line);   // 'rich rules' 처럼 공백 있는 키 포함
    if (!m) continue;
    const k = m[1]; const v = m[2].trim();
    if (k === 'target') out.target = v || 'default';
    else if (k === 'interfaces') out.interfaces = v ? v.split(/\s+/) : [];
    else if (k === 'sources') out.sources = v ? v.split(/\s+/) : [];
    else if (k === 'services') out.services = v ? v.split(/\s+/) : [];
    else if (k === 'ports') out.ports = v ? v.split(/\s+/) : [];
    else if (k === 'rich rules') { inRich = true; if (v) out.richRules.push(v); }
  }
  return out;
}

/* ── rich rule 생성(firewalld 가 --list-all 로 되돌려주는 정규형과 같게) ───── */
const fam = (cidr) => (parseCidr(cidr)?.family || 'ipv4');
export const richSsh = (cidr) => `rule family="${fam(cidr)}" source address="${cidr}" service name="ssh" accept`;
export const richPort = (cidr, port, proto, action) => (cidr
  ? `rule family="${fam(cidr)}" source address="${cidr}" port port="${port}" protocol="${proto}" ${action}`
  : `rule family="ipv4" port port="${port}" protocol="${proto}" ${action}`);

/** 설정이 요구하는 rich rule 전체(순서 무관 집합). */
export function desiredRichRules(s) {
  const out = [];
  if (s.ssh.mode === 'allowlist') for (const c of s.ssh.allow) out.push(richSsh(c));
  if (s.web.mode === 'allowlist') for (const c of s.web.allow) for (const p of s.web.ports) out.push(richPort(c, p, 'tcp', 'accept'));
  for (const r of s.firewall.extra) {
    if (r.sources.length) for (const c of r.sources) out.push(richPort(c, r.port, r.proto, r.action));
    else out.push(richPort(null, r.port, r.proto, r.action));
  }
  return uniq(out);
}

/** 현재 rich rule 이 포탈 관리 대상인가(ssh 서비스 / 웹 포트 / 추가 규칙 포트 / 직전 적용분). */
export function isManagedRich(rule, s, prevRich = []) {
  if (prevRich.includes(rule)) return true;
  if (/service name="ssh"/.test(rule)) return true;
  if (/port port="22" protocol="tcp"/.test(rule)) return true;
  const ports = new Set([...s.web.ports, ...s.firewall.extra.map((r) => r.port)]);
  const m = /port port="([^"]+)" protocol="(tcp|udp)"/.exec(rule);
  if (m && ports.has(m[1])) return true;
  return false;
}

/**
 * 적용 계획 — 현재 존 상태(parseListAll 결과)와 설정을 비교해 firewall-cmd 인자 목록을 만든다(런타임, --permanent 없음).
 * @returns {{ commands: string[][], warnings: string[], errors: string[], desiredRich: string[] }}
 */
export function planCommands(s, cur, { prevRich = [], requesterIp = '' } = {}) {
  const commands = []; const warnings = []; const errors = [];
  const z = cur.zone ? [`--zone=${cur.zone}`] : [];
  const cmd = (...a) => commands.push([...z, ...a]);
  const hasService = (n) => cur.services.includes(n);
  const hasPort = (p) => cur.ports.includes(`${p}/tcp`);

  if ((cur.target || 'default').toUpperCase() === 'ACCEPT') {
    errors.push(`존 '${cur.zone}' 의 target 이 ACCEPT 라 허용목록/차단이 효력이 없습니다 — 'firewall-cmd --permanent --zone=${cur.zone} --set-target=default && firewall-cmd --reload' 로 먼저 바꾸세요.`);
  }
  if (!cur.interfaces.length && !cur.sources.length) warnings.push(`존 '${cur.zone}' 에 바인딩된 인터페이스/소스가 없습니다(기본 존이라면 미지정 인터페이스가 이 존을 씁니다).`);

  // ── SSH ──
  if (s.ssh.mode === 'open') {
    if (!hasService('ssh')) cmd('--add-service=ssh');
  } else {
    if (hasService('ssh')) cmd('--remove-service=ssh');
    if (hasPort(22)) { warnings.push('존에 22/tcp 포트 규칙이 있어 함께 제거합니다(그대로 두면 SSH 제어가 무력화됩니다).'); cmd('--remove-port=22/tcp'); }
    if (s.ssh.mode === 'deny' && requesterIp && s.ssh.allow.length === 0) warnings.push('SSH 를 완전히 차단합니다 — 콘솔(IPMI/iDRAC/vSphere 콘솔) 접근 경로를 확보한 뒤 확정하세요.');
  }
  // ── 웹(포탈 포트 + 선택 포트) ──
  if (s.web.mode === 'open') {
    for (const p of s.web.ports) {
      if (p === '80' && hasService('http')) continue;
      if (p === '443' && hasService('https')) continue;
      if (!hasPort(p)) cmd(`--add-port=${p}/tcp`);
    }
  } else {
    if (!requesterIp) errors.push('요청자 IP 를 판별할 수 없어 웹 허용목록을 적용하지 않습니다(자기 잠금 방지).');
    else if (!s.web.allow.some((c) => ipInCidr(requesterIp, c))) errors.push(`요청자 IP ${requesterIp} 가 웹 허용목록에 없습니다 — 적용 직후 이 세션이 끊깁니다. 허용목록에 추가한 뒤 적용하세요.`);
    for (const p of s.web.ports) {
      if (hasPort(p)) cmd(`--remove-port=${p}/tcp`);
      if (p === '80' && hasService('http')) cmd('--remove-service=http');
      if (p === '443' && hasService('https')) cmd('--remove-service=https');
    }
  }
  // ── rich rule diff ──
  const desired = desiredRichRules(s);
  const curSet = new Set(cur.richRules);
  for (const r of cur.richRules) if (!desired.includes(r) && isManagedRich(r, s, prevRich)) cmd(`--remove-rich-rule=${r}`);
  for (const r of desired) if (!curSet.has(r)) cmd(`--add-rich-rule=${r}`);
  // 추가 규칙의 drop/reject 가 포탈 포트를 겨냥하면 경고(허용 rich rule 보다 drop 이 우선 평가될 수 있다).
  for (const r of s.firewall.extra) {
    if (r.action !== 'accept' && s.web.ports.includes(r.port) && r.proto === 'tcp') {
      if (!r.sources.length) errors.push(`추가 규칙이 포탈 포트 ${r.port}/tcp 를 전체 ${r.action} 합니다 — 포탈이 잠깁니다.`);
      else if (requesterIp && r.sources.some((c) => ipInCidr(requesterIp, c))) errors.push(`추가 규칙이 요청자 IP ${requesterIp} 의 포탈 포트 ${r.port}/tcp 를 ${r.action} 합니다.`);
    }
  }
  return { commands, warnings, errors, desiredRich: desired };
}

/** 설정 지문(적용 상태 비교용). */
export function fingerprint(s) {
  return JSON.stringify({ ssh: s.ssh, web: s.web, firewall: s.firewall });
}
