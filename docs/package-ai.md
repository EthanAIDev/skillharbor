# 上传结构识别模型配置

门户在服务器调用现有 One-API；浏览器不会获得本模块使用的模型密钥。规则无法明确分派真实引用时，最多调用一次兼容 `POST /v1/chat/completions` 的补全接口，建议仍须由技能网关检查原 ZIP、真实资源和逐行证据。

## 环境变量

| 变量 | 默认值与用途 |
| --- | --- |
| `ONE_API_BASE` | `http://127.0.0.1:3000`，沿用网站现有网关 |
| `ONE_API_ADMIN_TOKEN` | 无；仅服务器查询现有员工令牌列表 |
| `PACKAGE_AI_KEY` | 可选专用补全密钥，优先使用；不会自动创建令牌 |
| `PACKAGE_AI_BASE` | 可选专用补全地址，优先于 `ONE_API_BASE`；可包含结尾 `/v1` |
| `PACKAGE_AI_MODEL` | `deepseek-v4-1-flash-261017`，按用户选择默认使用Flash；可由服务器配置显式覆盖 |

未配置 `PACKAGE_AI_KEY` 时，模块使用 `ONE_API_ADMIN_TOKEN` 对 `/api/token/?p=0` 起的最多 60 页进行只读查询，每页固定 10 项。仅采用 `token.name === user.name` 的令牌；原始 key 自动补齐一次 `sk-` 前缀。未找到本人令牌、令牌无效或明确额度耗尽时保留规则识别结果。管理员令牌与其他员工令牌均不能用于补全；不写入或创建令牌。专用 key 与管理员令牌相同时同样拒绝补全。

`PACKAGE_AI_BASE` 单独设置时仍按上述规则在 `ONE_API_BASE` 查询本人已有 key，随后使用该 key 访问配置的补全地址，因此应只设置为受信任的服务地址。

## 服务器调用合同

```js
const { proposePackage } = require('./server/lib/package-ai.cjs');
const result = await proposePackage(analysis.modelContext, authenticatedUploader);
// result = { proposal: { resolutions: [...] } } 或 { unavailable: '固定可读状态' }
```

`modelContext` 仅包含以下字段；额外元数据不会发给模型：

```text
candidates: [{id, path, name, kind: 'skill' | 'script'}]
files: [{id, path, text}]
registry: [{id, slug, name, description, status}]
references: [{id, fileId, line, quote, targetIds: [真实候选或资源ID]}]
```

模型仅能返回：

```json
{
  "resolutions": [
    {
      "referenceId": "真实引用ID",
      "targetId": "该引用允许的真实目标ID",
      "evidence": { "fileId": "原文文件ID", "line": 1, "quote": "原文引文" }
    }
  ]
}
```

`line` 从 1 开始；`fileId/line/quote` 必须与网关提供的引用完全一致。同一引用可分派多个不同的真实目标。客户端拒绝额外字段、重复分派、虚构目标或证据，不接受身份、版本、required/planned 或发布状态修改。网关仍是最终验证边界。不确定或空建议保留问题，不会标记为 AI 识别成功。

完整认证查询与补全共用 20 秒期限；每个响应按字节流限制为 128 KiB；上下文总计不超过 96 KiB，单份说明文本不超过 32 KiB。拒绝重定向、非法或截断 JSON、超大响应和非正常结束的补全。文件内容在系统提示中明确作为不可信数据；已知凭据在上下文中脱敏，返回建议也经过解码后的凭据检查。失败只返回固定状态，不返回远端错误正文、员工列表或敏感 payload。

## 本地验证

2026-11-02已用新建的 `zeb` 令牌完成一次[真实模型受控验收](ops/2026-11-02-model-acceptance.md)。该令牌的授权模型是 `deepseek-v4-1-flash-261017` 和 `deepseek-v4-pro`；验收实际调用前者。用户随后选择Flash，智能结构识别的新版本默认值已改为 `deepseek-v4-1-flash-261017`。正式部署建议同时显式配置同名 `PACKAGE_AI_MODEL`；仍设置为旧模型的私有配置须同步更新。历史验收未修改生产配置，也未把真实补全接入隔离预览。

```powershell
node --test scripts/test-package-ai.cjs
node --check server/lib/package-ai.cjs
```

测试仅使用绑定 `127.0.0.1` 随机端口的 HTTP 模拟服务，并显式传入隔离的 `options.env`；不读取生产 key、不访问生产网关，也不消耗生产模型配额。`options.timeoutMs` 仅用于注入测试期限，默认服务调用不必传入 options。
