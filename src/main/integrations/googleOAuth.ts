import { createHash, randomBytes } from 'crypto'
import { shell } from 'electron'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import type { CalendarConfig } from '../../shared/types'
import { IntegrationError, request } from './http'
import { TOKEN_URL } from './providers/google'
import { getRecord, parseGoogleSecret, setGoogleRefreshToken } from './registry'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
// readonly lists calendars; events writes blocks to the work calendar; app.created lets us create
// and manage the Focus time calendar (and nothing else about the account's calendars)
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.app.created'
].join(' ')
const TIMEOUT_MS = 3 * 60_000

const b64url = (b: Buffer): string => b.toString('base64url')

/**
 * Desktop OAuth: loopback redirect + PKCE. Opens the system browser, waits for the redirect on
 * 127.0.0.1, exchanges the code, and stores the refresh token encrypted.
 */
export async function connectGoogle(integrationId: string): Promise<void> {
  const rec = getRecord(integrationId)
  const clientId = (rec.config as unknown as CalendarConfig).client_id
  const clientSecret = parseGoogleSecret(rec.secret).client_secret
  if (!clientId || !clientSecret) {
    throw new IntegrationError('Save the client ID and client secret first')
  }

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const err = url.searchParams.get('error')
        const got = url.searchParams.get('code')
        const ok = !err && got && url.searchParams.get('state') === state
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(
          ok
            ? 'Connected. You can close this tab.'
            : 'Authorization failed. You can close this tab.'
        )
        clearTimeout(timer)
        server.close()
        if (ok) {
          resolve({ code: got, redirectUri })
        } else {
          reject(new IntegrationError(err ? `Google: ${err}` : 'Authorization failed'))
        }
      })
      let redirectUri = ''
      const timer = setTimeout(() => {
        server.close()
        reject(new IntegrationError('Timed out waiting for Google sign-in'))
      }, TIMEOUT_MS)
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent'
        })
        shell.openExternal(`${AUTH_URL}?${params}`).catch(reject)
      })
    }
  )

  const tokens = await request<{ refresh_token?: string }>(TOKEN_URL, {
    form: {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }
  })
  if (!tokens.refresh_token) throw new IntegrationError('Google did not return a refresh token')
  setGoogleRefreshToken(integrationId, tokens.refresh_token)
}
