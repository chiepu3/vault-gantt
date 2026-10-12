import { describe, it, expect } from "vitest";
import { ContextBuilder } from "../../src/ai/context-builder";
import { selectToolFamilies } from "../../src/ai/tool-selection";
import { runtimeFixture } from "../app/operation-runtime-fixture";
import { CHILD_ID } from "../contracts/fixtures";
import { ChatSession, type ChatProvider } from "../../src/ai/chat-session";
describe("catalog chat context", () => {
  it("automatically attaches only a bounded overview and selects requested families", async () => {
    const { service, context } = await runtimeFixture();
    const text = await new ContextBuilder(service.contextPort).build(context);
    expect(new TextEncoder().encode(text).length).toBeLessThan(8192); expect(JSON.parse(text).data.kind).toBe("overview"); expect(text).not.toContain("currentStatus"); expect(text).not.toContain("workloadPlan"); expect(text).not.toContain("review-point");
    expect(selectToolFamilies("イベントの実績時間を設定")).toEqual(["tasks", "schedule", "workload", "events"]);
  });
  it("chat confirms catalog proposals through the same frozen service", async () => {
    const { service, context, vault } = await runtimeFixture();
    const provider: ChatProvider = { connected: () => true, async *stream() {
      const preview = await service.propose("M07", { subtaskId: CHILD_ID, workloadPlan: { "2026-10-13": 1.3 } }, context);
      yield { type: "plan", preview, operationId: "M07", plan: service.legacyPlan(preview), operation: "update-batch", input: { subtaskId: CHILD_ID, workloadPlan: { "2026-10-13": 1.3 } } };
    } };
    const session = new ChatSession({}, service, provider, () => undefined, service);
    await session.send("実績と計画"); const proposal = session.active.messages[1].proposals[0]; expect(proposal.preview?.operationId).toBe("M07"); expect(vault.getModifyCallCount()).toBe(0);
    await session.confirm(proposal); expect(proposal.result?.kind).toBe("success"); expect(vault.getModifyCallCount()).toBe(1); expect(JSON.stringify(session.active.context)).toContain("操作の実際の結果");
  });
  it("records human card approvals and new repreview receipts without sending projection snapshots to the model", async () => {
    const { service, context } = await runtimeFixture();
    const provider: ChatProvider = { connected: () => true, async *stream(request) {
      const preview = await service.propose("T07", { taskId: CHILD_ID, name: "カード承認" }, { ...context, origin: { kind: "chat", conversationId: request.conversationId! } });
      yield { type: "plan", preview, operationId: "T07", plan: service.legacyPlan(preview), operation: "update", input: { taskId: CHILD_ID } };
    } };
    const session = new ChatSession({}, service, provider, () => undefined, service);
    await session.send("名前を変更"); const proposal = session.active.messages[1].proposals[0];
    await service.previewPort.reject(proposal.plan.previewId);
    const next = await service.previewPort.requestRepreview(proposal.plan.previewId);
    await service.humanApprovalPort.approve(next.previewId);
    const contextText = JSON.stringify(session.active.context);
    expect(contextText).toContain(next.previewId); expect(contextText).toContain("人間の承認後の実保存結果");
    expect(contextText).not.toContain("actualProjection"); expect(contextText).not.toContain("affectedParentIds");
    expect(session.active.status).toBe("idle"); expect(proposal.consumed).toBe(true);
    session.dispose(); service.dispose();
  });

});
