import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import {
  mergeConfigWithDefaults,
  getReasoningEffortForModel,
  setReasoningEffortForModel,
  type ReasoningEffort,
} from "./lib/config"
import { ensurePaths } from "./lib/paths"
import { generateEnvScript } from "./lib/shell"
import { state, type CodexModel } from "./lib/state"
import { loadTokensIntoState } from "./lib/token"
import { loadTodayUsage } from "./lib/usage-tracker"

// Codex model allowlist
const CODEX_MODELS: Array<CodexModel> = [
  { id: "gpt-5.1-codex", name: "GPT 5.1 Codex", vendor: "openai" },
  { id: "gpt-5.1-codex-max", name: "GPT 5.1 Codex Max", vendor: "openai" },
  { id: "gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini", vendor: "openai" },
  { id: "gpt-5.2", name: "GPT 5.2", vendor: "openai" },
  { id: "gpt-5.2-codex", name: "GPT 5.2 Codex", vendor: "openai" },
  { id: "gpt-5.3-codex", name: "GPT 5.3 Codex", vendor: "openai" },
  { id: "gpt-5.4", name: "GPT 5.4", vendor: "openai" },
  { id: "gpt-5.4-mini", name: "GPT 5.4 Mini", vendor: "openai" },
]

interface RunServerOptions {
  port: number
  verbose: boolean
  claudeCode: boolean
  showToken: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
  mergeConfigWithDefaults()

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()

  // Load stored tokens
  await loadTokensIntoState()

  // Load today's usage data
  loadTodayUsage()

  // Set models (static allowlist for Codex)
  state.models = CODEX_MODELS

  consola.info(
    `Available models: \n${state.models.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    consola.log(
      "\nTip: The --claude-code flag generates a clipboard command for launching Claude Code.\n"
        + "All models remain accessible without this flag.\n",
    )

    invariant(state.models.length > 0, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.map((model) => model.id),
      },
    )

    const effortLevels: Array<ReasoningEffort> = ["low", "medium", "high", "xhigh"]

    const mainDefault = getReasoningEffortForModel(selectedModel)
    const selectedMainEffort = await consola.prompt(
      `Reasoning effort for ${selectedModel}`,
      {
        type: "select",
        options: effortLevels,
        initial: effortLevels.includes(mainDefault) ? mainDefault : "high",
      },
    ) as ReasoningEffort
    setReasoningEffortForModel(selectedModel, selectedMainEffort)

    if (selectedSmallModel !== selectedModel) {
      const smallDefault = getReasoningEffortForModel(selectedSmallModel)
      const selectedSmallEffort = await consola.prompt(
        `Reasoning effort for ${selectedSmallModel}`,
        {
          type: "select",
          options: effortLevels,
          initial: effortLevels.includes(smallDefault) ? smallDefault : "low",
        },
      ) as ReasoningEffort
      setReasoningEffortForModel(selectedSmallModel, selectedSmallEffort)
    }

    consola.info(`Reasoning effort: ${selectedModel}=${selectedMainEffort}${selectedSmallModel !== selectedModel ? `, ${selectedSmallModel}=${getReasoningEffortForModel(selectedSmallModel)}` : ""}`)

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      },
      "claude",
    )

    consola.log("\nRun this command in a new terminal to launch Claude Code:\n")
    consola.log(`  ${command}\n`)

    try {
      clipboard.writeSync(command)
      consola.success("(Also copied to clipboard)")
    } catch {
      // Clipboard not available — command is already displayed above
    }
  }

  const { server } = await import("./server")

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })

  consola.success(`GPT Proxy running at ${serverUrl}`)
  consola.box(`Usage Viewer: ${serverUrl}/usage-viewer`)
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the GPT Proxy server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with GPT Proxy config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show tokens on startup and refresh",
    },
  },
  run({ args }) {
    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
    })
  },
})
