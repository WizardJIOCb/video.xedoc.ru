import { createFileRoute } from '@tanstack/react-router'
import { ShareView } from '@/features/project-sharing/share-view'

export const Route = createFileRoute('/share/$shareId')({
  component: SharedProjectRoute,
})

function SharedProjectRoute() {
  const { shareId } = Route.useParams()
  return <ShareView shareId={shareId} />
}
