/* ZbModal：存量手写弹窗的统一收敛封装（2026-10-20 shadcn/ui 选型落地）。
 * 底座 = Radix Dialog（@radix-ui/react-dialog，经 src/components/ui/ 体系引入），
 * 视觉 = 全站手写弹窗的原样复刻：bg-black/40 anim-fade 遮罩 + .card p-6 anim-pop 卡片，
 * 关闭瞬间卸载（无退场动画）也与手写版一致。
 * 相对手写版的净增能力（均为无感增强，不改变观感）：ESC 关闭、焦点圈禁+初始焦点落在
 * 卡片本身（不点亮第一个输入框的 focus 边框）、滚动锁定（html 的 scrollbar-gutter:
 * stable 已为锁滚动预留槽位，视口不跳动）、无障碍 Title。
 * 用法（替换 fixed inset-0 三层手写结构，children 原样搬进来）：
 *   <ZbModal open={show} onClose={() => setShow(false)} label="新增人员" maxWidth="max-w-[420px]">
 *     <h2 …>新增人员</h2> <form …>…</form>
 *   </ZbModal> */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../lib/utils';

export interface ZbModalProps {
  open: boolean;
  onClose: () => void;
  /** 无障碍标题：渲染为视觉隐藏的 DialogTitle（Radix 必需；屏幕阅读器读一次即可） */
  label: string;
  /** 卡片宽度类（tailwind max-w-*），默认 max-w-[420px]，与存量弹窗主力宽度一致 */
  maxWidth?: string;
  className?: string;
  /** 初始焦点目标（如首个输入框）；缺省聚焦卡片本身，避免点亮表单控件的 focus 边框 */
  focusRef?: React.RefObject<HTMLElement | null>;
  /** 是否允许点外/ESC 关闭（默认 true）；多步向导等怕误触丢进度的场景传 false（✕ 按钮不受影响） */
  dismissible?: boolean;
  children: React.ReactNode;
}

export function ZbModal({ open, onClose, label, maxWidth = 'max-w-[420px]', className, focusRef, dismissible = true, children }: ZbModalProps) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className='fixed inset-0 z-50 bg-black/40 anim-fade' />
        {/* Content 做全屏弹性容器，真正的卡片是内层 div——这样 anim-pop 的 transform
            缩放不会干扰居中定位。点外关闭：Radix 在 modal 下会给 Content 内联
            pointer-events:auto（类名压不过），遮罩收不到点击，故由 Content 自身判定
            「按下落点=自身(卡片外)」即关闭——与旧版遮罩 onClick 关闭同语义，且只在
            按下起点在卡片外才关，拖选文本不会误关。 */}
        <DialogPrimitive.Content
          className='fixed inset-0 z-50 flex items-center justify-center p-4'
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            (focusRef?.current ?? cardRef.current)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            const opener = openerRef.current;
            if (opener?.isConnected && !opener.matches(':disabled, [inert], [inert] *')) {
              e.preventDefault();
              opener.focus({ preventScroll: true });
            }
          }}
          onEscapeKeyDown={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onPointerDown={(e) => {
            if (dismissible && e.target === e.currentTarget) onClose();
          }}
          onInteractOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
        >
          <DialogPrimitive.Title className='sr-only'>{label}</DialogPrimitive.Title>
          <div
            ref={cardRef}
            tabIndex={-1}
            className={cn('card relative w-full p-6 anim-pop outline-none', maxWidth, className)}
          >
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default ZbModal;
