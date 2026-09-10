/**
 * Media Processor Service
 *
 * Manages the media processor worker for off-main-thread media processing.
 * Provides a simple async API for extracting metadata and generating thumbnails.
 */

import { createLogger } from '@/shared/logging/logger'
import { createManagedWorker, rejectAndDeletePendingRequests } from '@/shared/utils/managed-worker'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import type {
  ProcessMediaRequest,
  ProcessMediaResponse,
  VideoMetadata,
  AudioMetadata,
  ImageMetadata,
} from '../workers/media-processor.worker'

const logger = createLogger('MediaProcessorService')
const PROCESS_MEDIA_TIMEOUT_MS = 120_000
const UNSUPPORTED_AUDIO_CODECS = ['dts', 'dtsc', 'dtse', 'dtsh', 'dtsl', 'truehd', 'mlpa']

type MediaMetadataResult = VideoMetadata | AudioMetadata | ImageMetadata

interface ProcessMediaResult {
  metadata: MediaMetadataResult
  thumbnail?: Blob
}

interface PendingRequest {
  resolve: (result: ProcessMediaResult) => void
  reject: (error: Error) => void
}

interface FastVideoTrack {
  codec: string | null
  displayWidth: number
  displayHeight: number
  canDecode?: () => Promise<boolean>
}

interface FastAudioTrack {
  codec?: unknown
}

function isAudioCodecSupported(codec: string | undefined): boolean {
  if (!codec) return true
  const normalizedCodec = codec.toLowerCase().trim()
  return !UNSUPPORTED_AUDIO_CODECS.some((unsupported) => normalizedCodec.includes(unsupported))
}

function requireVideoTrack<T>(videoTrack: T | null | undefined): T {
  if (!videoTrack) {
    throw new Error('No video track found in file')
  }
  return videoTrack
}

function getAudioCodec(audioTrack: FastAudioTrack | null | undefined): string | undefined {
  return audioTrack?.codec ? String(audioTrack.codec) : undefined
}

async function getVideoCodecSupported(videoTrack: FastVideoTrack): Promise<boolean> {
  if (videoTrack.codec === 'prores') return false
  if (!videoTrack.canDecode) return true
  return videoTrack.canDecode().catch(() => true)
}

async function loadFastVideoTracks(input: {
  computeDuration: () => Promise<number>
  getPrimaryVideoTrack: () => Promise<FastVideoTrack | null | undefined>
  getPrimaryAudioTrack: () => Promise<FastAudioTrack | null | undefined>
}): Promise<{
  duration: number
  videoTrack: FastVideoTrack
  audioTrack: FastAudioTrack | null | undefined
}> {
  const [duration, videoTrack, audioTrack] = await Promise.all([
    input.computeDuration(),
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
  ])
  return { duration, videoTrack: requireVideoTrack(videoTrack), audioTrack }
}

function buildFastVideoMetadata(
  duration: number,
  videoTrack: FastVideoTrack,
  audioCodec: string | undefined,
  videoCodecSupported: boolean,
): VideoMetadata {
  return {
    type: 'video',
    duration: duration || 0,
    width: videoTrack.displayWidth || DEFAULT_PROJECT_WIDTH,
    height: videoTrack.displayHeight || DEFAULT_PROJECT_HEIGHT,
    // Fast metadata intentionally does not walk encoded packets for FPS.
    fps: 30,
    codec: videoTrack.codec || 'unknown',
    bitrate: 0,
    audioCodec,
    audioCodecSupported: isAudioCodecSupported(audioCodec),
    videoCodecSupported,
  }
}

/**
 * Browser workers can terminate while probing otherwise valid media on some
 * Chromium builds. Fast metadata is deliberately small, so keep the import
 * path reliable by probing it on the main thread without decoding a frame.
 */
async function processFastVideoMetadataOnMainThread(file: File): Promise<ProcessMediaResult> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny')
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  })

  try {
    const { duration, videoTrack, audioTrack } = await loadFastVideoTracks(input)
    const audioCodec = getAudioCodec(audioTrack)
    const videoCodecSupported = await getVideoCodecSupported(videoTrack)

    return {
      metadata: buildFastVideoMetadata(duration, videoTrack, audioCodec, videoCodecSupported),
    }
  } finally {
    input.dispose()
  }
}

class MediaProcessorService {
  private requestId = 0
  private pendingRequests = new Map<string, PendingRequest>()
  private readonly workerManager = createManagedWorker({
    createWorker: () =>
      new Worker(new URL('../workers/media-processor.worker.ts', import.meta.url), {
        type: 'module',
      }),
    setupWorker: (worker) => {
      worker.onmessage = (event: MessageEvent<ProcessMediaResponse>) => {
        this.handleMessage(event.data)
      }

      worker.onerror = (event) => {
        const detail = event.error instanceof Error ? event.error.message : event.message
        const message = detail || 'Worker terminated unexpectedly'
        logger.error('Media processor worker error:', {
          message,
          filename: event.filename,
          line: event.lineno,
          column: event.colno,
          cause: event.error,
        })
        this.workerManager.terminate()

        rejectAndDeletePendingRequests(this.pendingRequests, new Error(`Worker error: ${message}`))
      }

      return () => {
        worker.onmessage = null
        worker.onerror = null
      }
    },
  })

