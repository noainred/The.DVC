/**
 * storage/collectors/xtremioSsh.js — XtremIO SSH(xmcli) 수집기(v2.405, 사용자 요구).
 *
 * XMS(XtremIO Management Server)에 SSH 로 접속하면 `xmcli` 셸이 뜬다. 로그인 셸 자체가
 * xmcli 인 경우가 많아 명령을 그대로 보내고, 일반 셸인 경우를 위해 `xmcli -c "<cmd>"` 형태도
 * 후보로 둔다(버전·설치 형태 차이 폴백).
 *
 * ⚠ 실장비 미검증: 명령·컬럼명은 XtremIO CLI 문서 기준이다. 각 명령의 원문 앞부분을
 *   extra.cliRaw 로 보관하니 '연결 테스트'에서 실제 출력을 확인해 교정할 수 있다.
 */

import { emptySnapshot } from '../types.js';
import { runCliSession, parseKeyValueBlocks, toBytes, sshFailureSnapshot } from './cliSsh.js';

const wrap = (cmd) => [cmd, `xmcli -c "${cmd}"`];

const SPECS = [
  { key: 'clusters', section: 'config', required: true, cmds: wrap('show-clusters') },
  { key: 'clustersInfo', section: 'capacity', cmds: wrap('show-clusters-info') },
  { key: 'controllers', section: 'nodes', cmds: wrap('show-storage-controllers') },
  { key: 'users', section: 'accounts', cmds: wrap('show-user-accounts') },
  { key: 'alerts', section: 'alerts', cmds: wrap('show-alerts') },
];

/**
 * XtremIO 표 출력 파서 — 공백으로 정렬된 표(헤더 1줄 + 데이터)를 레코드로 만든다.
 * 헤더가 없으면 Key=Value 블록으로 폴백한다(show-clusters-info 는 블록형인 버전이 있다).
 */
export function parseTable(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  // 구분선(---)이 있으면 그 바로 위가 헤더.
  const sepIdx = lines.findIndex((l) => /^[-=\s|+]+$/.test(l) && l.trim().length > 3);
  let headerIdx = sepIdx > 0 ? sepIdx - 1 : lines.findIndex((l) => /\S\s{2,}\S/.test(l));
  if (headerIdx < 0) return parseKeyValueBlocks(text);
  const header = lines[headerIdx].trim().split(/\s{2,}/).map((h) => h.trim());
  if (header.length < 2) return parseKeyValueBlocks(text);
  const rows = [];
  for (const line of lines.slice(sepIdx > 0 ? sepIdx + 1 : headerIdx + 1)) {
    if (/^[-=\s|+]+$/.test(line)) continue;
    const cells = line.trim().split(/\s{2,}/).map((c) => c.trim());
    if (cells.length < 2) continue;
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows.length ? rows : parseKeyValueBlocks(text);
}

function pick(rec, ...keys) {
  for (const k of keys) {
    for (const actual of Object.keys(rec || {})) {
      if (actual.toLowerCase().replace(/[\s_-]/g, '') === k.toLowerCase().replace(/[\s_-]/g, '')) {
        const v = rec[actual];
        if (v !== undefined && v !== '') return v;
      }
    }
  }
  return '';
}

export function normalizeXtremioSsh(device, out) {
  const snap = emptySnapshot(device);
  snap.extra.collectMethod = 'ssh';

  const clusters = parseTable(out.clusters || '');
  const c0 = clusters[0];
  if (c0) {
    snap.name = pick(c0, 'Name', 'Cluster-Name') || device.name;
    snap.serial = pick(c0, 'PSNT', 'Cluster-PSNT', 'Index') || '';
    snap.version = pick(c0, 'SW-Version', 'Version') || '';
    snap.sections.config = 'ok';
  }

  // 용량: show-clusters(-info) 의 물리 공간 컬럼. 표기가 버전마다 달라 여러 후보를 본다.
  const info = parseTable(out.clustersInfo || out.clusters || '');
  const pools = [];
  let total = 0;
  let used = 0;
  for (const c of info) {
    const t = toBytes(pick(c, 'Physical-Space', 'Total-Physical-Space', 'UD-SSD-Space', 'Total-Space'));
    const u = toBytes(pick(c, 'Physical-Space-In-Use', 'UD-SSD-Space-In-Use', 'Space-In-Use', 'Used-Space'));
    if (!t) continue;
    total += t; used += u;
    pools.push({ name: pick(c, 'Name', 'Cluster-Name') || `cluster${pools.length + 1}`, totalBytes: t, usedBytes: u, pct: Math.round((u / t) * 1000) / 10 });
  }
  if (total) {
    snap.capacity = { totalBytes: total, usedBytes: used, pct: Math.round((used / total) * 1000) / 10 };
    snap.pools = pools.slice(0, 32);
    snap.sections.capacity = 'ok';
  }

  const sc = parseTable(out.controllers || '');
  if (sc.length) {
    const list = sc.map((n, i) => {
      const state = (pick(n, 'State', 'Status', 'Health-State') || '').toLowerCase();
      return {
        id: i + 1, ip: pick(n, 'IP-Address', 'Mgmt-IP') || '',
        health: state ? (/ok|healthy|normal|connected/.test(state) ? 'ok' : state) : 'unknown',
        inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0,
        name: pick(n, 'Name', 'SC-Name') || `SC${i + 1}`,
      };
    });
    snap.nodes = { count: list.length, unhealthy: list.filter((n) => n.health !== 'ok' && n.health !== 'unknown').length, list: list.slice(0, 64) };
    snap.sections.nodes = 'ok';
  }

  const users = parseTable(out.users || '');
  if (users.length) {
    snap.accounts = users.slice(0, 200)
      .map((u) => ({ name: pick(u, 'Name', 'User-Name'), enabled: true, role: pick(u, 'Role') || undefined }))
      .filter((u) => u.name);
    snap.sections.accounts = 'ok';
  }

  if (out.alerts != null) {
    const alerts = parseTable(out.alerts || '');
    snap.alerts.unresolved = alerts.length;
    snap.sections.alerts = 'ok';
  }

  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = 'xmcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다(연결 테스트의 원문 확인).';
  return snap;
}

export async function collectViaSsh(device) {
  let raw = [];
  try {
    const r = await runCliSession(device, SPECS);
    raw = r.raw;
    const snap = normalizeXtremioSsh(device, r.out);
    for (const [key, msg] of Object.entries(r.errors)) {
      const sect = SPECS.find((s) => s.key === key)?.section;
      if (sect && snap.sections[sect] !== 'ok') snap.sections[sect] = `오류: ${msg}`;
    }
    snap.extra.cliRaw = raw;
    return snap;
  } catch (e) {
    return sshFailureSnapshot(device, e, raw);
  }
}
