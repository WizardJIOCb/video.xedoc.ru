import { describe, expect, it } from 'vitest'
import { encodePcm16Wav } from './clear-audio-service'

describe('encodePcm16Wav', () => {
  it('writes an interleaved 16-bit PCM WAV with the expected header', async () => {
    const blob = encodePcm16Wav(
      [new Float32Array([0, 1, -1]), new Float32Array([0.5, -0.5, 0])],
      48_000,
    )
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
    const view = new DataView(bytes)
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)))

    expect(blob.type).toBe('audio/wav')
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getInt16(44 + 2, true)).toBe(16384)
    expect(view.getInt16(44 + 4, true)).toBe(32767)
    expect(view.getInt16(44 + 6, true)).toBe(-16384)
  })
})
