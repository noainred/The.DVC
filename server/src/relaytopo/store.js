/**
 * relaytopo/store.js — 중계 토폴로지(Main – Edge DVC – IRS) 저장(v2.431, 사용자 요구 '첨부한 표처럼 Main-Edge1-Edge2 구조의
 * 접속이 필요한 서비스(ssh/vcsa/portal 등)를 입력하면 각각을 haproxy 로 구성하고 점검' + '노드 입력할 때 ip/id/pw/키 입력').
 *
 * 파일: CONFIG_DIR/relay-topology.json (0600). 노드별 SSH 자격증명(password/privateKey/passphrase)은 secretVault 정책대로 봉인
 * 저장하며(SECRET_FILES 등록), **어떤 조회 응답에도 비밀 값은 없다**(has* 플래그만). 자격증명이 없는 노드는 배포 대상 레지스트리
 * (sshTargetId 또는 같은 IP 의 배포 대상)로 폴백한다.
 *  main:     { name, privateIp, publicIp, portalPort, ssh }
 *  services: [{ key, label, listenPort, target: 'irs'|'irs-vcenter'|'edge-vcenter'|'main', targetPort, mode:'tcp'|'http', enabled }]
 *            target 은 중계 엣지(Edge DVC)의 listenPort 가 어디로 가는지: irs=IRS 포탈/SSH, irs-vcenter=IRS 사이트 vCenter,
 *            edge-vcenter=Edge 사이트 vCenter, main=중앙 포탈(IRS 가 중앙으로 갈 때 지나는 문).
 *  sites:    [{ dc, edge:{ privateIp, publicIp, vcenterIp, ssh }, irs:{ privateIp, publicIp, vcenterIp, ssh }, sshTargetId, note }]
 *  ssh:      { port, username, password, privateKey, passphrase } — 저장 시 빈 비밀은 기존 값 유지(화면이 비밀을 되돌려 보내지 않으므로).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { parseCsvRows, csvLine, unguardCell } from '../util/csv.js';

const FILE = () => path.join(config.configDir, 'relay-topology.json');
const RE_IP = /^(\d{1,3}\.){3}\d{1,3}$|^[A-Za-z0-9.-]{1,253}$/;
const RE_IP4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const RE_KEY = /^[a-z0-9-]{1,32}$/;

/** 첨부 표 기준 기본 서비스 프로파일. */
export const DEFAULT_SERVICES = [
  { key: 'portal', label: 'IRS 포탈', listenPort: 4068, target: 'irs', targetPort: 4000, mode: 'tcp', enabled: true },
  { key: 'ssh', label: 'IRS SSH', listenPort: 4067, target: 'irs', targetPort: 22, mode: 'tcp', enabled: true },
  { key: 'vcsa', label: 'IRS vCenter', listenPort: 4066, target: 'irs-vcenter', targetPort: 443, mode: 'tcp', enabled: true },
  { key: 'edge-vcsa', label: 'Edge vCenter', listenPort: 4065, target: 'edge-vcenter', targetPort: 443, mode: 'tcp', enabled: true },
  { key: 'hq', label: 'HQ 포탈', listenPort: 4001, target: 'main', targetPort: 4000, mode: 'tcp', enabled: true },
];
export const TARGETS = {
  irs: 'IRS 서버(포탈/SSH 등)', 'irs-vcenter': 'IRS 사이트 vCenter', 'edge-vcenter': 'Edge 사이트 vCenter', main: '중앙(Main) 포탈',
};
export const SSH_SECRETS = ['password', 'privateKey', 'passphrase'];

const ip = (v) => { const s = String(v || '').trim(); return RE_IP.test(s) ? s : ''; };
const port = (v, def) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : def; };
// ⚠ v2.598 INJ-02: 이 파일의 문자열 필드(dc·label·name·note·username …)는 전부 **한 줄** 값이고 HAProxy 설정의
//   주석·이름에 그대로 들어간다(`haproxy.js renderManagedBlock`). 개행이 남으면 dc 이름 하나로 설정에 임의 줄
//   (listen/server 지시어)을 끼워 넣을 수 있었다 — 제어 문자는 공백으로 바꾼다(저장·로드 모두 이 함수를 거친다).
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/g;
const str = (v, n) => String(v ?? '').replace(CTRL_RE, ' ').trim().slice(0, n);

