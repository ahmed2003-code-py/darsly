/**
 * The composition engine's public entry point.
 *
 * Importing it registers the pattern library as a side effect, which is why
 * every consumer must come through here rather than reaching for `registry`
 * directly. The registry on its own is empty: the planning prompt asked it for a
 * catalogue and was handed nothing, and the Site Brain asked it for a layout and
 * got the same. Both failed silently, which is the worst way for that to fail.
 */
import './patterns';

export * from './registry';
export { composeSite } from './compile';
export type { ComposeContext } from './types';
