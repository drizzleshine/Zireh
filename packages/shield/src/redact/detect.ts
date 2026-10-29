import type { EntityKind } from "@zireh/schema";

export interface Detection {
  readonly text: string;
  readonly kind: EntityKind;
  readonly hint?: string;
}

/** Everyday words the model sometimes lists as names; never hidden. */
export const COMMON = new Set(
  "a an and are as at but by can could did do does for from he her his how i if in is it its may might my no not of on or our she should so than that the their them then there these they this those to was we were what when where which who whom whose why will with would you your yes".split(" "),
);
