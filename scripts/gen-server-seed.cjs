/**
 * 生成服务端种子数据：server-seed-users.json / server-seed-tools.json
 * 从 src/data/users.ts 与 src/data/tools.ts 提取（部署前跑一次，产物 COPY 进镜像）。
 */
const fs = require('fs');
const path = require('path');

function extractArrayLiteral(file, marker) {
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('marker not found in ' + file);
  const start = src.indexOf('[', i);
  // 找匹配的收尾 “];”
  const end = src.indexOf('\n];', start);
  if (end < 0) throw new Error('array end not found in ' + file);
  // eslint-disable-next-line no-eval
  return eval('(' + src.slice(start, end + 2) + ')'); // end 指向 "\n];" 的 \n，+2 连 ] 一起截入
}

const root = path.join(__dirname, '..');
const users = extractArrayLiteral(path.join(root, 'src/data/users.ts'), 'export const baseUsers').map((u) => ({
  username: u.username,
  name: u.name,
  role: u.role || 'user',
  dept: u.dept,
  deptShort: u.deptShort,
  title: u.title || '',
  phone: u.phone || '',
  email: u.email || '',
}));
const tools = extractArrayLiteral(path.join(root, 'src/data/tools.ts'), 'export const tools').map((t) => ({
  id: t.id,
  name: t.name,
  owner: t.owner,
  department: t.department,
}));

fs.writeFileSync(path.join(root, 'server-seed-users.json'), JSON.stringify(users, null, 1));
fs.writeFileSync(path.join(root, 'server-seed-tools.json'), JSON.stringify(tools, null, 1));
console.log(`[seed] users=${users.length} tools=${tools.length} -> server-seed-users.json / server-seed-tools.json`);
