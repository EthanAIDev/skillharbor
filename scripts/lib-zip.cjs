/* 测试用 zip 构造器（STORE 不压缩，零依赖）与 1x1 PNG */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** files: Array<[name, Buffer]> → zip Buffer（entry 名 UTF-8 标记已置位；
 * name 传 Buffer 时按原始字节写入且不置 UTF-8 标记——用于构造 GBK 文件名 zip 的用例） */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const isRaw = Buffer.isBuffer(name);
    const nb = isRaw ? name : Buffer.from(name, 'utf8');
    const efs = isRaw ? 0 : 0x0800;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(efs, 6); // 版本 / UTF-8 名
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); // store / 时间 / 日期
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nb, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(efs, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nb);
    offset += lh.length + nb.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const HTML = (title) => Buffer.from(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>e2e</h1><script>console.log(1)</script>`, 'utf8');

module.exports = { makeZip, PNG_1x1, HTML };
