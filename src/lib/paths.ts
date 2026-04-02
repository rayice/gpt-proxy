import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DEFAULT_DIR = path.join(os.homedir(), ".local", "share", "gpt-proxy")
const APP_DIR = process.env.GPT_PROXY_HOME || DEFAULT_DIR

const AUTH_PATH = path.join(APP_DIR, "auth.json")
const CONFIG_PATH = path.join(APP_DIR, "config.json")

export const PATHS = {
  APP_DIR,
  AUTH_PATH,
  CONFIG_PATH,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.AUTH_PATH)
  await ensureFile(PATHS.CONFIG_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
