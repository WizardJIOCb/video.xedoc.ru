const CHANNEL = 'freecut-wangp'
const ALLOWED_ACTIONS = new Set(['health', 'start', 'poll', 'download'])

function postResponse(requestId, response) {
  window.postMessage(
    {
      channel: CHANNEL,
      kind: 'response',
      requestId,
      ok: !response?.error,
      payload: response?.payload,
      error: response?.error,
    },
    window.location.origin,
  )
}

function streamDownload(requestId, payload) {
  const port = chrome.runtime.connect({ name: 'freecut-wangp-download' })

  port.onMessage.addListener((message) => {
    window.postMessage(
      { channel: CHANNEL, kind: 'download', requestId, ...message },
      window.location.origin,
    )
  })

  port.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message
    if (message) {
      window.postMessage(
        { channel: CHANNEL, kind: 'download', requestId, type: 'error', error: message },
        window.location.origin,
      )
    }
  })

  port.postMessage({ type: 'start', url: payload?.url })
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return

  const message = event.data
  if (
    !message ||
    message.channel !== CHANNEL ||
    message.kind !== 'request' ||
    typeof message.requestId !== 'string' ||
    !ALLOWED_ACTIONS.has(message.action)
  ) {
    return
  }

  if (message.action === 'download') {
    streamDownload(message.requestId, message.payload)
    return
  }

  chrome.runtime.sendMessage(
    { channel: CHANNEL, action: message.action, payload: message.payload },
    (response) => {
      const lastError = chrome.runtime.lastError
      postResponse(message.requestId, lastError ? { error: lastError.message } : response)
    },
  )
})
