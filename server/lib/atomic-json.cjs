const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* The server uses synchronous filesystem writes already. Keep each commit in one
 * event-loop turn: callers can publish their new in-memory state only on success. */
function atomicWriteJSON(directory, name, value) {
  if (path.basename(name) !== name) throw new Error('JSON filename must be a basename');
  const target = path.join(directory, name);
  const temporary = `${target}.${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    const data = JSON.stringify(value);
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
module.exports = { atomicWriteJSON };
