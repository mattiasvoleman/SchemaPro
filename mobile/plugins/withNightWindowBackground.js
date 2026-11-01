const { AndroidConfig, withAndroidColors, withAndroidColorsNight } = require('expo/config-plugins');

/**
 * Android opens every window on the colour resource activityBackground (the
 * app theme's android:windowBackground, which expo-system-ui writes from
 * app.json's one backgroundColor) until React has drawn over it. Unlike iOS,
 * expo-system-ui on Android never reads back the colour the theme set last
 * time, so with one value a light phone showed the navy page wherever the
 * window was bare, as when the activity is made anew (a font-size or
 * language change) and React has not drawn again yet. This gives the resource
 * the light page in values/colors.xml and the dark page in
 * values-night/colors.xml, so the window follows the phone's appearance as the
 * splash does.
 *
 * The two page colours are this plugin's options in app.json, beside the
 * splash's, and theme/nativeColours.test.ts keeps them equal to the palette's
 * backgrounds. A plugin listed in app.json runs after expo-system-ui's own, so
 * its value is the one written.
 */
const NAME = 'activityBackground';
const HEX = /^#[0-9a-f]{6}$/i;

/** @type {import('expo/config-plugins').ConfigPlugin<{ light: string; dark: string }>} */
const withNightWindowBackground = (config, pages) => {
  const { light, dark } = pages ?? {};
  if (!HEX.test(light ?? '') || !HEX.test(dark ?? '')) {
    throw new Error('withNightWindowBackground takes { light, dark }, the page colour of each appearance as #rrggbb.');
  }
  config = withAndroidColors(config, (mod) => {
    mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name: NAME, value: light });
    return mod;
  });
  return withAndroidColorsNight(config, (mod) => {
    mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name: NAME, value: dark });
    return mod;
  });
};

module.exports = withNightWindowBackground;
