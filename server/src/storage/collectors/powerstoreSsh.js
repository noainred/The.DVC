/**
 * storage/collectors/powerstoreSsh.js — Dell PowerStore SSH(pstcli) 수집기(v2.405, 사용자 요구).
 *
 * PowerStore 클러스터 관리 IP 에 SSH 로 접속하면 `pstcli` 를 쓸 수 있다. pstcli 는
 * `-output json` 으로 REST 와 같은 구조의 JSON 을 내주므로 1순위로 쓰고, 지원하지 않는
 * 버전을 위해 csv/기본 표 출력을 폴백으로 둔다.
 *
 * ⚠ 실장비 미검증: 명령·플래그는 PowerStore CLI 문서 기준이다. 각 명령의 원문 앞부분을
 *   extra.cliRaw 로 보관하니, 등록 화면 '연결 테스트'에서 실제 출력을 확인해 교정할 수 있다.
 */

import { emptySnapshot } from '../types.js';
import { runCliSession, parseCsv, parseJsonLoose, toBytes, sshFailureSnapshot } from './cliSsh.js';

const SPECS = [
  { key: 'cluster', section: 'config', required: true, cmds: ['pstcli -output json cluster show', 'pstcli -output csv cluster show', 'pstcli cluster show'] },
  { key: 'sw', cmds: ['pstcli -output json software_installed show', 'pstcli software_installed show'] },
  { key: 'appliance', section: 'pools', cmds: ['pstcli -output json appliance show', 'pstcli -output csv appliance show', 'pstcli appliance show'] },
  { key: 'space', section: 'capacity', cmds: ['pstcli -output json metrics generate -entity space_metrics_by_cluster', 'pstcli -output json space_metrics_by_cluster show'] },
  { key: 'node', section: 'nodes', cmds: ['pstcli -output json node show', 'pstcli -output csv node show', 'pstcli node show'] },
  { key: 'user', section: 'accounts', cmds: ['pstcli -output json local_user show', 'pstcli local_user show'] },
  { key: 'alert', section: 'alerts', cmds: ['pstcli -output json alert show -state ACTIVE', 'pstcli alert show'] },
];

/** JSON 우선, 실패 시 CSV — 둘 다 레코드 배열로 통일한다. */
export function records(text) {
  const j = parseJsonLoose(text);
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') return [j];
  return parseCsv(text);
}

function pick(rec, ...keys) {
  for (const k of keys) {
    for (const actual of Object.keys(rec || {})) {
      if (actual.toLowerCase().replace(/[\s_]/g, '') === k.toLowerCase().replace(/[\s_]/g, '')) {
        const v = rec[actual];
        if (v !== undefined && v !== '') return v;
      }
    }
  }
  return '';
}

/** 원시 출력 → 정규화(순수). */
export function normalizePowerstoreSsh(device, out) {
  const snap = emptySnapshot(device);
  snap.extra.collectMethod = 'ssh';

  const cl = records(out.cluster || '')[0];
  if (cl) {
    snap.name = pick(cl, 'name') || device.name;
    snap.serial = pick(cl, 'global_id', 'id') || '';
    snap.extra.state = pick(cl, 'state') || '';
    snap.sections.config = 'ok';
  }
  const sw = records(out.sw || '')[0];
  if (sw) snap.version = pick(sw, 'release_version', 'build_version') || '';

  // 물리 용량 — space_metrics 는 시계열이라 마지막(최신) 점을 쓴다(REST 수집기와 같은 규칙).
  const pts = records(out.space || '');
  const pt = pts.length ? pts[pts.length - 1] : null;
  if (pt) {
    const total = toBytes(pick(pt, 'physical_total'));
    const used = toBytes(pick(pt, 'physical_used'));
    if (total) {
      snap.capacity = { totalBytes: total, usedBytes: used, pct: Math.round((used / total) * 1000) / 10 };
      snap.sections.capacity = 'ok';
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      snap.extra.space = {
        physicalTotal: total, physicalUsed: used,
        logicalUsed: toBytes(pick(pt, 'logical_used')) || null,
        logicalProvisioned: toBytes(pick(pt, 'logical_provisioned')) || null,
        dataReduction: num(pick(pt, 'data_reduction')),
        thinSavings: num(pick(pt, 'thin_savings')),
        snapshotSavings: num(pick(pt, 'snapshot_savings')),
        at: pick(pt, 'timestamp') || null,
      };
    }
  }

  const appliances = records(out.appliance || '');
  if (appliances.length) {
    snap.extra.appliances = appliances.slice(0, 8).map((a) => ({
      name: pick(a, 'name'), model: pick(a, 'model'), serviceTag: pick(a, 'service_tag'),
    }));
  }

  const nodes = records(out.node || '');
  if (nodes.length) {
    snap.nodes = {
      count: nodes.length, unhealthy: 0,
      list: nodes.slice(0, 64).map((n, i) => ({
        id: i + 1, ip: '', health: 'unknown', inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0,
        name: pick(n, 'name') || (pick(n, 'slot') !== '' ? `slot ${pick(n, 'slot')}` : pick(n, 'id')),
      })),
    };
    snap.sections.nodes = 'ok';
  }

  const users = records(out.user || '');
  if (users.length) {
    snap.accounts = users.slice(0, 200)
      .map((u) => ({ name: pick(u, 'name', 'id'), enabled: String(pick(u, 'is_locked')).toLowerCase() !== 'true' }))
      .filter((u) => u.name);
    snap.sections.accounts = 'ok';
  }

  if (out.alert != null) {
    const alerts = records(out.alert || '');
    snap.alerts.unresolved = alerts.length;
    const bySeverity = {};
    for (const a of alerts) { const k = String(pick(a, 'severity') || 'Unknown'); bySeverity[k] = (bySeverity[k] || 0) + 1; }
    snap.extra.alertsBySeverity = bySeverity;
    snap.sections.alerts = 'ok';
  }

  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = 'pstcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다(연결 테스트의 원문 확인).';
  return snap;
}

export async function collectViaSsh(device) {
  let raw = [];
  try {
    const r = await runCliSession(device, SPECS);
    raw = r.raw;
    const snap = normalizePowerstoreSsh(device, r.out);
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
