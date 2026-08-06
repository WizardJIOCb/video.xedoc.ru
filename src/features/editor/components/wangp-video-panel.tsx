import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Download,
  ImagePlus,
  Loader2,
  PlugZap,
  RefreshCw,
  WandSparkles,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  importMediaLibraryService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'

const CONNECTOR_CHANNEL = 'freecut-wangp'

type ConnectorAction = 'health' | 'start' | 'poll'
type ConnectorJobState = 'queued' | 'generating' | 'completed' | 'error'

interface ConnectorResult {
  status?: ConnectorJobState
  message?: string
  jobId?: string
  outputUrl?: string
}

interface DownloadMeta {
  name: string
  mimeType: string
}

interface ReferenceImagePayload {
  name: string
  mimeType: string
  base64: string
}

const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024

function toReferenceImagePayload(file: File): Promise<ReferenceImagePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Could not read the reference image.'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read the reference image.'))
        return
      }
      const base64 = reader.result.slice(reader.result.indexOf(',') + 1)
      resolve({ name: file.name, mimeType: file.type || 'image/png', base64 })
    }
    reader.readAsDataURL(file)
  })
}

function requestConnector<T>(action: ConnectorAction, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Connector did not respond. Install or reload the FreeCut WanGP Connector.'))
    }, 12_000)

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== window) return
      const message = event.data as {
        channel?: string
        kind?: string
        requestId?: string
        ok?: boolean
        payload?: T
        error?: string
      }
      if (
        message?.channel !== CONNECTOR_CHANNEL ||
        message.kind !== 'response' ||
        message.requestId !== requestId
      ) {
        return
      }
      cleanup()
      if (message.ok) resolve(message.payload as T)
      else reject(new Error(message.error || 'Connector request failed.'))
    }

    const cleanup = () => {
      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
    }

    window.addEventListener('message', onMessage)
    window.postMessage(
      { channel: CONNECTOR_CHANNEL, kind: 'request', requestId, action, payload },
      window.location.origin,
    )
  })
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function downloadFromConnector(url: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const chunks: ArrayBuffer[] = []
    let meta: DownloadMeta = { name: 'wangp-generated-video.mp4', mimeType: 'video/mp4' }
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('The generated video download timed out.'))
    }, 30 * 60_000)

    const cleanup = () => {
      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
    }

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== window) return
      const message = event.data as {
        channel?: string
        kind?: string
        requestId?: string
        type?: string
        data?: string
        name?: string
        mimeType?: string
        error?: string
      }
      if (
        message?.channel !== CONNECTOR_CHANNEL ||
        message.kind !== 'download' ||
        message.requestId !== requestId
      ) {
        return
      }

      if (message.type === 'meta') {
        meta = {
          name: message.name || meta.name,
          mimeType: message.mimeType?.startsWith('video/') ? message.mimeType : meta.mimeType,
        }
      } else if (message.type === 'chunk' && message.data) {
        chunks.push(base64ToArrayBuffer(message.data))
      } else if (message.type === 'complete') {
        cleanup()
        resolve(new File(chunks, meta.name, { type: meta.mimeType }))
      } else if (message.type === 'error') {
        cleanup()
        reject(new Error(message.error || 'The connector could not download the generated video.'))
      }
    }

    window.addEventListener('message', onMessage)
    window.postMessage(
      {
        channel: CONNECTOR_CHANNEL,
        kind: 'request',
        requestId,
        action: 'download',
        payload: { url },
      },
      window.location.origin,
    )
  })
}

