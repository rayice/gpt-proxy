import os from "node:os"

import type { State } from "./state"

// Codex OAuth constants
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_ISSUER = "https://auth.openai.com"
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const CODEX_OAUTH_PORT = 1455

const APP_VERSION = "0.1.0"

export const codexHeaders = (state: State): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${state.accessToken}`,
    "originator": "gpt-proxy",
    "User-Agent": `gpt-proxy/${APP_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
  }

  if (state.accountId) {
    headers["ChatGPT-Account-Id"] = state.accountId
  }

  return headers
}
