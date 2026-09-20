import * as React from 'react';
import { Button } from '@/components/ui/button';
import { applyTheme, getInitialTheme, type Theme } from '@/lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>(() => getInitialTheme());

  React.useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Sync with external changes (e.g., initial inline script)
  React.useEffect(() => {
    const isDark = document.documentElement.classList.contains('dark');
    setTheme(isDark ? 'dark' : 'light');
  }, []);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      aria-pressed={theme === 'dark'}
      onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
      className="h-8 gap-1.5"
    >
      <span aria-hidden="true" className="text-[15px] leading-none">
        {theme === 'dark' ? '☾' : '☼'}
      </span>
      <span className="hidden sm:inline text-xs font-medium">
        {theme === 'dark' ? 'Dark' : 'Light'}
      </span>
    </Button>
  );
}
