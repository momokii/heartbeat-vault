import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function SetupPage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">First-run setup</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Placeholder — one-time setup token flow lands in T7.2. This page previews the layout only.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Setup token</CardTitle>
          <CardDescription>
            Paste the one-time token printed by{' '}
            <code className="font-mono text-xs">install.sh</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={e => e.preventDefault()}>
            <div className="space-y-2">
              <Label htmlFor="setup-token">Setup token</Label>
              <Input
                id="setup-token"
                name="token"
                type="password"
                autoComplete="one-time-code"
                placeholder="hv_setup_..."
                required
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Token is single-use and expires. No network request is made in this shell.
              </p>
            </div>
            <Button type="submit" className="w-full">
              Verify token
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
