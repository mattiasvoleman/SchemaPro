import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../../src/context/AuthContext';
import { schoolAccountsOffered } from '../../src/services/auth/schoolAccount';
import { currentApp } from '../../src/config/appIdentity';
import { useI18n } from '../../src/context/LocaleContext';
import { DISABLED_OPACITY } from '../../src/theme/tokens';
import { makeStyles, useAppTheme } from '../../src/theme/ThemeContext';
import { FORM_MAX } from '../../src/layout/responsive';

/**
 * The brand tile is the splash image itself, so the screen the splash hands
 * over to shows the same mark (scripts/render-brand-assets.mjs draws both).
 */
const BRAND_TILE = require('../../assets/images/splash-icon.png');

export default function LoginScreen(): React.JSX.Element {
  const { login, loginWithSchoolAccount, isLoading, error } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const canSubmit = email.trim().length > 0 && password.length > 0 && !isLoading;

  // "Logga in med skolkonto" needs only the address: the gateway finds the
  // school's provider from its domain, and an address without one is said
  // as SSO_NEEDS_EMAIL rather than greyed out, so the button tells the
  // reader what it wants.
  const startSchoolAccount = () => {
    loginWithSchoolAccount(email).catch(() => {
      // The code is in `error`, which the line above the buttons words.
    });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.inner}>
          {/* ── Brand ────────────────────────────────────────────────────── */}
          {/* Decorative, so hidden from screen readers: the title under it
              says the name. */}
          <Image
            source={BRAND_TILE}
            style={styles.brand}
            accessible={false}
            importantForAccessibility="no"
          />
          <Text style={styles.title}>{t('login.title')}</Text>
          <Text style={styles.subtitle}>{t(`login.subtitle.${currentApp() ?? 'rastra'}`)}</Text>

          {/* ── Form ─────────────────────────────────────────────────────── */}
          <View style={styles.form}>
            <TextInput
              style={styles.input}
              placeholder={t('login.email')}
              placeholderTextColor={colors.textMuted}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="next"
            />
            <TextInput
              style={styles.input}
              placeholder={t('login.password')}
              placeholderTextColor={colors.textMuted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (canSubmit) void login(email, password);
              }}
            />

            {error !== null && (
              <Text style={styles.errorText} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {t(`authErrors.${error}`)}
              </Text>
            )}

            <TouchableOpacity
              style={[styles.loginBtn, !canSubmit && styles.loginBtnDisabled]}
              onPress={() => { void login(email, password); }}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel={t('login.submitA11y')}
            >
              {isLoading ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.loginBtnText}>{t('login.submit')}</Text>
              )}
            </TouchableOpacity>

            {schoolAccountsOffered() ? (
              <>
                <View style={styles.divider} accessible={false} importantForAccessibility="no-hide-descendants">
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>{t('login.or')}</Text>
                  <View style={styles.dividerLine} />
                </View>

                <TouchableOpacity
                  style={[styles.schoolAccountBtn, isLoading && styles.loginBtnDisabled]}
                  onPress={startSchoolAccount}
                  disabled={isLoading}
                  accessibilityRole="button"
                  accessibilityLabel={t('login.schoolAccountA11y')}
                  accessibilityState={{ disabled: isLoading }}
                >
                  <Text style={styles.schoolAccountText}>{t('login.schoolAccount')}</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>

          <Text style={styles.disclaimer}>{t('login.disclaimer')}</Text>

          {/* The language before anything else: a reader who does not read
              Swedish must be able to find the switch without reading Swedish. */}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void setLocale(locale === 'sv' ? 'en' : 'sv')}
            style={styles.languageBtn}
          >
            <Text style={styles.languageText}>{t('login.otherLanguage')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles((c) => ({
  container: {
    flex: 1,
    backgroundColor: c.background,
  },
  // Scrolls when it does not fit: a short Stage Manager window, an iPad on
  // its side with the keyboard up.
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  inner: {
    width: '100%',
    maxWidth: FORM_MAX + 56,
    alignSelf: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingVertical: 40,
  },
  brand: {
    width: 72,
    height: 72,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: c.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: c.textMuted,
    marginBottom: 40,
  },
  form: {
    width: '100%',
    maxWidth: FORM_MAX,
    gap: 12,
  },
  input: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: c.text,
  },
  errorText: {
    fontSize: 13,
    color: c.danger,
    textAlign: 'center',
  },
  loginBtn: {
    backgroundColor: c.primary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  loginBtnDisabled: {
    opacity: DISABLED_OPACITY,
  },
  loginBtnText: {
    color: c.onPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: c.border,
  },
  dividerText: {
    fontSize: 13,
    color: c.textMuted,
  },
  schoolAccountBtn: {
    borderWidth: 1,
    borderColor: c.primary,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  schoolAccountText: {
    color: c.text,
    fontSize: 16,
    fontWeight: '700',
  },
  disclaimer: {
    marginTop: 32,
    fontSize: 12,
    color: c.textMuted,
    textAlign: 'center',
    maxWidth: FORM_MAX,
  },
  languageBtn: {
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  languageText: {
    fontSize: 13,
    color: c.primary,
    fontWeight: '600',
  },
}));
