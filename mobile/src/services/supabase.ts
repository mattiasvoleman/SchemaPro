import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client for the mobile app.
//
// Session persistence uses expo-secure-store exclusively (never plain
// AsyncStorage — see .cursorrules). Because SecureStore values are limited to
// ~2 KB and a Supabase session JSON is larger, values are transparently
// chunked across multiple keychain entries.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env['EXPO_PUBLIC_SUPABASE_URL'];
const SUPABASE_KEY = process.env['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];

const CHUNK_SIZE = 1800;

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function chunkKey(key: string, index: number): string {
  return `${key}__chunk_${index}`;
}

const secureChunkedStorage = {
  async getItem(key: string): Promise<string | null> {
    const manifest = await SecureStore.getItemAsync(key, STORE_OPTIONS);
    if (manifest === null) return null;

    const chunkCount = Number.parseInt(manifest, 10);
    if (Number.isNaN(chunkCount)) {
      // Legacy/plain value written before chunking existed.
      return manifest;
    }

    const chunks = await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        SecureStore.getItemAsync(chunkKey(key, i), STORE_OPTIONS),
      ),
    );
    if (chunks.some((chunk) => chunk === null)) return null;
    return chunks.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    const chunkCount = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
    await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        SecureStore.setItemAsync(
          chunkKey(key, i),
          value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
          STORE_OPTIONS,
        ),
      ),
    );
    await SecureStore.setItemAsync(key, String(chunkCount), STORE_OPTIONS);
    // Remove stale trailing chunks from a previously longer value.
    for (let i = chunkCount; i < chunkCount + 4; i++) {
      await SecureStore.deleteItemAsync(chunkKey(key, i), STORE_OPTIONS);
    }
  },

  async removeItem(key: string): Promise<void> {
    const manifest = await SecureStore.getItemAsync(key, STORE_OPTIONS);
    await SecureStore.deleteItemAsync(key, STORE_OPTIONS);
    const chunkCount = manifest === null ? 0 : Number.parseInt(manifest, 10);
    if (Number.isNaN(chunkCount)) return;
    await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        SecureStore.deleteItemAsync(chunkKey(key, i), STORE_OPTIONS),
      ),
    );
  },
};

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      '[Supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set. Check your .env.local file.',
    );
  }
  _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      storage: secureChunkedStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return _client;
}

/** Returns the current Supabase access token, or null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}
