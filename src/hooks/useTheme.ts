import { useCallback, useEffect, useState } from 'react';

const KEY = 'skillharbor-theme';

export function useTheme() {
  const [dark, setDark] = useState<boolean>(() => {
    try {
      const forced = new URLSearchParams(location.search).get('theme');
      if (forced === 'dark' || forced === 'light') return forced === 'dark';
      const v = localStorage.getItem(KEY);
      if (v) return v === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem(KEY, dark ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);
  return { dark, toggle };
}
