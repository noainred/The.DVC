// v2.495 — BMC 벤더 판별(순수) 회귀 고정.
// 핵심: (1) Redfish 양성 게이트 없이는 '미지원' 후보가 되지 않는다(스위치 웹UI 오탐 방지),
// (2) HPE iLO 루트(Oem.Hpe)를 인증 없이도 HPE 로 판별한다, (3) 기존 Dell 시그니처 폴백을 유지한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBmcVendor, isRedfishRoot, VENDOR_LABEL } from '../src/idrac/vendorMatch.js';

const ILO = { '@odata.id': '/redfish/v1/', RedfishVersion: '1.6.0', Product: 'ProLiant DL380 Gen10', Vendor: 'HPE', Oem: { Hpe: { Manager: [] } } };
const IDRAC = { '@odata.id': '/redfish/v1', RedfishVersion: '1.11.0', Product: 'Integrated Dell Remote Access Controller', Vendor: 'Dell', Oem: { Dell: {} } };

test('Redfish 양성 게이트 — 루트 신호가 없으면 후보가 아니다', () => {
  assert.equal(isRedfishRoot(ILO), true);
  assert.equal(isRedfishRoot({ Links: { Sessions: { '@odata.id': '/redfish/v1/SessionService/Sessions' } } }), true);
  assert.equal(isRedfishRoot({}), false);
  assert.equal(isRedfishRoot({ error: 'not json' }), false);
  assert.equal(isRedfishRoot(null), false);
  assert.equal(classifyBmcVendor({ root: {} }).redfish, false);
});

test('HPE iLO — 인증 없이 루트만으로 HPE(oem 근거)', () => {
  const r = classifyBmcVendor({ root: ILO });
  assert.equal(r.redfish, true);
  assert.equal(r.vendor, 'hpe');
  assert.equal(r.evidence, 'oem:Hpe');
  assert.equal(r.label, 'HPE');
  assert.equal(r.product, 'ProLiant DL380 Gen10');
  // 구형 키 'Hp' 도 HPE
  assert.equal(classifyBmcVendor({ root: { RedfishVersion: '1.0.0', Oem: { Hp: {} } } }).vendor, 'hpe');
});

test('Dell iDRAC — oem/vendor/signature 모두 dell', () => {
  assert.equal(classifyBmcVendor({ root: IDRAC }).vendor, 'dell');
  assert.equal(classifyBmcVendor({ root: { RedfishVersion: '1', Vendor: 'Dell' } }).evidence, 'vendor:Dell');
  // 기존 휴리스틱(JSON 전문 substring) 폴백 유지 — 401 오류 본문에 iDRAC 메시지가 실린 경우
  const r = classifyBmcVendor({ root: { error: { '@Message.ExtendedInfo': [{ MessageId: 'IDRAC.2.7.SYS403' }] } } });
  assert.equal(r.vendor, 'dell'); assert.equal(r.evidence, 'signature'); assert.equal(r.redfish, false);
});

test('근거 우선순위 — Oem > Vendor > Manufacturer > Product > signature', () => {
  assert.equal(classifyBmcVendor({ root: { RedfishVersion: '1', Vendor: 'Lenovo' }, manufacturer: 'HPE' }).vendor, 'lenovo');
  assert.equal(classifyBmcVendor({ root: { RedfishVersion: '1' }, manufacturer: 'Supermicro' }).evidence, 'manufacturer:Supermicro');
  const p = classifyBmcVendor({ root: { RedfishVersion: '1', Product: 'Integrated Lights-Out 5' } });
  assert.equal(p.vendor, 'hpe'); assert.match(p.evidence, /^product:/);
  assert.equal(classifyBmcVendor({ root: { RedfishVersion: '1', Product: 'XClarity Controller' } }).vendor, 'lenovo');
  assert.equal(classifyBmcVendor({ root: { RedfishVersion: '1', Product: 'Cisco IMC' } }).vendor, 'cisco');
});

test('확신 없으면 unknown — 억지 단정 금지', () => {
  const r = classifyBmcVendor({ root: { RedfishVersion: '1.2.0', Product: 'Generic Redfish Service' } });
  assert.equal(r.vendor, 'unknown');
  assert.equal(r.label, VENDOR_LABEL.unknown);
  assert.equal(r.evidence, '');
  assert.equal(r.redfish, true);
});
