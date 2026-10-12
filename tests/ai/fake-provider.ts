import type { ChatEvent, ChatProvider, ChatRequest, ConnectionConfig } from "../../src/ai/chat-session";
export class FakeProvider implements ChatProvider {
  readonly requests: ChatRequest[] = [];
  connected(config: ConnectionConfig): boolean { return !!config.model; }
  constructor(private readonly events: (request: ChatRequest) => AsyncIterable<ChatEvent> = async function* () { yield { type: "text", text: "合成" }; yield { type: "text", text: "応答" }; }) {}
  stream(request: ChatRequest): AsyncIterable<ChatEvent> { this.requests.push(request); return this.events(request); }
}
