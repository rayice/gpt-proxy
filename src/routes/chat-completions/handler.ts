import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { createHandlerLogger } from "~/lib/logger"
import { recordUsage } from "~/lib/usage-tracker"
import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { normalizeToolSchema } from "~/routes/messages/responses-translation"
import {
  createResponses,
  type ResponsesPayload,
  type ResponseInputItem,
  type ResponseInputMessage,
  type ResponsesResult,
  type ResponseStreamEvent,
  type Tool as ResponsesTool,
  type ToolChoiceOptions,
  type ToolChoiceFunction,
} from "~/services/codex/create-responses"

const logger = createHandlerLogger("chat-completions-handler")

// OpenAI Chat Completions types
interface ChatCompletionsPayload {
  model: string
  messages: Array<ChatMessage>
  max_tokens?: number | null
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: Array<ChatTool>
  tool_choice?: string | { type: string; function?: { name: string } }
  stop?: Array<string> | string
  user?: string
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null
  name?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface ChatTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

// Chat Completions response types
interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: "assistant"
      content: string | null
      tool_calls?: Array<{
        id: string
        type: "function"
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export async function handleCompletion(c: Context) {
  const payload = await c.req.json<ChatCompletionsPayload>()
  logger.debug("Chat completions request payload:", JSON.stringify(payload).slice(-400))

  // Translate Chat Completions → Responses API
  const responsesPayload = translateChatCompletionsToResponses(payload)

  // Set prompt_cache_key from session header or user field to enable caching
  const sessionId = c.req.header("x-session-id") || payload.user
  if (sessionId) {
    responsesPayload.prompt_cache_key = sessionId
  }

  logger.debug("Translated Responses payload:", JSON.stringify(responsesPayload))

  const response = await createResponses(responsesPayload)

  if (payload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Codex")
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState()
      let responseId = "chatcmpl-codex"
      let toolCallIndex = 0

      try {
        for await (const chunk of response) {
          const eventName = chunk.event
          if (eventName === "ping") continue

          const data = chunk.data
          if (!data) continue

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
              recordUsage(payload.model, completionResponse.usage)
            }
          }

          const anthropicEvents = translateResponsesStreamEvent(parsedEvent, streamState)

          for (const event of anthropicEvents) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const openaiChunk = translateAnthropicEventToOpenAIChunk(event as any, payload.model, responseId, toolCallIndex)
            if (openaiChunk) {
              // Track response ID from message_start
              if (openaiChunk._responseId) {
                responseId = openaiChunk._responseId as string
                delete openaiChunk._responseId
              }
              // Track tool call index increments
              if (openaiChunk._toolCallIndexIncrement) {
                toolCallIndex += 1
                delete openaiChunk._toolCallIndexIncrement
              }
              await stream.writeSSE({
                data: JSON.stringify(openaiChunk),
              })
            }
          }

          if (streamState.messageCompleted) {
            await stream.writeSSE({ data: "[DONE]" })
            break
          }
        }
      } catch (error) {
        logger.error("Stream error:", error)
      }

      if (!streamState.messageCompleted) {
        logger.warn("Stream ended without completion, sending [DONE]")
        await stream.writeSSE({ data: "[DONE]" })
      }
    })
  }

  // Non-streaming: translate Responses result → Chat Completions response
  const result = response as ResponsesResult
  recordUsage(payload.model, result.usage)
  const chatResponse = translateResponsesToChatCompletions(result, payload.model)
  logger.debug("Non-streaming response:", JSON.stringify(chatResponse))
  return c.json(chatResponse)
}

// --- Translation: Chat Completions → Responses API ---

