/**
 * GPU 호스트의 게스트 값(온도·메모리 사용·VM 동작)이 **왜 비었는지** 판정(v2.653 — 사용자 신고 "직접 연결하는 vCenter 는
 * 수집이 되고 edge 에서 수집하는 건 안되는 것 같아"). 순수 함수 — 입력은 호출부(hardwareGpu.js gatherGuestWhyCtx)가 모은다.
 *
 * ⚠ 화면이 `—` 한 글자로 덮던 원인들은 **조치가 서로 다르다**(v2.517 perfDiag 와 같은 판단):
 *   edge-no-report  엣지가 게스트 GPU 를 한 번도 보고하지 않았다 → 엣지 버전·설정 pull·CENTRAL_TOKEN 확인
 *   edge-stale      엣지 보고가 오래됐다(push 멈춤) → 엣지 로그
 *   edge-no-config  엣지는 보고하는데 이 vCenter 를 수집 대상으로 갖고 있지 않다 → 중앙에서 그 엣지에 계정 배포
 *   not-enabled     중앙 직접 수집 vCenter 인데 GPU 게스트 수집이 꺼져 있다 → 설정에서 켜기
 *   no-creds        수집 대상 VM 에 계정이 없다 → 공용/VM 계정 입력
 *   collect-failed  로그인·인증·nvidia-smi 실패 → 진단의 사유
 *   edge-old        엣지가 2.650 미만이라 온도·메모리 절대량을 보내지 않는다 → 엣지 업그레이드
 *   partial         일부 VM 만 읽었다(값은 읽은 VM 기준)
 *   unknown         근거가 없다 — 단정하지 않는다
 * 켜진 GPU VM 이 없으면 비어 있는 것이 정상이라 사유를 내지 않는다(null).
 */
import { cmpVersion } from '../util/cmpVersion.js';

/** 온도·메모리 절대량을 엣지가 보내기 시작한 버전(v2.650 gpuGuestPush). */
export const GUEST_TEMP_MIN_EDGE = '2.650.0';
/** 엣지 진단 보고가 이보다 오래되면 '멈춤' 으로 본다(엣지 push 주기 60초의 30배). */
export const EDGE_REPORT_STALE_MS = 30 * 60_000;

export const GUEST_WHY_CODES = ['edge-no-report', 'edge-stale', 'edge-no-config', 'not-enabled', 'no-creds', 'collect-failed', 'edge-old', 'partial', 'unknown'];

const FAIL_STAGES = /로그인 실패|인증 실패|예외|미등록|인벤토리 미수집/;

/**
 * @param {object} s summarizeHostGpu 결과(vmsOn·vmsRead·vmsUnread·tempC·memUsedMB)
 * @param {object|null} ctx 이 호스트 vCenter 의 수집 문맥 {mode:'site'|'direct', agent, edgeVersion, report:{receivedAt}|null,
 *   diagVc:{stage,error,counts,results}|null, enabled:boolean|null}
 * @returns {{code:string, detail?:string, agent?:string}|null}
 */
export function guestWhyOf(s, ctx, { now = Date.now() } = {}) {
  if (!s || !(s.vmsOn > 0)) return null;
  const c = ctx || {};
  const agent = c.mode === 'site' ? (c.agent || '') : '';
  const out = (code, detail) => ({ code, ...(detail ? { detail: String(detail).slice(0, 200) } : {}), ...(agent ? { agent } : {}) });
  if (s.vmsRead > 0) {
    const tempMemMissing = s.tempC == null && s.memUsedMB == null && s.memUsedPct == null;
    if (tempMemMissing && agent && c.edgeVersion && cmpVersion(c.edgeVersion, GUEST_TEMP_MIN_EDGE) < 0) return out('edge-old', c.edgeVersion);
    if (s.vmsUnread > 0) return out('partial', `${s.vmsRead}/${s.vmsOn}`);
    return null;
  }
  // 한 대도 못 읽었다 — 어디서 막혔는가
  if (c.mode === 'site') {
    if (!agent || !c.report) return out('edge-no-report');
    if (c.report.receivedAt && now - c.report.receivedAt > EDGE_REPORT_STALE_MS) return out('edge-stale', String(Math.round((now - c.report.receivedAt) / 60_000)));
    if (!c.diagVc) return out('edge-no-config');
  } else if (c.enabled === false) {
    return out('not-enabled');
  }
  const d = c.diagVc;
  if (!d) return out('unknown');
  const stage = String(d.stage || '');
  if (stage === '수집 대상 계정 없음') return out('no-creds');
  if (FAIL_STAGES.test(stage)) return out('collect-failed', d.error || stage);
  const failed = (d.results || []).find((r) => r && r.ok === false);
  if (failed) return out('collect-failed', failed.error || '');
  return out('unknown', stage);
}

/*
 * v2.680 C-06: 'collect-failed' 의 detail 은 수집 예외 원문(SSH·게스트·vCenter e.message)이다 — 'connect ECONNREFUSED 10.x.x.x:22'
 *   처럼 대상 관리 주소를 싣는다. /tools/gpu 는 tools 권한(operator 기본 보유)이라 비-admin 에게는 이 원문을 주지 않는다
 *   (v2.598 AUTHZ-2598-03 '실패 원문은 admin 만'). 코드·대상 엣지·개수는 그대로 둔다 — 화면은 사유 문구로 말한다.
 *   그 밖의 detail(엣지 버전·읽은 대수·경과 분·단계 이름)은 원문 오류가 아니므로 남긴다.
 */
export const WHY_RAW_DETAIL_CODES = Object.freeze(['collect-failed']);
export function stripWhyDetail(why) {
  if (!why || typeof why !== 'object' || !WHY_RAW_DETAIL_CODES.includes(why.code) || why.detail == null || why.detail === '') return why;
  const { detail, ...rest } = why;
  return { ...rest, detail: null, detailHidden: true };
}
/** v2.680 C-06: /tools/gpu 인벤토리 응답 — 비-admin 이면 호스트 행·배너의 오류 원문을 뺀다(원본을 바꾸지 않는다). */
export function maskGpuInventoryForUser(data, admin) {
  if (admin || !data) return data;
  return {
    ...data,
    items: (data.items || []).map((r) => (r && r.guestWhy ? { ...r, guestWhy: stripWhyDetail(r.guestWhy) } : r)),
    guestWhy: (data.guestWhy || []).map((e) => stripWhyDetail(e)),
  };
}
