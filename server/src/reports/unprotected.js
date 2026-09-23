/**
 * 미보호 VM 리포트(백업 공백 탐지) — 별도 백업 솔루션 연동 없이, vCenter 이벤트에 남는
 * 백업 소프트웨어의 흔적으로 판정한다: Veeam/Commvault/NetBackup 등은 백업 시 서비스 계정으로
 * VM 스냅샷을 생성·삭제하므로, 조회 기간 내 '백업 계정의 스냅샷 이벤트'가 관측된 VM을
 * 보호(protected)로 본다. 휴리스틱임을 리포트에 명시한다(이벤트 보관 기간·계정 패턴 의존).
 */

export const DEFAULT_BACKUP_PATTERNS = ['veeam', 'backup', 'commvault', 'netbackup', 'nbu', 'avamar', 'rubrik', 'cohesity', 'networker', 'vranger', 'nakivo'];

/** 이벤트 1건이 '백업 소프트웨어의 스냅샷 작업'인지 — user 또는 message에 패턴 매칭. */
export function isBackupEvent(row, patterns = DEFAULT_BACKUP_PATTERNS) {
  if (!/Snapshot/i.test(row.type || '')) return false;
  const hay = `${row.user || ''} ${row.message || ''}`.toLowerCase();
  return patterns.some((p) => p && hay.includes(String(p).toLowerCase()));
}

/**
 * vms: 스냅샷 VM 배열. rows: 조회 기간의 스냅샷 이벤트(logs db). 반환: 보호/미보호 분류.
 * opts: { patterns, lookbackDays }
 */
export function computeUnprotected(vms, rows, opts = {}) {
  const patterns = (opts.patterns && opts.patterns.length ? opts.patterns : DEFAULT_BACKUP_PATTERNS)
    .map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  const lookbackDays = Number(opts.lookbackDays) || 7;

  // (vCenter, VM 이름) → 마지막 백업 이벤트 시각.
  // ⚠ v2.583 감사 #21: 예전에는 **이름만** 키로 써서, 28개 법인 중 한 곳의 `web-01` 이 백업되면 다른 법인의
  //   같은 이름 VM 까지 '보호됨' 으로 셌다 — 백업 공백을 찾는 리포트가 공백을 **숨겼다**(가장 나쁜 방향의 오류).
  //   이벤트 행에 vcenterId 가 있으면 반드시 그것까지 맞춘다. vcenterId 가 없는 옛 행만 이름으로 폴백하고
  //   그 개수를 밝힌다(nameOnlyEvents).
  const key = (vc, name) => `${vc}\u0000${name}`;
  const protectedByVcName = new Map();
  const protectedByNameOnly = new Map();
  let backupEvents = 0, nameOnlyEvents = 0;
  const keep = (m, k, r) => { const prev = m.get(k); if (!prev || r.ts > prev.ts) m.set(k, { ts: r.ts, user: r.user || '' }); };
  for (const r of rows || []) {
    if (!isBackupEvent(r, patterns)) continue;
    backupEvents++;
    const name = r.entity || '';
    if (!name) continue;
    if (r.vcenterId) keep(protectedByVcName, key(r.vcenterId, name), r);
    else { nameOnlyEvents++; keep(protectedByNameOnly, name, r); }
  }

  const unprotectedList = [];
  const protectedList = [];
  for (const v of vms) {
    if (v.template || v.powerState !== 'POWERED_ON') continue; // 가동 중 VM만 보호 대상 판단
    const hit = protectedByVcName.get(key(v.vcenterId, v.name)) || protectedByNameOnly.get(v.name);
    const item = {
      id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host || '', cluster: v.cluster || '',
      guestOS: v.guestOS || '', storageGB: v.storageGB || 0,
    };
    if (hit) protectedList.push({ ...item, lastBackupTs: hit.ts, backupUser: hit.user });
    else unprotectedList.push(item);
  }
  unprotectedList.sort((a, b) => b.storageGB - a.storageGB);
  protectedList.sort((a, b) => b.lastBackupTs - a.lastBackupTs);

  return {
    config: { patterns, lookbackDays },
    summary: {
      scannedVms: unprotectedList.length + protectedList.length,
      protectedCount: protectedList.length,
      unprotectedCount: unprotectedList.length,
      backupEvents,
      nameOnlyEvents,
      // 이벤트 조회 상한에 걸렸으면 오래된 백업 흔적이 빠져 '미보호' 가 과대 보고될 수 있다 — 조용히 두지 않는다.
      eventsTruncated: Number(opts.rowLimit) > 0 && (rows || []).length >= Number(opts.rowLimit),
      protectedPct: (unprotectedList.length + protectedList.length) > 0
        ? Math.round((protectedList.length / (unprotectedList.length + protectedList.length)) * 100) : 0,
    },
    unprotected: unprotectedList.slice(0, 1000),
    protected: protectedList.slice(0, 1000),
    note: '휴리스틱 판정: 조회 기간 내 백업 계정 패턴의 VM 스냅샷 이벤트가 관측된 VM을 보호로 간주합니다. 스냅샷을 쓰지 않는 백업(에이전트 방식 등)은 미보호로 보일 수 있습니다.',
  };
}
