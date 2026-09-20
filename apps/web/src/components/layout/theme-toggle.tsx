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
      className="h-8 gap-1.5 px-2"
    >
      {theme === 'dark' ? (
        <svg
          aria-hidden="true"
          className="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <path d="M12 3a6 6 0 1 0 9 9A9 9 0 1 1 12 3Z" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          className="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <circle cx="12" cy="12" r="4" strokeWidth="2" />
          <path
            d="M12 2v2m0 16v2m10-10h-2M4 12H2m17.1-7.1-1.4 1.4M6.3 17.7l-1.4 1.4m14.2 0-1.4-1.4M6.3 6.3 4.9 4.9"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span className="text-xs font-medium">{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </Button>
  );
}
