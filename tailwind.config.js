/** @type {import('tailwindcss').Config} */
import animate from 'tailwindcss-animate';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        card: 'rgb(var(--c-card) / <alpha-value>)',
        soft: 'rgb(var(--c-soft) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        t1: 'rgb(var(--c-t1) / <alpha-value>)',
        t2: 'rgb(var(--c-t2) / <alpha-value>)',
        t3: 'rgb(var(--c-t3) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        accentSoft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
        accentText: 'rgb(var(--c-accent-text) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        okSoft: 'rgb(var(--c-ok-soft) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        warnSoft: 'rgb(var(--c-warn-soft) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        dangerSoft: 'rgb(var(--c-danger-soft) / <alpha-value>)',
        /* shadcn/ui 别名令牌（值=index.css 里的 --background 等，逐一别名到 --c-*），
         * 供 src/components/ui/ 的 copy-in 组件使用；不覆盖上方既有键（card 同值不重复定义），
         * 也不引入 --accent（与品牌色 accent 冲突，见 index.css 注释）。 */
        background: 'rgb(var(--background) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        popover: 'rgb(var(--popover) / <alpha-value>)',
        popoverForeground: 'rgb(var(--popover-foreground) / <alpha-value>)',
        primary: 'rgb(var(--primary) / <alpha-value>)',
        primaryForeground: 'rgb(var(--primary-foreground) / <alpha-value>)',
        secondary: 'rgb(var(--secondary) / <alpha-value>)',
        secondaryForeground: 'rgb(var(--secondary-foreground) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        mutedForeground: 'rgb(var(--muted-foreground) / <alpha-value>)',
        destructive: 'rgb(var(--destructive) / <alpha-value>)',
        destructiveForeground: 'rgb(var(--destructive-foreground) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        ring: 'rgb(var(--ring) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans SC', 'PingFang SC', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: '16px',
      },
    },
  },
  plugins: [animate],
};
