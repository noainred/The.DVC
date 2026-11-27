/**
 * mock/demo/svcinv.js — 데모(DATA_SOURCE=mock) 서비스 인벤토리(v3.31.0, 사용자 요청 "서비스 인벤토리 목업 데이터 만들어줘, 중요한 기능이야").
 *
 * 예전 데모에서는 서비스 인벤토리가 통째로 비어 있었다(서비스 0 · 전 구성원 미지정). 여기서 **비어 있는 저장소에만** 한 번
 * 실제 사람이 만들 법한 트리·규칙을 넣는다 — 판정은 제품 코어(`servicemap/resolve.js`)가 그대로 한다(데모가 소속을 지어 넣지 않는다):
 *   · 전역 카탈로그 15개(ERP · MES · 웹 포털 · 데이터 플랫폼 · 쿠버네티스 · AI 학습 · HPC 해석 · WMS · 대외 서비스(DMZ) · 네트워크·보안 ·
 *     스토리지 · 백업 · 모니터링·로그 · 개발·테스트 · 인프라 공통) — 법인 서비스가 globalId 로 묶여 커버리지 매트릭스가 채워진다.
 *   · 법인(vCenter)마다 폴더 6개 · 그 법인에 구성원이 있는 서비스 · vCenter 폴더 규칙(VM — 목 생성기 VM_FOLDERS) ·
 *     태그 별칭(전역 카테고리 'Owner-Team' — 'Discovered virtual machine' 폴더 VM 이 태그로 정해진다) ·
 *     이름 규칙(베어메탈 — 이름의 '-역할' 토큰, 다른 서비스끼리 겹치지 않게 골랐다 — 겹치면 ruleOverlap 검토 큐가 된다).
 *   · 고정 몇 건(3개 법인) — 드리프트(고정 ≠ 자동) · '고정 유지'(reviewedAuto) · 불필요한 고정(고정 = 자동) · 미지정 VM 수동 연결.
 *   · 일부러 남기는 것: 'Discovered virtual machine' 폴더의 Owner-Team 태그 없는 VM(미지정 큐) · 법인 귀속 없는 앱 서버 2대((법인 미지정)).
 *
 * 규칙(flags.js 머리말): mock 모드에서만 · 저장소가 손상이 아니고 **법인·전역·고정이 모두 비어 있을 때만** · 목 vCenter 법인만 ·
 * 사람이 만든 트리가 있으면 아무것도 하지 않는다. VM 키 규칙은 라우트의 `vmKeyOf` 를 주입받는다(키 판정 복제 금지).
 */
import { isMockMode } from './flags.js';
import { demoBareMetalSpecs } from './idrac.js';
import { isMockVcenter } from '../generator.js';
import { peekMap, peekPins, storeLoadError, mutateMap, mutatePins } from '../../servicemap/store.js';

const DAY = 86_400_000;