/** SSH 자격증명 정규화. prev 가 있으면 빈 비밀은 이전 값을 잇는다(화면은 비밀을 되돌려 보내지 않음). clear* 플래그로 명시 삭제. */
function normSsh(input, prev) {
  const s = input && typeof input === 'object' ? input : {};
  const out = { port: port(s.port, 22), username: str(s.username, 64) };
  for (const k of SSH_SECRETS) {
    const v = typeof s[k] === 'string' ? s[k] : '';
    const clear = s[`clear${k[0].toUpperCase()}${k.slice(1)}`] === true;
    out[k] = v ? v.slice(0, 16_384) : (clear ? '' : String(prev?.[k] || ''));
  }
  return out;
}
/**
 * 노드 정규화. **host(privateIp/publicIp)가 바뀌면 저장된 비밀을 이월하지 않는다**(v2.435 — 감사 S1).
 *
 * 왜: 이월 규칙이 dc 이름만 보고 동작해서, `edge.publicIp` 만 공격자 호스트로 바꾸고 비밀번호를 빈 값으로
 * 저장한 뒤 SSH 테스트를 부르면 **운영 서버의 root 비밀번호가 그 호스트로 평문 전송**됐다(실측 확인).
 * `server/CLAUDE.md` v2.257 M3("host 변경 시 저장 비번을 이월하지 않는다")의 직접 회귀였다.
 * 개인키/패스프레이즈는 publickey 인증이라 선로에 나가지 않지만, 같은 규칙으로 함께 끊는다(원칙 단순화).
 */
function normNode(n, prev) {
  const next = { privateIp: ip(n?.privateIp), publicIp: ip(n?.publicIp), vcenterIp: ip(n?.vcenterIp) };
  const hostChanged = !!prev && (next.privateIp !== (prev.privateIp || '') || next.publicIp !== (prev.publicIp || ''));
  return { ...next, ssh: normSsh(n?.ssh, hostChanged ? null : prev?.ssh), _secretsDropped: hostChanged && hasSecret(prev?.ssh) };
}
const hasSecret = (ssh) => SSH_SECRETS.some((k) => !!ssh?.[k]);

export function normalizeTopology(input = {}, prev = null) {
  const mainHostChanged = !!prev?.main && (ip(input.main?.privateIp) !== (prev.main.privateIp || '') || ip(input.main?.publicIp) !== (prev.main.publicIp || ''));
  const main = { name: str(input.main?.name, 40) || 'Main', privateIp: ip(input.main?.privateIp), publicIp: ip(input.main?.publicIp), portalPort: port(input.main?.portalPort, 4000), ssh: normSsh(input.main?.ssh, mainHostChanged ? null : prev?.main?.ssh) };
  const services = (Array.isArray(input.services) ? input.services : DEFAULT_SERVICES).map((s) => ({
    key: str(s?.key, 32).toLowerCase(), label: str(s?.label, 40), listenPort: port(s?.listenPort, 0),
    target: TARGETS[s?.target] ? s.target : 'irs', targetPort: port(s?.targetPort, 0), mode: s?.mode === 'http' ? 'http' : 'tcp', enabled: s?.enabled !== false,
  })).filter((s) => RE_KEY.test(s.key) && s.listenPort && s.targetPort).slice(0, 32);
  // listenPort 중복 제거(뒤에 온 것 무시)
  const seenPort = new Set(); const uniq = [];
  for (const s of services) { if (seenPort.has(s.listenPort)) continue; seenPort.add(s.listenPort); uniq.push(s); }
  const prevSites = new Map((prev?.sites || []).map((s) => [s.dc, s]));
  const dropped = [];   // host 가 바뀌어 저장된 비밀을 버린 노드(화면에 알린다 — 조용히 지우면 더 나쁘다)
  const sites = (Array.isArray(input.sites) ? input.sites : []).map((s) => {
    const dc = str(s?.dc, 40); const p = prevSites.get(dc);
    const edge = normNode(s?.edge, p?.edge); const irs = normNode(s?.irs, p?.irs);
    if (edge._secretsDropped) dropped.push(`${dc} Edge`);
    if (irs._secretsDropped) dropped.push(`${dc} IRS`);
    delete edge._secretsDropped; delete irs._secretsDropped;
    return { dc, edge, irs, sshTargetId: str(s?.sshTargetId, 64), note: str(s?.note, 200) };
  }).filter((s) => s.dc).slice(0, 200);
  const seenDc = new Set(); const uniqSites = sites.filter((s) => (seenDc.has(s.dc) ? false : (seenDc.add(s.dc), true)));
  const out = { main, services: uniq.length ? uniq : DEFAULT_SERVICES.map((x) => ({ ...x })), sites: uniqSites };
  if (dropped.length) Object.defineProperty(out, 'secretsDropped', { value: dropped, enumerable: false });
  return out;
}

