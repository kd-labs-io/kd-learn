#!/usr/bin/env node
// Paid acceptance run for phase 1 (plan step 8). NOT part of CI: it calls a real model.
//
// Drives the production SSR build in Chromium like a guest: enters the key on the settings screen,
// creates a session, answers with canned replies until the session reaches `done`, reloads once in
// the middle of a turn (interrupted banner + retry) and once after `done`, and asks the side chat once.
// Prints a JSON report (turns, tokens, cost, request sizes). The key is never printed or logged.
//
//   pnpm build
//   KD_LEARN_ENV_FILE=/path/to/.env node apps/web/scripts/acceptance.mjs [--first-turn] [--topic "..."]
//
// Flags: --first-turn stops after the first model turn (check model and cost before a full run).
// Caps (stop and report): --max-turns (default 60), --max-cost USD (default 0.50).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const MODEL = option('model', 'claude-haiku-5-5');
const TOPIC = option('topic', 'Adding fractions with different denominators');
const MAX_TURNS = Number(option('max-turns', '60'));
const MAX_COST = Number(option('max-cost', '0.50'));
const PORT = Number(option('port', '4180'));
// USD per million tokens (input, output) for claude-haiku-5-5.
const PRICE = { input: 0.1, output: 0.5 };

function readKey() {
  if (process.env.KD_LEARN_CLAUDE_API) return process.env.KD_LEARN_CLAUDE_API;
  const file = process.env.KD_LEARN_ENV_FILE;
  if (!file) throw new Error('Set KD_LEARN_CLAUDE_API or KD_LEARN_ENV_FILE');
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('KD_LEARN_CLAUDE_API='));
  if (!line) throw new Error('KD_LEARN_CLAUDE_API not found in the env file');
  return line
    .slice('KD_LEARN_CLAUDE_API='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
}

// The learner is a second, cheap model call that answers what the tutor really asked.
// Canned answers cannot work: the Teacher rightly refuses to complete a step until the learner has
// answered its question. Its tokens are counted apart and included in the cost cap.
const learnerUsage = { input: 0, output: 0 };
const learnerSystem = (topic) =>
  `You play a middle-school student in a one-to-one tutoring session on: "${topic}". ` +
  'You know what a fraction is and you can add fractions with the same denominator, but adding fractions with different denominators is new to you. ' +
  "Answer the tutor's last message directly, in one to three plain sentences, writing math like 3/6 (no LaTeX). " +
  'Show your reasoning briefly. When the tutor teaches an idea and then asks you to apply it, apply it correctly and explain why in your own words. ' +
  'Stay in character; never mention that you are an AI or a simulation.';

