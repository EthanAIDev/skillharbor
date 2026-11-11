interface Props {
  requirements?: string[];
}

export default function RuntimeRequirements({ requirements = [] }: Props) {
  if (!requirements.length) return null;
  return (
    <section aria-label="运行环境要求" className="rounded-xl border border-line p-4 text-sm">
      <h3 className="font-semibold">运行环境要求</h3>
      <p className="text-xs text-t2 leading-relaxed mt-2">
        使用环境需提供这些工具或接口，平台未验证实际可用性。
      </p>
      <ul
        aria-label="运行环境要求清单"
        tabIndex={0}
        className="mt-3 space-y-2 list-disc ps-5 max-h-40 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] text-xs text-t2 leading-relaxed break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {requirements.map((requirement, index) => (
          <li key={`${requirement}:${index}`}>{requirement}</li>
        ))}
      </ul>
    </section>
  );
}
