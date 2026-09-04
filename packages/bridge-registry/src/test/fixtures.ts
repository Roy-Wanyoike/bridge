import type { IRField, IRPackage } from '@bridge/core';

/**
 * Deterministic IR fixture for tests.
 *
 * The registry consumes only the frozen IR shape plus `hashPackage`, so
 * tests build their own IR values instead of depending on the compiler.
 * `seed > 0` varies the content so two fixtures of the same name hash
 * differently (used by immutability tests).
 */
export function makeIr(name: string, imports: string[] = [], seed = 0): IRPackage {
  const fields: IRField[] = [
    {
      name: 'amount',
      type: { kind: 'primitive' as const, primitive: 'decimal' as const },
      optional: false,
      constraints: [{ kind: 'min' as const, args: ['0'] }],
    },
    {
      name: 'currency',
      type: { kind: 'primitive' as const, primitive: 'string' as const },
      optional: false,
      constraints: [{ kind: 'length' as const, args: ['3'] }],
    },
  ];
  if (seed > 0) {
    fields.push({
      name: `extra${seed}`,
      type: { kind: 'primitive' as const, primitive: 'int32' as const },
      optional: true,
      constraints: [],
    });
  }
  return {
    name,
    imports,
    types: [{ name: 'Money', kind: 'struct', fields }],
    services: [
      {
        name: 'Payments',
        methods: [
          {
            name: 'Charge',
            input: { kind: 'named', name: 'Money' },
            output: { kind: 'named', name: 'Money' },
          },
        ],
      },
    ],
    events: [{ name: 'Charged', fields: [] }],
    docs: `Fixture package ${name} (seed ${seed})`,
  };
}
