/* 内联图标（lucide 路径，24×24 stroke）：替代 shadcn 源码里的 lucide-react 依赖。
 * 内网零外网原则 + 现仓库本就以内联 SVG 为图标惯例，故不引入 lucide-react。 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  };
}

export function IconX(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** Radio 指示点：实心，遵循 lucide Circle.fill-current 用法 */
export function IconCircleFill(props: IconProps) {
  return (
    <svg {...base({ fill: 'currentColor', stroke: 'none', ...props })}>
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}
