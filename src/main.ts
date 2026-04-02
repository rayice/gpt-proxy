#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

const { auth } = await import("./auth")
const { start } = await import("./start")

const main = defineCommand({
  meta: {
    name: "gpt-proxy",
    description:
      "A proxy for GPT models via Codex OAuth (ChatGPT Pro/Plus) that exposes OpenAI and Anthropic-compatible API endpoints.",
  },
  subCommands: { auth, start },
})

await runMain(main)
