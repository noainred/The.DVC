/**
 * storage/collectors/vplexSsh.js — VPLEX / Metro Node SSH(vplexcli) 수집기(v2.405, 사용자 요구).
 *
 * VPLEX 관리 서버(또는 Metro Node)에 SSH 로 접속하면 `vplexcli` 셸을 쓸 수 있다. 로그인 셸이
 * 이미 vplexcli 인 경우가 많아 명령을 그대로 보내고, 일반 셸이면 `vplexcli -c "<cmd>"` 로도
 * 시도한다(설치 형태 차이 폴백).
 *
 * ⚠ VPLEX 는 가상화 계층이라 **자체 물리 용량이 없다**(뒤단 어레이의 용량을 가상화한다).
 *   그래서 capacity 를 억지로 채우지 않고 클러스터/디렉터 상태와 스토리지 볼륨 요약만 남긴다
 *   — 0 으로 채우면 화면에서 '용량 0' 으로 오표시된다(types.js 의 정직 표기 규칙).
 * ⚠ 실장비 미검증: 각 명령의 원문 앞부분을 extra.cliRaw 로 보관하니 '연결 테스트'에서
 *   실제 출력을 확인해 교정할 수 있다.
 */

import { emptySnapshot } from '../types.js';
import { runCliSession, parseKeyValueBlocks, sshFailureSnapshot, firstLine } from './cliSsh.js';

const wrap = (cmd) => [cmd, `vplexcli -c "${cmd}"`];

const SPECS = [
  { key: 'version', section: 'config', required: true, cmds: wrap('version') },
  { key: 'clusters', section: 'nodes', cmds: wrap('ll /clusters') },
  { key: 'directors', section: 'nodes', cmds: wrap('ll /engines/*/directors') },
  { key: 'health', section: 'alerts', cmds: wrap('health-check --full') },
  { key: 'storageVolumes', section: 'pools', cmds: wrap('ll /clusters/*/storage-elements/storage-volumes') },
  { key: 'users', section: 'accounts', cmds: wrap('user list') },
];

/**
 * vplexcli 의 `ll` 표 출력 파서 — 공백 정렬 표. 헤더가 없으면 Key/Value 블록으로 폴백.
 * (xtremioSsh 의 parseTable 과 비슷하지만 VPLEX 는 '이름  값' 2열 표가 흔해 별도로 둔다.)
 */
export function parseLl(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const sepIdx = lines.findIndex((l) => /^[-\s]+$/.test(l) && l.trim().length > 3);
  if (sepIdx > 0) {
    const header = lines[sepIdx - 1].trim().split(/\s{2,}/).map((h) => h.trim());
    if (header.length >= 2) {
      const rows = [];
      for (const line of lines.slice(sepIdx + 1)) {
        if (/^[-\s]+$/.test(line)) continue;
        const cells = line.trim().split(/\s{2,}/).map((c) => c.trim());
        if (cells.length < 2) continue;
        const row = {};
        header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
        rows.push(row);
      }
      if (rows.length) return rows;
    }
  }
  return parseKeyValueBlocks(text);
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

export function normalizeVplexSsh(device, out) {
  const snap = emptySnapshot(device);
  snap.extra.collectMethod = 'ssh';
  snap.extra.virtualizationLayer = true; // 화면이 '자체 용량 없음'을 안내하는 근거(REST 수집기와 동일)

  if (out.version) {
    // 'Product Version: 6.2.0.01.00.13' 같은 줄에서 버전을 뽑는다. 못 찾으면 첫 줄을 남긴다.
    const m = /(?:product\s+version|version)\s*[:=]?\s*([\d][\w.]*)/i.exec(out.version);
    snap.version = m ? m[1] : firstLine(out.version);
    snap.name = device.name;
    snap.sections.config = 'ok';
  }

  const clusters = parseLl(out.clusters || '');
  if (clusters.length) {
    snap.extra.clusters = clusters.slice(0, 8).map((c) => ({
      name: pick(c, 'Name', 'cluster-id') || '', health: pick(c, 'health-state', 'Health', 'operational-status') || '',
    }));
  }

  const directors = parseLl(out.directors || '');
  if (directors.length) {
    const list = directors.slice(0, 64).map((d, i) => {
      const st = (pick(d, 'operational-status', 'health-state', 'Status') || '').toLowerCase();
      return {
        id: i + 1, ip: pick(d, 'management-ip', 'IP') || '',
        health: st ? (/ok|healthy|online|normal/.test(st) ? 'ok' : st) : 'unknown',
        inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0,
        name: pick(d, 'Name', 'director-id') || `director${i + 1}`,
      };
    });
    snap.nodes = { count: list.length, unhealthy: list.filter((n) => n.health !== 'ok' && n.health !== 'unknown').length, list };
    snap.sections.nodes = 'ok';
  }

  const sv = parseLl(out.storageVolumes || '');
  if (sv.length) {
    // 개수·상태 분포만(볼륨 수천 개의 원본을 스냅샷에 싣지 않는다 — 중앙 push 크기 계약).
    const byHealth = {};
    for (const v of sv) { const k = String(pick(v, 'health-state', 'Health') || 'Unknown'); byHealth[k] = (byHealth[k] || 0) + 1; }
    snap.extra.storageVolumes = { count: sv.length, byHealth };
    snap.sections.pools = 'ok';
  }

  const users = parseLl(out.users || '');
  if (users.length) {
    snap.accounts = users.slice(0, 200)
      .map((u) => ({ name: pick(u, 'Username', 'Name', 'user'), enabled: true }))
      .filter((u) => u.name);
    if (snap.accounts.length) snap.sections.accounts = 'ok';
  }

  if (out.health) {
    // health-check 출력에서 오류/경고 줄 수를 센다(정확한 경보 개수 API 가 없다 — 근사치임을 명시).
    const bad = String(out.health).split(/\r?\n/).filter((l) => /\b(error|fail(ed|ure)?|degraded|critical)\b/i.test(l));
    snap.alerts.unresolved = bad.length;
    snap.extra.healthCheckLines = bad.slice(0, 20);
    snap.extra.alertsAreApproximate = true; // 화면/보고서가 '근사치'임을 알 수 있게
    snap.sections.alerts = 'ok';
  }

  snap.ok = snap.sections.config === 'ok' || snap.sections.nodes === 'ok';
  if (!snap.ok && !snap.error) snap.error = 'vplexcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다(연결 테스트의 원문 확인).';
  return snap;
}

export async function collectViaSsh(device) {
  let raw = [];
  try {
    const r = await runCliSession(device, SPECS);
    raw = r.raw;
    const snap = normalizeVplexSsh(device, r.out);
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
