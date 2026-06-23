import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as Network from 'expo-network';
import type { NetworkState } from '../types';

interface NetworkContextValue {
  readonly networkState: NetworkState;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

// expo-network does not provide a subscription API, so we poll.
const POLL_INTERVAL_MS = 5_000;

/**
 * Provides real-time network state to the tree.
 * Components should read from this context (not call Network.* directly)
 * to avoid duplicating polling overhead.
 */
export function NetworkProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [networkState, setNetworkState] = useState<NetworkState>({
    isConnected: true,
    isInternetReachable: true,
  });

  useEffect(() => {
    async function check(): Promise<void> {
      const state = await Network.getNetworkStateAsync();
      setNetworkState({
        isConnected: state.isConnected ?? false,
        isInternetReachable: state.isInternetReachable ?? false,
      });
    }

    void check();
    const id = setInterval(() => { void check(); }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <NetworkContext.Provider value={{ networkState }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork must be used inside <NetworkProvider>');
  return ctx;
}
