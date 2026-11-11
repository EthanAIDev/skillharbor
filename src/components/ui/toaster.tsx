/* copy-in 自 shadcn/ui new-york（Tailwind v3 版，shadcn-ui/ui@84bd724d）。
 * 本仓适配：仅改 import 路径。在 App 根部挂载一次（<Toaster />）即可全局 useToast()。 */
import { useToast } from './use-toast';
import { Toast, ToastClose, ToastDescription, ToastTitle, ToastProvider, ToastViewport } from './toast';

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className='grid gap-1'>
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
