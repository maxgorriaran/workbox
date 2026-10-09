import { Providers } from '@librechat/agents';
import { HumanMessage } from '@langchain/core/messages';
import { EModelEndpoint } from 'librechat-data-provider';
import { ChatOpenAI } from '@librechat/agents/llm/openai';
import { CustomAnthropic } from '@librechat/agents/llm/anthropic';
import type { IMongoFile } from '@librechat/data-schemas';
import type { DocumentBlock, ServerRequest } from '~/types';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { encodeAndFormatDocuments } from './document';
import { getFileStream } from './utils';

jest.mock('./utils', () => ({
  getFileStream: jest.fn(),
  getConfiguredFileSizeLimit: jest.fn(() => undefined),
  isAttachmentObjectNotFoundError: jest.fn(() => false),
}));

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');
const file = {
  file_id: 'synthetic-pdf',
  filename: 'invoice.pdf',
  type: 'application/pdf',
  bytes: pdf.length,
  filepath: '/synthetic/invoice.pdf',
  source: 'local',
} as IMongoFile;
const req = { config: {} } as ServerRequest;
const claude = {
  provider: Providers.ANTHROPIC,
  model: 'claude-sonnet-5',
  model_parameters: { useResponsesApi: undefined as boolean | undefined },
};

function gptAgent(model: string, useResponsesApi?: boolean) {
  const { llmConfig } = getOpenAIConfig(
    'synthetic-test-key',
    { modelOptions: { model, ...(useResponsesApi == null ? {} : { useResponsesApi }) } },
    EModelEndpoint.openAI,
  );
  return { provider: Providers.OPENAI, model, model_parameters: llmConfig };
}

async function encode(
  primary: typeof claude | ReturnType<typeof gptAgent>,
  secondary?: typeof primary,
  files: IMongoFile[] = [file],
) {
  const params = {
    provider: primary.provider,
    model: primary.model,
    useResponsesApi: primary.model_parameters.useResponsesApi,
    agent: primary,
    agentConfigs: secondary ? new Map([['secondary', secondary]]) : undefined,
  };
  return encodeAndFormatDocuments(req, files, params, jest.fn());
}

/** Intercept the SDK's final HTTP body; no request reaches a model provider. */
async function openAIBody(model: string, useResponsesApi: boolean, content: DocumentBlock[]) {
  let body: Record<string, unknown> | undefined;
  const chat = new ChatOpenAI({
    model,
    apiKey: 'synthetic-test-key',
    firstPartyEndpoint: true,
    useResponsesApi,
    maxRetries: 0,
    configuration: {
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify(
            useResponsesApi
              ? {
                  id: 'resp_synthetic',
                  object: 'response',
                  created_at: 0,
                  status: 'completed',
                  model,
                  output: [
                    {
                      type: 'message',
                      id: 'msg_synthetic',
                      role: 'assistant',
                      status: 'completed',
                      content: [
                        { type: 'output_text', text: 'Synthetic response', annotations: [] },
                      ],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }
              : {
                  id: 'chatcmpl_synthetic',
                  object: 'chat.completion',
                  created: 0,
                  model,
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'Synthetic response' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                },
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    },
  });
  await chat.invoke([new HumanMessage({ content: content.map((block) => ({ ...block })) })]);
  return body;
}

async function anthropicBody(content: DocumentBlock[]) {
  let body: Record<string, unknown> | undefined;
  const chat = new CustomAnthropic({
    model: claude.model,
    apiKey: 'synthetic-test-key',
    streaming: true,
    maxRetries: 0,
    clientOptions: {
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_synthetic',
              type: 'message',
              role: 'assistant',
              model: claude.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Synthetic response' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ];
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    },
  });
  await chat.invoke([new HumanMessage({ content: content.map((block) => ({ ...block })) })]);
  return body;
}

describe('PDFs in shared agent histories through the pinned SDK', () => {
  beforeEach(() => {
    jest.mocked(getFileStream).mockResolvedValue({
      file,
      content: pdf.toString('base64'),
      metadata: file,
    });
  });

  it.each(['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'])(
    'serializes a Claude PDF for %s with its default Responses route',
    async (model) => {
      const secondary = gptAgent(model);
      expect(secondary.model_parameters.useResponsesApi).toBe(true);
      const { documents } = await encode(claude, secondary);
      const body = await openAIBody(model, true, documents);
      expect(body?.input).toEqual([
        expect.objectContaining({
          role: 'user',
          content: [
            {
              type: 'input_file',
              filename: file.filename,
              file_data: `data:application/pdf;base64,${pdf.toString('base64')}`,
            },
          ],
        }),
      ]);
    },
  );

  it('keeps the PDF, filename context and citations when GPT hands off to Claude', async () => {
    const { documents } = await encode(gptAgent('gpt-6.1-sol'), claude);
    const body = await anthropicBody(documents);
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
            context: 'File: "invoice.pdf"',
            citations: { enabled: true },
          },
        ],
      },
    ]);
  });

  it('serializes the same PDF for a Chat Completions agent', async () => {
    const secondary = gptAgent('gpt-4.1', false);
    const { documents } = await encode(gptAgent('gpt-6-sol'), secondary);
    const body = await openAIBody('gpt-4.1', false, documents);
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: {
              filename: file.filename,
              file_data: `data:application/pdf;base64,${pdf.toString('base64')}`,
            },
          },
        ],
      },
    ]);
  });

  it('keeps single-format histories on their existing document path', async () => {
    expect((await encode(claude)).documents[0]).toMatchObject({ type: 'document' });
    const primary = gptAgent('gpt-6-sol');
    const secondary = gptAgent('gpt-6-luna');
    expect((await encode(primary, secondary)).documents[0]).toMatchObject({ type: 'input_file' });
  });

  it('finds a nested handoff agent without a top-level added conversation', async () => {
    const primary = { ...claude, subagentAgentConfigs: [gptAgent('gpt-6.1-sol')] };
    const { documents } = await encode(primary);
    const body = await openAIBody('gpt-6.1-sol', true, documents);
    expect(body?.input).toEqual([
      expect.objectContaining({ content: [expect.objectContaining({ type: 'input_file' })] }),
    ]);
    expect(primary.subagentAgentConfigs[0].model_parameters.useResponsesApi).toBe(true);
  });

  it.each([Providers.ANTHROPIC, Providers.BEDROCK])(
    'keeps textual files readable when %s shares history with GPT',
    async (provider) => {
      const textFile = { ...file, type: 'text/plain', filename: 'notes.txt', bytes: 5 };
      jest.mocked(getFileStream).mockResolvedValue({
        file: textFile,
        content: Buffer.from('Hello').toString('base64'),
        metadata: textFile,
      });
      const { documents } = await encode({ ...claude, provider }, gptAgent('gpt-6-sol'), [
        textFile,
      ]);
      const body = await openAIBody('gpt-6-sol', true, documents);
      expect(body?.input).toEqual([
        expect.objectContaining({
          content: [{ type: 'input_text', text: 'File: "notes.txt"\n\nHello' }],
        }),
      ]);
    },
  );

  it('preserves PDF validation before a shared block is created', async () => {
    jest.mocked(getFileStream).mockResolvedValue({
      file,
      content: Buffer.from('not a PDF').toString('base64'),
      metadata: file,
    });
    await expect(encode(claude, gptAgent('gpt-6-sol'))).rejects.toThrow('missing PDF header');
  });
});
