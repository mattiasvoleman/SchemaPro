import * as Network from 'expo-network';
import { deviceOffline } from './deviceOffline';

/**
 * What the device says about its network decides only whether a start or a
 * sign-out waits for a server: no network, or one the phone has not
 * validated, is offline; anything it cannot read is online, so the server is
 * still asked.
 */
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn() }));

it.each([
  ['no network', { isConnected: false, isInternetReachable: false }, true],
  ['a network the phone has not validated (Android) or whose check timed out (iOS)', { isConnected: true, isInternetReachable: false }, true],
  ['no connection, reachability not yet known', { isConnected: false, isInternetReachable: null }, true],
  ['a validated network', { isConnected: true, isInternetReachable: true }, false],
  ['a connection whose reachability is not yet known', { isConnected: true, isInternetReachable: null }, false],
  ['a state with nothing known', {}, false],
])('%s: offline is %s', async (_case, state, offline) => {
  (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue(state);
  await expect(deviceOffline()).resolves.toBe(offline);
});

it('counts a state it cannot read as online', async () => {
  (Network.getNetworkStateAsync as jest.Mock).mockRejectedValue(new Error("Cannot find native module 'ExpoNetwork'"));
  await expect(deviceOffline()).resolves.toBe(false);
});
