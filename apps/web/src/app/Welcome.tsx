// The mode chooser (plan 2.2): guest with an own key, the demo on the server's key, or an account.
// Only the entries this server offers are shown (`GET /api/config`).
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { PublicConfig } from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import { useNavigate } from '@tanstack/react-router';
import { chooseLocalMode } from '../account/auth';
import { AppHeader } from './AppHeader';
import { pageWidth } from './page';

export function Welcome({ config }: { config: PublicConfig }) {
  const navigate = useNavigate();
  return (
    <Layout
      contentWidth={pageWidth}
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          <VStack gap={5} maxWidth="68ch" data-testid="welcome">
            <Text type="large" color="secondary">
              {m.app_tagline()}
            </Text>
            <Heading level={2}>{m.welcome_title()}</Heading>
            {config.accounts ? (
              <Card padding={6} elevation="low">
                <VStack gap={2}>
                  <Heading level={3}>{m.welcome_account_title()}</Heading>
                  <Text type="supporting">{m.welcome_account_body()}</Text>
                  <HStack gap={2} wrap="wrap">
                    <Button
                      label={m.auth_login()}
                      variant="primary"
                      onClick={() => void navigate({ to: '/login' })}
                      data-testid="choose-login"
                    />
                    {config.registration === 'closed' ? null : (
                      <Button
                        label={m.auth_register()}
                        onClick={() => void navigate({ to: '/register' })}
                        data-testid="choose-register"
                      />
                    )}
                  </HStack>
                </VStack>
              </Card>
            ) : null}
            {config.guestMode ? (
              <Card padding={6} elevation="low">
                <VStack gap={2}>
                  <Heading level={3}>{m.welcome_guest_title()}</Heading>
                  <Text type="supporting">{m.welcome_guest_body()}</Text>
                  <HStack>
                    <Button
                      label={m.welcome_guest_action()}
                      onClick={() => chooseLocalMode('guest')}
                      data-testid="choose-guest"
                    />
                  </HStack>
                </VStack>
              </Card>
            ) : null}
            {config.demoMode ? (
              <Card padding={6} elevation="low">
                <VStack gap={2}>
                  <Heading level={3}>{m.welcome_demo_title()}</Heading>
                  <Text type="supporting">{m.welcome_demo_body()}</Text>
                  <HStack>
                    <Button
                      label={m.welcome_demo_action()}
                      onClick={() => chooseLocalMode('demo')}
                      data-testid="choose-demo"
                    />
                  </HStack>
                </VStack>
              </Card>
            ) : null}
            {!config.accounts && !config.guestMode && !config.demoMode ? (
              <Text type="supporting">{m.welcome_nothing()}</Text>
            ) : null}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
