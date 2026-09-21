/**
 * Ping 모니터링 추이의 '측정 데이터 없음' 사유 판정(v2.575 BUG-16).
 *
 * v2.574 까지 이 자리는 **한 문구**였다 — "이 기간에 측정 데이터가 없습니다.
 * 잠시 후 자동 측정되면 표시됩니다." 그런데 그 한 문장이 **행동이 정반대인 상황들**을 덮었다:
 *  - 대상이 **비활성**(`enabled:false`)  → 폴러가 그 대상을 아예 건너뛴다. **기다려도 안 된다.**
 *  - **폴러 전역 꺼짐**(`PING_MON_ENABLED=false`) → 어떤 대상도 측정되지 않는다. 기다려도 안 된다.
 *  - 측정은 되는데 **조회 기간 밖**(마지막 측정이 이 기간보다 오래됐다) → 기간을 넓히면 보인다.
 *  - 정말 **첫 측정 대기** → 기다리면 채워진다.
 * 루트 CLAUDE.md v2.509('수집 대기로 뭉개지 말 것 — 화면이 기다리면 되는지를 말해야 한다')와
 * v2.517 `perfDiagText` 가 같은 규약이다. **한 문구로 되돌리지 말 것.**
 *
 * 판정 순서가 계약이다 — '기다리면 된다'(`waiting`)는 **실패 판정들 뒤**에 둔다.
 * 실패가 있는데 '기다리세요' 라고 말하면 거짓이다.
 */

/** ms 를 사람이 읽는 주기로. 숫자를 문구에 박지 않기 위한 것이므로 값이 없으면 null. */
function everyText(intervalMs) {
  const n = Number(intervalMs);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 60_000) return `${Math.round(n / 1000)}초`;
  return `${Math.round(n / 60_000)}분`;
}

/**
 * @param {object} a
 * @param {object|null} a.target   선택된 대상(status 행). `enabled` 를 본다.
 * @param {boolean|undefined} a.monitorEnabled  폴러 전역 스위치(모르면 undefined — 단정하지 않는다)
 * @param {number|null} a.intervalMs            폴러 주기(모르면 null)
 * @param {number|null} a.lastTs                그 대상의 마지막 측정 시각(epoch ms)
 * @param {number|null} a.rangeMs               조회 기간
 * @param {number} [a.now]
 * @returns {{kind:string, waiting:boolean, text:string}}
 */
export function pingEmptyReason({ target, monitorEnabled, intervalMs, lastTs, rangeMs, now = 0 } = {}) {
  const every = everyText(intervalMs);
  const cadence = every ? ` 측정 주기는 ${every}입니다.` : '';

  if (monitorEnabled === false) {
    return {
      kind: 'monitor-off', waiting: false,
      text: '**Ping 모니터가 꺼져 있어** 측정이 이뤄지지 않습니다 — 기다려도 채워지지 않습니다. 서버의 ‘PING_MON_ENABLED’ 설정을 확인하세요.',
    };
  }
  if (target && target.enabled === false) {
    return {
      kind: 'target-disabled', waiting: false,
      text: '이 대상은 **비활성** 상태라 측정하지 않습니다 — 기다려도 채워지지 않습니다. ‘수정’ 에서 사용함으로 바꾸세요.',
    };
  }

  const t = Number(lastTs);
  const hasLast = Number.isFinite(t) && t > 0;
  const r = Number(rangeMs);
  if (hasLast && Number.isFinite(r) && r > 0 && now > 0 && t < now - r) {
    return {
      kind: 'out-of-range', waiting: false,
      text: '측정은 되고 있지만 **마지막 측정이 이 조회 기간보다 오래됐습니다** — 위에서 기간을 넓히면 보입니다.',
    };
  }
  if (hasLast) {
    return {
      kind: 'gap', waiting: true,
      text: `이 기간에는 측정값이 없습니다(측정 자체는 동작 중입니다).${cadence}`,
    };
  }
  return {
    kind: 'first', waiting: true,
    text: `아직 **첫 측정 전**입니다 — 잠시 후 자동 측정되면 표시됩니다.${cadence}`,
  };
}

export default pingEmptyReason;
