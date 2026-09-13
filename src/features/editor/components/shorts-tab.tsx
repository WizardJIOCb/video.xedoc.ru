import { memo, useState } from 'react'
import { Captions, Clapperboard, Scissors, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { AiPanel } from './ai-panel'
import { ShortsStudioDialog } from './shorts-studio-dialog'
import { WangpVideoPanel } from './wangp-video-panel'

/**
 * A single home for the short-form workflow. Each generated asset is saved to
 * the current project's media library so it can be moved, trimmed, replaced,
 * or deleted on the normal FreeCut timeline instead of becoming a locked MP4.
 */
export const ShortsTab = memo(function ShortsTab() {
  const projectId = useMediaLibraryStore((state) => state.currentProjectId)
  const [finishingOpen, setFinishingOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-border bg-gradient-to-br from-primary/15 via-primary/5 to-transparent px-3 py-3">
        <div className="flex items-start gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/15 text-primary">
            <Clapperboard className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Shorts</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              Соберите черновик по промпту, затем правьте каждый клип на таймлайне.
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-border px-3 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            1. Видеоряд по промпту
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            WanGP делает отдельный клип на локальном GPU. После импорта он появляется в медиатеке
            этого проекта — добавьте его на таймлайн и меняйте как обычный исходник.
          </p>
          <div className="-mx-3 border-y border-border bg-secondary/10">
            <WangpVideoPanel />
          </div>
        </section>

        <section className="border-b border-border px-3 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium">
            <Captions className="h-3.5 w-3.5 text-primary" />
            2. Голос и музыка
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            Создайте отдельные дорожки для ролика. Их можно прослушать, вставить в проект или
            заменить до экспорта.
          </p>
          <div className="-mx-3 border-y border-border bg-secondary/10">
            <AiPanel />
          </div>
        </section>

        <section className="px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium">
                <Scissors className="h-3.5 w-3.5 text-primary" />
                3. Доводка исходника
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Субтитры, паузы, слова-паразиты и очистка речи — сначала с предпросмотром, затем с
                вашим подтверждением.
              </p>
            </div>
            <Button
              size="sm"
              className="h-7 shrink-0 gap-1.5 text-[11px]"
              onClick={() => setFinishingOpen(true)}
              disabled={!projectId}
            >
              <Scissors className="h-3 w-3" />
              Открыть
            </Button>
          </div>
        </section>
      </div>

      {projectId && (
        <ShortsStudioDialog
          open={finishingOpen}
          onOpenChange={setFinishingOpen}
          projectId={projectId}
        />
      )}
    </div>
  )
})
