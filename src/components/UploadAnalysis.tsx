import { useEffect, useRef, useState } from 'react';
import type { SmartAnalysis } from '../services/smartUpload';
import RuntimeRequirements from './RuntimeRequirements';

interface Props {
  analysis: SmartAnalysis | null;
  busy: boolean;
  error: string;
  disabled?: boolean;
  onRetry: () => void;
  onAnswer: (question: string, choice: string) => void;
  onCopy: (value: string) => Promise<boolean>;
}
const labels = { agent: '智能体', skill: 'AI 技能', tool: '工具' };

/** Analysis is part of the publishing form; it never introduces a second upload flow. */
export default function UploadAnalysis({ analysis, busy, error, disabled, onRetry, onAnswer, onCopy }: Props) {
  const [choice, setChoice] = useState('');
  const [copied, setCopied] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setChoice(''); setCopied(false); }, [analysis]);
  return <section aria-label="包内容解析" className="shrink-0 space-y-3 rounded-[14px] border border-line p-3.5">
    <div className="flex items-center justify-between gap-3">
      <h3 ref={headingRef} tabIndex={-1} className="focus-ring rounded text-[12.5px] font-semibold">包内容解析</h3>
      {analysis && <span className="pill bg-accentSoft text-accentText">{analysis.engine === 'ai' ? 'AI 解析' : '结构检查'} · {labels[analysis.kind]}</span>}
    </div>
    {busy ? <p role="status" className="text-xs text-t2">正在解析包内容，请稍候…</p> : error ? <div role="alert" className="space-y-2 text-xs text-danger">
      <p>{error}</p><p className="text-t2">草稿已保留，可重新解析后继续填写。</p>
      <button type="button" className="btn-ghost focus-ring !text-xs" disabled={disabled} onClick={() => { headingRef.current?.focus({ preventScroll: true }); onRetry(); }}>重新解析</button>
    </div> : analysis && <>
      {analysis.aiNotice && <p className="text-xs leading-relaxed text-t2">{analysis.aiNotice}</p>}
      {analysis.status === 'question' && analysis.question && <div className="space-y-3">
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="mb-2 text-xs font-medium">{analysis.question.prompt}</legend>
          {analysis.question.options.map(option => <label key={option.id} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-xs ${choice === option.id ? 'border-accent bg-accentSoft' : 'border-line'}`}>
            <input type="radio" name={`analysis-${analysis.question!.id}`} value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} className="mt-0.5 accent-accent" />
            <span><span className="block font-medium">{option.label}</span><span className="mt-1 block text-t2">{option.description}</span></span>
          </label>)}
        </fieldset>
        <button type="button" className="btn-primary focus-ring !text-xs" disabled={!choice || disabled} onClick={() => { headingRef.current?.focus({ preventScroll: true }); onAnswer(analysis.question!.id, choice); }}>确认并继续解析</button>
      </div>}
      {analysis.status === 'blocked' && <div className="space-y-2 text-xs">
        <p role="alert" className="font-medium text-danger">包内容尚未通过检查，请按以下提示修改。</p>
        <ul className="list-disc space-y-1 pl-4 text-t2">{analysis.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>
        {analysis.repairText && <><p className="whitespace-pre-wrap leading-relaxed text-t2">{analysis.repairText}</p><button type="button" className="rounded text-accentText underline focus-ring" onClick={async () => setCopied(await onCopy(analysis.repairText))}>{copied ? '已复制修改建议' : '复制修改建议'}</button></>}
        <button type="button" className="btn-ghost focus-ring !text-xs" disabled={disabled} onClick={() => { headingRef.current?.focus({ preventScroll: true }); onRetry(); }}>重新解析</button>
      </div>}
      {analysis.status === 'ready' && <>
        <p role="status" className="text-xs text-t2">已识别 {analysis.resource.functions.length} 项功能，请核对右侧资源信息。</p>
        <ul className="space-y-1.5 text-xs">{analysis.resource.functions.slice(0, 5).map((item, index) => <li key={index} className="flex justify-between gap-3"><span>{item.name}</span><span className="shrink-0 text-t3">{item.source === 'registry' ? '平台技能' : '包内功能'}</span></li>)}</ul>
        {analysis.resource.functions.length > 5 && <details className="text-xs"><summary className="cursor-pointer text-accentText">其余 {analysis.resource.functions.length - 5} 项功能</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-t2">{analysis.resource.functions.slice(5).map((item, index) => <li key={index}>{item.name}</li>)}</ul></details>}
        <RuntimeRequirements requirements={analysis.runtimeRequirements} />
      </>}
    </>}
  </section>;
}
