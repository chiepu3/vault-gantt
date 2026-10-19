import type { ChatMessage, ChatPart, Conversation } from "./chat-session";

/** Stored outside the plugin folder (in the vault's config folder) so updating or reinstalling the plugin never removes it. */
export const CHAT_HISTORY_FILE = "vault-gantt-chat-history.json";
const VERSION = 1;
const MAX_CONVERSATIONS = 10;
const MAX_MESSAGES = 100;

export interface StoredConversation { id: string; title: string; messages: ChatMessage[]; context: Conversation["context"] }
export interface StoredChatHistory { version: number; activeId?: string; conversations: StoredConversation[] }

/**
 * Previews live only in memory, so proposal cards cannot be restored; their text, reasoning and tool activity are kept.
 * Messages are copied so the stored snapshot never aliases live, still-streaming state.
 */
export function serializeChatHistory(conversations: readonly Conversation[], activeId: string | undefined): StoredChatHistory {
  return {
    version: VERSION,
    activeId,
    conversations: conversations.filter((conversation) => conversation.messages.length).map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages.map((message): ChatMessage => ({
        role: message.role,
        text: message.text,
        proposals: [],
        parts: (message.parts ?? (message.text ? [{ type: "text", id: "text", text: message.text } as ChatPart] : [])).filter((part) => part.type !== "proposal").map((part) => structuredClone(part)),
      })),
      context: structuredClone(conversation.context),
    })),
  };
}

/** Tolerates a missing, partial or corrupt file: whatever cannot be read is dropped. */
export function restoreChatHistory(raw: unknown): { conversations: Conversation[]; activeId?: string } {
  const value = raw && typeof raw === "object" ? (raw as Partial<StoredChatHistory>) : {};
  const conversations: Conversation[] = [];
  for (const item of Array.isArray(value.conversations) ? value.conversations.slice(-MAX_CONVERSATIONS) : []) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !Array.isArray(item.messages)) continue;
    const messages: ChatMessage[] = item.messages.slice(0, MAX_MESSAGES).filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string")
      .map((message) => ({ role: message.role, text: message.text, proposals: [], parts: Array.isArray(message.parts) ? message.parts.filter((part) => part && typeof part === "object" && part.type !== "proposal") : undefined }));
    if (!messages.length) continue;
    conversations.push({ id: item.id, title: typeof item.title === "string" && item.title ? item.title : "新しい会話", messages, context: Array.isArray(item.context) ? item.context : [], status: "idle", error: "", draft: "" });
  }
  return { conversations, activeId: typeof value.activeId === "string" ? value.activeId : undefined };
}
