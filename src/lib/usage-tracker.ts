import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "./paths"

export interface ModelUsage {
  requests: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  reasoning_tokens: number
}

export interface UsageSnapshot {
  models: Record<string, ModelUsage>
  totals: ModelUsage
}

export interface UsageReport {
  session: UsageSnapshot & { started: string }
  today: UsageSnapshot & { date: string }
}

const USAGE_DIR = path.join(PATHS.APP_DIR, "usage")

const emptyModelUsage = (): ModelUsage => ({
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
})

const emptySnapshot = (): UsageSnapshot => ({
  models: {},
  totals: emptyModelUsage(),
})

// In-memory state
const sessionStarted = new Date().toISOString()
let sessionUsage: UsageSnapshot = emptySnapshot()
let dailyUsage: UsageSnapshot = emptySnapshot()
let currentDay = todayKey()

function todayKey(): string {
  return new Date().toLocaleDateString("sv-SE") // YYYY-MM-DD
}

function dailyFilePath(day: string): string {
  return path.join(USAGE_DIR, `${day}.json`)
}

function ensureUsageDir(): void {
  if (!fs.existsSync(USAGE_DIR)) {
    fs.mkdirSync(USAGE_DIR, { recursive: true })
  }
}

export function loadTodayUsage(): void {
  ensureUsageDir()
  const day = todayKey()
  const filePath = dailyFilePath(day)
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8")
      const parsed = JSON.parse(raw) as UsageSnapshot
      dailyUsage = parsed
      currentDay = day
      consola.debug(`Loaded daily usage for ${day}`)
    }
  } catch {
    consola.debug("No existing daily usage found, starting fresh")
  }
}

function addToSnapshot(
  snapshot: UsageSnapshot,
  model: string,
  input_tokens: number,
  output_tokens: number,
  cached_tokens: number,
  reasoning_tokens: number,
): void {
  if (!snapshot.models[model]) {
    snapshot.models[model] = emptyModelUsage()
  }
  const m = snapshot.models[model]
  m.requests += 1
  m.input_tokens += input_tokens
  m.output_tokens += output_tokens
  m.cached_tokens += cached_tokens
  m.reasoning_tokens += reasoning_tokens

  snapshot.totals.requests += 1
  snapshot.totals.input_tokens += input_tokens
  snapshot.totals.output_tokens += output_tokens
  snapshot.totals.cached_tokens += cached_tokens
  snapshot.totals.reasoning_tokens += reasoning_tokens
}

function persistDaily(): void {
  ensureUsageDir()
  try {
    fs.writeFileSync(
      dailyFilePath(currentDay),
      JSON.stringify(dailyUsage, null, 2),
      "utf8",
    )
  } catch (error) {
    consola.warn("Failed to persist daily usage:", error)
  }
}

export interface ResponseUsageData {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

export function recordUsage(model: string, usage: ResponseUsageData | null | undefined): void {
  if (!usage) return

  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0

  // Roll over to new day if needed
  const today = todayKey()
  if (today !== currentDay) {
    dailyUsage = emptySnapshot()
    currentDay = today
  }

  addToSnapshot(sessionUsage, model, input, output, cached, reasoning)
  addToSnapshot(dailyUsage, model, input, output, cached, reasoning)

  persistDaily()

  consola.debug(
    `[usage] ${model}: in=${input} out=${output} cached=${cached} reasoning=${reasoning}`,
  )
}

export function getUsageReport(): UsageReport {
  // Roll over if day changed
  const today = todayKey()
  if (today !== currentDay) {
    dailyUsage = emptySnapshot()
    currentDay = today
  }

  return {
    session: {
      started: sessionStarted,
      ...sessionUsage,
    },
    today: {
      date: currentDay,
      ...dailyUsage,
    },
  }
}
