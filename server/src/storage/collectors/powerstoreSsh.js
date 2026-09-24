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
import { runCliSession, parseCsv, parseJsonLoose, toBytes, toBytesOrNull, sshFailureSnapshot } from './cliSsh.js';
import { numOrNull } from '../../util/numOrNull.js';
// v2.599(감사 C2599-02·03): 점 선택·미해결 판정은 REST 수집기의 코어를 그대로 쓴다(판정이 두 벌이면 갈라진다).
import { pickLatestSpacePoint, isActiveAlert } from './powerstoreCore.js';

/** 상태 필터가 없는 알람 폴백 명령(v2.599 C2599-03) — 이 명령의 출력은 CLEARED 까지 담는다. */
export const ALERT_FALLBACK_CMD = 'pstcli alert show';

const SPECS = [
  { key: 'cluster', section: 'config', required: true, cmds: ['pstcli -output json cluster show', 'pstcli -output csv cluster show', 'pstcli cluster show'] },
  { key: 'sw', cmds: ['pstcli -output json software_installed show', 'pstcli software_installed show'] },
  { key: 'appliance', section: 'pools', cmds: ['pstcli -output json appliance show', 'pstcli -output csv appliance show', 'pstcli appliance show'] },
  { key: 'space', section: 'capacity', cmds: ['pstcli -output json metrics generate -entity space_metrics_by_cluster', 'pstcli -output json space_metrics_by_cluster show'] },
  { key: 'node', section: 'nodes', cmds: ['pstcli -output json node show', 'pstcli -output csv node show', 'pstcli node show'] },
  { key: 'user', section: 'accounts', cmds: ['pstcli -output json local_user show', 'pstcli local_user show'] },
  { key: 'alert', section: 'alerts', cmds: ['pstcli -output json alert show -state ACTIVE', ALERT_FALLBACK_CMD] },
];

/** JSON 우선, 실패 시 CSV — 둘 다 레코드 배열로 통일한다. */
export function records(text) {
  const j = parseJsonLoose(text);
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') return [j];
  return parseCsv(text);
}

/**
 * 알람 출력이 '읽지 못한 것' 인가(v2.603 COL-2603-01) — 레코드 0건일 때만 부른다.
 * 빈 출력·JSON 빈 배열/객체·'No alerts' 류 문구·머리글만 있는 표는 정상 0건이다. 그 밖에 글자가 있는데 0건이면 형식 미인식이다.
 */
export function alertOutputUnread(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  const j = parseJsonLoose(t);
  if (Array.isArray(j) || (j && typeof j === 'object')) return false;
  if (/^(no\s+(alerts?|records?|items?|results?)\b|0\s+(alerts?|records?)\b)/im.test(t)) return false;
  // 머리글 한 줄뿐(구분선 제외)이면 행이 없는 표다 — 0건으로 본다. 두 줄 이상인데 0건이면 형식을 못 읽은 것이다.
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && !/^[-+=|\s]+$/.test(l));
  return lines.length > 1;
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

/**
 * 원시 출력 → 정규화(순수).
 * meta.alertCmd — 알람 항목을 실제로 읽은 명령(collectViaSsh 가 원문 기록에서 채운다). 폴백이면 화면이 밝힌다.
 */
export function normalizePowerstoreSsh(device, out, meta = {}) {
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

  // 물리 용량 — space_metrics 는 시계열이다. v2.599(감사 C2599-02): 예전 주석은 'REST 와 같은 규칙' 이라며
  //   배열의 **마지막 점**을 썼는데 REST 규칙은 그 뒤 '물리 총량이 있는 점 중 timestamp 가 가장 큰 것' 으로 바뀌었다
  //   (정렬 방향이 경로마다 다르고 최신 점은 아직 집계 전일 수 있다). 내림차순 출력이면 가장 오래된 사용량이
  //   적재됐다. 이제 pickLatestSpacePoint 하나를 쓴다 — 키 대소문자·단위 표기는 pick/toBytes 로 먼저 맞춘다.
  const pts = records(out.space || '');
  const cands = pts.map((rec) => ({ physical_total: toBytes(pick(rec, 'physical_total')), timestamp: pick(rec, 'timestamp') || '', rec }));
  const pt = pickLatestSpacePoint(cands)?.rec || null;
  if (pt) {
    const total = toBytes(pick(pt, 'physical_total'));
    const used = toBytesOrNull(pick(pt, 'physical_used'));   // v2.595: 못 읽은 사용량은 null(0 이 아니다)
    if (total) {
      snap.capacity = { totalBytes: total, usedBytes: used, pct: used == null ? null : Math.round((used / total) * 1000) / 10 };
      snap.sections.capacity = 'ok';
      const num = numOrNull;   // v2.561: 공용 판정(Number(null)===0 함정)
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
    // v2.599(감사 C2599-03): 폴백 명령(상태 필터 없음)은 CLEARED 까지 준다 — 예전에는 그것을 전부 미해결로 셌다.
    //   REST 폴백과 같은 isActiveAlert 로 거른다(state 가 없으면 '확인(acknowledged)된 것만' 뺀다 — 조용한 축소 금지).
    const all = records(out.alert || '');
    // v2.603(감사 COL-2603-01): 출력이 있는데 레코드가 0건이면 '미해결 0건' 이 아니라 '못 읽음' 이다
    //   (폴백 명령의 사람용 표 출력은 JSON·CSV 어느 쪽으로도 읽히지 않는다). 빈 JSON 배열·'없음' 문구는 정상 0건이다.
    if (!all.length && alertOutputUnread(out.alert)) {
      snap.alerts.unresolved = null;
      snap.sections.alerts = '미수집: 알람 출력 형식을 읽지 못했습니다(경보 수를 모릅니다 — 연결 테스트의 원문 확인)';
    } else {
      const alerts = all.filter((a) => isActiveAlert({
        state: pick(a, 'state'),
        is_acknowledged: String(pick(a, 'is_acknowledged', 'acknowledged')).trim().toLowerCase() === 'true',
      }));
      snap.alerts.unresolved = alerts.length;
      const fallback = meta.alertCmd === ALERT_FALLBACK_CMD;
      if (fallback || alerts.length !== all.length) {
        snap.extra.alertsNote = `${fallback ? '상태 필터 없는 명령(pstcli alert show)으로 읽어 ' : ''}전체 ${all.length}건 중 미해결 ${alerts.length}건만 집계(해제·확인 ${all.length - alerts.length}건 제외)`;
      }
      const bySeverity = {};
      for (const a of alerts) { const k = String(pick(a, 'severity') || 'Unknown'); bySeverity[k] = (bySeverity[k] || 0) + 1; }
      snap.extra.alertsBySeverity = bySeverity;
      snap.sections.alerts = 'ok';
    }
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
    const alertCmd = (r.raw || []).find((x) => x.key === 'alert' && x.ok)?.cmd || '';
    const snap = normalizePowerstoreSsh(device, r.out, { alertCmd });
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
