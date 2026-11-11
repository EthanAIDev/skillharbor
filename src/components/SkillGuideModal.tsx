import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getToken } from '../services/api';
import { ZbModal } from './ZbModal';

interface Props {
  onClose: () => void;
}

/** 截图：/files/guide/<name>.png 存在则显示，否则显示占位框（放图后自动生效） */
function GuideImg({ name, label, caption }: { name: string; label: string; caption?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-soft dark:bg-[#13121C] h-[180px] flex flex-col items-center justify-center gap-1.5">
        <span className="text-2xl text-t3">🖼</span>
        <span className="text-xs text-t3">截图占位：{label}</span>
        <span className="text-[10px] text-t3 font-mono">/files/guide/{name}.png</span>
      </div>
    );
  }
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={`/files/guide/${name}.png`}
        alt={label}
        onError={() => setMissing(true)}
        className="rounded-xl border border-line max-h-[280px] object-contain w-full bg-soft"
      />
      {caption && <figcaption className="text-[10px] text-t3 text-center">{caption}</figcaption>}
    </figure>
  );
}

/** AI 网关使用指引：一键连接AI Gateway后，技能 / 知识库 / 专家全部可用 */
export default function SkillGuideModal({ onClose }: Props) {
  const nav = useNavigate();
  /* 服务端鉴权只认 Bearer 头 / ?token=，裸 <a> 导航带不上令牌会 401（浏览器把 JSON 错误体存成 install-wb.json） */
  const installUrl = '/api/gateway/install-wb' + (getToken() ? `?token=${encodeURIComponent(getToken())}` : '');

  return (
    <ZbModal open onClose={onClose} label="AI 网关使用指引" maxWidth="w-[1080px] max-w-full" className="p-0 h-[660px] max-h-[92vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft text-lg"
        >
          ✕
        </button>
        <div className="p-6 flex flex-col gap-5">
          <div>
            <h2 className="text-lg font-semibold">AI 网关使用指引</h2>
            <p className="text-xs text-t2 mt-1 leading-relaxed">
              一键连接AI Gateway，<b className="text-t1">技能 · 知识库 · 专家 · 数据工具</b>在 AI 助手中全部可用。
            </p>
          </div>

          {/* 第一步：一键配置 */}
          <section className="rounded-xl border-2 border-accent/50 bg-accentSoft/50 dark:bg-accentSoft/20 p-4 flex flex-col gap-3">
            <div className="text-sm font-semibold text-t1">第一步 · 一键配置AI Gateway（前提，双击运行一次即可）</div>
            <p className="text-xs text-t2 leading-relaxed">
              下载脚本并<b className="text-t1">双击运行一次</b>，自动完成全部三件事：
            </p>
            <ul className="flex flex-col gap-1.5">
              <li className="flex items-start gap-2 text-xs text-t2 leading-relaxed">
                <span className="text-t1 font-medium shrink-0">①</span>
                <span>为 WorkBuddy 与本机已安装的 Trae 配置AI Gateway连接（保留你已有的其他连接器）</span>
              </li>
              <li className="flex items-start gap-2 text-xs text-t2 leading-relaxed">
                <span className="text-t1 font-medium shrink-0">②</span>
                <span>安装当前全部技能（WorkBuddy 技能菜单与 Trae 技能列表同步呈现），知识库与专家工具<b className="text-t1">无需安装自动可用</b></span>
              </li>
              <li className="flex items-start gap-2 text-xs text-t2 leading-relaxed">
                <span className="text-t1 font-medium shrink-0">③</span>
                <span>
                  注册自动同步——之后<b className="text-t1">新增技能自动更新</b>（每次登录 + 每 15 分钟），<b className="text-t1">无需再运行</b>
                </span>
              </li>
            </ul>
            <p className="text-[11px] text-t3 leading-relaxed">
              浏览器提示安全警告时选「仍要运行」；如已打开 WorkBuddy / Trae，重启后生效（Trae 的技能列表无需重启，实时可见）。连接成功的标志：工具列表出现 <code className="bg-soft px-1 rounded">list_skills</code>、<code className="bg-soft px-1 rounded">kb_search</code> 等工具。
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <a
                className="btn-primary !py-1.5 !px-3 !text-xs"
                href={installUrl}
                download
                onClick={(e) => {
                  if (!getToken()) { e.preventDefault(); nav('/login'); }
                }}
              >
                下载一键配置脚本（.bat）
              </a>
            </div>
            <GuideImg name="inst-success" label="脚本运行成功示例" caption="看到「安装完成！AI Gateway已连接」即为成功，关闭窗口进入下一步" />
          </section>

          {/* 第二步：WorkBuddy 信任并开启 */}
          <section className="rounded-xl border-2 border-accent/50 bg-accentSoft/50 dark:bg-accentSoft/20 p-4 flex flex-col gap-3">
            <div className="text-sm font-semibold text-t1">第二步 · 在 WorkBuddy 中信任并开启连接器</div>
            <ol className="flex flex-col gap-1.5 text-xs text-t2 leading-relaxed list-decimal pl-4">
              <li><b className="text-t1">重启 WorkBuddy</b>（正在运行的必须重启才能看到新连接器）；</li>
              <li>打开左上角「技能-专家-连接器」→「连接器」，点击右上角<b className="text-t1">「自定义连接器」</b>，列表中出现 <code className="bg-soft px-1 rounded">skillharbor-ai-gateway</code>；</li>
              <li>点击<b className="text-t1">「信任」</b>，再打开<b className="text-t1">开启开关</b>——开启后开关为绿色即生效。</li>
            </ol>
            <GuideImg name="wb-connectors-entry" label="新版 WorkBuddy 连接器入口" caption="新版 WorkBuddy：左上角点开「技能-专家-连接器」，在弹出菜单中选择「连接器」" />
            <GuideImg name="wb-custom-connectors" label="自定义连接器入口" caption="进入「连接器」页后，点右上角「自定义连接器」——脚本写入的 skillharbor-ai-gateway 就在这个列表里" />
            <GuideImg name="wb-trust" label="WorkBuddy 连接器开启示例" caption="在连接器列表找到 skillharbor-ai-gateway：先点「信任」，再打开右侧开关（如图绿色状态）；旧版入口在「设置 → MCP / 连接器」" />
          </section>

          {/* 第三步：验证与使用 */}
          <section className="rounded-xl border border-line p-4 flex flex-col gap-3">
            <h3 className="text-sm font-semibold">第三步 · 验证与日常使用（配好即用，验证一下更安心）</h3>
            <div className="text-xs text-t2 leading-relaxed">
              <b className="text-t1">验证方法</b>：新开一个对话，问一句「<b className="text-t1">列出可用技能</b>」——AI 能回答技能清单即连接成功。日常直接下达任务即可（如「帮我做农文旅融合发展项目规划」），技能的完整流程、方法论与模板文件由网关自动拉取执行。
            </div>
            <GuideImg name="workbuddy-chat" label="对话调用示例" caption="示例：对话中调用「六网融合」技能（菜单里能选到是因为这台电脑本地装过技能文件）" />
          </section>

          {/* 第三步：用知识库 */}
          <section className="rounded-xl border border-line p-4 flex flex-col gap-3">
            <h3 className="text-sm font-semibold">第四步 · 用知识库：用自然语言查公司知识</h3>
            <div className="text-xs text-t2 leading-relaxed">
              15 个部门知识库已全员开放。在对话里<b className="text-t1">像问同事一样提问</b>，AI 自动检索并给出带出处的结果：
            </div>
            <div className="rounded-lg bg-soft p-3 text-xs text-t2 leading-relaxed flex flex-col gap-1.5">
              <div>· 「查一下知识库里，<b className="text-t1">园区项目的收益怎么测算</b>」——不必记得文件名，检索按语义理解内容（Word/Excel/PDF 正文可搜）</div>
              <div>· 「知识库里有没有<b className="text-t1">光伏电站的案例</b>？把那份测算口径的原文拿给我」——自动检索 + 取全文</div>
              <div>· 部门智能体执行任务时会<b className="text-t1">自动查本部门知识库</b>取模板、案例与数据</div>
            </div>
            <GuideImg name="workbuddy-kb" label="知识库检索对话示例" caption="示例：对话中一句自然语言提问，AI 自动检索知识库并给出带出处的结果" />
            <div className="text-[11px] text-t3 leading-relaxed">
              浏览器里浏览/上传知识库：门户「工作台 → 知识库」。上传、编辑等维护操作详见《知识库使用说明》。
            </div>
          </section>

          <p className="text-[11px] text-t3">
            遇到连接或调用问题，请联系你的平台管理员；技能清单见首页「AI 技能」区，知识库入口见「工作台」。
          </p>
        </div>
    </ZbModal>
  );
}
