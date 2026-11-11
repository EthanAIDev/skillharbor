/* shadcn/ui copy-in 基建（2026-10-20 组件库选型落地，详见 docs 或提交说明）：
 * cn = clsx 拼接 + tailwind-merge 冲突消解，是 src/components/ui/ 下组件的标配工具。
 * tailwind-merge 锁 v2（v3 面向 Tailwind v4，与本仓 Tailwind 3.4 不匹配）。 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
