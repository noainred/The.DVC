/**
 * 고아 VMDK 스캔 실행부(v2.505) — 데이터스토어 1개를 라이브 조회해 판정 모듈에 넘긴다.
 *
 * 판정 로직은 `tools/orphanVmdk.js`(순수, 테스트로 고정)에 있고 여기는 **I/O 만** 한다.
 *
 * ## 왜 온디맨드인가(상시 적재하지 않는 이유)
 *
 * 소유 집합의 원천인 `layoutEx.file` 은 이미 매 폴링에서 받고 있지만(soapClient 의 VM pathSet),
 * 경로 문자열을 스냅샷에 넣으면 5,850 VM × 파일 10~20개 = 6~12만 문자열이 된다. 스냅샷은
 * `/central/inventory` push 와 응답 캐시에서 직렬화되므로(루트 CLAUDE.md 성능 절) 그 비용을
 * **상시** 지불할 수는 없다. 이 리포트는 가끔 쓰는 것이라, 필요할 때 그 데이터스토어의 VM 만
 * 다시 읽는다 — 정상 운영 비용 0, 실행 시 SOAP 왕복 2회(+브라우저 태스크)다.
 *
 * ## 비용과 가드
 *  - `browseDatastore()` 재사용 — 60초 캐시·90초 시한·10,000 파일 상한·시한 초과 시 태스크 취소가
 *    이미 들어 있다(v2.277). 같은 데이터스토어 연타가 vCenter 에 태스크를 쌓지 않는다.
 *  - VM 소유 파일은 `retrieveManyObjectProps`(250개 청크)로 1회. 고RTT vCenter 라도 왕복 수가
 *    VM 수에 비례하지 않는다.
 *  - **동시 실행 1개**(데이터스토어별 재진입 가드) — 이 조회는 무겁다.
 */

import { VimSoapClient } from './soapClient.js';
import { parseMorefs, parseLayoutFilePaths } from './soapParse.js';
import { browseDatastore } from './dsBrowse.js';
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { ownedPathSet, findOrphanDisks, confidenceOf, SHARED_DS_WARNING } from '../tools/orphanVmdk.js';
import { withJob } from '../perf/monitor.js';

/** 데이터스토어별 진행 중 스캔(재진입 가드 — 연타가 vCenter 부하를 곱하지 않게). */
const _inflight = new Map();

export function scanOrphanDisks(dsId, opts = {}) {
  const key = `${dsId}|${Number(opts.recentHours) || 0}`;
  const hit = _inflight.get(key);
  if (hit) return hit;                                  // 진행 중이면 합류
  const p = withJob('고아 VMDK 스캔', () => scanFresh(dsId, opts))
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

async function scanFresh(dsId, { recentHours = 24 } = {}) {
  const snap = store.get();
  const ds = (snap.datastores || []).find((d) => d.id === dsId);
  if (!ds) { const e = new Error('데이터스토어를 찾을 수 없습니다.'); e.status = 404; throw e; }

  // ① 파일 목록 — 기존 브라우저 경로를 그대로 쓴다(캐시·시한·상한·태스크 취소 포함).
  const browsed = await browseDatastore(dsId);
  if (browsed.mock) {
    return {
      datastoreId: dsId, name: ds.name, vcenterId: ds.vcenterId, mock: true,
      reason: '데모 모드 — 실제 vCenter(live) 연결 시 데이터스토어 파일과 VM 소유 파일을 대조합니다.',
      disks: [], excluded: [], summary: null,
      confidence: { level: 'none', text: '데모 모드에서는 판정하지 않습니다(없는 결과를 지어내지 않습니다).' },
      sharedDatastoreWarning: SHARED_DS_WARNING, truncated: false, filesError: '',
      dsVmCount: 0, vmsQueried: 0, vmsWithLayout: 0, recentHours,
    };
  }
  if (browsed.filesError) {
    // 파일 목록이 없으면 판정 자체가 불가능하다 — 빈 결과를 '고아 0건' 으로 보여주지 않는다.
    const e = new Error(`데이터스토어 파일 목록을 읽지 못했습니다: ${browsed.filesError}`);
    e.status = 502; throw e;
  }

  // ② VM 소유 파일 — 이 데이터스토어를 쓰는 VM 의 layoutEx.file.
  const vcenterId = ds.vcenterId;
  const moref = ds.id.slice(vcenterId.length + 1);    // vc.id 에 콜론이 있어 split(':') 금지
  const vcCfg = loadVcenterConfig().vcenters.find((v) => v.id === vcenterId);
  if (!vcCfg) throw new Error('vCenter 접속 정보가 없습니다 — 엣지 수집(site) vCenter 는 중앙에서 직접 조회할 수 없습니다.');

  const c = new VimSoapClient(vcCfg);
  await c.login();
  let vmRefs = [];
  let pathLists = [];
  let vmsWithLayout = 0;
  let layoutError = '';
  try {
    const objs = await c.retrieveObjectProps('Datastore', moref, ['vm']);
    vmRefs = parseMorefs(objs[0]?.props?.vm || '', 'VirtualMachine');
    if (vmRefs.length) {
      const vmObjs = await c.retrieveManyObjectProps('VirtualMachine', vmRefs, ['layoutEx.file', 'config.files.vmPathName']);
      for (const o of vmObjs) {
        const paths = parseLayoutFilePaths(o?.props?.['layoutEx.file'] || '');
        if (paths.length) vmsWithLayout += 1;
        // vmPathName(vmx 경로)도 소유로 넣는다 — layoutEx 가 비는 순간(전원 전환 중 등)에도
        // 최소한 VM 홈 폴더의 vmx 는 소유로 잡혀 '미등록 VM' 오분류를 줄인다.
        const vmx = o?.props?.['config.files.vmPathName'];
        pathLists.push(vmx ? [...paths, vmx] : paths);
      }
    }
  } catch (e) {
    // 오류를 삼키지 않는다 — 소유 집합이 불완전하면 confidenceOf 가 '신뢰 불가' 로 내려간다.
    layoutError = e?.message || String(e);
  } finally {
    await c.logout().catch(() => {});
  }

  const owned = ownedPathSet(pathLists);
  const { disks, excluded, summary } = findOrphanDisks(browsed.files, owned, { recentHours });
  const confidence = confidenceOf({
    truncated: !!browsed.truncated,
    vmsQueried: pathLists.length,
    vmsWithLayout,
    ownedFiles: owned.size,
    dsVmCount: vmRefs.length,
  });

  return {
    datastoreId: dsId, name: ds.name, vcenterId, mock: false,
    disks, excluded, summary,
    confidence: layoutError ? { level: 'none', text: `VM 소유 파일 조회가 실패했습니다(${layoutError}) — 고아 판정을 신뢰할 수 없습니다.` } : confidence,
    sharedDatastoreWarning: SHARED_DS_WARNING,
    truncated: !!browsed.truncated,
    filesError: '',
    layoutError,
    dsVmCount: vmRefs.length,
    vmsQueried: pathLists.length,
    vmsWithLayout,
    ownedFiles: owned.size,
    totalFiles: browsed.files.length,
    recentHours,
  };
}
