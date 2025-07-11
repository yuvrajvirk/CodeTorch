import * as vscode from 'vscode';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { log } from './utils';
import path from 'path';
import fs from 'fs';
// Official Gemini SDK – loaded dynamically via require to avoid build-time dependency issue

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// General LLM service interface for future extensibility
interface LLMService {
  name: string;
  invoke(messages: ChatMessage[], options?: LLMOptions): Promise<string>;
}

interface LLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  retries?: number;
  baseDelay?: number;
}

// Throttling and retry configuration
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

const DEFAULT_MODEL = "anthropic.claude-3-haiku-20240307-v1:0"; 
// const DEFAULT_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  backoffMultiplier: 2
};

// Legacy client reference (kept for backward compatibility)
let client: BedrockRuntimeClient | undefined;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    const region = vscode.workspace.getConfiguration('codetorch').get<string>('awsRegion') || process.env.AWS_REGION || 'us-east-1';
    client = new BedrockRuntimeClient({ region });
  }
  return client;
}

// Utility to convert async iterable / stream into string
function streamToString(body: any): Promise<string> {
  if (!body) return Promise.resolve('');

  // 1. Already a string
  if (typeof body === 'string') {
    return Promise.resolve(body);
  }

  // 2. Uint8Array or Buffer
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return Promise.resolve(Buffer.from(body).toString('utf8'));
  }

  // 3. Blob-like (browser)
  if (typeof body.text === 'function') {
    return body.text();
  }

  // 4. ReadableStream (Node) – fallback
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    if (typeof body.on === 'function') {
      body.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      body.on('error', reject);
      body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    } else {
      reject(new Error('Unsupported response body type'));
    }
  });
}

/**
 * Check if an error is a throttling/rate limiting error that should be retried
 */
function isThrottlingError(error: any): boolean {
  // AWS Bedrock throttling
  if (error?.name === 'ThrottlingException' || error?.name === 'TooManyRequestsException') {
    return true;
  }
  
  // HTTP 429 status codes
  if (error?.$metadata?.httpStatusCode === 429) {
    return true;
  }
  
  // Generic rate limiting error messages
  const throttlingMessages = [
    'rate limit',
    'throttling',
    'too many requests',
    'quota exceeded',
    'service unavailable',
    'temporarily unavailable'
  ];
  
  const errorMessage = (error?.message || error?.toString() || '').toLowerCase();
  return throttlingMessages.some(msg => errorMessage.includes(msg));
}

/**
 * Calculate delay for exponential backoff
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(delay, config.maxDelay);
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff for throttling errors
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Only retry on throttling errors
      if (!isThrottlingError(error)) {
        throw error;
      }
      
      // Don't retry on the last attempt
      if (attempt === config.maxRetries) {
        break;
      }
      
      const delay = calculateDelay(attempt, config);
      log(`Throttling detected, retrying in ${delay}ms (attempt ${attempt + 1}/${config.maxRetries + 1})`);
      
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * AWS Bedrock LLM Service Implementation
 */
class AWSBedrockService implements LLMService {
  name = 'aws-bedrock';
  private client: BedrockRuntimeClient;

  constructor() {
    const region = vscode.workspace.getConfiguration('codetorch').get<string>('awsRegion') || process.env.AWS_REGION || 'us-east-1';
    this.client = new BedrockRuntimeClient({ region });
  }

  async invoke(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('codetorch');
    const modelId = options?.model || cfg.get<string>('model') || DEFAULT_MODEL;
    // Anthropic Claude models support up to 4 096 output tokens (see Bedrock docs).
    const requestedMax = options?.maxTokens ?? 8192;
    const maxTokens = Math.min(requestedMax, 4096);
    const temperature = options?.temperature ?? cfg.get<number>('temperature') ?? 0;

    let payload: Record<string, unknown>;

    if (modelId.startsWith('anthropic.') || modelId.startsWith('us.anthropic.')) {
      // Anthropic models require a specific schema
      let systemPrompt: string | undefined;
      // Claude 3/4 Messages API expects `content` to be an **array** of content blocks.
      const chatMessages: { role: 'user' | 'assistant'; content: { type: 'text'; text: string }[] }[] = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          systemPrompt = systemPrompt ? `${systemPrompt}\n${msg.content}` : msg.content;
        } else if (msg.role === 'user' || msg.role === 'assistant') {
          chatMessages.push({
            role: msg.role,
            content: [{ type: 'text', text: msg.content }]
          });
        }
      }

