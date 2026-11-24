export type ActionKind = "comment_reply" | "email_prompt" | "link_dm";

export interface SocialAction {
  /** Stable across every attempt for this logical effect. */
  id: string;
  runId: string;
  tenantId: string;
  accountId: string;
  participantId: string;
  commentId: string;
  kind: ActionKind;
  /** Exclusive UTC deadline checked by the connector immediately before sending. */
  sendBefore: string;
  text: string;
}

export type SendOutcome =
  | { kind: "sent"; receipt: string }
  | { kind: "retry"; code: string; retryAfterMs?: number }
  | { kind: "rejected"; code: string }
  | { kind: "uncertain"; code: string };

export interface SocialAdapter {
  /**
   * Retry and rejection both certify that the provider did not accept the send.
   * A timeout or a missing acknowledgement leaves the outcome uncertain.
   * Use opaque receipts and machine-readable error codes.
   */
  send(action: SocialAction, signal: AbortSignal): Promise<SendOutcome>;
}

type SimulatedOutcome =
  | Exclude<SendOutcome, { kind: "uncertain" }>
  | { kind: "uncertain"; code: string; accepted?: boolean };

/** Records every accepted call, including duplicates, so tests can detect an accidental resend. */
export class SimulatedAdapter implements SocialAdapter {
  readonly sent: SocialAction[] = [];
  private readonly outcomes: SimulatedOutcome[] = [];

  plan(...outcomes: SimulatedOutcome[]): void {
    this.outcomes.push(...outcomes);
  }

  async send(action: SocialAction, signal: AbortSignal): Promise<SendOutcome> {
    signal.throwIfAborted();
    if (!(Date.now() < Date.parse(action.sendBefore))) return { kind: "rejected", code: "window_expired" };
    const result = this.outcomes.shift() ?? { kind: "sent", receipt: `sim-${action.id}` };
    if (result.kind === "sent" || (result.kind === "uncertain" && result.accepted)) {
      this.sent.push({ ...action });
    }
    return result;
  }
}
