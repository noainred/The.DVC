/**
 * isidu/corpName.js — 대상의 법인(DataCenter) 이름(v2.742). 메일 본문·목록 행이 같은 판정을 쓴다.
 * 등록부 대상은 장비의 DataCenter, 직접 입력 대상은 설정의 DataCenter. 이름을 모르면 id, 법인이 없으면 ''(지어내지 않는다).
 */
import { listDevices } from '../storage/registry.js';
import { listDatacenters } from '../datacenter/store.js';
import { resolveTarget } from './settings.js';

export function dcNameMap() {
  try { return new Map(listDatacenters().map((d) => [String(d.id), String(d.name || d.id)])); } catch { return new Map(); }
}

/** 저장된 대상 하나 → 법인 이름(''이면 법인 미지정). */
export function corpNameOf(t, { devices = null, dcs = null } = {}) {
  if (!t) return '';
  let devs = devices;
  if (!devs) { try { devs = listDevices(); } catch { devs = []; } }
  const r = resolveTarget(t, { devices: devs });
  const id = String(r?.datacenterId || '');
  if (!id) return '';
  return (dcs || dcNameMap()).get(id) || id;
}