      payload = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        temperature: temperature,
        messages: chatMessages,
        ...(systemPrompt ? { system: systemPrompt } : {})
      };
    } else if (modelId.startsWith('meta.llama') || modelId.startsWith('us.meta.llama')) {
      // Meta Llama 3 models use a native prompt string plus native parameters
      let systemMessage: string | undefined;
      let userMessage: string | undefined;

      for (const msg of messages) {
        if (msg.role === 'system' && !systemMessage) {
          systemMessage = msg.content;
        } else if (msg.role === 'user') {
          // Keep the most recent user turn
          userMessage = msg.content;
        }
      }

      if (!userMessage) {
        throw new Error('Llama 3 invocation requires at least one user message');
      }

      // Build Llama 3 instruction-style prompt
      const promptParts: string[] = [];
      promptParts.push('<|begin_of_text|>');
      if (systemMessage) {
        promptParts.push(`<|start_header_id|>system<|end_header_id|>\n${systemMessage}\n<|eot_id|>`);
      }
      promptParts.push(`<|start_header_id|>user<|end_header_id|>\n${userMessage}\n<|eot_id|>`);
      // Assistant header to signal model to generate
      promptParts.push('<|start_header_id|>assistant<|end_header_id|>');

      const llamaPrompt = promptParts.join('\n');

      payload = {
        prompt: llamaPrompt,
        max_gen_len: Math.min(maxTokens, 2048), // Llama 3 supports up to 2048 generated tokens
        temperature: temperature,
        top_p: cfg.get<number>('topP') ?? 0.9
      };
    } else {
      // Generic schema (e.g., Titan, Llama)
      payload = {
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
        temperature: temperature
      };
    }

    log('LLM chat messages', messages);
    log('LLM payload preview', JSON.stringify(payload).slice(0, 800));

    const cmd = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload)
    });

    log('Bedrock invoke', { modelId, maxTokens, temperature });
    let res;
    try {
      res = await this.client.send(cmd);
    } catch (error: any) {
      // Surface the detailed Bedrock error message to the output channel
      log('Bedrock invoke error', {
        name: error?.name,
        message: error?.message,
        details: error,
      });
      throw error;
    }
    log('Received Bedrock response headers', res.$metadata);
    if (!res.body) {
      throw new Error('Empty response from Bedrock');
    }

    // Bedrock returns a stream; convert to string (Node env)
    const text = await streamToString(res.body as any);
    const parsed = JSON.parse(text);

    log('LLM parsed response snippet', typeof parsed === 'string' ? parsed.slice(0,100) : parsed);

    // Anthropic / OpenAI-compatible schema
    if (Array.isArray(parsed?.choices) && parsed.choices.length) {
      const choice = parsed.choices[0];
      return (
        choice.message?.content || // chat
        choice.text ||
        ''
      );
    }

    // Titan Text models
    if (Array.isArray(parsed?.results) && parsed.results.length) {
      return parsed.results[0].outputText || parsed.results[0].text || '';
    }

    // Meta Llama 3 native response
    if (typeof parsed.generation === 'string') {
      return parsed.generation;
    }

    // Cohere / Llama2 etc.
    if (typeof parsed.generated_text === 'string') {
      return parsed.generated_text;
    }

    // Generic {content: string}
    if (typeof parsed.content === 'string') {
      return parsed.content;
    }

    // Bedrock message-style schema (Claude streaming or non-chat)
    if (parsed?.type === 'message' && Array.isArray(parsed.content)) {
      const textPieces = parsed.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text);
      if (textPieces.length) {
        return textPieces.join('');
      }
    }

    // As a last resort, stringify the whole object
    return typeof text === 'string' ? text : JSON.stringify(parsed);
  }
}

/**
 * Google Gemini LLM Service Implementation
 */
class GoogleGeminiService implements LLMService {
  name = 'google-gemini';
  private apiKey: string;
  private genAI: any; // Lazy-initialised GoogleGenAI instance (SDK lacks TS types)

