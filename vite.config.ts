import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

/** 每次构建唯一，前端用它判断「服务器上是不是有了新版本」 */
const BUILD_ID = formatBuildId(new Date());
const BUILD_TIME = formatTime(new Date());

function formatBuildId(d: Date) {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function formatTime(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 版本注入 + version.json 生成：
 * - define 把当前构建的版本常量打进 JS，运行时与服务器上 version.json 比对；
 * - closeBundle 在 dist 写出 version.json（内容含项目根 update-notes.json 的更新说明）。
 * 注意：vite 可能多次加载本配置模块，因此 version.json 一律以 configResolved
 * 里 vite 实际采用的 define 值为准，确保「JS 内嵌 buildId === version.json buildId」。
 */
function versionPlugin(): Plugin {
  let notes: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'update-notes.json'), 'utf8'));
    if (Array.isArray(raw.notes)) {
      // 更新提醒卡空间有限：单条超 100 字构建时截断并警告（写 update-notes.json 时应自行控制）
      notes = raw.notes
        .filter((n: unknown): n is string => typeof n === 'string')
        .map((n) => {
          if (n.length > 100) {
            console.warn(`[skillharbor-version] 更新说明超 100 字已截断：${n.slice(0, 20)}…`);
            return n.slice(0, 99) + '…';
          }
          return n;
        });
    }
  } catch {
    /* 没有 update-notes.json 时提醒卡显示默认文案 */
  }

  let resolved: { version: string; buildId: string; buildTime: string } | null = null;

  return {
    name: 'skillharbor-version',
    config() {
      return {
        define: {
          __BUILD_VERSION__: JSON.stringify(pkg.version),
          __BUILD_ID__: JSON.stringify(BUILD_ID),
          __BUILD_TIME__: JSON.stringify(BUILD_TIME),
        },
      };
    },
    configResolved(c) {
      resolved = {
        version: String(c.define.__BUILD_VERSION__).replace(/^"|"$/g, ''),
        buildId: String(c.define.__BUILD_ID__).replace(/^"|"$/g, ''),
        buildTime: String(c.define.__BUILD_TIME__).replace(/^"|"$/g, ''),
      };
    },
    closeBundle() {
      const meta = resolved ?? { version: pkg.version, buildId: BUILD_ID, buildTime: BUILD_TIME };
      const outDir = path.join(__dirname, 'dist');
      fs.mkdirSync(outDir, { recursive: true });
      /* 从本次构建的 index.html 提取入口 JS 文件名，供前端核对部署完整性 */
      let entry = '';
      try {
        const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf-8');
        entry = html.match(/src="\/?(assets\/index-[^"]+\.js)"/)?.[1] || '';
      } catch {
        /* 读不到 index.html 时省略 entry，前端退回仅比对 buildId */
      }
      fs.writeFileSync(
        path.join(outDir, 'version.json'),
        JSON.stringify({ version: meta.version, buildId: meta.buildId, buildTime: meta.buildTime, entry, notes }, null, 2) + '\n',
      );
      console.log(`[version] dist/version.json → ${meta.version} (${meta.buildId}, entry: ${entry || 'n/a'})`);
    },
  };
}

export default defineConfig({
  plugins: [react(), versionPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    /* 本地 dev 的 /api 转发到 server.cjs（默认 8900）：技能中心代理、工具清单等接口由后端提供，
     * 纯 vite dev 没有它时首页技能区会显示「连接异常」。先起后端：node server.cjs 8900 */
    proxy: {
      '/api': 'http://127.0.0.1:8900',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
});