function translateChatCompletionsToResponses(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const input: Array<ResponseInputItem> = []
  const systemParts: Array<string> = []

  for (const msg of payload.messages) {
    switch (msg.role) {
      case "system": {
        // Concatenate multiple system messages
        if (typeof msg.content === "string") {
          systemParts.push(msg.content)
        }
        break
      }
      case "user": {
        if (typeof msg.content === "string") {
          input.push({ type: "message", role: "user", content: msg.content } as ResponseInputMessage)
        } else if (Array.isArray(msg.content)) {
          const content = msg.content.map((part) => {
            if (part.type === "text") {
              return { type: "input_text" as const, text: part.text ?? "" }
            }
            if (part.type === "image_url" && part.image_url) {
              return { type: "input_image" as const, image_url: part.image_url.url, detail: "auto" as const }
            }
            return { type: "input_text" as const, text: "" }
          })
          input.push({ type: "message", role: "user", content } as ResponseInputMessage)
        }
        break
      }
      case "assistant": {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (msg.content) {
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: msg.content }],
            } as ResponseInputMessage)
          }
          for (const tc of msg.tool_calls) {
            input.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
              status: "completed",
            })
          }
        } else if (msg.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          } as ResponseInputMessage)
        }
        break
      }
      case "tool": {
        if (msg.tool_call_id) {
          input.push({
            type: "function_call_output",
            call_id: msg.tool_call_id,
            output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          })
        }
        break
      }
    }
  }

  const tools: Array<ResponsesTool> | null = payload.tools
    ? payload.tools.map((t) => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description ?? null,
        parameters: normalizeToolSchema(t.function.parameters ?? { type: "object", properties: {} }),
        strict: false,
      }))
    : null

  const toolChoice = translateToolChoice(payload.tool_choice)
  const instructions = systemParts.length > 0 ? systemParts.join("\n\n") : null

  return {
    model: payload.model,
    input,
    instructions,
    // temperature and top_p are unsupported by Codex reasoning models — omit them
    max_output_tokens: payload.max_tokens ?? null,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: true,
    stream: payload.stream ?? null,
    store: false,
    reasoning: { effort: "high", summary: "detailed" },
    include: ["reasoning.encrypted_content"],
  }
}

function translateToolChoice(
  choice: ChatCompletionsPayload["tool_choice"],
): ToolChoiceOptions | ToolChoiceFunction | undefined {
  if (!choice) return undefined
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") return choice
    return "auto"
  }
  if (choice.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name }
  }
  return "auto"
}

// --- Translation: Responses API result → Chat Completions response ---

function translateResponsesToChatCompletions(
  result: ResponsesResult,
  model: string,
): ChatCompletionResponse {
  let textContent = ""
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  for (const item of result.output) {
    if (item.type === "message" && item.content) {
      for (const block of item.content) {
        if ("text" in block && typeof block.text === "string") {
          textContent += block.text
        }
      }
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      })
    }
  }

  if (!textContent && result.output_text) {
    textContent = result.output_text
  }

  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null = "stop"
  if (result.status === "incomplete") {
    if (result.incomplete_details?.reason === "max_output_tokens") {
      finishReason = "length"
    } else if (result.incomplete_details?.reason === "content_filter") {
      finishReason = "content_filter"
    }
  }
  if (toolCalls.length > 0) {
    finishReason = "tool_calls"
  }

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model: result.model || model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens ?? 0,
          total_tokens: result.usage.total_tokens,
        }
      : undefined,
  }
}

// --- Streaming: Anthropic event → OpenAI Chat Completion chunk ---

function translateAnthropicEventToOpenAIChunk(
  event: { type: string; [key: string]: unknown },
  model: string,
  responseId: string,
  toolCallIndex: number,
): Record<string, unknown> | null {
  switch (event.type) {
    case "message_start": {
      const msg = event.message as { id: string; model: string }
      return {
        id: msg.id,
        _responseId: msg.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: msg.model || model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      }
    }
    case "content_block_delta": {
      const delta = event.delta as { type: string; text?: string; partial_json?: string }
      if (delta.type === "text_delta" && delta.text) {
        return {
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content: delta.text },
              finish_reason: null,
            },
          ],
        }
      }
      if (delta.type === "input_json_delta" && delta.partial_json) {
        return {
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndex,
                    function: { arguments: delta.partial_json },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }
      }
      return null
    }
    case "content_block_start": {
      const block = event.content_block as { type: string; name?: string; id?: string }
      if (block.type === "tool_use") {
        return {
          id: responseId,
          _toolCallIndexIncrement: true,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndex,
                    id: block.id,
                    type: "function",
                    function: { name: block.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }
      }
      return null
    }
    case "message_delta": {
      const messageDelta = event.delta as { stop_reason?: string }
      let finishReason: string | null = null
      if (messageDelta.stop_reason === "end_turn") finishReason = "stop"
      else if (messageDelta.stop_reason === "max_tokens") finishReason = "length"
      else if (messageDelta.stop_reason === "tool_use") finishReason = "tool_calls"
      else if (messageDelta.stop_reason === "refusal") finishReason = "content_filter"

      return {
        id: responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
        usage: event.usage,
      }
    }
    default:
      return null
  }
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
