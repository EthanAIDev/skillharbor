const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = (s) => /^[1-9]\d{0,15}$/.test(s);

function multipartBoundary(value) {
  const m = /^multipart\/form-data\s*;\s*boundary=(?:"([\w'()+,./:=? -]{1,70})"|([\w'()+,./:=?-]{1,70}))\s*$/i.exec(value || '');
  if (!m) throw bad('无效的 multipart/form-data 请求');
  return m[1] || m[2];
}

function partHeaders(buffer) {
  const headers = new Map();
  for (const line of buffer.toString('utf8').split('\r\n')) {
    const m = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(line);
    if (!m || headers.has(m[1].toLowerCase())) throw bad('上传头格式错误或重复');
    const key = m[1].toLowerCase();
    if (!['content-disposition', 'content-type'].includes(key)) throw bad('不支持的上传头');
    headers.set(key, m[2]);
  }
  const disposition = headers.get('content-disposition') || '';
  if (!/^form-data(?:;\s*(?:name|filename)="[^"\r\n]*")+$/i.test(disposition)) throw bad('上传字段格式错误');
  const params = new Map();
  for (const m of disposition.matchAll(/;\s*(name|filename)="([^"\r\n]*)"/gi)) {
    const key = m[1].toLowerCase();
    if (params.has(key)) throw bad('上传字段参数重复');
    params.set(key, m[2]);
  }
  const name = params.get('name');
  if (!name || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) throw bad('上传字段名无效');
  const filename = params.get('filename');
  if (name === 'reposId' && filename !== undefined) throw bad('reposId 必须是文本字段');
  let normalized = `Content-Disposition: form-data; name="${name}"`;
  if (filename !== undefined) normalized += `; filename="${filename}"`;
  const type = headers.get('content-type');
  if (filename === undefined) {
    // Spring honors each text part's charset. Validate and forward the same UTF-8 bytes.
    if (type && !/^text\/plain(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type))
      throw bad('上传文本字段必须使用 UTF-8');
    normalized += '\r\nContent-Type: text/plain; charset=UTF-8';
  } else if (type) {
    if (!/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(type)) throw bad('文件类型格式错误');
    normalized += '\r\nContent-Type: ' + type;
  }
  return { name, file: filename !== undefined, filename, normalized };
}

/* Stage to disk before upstream receives anything. Memory is bounded by a single
 * input chunk plus a boundary/header tail; multipart headers are canonicalized so
 * the upstream cannot interpret an alternative name/encoding as another reposId. */
async function stageKbUpload(req, url, directory, maxBytes = 150 * 1024 * 1024) {
  const ids = url.searchParams.getAll('reposId');
  if (ids.length !== 1 || !validId(ids[0])) throw bad('必须指定唯一有效的 reposId');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw bad('上传大小限制配置无效', 500);
  const expectedId = ids[0];
  const boundary = multipartBoundary(req.headers['content-type']);
  const length = Number(req.headers['content-length'] || 0);
  if (length > maxBytes) throw bad('上传文件超过大小上限', 413);
  const temporary = path.join(directory, 'kb-upload-' + crypto.randomBytes(16).toString('hex') + '.tmp');
  const outputBoundary = 'skillharbor-' + crypto.randomBytes(24).toString('hex');
  const first = Buffer.from('--' + boundary + '\r\n');
  const delimiter = Buffer.from('\r\n--' + boundary);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  let pending = Buffer.alloc(0), state = 'first', part, bytes = 0, outputBytes = 0, fileBytes = 0;
  let repoFields = 0, fileFields = 0, parts = 0, repoValue = '';
  const fields = new Map(), files = [];
  const write = (data) => { outputBytes += Buffer.byteLength(data); fs.writeFileSync(fd, data); };
  const data = (chunk) => {
    part.bytes += chunk.length;
    if (!part.file) {
      if (part.bytes > 16384) throw bad('上传文本字段过大');
      part.chunks.push(Buffer.from(chunk));
    }
    if (part.name === 'reposId') {
      if (repoValue.length + chunk.length > 32) throw bad('reposId 无效');
      repoValue += chunk.toString('ascii');
      // Reject high-bit bytes instead of allowing ASCII decoding to normalize them.
      if (chunk.some((b) => b < 48 || b > 57)) throw bad('reposId 无效');
    } else {
      if (part.file) fileBytes += chunk.length;
      write(chunk);
    }
  };
  const consume = () => {
    while (true) {
      if (state === 'first') {
        if (pending.length < first.length) return;
        if (!pending.subarray(0, first.length).equals(first)) throw bad('上传边界格式错误');
        pending = pending.subarray(first.length); state = 'headers';
      } else if (state === 'headers') {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) { if (pending.length > 16384) throw bad('上传头过大'); return; }
        if (end > 16384 || ++parts > 128) throw bad('上传字段过多或头过大');
        part = partHeaders(pending.subarray(0, end));
        part.bytes = 0; part.chunks = [];
        if (part.name === 'reposId' && ++repoFields !== 1) throw bad('reposId 不可重复');
        if (part.file) fileFields++;
        write(`--${outputBoundary}\r\n${part.normalized}\r\n\r\n`);
        pending = pending.subarray(end + 4); state = 'data';
      } else if (state === 'data') {
        let cursor = 0, at;
        while ((at = pending.indexOf(delimiter, cursor)) >= 0) {
          if (pending.length < at + delimiter.length + 2) {
            data(pending.subarray(0, at)); pending = pending.subarray(at); return;
          }
          const suffix = pending.subarray(at + delimiter.length, at + delimiter.length + 2).toString();
          if (suffix === '\r\n' || suffix === '--') break;
          cursor = at + 1; // A boundary-like byte sequence inside file content.
        }
        if (at < 0) {
          const keep = delimiter.length + 2;
          if (pending.length > keep) { data(pending.subarray(0, pending.length - keep)); pending = pending.subarray(pending.length - keep); }
          return;
        }
        data(pending.subarray(0, at));
        if (part.file) files.push({ field: part.name, filename: part.filename, bytes: part.bytes });
        else {
          const values = fields.get(part.name) || [];
          try { values.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(part.chunks))); }
          catch { throw bad('上传文本字段不是有效 UTF-8'); }
          fields.set(part.name, values);
        }
        if (part.name === 'reposId') {
          if (!validId(repoValue) || repoValue !== expectedId) throw bad('上传目标库与已授权目标不一致');
          write(expectedId);
        }
        write('\r\n');
        const final = pending.subarray(at + delimiter.length, at + delimiter.length + 2).toString() === '--';
        pending = pending.subarray(at + delimiter.length + 2);
        state = final ? 'end' : 'headers';
        if (final) write(`--${outputBoundary}--\r\n`);
      } else {
        if (pending.length > 2 || (pending.length === 2 && pending.toString() !== '\r\n')) throw bad('上传尾部格式错误');
        return;
      }
    }
  };
  try {
    // Do not destroy the HTTP request on validation failure: caller can return a
    // useful 4xx while draining the remainder without retaining it in memory.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw bad('上传文件超过大小上限', 413);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      consume();
    }
    if (state !== 'end' || (pending.length && pending.toString() !== '\r\n')) throw bad('上传数据不完整');
    if (repoFields !== 1 || !fileFields) throw bad('上传缺少 reposId 或文件');
    fs.closeSync(fd);
    return { path: temporary, reposId: expectedId, bytes: outputBytes, fileBytes, fields, files,
      contentType: 'multipart/form-data; boundary=' + outputBoundary,
      cleanup() { fs.rmSync(temporary, { force: true }); } };
  } catch (e) {
    fs.closeSync(fd); fs.rmSync(temporary, { force: true }); throw e;
  }
}
module.exports = { stageKbUpload };
