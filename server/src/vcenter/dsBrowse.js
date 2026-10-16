/**
 * 데이터스토어 브라우즈 (v2.276) — 데이터스토어 상세에서 ① 어떤 VM 이 할당돼 있는지,
 * ② 실제 어떤 파일들이 있는지 보여준다.
 *
 *  - 할당 VM: Datastore 의 'vm' 속성(MoRef 목록)을 라이브 1회 조회 → 수집 스냅샷의 VM 과
 *    조인(이름/전원/호스트/클러스터). 스냅샷에 없는 ref 는 개수만 보고(방금 생성된 VM 등).
 *  - 파일: HostDatastoreBrowser.SearchDatastoreSubFolders_Task 를 던지고 태스크를 폴링해
 *    전체 폴더의 파일(크기·수정시각·유형)을 평탄화한다. 큰 데이터스토어는 수십 초 걸릴 수
 *    있어 90초 시한 + 파일 10,000개 상한(truncated 플래그)을 둔다.
 *
 * 결과는 60초 캐시(재클릭·새로고침 연타로 vCenter 에 태스크가 쌓이는 것 방지). scope 는
 * 라우트에서 vCenter 단위로 강제된 뒤 호출된다. 엣지 수집(site) vCenter 는 중앙에서 직접
 * 접속이 안 될 수 있다 — 그 경우 오류 메시지로 안내한다(추측 데이터 없음).
 */

import { VimSoapClient } from './soapClient.js';
import { parseMorefs, parseDsSearchResults } from './soapParse.js';
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { directCollectSkipReason } from './collectTarget.js';
import { vcAuthStopOf, noteVcAuthFailure, authStopView } from './authStopGate.js';

/*
 * v2.742(감사 VC-03) — 주문형 vCenter 로그인 문(gate). 데이터스토어 탐색·고아 VMDK 스캔·VM 전체 정보 내보내기·게스트 계정 추가
 * 네 경로는 등록부에서 접속 정보만 찾으면 로그인했다 — 관리자가 끈·점검중으로 둔·엣지에 위임한 vCenter 와 주 폴러가 인증 실패로
 * 멈춘 vCenter 에도 로그인이 나갔고, 거부는 정지 기록에 올라가지 않았다(재현: 가짜 vCenter 로 정지 기록의 시도 수 1 그대로).
 * 판정은 복제하지 않는다 — 직접 수집 대상은 collectTarget.js `directCollectSkipReason`, 인증 정지는 authStopGate.js 하나다.
 * 여기 있는 것은 그 둘을 '로그인 전에 막는 오류' 로 바꾸는 접착부뿐이다(사유 문장은 search/deepSearch.js PROBE_SKIP_TEXT 와 같은 뜻).
 */
export const ON_DEMAND_SKIP_TEXT = Object.freeze({
  disabled: '비활성 vCenter — 이 포탈이 로그인하지 않습니다',
  maintenance: '점검중 vCenter — 수집이 멈춰 있어 이 포탈이 로그인하지 않습니다',
  site: '엣지 위임 vCenter — 담당 엣지가 수집하므로 중앙이 직접 로그인하지 않습니다',
  invalid: 'vCenter 설정 형식이 올바르지 않습니다',
});

/**
 * 로그인 전에 막을 사유. 직접 수집 대상이 아니면 `{ skipReason, reason }`, 주 폴러가 인증 실패로 멈춘 vCenter 면
 * `{ authStopped, reason }`, 그 밖은 null. `allowAuthStopped` 면 인증 정지는 막지 않는다 — 관리자가 누른 수동 작업은
 * 1회 시도한다(authGuard 규칙 3 · v2.741 심층 검색 게스트 탐침과 같은 판단). 비활성·점검중·site 는 수동이어도 막는다
 * (collectTarget.js 머리말 '수동 실행도 이 셋은 건너뛴다').
 */
export function onDemandVcBlock(vc, { allowAuthStopped = false } = {}) {
  const why = directCollectSkipReason(vc);
  if (why) return { skipReason: why, reason: ON_DEMAND_SKIP_TEXT[why] || why };
  if (allowAuthStopped) return null;
  const stop = vcAuthStopOf(vc);
  return stop ? { authStopped: authStopView(stop), reason: stop.reason } : null;
}

/** 막는 사유 → 오류(status 409 — 재시도 대상이 아니다. 웹 fetchJson 은 502 를 재시도한다). */
export function onDemandBlockError(block) {
  const e = new Error(block.reason);
  e.status = 409;
  if (block.skipReason) e.skipReason = block.skipReason;
  if (block.authStopped) e.authStopped = block.authStopped;
  return e;
}

/** 로그인 실패 — 자격증명 거부면 주 폴러와 **같은 정지 기록**에 올리고 409 오류로 바꾼다. 그 밖(시한·연결 실패)은 원래 오류 그대로(authGuard 규칙 4). */
export function onDemandLoginError(vc, err) {
  const info = noteVcAuthFailure(vc, err);
  if (!info) return err;
  const e = new Error(info.reason);
  e.status = 409;
  e.authStopped = authStopView(info);
  e.cause = err;
  return e;
}

