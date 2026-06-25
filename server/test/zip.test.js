import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zipSingle } from '../src/util/zip.js';

test('zipSingle: 유효한 zip 헤더 + deflate 라운드트립', () => {
  const content = 'hello,world\n' + 'a'.repeat(5000);
  const zip = zipSingle('data.csv', content);
  // 로컬 파일 헤더 시그니처
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  // EOCD 시그니처가 끝부분에 존재
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  // 압축 데이터( name 'data.csv'=8바이트, 헤더 30 + 8 = 38 오프셋부터 deflate )
  const nameLen = zip.readUInt16LE(26);
  const compLen = zip.readUInt32LE(18);
  const comp = zip.subarray(30 + nameLen, 30 + nameLen + compLen);
  assert.equal(zlib.inflateRawSync(comp).toString('utf8'), content);
});
