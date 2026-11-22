// Teaching profile screen (plan luyen-tap-graph.md A2, phase 3 step 11). The default profile is
// read-only; "Duplicate" makes an editable copy with an id of its own, "Back to default" drops it.
// Validation is `SavedProfile` itself (the limits the server and the local DB check), shown with
// messages of our own per field.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import {
  MAX_PROBE_QUESTIONS,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_TURNS_PER_STEP,
  SavedProfile,
  type FigureSettings,
  type PromptKey,
  type ResolvedProfile,
} from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import { useForm } from '@tanstack/react-form';
import { Schema } from 'effect';
import { useState } from 'react';
import { errorText } from '../account/api';
import type { ProfileSource } from './source';
import { Block } from '../app/Block';
import { pageWidth } from '../app/page';

const PROMPT_KEYS: ReadonlyArray<PromptKey> = [
  'prober',
  'teacher',
  'sideChat',
  'practitioner',
  'extractor',
  'auditor',
  'merge',
  'researchQueries',
  'researchSummary',
];

const promptLabel = (key: PromptKey) => {
  switch (key) {
    case 'prober':
      return m.profile_prompt_prober();
    case 'teacher':
      return m.profile_prompt_teacher();
    case 'sideChat':
      return m.profile_prompt_sideChat();
    case 'practitioner':
      return m.profile_prompt_practitioner();
    case 'extractor':
      return m.profile_prompt_extractor();
    case 'auditor':
      return m.profile_prompt_auditor();
    case 'merge':
      return m.profile_prompt_merge();
    case 'researchQueries':
      return m.profile_prompt_researchQueries();
    case 'researchSummary':
      return m.profile_prompt_researchSummary();
  }
};

/** What the form edits: every prompt filled in, the name as text (blank means none). */
interface ProfileForm {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly maxProbeQuestions: number;
  readonly maxTurnsPerStep: number;
  readonly figures: FigureSettings;
  readonly prompts: Record<PromptKey, string>;
}

const FIGURE_KINDS = ['diagrams', 'demos', 'images'] as const;
const figureLabel = (kind: (typeof FIGURE_KINDS)[number]) =>
  kind === 'diagrams'
    ? m.profile_figures_diagrams()
    : kind === 'demos'
      ? m.profile_figures_demos()
      : m.profile_figures_images();

const toForm = (profile: ResolvedProfile): ProfileForm => ({
  id: profile.id,
  name: profile.name,
  language: profile.language,
  maxProbeQuestions: profile.maxProbeQuestions,
  maxTurnsPerStep: profile.maxTurnsPerStep,
  figures: { ...profile.figures },
  prompts: { ...profile.prompts },
});

const toSaved = (form: ProfileForm): SavedProfile => {
  const name = form.name.trim();
  return {
    id: form.id,
    ...(name === '' ? {} : { name }),
    language: form.language.trim(),
    maxProbeQuestions: form.maxProbeQuestions,
    maxTurnsPerStep: form.maxTurnsPerStep,
    figures: form.figures,
    prompts: form.prompts,
  };
};

const standard = Schema.toStandardSchemaV1(SavedProfile, { parseOptions: { errors: 'all' } });

/** Our message for a field the schema rejects, by its path in the form. */
const messageFor = (path: string): string => {
  if (path === 'name') return m.profile_error_name({ max: MAX_PROFILE_NAME_LENGTH });
  if (path === 'language') return m.profile_error_language();
  if (path === 'maxProbeQuestions') return m.profile_error_range({ max: MAX_PROBE_QUESTIONS });
  if (path === 'maxTurnsPerStep') return m.profile_error_range({ max: MAX_TURNS_PER_STEP });
  return m.profile_error_prompt({ max: MAX_PROMPT_LENGTH });
};

/** Field errors of a form value, keyed by path (`prompts.teacher`). Empty when it can be saved. */
export function validateProfile(form: ProfileForm): Record<string, string> {
  const result = standard['~standard'].validate(toSaved(form));
  if (result instanceof Promise || result.issues === undefined) return {};
  const fields: Record<string, string> = {};
  for (const issue of result.issues) {
    const path = (issue.path ?? [])
      .map((part) => String(typeof part === 'object' ? part.key : part))
      .join('.');
    fields[path] ??= messageFor(path);
  }
  return fields;
}

const newProfileId = () => crypto.randomUUID();