let _cache = null;
function loadRaw() {
  if (!_cache) {
    let raw = {};
    try { if (fs.existsSync(FILE())) raw = openSecretsDeep(JSON.parse(fs.readFileSync(FILE(), 'utf8'))); } catch { preserveCorrupt(FILE()); raw = {}; }
    _cache = normalizeTopology(raw);
  }
  return _cache;
}
/** 비밀 포함 원본(서버 내부 전용 — SSH 접속·마이그레이션). 응답에 그대로 내보내지 말 것. */
export function loadTopologyRaw() { return structuredClone(loadRaw()); }
/** 비밀 제거본(has* 플래그) — 화면/내보내기용. */
export function loadTopology() { return redactTopology(loadRaw()); }
export function saveTopology(input = {}) {
  _cache = normalizeTopology(input, loadRaw());
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep({ version: 1, ..._cache }), null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE(), 0o600); } catch { /* 신규 생성 외 덮어쓰기에도 0600 */ }
  return loadTopology();
}
export function _resetForTest() { _cache = null; }

const redactSsh = (s) => { const out = { port: s?.port || 22, username: s?.username || '' }; for (const k of SSH_SECRETS) out[`has${k[0].toUpperCase()}${k.slice(1)}`] = !!s?.[k]; return out; };
const redactNode = (n) => ({ ...n, ssh: redactSsh(n?.ssh) });
export function redactTopology(t) {
  return { main: { ...t.main, ssh: redactSsh(t.main?.ssh) }, services: structuredClone(t.services), sites: (t.sites || []).map((s) => ({ ...s, edge: redactNode(s.edge), irs: redactNode(s.irs) })) };
}

/**
 * 첨부 표(스프레드시트 붙여넣기: 탭/쉼표 구분) 파싱(순수). 열: Datacenter, Server(Main|Edge|IRS|Sandbox), private IP, public IP, …
 * DC 셀이 비면 직전 DC 를 잇는다(표의 IRS 행). 이 도구의 CSV 내보내기(머리글 dc,role,privateIp,publicIp,vcenterIp,sshPort,sshUser,note)도
 * 같은 함수로 읽는다(머리글로 판별). 반환 { main, sites, skipped:[] }.
 */
export function parseTopologyTable(text) {
  const src = String(text || '');
  const rows = src.includes('\t') || src.includes(',') ? parseCsvRows(src, { maxRows: 5000, maxCell: 500 }) : src.split(/\r?\n/).map((l) => l.trim().split(/\s{2,}/));
  const main = { privateIp: '', publicIp: '' }; const sites = new Map(); const skipped = [];
  let dc = ''; let cols = null; // cols: 내보내기 CSV 머리글 인덱스
  const site = (d) => { if (!sites.has(d)) sites.set(d, { dc: d, edge: { privateIp: '', publicIp: '', vcenterIp: '', ssh: {} }, irs: { privateIp: '', publicIp: '', vcenterIp: '', ssh: {} }, note: '' }); return sites.get(d); };
  for (const cells0 of rows) {
    // 보안(L-2): 내보내기에서 수식가드(`'` 접두)를 붙였으므로 가져오기에서 걷어낸다(왕복 무손실).
    const cells = cells0.map((c) => unguardCell(String(c || '').trim()));
    const line = cells.join('\t');
    if (!cells.some(Boolean)) continue;
    const low = cells.map((c) => c.toLowerCase());
    if (low[0] === 'dc' && low.includes('role')) { cols = Object.fromEntries(low.map((c, i) => [c.replace(/[^a-z]/g, ''), i])); continue; }
    if (cols) { // 내보내기 CSV
      const g = (k) => cells[cols[k]] ?? '';
      const d = g('dc') || dc; const role = g('role').toLowerCase();
      if (!d && role !== 'main') { skipped.push(line); continue; }
      if (d) dc = d;
      const node = { privateIp: g('privateip'), publicIp: g('publicip'), vcenterIp: g('vcenterip'), ssh: { port: g('sshport') || 22, username: g('sshuser') } };
      if (role === 'main') { Object.assign(main, node, { name: d || 'Main', portalPort: g('portalport') || 4000 }); continue; }
      if (role !== 'edge' && role !== 'irs') { skipped.push(line); continue; }
      const s = site(d); s[role] = node; if (g('note')) s.note = g('note');
      continue;
    }
    if (cells.length < 3) { skipped.push(line); continue; }
    if (/^(datacenter|main portal|edge dvc|edge irs)$/i.test(cells[0])) continue; // 머리글
    if (cells[0]) dc = cells[0];
    const role = low[1];
    const ips = cells.filter((c, i) => i >= 2 && RE_IP4.test(c));
    const priv = ips[0] || '', pub = ips[1] || '';
    if (!dc || !role || !priv) { skipped.push(line); continue; }
    if (role === 'main') { main.privateIp = priv; main.publicIp = pub; main.dc = dc; main.name = dc; continue; }
    if (role === 'sandbox') { skipped.push(line); continue; }
    if (role !== 'edge' && role !== 'irs') { skipped.push(line); continue; }
    const s = site(dc);
    s[role] = { ...s[role], privateIp: priv, publicIp: pub };
  }
  return { main, sites: [...sites.values()], skipped };
}

