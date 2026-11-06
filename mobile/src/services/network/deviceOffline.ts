import * as Network from 'expo-network';

/**
 * Whether the device says it has no network. A network the phone has not
 * validated counts as none (Android reports isInternetReachable false for a
 * school Wi-Fi it could not confirm reaches the internet, iOS after its
 * path check times out). Unknown counts as online: the question only spares
 * the person a wait for a server that cannot answer, at a start
 * (AuthService) and at a sign-out (endSessionHere); it never decides who is
 * in.
 */
export async function deviceOffline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isConnected === false || state.isInternetReachable === false;
  } catch {
    return false;
  }
}

/**
 * Whether the device is joined to no network at all: strictly less than
 * deviceOffline. A network the phone has not validated is still a network the
 * gateway may be reachable through, and a roll call of an alarm is sent over
 * it at once rather than waiting for the phone to be sure (Krisläge,
 * services/crisisQueue.ts): a failed attempt costs a moment, a withheld one
 * could cost a pupil counted late. Unknown counts as joined.
 */
export async function noNetwork(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isConnected === false;
  } catch {
    return false;
  }
}
