import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import {
  MODEL_HAIKU,
  MODEL_SONNET,
  MODEL_OPUS,
  type ModelId,
  calculateCostUsd,
} from '@/lib/ai-pm/llm.constants';

interface AnthropicMessageContent {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content: AnthropicMessageContent[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface AnthropicLike {
  messages: {
    create: (params: Record<string, unknown>) => Promise<AnthropicMessageResponse>;
  };
}

export type AnthropicFactory = (apiKey: string) => AnthropicLike;

const defaultFactory: AnthropicFactory = (apiKey) =>
  new Anthropic({ apiKey }) as unknown as AnthropicLike;

// Haiku occasionally wraps JSON output in a ```json fenced block despite
// prompt instructions. Strip the fence before JSON.parse so the schema layer
// doesn't reject otherwise-valid responses.
function stripCodeFence(text: string): string {
  const m = text.match(/^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  return m ? m[1] : text;
}

export type LlmError =
  | { kind: 'API_ERROR'; message: string }
  | { kind: 'INVALID_JSON'; message: string; raw: string }
  | { kind: 'SCHEMA_REJECTED'; message: string; issues: unknown }
  | { kind: 'NO_TOOL_USE'; message: string }
  | { kind: 'EMPTY_RESPONSE'; message: string };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  model: ModelId;
}

export type LlmResult<T> =
  | { ok: true; data: T; usage: LlmUsage }
  | { ok: false; error: LlmError; usage?: LlmUsage };

interface BaseCallParams {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  factory?: AnthropicFactory;
  maxTokens?: number;
  cacheSystem?: boolean;
}

interface JsonCallParams<T> extends BaseCallParams {
  schema: z.ZodType<T>;
}

export interface ToolDefinition<T> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
}

interface ToolCallParams<T> extends BaseCallParams {
  tools: ToolDefinition<T>[];
}

function extractUsage(model: ModelId, raw: AnthropicMessageResponse['usage']): LlmUsage {
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  const cachedInputTokens = raw.cache_read_input_tokens ?? 0;
  const costUsd = calculateCostUsd(model, { inputTokens, outputTokens, cachedInputTokens });
  return { inputTokens, outputTokens, cachedInputTokens, costUsd, model };
}

function buildSystem(prompt: string, cacheSystem: boolean): unknown {
  if (!cacheSystem) return prompt;
  return [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }];
}

async function callJsonModel<T>(
  model: ModelId,
  params: JsonCallParams<T>,
  defaultCache: boolean,
): Promise<LlmResult<T>> {
  const factory = params.factory ?? defaultFactory;
  const cacheSystem = params.cacheSystem ?? defaultCache;
  const client = factory(params.apiKey);

  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create({
      model,
      max_tokens: params.maxTokens ?? 1024,
      system: buildSystem(params.systemPrompt, cacheSystem),
      messages: [{ role: 'user', content: params.userPrompt }],
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const usage = extractUsage(model, response.usage);
  const textBlock = response.content.find((c) => c.type === 'text' && typeof c.text === 'string');
  if (!textBlock || !textBlock.text) {
    return { ok: false, error: { kind: 'EMPTY_RESPONSE', message: 'No text content' }, usage };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'INVALID_JSON',
        message: err instanceof Error ? err.message : String(err),
        raw: textBlock.text,
      },
      usage,
    };
  }

  const result = params.schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: {
        kind: 'SCHEMA_REJECTED',
        message: 'Zod validation failed',
        issues: result.error.issues,
      },
      usage,
    };
  }

  return { ok: true, data: result.data, usage };
}

export function callHaiku<T>(params: JsonCallParams<T>): Promise<LlmResult<T>> {
  return callJsonModel(MODEL_HAIKU, params, false);
}

export function callOpus<T>(params: JsonCallParams<T>): Promise<LlmResult<T>> {
  return callJsonModel(MODEL_OPUS, params, false);
}

export interface SonnetToolResult {
  toolName: string;
  args: unknown;
}

