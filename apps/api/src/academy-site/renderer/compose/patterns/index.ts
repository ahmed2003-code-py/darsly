/**
 * Importing this module registers the whole pattern library as a side effect.
 * The compiler imports it, so the catalogue is always populated before the first
 * render — and so is every prompt and every rule that reads the registry.
 */
import './hero';
import './content';
import './business';

export {};