  constructor() {
    this.apiKey = vscode.workspace.getConfiguration('codetorch').get<string>('googleApiKey') ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_AI_API_KEY || '';

    if (!this.apiKey) {
      log('Google Gemini API key not configured. Set `codetorch.googleApiKey` or env var GEMINI_API_KEY.');
    }

    // Dynamically require the SDK only when the service is first constructed
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { GoogleGenAI } = require('@google/genai');
      this.genAI = new GoogleGenAI({ apiKey: this.apiKey });
    } catch (err) {
      log('Failed to load @google/genai package', err as any);
      throw new Error('Missing dependency @google/genai – please run `npm install @google/genai` inside the extension workspace.');
    }
  }

  async invoke(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    log('Gemini invoke');
    if (!this.apiKey) {
      throw new Error('Google Gemini API key not configured. Set `codetorch.googleApiKey` in settings or GEMINI_API_KEY env var.');
    }

    const cfg = vscode.workspace.getConfiguration('codetorch');
    const model = options?.model || cfg.get<string>('geminiModel') || 'gemini-2.5-flash';
    const requestedMax = options?.maxTokens ?? 4096;
    const temperature = options?.temperature ?? cfg.get<number>('temperature') ?? 0.3;

    // Build chat history and extract system instruction (if any)
    let systemPrompt: string | undefined;
    const historyParts = [] as any[];
    for (const msg of messages.slice(0, -1)) {
      if (msg.role === 'system') {
        systemPrompt = systemPrompt ? `${systemPrompt}\n${msg.content}` : msg.content;
      } else {
        historyParts.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') {
      throw new Error('Gemini invocation expects the last message to be from the user.');
    }

    // Create a transient chat session for each invoke
    const chatOptions: any = {
      model,
      history: historyParts,
      generationConfig: {
        temperature,
        maxOutputTokens: requestedMax
      }
    };
    if (systemPrompt) {
      chatOptions.systemInstruction = systemPrompt;
    }

    const chat = this.genAI.chats.create(chatOptions);

    try {
      const response = await chat.sendMessage({ message: lastMsg.content });
      const text = response?.text ?? '';
      log('Gemini response', text.slice(0, 400));
      return text;
    } catch (error: any) {
      log('Gemini invoke error', { name: error?.name, message: error?.message, details: error });
      throw error;
    }
  }
}

/**
 * LLM Service Manager for handling multiple services
 */
class LLMServiceManager {
  private services = new Map<string, LLMService>();
  private defaultService: string = 'aws-bedrock';

  constructor() {
    // Register default AWS Bedrock service
    this.registerService(new AWSBedrockService());
    this.registerService(new GoogleGeminiService());
  }

  registerService(service: LLMService): void {
    this.services.set(service.name, service);
    log(`Registered LLM service: ${service.name}`);
  }

  getService(name?: string): LLMService {
    const serviceName = name || this.defaultService;
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`LLM service '${serviceName}' not found. Available services: ${Array.from(this.services.keys()).join(', ')}`);
    }
    return service;
  }

  getAvailableServices(): string[] {
    return Array.from(this.services.keys());
  }

  setDefaultService(name: string): void {
    if (!this.services.has(name)) {
      throw new Error(`Cannot set default service to '${name}' - service not registered`);
    }
    this.defaultService = name;
    log(`Default LLM service set to: ${name}`);
  }
}

// Global service manager instance
const serviceManager = new LLMServiceManager();
// Register Google Gemini service (optional unless explicitly selected)
try {
  serviceManager.registerService(new GoogleGeminiService());
} catch (err) {
  log('Failed to register Google Gemini service', err as any);
}

/**
 * Determine which service to use based on model name
 */
function getServiceForModel(modelId: string): string {
  // Check if it's a Gemini model
  if (modelId.startsWith('gemini-') || modelId.includes('gemini')) {
    return 'google-gemini';
  }
  // Default to AWS Bedrock for all other models
  return 'aws-bedrock';
}

/**
 * Invoke an LLM with automatic service selection and retry logic
 */
export async function invokeLLM(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('codetorch');
  
  // Get retry configuration from settings or use defaults
  const retryConfig: RetryConfig = {
    maxRetries: options?.retries ?? cfg.get<number>('maxRetries') ?? DEFAULT_RETRY_CONFIG.maxRetries,
    baseDelay: options?.baseDelay ?? cfg.get<number>('retryBaseDelay') ?? DEFAULT_RETRY_CONFIG.baseDelay,
    maxDelay: cfg.get<number>('retryMaxDelay') ?? DEFAULT_RETRY_CONFIG.maxDelay,
    backoffMultiplier: cfg.get<number>('retryBackoffMultiplier') ?? DEFAULT_RETRY_CONFIG.backoffMultiplier
  };

  // Determine which service to use based on model name
  log('Invoking LLM', cfg.get<string>('model'));
  const modelId = options?.model || cfg.get<string>('model') || DEFAULT_MODEL;
  log('Getting servic name for LLM', modelId);
  const serviceName = getServiceForModel(modelId);
  log('Getting service for LLM', serviceName);
  const service = serviceManager.getService(serviceName);
  log('Using LLM service', serviceName, modelId);

  return withRetry(async () => {
    return await service.invoke(messages, options);
  }, retryConfig);
}

/**
 * Register a new LLM service
 */
