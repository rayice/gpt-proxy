import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { getSmallModel } from "~/lib/config"
import { recordUsage } from "~/lib/usage-tracker"
import { createHandlerLogger } from "~/lib/logger"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/codex/create-responses"

import type {
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "./anthropic-types"

const logger = createHandlerLogger("messages-handler")

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  const isCompact = isCompactRequest(anthropicPayload)

  // Force small model for warmup requests (no tools, non-compact)
  const anthropicBeta = c.req.header("anthropic-beta")
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact) {
    anthropicPayload.model = getSmallModel()
  }

  if (!isCompact) {
    mergeToolResultForClaude(anthropicPayload)
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  // Ensure the model is in our allowed list, or use as-is
  const allowedModel = state.models.find((m) => m.id === anthropicPayload.model)
  if (allowedModel) {
    anthropicPayload.model = allowedModel.id
  }

  // Always use Responses API (Codex only speaks Responses API)
  return await handleWithResponsesApi(c, anthropicPayload, sessionId)
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  sessionId?: string,
) => {
  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)

  // Set prompt_cache_key from session ID to enable Codex prompt caching
  if (sessionId) {
    responsesPayload.prompt_cache_key = sessionId
  }

  // Compact input by latest compaction to reduce context size
  compactInputByLatestCompaction(responsesPayload)

  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const response = await createResponses(responsesPayload)

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Codex (Responses API)")
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState()

      try {
        for await (const chunk of response) {
          const eventName = chunk.event
          if (eventName === "ping") {
            await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
            continue
          }

          const data = chunk.data
          if (!data) {
            continue
          }

          logger.debug("Responses raw stream event:", data)

          let parsedEvent: ResponseStreamEvent
          try {
            parsedEvent = JSON.parse(data) as ResponseStreamEvent
          } catch {
            logger.warn("Failed to parse stream chunk:", data)
            continue
          }

          // Record usage from completion events
          if (parsedEvent.type === "response.completed" || parsedEvent.type === "response.incomplete") {
            const completionResponse = (parsedEvent as { response?: ResponsesResult }).response
            if (completionResponse) {
              recordUsage(anthropicPayload.model, completionResponse.usage)
            }
          }

          const events = translateResponsesStreamEvent(parsedEvent, streamState)
          for (const event of events) {
            const eventData = JSON.stringify(event)
            logger.debug("Translated Anthropic event:", eventData)
            await stream.writeSSE({
              event: event.type,
              data: eventData,
            })
          }

          if (streamState.messageCompleted) {
            logger.debug("Message completed, ending stream")
            break
          }
        }
      } catch (error) {
        logger.error("Stream error:", error)
      }

      if (!streamState.messageCompleted) {
        logger.warn(
          "Responses stream ended without completion; sending error event",
        )
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion",
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    })
  }

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const result = response as ResponsesResult
  recordUsage(anthropicPayload.model, result.usage)

  const anthropicResponse = translateResponsesResultToAnthropic(result)
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  return {
    ...tr,
    content: [...tr.content, textBlock],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}

import type {
  ResponsesPayload,
  ResponseInputItem,
} from "~/services/codex/create-responses"

const compactInputByLatestCompaction = (
  payload: ResponsesPayload,
): void => {
  if (!Array.isArray(payload.input) || payload.input.length === 0) {
    return
  }

  let latestCompactionIndex: number | undefined

  for (let index = payload.input.length - 1; index >= 0; index -= 1) {
    const item = payload.input[index] as ResponseInputItem
    if ("type" in item && typeof item.type === "string" && item.type === "compaction") {
      latestCompactionIndex = index
      break
    }
  }

  if (latestCompactionIndex !== undefined) {
    payload.input = payload.input.slice(latestCompactionIndex)
  }
}
