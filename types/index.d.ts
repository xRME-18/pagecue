export type Target = {
  id: string;
  kind?: 'field' | 'landmark';
  label: string;
  type?: string;
  required?: boolean;
  readMask?: boolean;
  writeRefuse?: boolean;
  section?: string;
  sectionLabel?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  [key: string]: unknown;
};
export type Rect = { x: number; y: number; w: number; h: number };
export type Section = { id: string; label: string; protected?: boolean; collapsed?: boolean };
export type Change = { type: 'value' | 'layout' | 'dom'; field?: string; section?: string; humanEdit?: boolean };
export interface Adapter {
  fields(): Target[];
  read(id: string): { value?: unknown; filled?: boolean; errors?: Array<{ code: string; message: string }> };
  onChange(callback: (change: Change) => void): () => void;
  rectOf(id: string): Rect | null;
  sectionRect(id: string): Rect | null;
  sections?(): Section[];
  commit?(id: string, value: string): boolean | void;
  setCollapsed?(id: string, collapsed: boolean): void;
  setIgnore?(selectors: string[]): void;
  onParked?(counts: Map<string, number>): void;
  railX?(): number;
  title?(): string;
  today?(): string;
  dispose?(): void;
}
export interface Options {
  root?: HTMLElement;
  styleNonce?: string;
  adapter?: Adapter;
  protected?: string[];
  ignore?: string[];
  activity?: boolean;
  note?: string;
  resultHint?: string;
  onToolCall?: (call: { name: string; input: unknown; result: unknown; durationMs: number }) => void;
}
export interface PageCueHandle {
  surface: 'document' | 'navigator' | 'none';
  tools: Array<{ name: string; description: string; execute: (input: unknown) => unknown | Promise<unknown> }>;
  registry: unknown;
  adapter: Adapter;
  activity: unknown;
  note(text: string, options?: { target?: string }): unknown;
  dispose(): void;
}
/** Installs the WebMCP page-guidance tool surface. */
export declare function init(options?: Options): PageCueHandle;
