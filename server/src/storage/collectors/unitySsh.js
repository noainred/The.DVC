/**
 * storage/collectors/unitySsh.js — Dell Unity SSH(uemcli) 수집기(v2.405, 사용자 요구).
 *
 * Unity 는 SP 에 SSH 로 접속해 `uemcli` 를 실행할 수 있다. uemcli 는 `-output csv` 로
 * **기계가 읽기 좋은 CSV** 를 내주므로 그것을 1순위로 쓰고, 없으면 기본(Key = Value) 출력을
 * 파싱한다(버전차 폴백).
 *
 * ⚠ 실장비 미검증: 명령 이름은 Unisphere CLI 문서 기준이지만 버전마다 필드명이 다를 수 있다.
 *   그래서 파싱 실패를 숨기지 않고 섹션 오류로 남기며, 각 명령의 **원문 앞부분**을 extra.cliRaw
 *   에 보관해 등록 화면 '연결 테스트'에서 그대로 확인할 수 있게 한다(cliSsh.js 머리말 참고).
 */

import { emptySnapshot } from '../types.js';
import { runCliSession, parseCsv, parseKeyValueBlocks, toBytes, sshFailureSnapshot } from './cliSsh.js';

/** uemcli 는 -output csv 를 지원한다. 지원하지 않는 버전을 위해 기본 출력도 후보로 둔다. */
const SPECS = [
  { key: 'system', section: 'config', required: true, cmds: ['uemcli -output csv /sys/general show', 'uemcli /sys/general show'] },
  { key: 'capacity', section: 'capacity', cmds: ['uemcli -output csv /metrics/value/rt -path sp.*.storage.summary.* show', 'uemcli -output csv /stor/config/pool show', 'uemcli /stor/config/pool show'] },
  { key: 'pools', section: 'pools', cmds: ['uemcli -output csv /stor/config/pool show', 'uemcli /stor/config/pool show'] },
  { key: 'sps', section: 'nodes', cmds: ['uemcli -output csv /env/sp show', 'uemcli /env/sp show'] },
  { key: 'users', section: 'accounts', cmds: ['uemcli -output csv /user/account show', 'uemcli /user/account show'] },
  { key: 'alerts', section: 'alerts', cmds: ['uemcli -output csv /event/alert/hist show -active', 'uemcli /event/alert/hist show -active'] },
];

/** CSV 우선, 실패 시 Key=Value 블록으로 — 둘 다 레코드 배열을 돌려준다. */
function records(text) {
  const csv = parseCsv(text);
  if (csv.length) return csv;
  return parseKeyValueBlocks(text);
}

/** 여러 후보 키 중 처음 존재하는 값(버전마다 헤더명이 달라서 필요). */
function pick(rec, ...keys) {
  for (const k of keys) {
    for (const actual of Object.keys(rec || {})) {
      if (actual.toLowerCase().replace(/\s+/g, '') === k.toLowerCase().replace(/\s+/g, '')) {
        const v = rec[actual];
        if (v !== undefined && v !== '') return v;
      }
    }
  }
  return '';
}

/** 원시 출력 → 정규화(순수 — 테스트가 이 함수를 고정한다). */
export function normalizeUnitySsh(device, out) {
  const snap = emptySnapshot(device);
  snap.extra.collectMethod = 'ssh';

  const sys = records(out.system || '')[0];
  if (sys) {
    snap.name = pick(sys, 'Name', 'System name') || device.name;
    snap.serial = pick(sys, 'ID', 'Serial number', 'Product serial number') || '';
    snap.extra.model = pick(sys, 'Model', 'Platform') || '';
    snap.version = pick(sys, 'Version', 'System version', 'Software version') || '';
    snap.sections.config = 'ok';
  }

  // 풀 목록에서 용량을 합산한다 — Unity 는 클러스터 단위 총량 명령이 버전마다 달라,
  // 어느 버전에나 있는 /stor/config/pool 합계를 진실의 원천으로 쓴다(정직: 풀 밖 공간은 제외).
  const pools = records(out.pools || out.capacity || '');
  const norm = [];
  let total = 0;
  let used = 0;
  for (const p of pools) {
    const name = pick(p, 'Name', 'ID');
    if (!name) continue;
    const t = toBytes(pick(p, 'Total space', 'Size total', 'Total capacity', 'Total'));
    const u = toBytes(pick(p, 'Used space', 'Size used', 'Used capacity', 'Used'));
    if (!t) continue;
    total += t; used += u;
    norm.push({ name, totalBytes: t, usedBytes: u, pct: Math.round((u / t) * 1000) / 10 });
  }
  if (norm.length) {
    snap.pools = norm.slice(0, 32);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total ? Math.round((used / total) * 1000) / 10 : null };
    snap.sections.capacity = 'ok';
    snap.sections.pools = 'ok';
  }

  const sps = records(out.sps || '');
  if (sps.length) {
    const list = sps.map((sp, i) => {
      const health = (pick(sp, 'Health state', 'Health', 'State') || '').toLowerCase();
      return {
        id: i + 1, ip: pick(sp, 'IP address', 'Address') || '',
        health: health ? (/ok|normal|healthy/.test(health) ? 'ok' : health) : 'unknown',
        inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0,
        name: pick(sp, 'Name', 'ID') || `SP${i}`,
      };
    });
    snap.nodes = { count: list.length, unhealthy: list.filter((n) => n.health !== 'ok' && n.health !== 'unknown').length, list: list.slice(0, 64) };
    snap.sections.nodes = 'ok';
  }

  const users = records(out.users || '');
  if (users.length) {
    snap.accounts = users.slice(0, 200)
      .map((u) => ({ name: pick(u, 'Name', 'ID'), enabled: true, role: pick(u, 'Role') || undefined }))
      .filter((u) => u.name);
    snap.sections.accounts = 'ok';
  }

  const alerts = records(out.alerts || '');
  if (out.alerts != null) { snap.alerts.unresolved = alerts.length; snap.sections.alerts = 'ok'; }

  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = 'uemcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다(연결 테스트의 원문 확인).';
  return snap;
}

export async function collectViaSsh(device) {
  let raw = [];
  try {
    const r = await runCliSession(device, SPECS);
    raw = r.raw;
    const snap = normalizeUnitySsh(device, r.out);
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
