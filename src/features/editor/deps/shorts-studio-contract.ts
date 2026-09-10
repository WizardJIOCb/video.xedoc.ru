/** Editor adapter for the local media and transcript jobs used by Shorts Studio. */

export { mediaTranscriptionService } from '@/features/media-library/services/media-transcription-service'
export { runMediaTranscriptionJob } from '@/features/media-library/services/media-transcription-runner'
export const importFillerRemovalPreview = () =>
  import('@/features/timeline/utils/filler-word-removal-preview')
