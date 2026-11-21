// Sign-in and registration (plan tai-khoan.md A4). Registration follows the admin switch: open,
// invite code required, or closed (plan A7).
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { accountClient } from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { clientOptions, errorCode, errorText, run, usePublicConfig } from './api';
import { signIn, useWho } from './auth';

const authErrorText = (error: unknown): string => {
  switch (errorCode(error)) {
    case 'InvalidCredentials':
      return m.auth_error_InvalidCredentials();
    case 'TooManyAttempts':
      return m.auth_error_TooManyAttempts();
    case 'AccountDisabled':
      return m.auth_error_AccountDisabled();
    case 'RegistrationClosed':
      return m.auth_error_RegistrationClosed();
    case 'InvalidInvite':
      return m.auth_error_InvalidInvite();
    case 'EmailTaken':
      return m.auth_error_EmailTaken();
    case 'InvalidRequest':
      return m.auth_error_InvalidRequest();
    default:
      return m.error_generic({ message: errorText(error) });
  }
};

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const navigate = useNavigate();
  const config = usePublicConfig();
  // The form appears once the page is interactive: typing into server-rendered fields before
  // hydration would be lost.
  const hydrated = useWho().status !== 'unknown';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const registration = config.data?.registration;
  const closed = mode === 'register' && registration === 'closed';
  const needsInvite = mode === 'register' && registration === 'invite';

  const submit = async () => {
    if (busy || closed) return;
    if (mode === 'register' && password.length < 8) {
      setError(m.auth_password_short());
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const api = accountClient(clientOptions());
      const input = { email: email.trim(), password };
      const answer = await run(
        mode === 'login'
          ? api.login(input)
          : api.register(invite.trim() === '' ? input : { ...input, inviteCode: invite.trim() }),
      );
      signIn(answer.token, answer.user, answer.expiresAt);
      await navigate({ to: '/' });
    } catch (cause) {
      setError(authErrorText(cause));
      setBusy(false);
    }
  };

  return (
    <Layout
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          <VStack gap={5} maxWidth="44ch">
            <Heading level={2}>
              {mode === 'login' ? m.auth_login_title() : m.auth_register_title()}
            </Heading>
            {config.isPending || !hydrated ? <Spinner size="sm" label={m.learn_loading()} /> : null}
            {config.data !== undefined && !config.data.accounts ? (
              <Banner status="info" title={m.auth_no_accounts()} data-testid="no-accounts" />
            ) : null}
            {!hydrated ? null : closed ? (
              <Banner status="info" title={m.auth_error_RegistrationClosed()} />
            ) : (
              <VStack gap={3}>
                <TextInput
                  label={m.auth_email()}
                  type="email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                  hasSpellCheck={false}
                  data-testid="auth-email"
                />
                <TextInput
                  label={m.auth_password()}
                  type="password"
                  value={password}
                  onChange={setPassword}
                  onEnter={() => void submit()}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  {...(mode === 'register' ? { description: m.auth_password_hint() } : {})}
                  data-testid="auth-password"
                />
                {needsInvite ? (
                  <TextInput
                    label={m.auth_invite()}
                    description={m.auth_invite_hint()}
                    value={invite}
                    onChange={setInvite}
                    autoComplete="off"
                    hasSpellCheck={false}
                    data-testid="auth-invite"
                  />
                ) : null}
                {error === undefined ? null : (
                  <Banner status="error" title={error} data-testid="auth-error" />
                )}
                <Button
                  label={mode === 'login' ? m.auth_login() : m.auth_register()}
                  variant="primary"
                  isLoading={busy}
                  isDisabled={email.trim() === '' || password === ''}
                  onClick={() => void submit()}
                  data-testid="auth-submit"
                />
              </VStack>
            )}
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="supporting">
                {mode === 'login' ? m.auth_no_account() : m.auth_have_account()}
              </Text>
              <Button
                label={mode === 'login' ? m.auth_register() : m.auth_login()}
                variant="ghost"
                size="sm"
                onClick={() => void navigate({ to: mode === 'login' ? '/register' : '/login' })}
                data-testid="auth-switch"
              />
            </HStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
