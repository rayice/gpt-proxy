import consola from "consola"
import fs from "node:fs"

import { PATHS } from "./paths"

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
  }
  extraPrompts?: Record<string, string>
  smallModel?: string
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >
}

const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  extraPrompts: {},
  smallModel: "gpt-5.1-codex-mini",
  modelReasoningEfforts: {
    "gpt-5.1-codex-mini": "low",
    "gpt-5.1-codex": "high",
    "gpt-5.1-codex-max": "xhigh",
    "gpt-5.2-codex": "high",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4": "xhigh",
    "gpt-5.4-mini": "xhigh",
  },
}

let cachedConfig: AppConfig | null = null

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
      "utf8",
    )
    try {
      fs.chmodSync(PATHS.CONFIG_PATH, 0o600)
    } catch {
      return
    }
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      )
      return defaultConfig
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    consola.error("Failed to read config file, using default config", error)
    return defaultConfig
  }
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()
  cachedConfig = { ...defaultConfig, ...config }
  return cachedConfig
}

export function getConfig(): AppConfig {
  cachedConfig ??= readConfigFromDisk()
  return cachedConfig
}

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  return config.extraPrompts?.[model] ?? ""
}

export function getSmallModel(): string {
  const config = getConfig()
  return config.smallModel ?? "gpt-5.1-codex-mini"
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export function getReasoningEffortForModel(
  model: string,
): ReasoningEffort {
  const config = getConfig()
  return config.modelReasoningEfforts?.[model] ?? "high"
}

export function setReasoningEffortForModel(
  model: string,
  effort: ReasoningEffort,
): void {
  const config = getConfig()
  if (!config.modelReasoningEfforts) {
    config.modelReasoningEfforts = {}
  }
  config.modelReasoningEfforts[model] = effort
}
