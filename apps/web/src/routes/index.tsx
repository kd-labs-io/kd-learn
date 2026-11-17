import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Popover } from '@astryxdesign/core/Popover';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import { getLocale, locales, m, setLocale } from '@kd-learn/i18n';
import { LessonText } from '@kd-learn/ui/components/LessonText';
import { checkContrast, decodeTheme, defaultTheme } from '@kd-learn/tokens';
import { createFileRoute } from '@tanstack/react-router';
import { Result } from 'effect';
import { useState } from 'react';
import { useThemeControl } from '../theme/ThemeRoot';

export const Route = createFileRoute('/')({ component: Home });

// A sample theme to try runtime switching (UI spike, plan phase 0).
const sampleTheme = {
  ...defaultTheme,
  name: 'forest',
  colors: {
    ...defaultTheme.colors,
    bg: '#F3F7F2',
    surface: '#EDF3EB',
    border: '#C9D8C5',
    accent: '#5E9A62',
    'accent-strong': '#2F6B3A',
    'focus-ring': '#2F6B3A',
  },
  radius: { sm: 2, md: 4, lg: 6 },
};

function Home() {
  const { override, setOverride } = useThemeControl();
  const [source, setSource] = useState(() => JSON.stringify(sampleTheme, null, 2));
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    let json: unknown;
    try {
      json = JSON.parse(source);
    } catch {
      setError(m.theme_invalid({ reason: 'JSON' }));
      return;
    }
    const decoded = decodeTheme(json);
    if (Result.isFailure(decoded)) {
      setError(m.theme_invalid({ reason: String(decoded.failure) }));
      return;
    }
    const issues = checkContrast(decoded.success);
    if (issues.length > 0) {
      const list = issues.map((i) => `${i.foreground}/${i.background} ${i.ratio.toFixed(2)}`);
      setError(m.theme_invalid({ reason: `WCAG AA: ${list.join(', ')}` }));
      return;
    }
    setError(null);
    setOverride(decoded.success);
  };

  return (
    <VStack gap={6} padding={6} maxWidth="68ch">
      <VStack gap={2}>
        <Heading level={1}>{m.app_name()}</Heading>
        <Text type="large" color="secondary">
          {m.app_tagline()}
        </Text>
        <HStack gap={2}>
          <Text type="supporting">{m.locale_label()}:</Text>
          {locales.map((locale) => (
            <Button
              key={locale}
              size="sm"
              label={locale.toUpperCase()}
              variant={locale === getLocale() ? 'primary' : 'ghost'}
              onClick={() => setLocale(locale)}
            />
          ))}
        </HStack>
      </VStack>

      <LessonText variant="callout">
        Mỗi bước dạy hiển thị bằng LessonText: component riêng của kd-learn viết bằng StyleX, dùng
        token của Astryx nên đổi theme là đổi theo.
      </LessonText>

      <Card padding={6} elevation="low">
        <VStack gap={4}>
          <Heading level={2}>Theme: {override?.name ?? 'kd'}</Heading>
          <HStack gap={3}>
            <Button label="Primary" variant="primary" />
            <Button label="Secondary" variant="secondary" />
            <Button label="Ghost" variant="ghost" />
            <Popover label="Popover" content={<Text>Lớp nổi dùng cùng theme.</Text>}>
              <Button label="Popover" variant="secondary" />
            </Popover>
          </HStack>
          <Banner status="success" title="Đã lưu" description="Trạng thái thành công." />
        </VStack>
      </Card>

      <Card padding={6}>
        <VStack gap={4}>
          <TextArea
            isOptional
            label="Theme JSON"
            value={source}
            onChange={(value) => setSource(value)}
          />
          {error ? <Banner status="error" title={error} /> : null}
          <HStack gap={3}>
            <Button label={m.theme_apply()} variant="primary" onClick={apply} />
            <Button label={m.theme_reset()} variant="secondary" onClick={() => setOverride(null)} />
          </HStack>
        </VStack>
      </Card>
    </VStack>
  );
}
