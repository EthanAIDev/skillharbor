import { useEffect, useRef, useState } from 'react';
import { skillStyle, loadSkills, loadSkillMd, type SkillMd } from '../services/skillsGateway';
import {
  loadAgentGraph,
  loadPackageComponent,
  type AgentGraph,
  type PackageComponent,
  type PackageDependency,
  type ComponentContent,
} from '../services/agentStructure';
import AgentStructure from './AgentStructure';
import RuntimeRequirements from './RuntimeRequirements';
import EvalSection from './EvalSection';
import { ZbModal } from './ZbModal';
import type { Skill } from '../types';

interface Props {
  skill: Skill;
  deptMap?: Record<string, string>;
  applicable?: Record<string, string[]>;
  onClose: () => void;
  onOpenGuide: () => void;
}

export default function SkillModal({ skill, deptMap = {}, applicable = {}, onClose, onOpenGuide }: Props) {
  const [history, setHistory] = useState<Skill[]>([skill]);
  const currentHistory = history[0] === skill ? history : [skill];
  const viewSkill = currentHistory[currentHistory.length - 1];
  const slug = viewSkill.slug || viewSkill.id;
  const [md, setMd] = useState<SkillMd | null>(null);
  const [mdError, setMdError] = useState(false);
  const graphKey = `${slug}:${viewSkill.version || ''}`;
  const [graphSnapshot, setGraphSnapshot] = useState<{ key: string; graph: AgentGraph } | null>(null);
  const graph = graphSnapshot?.key === graphKey ? graphSnapshot.graph : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [component, setComponent] = useState<PackageComponent | null>(null);
  const [componentContent, setComponentContent] = useState<ComponentContent | null>(null);
  const [componentError, setComponentError] = useState('');
  const [componentRetry, setComponentRetry] = useState(0);
  const [openingDependency, setOpeningDependency] = useState(false);
  const requestRef = useRef(0);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const restoreHeadingFocus = useRef(false);

  useEffect(() => {
    if (!restoreHeadingFocus.current) return;
    restoreHeadingFocus.current = false;
    detailHeadingRef.current?.focus({ preventScroll: true });
  }, [component, currentHistory.length]);

  useEffect(() => {
    setHistory([skill]);
    setComponent(null);
  }, [skill]);
  useEffect(() => {
    let alive = true;
    requestRef.current++;
    setMd(null);
    setMdError(false);
    setGraphSnapshot(null);
    setLoading(true);
    setError('');
    setComponent(null);
    setOpeningDependency(false);
    loadSkillMd(slug, viewSkill.version).then((result) => {
      if (alive) {
        setMd(result);
        setMdError(!result);
      }
    });
    loadAgentGraph(slug, viewSkill.version)
      .then((result) => {
        if (alive) setGraphSnapshot({ key: graphKey, graph: result });
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : '结构读取失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      requestRef.current++;
    };
  }, [slug, viewSkill.version, retry]);

  useEffect(() => {
    let alive = true;
    setComponentContent(null);
    setComponentError('');
    if (component && graph) {
      loadPackageComponent(slug, component.id, graph.version)
        .then((result) => {
          if (alive) setComponentContent(result);
        })
        .catch((reason) => {
          if (alive) setComponentError(reason instanceof Error ? reason.message : '组件读取失败');
        });
    }
    return () => {
      alive = false;
    };
  }, [component, graph, slug, componentRetry]);

  const openDependency = async (dependency: PackageDependency) => {
    if (!dependency.slug || openingDependency) return;
    const request = ++requestRef.current;
    setOpeningDependency(true);
    const all = await loadSkills();
    if (request !== requestRef.current) return;
    const found = all.find((item) => item.slug === dependency.slug || item.id === dependency.slug);
    setOpeningDependency(false);
    setHistory((items) => [
      ...items,
      found || {
        id: dependency.slug!,
        slug: dependency.slug,
        name: dependency.name,
        category: viewSkill.category,
        icon: dependency.name[0] || '技',
        usage: 0,
      },
    ]);
  };

  const isAgent = (graph?.kind || viewSkill.kind) === 'agent';
  const st = skillStyle(viewSkill.category);
  const ownerDept = deptMap[slug] || '';
  const applyDepts = applicable[slug]?.length ? applicable[slug] : ownerDept ? [ownerDept] : [];
  const applyText = applyDepts.includes('全部') ? ['全部部门'] : applyDepts;
  const title = component?.name || viewSkill.name;
  const previousName = component ? viewSkill.name : currentHistory[currentHistory.length - 2]?.name;
  const navigateTo = (index: number) => {
    requestRef.current++;
    setOpeningDependency(false);
    restoreHeadingFocus.current = true;
    setComponent(null);
    setHistory(currentHistory.slice(0, index + 1));
  };

  return (
    <ZbModal
      open
      onClose={onClose}
      label={title}
      maxWidth="w-[1080px] max-w-full"
      className="p-0 h-[660px] max-h-[92vh] overflow-hidden"
    >
      <button
        onClick={onClose}
        aria-label="关闭详情"
        className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-t2 hover:text-t1 hover:bg-soft text-lg z-10"
      >
        ✕
      </button>
      <div className="p-6 h-full min-h-0 flex flex-col gap-4">
        {(currentHistory.length > 1 || component) && (
          <div className="flex items-start gap-3 pr-10 shrink-0">
            <button
              type="button"
              aria-label={`返回上一级：${previousName}`}
              title={`返回${previousName}`}
              onClick={() => navigateTo(component ? currentHistory.length - 1 : currentHistory.length - 2)}
              className="btn-ghost focus-ring shrink-0 !gap-1.5 !px-3 !py-1.5 !text-xs hover:border-accent hover:bg-soft"
            >
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m10 5-5 5 5 5M5 10h10" /></svg>
              返回上一级
            </button>
            <nav
              aria-label="详情路径"
              className="min-w-0 flex-1 flex flex-wrap items-center gap-2 pt-2 text-xs max-h-16 overflow-y-auto overscroll-contain"
            >
              {currentHistory.map((item, i) => (
                <span key={`${item.id}-${i}`} className="min-w-0">
                  {i > 0 && <span className="text-t2 mx-2">/</span>}
                  {i < currentHistory.length - 1 || component ? (
                    <button
                      type="button"
                      className="focus-ring rounded text-accentText break-words text-left hover:underline"
                      onClick={() => navigateTo(i)}
                    >
                      {item.name}
                    </button>
                  ) : (
                    <span>{item.name}</span>
                  )}
                </span>
              ))}
              {component && <span className="text-t2">/ {component.name}</span>}
            </nav>
          </div>
        )}
        <div className="flex items-center gap-4 pr-10 shrink-0">
          <span
            className={`w-14 h-14 rounded-[14px] ${st.bg} flex items-center justify-center text-[22px] font-semibold ${st.fg} shrink-0`}
          >
            {component?.kind === 'script' ? '码' : viewSkill.icon}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 ref={detailHeadingRef} tabIndex={-1} className="focus-ring rounded text-lg font-semibold break-words">{title}</h2>
              <span className={`pill ${st.bg} ${st.fg}`}>
                {component
                  ? component.kind === 'script'
                    ? '包内脚本'
                    : '包内技能'
                  : isAgent
                    ? '智能体'
                    : 'AI 技能'}
              </span>
              {!component && viewSkill.routable === false && (
                <span className="pill bg-soft text-t2">内部技能</span>
              )}
            </div>
            <p className="text-[11px] text-t2 mt-2 font-mono break-all">
              {component ? `${slug} / ${component.path}` : `${slug} · 来自Skill Center`}
            </p>
          </div>
          {!component && (
            <button className="btn-primary shrink-0" onClick={onOpenGuide}>
              查看使用指引 →
            </button>
          )}
        </div>

        {component ? (
          <section className="rounded-xl border border-line p-4 flex-1 min-h-0 flex flex-col overflow-hidden">
            <p className="text-xs text-t2 mb-3 shrink-0">
              随 {viewSkill.name} · {graph?.version} 发布，版本由所属智能体统一管理。
              {component.kind === 'script' ? '此处可查看脚本内容。' : ''}
            </p>
            {componentError ? (
              <div role="alert" className="text-sm text-danger">
                {componentError}
                <button className="ml-3 underline" onClick={() => setComponentRetry((n) => n + 1)}>
                  重试
                </button>
              </div>
            ) : !componentContent ? (
              <p role="status" className="text-xs text-t2">
                正在读取组件…
              </p>
            ) : (
              <pre
                aria-label="组件正文"
                tabIndex={0}
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] text-xs leading-relaxed text-t2 font-mono whitespace-pre-wrap break-words pr-2"
              >
                {componentContent.content}
              </pre>
            )}
          </section>
        ) : (
          <div className="flex gap-4 flex-1 min-h-0">
            <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-4">
              <section className="rounded-xl border border-line p-4 shrink-0">
                <h3 className="text-sm font-semibold mb-2.5">{isAgent ? '智能体简介' : '技能简介'}</h3>
                <p className="text-xs text-t2 leading-relaxed max-h-20 overflow-y-auto overscroll-contain">
                  {viewSkill.desc || '暂无简介，可展开下方原文查看完整说明。'}
                </p>
              </section>
              {loading && (
                <p role="status" className="text-xs text-t2">
                  正在读取结构…
                </p>
              )}
              {error && (
                <div role="alert" className="rounded-lg border border-line p-3 text-xs text-t2">
                  {error}
                  <button className="ml-3 text-accentText underline" onClick={() => setRetry((n) => n + 1)}>
                    重试
                  </button>
                </div>
              )}
              {graph?.kind === 'agent' && (
                <AgentStructure
                  key={`${slug}:${graph.version}`}
                  graph={graph}
                  name={viewSkill.name}
                  onComponent={setComponent}
                  onDependency={openDependency}
                />
              )}
              {openingDependency && (
                <p role="status" className="text-xs text-t2">
                  正在打开关联技能…
                </p>
              )}
              {mdError && (
                <div role="alert" className="text-xs text-t2">
                  原文暂时读取失败{' '}
                  <button className="text-accentText underline ml-2" onClick={() => setRetry((n) => n + 1)}>
                    重新读取原文
                  </button>
                </div>
              )}
              {md && (
                <details
                  className={`rounded-xl border border-line ${isAgent ? 'shrink-0' : 'min-h-0 overflow-y-auto overscroll-contain'}`}
                >
                  <summary className="cursor-pointer text-sm font-semibold p-4">
                    查看 {graph?.entry || 'SKILL.md'} 原文{' '}
                    <span className="text-[11px] text-t2 font-mono ml-2">{md.version}</span>
                  </summary>
                  <pre
                    aria-label="技能原文"
                    tabIndex={0}
                    className={`text-[11px] leading-relaxed text-t2 font-mono whitespace-pre-wrap break-words ${isAgent ? 'max-h-[120px] overflow-y-auto overscroll-contain' : ''} px-4 pb-4 border-t border-line pt-3`}
                  >
                    {md.content}
                  </pre>
                </details>
              )}
            </div>
            <aside
              aria-label="详情补充信息"
              className="w-[320px] shrink-0 min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] space-y-4 pr-2"
            >
              <section className="rounded-xl border border-line p-4 flex flex-col gap-2.5">
                <h3 className="text-sm font-semibold">基本信息</h3>
                {[
                  ['类型', isAgent ? '智能体' : 'AI 技能'],
                  ['上传人', viewSkill.owner || '—'],
                  ['当前版本', graph?.version || viewSkill.version || '—'],
                  ['累计调用', `${viewSkill.usage.toLocaleString()} 次`],
                  ['近 7 日调用', viewSkill.calls7d === undefined ? '—' : `${viewSkill.calls7d} 次`],
                  ['更新时间', viewSkill.updatedAt?.slice(0, 10) || '—'],
                ].map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-2 text-xs">
                    <span className="text-t2 shrink-0">{key}</span>
                    <span className="font-medium text-right break-all">{value}</span>
                  </div>
                ))}
                <div className="border-t border-line pt-3">
                  <div className="text-[11px] text-t2 mb-1">归属部门</div>
                  <span className="text-xs">{ownerDept || '—'}</span>
                </div>
                <div>
                  <div className="text-[11px] text-t2 mb-1">适用部门</div>
                  <span className="text-xs">{applyText.join('、') || '—'}</span>
                </div>
                <div>
                  <div className="text-[11px] text-t2 mb-1">业务标签</div>
                  <span className="pill bg-soft text-t2">{viewSkill.category}</span>
                </div>
              </section>
              <section className="rounded-xl border border-line p-4">
                <h3 className="text-sm font-semibold mb-2.5">如何使用</h3>
                <p className="text-xs text-t2 leading-relaxed">
                  在 WorkBuddy 对话中描述你的业务需求，即可调用相关技能。首次使用请按使用指引配置 dt-skills
                  MCP 并安装技能。
                </p>
              </section>
              {graph && <RuntimeRequirements requirements={graph.runtimeRequirements} />}
              <EvalSection key={`skill:${slug}`} target={`skill:${slug}`} targetName={viewSkill.name} />
            </aside>
          </div>
        )}
      </div>
    </ZbModal>
  );
}