export const WangpVideoPanel = memo(function WangpVideoPanel() {
  const currentProjectId = useMediaLibraryStore((state) => state.currentProjectId)
  const loadMediaItems = useMediaLibraryStore((state) => state.loadMediaItems)
  const selectMedia = useMediaLibraryStore((state) => state.selectMedia)
  const showNotification = useMediaLibraryStore((state) => state.showNotification)

  const [prompt, setPrompt] = useState('')
  const [referenceImage, setReferenceImage] = useState<File | null>(null)
  const [connectorStatus, setConnectorStatus] = useState<'checking' | 'ready' | 'offline'>(
    'checking',
  )
  const [message, setMessage] = useState('Checking local WanGP connector…')
  const [job, setJob] = useState<ConnectorResult | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const referenceInputRef = useRef<HTMLInputElement>(null)

  const checkConnector = useCallback(async () => {
    setConnectorStatus('checking')
    setMessage('Checking local WanGP connector…')
    try {
      await requestConnector<{ available: boolean }>('health')
      setConnectorStatus('ready')
      setMessage('WanGP is ready on this computer.')
    } catch (error) {
      setConnectorStatus('offline')
      setMessage(error instanceof Error ? error.message : 'Connector is unavailable.')
    }
  }, [])

  useEffect(() => {
    void checkConnector()
  }, [checkConnector])

  useEffect(() => {
    if (!job?.jobId || job.status === 'completed' || job.status === 'error') return

    let cancelled = false
    const timer = window.setInterval(() => {
      void requestConnector<ConnectorResult>('poll', { jobId: job.jobId })
        .then((nextJob) => {
          if (!cancelled) setJob((previous) => ({ ...previous, ...nextJob }))
        })
        .catch((error) => {
          if (!cancelled) {
            setJob((previous) => ({
              ...previous,
              status: 'error',
              message: error instanceof Error ? error.message : 'Could not read WanGP status.',
            }))
          }
        })
    }, 3_000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [job?.jobId, job?.status])

  const startGeneration = useCallback(async () => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      setMessage('Describe the video first.')
      return
    }
    if (!currentProjectId) {
      setMessage('Open a project before starting a generation.')
      return
    }

    setIsStarting(true)
    setMessage('Sending the prompt to WanGP…')
    try {
      const payload = referenceImage ? await toReferenceImagePayload(referenceImage) : undefined
      const started = await requestConnector<ConnectorResult>('start', {
        prompt: trimmedPrompt,
        referenceImage: payload,
      })
      setJob(started)
      setMessage(started.message || 'Submitted to WanGP queue.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start WanGP generation.')
    } finally {
      setIsStarting(false)
    }
  }, [currentProjectId, prompt, referenceImage])

  const selectReferenceImage = useCallback((file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setMessage('Choose a PNG, JPEG, or WebP image.')
      return
    }
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      setMessage('The reference image must be 10 MB or smaller.')
      return
    }
    setReferenceImage(file)
    setMessage(`Reference image “${file.name}” selected.`)
  }, [])

  const importVideo = useCallback(async () => {
    if (!currentProjectId || !job?.outputUrl) return
    setIsImporting(true)
    setMessage('Downloading the generated video from WanGP…')
    try {
      const file = await downloadFromConnector(job.outputUrl)
      const { mediaLibraryService } = await importMediaLibraryService()
      const media = await mediaLibraryService.importGeneratedVideo(file, currentProjectId, {
        tags: ['ai-generated', 'wangp', 'source:local-wangp'],
      })
      await loadMediaItems()
      selectMedia([media.id])
      setMessage(`Imported “${media.fileName}” into this project.`)
      showNotification({
        type: 'success',
        message: `WanGP video “${media.fileName}” saved to the library.`,
      })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not import the generated video.')
    } finally {
      setIsImporting(false)
    }
  }, [currentProjectId, job?.outputUrl, loadMediaItems, selectMedia, showNotification])

  const jobBusy = job?.status === 'queued' || job?.status === 'generating'
  const completed = job?.status === 'completed' && Boolean(job.outputUrl)

  return (
    <section className="border-b border-border bg-secondary/10 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <WandSparkles className="h-4 w-4 text-primary" />
            WanGP video
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Uses the local GPU on this computer.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-[11px]"
          onClick={() => void checkConnector()}
          disabled={connectorStatus === 'checking'}
        >
          {connectorStatus === 'checking' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : connectorStatus === 'ready' ? (
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          ) : (
            <PlugZap className="h-3 w-3" />
          )}
          {connectorStatus === 'ready' ? 'Connected' : 'Check'}
        </Button>
      </div>

      <Textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe the video you want to generate…"
        className="mt-2 min-h-20 resize-y bg-background/50 text-xs"
        disabled={connectorStatus !== 'ready' || jobBusy || isImporting}
      />

      <input
        ref={referenceInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(event) => {
          selectReferenceImage(event.target.files?.[0] ?? null)
          event.currentTarget.value = ''
        }}
      />
      <div className="mt-2 flex items-center gap-1.5">
        {referenceImage ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-primary/30 bg-primary/5 px-2 py-1 text-[11px] text-muted-foreground">
            <ImagePlus className="h-3 w-3 shrink-0 text-primary" />
            <span className="truncate" title={referenceImage.name}>
              {referenceImage.name}
            </span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded p-0.5 hover:bg-secondary hover:text-foreground"
              onClick={() => setReferenceImage(null)}
              aria-label="Remove reference image"
              disabled={jobBusy || isImporting}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[11px]"
            onClick={() => referenceInputRef.current?.click()}
            disabled={connectorStatus !== 'ready' || jobBusy || isImporting}
          >
            <ImagePlus className="h-3 w-3" />
            Animate image
          </Button>
        )}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground" role="status">
        {job?.message || message}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          onClick={() => void startGeneration()}
          disabled={
            connectorStatus !== 'ready' || isStarting || jobBusy || isImporting || !prompt.trim()
          }
        >
          {isStarting || jobBusy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <WandSparkles className="h-3 w-3" />
          )}
          {jobBusy ? 'Generating…' : 'Generate'}
        </Button>
        {completed && (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 gap-1.5 text-[11px]"
            onClick={() => void importVideo()}
            disabled={isImporting}
          >
            {isImporting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {isImporting ? 'Importing…' : 'Import to library'}
          </Button>
        )}
        {job?.status === 'error' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-[11px]"
            onClick={() => setJob(null)}
          >
            <RefreshCw className="h-3 w-3" />
            Reset
          </Button>
        )}
      </div>
    </section>
  )
})
