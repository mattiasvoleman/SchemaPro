import { useCallback, useState } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';

export interface BiometricCapability {
  readonly isAvailable: boolean;
  readonly supportedTypes: LocalAuthentication.AuthenticationType[];
}

interface UseBiometricsReturn {
  readonly isAuthenticating: boolean;
  readonly checkCapability: () => Promise<BiometricCapability>;
  /**
   * Prompts the user with a biometric challenge.
   * Returns `true` if verified, `false` on failure/cancel.
   * This MUST be called immediately before any sensitive write action
   * (submitting or altering an attendance report).
   */
  readonly authenticate: (reason: string) => Promise<boolean>;
}

/**
 * Thin wrapper around expo-local-authentication.
 * Device passcode fallback is always allowed so teachers are not
 * blocked if biometrics are temporarily unavailable.
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
    async (reason: string): Promise<boolean> => {
      setIsAuthenticating(true);
      try {
        const capability = await checkCapability();

        if (!capability.isAvailable) {
          console.warn('[Biometrics] No enrolled biometrics — cannot verify teacher identity.');
          return false;
        }

        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: reason,
          fallbackLabel: 'Use Passcode',
          cancelLabel: 'Cancel',
          disableDeviceFallback: false,
        });

        if (!result.success) {
          console.warn(`[Biometrics] Verification failed: ${result.error}`);
        }

        return result.success;
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
