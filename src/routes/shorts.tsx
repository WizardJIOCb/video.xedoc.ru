import { createFileRoute, Link } from '@tanstack/react-router'
import { AudioLines, Captions, Clapperboard, Scissors, ShieldCheck, Smartphone } from 'lucide-react'
import { FreeCutLogo } from '@/components/brand/freecut-logo'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/shorts')({
  component: ShortsPage,
})

const steps = [
  {
    icon: Captions,
    title: 'Расшифровать и добавить субтитры',
    text: 'Распознавание с таймингами и редактируемые субтитры прямо на таймлайне.',
  },
  {
    icon: Scissors,
    title: 'Убрать паузы и слова-паразиты',
    text: 'Сначала просмотр найденных мест, затем только подтверждённые монтажные склейки.',
  },
  {
    icon: AudioLines,
    title: 'Почистить речь',
    text: 'Шум, эхо и громкость обрабатываются локально; новая дорожка не заменяет исходник.',
  },
]

function ShortsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/" aria-label="На главную">
            <FreeCutLogo variant="full" size="md" className="transition-opacity hover:opacity-80" />
          </Link>
          <Button variant="outline" asChild>
            <Link to="/projects">Мои проекты</Link>
          </Button>
        </div>
      </header>

      <section className="relative overflow-hidden border-b border-border px-6 py-16 sm:py-24">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.14),transparent_46%)]" />
        <div className="relative mx-auto max-w-4xl text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
            <Clapperboard className="h-6 w-6" />
          </div>
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.22em] text-primary">
            FreeCut Studio
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
            Из исходника — в короткий ролик
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Вертикальный монтаж, субтитры, чистая речь и аккуратные склейки без загрузки исходника в
            наш сервис.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button size="lg" className="gap-2" asChild>
              <Link to="/projects/new" search={{ shorts: '1' }}>
                <Smartphone className="h-4 w-4" />
                Создать Shorts 9:16
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/projects">Открыть существующий проект</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-14 sm:py-20">
        <div className="mb-8 max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight">Один понятный сценарий</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            После добавления видео нажмите{' '}
            <strong className="font-medium text-foreground">Shorts</strong> в верхней панели
            редактора. Все автоматические удаления сначала показываются в предпросмотре.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((step, index) => (
            <article key={step.title} className="rounded-xl border border-border bg-card p-5">
              <div className="mb-8 flex items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <step.icon className="h-4 w-4" />
                </div>
                <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
              </div>
              <h3 className="text-base font-medium">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-card/30 px-6 py-10">
        <div className="mx-auto flex max-w-4xl items-start gap-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h2 className="font-medium">Локальная обработка</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Видеофайлы и речь остаются в браузере и вашей рабочей папке. Для первого запуска
              модели скачиваются в кэш браузера; это не облачный рендер и не улучшение картинки.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
