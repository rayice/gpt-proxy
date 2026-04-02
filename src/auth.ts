import { defineCommand } from "citty"
import consola from "consola"

import {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  CODEX_OAUTH_PORT,
} from "./lib/api-config"
import { ensurePaths, PATHS } from "./lib/paths"
import { state } from "./lib/state"
import {
  extractAccountId,
  writeStoredAuth,
} from "./lib/token"

// --- PKCE utilities ---

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer)
}

// --- Token exchange ---

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json() as Promise<TokenResponse>
}

// --- Browser OAuth (PKCE) ---

const HTML_SUCCESS = `<!DOCTYPE html><html><body><h1>Authorization successful!</h1><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

const HTML_ERROR = (msg: string) =>
  `<!DOCTYPE html><html><body><h1>Authorization failed</h1><p>${escapeHtml(msg)}</p></body></html>`

interface PendingOAuth {
  verifier: string
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

function buildAuthorizeUrl(redirectUri: string, challenge: string, oauthState: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: oauthState,
    originator: "gpt-proxy",
  })
  return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`
}

async function startOAuthServer(): Promise<string> {
  const redirectUri = `http://localhost:${CODEX_OAUTH_PORT}/auth/callback`

  if (oauthServer) return redirectUri

  oauthServer = Bun.serve({
    port: CODEX_OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const returnedState = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          const errorMsg = errorDescription || error
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          const errorMsg = "Missing authorization code"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!pendingOAuth || returnedState !== pendingOAuth.state) {
          const errorMsg = "Invalid state - potential CSRF attack"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined

        exchangeCodeForTokens(code, redirectUri, current.verifier)
          .then((tokens) => current.resolve(tokens))
          .catch((err) => current.reject(err))

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  consola.debug("OAuth callback server started on port", CODEX_OAUTH_PORT)
  return redirectUri
}

function stopOAuthServer(): void {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
  }
}

async function browserAuth(): Promise<TokenResponse> {
  const redirectUri = await startOAuthServer()
  const pkce = await generatePKCE()
  const oauthState = generateState()
  const authUrl = buildAuthorizeUrl(redirectUri, pkce.challenge, oauthState)

  consola.info(`\nOpen this URL in your browser to authorize:\n${authUrl}\n`)

  // Try to open browser automatically
  try {
    const { spawn } = await import("node:child_process")
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawn(cmd, [authUrl], { stdio: "ignore", detached: true }).unref()
  } catch {
    // User can open manually
  }

  return new Promise<TokenResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingOAuth) {
        pendingOAuth = undefined
        reject(new Error("OAuth timeout - authorization took longer than 5 minutes"))
      }
    }, 5 * 60 * 1000)

    pendingOAuth = {
      verifier: pkce.verifier,
      state: oauthState,
      resolve: (tokens) => {
        clearTimeout(timeout)
        stopOAuthServer()
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        stopOAuthServer()
        reject(error)
      },
    }
  })
}

// --- Headless device code flow ---

async function headlessAuth(): Promise<TokenResponse> {
  const deviceResponse = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "gpt-proxy/0.1.0",
    },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  })

  if (!deviceResponse.ok) {
    throw new Error("Failed to initiate device authorization")
  }

  const deviceData = await deviceResponse.json() as {
    device_auth_id: string
    user_code: string
    interval: string
  }

  const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000
  const SAFETY_MARGIN_MS = 3000

  consola.info(`\nGo to: ${CODEX_ISSUER}/codex/device`)
  consola.info(`Enter code: ${deviceData.user_code}\n`)

  // Poll for completion
  const startTime = Date.now()
  const TIMEOUT_MS = 5 * 60 * 1000

  while (Date.now() - startTime < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, interval + SAFETY_MARGIN_MS))

    const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "gpt-proxy/0.1.0",
      },
      body: JSON.stringify({
        device_auth_id: deviceData.device_auth_id,
        user_code: deviceData.user_code,
      }),
    })

    if (response.ok) {
      const data = await response.json() as {
        authorization_code: string
        code_verifier: string
      }

      const tokenResponse = await fetch(`${CODEX_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: data.authorization_code,
          redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
          client_id: CODEX_CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      })

      if (!tokenResponse.ok) {
        throw new Error(`Token exchange failed: ${tokenResponse.status}`)
      }

      return tokenResponse.json() as Promise<TokenResponse>
    }

    // 403/404 = still pending, anything else = error
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Device auth polling failed: ${response.status}`)
    }
  }

  throw new Error("Device authorization timed out")
}

// --- Main auth command ---

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
  headless: boolean
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()

  consola.info("Starting Codex OAuth authentication...")

  const tokens = options.headless ? await headlessAuth() : await browserAuth()
  const accountId = extractAccountId(tokens)

  const storedAuth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
  }

  await writeStoredAuth(storedAuth)

  if (options.showToken) {
    consola.info("Access token:", tokens.access_token)
  }

  consola.success("Authentication successful! Token saved to", PATHS.AUTH_PATH)
  if (accountId) {
    consola.info("Account ID:", accountId)
  }
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Authenticate with Codex (ChatGPT Pro/Plus) OAuth",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show tokens on auth",
    },
    headless: {
      type: "boolean",
      default: false,
      description: "Use headless device code flow instead of browser",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
      headless: args.headless,
    })
  },
})
