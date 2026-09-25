/**
 * Which recently blocked posts show their text in the popup. A list-wide
 * default (remembered between popup opens) plus per-post overrides for this
 * popup session. Changing the default clears the overrides.
 */
export class RevealState {
  private hideByDefault: boolean;
  private overrides = new Map<string, boolean>();

  constructor(hideByDefault = true) {
    this.hideByDefault = hideByDefault;
  }

  get allHidden(): boolean {
    return this.hideByDefault;
  }

  isVisible(statusId: string): boolean {
    return this.overrides.get(statusId) ?? !this.hideByDefault;
  }

  toggle(statusId: string): boolean {
    const next = !this.isVisible(statusId);
    this.overrides.set(statusId, next);
    return next;
  }

  setAllHidden(hidden: boolean) {
    this.hideByDefault = hidden;
    this.overrides.clear();
  }
}

const PREF_KEY = "qf.recentBlocked.hidden";

/** Remembered list-wide preference; localStorage can throw or be empty, so default to hidden. */
export function loadHiddenPref(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(PREF_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveHiddenPref(hidden: boolean, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(PREF_KEY, String(hidden));
  } catch {
    // Preference is a convenience; ignore storage failures.
  }
}
