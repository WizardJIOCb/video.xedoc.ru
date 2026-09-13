import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShareServer } from './share-service.mjs'

let server
let origin
let dataDir

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'freecut-share-'))
  server = await createShareServer({
    dataDir,
    publicOrigin: 'http://127.0.0.1',
    cookieSecure: false,
    maxBundleBytes: 1024 * 1024,
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(dataDir, { recursive: true, force: true })
})

async function json(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  return { response, body: await response.json() }
}

test('read-only shares require the fragment secret for metadata and bundle download', async () => {
  const created = await json('/api/shares', {
    method: 'POST',
    body: JSON.stringify({ mode: 'read', name: 'Read only' }),
  })
  assert.equal(created.response.status, 201)
  const secret = new URL(created.body.shareUrl).hash.slice('#key='.length)

  const noSecret = await fetch(`${origin}/api/shares/${created.body.id}`)
  assert.equal(noSecret.status, 404)

  const upload = await fetch(`${origin}${created.body.uploadUrl}`, {
    method: 'PUT',
    headers: { 'X-Share-Upload': created.body.uploadToken },
    body: Buffer.from('bundle bytes'),
  })
  assert.equal(upload.status, 201)

  const metadata = await fetch(`${origin}/api/shares/${created.body.id}`, { headers: { 'X-Share-Key': secret } })
  assert.equal(metadata.status, 200)
  assert.equal((await metadata.json()).mode, 'read')

  const download = await fetch(`${origin}/api/shares/${created.body.id}/bundle`, { headers: { 'X-Share-Key': secret } })
  assert.equal(download.status, 200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from('bundle bytes'))
})

test('full-access shares are restricted to the registered invited email', async () => {
  const owner = await json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'owner@example.com', password: 'a safe test password' }),
  })
  assert.equal(owner.response.status, 201)
  const ownerCookie = owner.response.headers.get('set-cookie').split(';')[0]
  const guest = await json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'guest@example.com', password: 'a safe test password' }),
  })
  assert.equal(guest.response.status, 201)
  const guestCookie = guest.response.headers.get('set-cookie').split(';')[0]

  const created = await json('/api/shares', {
    method: 'POST',
    headers: { Cookie: ownerCookie },
    body: JSON.stringify({ mode: 'full', name: 'Editable', recipientEmail: 'guest@example.com' }),
  })
  assert.equal(created.response.status, 201)
  assert.equal((await fetch(`${origin}/api/shares/${created.body.id}`)).status, 404)

  const upload = await fetch(`${origin}${created.body.uploadUrl}`, { method: 'PUT', headers: { 'X-Share-Upload': created.body.uploadToken }, body: Buffer.from('editable') })
  assert.equal(upload.status, 201)
  assert.equal((await fetch(`${origin}/api/shares/${created.body.id}`)).status, 401)
  assert.equal((await fetch(`${origin}/api/shares/${created.body.id}`, { headers: { Cookie: ownerCookie } })).status, 200)
  assert.equal((await fetch(`${origin}/api/shares/${created.body.id}`, { headers: { Cookie: guestCookie } })).status, 200)
})
