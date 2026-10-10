import { IsIn, Matches } from 'class-validator';

/** Expo's token format, as the CHECK DevicePushTokens_token_is_an_expo_token says it. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

/** POST /api/v1/devices. Mirrors the CHECKs of 20261013110000. */
export class RegisterDeviceDto {
  @Matches(EXPO_PUSH_TOKEN, { message: 'token: en push-token från Expo.' })
  token!: string;

  @IsIn(['IOS', 'ANDROID'], { message: "platform: 'IOS' eller 'ANDROID'." })
  platform!: 'IOS' | 'ANDROID';

  @IsIn(['sv', 'en'], { message: "locale: 'sv' eller 'en'." })
  locale!: 'sv' | 'en';
}

/**
 * POST /api/v1/devices/unregister and /devices/release. A POST with a body,
 * so a token never sits in a URL or an access log.
 */
export class DeviceTokenDto {
  @Matches(EXPO_PUSH_TOKEN, { message: 'token: en push-token från Expo.' })
  token!: string;
}
