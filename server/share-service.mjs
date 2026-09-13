/**
 * Private project-share API for video.xedoc.ru.
 *
 * Bundles live outside the static web root. Access is checked before a bundle
 * is streamed, so a guessed share id is never enough to download media.
 */
import { createServer } from 'node:http'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const JSON_LIMIT_BYTES = 32 * 1024
const DEFAULT_MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function now() {
  return Date.now()
}

function base64url(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function fail(response, status, message) {
  json(response, status, { error: message })
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split(/=(.*)/s, 2))
      .filter(([name]) => name)
      .map(([name, value]) => [name, decodeURIComponent(value ?? '')]),
  )
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function safeFilename(name) {
  const compact = name.replaceAll(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
  return (compact || 'project').slice(0, 120)
}

function equalHash(expected, actual) {
  if (!expected || !actual) return false
  const left = Buffer.from(expected, 'hex')
  const right = Buffer.from(sha256(actual), 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

async function passwordHash(password) {
  const salt = base64url(16)
  const derived = await scrypt(password, salt, 64)
  return `${salt}:${Buffer.from(derived).toString('base64url')}`
}

async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':')
  if (!salt || !expected) return false
  const derived = Buffer.from(await scrypt(password, salt, 64)).toString('base64url')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(derived))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > JSON_LIMIT_BYTES) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON')
  }
}

function createSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK(mode IN ('read', 'full')),
      owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      recipient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      secret_hash TEXT,
      upload_hash TEXT NOT NULL,
      bundle_path TEXT,
      bundle_size INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending', 'ready')),
      created_at INTEGER NOT NULL
    ) STRICT;
  `)
}

/** Create the API without binding a socket; used by the service and tests. */
// fallow-ignore-next-line complexity -- HTTP composition is intentionally colocated with its private SQLite state.
export async function createShareServer(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.SHARE_DATA_DIR ?? './data/shares')
  const publicOrigin = (options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? 'https://video.xedoc.ru').replace(
    /\/$/,
    '',
  )
  const maxBundleBytes = Number(options.maxBundleBytes ?? process.env.MAX_BUNDLE_BYTES ?? DEFAULT_MAX_BUNDLE_BYTES)
  const cookieSecure = options.cookieSecure ?? process.env.SHARE_COOKIE_SECURE !== 'false'
  await mkdir(dataDir, { recursive: true })
  const bundlesDir = join(dataDir, 'bundles')
  await mkdir(bundlesDir, { recursive: true })
  const database = new DatabaseSync(join(dataDir, 'shares.sqlite'))
  createSchema(database)

  const findSession = database.prepare(
    `SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  )
  const findUserByEmail = database.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
  const getShare = database.prepare('SELECT * FROM shares WHERE id = ?')
  const requestCounts = new Map()

  function isSameOrigin(request) {
    const origin = request.headers.origin
    return !origin || origin === publicOrigin
  }

  function limited(request, key, limit) {
    const ip = request.socket.remoteAddress ?? 'unknown'
    const bucketKey = `${key}:${ip}`
    const entry = requestCounts.get(bucketKey)
    const current = now()
    if (!entry || current - entry.startedAt > 60_000) {
      requestCounts.set(bucketKey, { startedAt: current, count: 1 })
      return false
    }
    entry.count += 1
    return entry.count > limit
  }

  function currentUser(request) {
    const token = parseCookies(request.headers.cookie).freecut_session
    if (!token) return null
    return findSession.get(sha256(token), now()) ?? null
  }

  function setSession(response, userId) {
    const token = base64url()
    database
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), userId, now() + SESSION_TTL_MS)
    response.setHeader(
      'Set-Cookie',
      `freecut_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${cookieSecure ? '; Secure' : ''}`,
    )
  }

  function clearSession(response) {
    response.setHeader(
      'Set-Cookie',
      `freecut_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure ? '; Secure' : ''}`,
    )
  }

  function canReadShare(share, request, user) {
    if (share.mode === 'read') {
      return equalHash(share.secret_hash, request.headers['x-share-key'])
    }
    return Boolean(user && (user.id === share.owner_user_id || user.id === share.recipient_user_id))
  }

  // fallow-ignore-next-line complexity -- keeps streaming cleanup adjacent to the single-use upload authorization.
  async function receiveBundle(request, response, share, uploadToken) {
    if (!equalHash(share.upload_hash, uploadToken) || share.status !== 'pending') {
      fail(response, 403, 'This upload link is invalid or has already been used')
      return
    }
    const length = Number(request.headers['content-length'] ?? 0)
    if (length > maxBundleBytes) {
      fail(response, 413, `Bundle exceeds the ${maxBundleBytes} byte limit`)
      return
    }
    const partialPath = join(bundlesDir, `${share.id}.part`)
    const finalPath = join(bundlesDir, `${share.id}.freecut.zip`)
    const output = createWriteStream(partialPath, { flags: 'wx' })
    let received = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      received += chunk.length
      if (received > maxBundleBytes) {
        tooLarge = true
        request.destroy()
      }
    })
    try {
      await new Promise((resolveUpload, rejectUpload) => {
        request.pipe(output)
        output.on('finish', resolveUpload)
        output.on('error', rejectUpload)
        request.on('error', rejectUpload)
      })
      if (tooLarge) throw new Error('Bundle is too large')
      await stat(partialPath)
      // Rename is atomic within the data directory, so readers only see a
      // complete uploaded bundle after the database row becomes ready.
      await rename(partialPath, finalPath)
      database
        .prepare("UPDATE shares SET bundle_path = ?, bundle_size = ?, status = 'ready' WHERE id = ?")
        .run(finalPath, received, share.id)
      json(response, 201, { id: share.id, size: received })
    } catch (error) {
      output.destroy()
      await rm(partialPath, { force: true }).catch(() => undefined)
      fail(response, tooLarge ? 413 : 400, tooLarge ? 'Bundle is too large' : 'Bundle upload failed')
    }
  }

  // fallow-ignore-next-line complexity -- route dispatch is kept in one auditable API boundary.
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', publicOrigin)
      const path = url.pathname
      const method = request.method ?? 'GET'
      const user = currentUser(request)

      if (path === '/api/health' && method === 'GET') {
        json(response, 200, { status: 'ok' })
        return
      }
      if (method !== 'GET' && !isSameOrigin(request)) {
        fail(response, 403, 'Cross-site request rejected')
        return
      }
      if (path === '/api/auth/session' && method === 'GET') {
        json(response, 200, { user: user ? { email: user.email } : null })
        return
      }
      if (path === '/api/auth/register' && method === 'POST') {
        if (limited(request, 'register', 10)) return fail(response, 429, 'Too many registration attempts')
        const body = await readJson(request)
        const email = normalizeEmail(body.email)
        const password = typeof body.password === 'string' ? body.password : ''
        if (!EMAIL_PATTERN.test(email)) return fail(response, 400, 'Enter a valid email address')
        if (password.length < 8 || password.length > 256)
          return fail(response, 400, 'Password must contain 8 to 256 characters')
        if (findUserByEmail.get(email)) return fail(response, 409, 'This email is already registered')
        const result = database
          .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
          .run(email, await passwordHash(password), now())
        setSession(response, Number(result.lastInsertRowid))
        json(response, 201, { user: { email } })
        return
      }
      if (path === '/api/auth/login' && method === 'POST') {
        if (limited(request, 'login', 20)) return fail(response, 429, 'Too many sign-in attempts')
        const body = await readJson(request)
        const email = normalizeEmail(body.email)
        const password = typeof body.password === 'string' ? body.password : ''
        const account = findUserByEmail.get(email)
        if (!account || !(await verifyPassword(password, account.password_hash))) {
          return fail(response, 401, 'Email or password is incorrect')
        }
        setSession(response, account.id)
        json(response, 200, { user: { email: account.email } })
        return
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        const token = parseCookies(request.headers.cookie).freecut_session
        if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
        clearSession(response)
        json(response, 200, { ok: true })
        return
      }
      if (path === '/api/shares' && method === 'POST') {
        if (limited(request, 'share-create', 30)) return fail(response, 429, 'Too many share attempts')
        const body = await readJson(request)
        const mode = body.mode === 'full' ? 'full' : body.mode === 'read' ? 'read' : null
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 160) : ''
        if (!mode || !name) return fail(response, 400, 'Share mode and project name are required')
        let recipient = null
        if (mode === 'full') {
          if (!user) return fail(response, 401, 'Sign in before granting full access')
          const recipientEmail = normalizeEmail(body.recipientEmail)
          recipient = findUserByEmail.get(recipientEmail)
          if (!recipient) return fail(response, 422, 'The collaborator must register with this email first')
        }
        const id = randomUUID()
        const secret = mode === 'read' ? base64url() : null
        const uploadToken = base64url()
        database
          .prepare(
            `INSERT INTO shares (id, mode, owner_user_id, recipient_user_id, name, secret_hash, upload_hash, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            id,
            mode,
            user?.id ?? null,
            recipient?.id ?? null,
            name,
            secret ? sha256(secret) : null,
            sha256(uploadToken),
            now(),
          )
        json(response, 201, {
          id,
          uploadUrl: `/api/shares/${id}/bundle`,
          uploadToken,
          shareUrl: mode === 'read' ? `${publicOrigin}/share/${id}#key=${secret}` : `${publicOrigin}/share/${id}`,
        })
        return
      }

      const uploadMatch = path.match(/^\/api\/shares\/([0-9a-f-]{36})\/bundle$/i)
      if (uploadMatch && method === 'PUT') {
        const share = getShare.get(uploadMatch[1])
        if (!share) return fail(response, 404, 'Share not found')
        await receiveBundle(request, response, share, request.headers['x-share-upload'])
        return
      }
      const shareMatch = path.match(/^\/api\/shares\/([0-9a-f-]{36})(?:\/(bundle))?$/i)
      if (shareMatch && method === 'GET') {
        const share = getShare.get(shareMatch[1])
        if (!share || share.status !== 'ready') return fail(response, 404, 'Shared project not found')
        if (!canReadShare(share, request, user)) return fail(response, 401, 'This project is not available to this account')
        if (!shareMatch[2]) {
          json(response, 200, { id: share.id, mode: share.mode, name: share.name, size: share.bundle_size })
          return
        }
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': String(share.bundle_size),
          'Content-Disposition': `attachment; filename="${safeFilename(share.name)}.freecut.zip"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        createReadStream(share.bundle_path).pipe(response)
        return
      }
      fail(response, 404, 'Not found')
    } catch (error) {
      console.error('share-service request failed', error)
      fail(response, 500, 'Server error')
    }
  })
  server.on('close', () => database.close())
  return server
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const port = Number(process.env.PORT ?? 3113)
  const server = await createShareServer()
  server.listen(port, '127.0.0.1', () => console.log(`FreeCut share API listening on ${port}`))
}
