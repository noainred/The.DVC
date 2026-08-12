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
    if (Date.now() > deadline) throw new Error('데이터스토어 탐색 시간 초과(90초) — 파일이 매우 많은 데이터스토어일 수 있습니다');
  }
}

// 60초 캐시 — 진행 중 프라미스를 캐시해 동시 클릭도 태스크 1개로 합류.
const _cache = new Map(); // dsId -> { at, promise }
const CACHE_MS = 60_000;

export function browseDatastore(dsId) {
  const hit = _cache.get(dsId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = browseFresh(dsId).catch((e) => { _cache.delete(dsId); throw e; });
  _cache.set(dsId, { at: Date.now(), promise });
  return promise;
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
        ({ files, truncated } = parseDsSearchResults(resultXml, FILE_CAP));
        files.sort((a, b) => b.sizeBytes - a.sizeBytes);
      } catch (e) { filesError = e.message; }
    } else {
      filesError = '이 데이터스토어에 브라우저 객체가 없습니다.';
    }
    return { name: ds.name, mock: false, vms, unknownVmCount, files, truncated, filesError };
  } finally {
    await c.logout().catch(() => {});
  }
}
