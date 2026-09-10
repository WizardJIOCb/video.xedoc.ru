import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  AudioLines,
  Captions,
  CheckCircle2,
  Clapperboard,
  FileAudio,
  Loader2,
  Scissors,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import {
  importMediaLibraryService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import { useItemsStore } from '@/features/editor/deps/timeline-store'
import {
  useFillerRemovalDialogStore,
  useSilenceRemovalDialogStore,
} from '@/features/editor/deps/timeline-ui'
import {
  importFillerRemovalPreview,
  mediaTranscriptionService,
  runMediaTranscriptionJob,
} from '@/features/editor/deps/shorts-studio'
import { cleanSpeechAudio, type ClearAudioProgress } from '../services/clear-audio-service'
import { insertGeneratedAudioOnNewTrack } from '../utils/insert-generated-audio'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'

type StudioOperation = 'captions' | 'cleaning' | 'fillers' | null

type AudioVideoItem = TimelineItem & {
  mediaId: string
  type: 'audio' | 'video'
}

function isAudioVideoItem(item: TimelineItem): item is AudioVideoItem {
  return (item.type === 'audio' || item.type === 'video') && Boolean(item.mediaId)
}

function stageLabel(progress: ClearAudioProgress | null): string {
  switch (progress?.stage) {
    case 'decoding':
      return 'Читаю аудио из исходника'
    case 'downloading':
      return 'Загружаю модель очистки (только при первом запуске)'
    case 'enhancing':
      return 'Убираю шум и эхо, выравниваю громкость'
    case 'encoding':
      return 'Сохраняю отдельную WAV-дорожку'
    default:
      return 'Подготавливаю задачу'
  }
}

function asAudioFile(source: Blob, media: MediaMetadata): File {
  return source instanceof File
    ? source
    : new File([source], media.fileName, { type: media.mimeType || source.type })
}

function cleanupSuccessMessage(inserted: boolean, inputLufs: number | null): string {
  const lufs = inputLufs === null ? '' : ` Вход: ${inputLufs.toFixed(1)} LUFS.`
  return inserted
    ? `Создана очищенная WAV-дорожка. Исходник сохранён без изменений.${lufs}`
    : `Очищенная WAV сохранена в медиатеке.${lufs}`
}

async function createCleanAudioTrack({
  media,
  item,
  projectId,
  onProgress,
}: {
  media: MediaMetadata
  item: AudioVideoItem
  projectId: string
  onProgress: (next: ClearAudioProgress) => void
}): Promise<{ inserted: boolean; inputLufs: number | null }> {
  const { mediaLibraryService } = await importMediaLibraryService()
  const source = await mediaLibraryService.getMediaFile(media.id)
  if (!source) {
    throw new Error('Не удалось прочитать исходный файл.')
  }

  const cleaned = await cleanSpeechAudio(asAudioFile(source, media), onProgress)
  const cleanedMedia = await mediaLibraryService.importGeneratedAudio(cleaned.file, projectId, {
    tags: ['speech-cleanup', 'clear'],
    codec: 'pcm_s16le',
  })
  await useMediaLibraryStore.getState().loadMediaItems()
  return {
    inserted: insertGeneratedAudioOnNewTrack(
      cleanedMedia,
      URL.createObjectURL(cleaned.file),
      item.from,
    ),
    inputLufs: cleaned.inputLufs,
  }
}

export function ShortsStudioDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  const timelineItems = useItemsStore((state) => state.items)
  const mediaById = useMediaLibraryStore((state) => state.mediaById)
  const showNotification = useMediaLibraryStore((state) => state.showNotification)
  const [operation, setOperation] = useState<StudioOperation>(null)
  const [progress, setProgress] = useState(0)
  const [detail, setDetail] = useState<string | null>(null)

  const targetItems = useMemo(() => timelineItems.filter(isAudioVideoItem), [timelineItems])
  const uniqueMediaTargets = useMemo(() => {
    const seen = new Set<string>()
    return targetItems.filter((item) => {
      if (seen.has(item.mediaId)) return false
      seen.add(item.mediaId)
      return true
    })
  }, [targetItems])
  const cleanupTarget = targetItems[0] ?? null

  const withTarget = useCallback(
    (callback: () => void | Promise<void>) => {
      if (targetItems.length === 0) {
        showNotification({
          type: 'info',
          message: 'Сначала добавьте видео или аудио на таймлайн.',
        })
        return
      }
      void callback()
    },
    [showNotification, targetItems.length],
  )

  const handleCaptions = useCallback(() => {
    withTarget(async () => {
      setOperation('captions')
      setProgress(0)
      setDetail('Готовлю локальную расшифровку')

      try {
        for (const [index, item] of uniqueMediaTargets.entries()) {
          const media = mediaById[item.mediaId]
          if (!media) continue

          const status = useMediaLibraryStore.getState().transcriptStatus.get(item.mediaId)
          if (status !== 'ready') {
            setDetail(`Расшифровываю: ${media.fileName}`)
            const result = await runMediaTranscriptionJob(item.mediaId, {
              // Shorts Studio should be ready on an ordinary creator workstation. Large Turbo
              // is a manual quality option, but its multi-gigabyte runtime can leave the
              // one-click workflow stuck on the final window. Base + Hybrid is the reliable
              // local default and keeps word timings for captions.
              model: 'whisper-base',
              quantization: 'hybrid',
              language: 'ru',
              onProgress: (jobProgress) =>
                setProgress((index + jobProgress.progress) / uniqueMediaTargets.length),
            })
            if (result.status === 'cancelled') {
              throw new Error('Расшифровка отменена.')
            }
          }

          const clipIds = targetItems
            .filter((candidate) => candidate.mediaId === item.mediaId)
            .map((candidate) => candidate.id)
          await mediaTranscriptionService.enableTranscriptCaptions(item.mediaId, {
            clipIds,
            replaceExisting: true,
          })
          setProgress((index + 1) / uniqueMediaTargets.length)
        }

        showNotification({
          type: 'success',
          message: 'Расшифровка готова, субтитры включены на таймлайне.',
        })
        setDetail('Готово: субтитры связаны с расшифровкой и обновятся при её правке.')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Не удалось создать субтитры.'
        setDetail(message)
        showNotification({ type: 'error', message })
      } finally {
        setOperation(null)
      }
    })
  }, [mediaById, showNotification, targetItems, uniqueMediaTargets, withTarget])

  const handleSilence = useCallback(() => {
    withTarget(() => {
      onOpenChange(false)
      useSilenceRemovalDialogStore.getState().open({ itemIds: targetItems.map((item) => item.id) })
    })
  }, [onOpenChange, targetItems, withTarget])

  const handleFillers = useCallback(() => {
    withTarget(async () => {
      setOperation('fillers')
      setProgress(0)
      setDetail('Проверяю расшифровку и слова-паразиты')
      try {
        const {
          analyzeFillerWordsForItems,
          applyFillerPreviewOverlays,
          DEFAULT_FILLER_REMOVAL_SETTINGS,
        } = await importFillerRemovalPreview()
        const settings = {
          ...DEFAULT_FILLER_REMOVAL_SETTINGS,
          fillerWords: [
            ...DEFAULT_FILLER_REMOVAL_SETTINGS.fillerWords,
            'ээ',
            'эм',
            'мм',
            'м-м',
            'ну',
          ],
          fillerPhrases: [...DEFAULT_FILLER_REMOVAL_SETTINGS.fillerPhrases, 'как бы', 'это самое'],
        }
        const itemIds = targetItems.map((item) => item.id)
        const rangesByMediaId = await analyzeFillerWordsForItems(itemIds, settings)
        const summary = applyFillerPreviewOverlays(itemIds, rangesByMediaId)
        setProgress(1)

        if (summary.rangeCount === 0) {
          showNotification({
            type: 'info',
            message: 'По текущим правилам слов-паразитов не найдено.',
          })
          return
        }

        onOpenChange(false)
        useFillerRemovalDialogStore.getState().open({
          itemIds,
          settings,
          rangesByMediaId,
          summary,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Не удалось проверить слова-паразиты.'
        setDetail(message)
        showNotification({ type: 'error', message })
      } finally {
        setOperation(null)
      }
    })
  }, [onOpenChange, showNotification, targetItems, withTarget])

  const handleCleanAudio = useCallback(() => {
    const target = cleanupTarget
    const media = target ? mediaById[target.mediaId] : undefined
    if (!target || !media) {
      showNotification({ type: 'error', message: 'Не удалось найти исходное медиа.' })
      return
    }

    withTarget(async () => {
      setOperation('cleaning')
      setProgress(0)
      setDetail('Подготавливаю локальную обработку речи')
      try {
        const cleaned = await createCleanAudioTrack({
          media,
          item: target,
          projectId,
          onProgress: (next) => {
            setProgress(next.progress)
            setDetail(stageLabel(next))
          },
        })
        showNotification({
          type: cleaned.inserted ? 'success' : 'warning',
          message: cleanupSuccessMessage(cleaned.inserted, cleaned.inputLufs),
        })
        setDetail(
          'Готово: новая WAV-дорожка добавлена отдельно; сравните её с оригиналом перед экспортом.',
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Не удалось очистить звук.'
        setDetail(message)
        showNotification({ type: 'error', message })
      } finally {
        setOperation(null)
      }
    })
  }, [cleanupTarget, mediaById, projectId, showNotification, withTarget])

  const isBusy = operation !== null
  const cleanupFileName = cleanupTarget ? mediaById[cleanupTarget.mediaId]?.fileName : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-5 p-0 overflow-hidden">
        <div className="border-b border-border bg-gradient-to-br from-primary/12 via-background to-background px-6 py-5">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/30 bg-primary/15 text-primary">
                <Clapperboard className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle>Студия Shorts</DialogTitle>
                <DialogDescription className="mt-1">
                  Соберите вертикальный ролик, а речь и файлы останутся на вашем устройстве.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="space-y-3 px-6 pb-6">
          {targetItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              Добавьте видео на таймлайн — здесь появятся инструменты для его подготовки к шортсу.
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
              На таймлайне: {targetItems.length} фрагм. · {uniqueMediaTargets.length} исходн. медиа
              {cleanupFileName ? ` · очистка звука: ${cleanupFileName}` : ''}
            </div>
          )}

          <StudioStep
            icon={<Captions className="h-4 w-4" />}
            number="01"
            title="Расшифровка и субтитры"
            description="Локальная расшифровка с таймингами; субтитры привязываются к клипу и остаются редактируемыми."
            action="Создать субтитры"
            busy={operation === 'captions'}
            disabled={isBusy && operation !== 'captions'}
            onClick={handleCaptions}
          />
          <StudioStep
            icon={<AudioLines className="h-4 w-4" />}
            number="02"
            title="Паузы и слова-паразиты"
            description="Сначала показывает найденные места на таймлайне; вы подтверждаете, что именно вырезать."
            action="Проверить паузы"
            secondaryAction="Проверить паразиты"
            busy={operation === 'fillers'}
            disabled={isBusy && operation !== 'fillers'}
            onClick={handleSilence}
            onSecondaryClick={handleFillers}
          />
          <StudioStep
            icon={<Wand2 className="h-4 w-4" />}
            number="03"
            title="Очистка речи"
            description="Убирает шум и эхо, нормализует громкость и создаёт отдельную WAV-дорожку — оригинал не перезаписывается."
            action="Очистить звук"
            busy={operation === 'cleaning'}
            disabled={isBusy && operation !== 'cleaning'}
            onClick={handleCleanAudio}
          />
          <StudioStep
            icon={<Scissors className="h-4 w-4" />}
            number="04"
            title="Собрать шортс"
            description="Вертикальный проект 9:16, редактор, кадрирование, титры и экспорт уже доступны в текущем монтаже."
            action="Продолжить в редакторе"
            disabled={isBusy}
            onClick={() => onOpenChange(false)}
          />

          {operation && (
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                {detail ?? 'Выполняю локально'}
              </div>
              <Progress className="mt-2 h-1.5" value={Math.round(progress * 100)} />
            </div>
          )}

          {!operation && detail && (
            <div className="flex gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              {detail}
            </div>
          )}

          <p className="flex items-start gap-2 pt-1 text-xs leading-relaxed text-muted-foreground">
            <FileAudio className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Очистка речи работает в браузере через Clear. Аудио не отправляется на сервер; модель
            скачивается и кэшируется при первом запуске. Для неё действует{' '}
            <a
              className="text-primary underline underline-offset-2"
              href="https://license.desertant.com/1.0"
              target="_blank"
              rel="noreferrer"
            >
              лицензия Desert Ant
            </a>
            .
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StudioStep({
  icon,
  number,
  title,
  description,
  action,
  secondaryAction,
  busy = false,
  disabled = false,
  onClick,
  onSecondaryClick,
}: {
  icon: ReactNode
  number: string
  title: string
  description: string
  action: string
  secondaryAction?: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
  onSecondaryClick?: () => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-primary/80">{number}</span>
            <h3 className="text-sm font-medium">{title}</h3>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {secondaryAction && onSecondaryClick && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={onSecondaryClick}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : secondaryAction}
          </Button>
        )}
        <Button size="sm" disabled={disabled || busy} onClick={onClick} className="gap-1.5">
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {action}
        </Button>
      </div>
    </div>
  )
}
