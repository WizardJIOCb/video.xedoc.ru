import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authenticate, type SessionUser } from './share-client'

// fallow-ignore-next-line complexity -- one compact form owns its mutually-exclusive sign-in/register state.
export function ShareAuthForm({
  onAuthenticated,
}: {
  onAuthenticated: (user: SessionUser) => void
}) {
  const [action, setAction] = useState<'register' | 'login'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onAuthenticated(await authenticate(action, email, password))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex gap-2 text-sm">
        <Button
          type="button"
          size="sm"
          variant={action === 'register' ? 'default' : 'outline'}
          onClick={() => setAction('register')}
        >
          Create account
        </Button>
        <Button
          type="button"
          size="sm"
          variant={action === 'login' ? 'default' : 'outline'}
          onClick={() => setAction('login')}
        >
          Sign in
        </Button>
      </div>
      <Input
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Email"
        required
      />
      <Input
        type="password"
        autoComplete={action === 'register' ? 'new-password' : 'current-password'}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password (at least 8 characters)"
        minLength={8}
        required
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Please wait…' : action === 'register' ? 'Register' : 'Sign in'}
      </Button>
    </form>
  )
}
