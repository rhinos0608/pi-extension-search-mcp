export function normalizeProviderPayload(payload: unknown): unknown {
  if (!isRecord(payload) || !('instructions' in payload)) return payload;

  const instructions = payload.instructions;
  if (typeof instructions === 'string') return payload;

  return {
    ...payload,
    instructions: stringifyInstructions(instructions),
  };
}

function stringifyInstructions(instructions: unknown): string {
  if (instructions === undefined || instructions === null) return '';
  if (typeof instructions === 'string') return instructions;

  if (Array.isArray(instructions)) {
    return instructions.map(stringifyInstructions).filter(Boolean).join('\n');
  }

  if (isRecord(instructions)) {
    const text = instructions.text ?? instructions.content ?? instructions.instructions;
    if (typeof text === 'string') return text;
  }

  return JSON.stringify(instructions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
