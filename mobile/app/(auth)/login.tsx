import React, { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../../src/context/AuthContext';
import { schoolAccountsOffered } from '../../src/services/auth/schoolAccount';
import { useI18n } from '../../src/context/LocaleContext';

/**
 * The brand tile is the splash image itself, so the screen the splash hands
 * over to shows the same mark (scripts/render-brand-assets.mjs draws both).
 */
const BRAND_TILE = require('../../assets/images/splash-icon.png');

export default function LoginScreen(): React.JSX.Element {
  const { login, loginWithSchoolAccount, isLoading, error } = useAuth();
  const { t, locale, setLocale } = useI18n();
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
        <Text style={styles.subtitle}>{t('login.subtitle')}</Text>

        {/* ── Form ─────────────────────────────────────────────────────── */}
        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder={t('login.email')}
            placeholderTextColor="#475569"
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
            placeholderTextColor="#475569"
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
              <ActivityIndicator color="#fff" />
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingBottom: 40,
  },
  brand: {
    width: 72,
    height: 72,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#e2e8f0',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 40,
  },
  form: {
    width: '100%',
    gap: 12,
  },
  input: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#2d2d4a',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: '#e2e8f0',
  },
  errorText: {
    fontSize: 13,
    color: '#f87171',
    textAlign: 'center',
  },
  loginBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  loginBtnDisabled: {
    opacity: 0.45,
  },
  loginBtnText: {
    color: '#fff',
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
    backgroundColor: '#2d2d4a',
  },
  dividerText: {
    fontSize: 13,
    color: '#94a3b8',
  },
  schoolAccountBtn: {
    borderWidth: 1,
    borderColor: '#6366f1',
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  schoolAccountText: {
    color: '#e2e8f0',
    fontSize: 16,
    fontWeight: '700',
  },
  disclaimer: {
    marginTop: 32,
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
  },
  languageBtn: {
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  languageText: {
    fontSize: 13,
    color: '#6366f1',
    fontWeight: '600',
  },
});
