import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Contracts } from './types.ts';

export type { Contracts };
export type { MainProfileView, MainSessionDetail, MainSessionView } from './session.ts';
type Schema = Record<string, unknown>;
export type ToolName = 'delegate_task' | 'get_task' | 'wait_tasks' | 'send_to_task' | 'cancel_task' | 'list_profiles' | 'list_tasks';
export type Input<N extends ToolName> = Contracts[`${N}Input`];

const read = (name: string) => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: true });
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
addFormats(ajv);

export const tools = read('mcp-tools.json').tools as {
  name: ToolName;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  inputSchema: Schema;
  outputSchema: Schema;
}[];

export const validEvent = ajv.compile(read('events.schema.json'));
const definitions = JSON.parse(JSON.stringify(read('control-api.openapi.json').components.schemas)
  .replaceAll('#/components/schemas/', '#/$defs/'));
const apiValidators = new Map<string, ReturnType<typeof ajv.compile>>();

export function validApi<K extends keyof Contracts>(name: K, value: unknown): value is Contracts[K] {
  let check = apiValidators.get(name);
  if (!check) {
    check = ajv.compile({ $ref: '#/$defs/' + name, $defs: definitions });
    apiValidators.set(name, check);
  }
  return check(value) === true;
}

export function standardSchema(schema: Schema) {
  const check = ajv.compile(schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zgent',
      jsonSchema: { input: () => schema, output: () => schema },
      validate: (value: unknown) => check(value)
        ? { value }
        : { issues: [{ message: 'Value does not match the zgent v1 contract' }] },
    },
  };
}
