import { useCallback, useState } from 'react';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

export interface BiometricPrompt {
  /** Why the OS is asking, shown in its dialog. */
  readonly reason: string;
  /** The dialog's cancel button. */
  readonly cancelLabel: string;
}

export interface BiometricCapability {
  readonly isAvailable: boolean;
  readonly supportedTypes: LocalAuthentication.AuthenticationType[];
}

interface UseBiometricsReturn {
  readonly isAuthenticating: boolean;
  readonly checkCapability: () => Promise<BiometricCapability>;
  /**
   * Enforces a biometric challenge that is bound to the OS keychain.
   * Returns `true` only if verified, `false` on failure/cancel.
   * MUST be called immediately before any sensitive write action
   * (submitting or altering an attendance report).
   *
   * The prompt's words come from the caller, in the reader's language: this
   * hook has no catalogue of its own.
   */
  readonly authenticate: (prompt: BiometricPrompt) => Promise<boolean>;
}

// A device-local secret stored behind the keychain's own biometric gate
// (`requireAuthentication: true`). Reading it forces the OS to perform a
// biometric check and release the value only on success — so unlike a bare
// `LocalAuthentication.authenticateAsync()` boolean, this cannot be spoofed by
// hooking/patching the JS layer: without a genuine biometric unlock the OS
// never returns the secret and the gate fails closed.
const BIOMETRIC_GATE_KEY = 'sp_biometric_gate';

const GATE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: true,
};

/**
 * Biometric gate for sensitive attendance writes.
 *
 * Security model: `disableDeviceFallback: true` makes this biometric-only (a
 * device passcode does NOT satisfy it), and the challenge is enforced at the OS
 * keychain layer via a `requireAuthentication` secret rather than trusting a
 * client-side boolean.
 *
 * NOTE: this remains a client/device-side control. The server still authorizes
 * every write via the JWT + RLS (a teacher may only write attendance for
 * lessons they are assigned to). Full server-verified biometric attestation
 * would additionally require per-device key enrollment; see docs/SECURITY_AUDIT.md.
 */
export function useBiometrics(): UseBiometricsReturn {
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const checkCapability = useCallback(async (): Promise<BiometricCapability> => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (!hasHardware || !isEnrolled) {
      return { isAvailable: false, supportedTypes: [] };
    }

    const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return { isAvailable: true, supportedTypes };
  }, []);

  const authenticate = useCallback(
    async ({ reason, cancelLabel }: BiometricPrompt): Promise<boolean> => {
      setIsAuthenticating(true);
      try {
        const capability = await checkCapability();

        if (!capability.isAvailable) {
          console.warn('[Biometrics] No enrolled biometrics — cannot verify teacher identity.');
          return false;
        }

        // 1) Explicit biometric-only challenge (clear prompt + intent).
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: reason,
          cancelLabel,
          disableDeviceFallback: true,
        });
        if (!result.success) {
          console.warn(`[Biometrics] Verification failed: ${result.error}`);
          return false;
        }

        // 2) OS-keychain-enforced gate: retrieving this secret requires a real
        //    biometric unlock, so a spoofed step (1) cannot bypass it.
        await ensureGateSecret(reason);
        const secret = await SecureStore.getItemAsync(BIOMETRIC_GATE_KEY, {
          ...GATE_STORE_OPTIONS,
          authenticationPrompt: reason,
        });
        return typeof secret === 'string' && secret.length > 0;
      } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        console.error(`[Biometrics] Unexpected error (${name})`);
        return false;
      } finally {
        setIsAuthenticating(false);
      }
    },
    [checkCapability],
  );

  return { isAuthenticating, checkCapability, authenticate };
}

/**
 * Ensures the keychain gate secret exists. Created once per install with a
 * random value; the value itself is never used, only its retrievability behind
 * the biometric gate matters.
 */
async function ensureGateSecret(reason: string): Promise<void> {
  try {
    const existing = await SecureStore.getItemAsync(BIOMETRIC_GATE_KEY, {
      ...GATE_STORE_OPTIONS,
      authenticationPrompt: reason,
    });
    if (existing) return;
  } catch {
    // Not yet created (or unreadable) — (re)create it below.
  }
  const bytes = await Crypto.getRandomBytesAsync(32);
  const value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(BIOMETRIC_GATE_KEY, value, GATE_STORE_OPTIONS);
}
