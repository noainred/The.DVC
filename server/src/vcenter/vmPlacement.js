/**
 * vcenter/vmPlacement.js — VM 의 **정확한** vSphere 위치(데이터센터 경로·VM 폴더 경로) 계산(순수 함수, v2.747 Bareos 연동).
 *
 * 왜 따로 두나: 기존 VM 레코드의 `folder`(soapClient folderPath)는 화면 표시용이라 이름이 `vm`·`Datacenters` 인 폴더를
 *   **모든 깊이에서** 건너뛰고 루트를 'vm' 으로 적는다 — Bareos VMware 플러그인처럼 경로로 VM 을 찾는 쪽에는 쓸 수 없다
 *   (사용자가 'vm' 이라는 폴더를 만들었으면 다른 VM 을 가리킨다). `folder` 는 소비처가 많아 그대로 두고 새 필드를 더한다.
 *
 * 규칙(vSphere 인벤토리 구조): VM.parent → … → 데이터센터의 vmFolder(부모가 Datacenter 인 Folder) — 이 폴더 이름은 넣지 않는다.
 *   데이터센터가 폴더 안에 있으면 플러그인의 `dc` 는 전체 경로다(Bareos VMware 플러그인 문서 'Use the full path if it is not in the
 *   root folder') — 루트 폴더(부모 없는 Folder)는 넣지 않는다.
 *   따라갈 수 없으면(vApp 안의 VM 은 parent 가 없다 · 고리 · 깊이 32 초과) **null** — 지어내지 않는다.
 */
const MAX_DEPTH = 32;

/**
 * @param {string|undefined} vmParent   VM 의 parent ref
 * @param {Map<string,{name:string,parent?:string}>} folders  Folder ref → { name, parent }
 * @param {Map<string,{name:string,parent?:string}>} dcs      Datacenter ref → { name, parent }
 * @returns {{ vcDatacenter: string|null, folderPath: string|null }}
 */
export function vmPlacement(vmParent, folders, dcs) {
  const none = { vcDatacenter: null, folderPath: null };
  if (!vmParent || !folders?.has?.(vmParent)) return none;
  const parts = [];
  let cur = vmParent; let dcRef = null;
  for (let i = 0; i < MAX_DEPTH && cur; i++) {
    const f = folders.get(cur);
    if (!f) return none;
    if (f.parent && dcs?.has?.(f.parent)) { dcRef = f.parent; break; } // 데이터센터의 vmFolder — 이름은 넣지 않는다
    if (typeof f.name !== 'string' || !f.name) return none;
    parts.unshift(f.name);
    cur = f.parent;
  }
  if (!dcRef) return none;
  const dc = dcs.get(dcRef);
  if (!dc || typeof dc.name !== 'string' || !dc.name) return none;
  const dcParts = [dc.name];
  let up = dc.parent;
  for (let i = 0; i < MAX_DEPTH && up; i++) {
    const f = folders.get(up);
    if (!f) return none;
    if (!f.parent) break; // 루트 폴더(Datacenters) — 넣지 않는다
    if (typeof f.name !== 'string' || !f.name) return none;
    dcParts.unshift(f.name);
    up = f.parent;
  }
  return { vcDatacenter: dcParts.join('/'), folderPath: parts.length ? `/${parts.join('/')}` : '/' };
}
