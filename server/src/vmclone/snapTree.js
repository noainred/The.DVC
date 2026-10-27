/**
 * vmclone/snapTree.js — VM 스냅샷 트리 파싱(순수, v2.794 에 runner.js 에서 옮김).
 * runner.js(재시작으로 중단된 백업의 스냅샷 정리)와 vsOps.js(중단된 검증의 정리)가 함께 쓴다 —
 * vsOps 가 runner 에서 가져오면 runner(동적 import vsOps) ↔ vsOps 순환이 생긴다(arch2579 SCC 상한).
 */
import { xmlUnescape } from '../vcenter/soapParse.js';

/**
 * VM 'snapshot'(VirtualMachineSnapshotInfo) XML → [{ref, name}] (순수 — 테스트 고정).
 * 트리 노드마다 snapshot → vm → name 순서다(vim25 VirtualMachineSnapshotTree). currentSnapshot 은 태그 이름이 달라 섞이지 않는다.
 */
export function snapshotTreeList(xml) {
  const out = [];
  const re = /<snapshot type="VirtualMachineSnapshot">([^<]+)<\/snapshot>\s*<vm\b[^>]*>[^<]*<\/vm>\s*<name>([^<]*)<\/name>/g;
  const s = String(xml || '');
  let m;
  while ((m = re.exec(s)) && out.length < 1000) out.push({ ref: m[1].trim(), name: xmlUnescape(m[2]) });
  return out;
}
