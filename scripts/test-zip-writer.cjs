const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { makeZip } = require('../server/lib/zip-writer.cjs');
test('publishing compresses large text and preserves exact UTF-8 paths and bytes', () => {
  const name = 'internal-skills/测算.md';
  const data = Buffer.from('可重复的业务资料\n'.repeat(100000));
  const zip = makeZip([{ name, data }]);
  assert.ok(zip.length < data.length / 10);
  assert.equal(zip.readUInt16LE(8), 8);
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), name);
  const compressedSize = zip.readUInt32LE(18);
  assert.deepEqual(zlib.inflateRawSync(zip.subarray(30 + nameLength, 30 + nameLength + compressedSize)), data);
});
