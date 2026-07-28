/**
 * Authored method logic, keyed by persona id.
 *
 * A seat listed here gets its real formulas and its real decision policy. A seat absent from
 * this file keeps the mechanical identity proxy, which is executable and deliberately says
 * nothing -- so this file fills in one seat at a time without the build ever being in a
 * half-written state.
 *
 * Everything here is AI-authored and unreviewed. It is barred from production admission by
 * the same gates that bar the proxies; what changes is only that the arithmetic becomes the
 * method's own rather than a placeholder.
 *
 * DELIBERATELY EMPTY IN THIS CHECKOUT. Authored content is in
 * `docs/pending-seats/persona-v3-authored-methods.v1.mjs` and cannot be activated here: a
 * policy references tool outputs, and the tools live in the committed solo-test formula tree,
 * which is generated from `knowledge/staging/` -- private authoring inputs this repository
 * does not carry. Activating it means running the regeneration where that staging exists.
 * See `docs/pending-seats/README.md`.
 */
export const personaV3AuthoredMethods = Object.freeze({});

export default personaV3AuthoredMethods;
