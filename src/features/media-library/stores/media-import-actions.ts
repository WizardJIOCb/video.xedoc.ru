import type { MediaLibraryState, MediaLibraryActions, UnsupportedCodecFile } from '../types'
import type { MediaAttribution, MediaMetadata } from '@/types/storage'
import { loadMediaLibraryService } from './media-library-service-access'
import { proxyService } from '../services/proxy-service'
import { getMimeType } from '../utils/validation'
import { getSharedProxyKey } from '../utils/proxy-key'
import { hasMediaFilePickerSupport, showMediaFilePicker } from '../utils/media-file-picker'
import { createLogger, createOperationId } from '@/shared/logging/logger'
import { useMediaPreparationStore } from './media-preparation-store'

const logger = createLogger('MediaImport')

type Set = (
  partial:
    | Partial<MediaLibraryState>
    | ((state: MediaLibraryState & MediaLibraryActions) => Partial<MediaLibraryState>),
) => void
type Get = () => MediaLibraryState & MediaLibraryActions

type ImportedMetadata = MediaMetadata & { isDuplicate?: boolean; hasUnsupportedCodec?: boolean }

const IMPORT_PROCESSING_CONCURRENCY = 2

interface ImportTask {
  handle: FileSystemFileHandle
  tempId: string
  file: File
}

interface CompletedImportTask extends ImportTask {
  metadata: ImportedMetadata
  linkedFallback?: boolean
}

type ImportStorageMode = 'copy' | 'link'

interface ImportFailure {
  fileName: string
  message: string
}

interface ImportResultSummary {
  results: MediaMetadata[]
  importedCount: number
  duplicateNames: string[]
  linkedFallbackNames: string[]
  unsupportedCodecFiles: UnsupportedCodecFile[]
  failures: ImportFailure[]
}

function buildOptimisticMediaItem(
  handle: FileSystemFileHandle,
  file: File,
  tempId: string,
  storageMode: ImportStorageMode,
): MediaMetadata {
  const now = Date.now()

  return {
    id: tempId,
    storageType: storageMode === 'link' ? 'handle' : 'workspace',
    fileHandle: storageMode === 'link' ? handle : undefined,
    fileName: file.name,
    fileSize: file.size,
    fileLastModified: file.lastModified,
    mimeType: getMimeType(file),
    duration: 0,
    width: 0,
    height: 0,
    fps: 30,
    codec: 'importing...',
    bitrate: 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
  }
}

function removeImportPlaceholder(set: Set, tempId: string): void {
  useMediaPreparationStore.getState().clearMedia(tempId)

  set((state) => ({
    mediaItems: state.mediaItems.filter((item) => item.id !== tempId),
    importingIds: state.importingIds.filter((id) => id !== tempId),
  }))
}

/**
 * Drop the optimistic placeholder and guarantee the resolved media record is
 * visible in the library exactly once.
 *
 * Used for BOTH fresh imports and "duplicate" results. A re-imported file is
 * flagged `isDuplicate` whenever it already has a `media-links.json`
 * association with the project — but that association can outlive the file's
 * presence in the in-memory library (the user removed it from the library
 * view, or the association was re-backfilled from a lingering timeline clip).
 * The old duplicate path only removed the placeholder, so re-importing such a
 * file showed "already exists in library" while the file stayed invisible and
 * un-recoverable without a full reload. Surfacing it here fixes that.
 *
 * Also resilient to a concurrent `loadMediaItems()` wiping the placeholder
 * mid-import: the record is prepended rather than silently dropped.
 */
