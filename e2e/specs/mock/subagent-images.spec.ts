import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { messagesView } from './helpers';

/** Synthetic message/file APIs exercise the real chat, fold, image, and child-panel renderers. */
async function seedImages(page: Page, preview: boolean) {
  const conversationId = 'e2e-subagent-images';
  const messageId = 'e2e-parent-image-message';
  const now = new Date(0).toISOString();
  const attachments = ['cat', 'moon'].map((name, index) => ({
    file_id: `child-${name}`,
    filename: `child-${name}.png`,
    filepath: `/images/e2e/${name}.png`,
    width: 320,
    height: 200,
    source: 'local',
    type: 'image/png',
    bytes: 100,
    messageId,
    conversationId,
    toolCallId: 'repeated-child-tool',
    agentId: 'artist',
    stepId: `child-step-${index}`,
  }));
  const parts = attachments.map((_, index) => ({
    type: 'tool_call',
    agentId: 'parent',
    tool_call: {
      id: `delegate-${index}`,
      name: 'subagent',
      args: '{"subagent_type":"artist","description":"Draw an image"}',
      output: 'Image generated.',
      progress: 1,
      stepId: `parent-step-${index}`,
      subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'artist' },
      subagent_content: [
        {
          type: 'tool_call',
          agentId: 'artist',
          tool_call: {
            id: 'repeated-child-tool',
            name: 'image_gen_oai',
            args: '{}',
            output: 'Image generated.',
            progress: 1,
            stepId: `child-step-${index}`,
          },
        },
      ],
    },
  }));
  const content = preview
    ? parts.map((part) => {
        const tool_call: Omit<typeof part.tool_call, 'subagent_content'> & {
          subagent_content?: unknown;
        } = { ...part.tool_call };
        delete tool_call.subagent_content;
        return {
          ...part,
          tool_call: {
            ...tool_call,
            subagentContentOmitted: true,
            subagentContentParts: 1,
            previewRevision: 'fixture-v1',
          },
        };
      })
    : parts;
  const conversation = {
    conversationId,
    title: 'Subagent image regression',
    endpoint: 'agents',
    agent_id: 'parent',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const message = {
    ...conversation,
    messageId,
    parentMessageId: '00000000-0000-0000-0000-000000000000',
    sender: 'Parent artist',
    isCreatedByUser: false,
    text: '',
    content,
    attachments,
  };
  let detailRequests = 0;
  await page.route('**/api/convos/e2e-subagent-images?*', (route) =>
    route.fulfill({ json: conversation }),
  );
  await page.route('**/api/convos/e2e-subagent-images', (route) =>
    route.fulfill({ json: conversation }),
  );
  await page.route(/\/api\/messages\/e2e-subagent-images(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [message] }),
  );
  await page.route(
    /\/api\/messages\/e2e-subagent-images\/e2e-parent-image-message\/parts\/\d+(?:\?.*)?$/,
    (route) => {
      detailRequests++;
      const index = Number(new URL(route.request().url()).pathname.split('/').pop());
      return route.fulfill({ json: parts[index] });
    },
  );
  await page.route('**/images/e2e/*.png', async (route) => {
    // A real PNG drawn locally, with no provider call or remote image service.
    const png = await page.evaluate((cat) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#171827';
      ctx.fillRect(0, 0, 320, 200);
      ctx.fillStyle = cat ? '#ef665e' : '#ecc978';
      ctx.beginPath();
      ctx.arc(160, 104, 52, 0, Math.PI * 2);
      ctx.fill();
      if (cat) {
        ctx.beginPath();
        ctx.moveTo(116, 79);
        ctx.lineTo(114, 31);
        ctx.lineTo(151, 59);
        ctx.lineTo(185, 59);
        ctx.lineTo(211, 31);
        ctx.lineTo(211, 85);
        ctx.fill();
        ctx.fillStyle = '#171827';
        ctx.fillRect(141, 94, 8, 10);
        ctx.fillRect(178, 94, 8, 10);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    }, route.request().url().includes('cat'));
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
  });
  await page.goto(`/c/${conversationId}`);
  return { detailRequests: () => detailRequests };
}

for (const viewport of [
  { width: 1280, height: 850 },
  { width: 390, height: 844 },
]) {
  test(`subagent images survive folds, reload and lazy child activity at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const fixture = await seedImages(page, true);
    const view = messagesView(page);
    await expect(view).toBeVisible();
    const image = view.getByRole('img', { name: 'child-cat.png', exact: true });
    if (process.env.E2E_EXPECT_MISSING_SUBAGENT_IMAGES === 'true') {
      await expect(image).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`subagent-images-before-${viewport.width}.png`),
      });
      return;
    }
    await expect(image).toBeVisible();
    await expect(image).toHaveCount(1);
    await expect(view.getByRole('img', { name: 'child-moon.png', exact: true })).toHaveCount(1);
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(320);
    expect(fixture.detailRequests()).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`subagent-images-after-${viewport.width}.png`),
    });
    await page.reload();
    await expect(image).toBeVisible();
    await expect(image).toHaveCount(1);
    const cards = page.locator('[data-subagent-tool-call]');
    if ((await cards.count()) === 0)
      await view.getByRole('button', { name: /Ran 2 agents/ }).click();
    await cards.first().click();
    const panel = page.getByRole(viewport.width < 768 ? 'dialog' : 'region', {
      name: 'Child agent activity',
    });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('img', { name: 'child-cat.png', exact: true })).toBeVisible();
    await expect(panel.getByRole('img', { name: 'child-moon.png', exact: true })).toHaveCount(0);
    await expect.poll(fixture.detailRequests).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(image).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
