/**
 * Browser-only speech cleanup built around Desert Ant Clear.
 *
 * The media source is decoded and enhanced in the user's browser. The result is
 * deliberately emitted as a new WAV instead of changing a source file or a
 * timeline item in place: users can A/B it, keep the original, and decide where
 * to place the cleaned track.
 */

export type ClearAudioStage = 'decoding' | 'downloading' | 'enhancing' | 'encoding'

export interface ClearAudioProgress {
  stage: ClearAudioStage
  progress: number
}

export interface ClearAudioResult {
  file: File
  durationSeconds: number
  inputLufs: number | null
  outputTruePeakDbfs: number | null
  realtimeFactor: number
}

function getAudioContextConstructor(): typeof AudioContext {
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!ctor) {
    throw new Error('This browser cannot decode audio for local cleanup.')
  }

  return ctor
}

function copyChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => new Float32Array(buffer.getChannelData(channel)),
  )
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

/** Export standard 16-bit PCM WAV, broadly playable and importable by FreeCut. */
export function encodePcm16Wav(channels: readonly Float32Array[], sampleRate: number): Blob {
  const firstChannel = channels[0]
  if (!firstChannel || channels.length === 0) {
    throw new Error('Clear returned no audio samples.')
  }

  const frameCount = firstChannel.length
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || frameCount === 0) {
    throw new Error('Clear returned invalid audio metadata.')
  }

  if (channels.some((channel) => channel.length !== frameCount)) {
    throw new Error('Clear returned channels with different lengths.')
  }

  const bytesPerSample = 2
  const blockAlign = channels.length * bytesPerSample
  const dataSize = frameCount * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0))
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
      offset += bytesPerSample
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function cleanedFileName(sourceName: string): string {
  const extensionIndex = sourceName.lastIndexOf('.')
  const baseName = extensionIndex > 0 ? sourceName.slice(0, extensionIndex) : sourceName
  return `${baseName || 'audio'}-clean.wav`
}

export async function cleanSpeechAudio(
  source: File,
  onProgress?: (progress: ClearAudioProgress) => void,
): Promise<ClearAudioResult> {
  if (typeof window === 'undefined') {
    throw new Error('Local audio cleanup is available only in a browser.')
  }

  onProgress?.({ stage: 'decoding', progress: 0 })
  const AudioContextConstructor = getAudioContextConstructor()
  const context = new AudioContextConstructor()

  try {
    const decoded = await context.decodeAudioData(await source.arrayBuffer())
    onProgress?.({ stage: 'decoding', progress: 1 })

    // Keep this import lazy: Clear's WebAssembly runtime stays out of the editor
    // until someone explicitly starts an audio-cleanup job.
    const [{ Clear }, litert] = await Promise.all([
      import('@desert-ant-labs/clear'),
      // Clear declares LiteRT as a peer dependency. Passing it explicitly makes
      // the browser runtime dependency visible to both the bundler and audits.
      import('@litertjs/core'),
    ])
    const clear = await Clear.load({
      litert,
      onProgress: (fraction) => {
        onProgress?.({ stage: 'downloading', progress: Math.max(0, Math.min(1, fraction)) })
      },
    })

    try {
      onProgress?.({ stage: 'enhancing', progress: 0 })
      const enhanced = await clear.enhance(copyChannels(decoded), decoded.sampleRate, {
        channelMode: 'preserve',
        // Short-form platforms target roughly -14 LUFS. A bounded mastering pass
        // is included by Clear, but the source remains untouched.
        targetLUFS: 'youtube',
        strength: 0.85,
      })
      onProgress?.({ stage: 'enhancing', progress: 1 })
      onProgress?.({ stage: 'encoding', progress: 0 })

      const file = new File(
        [encodePcm16Wav(enhanced.channels, enhanced.sampleRate)],
        cleanedFileName(source.name),
        { type: 'audio/wav' },
      )
      onProgress?.({ stage: 'encoding', progress: 1 })

      return {
        file,
        durationSeconds: enhanced.durationSec,
        inputLufs: enhanced.measuredLUFS,
        outputTruePeakDbfs: enhanced.measuredTruePeakDBFS,
        realtimeFactor: enhanced.realtimeFactor,
      }
    } finally {
      clear.dispose()
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'EncodingError') {
      throw new Error(
        'The browser could not decode this media. Try a file with AAC, MP3, or WAV audio.',
      )
    }
    throw error
  } finally {
    void context.close().catch(() => {})
  }
}
