/**
 * 무거운 내보내기의 **동시 실행 1건 가드** — 단일 소스(v2.575).
 *
 * ⚠⚠ **왜 필요한가 — 실측 재현(v2.575 전수 감사).** `GET /api/tools/ipam.xlsx` 는 exceljs 로
 * IP 원장 전체를 **메모리에 워크북으로 조립**한 뒤 직렬화한다. 가드가 없어 한 사용자가 연타하면
 * 그만큼 동시에 쌓인다. 목 데이터(28 vCenter) 실측:
 *   · 순차 80회 → RSS 1.56GB → **2.62GB** (요청당 ~13MB 누적, 유휴 60초 뒤 728MB 로 회수 — **누수는 아니다**)
 *   · **동시 5개 → 728MB → 2.45GB**(요청 하나가 순간 ~344MB)
 *   · 전수 퍼징 중 실제로 **`FATAL ERROR: Ineffective mark-compacts near heap limit` 로 프로세스가 죽었다**(8GB).
 * 즉 **`tools` 권한만 있는 계정**(operator 는 기본 보유)이 동시 요청 수십 개로 중앙 포탈을
 * 내릴 수 있었다. 가용성 취약점이다.
 *
 * 형제 라우트 `GET /api/tools/waste/export` 는 v2.500 부터 같은 가드를 **이미** 갖고 있었다
 * (`wasteExportBusy`). 그 20줄을 복사하면 다음 내보내기에서 또 빠진다 — 코어는 하나다.
 *
 * ⚠ 진행자 계정명은 **본인일 때만** 밝힌다(v2.500 감사 L-2) — `tools` 권한 계정이 연타해
 * 관리자 로그인 ID 를 알아내는 계정 열거 단서였다.
 * ⚠ `release()` 는 반드시 `finally` 에서 부른다 — 예외로 빠져나가면 그 이름이 영영 잠긴다.
 */

const busy = new Map(); // name -> { user, at }

/** 지금 이 이름이 점유 중인가(진단·테스트용). */
export const exportBusyOf = (name) => busy.get(name) || null;

/**
 * 점유를 시도한다.
 * @returns {{ok:true, release:()=>void} | {ok:false, status:409, body:object}}
 */
export function acquireExport(name, req) {
  const cur = busy.get(name);
  if (cur) {
    const sec = Math.round((Date.now() - cur.at) / 1000);
    const mine = cur.user && cur.user === (req?.user?.username || '');
    const who = mine ? '내 요청' : '다른 사용자';
    return {
      ok: false,
      status: 409,
      body: { ok: false, error: 'export_busy', reason: `다른 내보내기가 진행 중입니다(${who} · ${sec}초 경과). 끝난 뒤 다시 시도하세요.` },
    };
  }
  const token = { user: req?.user?.username || '', at: Date.now() };
  busy.set(name, token);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      if (busy.get(name) === token) busy.delete(name);
    },
  };
}

/** 테스트 전용 — 모든 점유를 푼다. */
export function _resetExportBusy() { busy.clear(); }
