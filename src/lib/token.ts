import consola from "consola"
import fs from "node:fs/promises"

import {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
} from "./api-config"
import { HTTPError } from "./error"
import { PATHS } from "./paths"
import { state } from "./state"

export interface StoredAuth {
  accessToken: string
  refreshToken: string
  expires: number
  accountId?: string
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new HTTPError(`Token refresh failed: ${response.status}`, response)
  }
  return response.json() as Promise<TokenResponse>
}

export async function readStoredAuth(): Promise<StoredAuth | null> {
  let raw: string
  try {
    raw = await fs.readFile(PATHS.AUTH_PATH, "utf8")
  } catch {
    return null // File does not exist
  }
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as StoredAuth
  } catch {
    consola.warn("auth.json is corrupt, re-authenticate with `gpt-proxy auth`")
    return null
  }
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  await fs.writeFile(PATHS.AUTH_PATH, JSON.stringify(auth, null, 2), "utf8")
  await fs.chmod(PATHS.AUTH_PATH, 0o600)
}

export async function loadTokensIntoState(): Promise<void> {
  const stored = await readStoredAuth()
  if (!stored) {
    throw new Error("No stored auth found. Run `gpt-proxy auth` first.")
  }

  state.accessToken = stored.accessToken
  state.refreshToken = stored.refreshToken
  state.tokenExpires = stored.expires
  state.accountId = stored.accountId

  if (state.showToken) {
    consola.info("Access token:", state.accessToken)
  }

  consola.debug("Loaded stored auth tokens")
}

// Mutex to prevent concurrent token refreshes
let refreshPromise: Promise<void> | null = null

export async function ensureValidToken(): Promise<void> {
  if (!state.accessToken || !state.refreshToken) {
    throw new Error("No auth tokens loaded. Run `gpt-proxy auth` first.")
  }

  if (state.tokenExpires && state.tokenExpires > Date.now()) {
    return // Token is still valid
  }

  // If a refresh is already in-flight, await the same promise
  if (refreshPromise) {
    return refreshPromise
  }

  refreshPromise = performTokenRefresh()

  try {
    await refreshPromise
  } finally {
    refreshPromise = null
  }
}

async function performTokenRefresh(): Promise<void> {
  consola.debug("Access token expired, refreshing...")

  try {
    const tokens = await refreshAccessToken(state.refreshToken!)
    const newAccountId = extractAccountId(tokens) || state.accountId

    state.accessToken = tokens.access_token
    state.refreshToken = tokens.refresh_token
    state.tokenExpires = Date.now() + (tokens.expires_in ?? 3600) * 1000
    state.accountId = newAccountId

    await writeStoredAuth({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expires: state.tokenExpires,
      accountId: newAccountId,
    })

    consola.debug("Token refreshed successfully")
    if (state.showToken) {
      consola.info("Refreshed access token:", state.accessToken)
    }
  } catch (error) {
    consola.error("Failed to refresh token:", error)
    throw new Error("Token refresh failed. Run `gpt-proxy auth` to re-authenticate.")
  }
}
