export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  stream?: boolean;
  user?: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamDelta {
  role?: string;
  content?: string;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
}

export type StreamCallback = (chunk: StreamChunk) => void;

export class OpenClawHttpClient {
  private baseUrl: string;
  private token: string;
  private agentId: string;

  constructor(options: {
    baseUrl: string;
    token: string;
    agentId?: string;
  }) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.agentId = options.agentId || 'main';
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'x-openclaw-agent-id': this.agentId,
      },
      body: JSON.stringify({
        ...request,
        model: request.model || `openclaw:${this.agentId}`,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenClaw API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  async chatCompletionStream(
    request: ChatCompletionRequest,
    onChunk: StreamCallback,
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'x-openclaw-agent-id': this.agentId,
      },
      body: JSON.stringify({
        ...request,
        model: request.model || `openclaw:${this.agentId}`,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenClaw API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    let fullContent = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') break;

        try {
          const chunk: StreamChunk = JSON.parse(data);
          onChunk(chunk);

          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            fullContent += content;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    return fullContent;
  }

  async invokeToolRaw(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'x-openclaw-agent-id': this.agentId,
      },
      body: JSON.stringify({ tool, args }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenClaw tools/invoke error (${response.status}): ${errorText}`);
    }

    const result = await response.json() as { ok: boolean; error?: { message: string }; result?: unknown };
    if (!result.ok) {
      throw new Error(result.error?.message || 'Tool invocation failed');
    }

    return result.result;
  }
}