/** CSV 내보내기(순수, 비밀 없음). 머리글은 parseTopologyTable 이 다시 읽을 수 있는 형태.
 *  보안(L-2, 2026-09-12): 다른 12개 CSV 빌더처럼 `csvLine`(수식 인젝션 가드 포함)을 쓴다 —
 *  dc·note 에 `=cmd|...`·`=HYPERLINK(...)` 를 넣어 다른 admin 의 엑셀에서 실행되는 것을 막는다.
 *  가져오기 parseTopologyTable 이 unguardCell 로 걷어내므로 왕복 무손실이다. */
export function topologyToCsv(t) {
  const lines = [csvLine(['dc', 'role', 'privateIp', 'publicIp', 'vcenterIp', 'sshPort', 'sshUser', 'portalPort', 'note'])];
  const m = t.main || {};
  lines.push(csvLine([m.name || 'Main', 'Main', m.privateIp, m.publicIp, '', m.ssh?.port || 22, m.ssh?.username || '', m.portalPort || 4000, '']));
  for (const s of t.sites || []) {
    lines.push(csvLine([s.dc, 'Edge', s.edge?.privateIp, s.edge?.publicIp, s.edge?.vcenterIp, s.edge?.ssh?.port || 22, s.edge?.ssh?.username || '', '', s.note || '']));
    lines.push(csvLine([s.dc, 'IRS', s.irs?.privateIp, s.irs?.publicIp, s.irs?.vcenterIp, s.irs?.ssh?.port || 22, s.irs?.ssh?.username || '', '', '']));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * 가져오기 병합(순수): 현재 토폴로지에 파싱 결과를 얹는다. 같은 DC 는 IP/SSH 계정을 갱신하되 저장된 비밀은 유지(normalize 의 prev 규칙),
 * 없는 DC 는 추가. replace=true 면 목록을 통째로 교체(비밀은 같은 DC 면 유지).
 */
export function mergeImport(current, parsed, { replace = false } = {}) {
  const next = structuredClone(current);
  if (parsed.main && (parsed.main.privateIp || parsed.main.publicIp)) next.main = { ...next.main, ...Object.fromEntries(Object.entries(parsed.main).filter(([k, v]) => v && ['name', 'privateIp', 'publicIp', 'portalPort'].includes(k))), ssh: { ...(next.main.ssh || {}), ...(parsed.main.ssh || {}) } };
  const byDc = new Map((replace ? [] : next.sites).map((s) => [s.dc, s]));
  for (const p of parsed.sites || []) {
    const cur = byDc.get(p.dc) || { dc: p.dc, edge: { privateIp: '', publicIp: '', vcenterIp: '', ssh: {} }, irs: { privateIp: '', publicIp: '', vcenterIp: '', ssh: {} }, sshTargetId: '', note: '' };
    // S1(v2.435): 가져오기로 host 가 바뀌면 저장된 비밀을 잇지 않는다(저장 경로와 같은 규칙).
    const mergeNode = (a, b) => {
      const privateIp = b?.privateIp || a.privateIp; const publicIp = b?.publicIp || a.publicIp;
      const changed = (privateIp !== (a.privateIp || '') || publicIp !== (a.publicIp || ''));
      const keep = changed ? {} : (a.ssh || {});
      return { privateIp, publicIp, vcenterIp: b?.vcenterIp || a.vcenterIp,
        ssh: { ...keep, ...Object.fromEntries(Object.entries(b?.ssh || {}).filter(([, v]) => v)) } };
    };
    byDc.set(p.dc, { ...cur, edge: mergeNode(cur.edge, p.edge), irs: mergeNode(cur.irs, p.irs), note: p.note || cur.note });
  }
  next.sites = [...byDc.values()];
  if (parsed.services?.length) next.services = parsed.services;
  return next;
}
