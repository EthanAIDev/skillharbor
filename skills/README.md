# 本地技能源资产

这里保存业务技能源文件、开发方案、测试样例和历史检查记录。2026-11-10 整理入库时，源文件声明的版本如下：

| 技能目录 | 版本 | 可直接路由 |
| --- | --- | --- |
| `skill-dev-assistant/zlb-skilldev-agent` | 1.3.4 | 是 |
| `skill-dev-assistant/zlb-funcdev-agent` | 1.3.4 | 是 |
| `skill-dev-assistant/tool-skill-lint` | 1.3.4 | 否 |
| `skill-dev-assistant/tool-kb-verify` | 1.3.2 | 否 |
| `skill-dev-assistant/tool-trigger-sim` | 1.3.2 | 否 |
| `tool-meeting-todo` | 1.0.0 | 是 |

`skill-dev-assistant/README.md`、自检报告和日期命名的记录保留其编写时的状态，其中的本地或线上版本不能代替当前源文件或网关查询结果。本次只归档本地资产，不执行技能、不发布到网关，也未确认当前线上版本。

上表记录归档时源文件的标记，不作为重新分类的依据。按[已确认规则](../docs/ops/2026-11-10-local-main-alignment.md#内部技能规则现有行为与已确认原则)，具有独立用途的技能保持 `routable=true` 和独立在线入口，即使被主编排引用；只有明确不提供独立入口的内部组件才适合 `false`。具体技能的标记尚待逐项核对，本次未修改源文件或网关标签。

`test-bad-skill.md` 是有意包含不合规内容的检查样例。相关部门口径见 [部门代码与归属对照表](../docs/部门代码与归属对照表.md)。