export function registerLLMService(service: LLMService): void {
  serviceManager.registerService(service);
}

/**
 * Get available LLM services
 */
export function getAvailableLLMServices(): string[] {
  return serviceManager.getAvailableServices();
}

/**
 * Set the default LLM service
 */
export function setDefaultLLMService(name: string): void {
  serviceManager.setDefaultService(name);
}

/**
 * Convenience wrapper to summarise an entire function. Returns a natural-language summary.
 */
export async function summarizeFunction(code: string, language: string): Promise<string> {
  const prefix = vscode.workspace.getConfiguration('codetorch').get<string>('commentPrefix') || '// >';
  const systemPrompt = 'You are a senior software engineer who explains code clearly. Respond ONLY with JSON that conforms to this schema: { "summary": "string" }';
  const userPrompt = `Provide a concise summary (1-3 sentences) of the following ${language} function. Do not add code fences.\n\n${code}`;
  const response = await invokeLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]);

  // Ensure summary lines start with comment prefix for easy insertion if desired
  return response.split('\n').map(line => `${prefix} ${line}`.trim()).join('\n');
}

export interface ChunkSummary {
  line: number;          // 1-based, relative to start of function
  chunkCode: string;     // The exact code lines this summary describes
  summary: string;       // Natural-language explanation
}

export interface FunctionSummary {
  liveCode: string;        // Live (current) source of the function
  lastSavedCode: string;       // Source when summaries were last generated
  startLine: number;           // Absolute 0-based start line in the document (for live shifts)
  units: ChunkSummary[];       // Ordered list of chunk summaries (first element can summarise entire fn)
}

// Backwards-compat alias until callers migrate fully
export type SemanticUnitComment = ChunkSummary;

/**
 * Generate detailed semantic unit summaries for a single function.
 *
 * The function is sent to the model with **explicit line numbers** so that the
 * model can reference exact insertion points. We then parse the JSON array the
 * model returns. If the model produces a simpler "N - summary" style list we
 * fall back to regex parsing.
 *
 * @param code      Raw source of the function (no surrounding code)
 * @param language  Language identifier (e.g. "typescript", "python") for better prompting
 * @returns Array of `{ line, summary }` objects – ready for the CodeLens provider.
 */
export async function summarizeFunctionSemanticUnits(code: string, language: string): Promise<SemanticUnitComment[]> {
  const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'comments_system_prompt.txt'), 'utf8');
  const promptTemplate = fs.readFileSync(path.join(__dirname, 'prompts', 'comments_prompt_template.txt'), 'utf8');

  //'You are a senior software engineer who explains code clearly. Respond ONLY with JSON that conforms to this schema: [{ "line": 1, "summary": "string" }]';
  // Add line numbers to snippet so the model can reference them deterministically
  const lines = code.split(/\r?\n/);
  const numberedSnippet = lines.map((l, idx) => `${idx + 1}: ${l}`).join("\n");
  const promptCode = promptTemplate.replace('{{{code_with_line_numbers}}}', numberedSnippet);
  const example1 = fs.readFileSync(path.join(__dirname, 'prompts', 'comments_example_1.txt'), 'utf8');
  const example2 = fs.readFileSync(path.join(__dirname, 'prompts', 'comments_example_2.txt'), 'utf8');

  const response = await invokeLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: example1.substring(example1.indexOf('USER:') + 'USER:'.length).trim() },
    { role: 'assistant', content: example1.substring(example1.indexOf('ASSISTANT:') + 'ASSISTANT:'.length).trim() },
    { role: 'user', content: example2.substring(example2.indexOf('USER:') + 'USER:'.length).trim() },
    { role: 'assistant', content: example2.substring(example2.indexOf('ASSISTANT:') + 'ASSISTANT:'.length).trim() },
    { role: 'user', content: `${promptCode}` }
  ]);
  

  // Primary: parse "N | summary" style lines
  const lineObjects = response
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m = l.match(/^(\d+)\s*[|:-]\s*(.+)$/);
      if (m) {
        return { line: Number(m[1]), summary: m[2].trim() };
      }
      return undefined;
    })
    .filter(Boolean) as SemanticUnitComment[];

  if (lineObjects.length) return lineObjects;

  // Fallback: attempt to parse strict JSON array
  try {
    const parsed = JSON.parse(response);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((obj: any) => typeof obj?.line === 'number' && typeof obj?.summary === 'string')
        .map((obj: any) => ({ line: obj.line, summary: obj.summary.trim() })) as SemanticUnitComment[];
    }
  } catch {
    // ignore
  }

  // If parsing fails, return empty array
  return [];
}
