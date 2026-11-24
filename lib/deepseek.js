// Direct DeepSeek API adapter (OpenAI-compatible chat completions).
//
// The chat engine only needs an object with `stream({ system, messages, ... })`
// that yields text-delta / finish chunks, so this adapter lets the plugin's
// right-hand chat talk to api.deepseek.com without going through DSH's model
// service. ZenTao writes remain deterministic flows in lib/chat.js.

function contentOf(message) {
  const parts = Array.isArray(message && message.content) ? message.content : [];
  let text = '';
  const images = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.type === 'text') text += String(part.text || '');
    else if (part.type === 'image' && part.data && part.mimeType) {
      images.push('data:' + part.mimeType + ';base64,' + part.data);
    }
  }
  if (!images.length) return text;
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });
  return content;
}

export function createDeepSeekLlm(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  const baseUrl = String(options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const defaultModel = String(options.model || 'deepseek-chat');
  const timeoutMs = Math.max(10000, Number(options.timeoutMs) || 120000);

  return {
    async *stream(input = {}) {
      if (!apiKey) throw new Error('未配置 DeepSeek API Key');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const messages = [];
      if (input.system) messages.push({ role: 'system', content: String(input.system) });
      for (const message of Array.isArray(input.messages) ? input.messages : []) {
        if (!message || !message.role) continue;
        messages.push({ role: message.role, content: contentOf(message) });
      }
      const body = {
        model: String(input.model || defaultModel),
        messages,
        stream: true,
        temperature: typeof input.temperature === 'number' ? input.temperature : 0.6,
        max_tokens: Number(input.maxTokens) || 1500,
      };
      try {
        const res = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          throw new Error('DeepSeek API HTTP ' + res.status + (detail ? '：' + detail.slice(0, 300) : ''));
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let stopped = false;
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line || !line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              stopped = true;
              break;
            }
            let event;
            try {
              event = JSON.parse(data);
            } catch (error) {
              continue;
            }
            const delta = event.choices && event.choices[0] && event.choices[0].delta;
            if (delta && typeof delta.content === 'string' && delta.content) {
              yield { type: 'text-delta', text: delta.content };
            }
            const finish = event.choices && event.choices[0] && event.choices[0].finish_reason;
            if (finish && finish !== 'null') {
              stopped = true;
              break;
            }
          }
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('DeepSeek API 请求超时');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
