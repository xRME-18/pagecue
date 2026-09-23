import type { Options, PageCueHandle } from './index.js';

declare global {
  interface Window {
    pagecueOptions?: Options;
    pagecue?: PageCueHandle;
  }
}
export {};