function ensureImportedMediaVisible(set: Set, tempId: string, metadata: MediaMetadata): boolean {
  let wasAlreadyVisible = false
  useMediaPreparationStore.getState().clearMedia(tempId)

  set((state) => {
    const withoutPlaceholder = state.mediaItems.filter((item) => item.id !== tempId)
    wasAlreadyVisible = withoutPlaceholder.some((item) => item.id === metadata.id)

    return {
      mediaItems: wasAlreadyVisible
        ? withoutPlaceholder.map((item) => (item.id === metadata.id ? metadata : item))
        : [metadata, ...withoutPlaceholder],
      importingIds: state.importingIds.filter((id) => id !== tempId),
    }
  })
  return wasAlreadyVisible
}

function prependImportedMedia(set: Set, metadata: MediaMetadata): void {
  set((state) => ({
    mediaItems: [metadata, ...state.mediaItems.filter((item) => item.id !== metadata.id)],
    error: null,
    errorLink: null,
  }))
}

function setupImportedVideoProxy(metadata: MediaMetadata): void {
  if (!proxyService.canGenerateProxy(metadata.mimeType)) {
    return
  }

  // ProRes and other browser-undecodable codecs are previewed via live turbores
  // decode (full fidelity), not an auto-generated proxy. A proxy remains an opt-in
  // scrub-performance aid via the media library UI, so we still map its key here.
  proxyService.setProxyKey(metadata.id, getSharedProxyKey(metadata))
}

function queueImportPreparationTask(tempId: string): void {
  const preparationStore = useMediaPreparationStore.getState()
  preparationStore.queueTask(tempId, 'import')
  preparationStore.updateTask(tempId, 'import', { status: 'queued', progress: 0.05 })
}

function markImportPreparationRunning(tempId: string): void {
  useMediaPreparationStore
    .getState()
    .updateTask(tempId, 'import', { status: 'running', progress: 0.2 })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return String(error || 'Unknown import error')
}

function createImportResultSummary(): ImportResultSummary {
  return {
    results: [],
    importedCount: 0,
    duplicateNames: [],
    linkedFallbackNames: [],
    unsupportedCodecFiles: [],
    failures: [],
  }
}

function processCompletedImport(
  importResult: PromiseFulfilledResult<CompletedImportTask>,
  summary: ImportResultSummary,
  set: Set,
  options?: { includeDuplicatesInResults?: boolean },
): void {
  const { metadata, tempId, file, handle, linkedFallback } = importResult.value
  const wasAlreadyVisible = ensureImportedMediaVisible(set, tempId, metadata)

  // "already exists in library" should only fire for a genuine no-op:
  // re-importing a file that is ALREADY visible in this project's library.
  // A file flagged `isDuplicate` merely has a project↔media association —
  // which the by-design cross-workspace dedup re-creates when you re-import
  // a file you'd removed. Surfacing that as "already exists" is wrong; it's
  // a normal (re-)add, so fall through to the import branch with no banner.
  if (metadata.isDuplicate && wasAlreadyVisible) {
    summary.duplicateNames.push(file.name)
    if (options?.includeDuplicatesInResults) {
      summary.results.push(metadata)
    }
    return
  }

  setupImportedVideoProxy(metadata)
  summary.results.push(metadata)
  summary.importedCount += 1

  if (linkedFallback) {
    summary.linkedFallbackNames.push(file.name)
  }

  if (metadata.hasUnsupportedCodec && metadata.audioCodec) {
    summary.unsupportedCodecFiles.push({
      fileName: file.name,
      audioCodec: metadata.audioCodec,
      handle,
    })
  }
}

function processFailedImport(
  importResult: PromiseRejectedResult,
  importTask: ImportTask,
  summary: ImportResultSummary,
  set: Set,
): void {
  removeImportPlaceholder(set, importTask.tempId)
  logger.error(`Failed to import ${importTask.file.name}`, importResult.reason)
  summary.failures.push({
    fileName: importTask.file.name,
    message: errorMessage(importResult.reason),
  })
}