/** 막는 사유가 있으면 로그인하지 않고 던지고, 없으면 로그인한다(거부는 기록 · 409). */
export async function onDemandLogin(c, vc, opts) {
  const block = onDemandVcBlock(vc, opts);
  if (block) throw onDemandBlockError(block);
  try { await c.login(); } catch (err) { throw onDemandLoginError(vc, err); }
}

/** 라우트용 — 409 오류의 본문 필드(사유 코드·정지 표지). 다른 오류면 빈 객체. */
export const onDemandErrorFields = (e) => (e?.status === 409
  ? { ...(e.skipReason ? { skipReason: e.skipReason } : {}), ...(e.authStopped ? { authStopped: e.authStopped } : {}) }
  : {});

const FILE_CAP = 10_000;
const TASK_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** 데이터스토어 전체를 재귀 탐색하는 태스크를 만들고 완료까지 폴링해 result XML 을 돌려준다. */
async function searchAllFiles(c, browserRef, dsName) {
  const submit = await c.callRaw(
    `<SearchDatastoreSubFolders_Task xmlns="urn:vim25"><_this type="HostDatastoreBrowser">${escXml(browserRef)}</_this>` +
    `<datastorePath>[${escXml(dsName)}]</datastorePath>` +
    `<searchSpec><details><fileType>true</fileType><fileSize>true</fileSize><modification>true</modification><fileOwner>false</fileOwner></details></searchSpec>` +
    `</SearchDatastoreSubFolders_Task>`
  );
  const taskRef = /<returnval type="Task"[^>]*>([^<]+)<\/returnval>/.exec(submit)?.[1];
  if (!taskRef) throw new Error('데이터스토어 탐색 태스크 생성 실패');
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  for (;;) {
    await sleep(800);
    const objs = await c.retrieveObjectProps('Task', taskRef, ['info.state', 'info.result', 'info.error.localizedMessage']);
    const p = objs[0]?.props || {};
    const state = p['info.state'] || '';
    if (state === 'success') return p['info.result'] || '';
    if (state === 'error') throw new Error(p['info.error.localizedMessage'] || '데이터스토어 탐색 실패(권한/접근성 확인)');
    if (Date.now() > deadline) {
      // 시한 초과 시 vCenter 쪽 탐색 태스크를 취소(best-effort) — 취소 없이 throw 만 하면
      // 재클릭마다 고비용 재귀 탐색 태스크가 vCenter/ESXi 에 계속 누적된다(v2.277 확정 버그).
      // CancelTask 자체가 실패해도(권한·이미 종료) 시한 초과 처리는 계속한다.
      await c.callRaw(`<CancelTask xmlns="urn:vim25"><_this type="Task">${escXml(taskRef)}</_this></CancelTask>`).catch(() => {});
      throw new Error('데이터스토어 탐색 시간 초과(90초) — 파일이 매우 많은 데이터스토어일 수 있습니다');
    }
  }
}

/**
 * 60초 캐시 — 의미론(v2.277 수정):
 *  - **진행 중** 프라미스는 만료 없이 항상 합류시킨다. 이전에는 at(시작 시각) 기준 60초라
 *    탐색이 60초를 넘기면 진행 중인데도 '만료'로 판정 → 재클릭이 같은 데이터스토어에
 *    새 탐색 태스크를 또 만들고(vCenter 태스크 누적), 첫 태스크의 결과는 캐시 교체로 폐기됐다.
 *  - **완료된** 결과는 완료 시점부터 60초 유지 — 미리보기 확인 후 천천히 눌러도 재조회 없음.
 *  - 실패는 즉시 삭제(다음 클릭이 새로 시도).
 */
const _cache = new Map(); // dsId -> { at(완료 시각, 진행 중엔 0), promise, settled }
const CACHE_MS = 60_000;

/**
 * v2.605(감사 TIM2605-01): 완료 항목은 60초가 지나면 **Map 에서 지운다**. 예전에는 '만료' 로 판정만 하고 지우지
 * 않아(삭제는 실패 경로뿐) 한 번 연 데이터스토어의 결과(최대 1만 파일)가 프로세스 수명 동안 남았다 — 1,100개를
 * 한 번씩 열면 그만큼 상주한다. 조회 때 만료분을 청소하고, 완료 시 unref 타이머로도 지운다(다시 열지 않는 항목).
 */
function sweepExpired(now = Date.now()) {
  for (const [k, e] of _cache) if (e.settled && now - e.at >= CACHE_MS) _cache.delete(k);
}
/** 테스트·진단용 — 캐시 항목 수. */
export function _dsBrowseCacheSize(now) { sweepExpired(now); return _cache.size; }

/** 파일 목록의 문자열을 원문과 무관한 새 문자열로 만든다(JSON 왕복 — V8 이 새 문자열을 만든다). */
export function flattenFiles(files) {
  return JSON.parse(JSON.stringify(files));
}

