/**
 * Minimal DOM element shape used by the shared axId resolution.
 * Defined as a structural type so the in-process side and the
 * BiDi-realm side can both satisfy it.
 */
export interface MinimalDomElement {
  /** `element.id` (HTML id attribute) or null if none. */
  id: string | null;
  /** Tag name in lower case (e.g. `"a"`, `"button"`). */
  tagName: string;
  /** `href` for `<a>` elements; null otherwise. */
  href: string | null;
  /** Pre-order DOM index (zero-based) under `<html>`. */
  domIndex: number;
}
