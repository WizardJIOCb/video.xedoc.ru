import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2, LockKeyhole, Share2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { FreeCutLogo } from '@/components/brand/freecut-logo'
import { ShareAuthForm } from './auth-form'
import {
  downloadSharedProject,
  getSharedProject,
  getSession,
  type SharedProject,
  type SessionUser,
} from './share-client'

function readKey() {
  return new URLSearchParams(window.location.hash.slice(1)).get('key') ?? undefined
}

// fallow-ignore-next-line complexity -- access state and download state share one small landing page.
export function ShareView({ shareId }: { shareId: string }) {
  const [project, setProject] = useState<SharedProject | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState(false)
  const key = readKey()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setProject(await getSharedProject(shareId, key))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open shared project')
    } finally {
      setLoading(false)
    }
  }, [key, shareId])

  useEffect(() => {
    void getSession()
      .then(setUser)
      .catch(() => setUser(null))
    void load()
  }, [load])

  const download = async () => {
    if (!project) return
    setDownloading(true)
    setError(null)
    try {
      await downloadSharedProject(shareId, project.name, key)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not download shared project')
    } finally {
      setDownloading(false)
    }
  }

  const needsAccount = Boolean(error?.includes('not available to this account'))
  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-5">
        <Link to="/">
          <FreeCutLogo variant="full" size="md" />
        </Link>
      </header>
      <section className="mx-auto max-w-xl px-6 py-20">
        <div className="rounded-xl border border-border bg-card p-7 shadow-sm">
          <Share2 className="mb-4 h-8 w-8 text-primary" />
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Opening shared project…
            </div>
          ) : project ? (
            <div className="space-y-5">
              <div>
                <h1 className="text-2xl font-semibold">{project.name}</h1>
                <p className="mt-2 text-muted-foreground">
                  {project.mode === 'read' ? 'Read-only project snapshot' : 'Editable project copy'}
                </p>
              </div>
              <Alert>
                <LockKeyhole className="h-4 w-4" />
                <AlertDescription>
                  {project.mode === 'read'
                    ? 'This link never grants access to the owner’s local workspace.'
                    : 'Download the bundle, then import it into your own workspace to edit it.'}
                </AlertDescription>
              </Alert>
              <Button onClick={() => void download()} disabled={downloading}>
                {downloading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {project.mode === 'read' ? 'Download snapshot' : 'Download editable project'}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">Shared project</h1>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {needsAccount && !user && (
                <ShareAuthForm
                  onAuthenticated={(nextUser) => {
                    setUser(nextUser)
                    void load()
                  }}
                />
              )}
              {needsAccount && user && (
                <p className="text-sm text-muted-foreground">
                  You are signed in as {user.email}, but this project was shared with a different
                  account.
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}
