import type { HumanApprovalPort } from "../contracts/ports";
import type { OperationOutcomeV1 } from "../contracts/preview";
/** Created for the plugin human UI; never put this object in a model/transport toolset. */
export class ApprovalService implements HumanApprovalPort {
  private readonly running = new Map<string, Promise<OperationOutcomeV1>>();
  constructor(private readonly execute: (id: string) => Promise<OperationOutcomeV1>, private readonly receipt: (id: string) => OperationOutcomeV1 | undefined) {}
  approve(id: string): Promise<OperationOutcomeV1> {
    const saved = this.receipt(id);
    if (saved) return Promise.resolve(saved);
    const active = this.running.get(id); if (active) return active;
    const result = this.execute(id);
    this.running.set(id, result);
    void result.finally(() => this.running.delete(id)).catch(() => undefined);
    return result;
  }
}