export function ProfileScreen({ source }: { source: ProfileSource }) {
  const { view } = source;
  const [draft, setDraft] = useState<ProfileForm | undefined>(undefined);
  const [message, setMessage] = useState<{ status: 'success' | 'error'; text: string }>();

  // A copy not saved yet. Once the store holds it, the saved profile is what the form edits.
  const editing =
    draft !== undefined && view.status === 'ready' && view.saved && view.profile.id === draft.id
      ? undefined
      : draft;

  const reset = async () => {
    try {
      await source.reset();
      setDraft(undefined);
      setMessage({ status: 'success', text: m.profile_reset_done() });
    } catch (cause) {
      setMessage({ status: 'error', text: m.profile_save_failed({ reason: errorText(cause) }) });
    }
  };

  return (
    <Layout
      contentWidth={pageWidth}
      content={
        <LayoutContent padding={6}>
          <VStack gap={5} maxWidth="80ch">
            <Heading level={2}>{m.profile_title()}</Heading>
            {view.status === 'loading' ? <Spinner size="sm" label={m.learn_loading()} /> : null}
            {view.status === 'error' ? (
              <Banner status="error" title={m.account_load_failed({ reason: view.message })} />
            ) : null}
            {message === undefined ? null : (
              <Banner status={message.status} title={message.text} data-testid="profile-message" />
            )}
            {view.status !== 'ready' ? null : editing === undefined && !view.saved ? (
              <>
                <Text>{m.profile_default_intro()}</Text>
                <HStack gap={2}>
                  <Button
                    label={m.profile_duplicate()}
                    variant="primary"
                    onClick={() => {
                      setMessage(undefined);
                      setDraft({
                        ...toForm(view.profile),
                        id: newProfileId(),
                        name: m.profile_copy_name({ name: view.profile.name }),
                      });
                    }}
                    data-testid="profile-duplicate"
                  />
                </HStack>
                <Block>
                  <ProfileFields value={toForm(view.profile)} isReadOnly />
                </Block>
              </>
            ) : (
              <>
                <Text>{m.profile_custom_intro()}</Text>
                <Block>
                  <ProfileEditor
                    // A new copy, a save from elsewhere or a reset starts the form again.
                    key={editing?.id ?? view.profile.id}
                    initial={editing ?? toForm(view.profile)}
                    isNew={editing !== undefined}
                    onSave={async (value) => {
                      try {
                        // The draft stays until the store shows it saved, so nothing flickers.
                        await source.save(toSaved(value));
                        setMessage({ status: 'success', text: m.profile_saved() });
                      } catch (cause) {
                        setMessage({
                          status: 'error',
                          text: m.profile_save_failed({ reason: errorText(cause) }),
                        });
                      }
                    }}
                    onCancel={() => {
                      setDraft(undefined);
                      setMessage(undefined);
                    }}
                    onReset={view.saved ? () => void reset() : undefined}
                  />
                </Block>
              </>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function ProfileEditor({
  initial,
  isNew,
  onSave,
  onCancel,
  onReset,
}: {
  initial: ProfileForm;
  isNew: boolean;
  onSave: (value: ProfileForm) => Promise<void>;
  onCancel: () => void;
  onReset: (() => void) | undefined;
}) {
  // Text a number field rejected (`abc`, `2.5`) never reaches the form: block saving on it too.
  const [entryErrors, setEntryErrors] = useState<ReadonlySet<string>>(new Set());
  const setEntryError = (name: string, isError: boolean) =>
    setEntryErrors((current) => {
      const next = new Set(current);
      if (isError) next.add(name);
      else next.delete(name);
      return next;
    });
  const hasEntryError = entryErrors.size > 0;

  const form = useForm({
    defaultValues: initial,
    validators: {
      onChange: ({ value }) => {
        const fields = validateProfile(value);
        return Object.keys(fields).length === 0 ? undefined : { form: m.profile_invalid(), fields };
      },
    },
    onSubmit: ({ value }) => onSave(value),
  });

  const errorOf = (errors: ReadonlyArray<unknown>) => {
    const first = errors.find((error) => typeof error === 'string');
    return first === undefined ? {} : { status: { type: 'error' as const, message: first } };
  };

  return (
    <VStack gap={5}>
      <form.Field name="name">
        {(field) => (
          <TextInput
            label={m.profile_name()}
            value={field.state.value}
            onChange={field.handleChange}
            {...errorOf(field.state.meta.errors)}
            data-testid="profile-name"
          />
        )}
      </form.Field>
      <form.Field name="language">
        {(field) => (
          <TextInput
            label={m.profile_language()}
            description={m.profile_language_description()}
            value={field.state.value}
            onChange={field.handleChange}
            autoComplete="off"
            hasSpellCheck={false}
            {...errorOf(field.state.meta.errors)}
            data-testid="profile-language"
          />
        )}
      </form.Field>
      <form.Field name="maxProbeQuestions">
        {(field) => (
          <NumberInput
            label={m.profile_max_probe()}
            description={m.profile_max_probe_description()}
            value={field.state.value}
            onChange={field.handleChange}
            min={1}
            max={MAX_PROBE_QUESTIONS}
            isIntegerOnly
            onEntryErrorChange={(error) => setEntryError(field.name, error !== null)}
            {...errorOf(field.state.meta.errors)}
            data-testid="profile-max-probe"
          />
        )}
      </form.Field>
      <form.Field name="maxTurnsPerStep">
        {(field) => (
          <NumberInput
            label={m.profile_max_turns()}
            description={m.profile_max_turns_description()}
            value={field.state.value}
            onChange={field.handleChange}
            min={1}
            max={MAX_TURNS_PER_STEP}
            isIntegerOnly
            onEntryErrorChange={(error) => setEntryError(field.name, error !== null)}
            {...errorOf(field.state.meta.errors)}
            data-testid="profile-max-turns"
          />
        )}
      </form.Field>
      <Heading level={3}>{m.profile_figures()}</Heading>
      <Text type="supporting">{m.profile_figures_description()}</Text>
      {FIGURE_KINDS.map((kind) => (
        <form.Field key={kind} name={`figures.${kind}`}>
          {(field) => (
            <Switch
              label={figureLabel(kind)}
              value={field.state.value}
              onChange={(checked) => field.handleChange(checked)}
              data-testid={`profile-figures-${kind}`}
            />
          )}
        </form.Field>
      ))}
      <Heading level={3}>{m.profile_prompts()}</Heading>
      {PROMPT_KEYS.map((key) => (
        <form.Field key={key} name={`prompts.${key}`}>
          {(field) => (
            <TextArea
              label={promptLabel(key)}
              value={field.state.value}
              onChange={field.handleChange}
              rows={8}
              maxLength={MAX_PROMPT_LENGTH}
              {...errorOf(field.state.meta.errors)}
              data-testid={`profile-prompt-${key}`}
            />
          )}
        </form.Field>
      ))}
      <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
        {([canSubmit, isSubmitting]) => (
          <VStack gap={3}>
            {canSubmit && !hasEntryError ? null : (
              <Banner status="error" title={m.profile_invalid()} data-testid="profile-invalid" />
            )}
            <HStack gap={2} wrap="wrap">
              <Button
                label={m.profile_save()}
                variant="primary"
                isDisabled={!canSubmit || hasEntryError}
                isLoading={isSubmitting}
                onClick={() => void form.handleSubmit()}
                data-testid="profile-save"
              />
              {isNew ? (
                <Button
                  label={m.profile_cancel()}
                  variant="ghost"
                  onClick={onCancel}
                  data-testid="profile-cancel"
                />
              ) : null}
              {onReset === undefined ? null : (
                <Button
                  label={m.profile_reset()}
                  variant="destructive"
                  onClick={onReset}
                  data-testid="profile-reset"
                />
              )}
            </HStack>
          </VStack>
        )}
      </form.Subscribe>
    </VStack>
  );
}

/** The default profile, read-only. */
function ProfileFields({ value, isReadOnly }: { value: ProfileForm; isReadOnly: true }) {
  return (
    <VStack gap={5}>
      <TextInput label={m.profile_name()} value={value.name} isReadOnly={isReadOnly} />
      <TextInput label={m.profile_language()} value={value.language} isReadOnly={isReadOnly} />
      <NumberInput
        label={m.profile_max_probe()}
        value={value.maxProbeQuestions}
        onChange={() => undefined}
        isReadOnly={isReadOnly}
      />
      <NumberInput
        label={m.profile_max_turns()}
        value={value.maxTurnsPerStep}
        onChange={() => undefined}
        isReadOnly={isReadOnly}
      />
      <Heading level={3}>{m.profile_figures()}</Heading>
      {FIGURE_KINDS.map((kind) => (
        <Switch
          key={kind}
          label={figureLabel(kind)}
          value={value.figures[kind]}
          onChange={() => undefined}
          isDisabled
        />
      ))}
      <Heading level={3}>{m.profile_prompts()}</Heading>
      {PROMPT_KEYS.map((key) => (
        <TextArea
          key={key}
          label={promptLabel(key)}
          value={value.prompts[key]}
          rows={8}
          isReadOnly={isReadOnly}
          data-testid={`profile-default-prompt-${key}`}
        />
      ))}
    </VStack>
  );
}
