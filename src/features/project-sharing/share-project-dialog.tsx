import { useEffect, useState } from 'react'
import { CheckCircle2, Copy, Loader2, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Project } from '@/types/project'
import { exportProjectBundle } from './deps/project-bundle'
import { ShareAuthForm } from './auth-form'
import {
  createShare,
  getSession,
  uploadShareBundle,
  type SessionUser,
  type ShareMode,
} from './share-client'

// fallow-ignore-next-line complexity -- publication progress, auth state, and success view are intentionally presented in one modal.
export function ShareProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [mode, setMode] = useState<ShareMode>('read')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setShareUrl(null)
    void getSession()
      .then(setUser)
      .catch(() => setUser(null))
  }, [open])

  const copyLink = async () => {
    if (!shareUrl) return
    await navigator.clipboard.writeText(shareUrl)
    toast.success('Share link copied')
  }

  const publish = async () => {
    setBusy(true)
    setError(null)
    try {
      setProgress('Creating a portable project snapshot…')
      const share = await createShare({ mode, name: project.name, recipientEmail })
      const bundle = await exportProjectBundle(project.id, (event) => {
        setProgress(
          event.currentFile
            ? `Packing ${event.currentFile}`
            : `Packing project — ${Math.round(event.percent)}%`,
        )
      })
      if (!bundle.blob) throw new Error('Could not create the project bundle')
      setProgress('Uploading protected project snapshot…')
      await uploadShareBundle(share.uploadUrl, share.uploadToken, bundle.blob)
      setShareUrl(share.shareUrl)
      setProgress('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not share project')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5" />
            Share “{project.name}”
          </DialogTitle>
          <DialogDescription>
            Sharing creates a portable snapshot including the project media. Later local edits are
            not sent automatically.
          </DialogDescription>
        </DialogHeader>
        {shareUrl ? (
          <div className="space-y-4 py-2">
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>
                Project snapshot is ready. Keep this link private.
              </AlertDescription>
            </Alert>
            <Input readOnly value={shareUrl} aria-label="Share link" />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={() => void copyLink()}>
                <Copy className="mr-2 h-4 w-4" />
                Copy link
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setMode('read')}
                className={`rounded-lg border p-3 text-left ${mode === 'read' ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
              >
                <p className="font-medium">Read-only link</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  No registration. The link provides a view/download snapshot, but no access to your
                  workspace.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setMode('full')}
                className={`rounded-lg border p-3 text-left ${mode === 'full' ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
              >
                <p className="font-medium">Full access</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  An editable copy for one registered collaborator.
                </p>
              </button>
            </div>
            {mode === 'full' && (
              <>
                {!user ? (
                  <ShareAuthForm onAuthenticated={setUser} />
                ) : (
                  <Alert>
                    <AlertDescription>
                      Signed in as <strong>{user.email}</strong>
                    </AlertDescription>
                  </Alert>
                )}
                <Input
                  type="email"
                  value={recipientEmail}
                  onChange={(event) => setRecipientEmail(event.target.value)}
                  placeholder="Registered collaborator email"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  The collaborator must create an account first; only that email can download the
                  editable copy.
                </p>
              </>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {progress && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {progress}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy || (mode === 'full' && (!user || !recipientEmail))}
                onClick={() => void publish()}
              >
                {busy ? 'Sharing…' : 'Create share link'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
