export type ShareMode = 'read' | 'full'

export interface SessionUser {
  email: string
}

export interface SharedProject {
  id: string
  mode: ShareMode
  name: string
  size: number
}

interface ApiErrorPayload {
  error?: string
}

// fallow-ignore-next-line complexity -- centralizes JSON/error handling for the small share API client.
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload & T
  if (!response.ok) throw new Error(payload.error ?? 'Request failed')
  return payload
}

export async function getSession(): Promise<SessionUser | null> {
  const result = await api<{ user: SessionUser | null }>('/api/auth/session')
  return result.user
}

export async function authenticate(
  action: 'register' | 'login',
  email: string,
  password: string,
): Promise<SessionUser> {
  const result = await api<{ user: SessionUser }>(`/api/auth/${action}`, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  return result.user
}

export async function createShare(input: {
  mode: ShareMode
  name: string
  recipientEmail?: string
}): Promise<{ id: string; uploadUrl: string; uploadToken: string; shareUrl: string }> {
  return api('/api/shares', { method: 'POST', body: JSON.stringify(input) })
}

export async function uploadShareBundle(
  uploadUrl: string,
  uploadToken: string,
  bundle: Blob,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: bundle,
    headers: { 'Content-Type': 'application/zip', 'X-Share-Upload': uploadToken },
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload
    throw new Error(payload.error ?? 'Upload failed')
  }
}

export async function getSharedProject(id: string, key?: string): Promise<SharedProject> {
  return api(`/api/shares/${id}`, { headers: key ? { 'X-Share-Key': key } : undefined })
}

// fallow-ignore-next-line complexity -- download failures must preserve the API's server message.
export async function downloadSharedProject(id: string, name: string, key?: string): Promise<void> {
  const response = await fetch(`/api/shares/${id}/bundle`, {
    credentials: 'same-origin',
    headers: key ? { 'X-Share-Key': key } : undefined,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload
    throw new Error(payload.error ?? 'Download failed')
  }
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${name || 'project'}.freecut.zip`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