async function learnerReply(key, topic, history, tutorText) {
  history.push({ role: 'user', content: tutorText });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      system: learnerSystem(topic),
      messages: history,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`learner call failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  const body = await res.json();
  learnerUsage.input += body.usage?.input_tokens ?? 0;
  learnerUsage.output += body.usage?.output_tokens ?? 0;
  const text = (body.content ?? [])
    .map((c) => c.text ?? '')
    .join('')
    .trim();
  if (text === '') throw new Error(`learner returned no text (stop_reason=${body.stop_reason})`);
  history.push({ role: 'assistant', content: text });
  return text;
}

const server = spawn(
  'node',
  [fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url))],
  { env: { ...process.env, PORT: String(PORT), KD_LEARN_CLAUDE_API: '' }, stdio: 'ignore' },
);
const stopServer = () => server.kill('SIGTERM');
process.on('exit', stopServer);

const report = { model: MODEL, topic: TOPIC, turns: [], notes: [], criteria: {} };
const cost = (u) => (u.input * PRICE.input + u.output * PRICE.output) / 1e6;
const total = () =>
  report.turns.reduce(
    (a, t) => ({ input: a.input + (t.inputTokens ?? 0), output: a.output + (t.outputTokens ?? 0) }),
    { input: 0, output: 0 },
  );
const startedAt = Date.now();
const note = (s) => {
  const line = `[${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${s}`;
  report.notes.push(line);
  console.error(line);
};

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/api/endpoints`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function main(key) {
  await waitForServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  // Every POST /api/turns: count it in flight, record the request size, read the SSE body at the end.
  let inflight = 0;
  const bodies = [];
  const isTurn = (r) => r.url().endsWith('/api/turns') && r.method() === 'POST';
  page.on('request', (r) => {
    if (!isTurn(r)) return;
    inflight++;
    const entry = {
      n: report.turns.length + 1,
      requestBytes: r.postData()?.length ?? 0,
      startedAt: Date.now(),
    };
    report.turns.push(entry);
    bodies.push(
      r
        .response()
        .then((res) => res?.text())
        .catch(() => undefined)
        .then((text) => ({ entry, text }))
        .finally(() => {
          entry.seconds = Number(((Date.now() - entry.startedAt) / 1000).toFixed(1));
          inflight--;
        }),
    );
  });

  const digest = async () => {
    for (const { entry, text } of await Promise.all(bodies.splice(0))) {
      if (text === undefined) {
        entry.aborted = true;
        continue;
      }
      const frames = [];
      for (const block of text.split('\n\n')) {
        const data = block.split('\n').find((l) => l.startsWith('data:'));
        if (!data) continue;
        try {
          frames.push(JSON.parse(data.slice(5)));
        } catch {
          // keep-alive or partial frame
        }
      }
      const events = frames.map((f) => f.event ?? f);
      const usage =
        events.find((e) => e._tag === 'UsageRecorded') ??
        events.find((e) => e._tag === 'SideMessageAppended')?.usage;
      Object.assign(entry, {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        model: usage?.model,
        events: events.map((e) => e._tag).filter(Boolean),
        error: frames.find((f) => f.error)?.error?.code,
      });
    }
  };

  const settle = async () => {
    // wait for the in-flight turn and for any follow-up turn the app starts by itself
    for (let quiet = 0; quiet < 6;) {
      await page.waitForTimeout(250);
      quiet = inflight === 0 ? quiet + 1 : 0;
    }
    await digest();
  };

  // 1. the guest enters the key on the settings screen
  await page.goto(`http://localhost:${PORT}/settings`);
  await page.getByLabel('Model').fill(MODEL);
  await page.getByLabel('API key').fill(key);
  await page.getByTestId('save-settings').click();
  await page.getByTestId('settings-message').filter({ hasText: 'Saved' }).waitFor();

  // 2. create the session; the Prober starts by itself
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByLabel('What do you want to learn?').fill(TOPIC);
  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/s\//);
  await settle();
  const first = report.turns[0];
  note(
    `first turn: model=${first?.model} in=${first?.inputTokens} out=${first?.outputTokens} cost=${cost({ input: first?.inputTokens ?? 0, output: first?.outputTokens ?? 0 }).toFixed(6)} error=${first?.error}`,
  );
  if (flag('first-turn') || !first || first.error) return;

  // 3. canned learner until done
  const ui = async () => ({
    tutor: await page.getByTestId('msg-tutor').count(),
    user: await page.getByTestId('msg-user').count(),
    steps: await page
      .getByTestId('plan-steps')
      .locator('[data-status]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-status'))),
    phase: (await page.getByTestId('plan-phase').count())
      ? await page.getByTestId('plan-phase').textContent()
      : null,
    done: await page.getByTestId('lesson-done').isVisible(),
  });
  const phaseLog = [];
  let teach = 0;
  const learnerHistory = [];
  // The last tutor message as plain text, with each formula replaced by its TeX source.
  const lastTutorText = () =>
    page
      .getByTestId('msg-tutor')
      .last()
      .evaluate((el) => {
        const copy = el.cloneNode(true);
        for (const k of copy.querySelectorAll('.katex')) {
          k.replaceWith(`$${k.querySelector('annotation')?.textContent ?? ''}$`);
        }
        return copy.textContent.replace(/^Tutor/, '').trim();
      });
  let midTurnDone = false;
  let sideDone = false;
  let stopped;
  while (!(await page.getByTestId('lesson-done').isVisible())) {
    const state = await ui();
    phaseLog.push({
      afterRequest: report.turns.length,
      steps: state.steps.join(','),
      phase: state.phase,
    });
    const spent = cost(total()) + cost(learnerUsage);
    if (report.turns.length >= MAX_TURNS || spent > MAX_COST) {
      stopped = `cap reached: requests=${report.turns.length} cost=${spent.toFixed(4)}`;
      break;
    }
    if (await page.getByTestId('turn-failed').isVisible()) {
      stopped = 'turn failed banner shown';
      break;
    }
    if (await page.getByTestId('skip-step').isVisible()) {
      report.criteria.skipStepSeenAfterRequest ??= report.turns.length;
    }
    const hasPlan = state.steps.length > 0;
    if (hasPlan) teach++;
    const text = await learnerReply(key, TOPIC, learnerHistory, await lastTutorText());
    note(`learner: ${text.slice(0, 90)}`);

    // side chat once, while teaching
    if (hasPlan && !sideDone) {
      sideDone = true;
      await page
        .getByTestId('side-input')
        .fill('Quick question: why can we not just add the denominators?');
      await page.getByTestId('side-send').click();
      await page
        .getByTestId('side-messages')
        .getByText(/denominator/i)
        .first()
        .waitFor({ timeout: 60000 });
      await page.waitForTimeout(3000);
      const sideText = await page.getByTestId('side-messages').innerText();
      report.criteria.sideChat = {
        ok: sideText.length > 80,
        chars: sideText.length,
        mainUntouched: (await ui()).tutor === state.tutor,
      };
      note(`side chat: ${JSON.stringify(report.criteria.sideChat)}`);
    }

    await page.getByLabel('Your answer').fill(text);
    if (hasPlan && teach === 2 && !midTurnDone) {
      // reload while the model is still answering
      midTurnDone = true;
      const before = await ui();
      const sent = page.waitForRequest(isTurn);
      await page.getByTestId('composer-send').click();
      await sent;
      await page.reload();
      await page.getByTestId('turn-interrupted').waitFor({ timeout: 15000 });
      const after = await ui();
      const shown = async () =>
        (await page.getByTestId('msg-user').allInnerTexts()).filter((t) =>
          t.includes(text.slice(0, 30)),
        ).length;
      const userKept = (await shown()) === 1;
      const requests = report.turns.length;
      await page.waitForTimeout(1500);
      const noAutoResend = report.turns.length === requests;
      await page.getByTestId('turn-retry').click();
      await settle();
      report.criteria.midTurnReload = {
        interruptedBanner: true,
        userAnswerKept: userKept,
        noAutoResend,
        planKept: before.steps.join() === after.steps.join(),
        retryResolved: !(await page.getByTestId('turn-interrupted').isVisible()),
        answerShownOnce: (await shown()) === 1,
      };
      note(`mid-turn reload: ${JSON.stringify(report.criteria.midTurnReload)}`);
      continue;
    }
    await page.getByTestId('composer-send').click();
    await settle();
  }

  const final = await ui();
  report.criteria.reachedDone = final.done;
  report.final = { ...final, stopped };
  for (const kind of ['msg-tutor', 'msg-user']) {
    report[kind] = await page.getByTestId(kind).allInnerTexts();
  }
  report.phaseLog = phaseLog;
  note(`ended: ${JSON.stringify(report.final)}`);

  // 4. reload after done: nothing is lost
  if (final.done) {
    const texts = async () =>
      JSON.stringify([
        await page.getByTestId('msg-tutor').allInnerTexts(),
        await page.getByTestId('msg-user').allInnerTexts(),
      ]);
    const textBefore = await texts();
    await page.reload();
    await page.getByTestId('lesson-done').waitFor({ timeout: 15000 });
    await page.getByTestId('msg-user').first().waitFor();
    // KaTeX loads lazily: formulas show their TeX source until it is there
    await page.locator('.katex').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    const reloaded = await ui();
    report.criteria.reloadAfterDone = {
      same: JSON.stringify(reloaded) === JSON.stringify(final),
      sameText: (await texts()) === textBefore,
      tutor: [final.tutor, reloaded.tutor],
      user: [final.user, reloaded.user],
    };
    const textAfter = await texts();
    if (textAfter !== textBefore) {
      const a = JSON.parse(textBefore).flat();
      const b = JSON.parse(textAfter).flat();
      report.textDiff = a
        .map((t, i) =>
          t === b[i] ? undefined : { i, before: t.slice(0, 400), after: b[i]?.slice(0, 400) },
        )
        .filter(Boolean);
    }
    await page.goto(`http://localhost:${PORT}/`);
    await page.getByTestId('session-list').waitFor({ timeout: 15000 });
    report.criteria.reloadAfterDone.inList = (await page.getByTestId('session-item').count()) === 1;
    note(`reload after done: ${JSON.stringify(report.criteria.reloadAfterDone)}`);
  }
  report.criteria.keyNotInPage = !(await page.content()).includes(key);
  await browser.close();
}

let key = '\u0000';
try {
  key = readKey();
  await main(key);
} catch (error) {
  report.error = String(error?.message ?? error)
    .split(key)
    .join('[key]');
} finally {
  const t = total();
  report.totals = {
    requests: report.turns.length,
    inputTokens: t.input,
    outputTokens: t.output,
    costUsd: Number(cost(t).toFixed(5)),
    simulatedLearner: { ...learnerUsage, costUsd: Number(cost(learnerUsage).toFixed(5)) },
  };
  console.log(JSON.stringify(report, null, 2));
  stopServer();
  process.exit(0);
}