export async function callSonnet<T>(
  params: ToolCallParams<T>,
): Promise<LlmResult<SonnetToolResult>> {
  const factory = params.factory ?? defaultFactory;
  const cacheSystem = params.cacheSystem ?? true;
  const client = factory(params.apiKey);

  const tools = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema),
  }));

  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: params.maxTokens ?? 2048,
      system: buildSystem(params.systemPrompt, cacheSystem),
      tools,
      messages: [{ role: 'user', content: params.userPrompt }],
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const usage = extractUsage(MODEL_SONNET, response.usage);
  const toolBlock = response.content.find((c) => c.type === 'tool_use');
  if (!toolBlock || !toolBlock.name) {
    return {
      ok: false,
      error: { kind: 'NO_TOOL_USE', message: 'Sonnet returned no tool_use block' },
      usage,
    };
  }

  const matched = params.tools.find((t) => t.name === toolBlock.name);
  if (!matched) {
    return {
      ok: false,
      error: {
        kind: 'SCHEMA_REJECTED',
        message: `Unknown tool name: ${toolBlock.name}`,
        issues: [],
      },
      usage,
    };
  }

  const validation = matched.schema.safeParse(toolBlock.input);
  if (!validation.success) {
    return {
      ok: false,
      error: {
        kind: 'SCHEMA_REJECTED',
        message: `Tool args failed validation for ${toolBlock.name}`,
        issues: validation.error.issues,
      },
      usage,
    };
  }

  return {
    ok: true,
    data: { toolName: toolBlock.name, args: validation.data },
    usage,
  };
}

export interface SonnetTextResult {
  text: string;
}

export async function callSonnetText(
  params: BaseCallParams,
): Promise<LlmResult<SonnetTextResult>> {
  const factory = params.factory ?? defaultFactory;
  const cacheSystem = params.cacheSystem ?? false;
  const client = factory(params.apiKey);

  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: params.maxTokens ?? 1024,
      system: buildSystem(params.systemPrompt, cacheSystem),
      messages: [{ role: 'user', content: params.userPrompt }],
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const usage = extractUsage(MODEL_SONNET, response.usage);
  const textBlock = response.content.find((c) => c.type === 'text');
  const text = textBlock?.text ?? '';
  if (!text) {
    return { ok: false, error: { kind: 'EMPTY_RESPONSE', message: 'Sonnet returned no text content' }, usage };
  }
  return { ok: true, data: { text }, usage };
}

/**
 * Minimal Zod-to-JSON-Schema converter for Anthropic tool input schemas.
 * Only supports the subset of Zod we use: z.object, z.string, z.number,
 * z.boolean, z.array, z.enum, z.optional, z.literal.
 *
 * Written for Zod 4 where _def uses { type: string } instead of
 * Zod 3's { typeName: 'ZodString' } convention.
 *
 * Larger projects should use a library like `zod-to-json-schema`. We avoid
 * the dependency for now; widen this function as new schema shapes appear.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Zod 4: _def.type is the discriminator string (e.g. 'string', 'object', 'enum', …)
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const type = def['type'] as string | undefined;

  switch (type) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'literal': {
      // Zod 4: _def.values is an array of literal values
      const values = def['values'] as unknown[];
      return { const: values[0] };
    }
    case 'enum': {
      // Zod 4: _def.entries is a { value: value } map
      const entries = def['entries'] as Record<string, string>;
      return { type: 'string', enum: Object.keys(entries) };
    }
    case 'array': {
      // Zod 4: _def.element is the element schema
      const element = def['element'] as z.ZodType;
      return { type: 'array', items: zodToJsonSchema(element) };
    }
    case 'optional': {
      // Zod 4: _def.innerType is the wrapped schema
      const inner = def['innerType'] as z.ZodType;
      return zodToJsonSchema(inner);
    }
    case 'object': {
      // Zod 4: _def.shape is a plain object (not a function)
      const shape = def['shape'] as Record<string, z.ZodType>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        const innerDef = (value as unknown as { _def: Record<string, unknown> })._def;
        if (innerDef['type'] !== 'optional') required.push(key);
      }
      return { type: 'object', properties, required };
    }
    default:
      return { type: 'object' };
  }
}
