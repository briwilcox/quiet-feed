export interface TallyDelta {
  newlyChecked: boolean;
  newlyBlocked: boolean;
}

/**
 * Per-page tally so re-evaluating a post (scrolling back, a settings change)
 * doesn't recount it. Returns null when nothing new should be recorded.
 */
export class PostTally {
  private seen = new Map<string, "checked" | "blocked">();

  record(statusId: string, blocked: boolean): TallyDelta | null {
    const prev = this.seen.get(statusId);
    const newlyChecked = prev === undefined;
    const newlyBlocked = blocked && prev !== "blocked";
    if (!newlyChecked && !newlyBlocked) return null;
    this.seen.set(statusId, blocked ? "blocked" : (prev ?? "checked"));
    return { newlyChecked, newlyBlocked };
  }
}
