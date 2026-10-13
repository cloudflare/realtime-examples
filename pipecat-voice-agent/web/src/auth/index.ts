import { accessCodeAuth } from './access-code';
import type { BrowserAuth } from './provider';

/** The active browser authentication provider. Swap the import to replace it. */
export const browserAuth: BrowserAuth = accessCodeAuth;

export type { BrowserAuth, SignInProps } from './provider';
