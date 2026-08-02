/**
 * Importing this module registers every built-in section variant as a side
 * effect, then re-exports the registry API. The compiler imports from here so
 * the catalogue is always populated before the first render.
 */
import './defaults';

export * from './registry';