  /**
   * Initialize the worker (lazy)
   */
  private ensureWorker(): Worker {
    return this.workerManager.getWorker()
  }

  /**
   * Handle messages from the worker
   */
  private handleMessage(response: ProcessMediaResponse): void {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) {
      logger.warn('Received response for unknown request:', response.requestId)
      return
    }

    this.pendingRequests.delete(response.requestId)

    if (response.type === 'error') {
      pending.reject(new Error(response.error || 'Unknown error'))
    } else if (response.type === 'complete' && response.metadata) {
      pending.resolve({
        metadata: response.metadata,
        thumbnail: response.thumbnail,
      })
    } else {
      pending.reject(new Error('Invalid response from worker'))
    }
  }

  /**
   * Process a media file - extract metadata and generate thumbnail
   *
   * This runs entirely off the main thread to prevent UI blocking.
   *
   * @param file - The media file to process
   * @param mimeType - The MIME type of the file
   * @param options - Optional processing options
   * @returns Promise with metadata and thumbnail
   */
  async processMedia(
    file: File,
    mimeType: string,
    options?: {
      thumbnailMaxSize?: number
      thumbnailQuality?: number
      thumbnailTimestamp?: number
      generateThumbnail?: boolean
      fastMetadata?: boolean
    },
  ): Promise<ProcessMediaResult> {
    if (options?.fastMetadata && mimeType.startsWith('video/')) {
      return processFastVideoMetadataOnMainThread(file)
    }

    const worker = this.ensureWorker()
    const requestId = `media-${++this.requestId}`

    return new Promise<ProcessMediaResult>((resolve, reject) => {
      // Large MKV/MOV files can take a while to probe in-browser. If a worker
      // does hang, terminate it so the next import gets a fresh worker.
      // Terminating drops every in-flight request on the floor, so reject
      // them all here before the worker dies — otherwise other importers
      // would hang forever waiting on a worker that no longer exists.
      const timeout = setTimeout(() => {
        const timeoutError = new Error('Media processing timeout')
        rejectAndDeletePendingRequests(this.pendingRequests, timeoutError)
        this.workerManager.terminate()
        reject(timeoutError)
      }, PROCESS_MEDIA_TIMEOUT_MS)

      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })

      const request: ProcessMediaRequest = {
        type: 'process',
        requestId,
        file,
        mimeType,
        options,
      }

      worker.postMessage(request)
    })
  }

  /**
   * Process multiple files in parallel (up to concurrency limit)
   *
   * @param files - Array of files with their MIME types
   * @param concurrency - Max concurrent processing (default 3)
   * @param onProgress - Progress callback
   * @returns Array of results in same order as input
   */
  async processMediaBatch(
    files: Array<{ file: File; mimeType: string }>,
    concurrency = 3,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<Array<ProcessMediaResult | Error>> {
    const results: Array<ProcessMediaResult | Error> = new Array(files.length)
    let completed = 0

    // Process in chunks for controlled concurrency
    const chunks: Array<Array<{ index: number; file: File; mimeType: string }>> = []
    for (let i = 0; i < files.length; i += concurrency) {
      chunks.push(
        files.slice(i, i + concurrency).map((f, j) => ({
          index: i + j,
          ...f,
        })),
      )
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(
        chunk.map(({ file, mimeType }) => this.processMedia(file, mimeType)),
      )

      for (let i = 0; i < chunkResults.length; i++) {
        const result = chunkResults[i]
        const chunkItem = chunk[i]
        if (!result || !chunkItem) continue

        const originalIndex = chunkItem.index

        if (result.status === 'fulfilled') {
          results[originalIndex] = result.value
        } else {
          // result.status === 'rejected'
          const reason = result.reason as Error | undefined
          results[originalIndex] = new Error(reason?.message || 'Processing failed')
        }

        completed++
        onProgress?.(completed, files.length)
      }
    }

    return results
  }

  /**
   * Check if a video file has unsupported audio codec
   * This is now included in the metadata extraction - no separate call needed
   */
  hasUnsupportedAudioCodec(metadata: MediaMetadataResult): {
    unsupported: boolean
    codec?: string
  } {
    if (metadata.type === 'video') {
      return {
        unsupported: !metadata.audioCodecSupported,
        codec: metadata.audioCodec,
      }
    }
    return { unsupported: false }
  }

  /**
   * Terminate the worker
   */
  dispose(): void {
    this.workerManager.terminate()

    // Reject all pending requests
    rejectAndDeletePendingRequests(this.pendingRequests, new Error('Worker disposed'))
  }
}

// Singleton instance
export const mediaProcessorService = new MediaProcessorService()
