declare const __QF_BUILD_ID__: string | undefined;

/**
 * Identifies one build. Extension pages load fresh from disk while the service
 * worker keeps running old code until the extension is reloaded, so the popup
 * and settings page compare this with the worker's and ask for a reload.
 * The build scripts replace it; unbuilt code (tests) reports "dev".
 */
export const BUILD_ID: string = typeof __QF_BUILD_ID__ === "string" ? __QF_BUILD_ID__ : "dev";