/** 전역 카탈로그(id 는 결정적 — 테스트·재기동에 같게). path = 법인 트리의 폴더. */
export const DEMO_GLOBALS = Object.freeze([
  { id: 'g_demo_erp', name: 'ERP', tier: 1, owner: '경영지원 IT', note: 'SAP S/4HANA · 회계·구매·영업', path: '업무' },
  { id: 'g_demo_mes', name: 'MES', tier: 1, owner: '제조 IT', note: '생산 관리 · 설비 연동(SCADA)', path: '생산' },
  { id: 'g_demo_wms', name: 'WMS', tier: 2, owner: 'SCM IT', note: '물류 창고 관리', path: '생산' },
  { id: 'g_demo_web', name: '웹 포털', tier: 2, owner: '디지털채널팀', note: '대표 홈페이지 · 고객 포털', path: '대외' },
  { id: 'g_demo_dmz', name: '대외 서비스(DMZ)', tier: 2, owner: '정보보안팀', note: '협력사 연계 · 파일 전송', path: '대외' },
  { id: 'g_demo_dw', name: '데이터 플랫폼', tier: 2, owner: '데이터팀', note: 'DW · BI · 운영 DB', path: '업무' },
  { id: 'g_demo_k8s', name: '쿠버네티스 플랫폼', tier: 2, owner: '플랫폼팀', note: '사내 컨테이너 플랫폼', path: '플랫폼' },
  { id: 'g_demo_ai', name: 'AI 학습 플랫폼', tier: 2, owner: 'AI 센터', note: 'GPU 학습 클러스터', path: '플랫폼' },
  { id: 'g_demo_hpc', name: 'HPC 해석', tier: 2, owner: '연구소 IT', note: '구조·유동 해석 클러스터', path: '플랫폼' },
  { id: 'g_demo_net', name: '네트워크·보안 인프라', tier: 3, owner: '인프라팀', note: 'DNS · 방화벽 관리 · 프록시', path: '인프라' },
  { id: 'g_demo_stor', name: '스토리지 인프라', tier: 3, owner: '인프라팀', note: '파일 서버 · 스토리지 게이트웨이', path: '인프라' },
  { id: 'g_demo_bkp', name: '백업 인프라', tier: 3, owner: '인프라팀', note: '백업 미디어 서버', path: '인프라' },
  { id: 'g_demo_mon', name: '모니터링·로그', tier: 3, owner: '운영팀', note: '로그 수집 · 관제', path: '인프라' },
  { id: 'g_demo_infra', name: '인프라 공통', tier: 3, owner: '인프라팀', note: '공용 관리 서버', path: '인프라' },
  { id: 'g_demo_dev', name: '개발·테스트', tier: 3, owner: '개발팀', note: '개발 · QA 환경', path: '개발' },
]);
const FOLDERS = ['업무', '생산', '대외', '플랫폼', '인프라', '개발'];

/** vCenter 폴더 규칙(VM) — 목 생성기 VM_FOLDERS 의 경로. 'Discovered virtual machine' 은 일부러 규칙이 없다(태그 · 미지정 시연). */
const VM_FOLDER_RULES = [
  ['/Production/Web', 'g_demo_web'], ['/Production/App', 'g_demo_erp'], ['/Production/DB', 'g_demo_dw'],
  ['/Infrastructure/Network', 'g_demo_net'], ['/Infrastructure/Storage', 'g_demo_stor'],
  ['/Test/QA', 'g_demo_dev'], ['/Dev', 'g_demo_dev'], ['/DMZ', 'g_demo_dmz'],
];
/** 태그 별칭(카테고리 Owner-Team) — 목 생성기 tagInv 의 값. */
export const DEMO_TAG_CATEGORY = 'Owner-Team';
const TAG_ALIASES = [['Platform', 'g_demo_infra'], ['App', 'g_demo_erp']];
/**
 * 이름 규칙(베어메탈 — 'bm-<도시>-<역할><NN>'). '포함' 하나로 고르되 **다른 서비스끼리 서로 포함하지 않게** 골랐다
 * ('-db' 는 '-mesdb'·'-hanadb'·'-wmsdb' 에 걸리지 않는다 — 앞 글자가 '-' 가 아니다 · '-log0' 은 '-login' 에 걸리지 않는다).
 * VM 이름('<역할>-<사이트>-NNNN')에는 걸리지 않는다(역할이 맨 앞이라 앞에 '-' 가 없다).
 */
