const WANGP_ORIGIN = 'http://127.0.0.1:7860'
const WANGP_URL = `${WANGP_ORIGIN}/`
const jobs = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function absoluteUrl(value) {
  return new URL(value, WANGP_ORIGIN).href
}

async function waitForTab(tabId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete') return
    await sleep(500)
  }
  throw new Error('WanGP did not finish loading.')
}

async function getWanGpTab() {
  const existing = await chrome.tabs.query({ url: [`${WANGP_ORIGIN}/*`] })
  const tab = existing[0] ?? (await chrome.tabs.create({ url: WANGP_URL, active: false }))
  if (!tab.id) throw new Error('Could not open a local WanGP tab.')
  await waitForTab(tab.id)
  return tab.id
}

function startGeneration(prompt) {
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    )
  }
  const collectVideoUrls = () => {
    const urls = new Set()
    for (const element of document.querySelectorAll('video[src], video source[src], a[href]')) {
      const source = element.getAttribute('src') ?? element.getAttribute('href')
      if (!source || !/\.(mp4|webm|mov|mkv)(?:$|[?#])/i.test(source)) continue
      urls.add(new URL(source, window.location.href).href)
    }
    return [...urls]
  }
  const input =
    document.querySelector('#wangp-prompt-advanced textarea') ??
    [...document.querySelectorAll('textarea')].find(isVisible)
  const generate = [...document.querySelectorAll('button')].find(
    (button) => isVisible(button) && button.textContent.trim() === 'Generate',
  )

  if (!(input instanceof HTMLTextAreaElement) || !(generate instanceof HTMLButtonElement)) {
    throw new Error('WanGP is still loading. Open its tab once and try again.')
  }

  const beforeSources = collectVideoUrls()
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(input, prompt)
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }),
  )
  input.dispatchEvent(new Event('change', { bubbles: true }))
  generate.click()
  return { beforeSources }
}

function readGenerationState(beforeSources) {
  const collectVideoUrls = () => {
    const urls = new Set()
    for (const element of document.querySelectorAll('video[src], video source[src], a[href]')) {
      const source = element.getAttribute('src') ?? element.getAttribute('href')
      if (!source || !/\.(mp4|webm|mov|mkv)(?:$|[?#])/i.test(source)) continue
      urls.add(new URL(source, window.location.href).href)
    }
    return [...urls]
  }
  const outputUrl = collectVideoUrls().find((url) => !beforeSources.includes(url))
  if (outputUrl) return { status: 'completed', outputUrl }

  const text = document.body.innerText
  const failure = text.match(/(?:generation\s+)?error[^\n]*/i)
  if (failure) return { status: 'error', message: failure[0] }

  const progress = text.match(/(?:Loading model|Generating|queue:)\s*[^\n]*/i)
  return {
    status: progress ? 'generating' : 'queued',
    message: progress?.[0] ?? 'Waiting in WanGP queue',
  }
}

async function executeInWanGp(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return result[0]?.result
}

async function startJob(prompt) {
  const tabId = await getWanGpTab()
  const result = await executeInWanGp(tabId, startGeneration, [prompt])
  const jobId = crypto.randomUUID()
  const job = { tabId, beforeSources: result.beforeSources }
  jobs.set(jobId, job)
  await chrome.storage.session.set({ [`job:${jobId}`]: job })
  return { jobId, status: 'queued', message: 'Submitted to WanGP queue' }
}

async function pollJob(jobId) {
  const job = jobs.get(jobId) ?? (await chrome.storage.session.get(`job:${jobId}`))[`job:${jobId}`]
  if (!job) throw new Error('Generation session expired. Start it again.')
  jobs.set(jobId, job)
  const state = await executeInWanGp(job.tabId, readGenerationState, [job.beforeSources])
  if (state.outputUrl) {
    state.outputUrl = absoluteUrl(state.outputUrl)
    await chrome.storage.session.remove(`job:${jobId}`)
    jobs.delete(jobId)
  }
  return state
}

async function health() {
  const response = await fetch(`${WANGP_ORIGIN}/config`)
  if (!response.ok) throw new Error(`WanGP returned HTTP ${response.status}`)
  const config = await response.json()
  return { available: true, name: config.title || 'WanGP' }
}

function responseFor(action, payload) {
  if (action === 'health') return health()
  if (action === 'start') {
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) throw new Error('Enter a video prompt.')
    return startJob(prompt)
  }
  if (action === 'poll') return pollJob(payload?.jobId)
  throw new Error('Unsupported connector action.')
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== 'freecut-wangp') return
  responseFor(message.action, message.payload)
    .then((payload) => sendResponse({ payload }))
    .catch((error) =>
      sendResponse({ error: error instanceof Error ? error.message : String(error) }),
    )
  return true
})

function arrayBufferToBase64(bytes) {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'freecut-wangp-download') return

  port.onMessage.addListener(async (message) => {
    if (message?.type !== 'start' || typeof message.url !== 'string') return
    try {
      const url = absoluteUrl(message.url)
      if (!url.startsWith(WANGP_ORIGIN)) throw new Error('Unexpected WanGP result URL.')
      const response = await fetch(url)
      if (!response.ok || !response.body)
        throw new Error(`Could not download the generated video (HTTP ${response.status}).`)

      const disposition = response.headers.get('content-disposition') ?? ''
      const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'wangp-generated-video.mp4'
      port.postMessage({
        type: 'meta',
        name,
        mimeType: response.headers.get('content-type') || 'video/mp4',
      })

      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        port.postMessage({
          type: 'chunk',
          data: arrayBufferToBase64(
            value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          ),
        })
      }
      port.postMessage({ type: 'complete' })
    } catch (error) {
      port.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
})
