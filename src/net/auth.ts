import { supabase, isConfigured } from './supabase.ts';
import type { Session } from '@supabase/supabase-js';
import type { OwnProfile } from './types.ts';

// Google sign-in without ever leaving sharpenerfight.com.
//
// The usual Supabase flow redirects the browser to <project>.supabase.co and
// lets Google redirect back, which means Google's consent screen shows the
// supabase.co address. Instead we let Google Identity Services render its own
// button on our page: the popup runs against our origin, Google hands us an ID
// token, and we pass that token to Supabase. Supabase still owns the session —
// the player just never sees its hostname.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const GIS_SRC = 'https://accounts.google.com/gsi/client';

let loading: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (!CLIENT_ID) return Promise.reject(new Error('no-client-id'));
  if (window.google?.accounts?.id) return Promise.resolve();

  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      // Ad blockers and strict privacy extensions block this script outright,
      // so the caller needs to be able to say so rather than showing nothing.
      loading = null;
      reject(new Error('gis-blocked'));
    };
    document.head.append(s);
  });
  return loading;
}

interface MountOptions {
  onError?: (e: Error) => void;
}

/** Render Google's button into `container`. Throws if GIS can't load. */
export async function mountGoogleButton(
  container: HTMLElement,
  { onError }: MountOptions = {}
): Promise<void> {
  if (!isConfigured) throw new Error('no-supabase');
  await loadGis();

  const gis = window.google?.accounts.id;
  if (!gis) throw new Error('gis-blocked');

  gis.initialize({
    client_id: CLIENT_ID as string,
    ux_mode: 'popup',
    use_fedcm_for_prompt: true, // survives Chrome's third-party cookie removal
    // Fires for problems Google detects on its side — most usefully when this
    // origin is not on the client ID's allow-list, which otherwise makes the
    // button look like it simply does nothing.
    error_callback: (e) => {
      onError?.(
        new Error(
          e?.type === 'unregistered_origin'
            ? `Add ${window.location.origin} to the Google client ID's authorised JavaScript origins.`
            : 'Google could not start sign-in.'
        )
      );
    },
    callback: async ({ credential }) => {
      const { error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: credential,
      });
      if (error) onError?.(error);
    },
  });

  container.replaceChildren();
  gis.renderButton(container, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'left',
  });
}

export async function signOut(): Promise<void> {
  // Otherwise Google silently signs them straight back in next visit.
  window.google?.accounts?.id?.disableAutoSelect?.();
  await supabase?.auth.signOut();
}

/** Calls back with the session now and on every change. Returns an unsubscribe. */
export function onAuth(cb: (session: Session | null) => void): () => void {
  if (!isConfigured) {
    cb(null);
    return () => {};
  }
  supabase.auth.getSession().then(({ data }) => cb(data.session));
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

/** The public profile row, created by a trigger the moment the user is made. */
export async function fetchProfile(userId: string): Promise<OwnProfile | null> {
  if (!isConfigured) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('handle, display_name, avatar_url')
    .eq('id', userId)
    .maybeSingle<OwnProfile>();
  return error ? null : data;
}