const BM_NAME_RULES = [
  ['-hanadb', 'g_demo_erp', 'hanadb'], ['-db', 'g_demo_dw', 'db'], ['-app', 'g_demo_erp', 'app'], ['-k8s', 'g_demo_k8s', 'k8s'],
  ['-bkp', 'g_demo_bkp', 'bkp'], ['-log0', 'g_demo_mon', 'log'], ['-web', 'g_demo_web', 'web'], ['-stor', 'g_demo_stor', 'stor'],
  ['-mes', 'g_demo_mes', 'mes'], ['-scada', 'g_demo_mes', 'scada'], ['-aigpu', 'g_demo_ai', 'aigpu'], ['-gpu', 'g_demo_ai', 'gpu'],
  ['-hpc', 'g_demo_hpc', 'hpc'], ['-login', 'g_demo_hpc', 'login'], ['-wms', 'g_demo_wms', 'wms'],
];
/** 베어메탈 이름 → 역할 토큰('bm-ulsan-mesdb01' → 'mesdb'). */
const roleOfBm = (name) => (/-([a-z0-9]+?)\d+$/.exec(String(name || '')) || [])[1] || '';
/** 그 역할을 받는 이름 규칙 — 역할 토큰이 규칙 값을 포함하는가(BM_NAME_RULES 의 셋째 칸은 대표 역할). */
const ruleForRole = (role) => BM_NAME_RULES.find(([v]) => `-${role}0`.includes(v) || `-${role}`.includes(v)) || null;

