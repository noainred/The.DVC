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

export function browseDatastore(dsId) {
  const hit = _cache.get(dsId);
  if (hit && (!hit.settled || Date.now() - hit.at < CACHE_MS)) return hit.promise;
  const entry = { at: 0, settled: false, promise: null };
  entry.promise = browseFresh(dsId)
    .then((r) => { entry.settled = true; entry.at = Date.now(); return r; })
    .catch((e) => { _cache.delete(dsId); throw e; });
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

  const c = new VimSoapClient(vcCfg);
  await c.login();
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
      } catch (e) { filesError = e.message; }
    } else {
      filesError = '이 데이터스토어에 브라우저 객체가 없습니다.';
    }
    return { name: ds.name, mock: false, vms, unknownVmCount, files, truncated, filesError };
  } finally {
    await c.logout().catch(() => {});
  }
}
