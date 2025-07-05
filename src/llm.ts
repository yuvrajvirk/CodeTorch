import * as vscode from 'vscode';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { log } from './utils';
import path from 'path';
import fs from 'fs';

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const DEFAULT_MODEL = "anthropic.claude-3-haiku-20240307-v1:0"; // cost-effective but capable

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
 * Invoke an LLM hosted on AWS Bedrock. The messages array should follow the
 * standard chat format. Returns the assistant response string.
 */
export async function invokeLLM(messages: ChatMessage[], options?: { model?: string; maxTokens?: number; temperature?: number }): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('codetorch');
  const modelId = options?.model || cfg.get<string>('model') || DEFAULT_MODEL;
  const maxTokens = options?.maxTokens ?? 8192;
  const temperature = options?.temperature ?? cfg.get<number>('temperature') ?? 0;

  let payload: Record<string, unknown>;

  if (modelId.startsWith('anthropic.')) {
    // Anthropic models require a specific schema
    let systemPrompt: string | undefined;
    const chatMessages: { role: 'user' | 'assistant'; content: string }[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = systemPrompt ? `${systemPrompt}\n${msg.content}` : msg.content;
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        chatMessages.push({ role: msg.role, content: msg.content });
      }
    }

    payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      temperature,
      messages: chatMessages,
      ...(systemPrompt ? { system: systemPrompt } : {})
    };
  } else {
    // Generic schema (e.g., Titan, Llama)
    payload = {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature
    };
  }

  // Debug: log constructed chat messages and a truncated payload preview
  log('LLM chat messages', messages);
  log('LLM payload preview', JSON.stringify(payload).slice(0, 800));

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload)
  });

  log('Bedrock invoke', { modelId, maxTokens, temperature });
  const res = await getClient().send(cmd);
  log('Received Bedrock response headers', res.$metadata);
  if (!res.body) {
    throw new Error('Empty response from Bedrock');
  }

  // Bedrock returns a stream; convert to string (Node env)
  const text = await streamToString(res.body as any);
  const parsed = JSON.parse(text);

  // after parsed computation before returning string
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

export interface SemanticUnitComment {
  line: number; // 1-based line index within the provided snippet where comment should be inserted BEFORE
  summary: string;
}

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
