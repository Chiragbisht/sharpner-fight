/// <reference types="vite/client" />

// The three values the app reads out of .env.local. Declaring them (rather than
// leaving import.meta.env as a loose index) means a typo in a variable name is
// a compile error instead of an undefined at runtime.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Google Identity Services, loaded from accounts.google.com at sign-in time
// rather than bundled. Only the handful of members auth.ts actually touches.
interface GoogleIdConfiguration {
  client_id: string;
  ux_mode?: 'popup' | 'redirect';
  use_fedcm_for_prompt?: boolean;
  error_callback?: (e: { type?: string }) => void;
  callback?: (response: { credential: string }) => void;
}

interface GoogleButtonOptions {
  type?: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'small' | 'medium' | 'large';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  logo_alignment?: 'left' | 'center';
}

interface Window {
  google?: {
    accounts: {
      id: {
        initialize(config: GoogleIdConfiguration): void;
        renderButton(parent: HTMLElement, options: GoogleButtonOptions): void;
        disableAutoSelect?(): void;
      };
    };
  };
  // Safari's prefixed constructor, still the only one on older iOS.
  webkitAudioContext?: typeof AudioContext;
}
