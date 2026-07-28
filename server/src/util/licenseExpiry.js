/**
 * 라이선스 만료일 확인 공용 헬퍼 — 특수기능 '라이선스 만료일 확인'(/tools/license-expiry).
 * 제품군 분류와 만료 상태(만료/임박/정상/영구) 계산을 순수 함수로 분리(테스트 대상).
 */

// 라이선스 이름/에디션/제품 문자열에서 제품군을 추론한다. VCF/VVF는 vSphere보다 먼저
// 검사(이름에 vSphere가 함께 들어가는 번들 키가 많음).
export function licenseFamilyOf(text) {
  const s = String(text || '').toLowerCase();
  if (/vcf|cloud foundation/.test(s)) return 'VCF';
  if (/vvf|vsphere foundation/.test(s)) return 'VVF';
  if (/nsx/.test(s)) return 'NSX';
  if (/horizon|\bview\b/.test(s)) return 'Horizon';
  if (/vsan/.test(s)) return 'vSAN';
  if (/vcenter|virtualcenter/.test(s)) return 'vCenter';
  if (/tanzu|kubernetes|supervisor/.test(s)) return 'Tanzu';
  if (/esx|vsphere/.test(s)) return 'ESXi(vSphere)';
  return '기타';
}

/**
 * 만료 시각(epoch ms|null)을 상태로 분류. 임박 기준 90일.
 * @returns {{ status:'expired'|'expiring'|'ok'|'perpetual', daysLeft:number|null }}
 */
export function licenseExpiryStatus(ts, { forcedExpired = false, now = Date.now(), soonDays = 90 } = {}) {
  if (!ts) return { status: forcedExpired ? 'expired' : 'perpetual', daysLeft: null };
  const daysLeft = Math.floor((ts - now) / 86400000);
  if (forcedExpired || ts <= now) return { status: 'expired', daysLeft };
  if (daysLeft <= soonDays) return { status: 'expiring', daysLeft };
  return { status: 'ok', daysLeft };
}