function processImportResults(
  importResults: PromiseSettledResult<CompletedImportTask>[],
  importTasks: ImportTask[],
  set: Set,
  options?: { includeDuplicatesInResults?: boolean },
): ImportResultSummary {
  const summary = createImportResultSummary()

  for (const [index, importResult] of importResults.entries()) {
    const importTask = importTasks[index]
    if (!importTask) {
      continue
    }

    if (importResult.status === 'fulfilled') {
      processCompletedImport(importResult, summary, set, options)
      continue
    }
    processFailedImport(importResult, importTask, summary, set)
  }

  return summary
}

function pluralFile(count: number): string {
  return count === 1 ? 'file' : 'files'
}

function formatNameList(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

function formatImportedCount(importedCount: number): string | null {
  return importedCount > 0 ? `Imported ${importedCount} ${pluralFile(importedCount)}.` : null
}

function formatDuplicateImports(
  importedCount: number,
  duplicateNames: string[],
  linkedFallbackNames: string[],
  unsupportedCodecFiles: UnsupportedCodecFile[],
  failures: ImportFailure[],
): string | null {
  if (duplicateNames.length === 0) return null

  const onlyDuplicates =
    importedCount === 0 &&
    linkedFallbackNames.length === 0 &&
    unsupportedCodecFiles.length === 0 &&
    failures.length === 0
  if (onlyDuplicates) {
    return duplicateNames.length === 1
      ? `"${duplicateNames[0]}" already exists in library`
      : `${duplicateNames.length} files already exist in library`
  }
  if (duplicateNames.length === 1) {
    return `Skipped 1 duplicate: ${duplicateNames[0]}.`
  }
  return `Skipped ${duplicateNames.length} duplicates: ${formatNameList(duplicateNames)}.`
}

function formatLinkedFallbackImports(linkedFallbackNames: string[]): string | null {
  if (linkedFallbackNames.length === 0) return null

  const names = formatNameList(linkedFallbackNames)
  const subject =
    linkedFallbackNames.length === 1 ? `"${names}" was` : `${linkedFallbackNames.length} files were`
  return `${subject} linked to the original location because copying into the workspace failed. Keep the source file where it is.`
}

function formatUnsupportedCodecImports(
  unsupportedCodecFiles: UnsupportedCodecFile[],
): string | null {
  if (unsupportedCodecFiles.length === 0) return null

  const codecList = [...new Set(unsupportedCodecFiles.map((file) => file.audioCodec))].join(', ')
  const count = unsupportedCodecFiles.length
  return `${count} ${pluralFile(count)} ${count === 1 ? 'has' : 'have'} unsupported audio codec (${codecList}). Waveforms may not be available.`
}

function formatFailedImports(failures: ImportFailure[]): string | null {
  if (failures.length === 0) return null

  const first = failures[0]
  const suffix = failures.length > 1 ? ` (${failures.length - 1} more failed)` : ''
  return `Could not import ${first?.fileName ?? 'file'}: ${first?.message ?? 'Unknown error'}${suffix}.`
}

function buildImportSummaryMessage({
  importedCount,
  duplicateNames,
  linkedFallbackNames,
  unsupportedCodecFiles,
  failures,
}: {
  importedCount: number
  duplicateNames: string[]
  linkedFallbackNames: string[]
  unsupportedCodecFiles: UnsupportedCodecFile[]
  failures: ImportFailure[]
}): string | null {
  const hasAdditionalStatus =
    duplicateNames.length > 0 ||
    linkedFallbackNames.length > 0 ||
    unsupportedCodecFiles.length > 0 ||
    failures.length > 0
  const parts = [
    hasAdditionalStatus ? formatImportedCount(importedCount) : null,
    formatDuplicateImports(
      importedCount,
      duplicateNames,
      linkedFallbackNames,
      unsupportedCodecFiles,
      failures,
    ),
    formatLinkedFallbackImports(linkedFallbackNames),
    formatUnsupportedCodecImports(unsupportedCodecFiles),
    formatFailedImports(failures),
  ].filter((part): part is string => part !== null)

  return parts.length > 0 ? parts.join(' ') : null
}

function showImportNotifications(
  importedCount: number,
  duplicateNames: string[],
  linkedFallbackNames: string[],
  unsupportedCodecFiles: UnsupportedCodecFile[],
  failures: ImportFailure[],
  get: Get,
): void {
  const message = buildImportSummaryMessage({
    importedCount,
    duplicateNames,
    linkedFallbackNames,
    unsupportedCodecFiles,
    failures,
  })
  if (!message) return

  const type = failures.length > 0 || unsupportedCodecFiles.length > 0 ? 'warning' : 'info'
  get().showNotification({ type, message })
}

export function createImportActions(
  set: Set,
  get: Get,
): Pick<
  MediaLibraryActions,
  | 'importMedia'
  | 'importMediaFromUrl'
  | 'importRemoteLottie'
  | 'importHandles'
  | 'importHandlesForPlacement'
> {
  const createOptimisticImportTasks = async (
    handles: FileSystemFileHandle[],
    storageMode: ImportStorageMode,
  ): Promise<ImportTask[]> => {
    const importTasks: ImportTask[] = []

    for (const handle of handles) {
      if (!handle) continue
      const tempId = crypto.randomUUID()

      let file: File
      try {
        file = await handle.getFile()
      } catch (error) {
        // getFile() can fail if permission is denied or file is missing —
        // remove the placeholder that was about to be inserted and skip.
        logger.error(`Failed to read file from handle "${handle.name}":`, error)
        continue
      }

      const tempItem = buildOptimisticMediaItem(handle, file, tempId, storageMode)

      set((state) => ({
        mediaItems: [tempItem, ...state.mediaItems],
        importingIds: [...state.importingIds, tempId],
        error: null,
      }))
      queueImportPreparationTask(tempId)

      importTasks.push({ handle, tempId, file })
    }

    return importTasks
  }

  const runImportTasks = async (
    importTasks: ImportTask[],
    projectId: string,
    serviceModulePromise: ReturnType<typeof loadMediaLibraryService>,
    storageMode: ImportStorageMode,
  ): Promise<PromiseSettledResult<CompletedImportTask>[]> => {
    const results: PromiseSettledResult<CompletedImportTask>[] = new Array(importTasks.length)
    let nextIndex = 0
    const { mediaLibraryService } = await serviceModulePromise

    const runNext = async (): Promise<void> => {
      while (nextIndex < importTasks.length) {
        const index = nextIndex++
        const task = importTasks[index]
        if (!task) {
          continue
        }

        try {
          markImportPreparationRunning(task.tempId)
          const metadata = await mediaLibraryService.importMediaWithHandle(task.handle, projectId, {
            storageMode,
          })
          results[index] = {
            status: 'fulfilled',
            value: { metadata, tempId: task.tempId, file: task.file, handle: task.handle },
          }
        } catch (reason) {
          if (storageMode !== 'copy') {
            results[index] = { status: 'rejected', reason }
            continue
          }

          // A workspace write may fail independently of the source file itself.
          // Retry as a linked local file so the editor can still use the media
          // without asking the user to select it again.
          try {
            const metadata = await mediaLibraryService.importMediaWithHandle(
              task.handle,
              projectId,
              {
                storageMode: 'link',
              },
            )
            results[index] = {
              status: 'fulfilled',
              value: {
                metadata,
                tempId: task.tempId,
                file: task.file,
                handle: task.handle,
                linkedFallback: true,
              },
            }
          } catch (linkedReason) {
            results[index] = {
              status: 'rejected',
              reason: new Error(
                `Copy import failed: ${errorMessage(reason)}. Linked-file fallback failed: ${errorMessage(linkedReason)}`,
              ),
            }
          }
        }
      }
    }

    const workerCount = Math.min(IMPORT_PROCESSING_CONCURRENCY, importTasks.length)
    await Promise.all(Array.from({ length: workerCount }, runNext))
    return results
  }

  const importHandlesInternal = async (
    handles: FileSystemFileHandle[],
    options?: {
      includeDuplicatesInResults?: boolean
      waitForPreparation?: boolean
      storageMode?: ImportStorageMode
    },
  ): Promise<MediaMetadata[]> => {
    const { currentProjectId } = get()

    if (!currentProjectId) {
      set({ error: 'No project selected' })
      return []
    }

    const opId = createOperationId()
    const event = logger.startEvent('import', opId)
    event.merge({
      source: 'drag-drop',
      projectId: currentProjectId,
      fileCount: handles.length,
    })

    const storageMode = options?.storageMode ?? 'copy'
    const serviceModulePromise = loadMediaLibraryService()
    const importTasks = await createOptimisticImportTasks(handles, storageMode)
    const importResults = await runImportTasks(
      importTasks,
      currentProjectId,
      serviceModulePromise,
      storageMode,
    )

    const {
      results,
      importedCount,
      duplicateNames,
      linkedFallbackNames,
      unsupportedCodecFiles,
      failures,
    } = processImportResults(importResults, importTasks, set, options)

    showImportNotifications(
      importedCount,
      duplicateNames,
      linkedFallbackNames,
      unsupportedCodecFiles,
      failures,
      get,
    )

    if (options?.waitForPreparation && results.length > 0) {
      const { mediaLibraryService } = await serviceModulePromise
      await mediaLibraryService.waitForMediaPreparation(results.map((media) => media.id))
    }

    event.success({
      imported: importedCount,
      duplicates: duplicateNames.length,
      failed: failures.length,
      linkedFallbacks: linkedFallbackNames.length,
      unsupportedCodecs: unsupportedCodecFiles.length,
    })

    return results
  }

  return {
    importMedia: async (options) => {
      const { currentProjectId } = get()

      if (!currentProjectId) {
        set({ error: 'No project selected' })
        return []
      }

      // Check if File System Access API is supported
      if (!hasMediaFilePickerSupport()) {
        const isBrave = 'brave' in navigator
        set({
          error: isBrave
            ? 'File System Access API is disabled in Brave. Copy the URL below, paste it in your address bar, set the flag to Enabled, and relaunch.'
            : 'File picker not supported in this browser. Use Chrome or Edge.',
          errorLink: isBrave ? 'brave://flags/#file-system-access-api' : null,
        })
        return []
      }

      const opId = createOperationId()
      const event = logger.startEvent('import', opId)
      event.set('source', 'picker')
      event.set('projectId', currentProjectId)

      try {
        // Open file picker
        const handles = await showMediaFilePicker({ multiple: true })

        event.set('fileCount', handles.length)

        // Create optimistic placeholders for all files immediately
        const serviceModulePromise = loadMediaLibraryService()
        const storageMode = options?.storageMode ?? 'copy'
        const importTasks = await createOptimisticImportTasks(handles, storageMode)
        const importResults = await runImportTasks(
          importTasks,
          currentProjectId,
          serviceModulePromise,
          storageMode,
        )

        const {
          results,
          importedCount,
          duplicateNames,
          linkedFallbackNames,
          unsupportedCodecFiles,
          failures,
        } = processImportResults(importResults, importTasks, set)

        showImportNotifications(
          importedCount,
          duplicateNames,
          linkedFallbackNames,
          unsupportedCodecFiles,
          failures,
          get,
        )

        event.success({
          imported: importedCount,
          duplicates: duplicateNames.length,
          failed: failures.length,
          linkedFallbacks: linkedFallbackNames.length,
          unsupportedCodecs: unsupportedCodecFiles.length,
        })

        return results
      } catch (error) {
        // User cancelled or error
        if (error instanceof Error && error.name !== 'AbortError') {
          set({ error: error.message })
          event.failure(error)
        } else {
          event.success({
            outcome: 'cancelled',
            imported: 0,
            duplicates: 0,
            failed: 0,
            unsupportedCodecs: 0,
          })
        }
        return []
      }
    },

    importMediaFromUrl: async (url: string) => {
      const { currentProjectId } = get()
      const trimmedUrl = url.trim()

      if (!currentProjectId) {
        set({ error: 'No project selected', errorLink: null })
        return []
      }

      if (trimmedUrl.length === 0) {
        set({ error: 'Enter a media URL.', errorLink: null })
        return []
      }

      set({ error: null, errorLink: null })

      const opId = createOperationId()
      const event = logger.startEvent('import', opId)
      event.set('source', 'url')
      event.set('projectId', currentProjectId)

      try {
        const parsedUrl = new URL(trimmedUrl)
        event.set('urlHost', parsedUrl.hostname)
      } catch {
        event.set('urlHost', 'invalid')
      }

      try {
        const { mediaLibraryService } = await loadMediaLibraryService()
        const metadata = await mediaLibraryService.importMediaFromUrl(trimmedUrl, currentProjectId)

        if (metadata.isDuplicate) {
          showImportNotifications(0, [metadata.fileName], [], [], [], get)
          event.success({
            imported: 0,
            duplicates: 1,
            failed: 0,
            unsupportedCodecs: 0,
          })
          return []
        }

        prependImportedMedia(set, metadata)
        setupImportedVideoProxy(metadata)

        const unsupportedCodecFiles =
          metadata.hasUnsupportedCodec && metadata.audioCodec
            ? [{ fileName: metadata.fileName, audioCodec: metadata.audioCodec }]
            : []
        showImportNotifications(1, [], [], unsupportedCodecFiles, [], get)

        event.success({
          imported: 1,
          duplicates: 0,
          failed: 0,
          unsupportedCodecs: unsupportedCodecFiles.length,
        })
        return [metadata]
      } catch (error) {
        const importError = error instanceof Error ? error : new Error(String(error))
        set({ error: importError.message, errorLink: null })
        event.failure(importError)
        return []
      }
    },

    importRemoteLottie: async (params: {
      url: string
      fileName?: string
      attribution?: MediaAttribution
    }) => {
      const { currentProjectId } = get()

      if (!currentProjectId) {
        set({ error: 'No project selected', errorLink: null })
        return null
      }

      set({ error: null, errorLink: null })

      const opId = createOperationId()
      const event = logger.startEvent('import', opId)
      event.set('source', 'lottiefiles')
      event.set('projectId', currentProjectId)
      event.set('provider', params.attribution?.provider ?? 'unknown')

      try {
        const { mediaLibraryService } = await loadMediaLibraryService()
        const metadata = await mediaLibraryService.importLottieFromUrl(
          params.url,
          currentProjectId,
          { fileName: params.fileName, attribution: params.attribution },
        )

        if (metadata.isDuplicate) {
          showImportNotifications(0, [metadata.fileName], [], [], [], get)
          event.success({ imported: 0, duplicates: 1, failed: 0, unsupportedCodecs: 0 })
          return metadata
        }

        prependImportedMedia(set, metadata)
        showImportNotifications(1, [], [], [], [], get)
        event.success({ imported: 1, duplicates: 0, failed: 0, unsupportedCodecs: 0 })
        return metadata
      } catch (error) {
        const importError = error instanceof Error ? error : new Error(String(error))
        set({ error: importError.message, errorLink: null })
        event.failure(importError)
        return null
      }
    },

    importHandles: async (handles: FileSystemFileHandle[], options) => {
      return importHandlesInternal(handles, options)
    },

    importHandlesForPlacement: async (handles: FileSystemFileHandle[]) =>
      importHandlesInternal(handles, {
        includeDuplicatesInResults: true,
        waitForPreparation: true,
        storageMode: 'copy',
      }),
  }
}