export function browseDatastore(dsId) {
  sweepExpired();
  const hit = _cache.get(dsId);
  if (hit && (!hit.settled || Date.now() - hit.at < CACHE_MS)) return hit.promise;
  const entry = { at: 0, settled: false, promise: null };
  entry.promise = browseFresh(dsId)
    .then((r) => {
      entry.settled = true; entry.at = Date.now();
      const t = setTimeout(() => { if (_cache.get(dsId) === entry) _cache.delete(dsId); }, CACHE_MS);
      t.unref?.();
      return r;
    })
    .catch((e) => { if (_cache.get(dsId) === entry) _cache.delete(dsId); throw e; });
  _cache.set(dsId, entry);
  return entry.promise;
}

async function browseFresh(dsId) {
  const snap = store.get();
  const ds = (snap.datastores || []).find((d) => d.id === dsId);
  if (!ds) { const e = new Error('데이터스토어를 찾을 수 없습니다.'); e.status = 404; throw e; }
  if (snap.source === 'mock') {
    return { name: ds.name, mock: true, reason: '데모 모드 — 실제 vCenter(live) 연결 시 파일/할당 VM 이 조회됩니다.', vms: [], unknownVmCount: 0, files: [], truncated: false, filesError: '' };
  }
  const vcenterId = ds.vcenterId;
  // vc.id 에 콜론이 있을 수 있어 split(':') 금지 — 알려진 프리픽스 길이로 moref 를 잘라낸다.
  const moref = ds.id.slice(vcenterId.length + 1);
  const vcCfg = loadVcenterConfig().vcenters.find((v) => v.id === vcenterId);
  if (!vcCfg) throw new Error('vCenter 접속 정보가 없습니다 — 엣지 수집(site) vCenter 는 중앙에서 직접 조회할 수 없습니다.');

  // v2.742(감사 VC-03): 비활성·점검중·엣지 위임·인증 정지 vCenter 에는 로그인하지 않는다(409 + 사유). 거부는 같은 정지 기록에.
  //   viewer 도 부르는 주문형 조회라 v2.733 C3-01 의 주문형 성능 조회와 같은 규칙이다(정지 중 로그인 0).
  const c = new VimSoapClient(vcCfg);
  await onDemandLogin(c, vcCfg);
  try {
    const objs = await c.retrieveObjectProps('Datastore', moref, ['browser', 'vm']);
    const p = objs[0]?.props || {};

    // ① 할당 VM — MoRef 를 스냅샷 VM 과 조인.
    const vmRefs = parseMorefs(p.vm || '', 'VirtualMachine');
    const vmById = new Map((snap.vms || []).map((v) => [v.id, v]));
    const vms = vmRefs
      .map((r) => vmById.get(`${vcenterId}:${r}`))
      .filter(Boolean)
      .map((v) => ({ id: v.id, name: v.name, powerState: v.powerState, host: v.host, cluster: v.cluster, guestOS: v.guestOS, storageGB: v.storageGB }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const unknownVmCount = Math.max(0, vmRefs.length - vms.length);

    // ② 파일 — 브라우저 태스크. VM 목록은 성공했는데 파일만 실패할 수 있어(권한 등) 분리 보고.
    let files = [];
    let truncated = false;
    let filesError = '';
    if (p.browser) {
      try {
        const resultXml = await searchAllFiles(c, p.browser, ds.name);
        // 파싱은 안전상한(20만)까지 전부 → 크기순 정렬 → FILE_CAP(1만) 절단(v2.277 수정).
        // 이전에는 파싱 단계에서 '발견순 앞쪽 1만'을 자른 뒤 정렬해, 가장 큰 파일이 뒤쪽
        // 폴더에 있으면 누락된 채 UI 가 '크기순'이라고 안내했다(용량 회수 용도에서 오판 유발).
        // 20만 파일 파싱은 16ms/힙 +4MB 실측(검증 에이전트) — 이벤트 루프에 무해하다.
        ({ files, truncated } = parseDsSearchResults(resultXml, 200_000));
        files.sort((a, b) => b.sizeBytes - a.sizeBytes);
        if (files.length > FILE_CAP) { files = files.slice(0, FILE_CAP); truncated = true; }
        // v2.605(감사 TIM2605-01): 정규식·split 으로 만든 folder·name·modified 는 V8 SlicedString 이라 1만 개만 남겨도
        //   원문 SOAP XML(20만 파일이면 약 33MB)을 통째로 붙잡는다. 새 문자열로 평탄화해 원문 참조를 끊는다.
        files = flattenFiles(files);
      } catch (e) { filesError = e.message; }
    } else {
      filesError = '이 데이터스토어에 브라우저 객체가 없습니다.';
    }
    return { name: ds.name, mock: false, vms, unknownVmCount, files, truncated, filesError };
  } finally {
    await c.logout().catch(() => {});
  }
}