const svcIdOf = (vc, g) => `s_demo_${g.slice(7)}_${String(vc).replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;
/** 고정을 둘 법인(앞 3곳) — 화면의 드리프트 · 불필요한 고정 · 고정 유지 시연. */
const PIN_CORPS = ['vc-ap-northeast', 'vc-us-east', 'vc-eu-central'];

let _done = false;
/** 시드 결과(상태 확인용). */
let _last = null;
export function svcInvDemoStatus() { return _last; }
export function _resetSvcInvDemoForTest() { _done = false; _last = null; }

/**
 * 비어 있으면 데모 트리·규칙·고정을 넣는다(동기 — 라우트의 loadState 첫머리에서 부른다).
 * @param {object} snapshot 메인 스냅샷
 * @param {{ vmKeyOf:(vm)=>{key:string} }} deps 라우트의 키 규칙(복제 금지)
 */
export function ensureSvcInvDemo(snapshot, { vmKeyOf } = {}) {
  if (_done || !isMockMode()) return _last;
  const vcs = (snapshot?.vcenters || []).filter((v) => v?.id && isMockVcenter(v));
  if (!vcs.length || typeof vmKeyOf !== 'function') return null;   // 스냅샷 아직 — 다음 요청에 다시
  _done = true;
  if (storeLoadError()) { _last = { skipped: 'store-unreadable' }; return _last; }
  const map = peekMap();
  if (Object.keys(map.corps || {}).length || (map.globals || []).length || Object.keys(peekPins() || {}).length) { _last = { skipped: 'not-empty' }; return _last; }

  // 법인별로 구성원이 있는 서비스 — VM 은 모든 법인에 폴더 규칙 서비스 전부, 베어메탈은 그 법인 서버의 역할에서
  const bmByCorp = new Map();
  for (const s of demoBareMetalSpecs(snapshot)) {
    if (!s.vcenterId) continue;
    if (!bmByCorp.has(s.vcenterId)) bmByCorp.set(s.vcenterId, new Set());
    bmByCorp.get(s.vcenterId).add(roleOfBm(s.name));
  }
  const corpGlobals = new Map();
  for (const vc of vcs) {
    const set = new Set([...VM_FOLDER_RULES.map(([, g]) => g), ...TAG_ALIASES.map(([, g]) => g)]);
    for (const role of bmByCorp.get(vc.id) || []) { const r = ruleForRole(role); if (r) set.add(r[1]); }
    corpGlobals.set(vc.id, set);
  }
  const usedGlobals = new Set([...corpGlobals.values()].flatMap((s) => [...s]));

  const r = mutateMap((d) => {
    d.settings = { ...(d.settings || {}), tagCategory: DEMO_TAG_CATEGORY };
    d.globals = DEMO_GLOBALS.filter((g) => usedGlobals.has(g.id)).map(({ path: _p, ...g }) => ({ ...g }));
    d.corps = d.corps || {};
    for (const vc of vcs) {
      const gs = corpGlobals.get(vc.id);
      const services = DEMO_GLOBALS.filter((g) => gs.has(g.id)).map((g) => ({ id: svcIdOf(vc.id, g.id), name: g.name, path: g.path, tier: g.tier, owner: g.owner, note: g.note, globalId: g.id }));
      const sid = (g) => (gs.has(g) ? svcIdOf(vc.id, g) : null);
      d.corps[vc.id] = {
        folders: FOLDERS.filter((f) => services.some((s) => s.path === f)),
        services,
        folderRules: VM_FOLDER_RULES.filter(([, g]) => sid(g)).map(([prefix, g]) => ({ prefix, serviceId: sid(g) })),
        aliases: TAG_ALIASES.filter(([, g]) => sid(g)).map(([value, g]) => ({ kind: 'tag', value, serviceId: sid(g) })),
        nameRules: BM_NAME_RULES.filter(([, g, role]) => sid(g) && [...(bmByCorp.get(vc.id) || [])].some((x) => ruleForRole(x)?.[2] === role))
          .map(([value, g]) => ({ match: 'contains', value, serviceId: sid(g) })),
        bmFolderRules: [],
        tagEnabled: true,
      };
    }
    return { result: { corps: vcs.length } };
  });
  if (!r.ok) { _last = { skipped: 'map-write-failed', error: r.error }; return _last; }

  // 고정 — 3개 법인 × (드리프트 2 · 고정 유지 1 · 불필요 1 · 미지정 수동 연결 2)
  const now = Date.now();
  const pins = {};
  const vmsOf = (vc) => (snapshot.vms || []).filter((v) => v.vcenterId === vc && !v.template && v.powerState === 'POWERED_ON');
  const teamTagged = (vc, vm) => {
    const inv = vcs.find((v) => v.id === vc)?.tagInv;
    const idx = inv?.vmTags?.[vm.name] || [];
    return idx.some((i) => inv.categories?.[inv.tags?.[i]?.cat]?.name === DEMO_TAG_CATEGORY);
  };
  for (const vc of PIN_CORPS.filter((x) => corpGlobals.has(x))) {
    const vms = vmsOf(vc);
    const dev = vms.filter((v) => v.folderPath === '/Dev').slice(0, 3);
    const web = vms.filter((v) => v.folderPath === '/Production/Web').slice(0, 1);
    const lost = vms.filter((v) => v.folderPath === '/Discovered virtual machine' && !teamTagged(vc, v)).slice(0, 2);
    const at = (k) => now - (3 + k) * DAY;
    dev.forEach((vm, i) => {
      const p = { serviceId: svcIdOf(vc, 'g_demo_erp'), corp: vc, by: 'demo', at: at(i), reviewed: false };
      if (i === 2) Object.assign(p, { reviewed: true, reviewedAuto: svcIdOf(vc, 'g_demo_dev') });   // '고정 유지' — 같은 드리프트는 다시 묻지 않는다
      pins[vmKeyOf(vm).key] = p;
    });
    web.forEach((vm, i) => { pins[vmKeyOf(vm).key] = { serviceId: svcIdOf(vc, 'g_demo_web'), corp: vc, by: 'demo', at: at(5 + i), reviewed: false }; });   // 불필요한 고정(= 자동)
    lost.forEach((vm, i) => { pins[vmKeyOf(vm).key] = { serviceId: svcIdOf(vc, 'g_demo_infra'), corp: vc, by: 'demo', at: at(7 + i), reviewed: false }; });   // 미지정 VM 수동 연결
  }
  const pr = Object.keys(pins).length ? mutatePins((d) => { for (const [k, v] of Object.entries(pins)) d.pins[k] = v; return {}; }) : { ok: true };
  _last = { seeded: true, corps: vcs.length, globals: usedGlobals.size, pins: pr.ok ? Object.keys(pins).length : 0 };
  console.log(`[mock] 서비스 인벤토리 데모: 법인 ${vcs.length}곳 · 전역 서비스 ${usedGlobals.size}개 · 고정 ${_last.pins}건`);
  return _last;
}
