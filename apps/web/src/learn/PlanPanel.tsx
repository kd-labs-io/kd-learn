import { Heading } from '@astryxdesign/core/Heading';
import { Item } from '@astryxdesign/core/Item';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import type { Session } from '@kd-learn/core';
import { planRows, type StepStatus } from './view';

const statusLabel = (status: StepStatus): string =>
  status === 'done'
    ? m.plan_status_done()
    : status === 'skipped'
      ? m.plan_status_skipped()
      : status === 'current'
        ? m.plan_status_current()
        : m.plan_status_waiting();

/** The steps of the plan with the current one marked; before there is a plan, what the tutor is doing. */
export function PlanPanel({ session }: { session: Session }) {
  const rows = planRows(session);
  const resolved = session.completedSteps.length + session.skippedSteps.length;
  return (
    <VStack gap={3} data-testid="plan-panel">
      <Heading level={4} accessibilityLevel={2}>
        {m.plan_title()}
      </Heading>
      {rows.length === 0 ? (
        <Text type="supporting" data-testid="plan-phase">
          {session.state._tag === 'Planning' ? m.plan_phase_planning() : m.plan_phase_probing()}
        </Text>
      ) : (
        <>
          <Text type="supporting">{m.plan_progress({ done: resolved, total: rows.length })}</Text>
          <VStack gap={1} as="ol" data-testid="plan-steps">
            {rows.map(({ node, status }) => (
              <Item
                as="li"
                key={node.id}
                label={node.title}
                description={node.goal}
                isSelected={status === 'current'}
                endContent={
                  <Text type="supporting" color={status === 'current' ? 'accent' : 'secondary'}>
                    {statusLabel(status)}
                  </Text>
                }
                data-testid={`plan-step-${node.id}`}
                data-status={status}
              />
            ))}
          </VStack>
        </>
      )}
    </VStack>
  );
}
