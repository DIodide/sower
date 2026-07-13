import { htmlEntityEncodedToPlainText } from '../description.js';

/**
 * Parser for a Workday "calypso" questionnaire definition — the JSON returned
 * by `POST /wday/calypso/cxs/common/{tenant}/questionnaire/{id}/definition`.
 *
 * The definition is a JSON Schema: `definitions.primaryQuestionnaire` holds a
 * `properties` map keyed by question GUID plus a `required` list. Each property
 * carries `label` (HTML), `type`, `order`, `hidden`, `readOnly`. This is the
 * authenticated view of the questions the PUBLIC cxs API withholds — reading it
 * needs a candidate session (see workday-calypso-api.md).
 *
 * Reverse-engineered from a real datasite application (fixture
 * fixture-questionnaire-definition.json), verified live 2026-07-12.
 */

/** A raw question field as declared in the definition schema. */
export interface WorkdayQuestionnaireField {
  /** The question GUID (used as the answer key in questionnaireresponses). */
  id: string;
  /** Plain-text question label (HTML stripped). */
  label: string;
  /**
   * Normalized control kind:
   * - 'text'   <- schema type 'string' / 'integer' / 'number'
   * - 'select' <- schema type 'object' / 'boolean' (a choice; the option
   *               values are NOT inline — the client resolves them separately)
   * - 'file'   <- schema type 'upload'
   */
  control: 'text' | 'select' | 'file';
  /** Required to submit — but see `conditional`: a hidden field is only
   *  enforced once revealed by a controlling answer. */
  required: boolean;
  /**
   * True when the field is `hidden` in the definition — a CONDITIONAL question
   * shown only after a controlling answer (e.g. datasite's "provide a copy of
   * the document", order 'c.a', appears when the non-compete question 'c' is
   * answered yes). Conditional fields are surfaced but never force a human up
   * front.
   */
  conditional: boolean;
  /** Sort key from the schema ('a','b','c','c.a',…) — dotted = sub-question. */
  order: string;
  /** True when a 'select'/choice control still needs its options fetched. */
  needsOptions: boolean;
}

interface DefinitionSchema {
  definitions?: {
    primaryQuestionnaire?: {
      required?: string[];
      properties?: Record<
        string,
        {
          label?: string;
          type?: string;
          order?: string;
          hidden?: boolean;
          readOnly?: boolean;
        }
      >;
    };
  };
}

const CONTROL_BY_TYPE: Record<string, WorkdayQuestionnaireField['control']> = {
  string: 'text',
  integer: 'text',
  number: 'text',
  object: 'select',
  boolean: 'select',
  upload: 'file',
};

/** Compare Workday order keys ('a' < 'b' < 'c' < 'c.a' < 'd'), dotted-aware. */
function compareOrder(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Parse a questionnaire definition into ordered fields. read-only fields are
 * dropped (nothing to answer). Hidden (conditional) fields are kept but
 * reported as `required: false` (only enforced once revealed) with
 * `conditional: true`. Choice fields come back as 'select' with
 * `needsOptions: true` — their option values are fetched by the client.
 */
export function parseQuestionnaireDefinition(
  schema: DefinitionSchema,
): WorkdayQuestionnaireField[] {
  const primary = schema.definitions?.primaryQuestionnaire;
  const properties = primary?.properties ?? {};
  const requiredSet = new Set(primary?.required ?? []);

  const fields: WorkdayQuestionnaireField[] = [];
  for (const [id, prop] of Object.entries(properties)) {
    if (prop.readOnly === true) {
      continue;
    }
    const control = CONTROL_BY_TYPE[prop.type ?? ''] ?? 'text';
    const conditional = prop.hidden === true;
    fields.push({
      id,
      label: htmlEntityEncodedToPlainText(prop.label ?? '').trim(),
      control,
      // A conditional (hidden) field is not required until it is shown.
      required: requiredSet.has(id) && !conditional,
      conditional,
      order: prop.order ?? '',
      needsOptions: control === 'select',
    });
  }
  fields.sort((a, b) => compareOrder(a.order, b.order));
  return fields;
}
